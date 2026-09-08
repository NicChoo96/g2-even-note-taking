#!/usr/bin/env node
// Dictation COMMIT-CONTRACT harness.
//
// WHY THIS EXISTS:
//   The original bug — "it reaches Deepgram fine, but it writes to the field and
//   kills dictation" — was caused by the streaming engine handing each finished
//   phrase to the caller (onFinal), which wrote the target field mid-session.
//   A field write re-renders the glasses page, and a page write while the mic is
//   open makes the host drop the audio stream. The fix: the engine publishes the
//   RUNNING transcript through `onText` (display only) and the caller writes the
//   field exactly ONCE, from `onState('idle')`, gated on
//   `dictationSnapshot().commit`.
//
//   This harness bundles the REAL glasses/src/dictate.ts (esbuild + an SDK stub),
//   feeds it synthetic 16 kHz PCM through a fake Even-App bridge, and asserts the
//   contract end-to-end. It does NOT need the glasses simulator (which has no
//   audioControl) or the relay.
//
// Run: node tools/dictate-commit-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Test bookkeeping ────────────────────────────────────────────────────────
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
};
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// ── Bundle the real engine with a stubbed SDK ───────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'dictate-commit-'));
const stub = join(out, 'sdk-stub.mjs');
writeFileSync(
  stub,
  `export const AudioInputSource = { Glasses: 'glasses', Phone: 'phone' };
export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }
export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }
export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }
export const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
export const measureTextWrap = () => ({ lineCount: 1 });
`,
);

// One bundle exporting the engine AND the bridge slot, so the harness can wire
// the fake Even-App bridge into the SAME module instance the engine reads.
const outfile = join(out, 'dictate.mjs');
await build({
  stdin: {
    contents: `export * from './dictate.ts';
export { setDurableBridge, setStartupReady } from './durable-docs.ts';`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '@evenrealities/even_hub_sdk': stub },
  define: { 'import.meta.env': '{}' }, // stream.ts reads VITE_HUB_STREAM_URL
});

// ── Fake host: window timers + fetch (the relay) ────────────────────────────
globalThis.window = globalThis; // dictate.ts uses window.setTimeout/setInterval
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Responses the fake relay returns, one per POST /api/stt. */
let sttQueue = [];
let sttCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/api/stt/status')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ supported: true, provider: 'deepgram' }),
    };
  }
  if (u.includes('/api/stt')) {
    sttCalls++;
    const text = sttQueue.length ? sttQueue.shift() : '';
    // The engine sends a WAV body; assert it is actually audio, not empty.
    const body = init.body;
    const bytes = body ? body.length : 0;
    if (bytes < 44) throw new Error('STT received a non-WAV body');
    return { ok: true, status: 200, json: async () => ({ text }) };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

// ── Fake Even-App bridge (G2 mic) ───────────────────────────────────────────
const mic = { handler: null, open: false, source: null };
const bridge = {
  audioControl: async (on, source) => {
    mic.open = !!on;
    mic.source = source;
    return !!on;
  },
  onEvenHubEvent: (cb) => {
    mic.handler = cb;
    return () => {
      mic.handler = null;
    };
  },
};

/** Push one 100 ms frame of 16 kHz s16le PCM (amplitude 0 = silence). */
const FRAME_SAMPLES = 1600;
function pushFrame(amplitude) {
  if (!mic.handler || !mic.open) return;
  const i16 = new Int16Array(FRAME_SAMPLES);
  if (amplitude) i16.fill(amplitude);
  mic.handler({ audioEvent: { audioPcm: new Uint8Array(i16.buffer) } });
}

/** Feed voiced audio then trailing silence so the VAD cuts a phrase. */
async function speak({ voicedMs = 600, quietMs = 900 } = {}) {
  for (let t = 0; t < voicedMs; t += 20) {
    pushFrame(9000);
    await sleep(20);
  }
  for (let t = 0; t < quietMs; t += 20) {
    pushFrame(0);
    await sleep(20);
  }
  await sleep(60); // let pump() finish the STT round-trip
}

// ── Import the engine + bridge slot ─────────────────────────────────────────
const dictate = await import(pathToFileURL(outfile).href);
const {
  startDictation,
  stopDictation,
  cancelDictation,
  dictationSnapshot,
  dictationText,
  isDictating,
  setDurableBridge,
  setStartupReady,
} = dictate;

setStartupReady(true); // glasses mic requires the startup page
setDurableBridge(bridge);
assert('fake Even-App bridge is live (micTarget=glasses)', dictate.micTarget() === 'glasses');

// ── Event recorder ──────────────────────────────────────────────────────────
function recorder() {
  const events = [];
  const state = [];
  return {
    events,
    state,
    hooks: {
      onState: (s, d) => {
        state.push(s);
        events.push({ type: 'state', s, d: d || '' });
      },
      onPartial: (t) => events.push({ type: 'partial', t }),
      onText: (t) => events.push({ type: 'text', t }),
    },
    texts: () => events.filter((e) => e.type === 'text').map((e) => e.t),
  };
}

const source = readFileSync('src/dictate.ts', 'utf8');

// ── 1. Live transcript grows; NOTHING is committed mid-session ──────────────
console.log('\n── 1. mid-session: display only, no commit ──');
{
  sttQueue = ['hello world', 'second phrase'];
  sttCalls = 0;
  const r = recorder();
  // A caller that commits ONLY from idle, exactly like main.ts / Dictate.tsx.
  const commits = [];
  r.hooks.onState = ((orig) => (s, d) => {
    orig(s, d);
    if (s === 'idle') {
      const snap = dictationSnapshot();
      commits.push(snap.commit ? snap.text : '<no-commit>');
    }
  })(r.hooks.onState);

  await startDictation(r.hooks);
  await sleep(150);
  check('engine reached listening', r.state.includes('listening'), true);

  await speak(); // phrase 1 → transcribed
  check('phrase 1 transcribed', sttCalls, 1);
  check('running transcript published', r.texts().at(-1), 'hello world');
  assert('no idle during the session', !r.state.includes('idle'));
  assert('nothing committed mid-session', commits.length === 0, JSON.stringify(commits));
  check('snapshot.commit stays false while listening', dictationSnapshot().commit, false);

  await speak(); // phrase 2 → transcribed, still listening
  check('phrase 2 transcribed', sttCalls, 2);
  check('transcript grew (newest last)', r.texts().at(-1), 'hello world second phrase');
  assert('still no idle after 2 phrases', !r.state.includes('idle'));
  assert('still nothing committed', commits.length === 0, JSON.stringify(commits));
  assert('still dictating', isDictating());

  // ── 2. Explicit stop → exactly ONE commit of the WHOLE transcript ─────────
  console.log('\n── 2. tap-to-stop: commit the whole utterance once ──');
  const beforeTexts = r.texts().length;
  await stopDictation();
  await sleep(200);

  check('idle fired once', r.state.filter((s) => s === 'idle').length, 1);
  check('committed exactly once', commits, ['hello world second phrase']);
  check('snapshot.commit is true after a stop', dictationSnapshot().commit, true);
  check('dictationText() is the full utterance', dictationText(), 'hello world second phrase');
  check('session is over', isDictating(), false);

  const afterTexts = r.texts().length;
  assert(
    'final transcript re-published just before idle',
    afterTexts === beforeTexts + 1 && r.texts().at(-1) === 'hello world second phrase',
    `texts=${afterTexts - beforeTexts}`,
  );
  // Ordering: the last text event must come BEFORE the idle state event.
  const lastText = r.events.map((e) => e.type).lastIndexOf('text');
  const lastIdle = r.events.map((e) => e.type).lastIndexOf('state');
  assert('final onText precedes onState(idle)', lastText < lastIdle);
  assert(
    'no onText after idle',
    !r.events.slice(lastIdle + 1).some((e) => e.type === 'text'),
  );
}

// ── 3. Abort discards the capture (commit stays false) ─────────────────────
console.log('\n── 3. abort: publish for display, never commit ──');
{
  sttQueue = ['discard me'];
  const r = recorder();
  const commits = [];
  r.hooks.onState = ((orig) => (s, d) => {
    orig(s, d);
    if (s === 'idle') {
      const snap = dictationSnapshot();
      commits.push(snap.commit ? snap.text : '<no-commit>');
    }
  })(r.hooks.onState);

  await startDictation(r.hooks);
  await sleep(150);
  await speak();
  check('aborted session still published its text', r.texts().at(-1), 'discard me');

  cancelDictation();
  await sleep(200);
  check('abort commits nothing', commits, ['<no-commit>']);
  check('snapshot.commit false after abort', dictationSnapshot().commit, false);
  assert('aborted text is still readable for display', dictationText() === 'discard me');
}

// ── 4. Empty transcript ⇒ no commit (nothing was heard) ────────────────────
console.log('\n── 4. silence: empty transcript never commits ──');
{
  sttQueue = ['']; // server heard speech energy but recognised nothing
  const r = recorder();
  const commits = [];
  r.hooks.onState = ((orig) => (s, d) => {
    orig(s, d);
    if (s === 'idle') {
      const snap = dictationSnapshot();
      commits.push(snap.commit ? snap.text : '<no-commit>');
    }
  })(r.hooks.onState);

  await startDictation(r.hooks);
  await sleep(150);
  await speak();
  await stopDictation();
  await sleep(250);
  check('empty transcript → no commit', commits, ['<no-commit>']);
  check('snapshot.commit false for empty text', dictationSnapshot().commit, false);
  check('dictationText() is empty', dictationText(), '');
}

// ── 5. End-reason gating is source-verified (never-heard / cap) ────────────
// These two need 90 s / 10 min of virtual time, so assert the exact rules in
// the source instead of waiting for them.
console.log('\n── 5. watchdog end-reason commit rules (source) ──');
{
  const neverHeard = /never-heard[\s\S]{0,220}?wantCommit = false;/.test(source);
  const cap = /hard-cap[\s\S]{0,260}?wantCommit = true;/.test(source);
  const abort = /abort:[\s\S]{0,120}?wantCommit = false;/.test(source);
  const tap = /stop:[\s\S]{0,160}?wantCommit = true;/.test(source);
  assert('never-heard ⇒ commit = false', neverHeard);
  assert('hard-cap (10 min) ⇒ commit = true', cap);
  assert('abort ⇒ commit = false', abort);
  assert('explicit stop ⇒ commit = true', tap);
  assert(
    'commit is derived from wantCommit && transcript.length > 0',
    /snap\.commit = wantCommit && transcript\.length > 0;/.test(source),
  );
  assert(
    'the engine no longer exposes a per-phrase commit hook',
    !/onFinal/.test(source),
  );
}

// ── 6. Consumers never call the target field from a text hook ──────────────
console.log('\n── 6. consumers commit from idle only (source) ──');
{
  for (const f of ['src/main.ts', 'src/web/Dictate.tsx']) {
    const src = readFileSync(f, 'utf8');
    assert(`${f}: no onFinal handler`, !/onFinal/.test(src));
    assert(`${f}: commits gated on snapshot.commit`, /snap\.commit|s\.commit/.test(src));
  }
  const main = readFileSync('src/main.ts', 'utf8');
  assert(
    'main.ts writes the section only from the idle branch',
    /s === 'idle'[\s\S]{0,900}?commitSpeechToSection\(draft\)/.test(main),
  );
  const tsx = readFileSync('src/web/Dictate.tsx', 'utf8');
  assert(
    'MicButton calls onText only from the idle branch',
    /s === 'idle'[\s\S]{0,700}?onTextRef\.current\(snap\.text\)/.test(tsx),
  );
}

console.log('\n── 7. the overlay actually reaches the screen (source) ──');
{
  const main = readFileSync('src/main.ts', 'utf8');
  // The Agents tab has its own dual-pane renderer that RETURNS early. Without
  // this guard the dictation overlay was computed but never drawn there.
  assert(
    'Agents dual-pane branch is skipped while an overlay is up',
    /activeSection === 'agents' && !overlayActive/.test(main),
  );
  assert(
    'overlayActive covers picker + dictation + diagnostics + foreign mirror',
    /const overlayActive = pickerActive \|\| dictationActive \|\| !!dictationDiagText \|\| foreignActive;/.test(
      main,
    ),
  );
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
