#!/usr/bin/env node
/**
 * WHY THIS EXISTS
 * ---------------
 * `ai/memory.ts` is the layer that lets Jarvis remember the previous
 * conversation, and every one of its promises is a silent one:
 *
 *   1. WHAT IT REPLAYS. `memoryMessages()` walks the log BACKWARDS and stops at
 *      a count AND a char budget — but it must never drop the newest turn, even
 *      when that one turn alone is over budget. Losing the exchange that just
 *      happened is precisely the bug this module was written to fix, so the
 *      guard is the point, not a detail.
 *
 *   2. WHEN IT FORGETS. The wearer asked for a 100k-word cap and a ~400-word
 *      digest once it is hit. Compaction folds everything except the newest
 *      KEEP_TURNS into a model-written summary and drops what it covered. If it
 *      mis-slices, it either discards live history (`folded` lies) or never
 *      shrinks (the cap is fiction).
 *
 *   3. WHAT IT KEEPS ON FAILURE. The summarising call is a network call. A relay
 *      that is down must cost nothing, so a failed compaction has to leave the
 *      verbatim log exactly as it was and report `false`.
 *
 *   4. THAT IT SURVIVES A RESTART. The log is persisted through a WebView
 *      storage bridge, sanitized on the way back in, and `hydrateMemory()` is
 *      idempotent — while `resetMemory()` must beat a hydrate that arrives late,
 *      or a wearer who clears their memory gets it back.
 *
 * This harness drives the real module with plain objects and a stubbed `ask`.
 * `hydrateMemory()` latches on first call, so the storage cases run against
 * SEPARATE module instances (one bundle, imported under different URLs) — each
 * import gets fresh module state while sharing the fake localStorage.
 *
 * Run: node tools/jarvis-memory-sim.mjs        (SIM_QUIET=1 for the tally only)
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const QUIET = !!process.env.SIM_QUIET;
let fail = 0;
let pass = 0;

function ok(label) {
  pass += 1;
  if (!QUIET) console.log(`  ok   ${label}`);
}
function bad(label, detail) {
  fail += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok(label);
  else bad(label, `got ${g}, want ${w}`);
}
function is(label, got, want) {
  if (got === want) ok(label);
  else bad(label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function assert(label, cond, detail = '') {
  if (cond) ok(label);
  else bad(label, detail);
}
function has(label, haystack, needle) {
  if (String(haystack).includes(needle)) ok(label);
  else bad(label, `${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 220))}`);
}
function lacks(label, haystack, needle) {
  if (!String(haystack).includes(needle)) ok(label);
  else bad(label, `${JSON.stringify(needle)} unexpectedly in ${JSON.stringify(String(haystack).slice(0, 220))}`);
}
/** Words the way a person counts them — computed here, not asked of the module. */
const words = (s) => (String(s).trim() ? String(s).trim().split(/\s+/).length : 0);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Fake host ───────────────────────────────────────────────────────────────
// Set up BEFORE any module loads: the durable layer reads localStorage.
globalThis.window = globalThis;
// Node 26 defines `navigator` as a getter-only global, so redefine rather than assign.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node' },
  configurable: true,
  writable: true,
});
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
globalThis.fetch = async () => ({
  ok: false,
  status: 404,
  json: async () => ({ ok: false, error: 'not stubbed' }),
  text: async () => '{"ok":false}',
});

// The storage key is a contract: the app writes it through the WebView bridge and
// reads it back on the next boot, so pin the literal here.
const KEY = 'hub:ai-memory';
const seed = (value) => mem.set(KEY, typeof value === 'string' ? value : JSON.stringify(value));
const stored = () => {
  const raw = mem.get(KEY);
  try {
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return raw;
  }
};

// ── Bundle the real module ──────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'jarvis-memory-sim-'));
const stub = join(dir, 'sdk-stub.mjs');
writeFileSync(
  stub,
  [
    'export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }',
    'export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }',
    'export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }',
    'export const utf8ByteLength = (s) => Buffer.byteLength(s, "utf8");',
    'export const measureTextWrap = () => ({ lineCount: 1 });',
    'export default {};',
  ].join('\n'),
);
const outfile = join(dir, 'bundle.mjs');
await build({
  stdin: {
    contents: ["export * from './ai/memory.ts';", "export { memoryPromptText } from './ai/memory.ts';"].join('\n'),
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  alias: { '@evenrealities/even_hub_sdk': stub },
  define: { 'import.meta.env': '{}' },
});

const url = pathToFileURL(outfile).href;
/** A fresh module instance, sharing the one fake localStorage. */
const fresh = (tag) => import(`${url}?${tag}`);

const A = await fresh('a');
const {
  MEMORY_DIGEST_WORDS,
  MEMORY_MAX_WORDS,
  compactMemory,
  countWords,
  getMemoryView,
  isCompacting,
  memoryMessages,
  memoryPromptText,
  rememberExchange,
  rememberSpoken,
  resetMemory,
  subscribeMemory,
} = A;

// ── 1. Counting and the empty state ─────────────────────────────────────────
console.log('\n── empty ──');
is('nothing counts as nothing', countWords(''), 0);
is('whitespace counts as nothing', countWords('   \n\t '), 0);
is('words are whitespace-separated', countWords('one  two\nthree'), 3);
check('an empty log tells the model nothing', memoryPromptText(), '');
check('an empty log replays nothing', memoryMessages(), []);
check('an empty log reports nothing', [getMemoryView().turns, getMemoryView().words, getMemoryView().digest], [0, 0, '']);
is('the cap is the number the wearer was given', MEMORY_MAX_WORDS, 100_000);
is('the digest target is the number the wearer was given', MEMORY_DIGEST_WORDS, 400);
assert('the view object is cached by identity', getMemoryView() === getMemoryView());
check('nothing is stored before the first turn', stored(), null);

// ── 2. Writing an exchange ──────────────────────────────────────────────────
console.log('\n── writing ──');
let events = 0;
const off = subscribeMemory(() => {
  events += 1;
});
let view = getMemoryView();
rememberExchange('what is on my list', 'Two open tasks.', 1000);
is('a listener hears the request and the answer', events, 2);
check('the exchange orders user then assistant', getMemoryView().turns, 2);
const turns = memoryMessages();
check('the wearer turn came first', [turns[0].role, turns[0].text, turns[0].at], ['user', 'what is on my list', 1000]);
check('the answer follows it', [turns[1].role, turns[1].text, turns[1].at], ['assistant', 'Two open tasks.', 1001]);
assert('the cached view is invalidated by the write', getMemoryView() !== view);
view = getMemoryView();
is('the view counts the turns', view.turns, 2);
is('the view counts the words', view.words, words('what is on my list') + words('Two open tasks.'));
off();
rememberExchange('are you sure', 'Yes.', 2000);
is('an unsubscribed listener hears nothing', events, 2);
is('but the log still grew', getMemoryView().turns, 4);

// A run with no spoken answer still records the request.
rememberExchange('did it work', '', 3000);
check('an empty answer adds no assistant turn', memoryMessages().slice(-1).map((t) => t.role), ['user']);
rememberSpoken('a   b\n\n  c  ', 4000);
check('prose is collapsed to one line', memoryMessages().slice(-1).map((t) => t.text), ['a b c']);
rememberSpoken('y'.repeat(5000), 5000);
is('a single turn is capped', memoryMessages().slice(-1)[0].text.length, 2000);
await tick();
const blob = stored();
assert('the log reaches storage', !!blob && Array.isArray(blob.turns), typeof blob);
is('the stored log matches the live one', blob.turns.length, getMemoryView().turns);
assert('the stored log carries a version', typeof blob.version === 'number');
has('the model is told what it remembers', memoryPromptText(), 'MEMORY (earlier conversations');
has('the prompt says how many turns are held', memoryPromptText(), 'Remembered: 7 recent turn(s)');
lacks('nothing has been summarised yet', memoryPromptText(), 'plus a summary of');

// ── 3. What gets replayed ───────────────────────────────────────────────────
console.log('\n── the replay window ──');
resetMemory();
for (let i = 1; i <= 8; i++) rememberExchange(`question ${i}`, `answer ${i}`, 10_000 + i * 10);
is('the default window is six turns', memoryMessages().length, 6);
check('the window is the newest six, oldest first', memoryMessages().map((t) => t.text), [
  'question 6',
  'answer 6',
  'question 7',
  'answer 7',
  'question 8',
  'answer 8',
]);
is('an explicit window is honoured', memoryMessages(2).length, 2);
check('and it is still the newest', memoryMessages(2).map((t) => t.text), ['question 8', 'answer 8']);
is('a window of one is one', memoryMessages(1).length, 1);
is('a window of zero is empty', memoryMessages(0).length, 0);

resetMemory();
rememberSpoken('z'.repeat(2000), 60_000);
const lonely = memoryMessages();
is('the newest turn survives being over the char budget on its own', lonely.length, 1);
is('and it is the long one', lonely[0].text.length, 2000);
rememberSpoken('the immediate follow-up', 60_100);
check('a long neighbour does not evict the newest', memoryMessages().map((t) => t.text), ['the immediate follow-up']);

// ── 4. Compaction ───────────────────────────────────────────────────────────
console.log('\n── compaction ──');
resetMemory();
// Exchanges, not bare turns: the transcript the model is handed has to label
// both speakers, and rememberSpoken() only ever writes a wearer turn.
for (let i = 1; i <= 10; i++) rememberExchange(`turn ${2 * i - 1}`, `turn ${2 * i}`, i);
is('twenty turns is exactly the keep-window', getMemoryView().turns, 20);
let asked = 0;
is('nothing is folded while the log fits in the keep-window', await compactMemory(async () => (asked += 1, 'summary')), false);
is('and the model was not asked', asked, 0);

for (let i = 11; i <= 13; i++) rememberExchange(`turn ${2 * i - 1}`, `turn ${2 * i}`, i);
is('the log is now past the keep-window', getMemoryView().turns, 26);
let prompt = '';
const DRILL = 'The wearer asked about turn one and Jarvis answered.';
is(
  'a long log folds',
  await compactMemory(async (p) => {
    prompt = p;
    return DRILL;
  }),
  true,
);
has('the compaction prompt carries the old summary slot', prompt, '[existing summary]');
has('and the new transcript', prompt, '[new transcript]');
has('the transcript names the wearer speaker', prompt, 'Wearer: turn 1');
has('and the assistant speaker', prompt, 'Jarvis: turn 2');
has('the prompt asks for the agreed length', prompt, 'at most 400 words');
has('the prompt says not to restart the summary', prompt, 'do not restart it');
const folded = getMemoryView();
is('only the newest twenty turns are kept', folded.turns, 20);
is('the six older turns are counted as folded', folded.folded, 6);
check('the digest is the model summary', folded.digest, DRILL);
check('the kept turns are the newest', memoryMessages(2).map((t) => t.text), ['turn 25', 'turn 26']);
has('the prompt reports the digest', memoryPromptText(), DRILL);
has('the prompt reports the fold', memoryPromptText(), 'plus a summary of 6 older turn(s)');
await tick();
is('persisted on the way out', stored().folded, 6);

// A digest is prose, not a document: 600 words in, 400 out, and DSML markup is
// scrubbed on the way through — the model that writes the summary is the same
// model that leaks tool markup.
for (let i = 27; i <= 46; i++) rememberSpoken(`turn ${i}`, i);
is('the log is forty turns again', getMemoryView().turns, 40);
const long = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ');
is(
  'a second fold runs',
  await compactMemory(async () => `Summary. <tool_calls> <invoke name="x"></invoke> </tool_calls> ${long}`),
  true,
);
const twice = getMemoryView();
is('the digest is cut to the agreed length', words(twice.digest), 400);
lacks('tool markup is stripped from the digest', twice.digest, 'tool_calls');
lacks('and its invoke tags with it', twice.digest, 'invoke');
has('the new summary is merged in front of the old prose', twice.digest, 'Summary.');
is('the fold count accumulates', twice.folded, 26);
is('the kept window is still twenty', twice.turns, 20);

// Failure must cost nothing.
for (let i = 47; i <= 66; i++) rememberSpoken(`turn ${i}`, i);
const before = getMemoryView();
is(
  'a relay failure is reported, not thrown',
  await compactMemory(async () => {
    throw new Error('relay down');
  }),
  false,
);
is('and nothing was folded', getMemoryView().turns, before.turns);
check('and the digest is untouched', getMemoryView().digest, before.digest);
is('and the fold count is untouched', getMemoryView().folded, before.folded);
is('an empty summary is refused', await compactMemory(async () => '   '), false);
is('and still folds nothing', getMemoryView().turns, before.turns);
is('the module is no longer compacting', isCompacting(), false);

// Two folds must not race: the second call during an in-flight first is a no-op.
let release;
const gate = new Promise((r) => {
  release = r;
});
const first = compactMemory(async () => {
  await gate;
  return 'the slow summary';
});
await tick();
is('a fold in flight is visible', isCompacting(), true);
is('a second fold refuses while one is running', await compactMemory(async () => 'the fast summary'), false);
release();
is('the first fold completes', await first, true);
is('and the lock is released', isCompacting(), false);
is('the running fold is the one that landed', getMemoryView().digest, 'the slow summary');

// ── 5. Forgetting ───────────────────────────────────────────────────────────
console.log('\n── forgetting ──');
resetMemory();
await tick();
const gone = getMemoryView();
check('the view is cleared', [gone.turns, gone.folded, gone.words, gone.digest], [0, 0, 0, '']);
check('nothing is replayed', memoryMessages(), []);
check('the model is told nothing', memoryPromptText(), '');
is('storage is cleared with it', mem.get(KEY) ?? null, null);

// ── 6. Storage on the way back in ───────────────────────────────────────────
// Each case needs its own module instance: hydrateMemory() latches on first call.
console.log('\n── hydration ──');
mem.clear();
const goods = [
  { role: 'user', text: 'i park in bay 12', at: 100 },
  { role: 'bogus', text: 'unknown role is coerced', at: 200 },
  { role: 'assistant', text: 'noted', at: 300 },
  { text: 'no role at all' },
  { role: 'user', text: 42, at: 400 },
];
seed({ version: 1, digest: 'The wearer parks in bay 12.', digestAt: 50, folded: 3, turns: goods, updatedAt: 500 });
const B = await fresh('b');
await B.hydrateMemory();
const back = B.getMemoryView();
check('the digest comes back', back.digest, 'The wearer parks in bay 12.');
is('the fold count comes back', back.folded, 3);
is('only usable turns are kept', back.turns, 4);
check('and their order is preserved', B.memoryMessages().map((t) => t.text), [
  'i park in bay 12',
  'unknown role is coerced',
  'noted',
  'no role at all',
]);
is('an unknown role becomes a wearer turn', B.memoryMessages()[1].role, 'user');
is('and its prose is intact', B.memoryMessages()[1].text, 'unknown role is coerced');
has('the prompt reports what came back', B.memoryPromptText(), 'bay 12');

// The latch: a second hydrate is a no-op even with different storage behind it.
seed({ version: 1, digest: 'a different life', digestAt: 1, folded: 9, turns: [{ role: 'user', text: 'second boot', at: 1 }] });
await B.hydrateMemory();
is('hydrate is idempotent', B.getMemoryView().turns, 4);
lacks('and the second blob is ignored', B.getMemoryView().digest, 'a different life');

// A corrupt blob must not stop the app.
mem.clear();
seed('{ this is not json');
const C = await fresh('c');
await C.hydrateMemory();
check('an unparseable log starts empty', [C.getMemoryView().turns, C.getMemoryView().digest], [0, '']);
mem.clear();
seed('null');
const D = await fresh('d');
await D.hydrateMemory();
check('a null log starts empty', [D.getMemoryView().turns, D.getMemoryView().digest], [0, '']);

// Clearing memory must beat a hydrate that arrives afterwards. resetMemory()
// latches as hydrated for exactly this reason: the wearer asked to forget.
mem.clear();
seed({ version: 1, digest: 'the old life', digestAt: 0, turns: [{ role: 'user', text: 'old turn', at: 1 }] });
const E = await fresh('e');
E.resetMemory();
await E.hydrateMemory();
check('a cleared log stays cleared', [E.getMemoryView().turns, E.getMemoryView().digest], [0, '']);
is('and storage stays cleared', mem.get(KEY) ?? null, null);

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
