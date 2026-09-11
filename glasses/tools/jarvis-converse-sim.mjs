#!/usr/bin/env node
/**
 * WHY THIS EXISTS
 * ---------------
 * Jarvis used to answer a chat message with a status report: "you turn ONE
 * spoken sentence into app actions, or into one short answer". Talking to it was
 * not possible. Now a sentence that names nothing in the app gets a
 * CONVERSATION clause in the system prompt and a longer reply budget
 * (ai/converse.ts). Two things have to be true for that to be safe, and both of
 * them fail silently if they regress:
 *
 *   1. THE TRIGGER IS CAREFUL. It fires only when the sentence carries no page
 *      vocabulary (ids, titles and synonyms read LIVE from the registry) and no
 *      action verb. The dangerous direction is a FALSE POSITIVE — a real order
 *      read as chit-chat — so the battery below is mostly orders, including the
 *      ones that name the app nowhere: "go back", "make it the second one",
 *      "put it in the notes", "undo".
 *
 *   2. THE LANE IS ONE-SIDED. It only ever RELAXES a turn: an extra prompt
 *      paragraph and a bigger reply cap. It must NEVER change the tool list —
 *      no removal, no reordering — because that is what makes a wrong guess
 *      cheap: every action stays on the table and the clause itself tells the
 *      model to ignore it if the sentence turns out to refer to the app. The
 *      "same tools, same order" check below is that guarantee, pinned.
 *
 * It also covers the two smaller consequences: the answer is no longer printed
 * as a step as well as under the transcript (a chat reply is the whole message,
 * so a duplicate paragraph is the whole message twice), and a run that called
 * nothing says so on the HUD instead of claiming it did work.
 *
 * Run: node tools/jarvis-converse-sim.mjs        (SIM_QUIET=1 for the tally only)
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
  else bad(label, `${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 200))}`);
}
function lacks(label, haystack, needle) {
  if (!String(haystack).includes(needle)) ok(label);
  else bad(label, `${JSON.stringify(needle)} unexpectedly in ${JSON.stringify(String(haystack).slice(0, 200))}`);
}
function count(label, haystack, needle, want) {
  const n = String(haystack).split(needle).length - 1;
  if (n === want) ok(label);
  else bad(label, `${JSON.stringify(needle)} appeared ${n} time(s), want ${want}`);
}

// ── Fake host ───────────────────────────────────────────────────────────────
// Set up BEFORE any module loads: the stores read localStorage at import time
// and the durable layer reaches for a bridge on its own.
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

// ── Bundle the real modules ─────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'jarvis-converse-sim-'));
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
    contents: [
      "export * from './ai/index.ts';",
      "export * from './ai/registry.ts';",
      "export * from './ai/converse.ts';",
      "export { runAiAgent } from './ai/agent.ts';",
      "export { aiView } from './sections.ts';",
    ].join('\n'),
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

const M = await import(pathToFileURL(outfile).href);
const { aiView, callAction, conversePromptText, getAi, isConversational, listPages, registerPage, runAiAgent } = M;

// ── 1. The trigger ──────────────────────────────────────────────────────────
// The dangerous direction is a FALSE POSITIVE, so the order battery is the big
// one — and it includes the orders that name the app NOWHERE, which are the only
// ones a word list can plausibly miss.
console.log('\n── the trigger: orders must never read as chat ──');
const ORDERS = [
  'add milk to my shopping list',
  'what is on my list',
  'open my notes',
  'show me the docs',
  'go to settings',
  'run the news agent',
  'undo',
  'stop',
  'go back',
  'make it the second one',
  'put it in the notes',
  'remember that I park in bay 12',
  'tick the first one',
  'delete the last task',
  'check my agents',
  'switch to docs',
  'search for the meeting minutes',
  'what did the agent say',
  'read the document',
  'clear it',
  'start a new doc',
  'mark it done',
  'the other one',
  'summarise the docs for me',
  'append this to my quick notes',
  'show me my preferences',
];
for (const line of ORDERS) is(`order: ${line}`, isConversational(line), false);

console.log('\n── the trigger: talk must reach the conversation lane ──');
const CHATTY = [
  'hey how are you',
  'what do you think of this idea',
  'thanks, that was helpful',
  'tell me a joke',
  'what is the capital of France',
  'I am feeling tired today',
  'write me a poem about the sea',
  'good morning',
  'do you like jazz',
  'I think we should talk about something else',
  'how was your morning',
  'that is a very good point',
  'nice one, thank you',
];
for (const line of CHATTY) is(`chat: ${line}`, isConversational(line), true);

console.log('\n── the trigger: shape and degenerate input ──');
is('empty is not a conversation', isConversational(''), false);
is('whitespace is not a conversation', isConversational('   '), false);
is('null is not a conversation', isConversational(null), false);
is('undefined is not a conversation', isConversational(undefined), false);
// 70 words clears both word gates, so only the shape check can reject it.
is('a rambling blob is not a conversation', isConversational(Array(70).fill('hello').join(' ')), false);
is('a sentence just under the cap is', isConversational(Array(50).fill('hello').join(' ')), true);
// The registry supplies page TITLES too, and "To-Do" splits into "to" and "do".
// Without the filler filter, half of everything a person says is "the app".
is('the "to" and "do" of "To-Do" are not vocabulary', isConversational('to be honest I am not sure'), true);
is('but the squashed title still bites', isConversational('what is on my todo'), false);
is('the singular of a plural page alias still bites', isConversational('what did the agent say'), false);

// ── 2. The prompt ───────────────────────────────────────────────────────────
// One scripted transport, two utterances. Everything the loop is given is
// captured, so the prompt and the tool list can both be read back.
async function runTurn(utterance, script, focus = 'todo') {
  const box = { tools: null, system: '', turns: 0 };
  const llm = async ({ messages, tools }) => {
    box.turns += 1;
    if (!box.tools) {
      box.tools = (tools ?? []).map((t) => t.function.name);
      box.system = messages[0].content;
    }
    return script(box.turns);
  };
  const res = await runAiAgent({ utterance, focus, llm });
  return { res, box, steps: getAi().steps.map((s) => ({ kind: s.kind, text: s.text })) };
}

const CHAT_REPLY = [
  'Morning. Things are quiet here.',
  'I went back over the notes you left and put the two Friday items at the top of the list.',
  'Nothing is on fire, but the invoice one has been sitting there for three days, so it is worth a look when you have a minute.',
].join(' ');
assert(
  'the probe reply is longer than the command cap and shorter than the chat cap',
  CHAT_REPLY.length > 240 && CHAT_REPLY.length <= 720,
  `${CHAT_REPLY.length} chars`,
);

console.log('\n── the prompt gains a clause, and loses it again ──');
const chat = await runTurn('hey how are you', () => ({
  ok: true,
  message: { role: 'assistant', content: CHAT_REPLY },
}));
const chatView = aiView(getAi(), { conversing: true });
has('the chat prompt carries the conversation clause', chat.box.system, 'CONVERSATION — this sentence names nothing in the app');
has('the clause says the app wins', chat.box.system, 'THIS PARAGRAPH LOSES TO THE APP');
assert(
  'the clause lands after the rules it overrides',
  chat.box.system.indexOf('CONVERSATION —') > chat.box.system.indexOf('RULES'),
);
assert(
  'the clause lands before the live state it must not hide',
  chat.box.system.indexOf('CONVERSATION —') < chat.box.system.indexOf('LIVE APP STATE'),
);
has('the chat prompt still names the pages', chat.box.system, 'PAGES (route here');
assert('the chat prompt is not the empty string', chat.box.system.length > 500);
assert('the reply is kept whole', chat.res.reply === CHAT_REPLY, `${chat.res.reply.length} chars`);
assert('the chat run reports success', chat.res.ok, chat.res.error);

// ── 3. The tool list is untouched — the whole safety argument ────────────────
const cmd = await runTurn('add milk to my shopping list', (turn) =>
  turn === 1
    ? {
        ok: true,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'app__status', arguments: '{}' } }],
        },
      }
    : { ok: true, message: { role: 'assistant', content: 'Two tasks are open.' } },
);
const cmdView = aiView(getAi(), { conversing: true });

console.log('\n── the lane never changes what Jarvis can do ──');
check('the same tools, in the same order, both ways', chat.box.tools, cmd.box.tools);
assert('the tool list is not empty', chat.box.tools.length > 0, `${chat.box.tools.length} tool(s)`);
has('say__reply is still offered on a chat turn', chat.box.tools.join(','), 'say__reply');
has('the page actions are still offered on a chat turn', chat.box.tools.join(','), 'app__status');
lacks('the command prompt has no conversation clause', cmd.box.system, 'CONVERSATION —');
has('the command prompt still names the pages', cmd.box.system, 'PAGES (route here');
assert('the command run reports success', cmd.res.ok, cmd.res.error);

// ── 4. The answer is not cut to fit a lane ──────────────────────────────────
// The bug this guards, in full: the loop picked a reply budget from `converse`
// (240 for a command, 720 for a chat) and the model was TOLD to write to roughly
// the same size. So "the whole answer" was whatever survived the smaller of two
// guesses — and because the lane is inferred from the sentence, "what did the
// agent say?" named the app, counted as a command, and lost its answer at 240
// characters behind an ellipsis. The glasses PAGE the feed now (see sections.ts),
// so length is the HUD's problem and the loop has no business shortening a reply.
console.log('\n── the answer is not cut to fit a lane ──');

const longCmd = await runTurn('open the docs page', () => ({
  ok: true,
  message: { role: 'assistant', content: CHAT_REPLY },
}));
assert('a long answer on the COMMAND lane is not cut', longCmd.res.reply === CHAT_REPLY, `${longCmd.res.reply.length} chars`);
assert('and it carries no ellipsis', !longCmd.res.reply.endsWith('…'), longCmd.res.reply.slice(-8));

const VERBOSE = Array(4).fill(CHAT_REPLY).join(' ');
assert('the probe is longer than the old chat cap', VERBOSE.length > 720, `${VERBOSE.length} chars`);
const verbose = await runTurn('tell me everything about my day', () => ({
  ok: true,
  message: { role: 'assistant', content: VERBOSE },
}));
assert('a verbose answer is not cut either', verbose.res.reply === VERBOSE, `${verbose.res.reply.length} chars`);
assert('and it is not marked as cut', !verbose.res.reply.endsWith('…'), verbose.res.reply.slice(-8));

// A REAL answer, not a doubled probe: the whole point of the fix is that the
// wearer can ask for something long and get ALL of it. This is ~10 HUD pages,
// which the ring walks — the number that matters is that the string arrives
// EXACTLY as the model wrote it, ellipsis-free.
const ESSAY = Array.from(
  { length: 60 },
  (_, i) => `Point ${i + 1} about tea: the water matters more than the leaf, and the leaf matters more than the pot.`,
).join(' ');
assert('the essay probe runs to several HUD pages', ESSAY.length > 5000, `${ESSAY.length} chars`);
const essay = await runTurn('write me a long essay about tea', () => ({
  ok: true,
  message: { role: 'assistant', content: ESSAY },
}));
assert('a real long answer arrives whole', essay.res.reply === ESSAY, `${essay.res.reply.length} of ${ESSAY.length} chars`);
assert('and it is NOT marked as cut', !essay.res.reply.endsWith('…'), essay.res.reply.slice(-8));

// The cap is still a cap — a runaway reply is stopped, and the cut is VISIBLE.
// Above the backstop sits only nonsense, so nothing a person asked for is ever
// lost here; and it has to stay far enough above a real answer that raising it
// is never the fix for "my reply got cut".
const RUNAWAY = 'z'.repeat(9000);
const runaway = await runTurn('keep going forever', () => ({
  ok: true,
  message: { role: 'assistant', content: RUNAWAY },
}));
is('a runaway answer is stopped at the backstop', runaway.res.reply.length, 8000);
assert('and the cut is marked', runaway.res.reply.endsWith('…'), runaway.res.reply.slice(-8));
assert('the backstop sits clear of a real answer', 8000 >= Math.round(ESSAY.length * 1.25), `${ESSAY.length} vs 8000`);

// say__reply must not clip its own argument either. It used to slice at 1200, so
// a long answer reached the loop PRE-CLIPPED — silently, with no ellipsis at all
// — and `clean` never got the chance to be the one place a cut is decided.
const spoken = await callAction('say.reply', { text: 'x'.repeat(600) }, 'todo');
is('say__reply passes a conversational answer through', spoken.summary.length, 600);
const oversize = await callAction('say.reply', { text: 'x'.repeat(9000) }, 'todo');
is('say__reply does not pre-clip the loop', oversize.summary.length, 9000);

// …and end to end, through the tool the model actually calls.
const viaTool = await runTurn('tell me a joke', () => ({
  ok: true,
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'say__reply', arguments: JSON.stringify({ text: CHAT_REPLY }) } }],
  },
}));
const viaToolView = aiView(getAi(), { conversing: true });
assert('a say__reply answer survives the loop whole', viaTool.res.reply === CHAT_REPLY, `${viaTool.res.reply.length} chars`);

// The same, for a LONG answer through the tool a real conversational reply takes.
const longTool = await runTurn('explain the port strike to me', () => ({
  ok: true,
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'say__reply', arguments: JSON.stringify({ text: ESSAY }) } }],
  },
}));
assert(
  'a long say__reply answer survives the loop whole',
  longTool.res.reply === ESSAY,
  `${longTool.res.reply.length} of ${ESSAY.length} chars`,
);

// ── 5. The HUD: no duplicate answer, and an honest header ───────────────────
console.log('\n── the hud says what happened, once ──');
check('a missing tool call leaves only the seed step', chat.steps.map((s) => s.kind), ['focus']);
check('a say__reply run records the call, not the sentence', viaTool.steps.map((s) => s.kind), ['focus', 'call']);
const echoed = viaTool.steps.filter((s) => s.text.includes('Morning. Things are quiet'));
check('the answer is not also a step', echoed, []);
has('the answer is under the transcript', viaToolView.text, '= Morning. Things are quiet');
count('and only there', viaToolView.text, 'Morning. Things are quiet here.', 1);

has('a run that called nothing says it said something', chatView.text, 'JARVIS · said');
lacks('and does not claim it did work', chatView.text, 'JARVIS · done');
has('a run that called something still says done', cmdView.text, 'JARVIS · done');
lacks('and does not say it merely talked', cmdView.text, 'JARVIS · said');
has('a say__reply turn still reports work done', viaToolView.text, 'JARVIS · done');

// ── 6. The vocabulary is live, not frozen ───────────────────────────────────
// Last, because it mutates the registry.
console.log('\n── the vocabulary tracks the registry ──');
is('the forecast reads as chat before the page exists', isConversational('what is the forecast'), true);
registerPage({ id: 'weather', title: 'Weather', synonyms: ['forecast'], summary: 'Registered by the harness.' });
is('a page registered later bites', isConversational('what is the forecast'), false);
is('and its title too', isConversational('open the weather thing'), false);
assert('the catalog grew', listPages().length >= 6, `${listPages().length} page(s)`);
assert('the clause is a real block', conversePromptText().split('\n').length > 4);

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
