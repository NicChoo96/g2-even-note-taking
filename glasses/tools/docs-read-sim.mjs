#!/usr/bin/env node
// Long-document READ harness (docs.read / notes.read paging).
//
// WHY THIS EXISTS:
//   "Jarvis cant seem to read all the entire docs when I asked it to."
//   `docs.read` returned a flat 4000 characters and took NO cursor at all, so a
//   document longer than that could never be read in full however the request
//   was phrased — while the lens pages the very same body happily. Nothing in
//   this repo asserted a single thing about `docs.read`, so the ceiling sat
//   there unnoticed. This harness is that missing assertion.
//
//   What must not regress:
//     1. A short read is COMPLETE and UNMARKED. The absence of the marker is the
//        model's only proof that it has seen the whole document, so a stray
//        marker on a complete read is a bug, not a cosmetic issue.
//     2. A long read is CONTINUABLE and says how — both as a typed `next` cursor
//        and as a prose marker that must AGREE with it. Two channels that
//        disagree are worse than one.
//     3. Paging to the end RECONSTRUCTS the text byte-for-byte. This is the
//        strongest assertion available to us: it fails if a window boundary
//        drops or duplicates even one character.
//     4. Every read reports the TRUE total, so a window can never be mistaken
//        for the whole document (the wearer sees the total, and so does the
//        model — a "2600" that was really a length, not a cap).
//     5. A junk offset is CLAMPED, never handed straight to String.slice: an
//        out-of-range offset returns an EMPTY string, which reads to the model
//        as "the document is blank" — a wrong answer wearing a success.
//
//   This bundles the REAL src/ai/*, the real registry and the real app store
//   with a stubbed SDK, and drives the REAL capabilities. No network, no LLM.
//
// Run: node tools/docs-read-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// SIM_QUIET=1 prints only failures and the verdict.
const QUIET = !!process.env.SIM_QUIET;
let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  if (ok && QUIET) return;
  if (ok) console.log(`PASS  ${label}`);
  else
    console.log(
      `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`,
    );
}

function checkTrue(label, got) {
  const ok = got === true;
  if (ok) pass++;
  else fail++;
  if (ok && QUIET) return;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label} (got ${JSON.stringify(got)})`);
}

// ── Bundle the real modules ─────────────────────────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'docs-read-sim-'));
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

const outfile = join(out, 'ai.mjs');
await build({
  stdin: {
    // One bundle, so the harness and the capabilities share a single store.
    contents: `
export * from './ai/index.ts';
export { prepare, capabilityByName, toToolSchema } from './ai/registry.ts';
export { READ_CHARS } from './ai/capabilities/shared.ts';
export * as hub from './store.ts';
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
  define: { 'import.meta.env': '{}' },
});

// ── Fake host: localStorage + timers before any module loads ────────────────
globalThis.window = globalThis; // store.ts publishes through window.setTimeout
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
// The app stores publish to the relay on every edit; there is no relay here, so
// swallow it. Returning !ok also keeps store.ts from marking itself "in sync".
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });

const { prepare, capabilityByName, toToolSchema, READ_CHARS, hub } = await import(
  pathToFileURL(outfile).href
);

console.log(`read window: ${READ_CHARS} chars\n`);

// The window has to stay big enough that the common document is ONE call. A
// regression back to a small ceiling would otherwise still page correctly and
// pass every behavioural check below.
checkTrue('the read window is generous (>= 8000 chars)', READ_CHARS >= 8000);

// ── Drivers ─────────────────────────────────────────────────────────────────
function runCap(name, args, focus) {
  const p = prepare(name, args, focus);
  if (p.kind !== 'ready') return { ok: false, error: p.error, hint: p.hint };
  return p.prepared.cap.run(p.prepared.args);
}

/** The stored text, read from the store — the harness's ground truth. */
function storedDoc(title) {
  const d = hub.getState().sections.docs.find((x) => x.title === title);
  if (!d) throw new Error(`no document titled "${title}"`);
  return d.content;
}

function makeText(chars) {
  let s = '';
  let i = 0;
  while (s.length < chars) {
    s += `line ${String(i).padStart(4, '0')} ${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2)}\n`;
    i++;
  }
  // `.trim()` matches what docs.new does to seeded content, so the store's copy
  // and the harness's copy stay identical (and the byte-for-byte check is fair).
  return s.slice(0, chars).trim();
}

const MARKER = '\n…(truncated';

/**
 * Page a read capability to the end the way the MODEL would — following the
 * typed cursor, stripping the marker. Returns the concatenated text.
 */
function readToEnd(name, focus, target) {
  let offset;
  let text = '';
  let calls = 0;
  let last = null;
  for (;;) {
    const args = target === undefined ? {} : { doc: target };
    if (offset !== undefined) args.offset = offset;
    const res = runCap(name, args, focus);
    if (!res.ok) throw new Error(`${name} failed: ${res.summary}`);
    calls++;
    const body = String(res.data.content);
    const cut = body.indexOf(MARKER);
    text += cut === -1 ? body : body.slice(0, cut);
    last = res;
    if (!res.data.more) break;
    if (calls > 50) throw new Error(`${name} paging did not terminate`);
    offset = res.data.next;
  }
  return { text, calls, last };
}

// ── A short document: complete, unmarked ────────────────────────────────────
const SHORT = 'Alpha beta gamma.\nSecond line of the short document.';
runCap('docs.new', { title: 'Short Doc', content: SHORT }, 'docs');
const shortRead = runCap('docs.read', { doc: 'Short Doc' }, 'docs');

checkTrue('a short document reads ok', shortRead.ok === true);
check('…and comes back whole', shortRead.data.content, SHORT);
checkTrue('…with NO truncation marker', !shortRead.data.content.includes('truncated'));
check('…reporting more=false', shortRead.data.more, false);
check('…and offering no next cursor', shortRead.data.next, null);
check('…reporting the true total', shortRead.data.total, SHORT.length);
check('…and the summary names the full length', shortRead.summary, `Read "Short Doc" (${SHORT.length} chars)`);

// ── A long document: the actual reported bug ────────────────────────────────
const BIG_CHARS = READ_CHARS * 2 + 500;
runCap('docs.new', { title: 'Big Doc', content: makeText(BIG_CHARS) }, 'docs');
const big = storedDoc('Big Doc');
checkTrue('the long document really is longer than one read', big.length > READ_CHARS);

const r1 = runCap('docs.read', { doc: 'Big Doc' }, 'docs');
check('the first window starts at the beginning', r1.data.offset, 0);
check('…is exactly one window of text', r1.data.next - r1.data.offset, READ_CHARS);
check('…is flagged as partial', r1.data.more, true);
check('…reports the TRUE total, not the window', r1.data.total, big.length);
checkTrue('…and carries the resume marker', r1.data.content.includes('…(truncated'));
checkTrue(
  '…the marker names the same cursor the typed field gives',
  r1.data.content.includes(`call again with offset ${r1.data.next})`),
);
checkTrue(
  '…and the result also hints at the cursor',
  String(r1.hint ?? '').includes(`offset ${r1.data.next}`),
);
check(
  '…and the summary states the range AND the total',
  r1.summary,
  `Read "Big Doc" (0-${READ_CHARS} of ${big.length} chars)`,
);

// ── The strong one: paging reconstructs the document byte-for-byte ──────────
const paged = readToEnd('docs.read', 'docs', 'Big Doc');
check('paging to the end reconstructs the document byte-for-byte', paged.text, big);
checkTrue('…the final window carries no marker', !String(paged.last.data.content).includes('truncated'));
check('…the final window is flagged complete', paged.last.data.more, false);
check('…the final window offers no cursor', paged.last.data.next, null);
check('…and a two-and-a-bit window document took three calls', paged.calls, 3);
check('…the last read reports the true total', paged.last.data.total, big.length);

// ── Offset behaviour ────────────────────────────────────────────────────────
const nearEnd = big.length - 10;
const tail = runCap('docs.read', { doc: 'Big Doc', offset: nearEnd }, 'docs');
check('an offset near the end returns exactly the tail', tail.data.content, big.slice(nearEnd));
check('…is complete', tail.data.more, false);
check('…and reports the offset it used', tail.data.offset, nearEnd);

const past = runCap('docs.read', { doc: 'Big Doc', offset: big.length + 5000 }, 'docs');
checkTrue('an offset past the end does not crash', past.ok === true);
check('…and returns nothing rather than garbage', past.data.content, '');
check('…and is not flagged as partial', past.data.more, false);
check('…and clamps to a real position', past.data.offset, big.length);

const negative = runCap('docs.read', { doc: 'Big Doc', offset: -5 }, 'docs');
check('a negative offset clamps to the start', negative.data.offset, 0);
check('…so it reads the opening window', negative.data.next, READ_CHARS);

// The registry accepts a numeric STRING for a number param, so make sure the
// clamp sees it as a number rather than concatenating it.
const asString = runCap('docs.read', { doc: 'Big Doc', offset: String(READ_CHARS) }, 'docs');
check('a numeric-string offset is accepted', asString.data.offset, READ_CHARS);
check('…and returns the second window', asString.data.content.slice(0, 24), big.slice(READ_CHARS, READ_CHARS + 24));

const bad = prepare('docs.read', { doc: 'Big Doc', offset: 'later' }, 'docs');
check('an unparseable offset is REFUSED, not silently accepted', bad.kind, 'error');
check(
  '…with an error that names the argument',
  bad.error,
  'invalid arguments for docs__read: argument "offset" must be a number',
);

// ── The active-document fallback still works ────────────────────────────────
runCap('docs.open', { doc: 'Short Doc' }, 'docs');
const byActive = runCap('docs.read', {}, 'docs');
check('omitting doc reads the ACTIVE document', byActive.data.title, 'Short Doc');
check('…and returns it whole', byActive.data.content, SHORT);

// ── The model must be OFFERED the cursor as a number ────────────────────────
const schema = toToolSchema(capabilityByName('docs.read'));
check('the tool schema exposes offset', schema.function.parameters.properties.offset.type, 'number');
check('offset is optional in the schema', schema.function.parameters.required.includes('offset'), false);
checkTrue(
  'the description teaches the paging contract',
  /without the marker/i.test(schema.function.description),
);

// ── Notes: the same bug class, the same contract ────────────────────────────
const NOTES_LONG = makeText(READ_CHARS * 2 + 100);
hub.update((s) => ({ ...s, sections: { ...s.sections, notes: NOTES_LONG } }));

const nFirst = runCap('notes.read', {}, 'notes');
check('a long notes read reports the true total', nFirst.data.total, NOTES_LONG.length);
check('…is flagged partial', nFirst.data.more, true);
checkTrue('…carries the marker', nFirst.data.content.includes('…(truncated'));

const nPaged = readToEnd('notes.read', 'notes', undefined);
check('notes page to the end byte-for-byte too', nPaged.text, NOTES_LONG);
check('…and the last one is complete', nPaged.last.data.more, false);

const NOTES_SHORT = 'just one line of notes';
hub.update((s) => ({ ...s, sections: { ...s.sections, notes: NOTES_SHORT } }));
const nShort = runCap('notes.read', {}, 'notes');
check('a short notes read is complete and unmarked', nShort.data.content, NOTES_SHORT);
check('…with no cursor', nShort.data.next, null);
check('…and the original summary wording is preserved', nShort.summary, `Notes: ${NOTES_SHORT.length} chars`);

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log('');
if (fail === 0) {
  console.log(`ALL PASS — ${pass} checks`);
} else {
  console.log(`${fail} FAILURE(S) — ${pass} passed`);
  process.exitCode = 1;
}
