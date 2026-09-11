#!/usr/bin/env node
// Cross-surface mirror harness (Jarvis run mirror — `ai/sync.ts` + `ai/store.ts`).
//
// WHY THIS EXISTS:
//   BUG REPORT — "during the read mode in Jarvis, while I was reading halfway,
//   without even any interaction, the entire Jarvis mode just killed itself. The
//   contextual menu remained as 'Stop AI', but I have already exited Jarvis
//   mode."
//
//   That is a CONTRADICTION between two views of one session: the menu reads
//   `jarvisSession` (still set ⇒ "Stop AI"), the HUD reads the AI store (forced
//   to `idle` ⇒ the page underneath). This harness pins the four rules that stop
//   a frame from ANOTHER surface doing that:
//
//     1. an instance never re-broadcasts a run it is only mirroring;
//     2. it drops its own echo;
//     3. a mirror expires when its owner goes quiet;
//     4. it refuses a frame that carries no run (the `idle` frame), a frame that
//        is already older than the mirror TTL (a replay), and any frame when
//        THIS instance has something of its own on the canvas.
//
//   Rule 4a/b is the fix for the report. The relay used to keep the last `ai`
//   frame and hand it back as the `init` state of the NEXT connection, so a
//   finished run — or the idle frame a peer published minutes earlier — arrived
//   on a reconnect and overwrote the HUD mid-sentence, and because the store was
//   then `mirrored: true` with `status: 'idle'`, `mirrorExpired` could never
//   sweep that state back out again: dead screen, live menu, no way back except
//   the menu. Both sides of that are asserted here (client store + relay source).
//
// Run: node tools/jarvis-mirror-sim.mjs        (SIM_QUIET=1 for verdict only)

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const QUIET = !!process.env.SIM_QUIET;
let fail = 0;
let pass = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (ok && QUIET) return;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
};
const assert = (label, cond, detail = '') => {
  cond ? pass++ : fail++;
  if (cond && QUIET) return;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// ── Fake host ───────────────────────────────────────────────────────────────
globalThis.window = globalThis;
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
// No relay in a harness: every publish must fail quietly rather than throw.
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });

// ── Bundle the real store + the real sync layer ─────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'jarvis-mirror-sim-'));
const stub = join(out, 'sdk-stub.mjs');
writeFileSync(
  stub,
  `export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }
export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }
export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }
export const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
export const measureTextWrap = () => ({ lineCount: 1 });
`,
);

const outfile = join(out, 'mirror.mjs');
await build({
  stdin: {
    // One bundle, so the store the harness inspects IS the store sync.ts writes.
    contents: `
export * from './ai/store.ts';
export * from './ai/sync.ts';
`,
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

const mod = await import(pathToFileURL(outfile).href);
const {
  AI_INSTANCE_ID,
  MIRROR_MAX_AGE_MS,
  MIRROR_TTL_MS,
  acceptRemote,
  applyRemoteAi,
  getAi,
  isAiMirrored,
  localSnapshot,
  mayMirror,
  mirrorableStatus,
  mirrorExpired,
  resetAiForTest,
  aiBegin,
  aiFinish,
} = mod;

const SELF = 'ai-self';
const PEER = 'ai-peer';
const NOW = 1_700_000_000_000;

// ── A frame builder that mirrors what an owner actually publishes ───────────
const frame = (owner, patch = {}, at = NOW) => ({
  owner,
  at,
  status: 'running',
  focus: 'todo',
  utterance: 'add milk',
  steps: [],
  turn: 1,
  maxSteps: 6,
  pending: null,
  result: '',
  error: '',
  ...patch,
});

// ════════════════════════════════════════════════════════════════════════════
// 1. What counts as a run at all
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Mirror: which frames carry a run ──');

assert('a running frame is mirrorable', mirrorableStatus('running'));
assert('a pending confirm is mirrorable', mirrorableStatus('confirm'));
assert('a finished run is mirrorable (the peer HUD shows the answer)', mirrorableStatus('done'));
assert('a failed run is mirrorable', mirrorableStatus('error'));
assert('an IDLE frame is NOT mirrorable', !mirrorableStatus('idle'));
assert('an unknown status is NOT mirrorable', !mirrorableStatus('compiling'));
assert('a missing status is NOT mirrorable', !mirrorableStatus(undefined));

// ════════════════════════════════════════════════════════════════════════════
// 2. acceptRemote — ownership, freshness, and "is there a run on it"
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Mirror: accepting a frame ──');

check('a fresh peer run is accepted', acceptRemote(frame(PEER), SELF, NOW), true);
check('a frame from an unknown-but-other surface is accepted', acceptRemote(frame('ai-xyz'), SELF, NOW), true);
check('our own echo is dropped', acceptRemote(frame(SELF), SELF, NOW), false);
check('a frame with no owner is dropped', acceptRemote(frame(PEER, { owner: '' }), SELF, NOW), false);
check('a non-string owner is dropped', acceptRemote(frame(PEER, { owner: 7 }), SELF, NOW), false);
check('null is dropped', acceptRemote(null, SELF, NOW), false);
check('a non-object is dropped', acceptRemote('nope', SELF, NOW), false);

// ── THE BUG: an idle frame is not a run ─────────────────────────────────────
// Adopting one blanked the HUD (`status: 'idle'` ⇒ no overlay) while the Jarvis
// session flag survived, and left `mirrored: true`, which `mirrorExpired` can
// never clear — a dead screen with a live "Stop AI" in the menu.
check('a peer IDLE frame is refused', acceptRemote(frame(PEER, { status: 'idle' }), SELF, NOW), false);
check('a peer frame with an unknown status is refused', acceptRemote(frame(PEER, { status: 'x' }), SELF, NOW), false);

// ── THE REPLAY: a frame too old to be from this session ───────────────────
// The relay used to cache the last `ai` frame and send it as the `init` state of
// the next connection, so a run from an earlier connection arrived as if it were
// live. The bound is loose by design — `at` is the SENDER's clock — so the whole
// point is that it never fires on a frame that could be real.
check(
  'a frame from an earlier session is refused (a reconnect replay)',
  acceptRemote(frame(PEER, {}, NOW - MIRROR_MAX_AGE_MS - 1), SELF, NOW),
  false,
);
check(
  'a frame a minute old is still adopted (skew must not break mirroring)',
  acceptRemote(frame(PEER, {}, NOW - 60_000), SELF, NOW),
  true,
);
check(
  'a frame whose clock runs slightly AHEAD is adopted',
  acceptRemote(frame(PEER, {}, NOW + 5_000), SELF, NOW),
  true,
);
check('an undated frame is refused', acceptRemote(frame(PEER, { at: undefined }), SELF, NOW), false);
check('a non-numeric timestamp is refused', acceptRemote(frame(PEER, { at: 'now' }), SELF, NOW), false);
assert(
  'the replay window is far beyond anything a live frame could be',
  MIRROR_MAX_AGE_MS >= 60 * MIRROR_TTL_MS,
  `max-age=${MIRROR_MAX_AGE_MS} ttl=${MIRROR_TTL_MS}`,
);

// ════════════════════════════════════════════════════════════════════════════
// 3. mayMirror — a peer's run may only take an EMPTY canvas
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Mirror: whose canvas is it ──');

check('an idle local store offers the canvas', mayMirror({ status: 'idle', mirrored: false }), true);
check('a local run keeps the canvas', mayMirror({ status: 'running', mirrored: false }), false);
check('a local confirm keeps the canvas', mayMirror({ status: 'confirm', mirrored: false }), false);
check('a held reply keeps the canvas', mayMirror({ status: 'done', mirrored: false }), false);
check('a local failure keeps the canvas', mayMirror({ status: 'error', mirrored: false }), false);
check('an existing mirror may keep updating', mayMirror({ status: 'running', mirrored: true }), true);

// ════════════════════════════════════════════════════════════════════════════
// 4. The reported scenario, at the store level
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Mirror: the read-mode kill ──');

// The wearer is holding a finished reply (the read mode) — the transcript is on
// the HUD, `jarvisSession` is set, nothing is in flight.
resetAiForTest();
aiFinish('Nothing on your list.');
check('a held reply is on screen', getAi().status, 'done');
check('…and it is ours, not a mirror', isAiMirrored(), false);

// Each frame below is one the relay could have replayed onto a live connection.
const replayed = [
  ['an idle frame', frame(PEER, { status: 'idle', result: '' })],
  ['a replayed running frame', frame(PEER, {}, NOW - MIRROR_MAX_AGE_MS - 1)],
  [
    'a replayed finished frame',
    frame(PEER, { status: 'done', result: 'Something else' }, NOW - MIRROR_MAX_AGE_MS - 1),
  ],
];
for (const [what, frameFromPeer] of replayed) {
  const accepted = acceptRemote(frameFromPeer, SELF, NOW);
  check(`${what} from the relay is refused`, accepted, false);
  if (accepted) applyRemoteAi(frameFromPeer); // what the old code did unconditionally
}
check('the held reply survives every replay', getAi().result, 'Nothing on your list.');
check('…still on screen', getAi().status, 'done');
check('…and still not a mirror', isAiMirrored(), false);

// Nothing above may have left `mirrored && idle`, the one state `mirrorExpired`
// cannot clear: a cancelled run (or any local dismissal) must not strand a
// mirror's owner id on the store.
let stranded = 0;
for (const [, frameFromPeer] of replayed) {
  resetAiForTest();
  applyRemoteAi(frameFromPeer); // even if a caller skips acceptRemote
  if (getAi().mirrored && getAi().status === 'idle') stranded++;
  if (getAi().mirrored) {
    const swept = mirrorExpired(getAi().mirrored, getAi().status, NOW - MIRROR_TTL_MS - 1, NOW);
    if (!swept) stranded++; // a mirror we can never get rid of
  }
}
check('no frame can leave an un-sweepable mirror behind', stranded, 0);

// ════════════════════════════════════════════════════════════════════════════
// 5. …and the feature still works
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Mirror: the peer run still shows ──');

resetAiForTest();
check('an empty canvas may show a peer run', mayMirror(), true);
const live = frame(PEER, { status: 'running', focus: 'docs', utterance: 'clear the list' });
if (acceptRemote(live, SELF, NOW) && mayMirror()) applyRemoteAi(live);
check('the peer run is mirrored', isAiMirrored(), true);
check('…with its status', getAi().status, 'running');
check('…its focus', getAi().focus, 'docs');
check('…and its utterance', getAi().utterance, 'clear the list');
// The owner going quiet still expires it (rule 3), which is the only way this
// screen is allowed to disappear on its own.
check(
  'a silent owner still expires',
  mirrorExpired(getAi().mirrored, getAi().status, NOW - MIRROR_TTL_MS - 1, NOW),
  true,
);
applyRemoteAi(null);
check('…and the sweep returns the canvas', getAi().status, 'idle');
check('…with no mirror left behind', isAiMirrored(), false);

// Our OWN run must never be displaced by a peer frame: this is the case where a
// transcript the wearer is reading would be swapped mid-sentence.
resetAiForTest();
aiBegin('add milk', 'todo');
const before = getAi().steps.length;
check('our own run owns the canvas', mayMirror(), false);
if (mayMirror()) applyRemoteAi(frame(PEER, { status: 'done', result: 'Somebody else' }));
check('our run is untouched by a peer frame', getAi().status, 'running');
check('…its steps are untouched', getAi().steps.length, before);
check('…and it is still ours', isAiMirrored(), false);

// The snapshot we send must carry the stamp the freshness rule depends on.
resetAiForTest();
aiBegin('add milk', 'todo');
const snap = localSnapshot(NOW);
check('our own snapshot stamps the owner', snap.owner, AI_INSTANCE_ID);
check('our own snapshot stamps a timestamp', snap.at, NOW);
check('our own snapshot is rejected by its own sender', acceptRemote(snap, AI_INSTANCE_ID, NOW), false);

// ════════════════════════════════════════════════════════════════════════════
// 6. Source invariants — the two places that let this happen
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Mirror: source invariants ──');

// 6a. The relay must not keep a transient frame, because the SSE `init` frame is
//     what hands it to the next client. (`ai`/`ai-ctl` are live signals: they
//     are broadcast once and forgotten.)
const relaySrc = readFileSync(new URL('../../web/server/local-sse.mjs', import.meta.url), 'utf8');
assert('the relay declares its transient channels', /TRANSIENT_CHANNELS = new Set\(\['ai', 'ai-ctl'\]\)/.test(relaySrc));
const writes = relaySrc.match(/channel\.lastState = state;/g) ?? [];
const guarded = /if \(!TRANSIENT_CHANNELS\.has\(channel\.name\)\) \{\s*channel\.lastState = state;/.test(relaySrc);
check('the relay caches state in exactly one place', writes.length, 1);
assert('…and that place refuses transient channels', guarded);

// 6b. The menu must not promise "Stop AI" for a HUD that is not there: the item
//     is derived from what is on screen (a held reply, or an open Jarvis mic),
//     not from the session flag alone.
const mainSrc = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const listening = /aiListening:\s*jarvisSession &&[\s\S]{0,200}ai\.status === 'done'/.exec(mainSrc);
assert('the "Stop AI" item is derived from the visible conversation', !!listening);
assert(
  '…and no longer from the session flag alone',
  !/aiListening: jarvisSession && ai\.status !== 'running'/.test(mainSrc),
);

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
