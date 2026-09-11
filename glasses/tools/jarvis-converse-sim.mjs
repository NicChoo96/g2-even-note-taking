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
  CHAT_REPLY.length > 240 && CHAT_REPLY.length <= 480,
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

// ── 4. The reply budget ─────────────────────────────────────────────────────
console.log('\n── the reply budget follows the lane ──');
const longCmd = await runTurn('open the docs page', () => ({
  ok: true,
  message: { role: 'assistant', content: CHAT_REPLY },
}));
is('a command reply is still cut to the short cap', longCmd.res.reply.length, 240);
assert('and it is marked as cut', longCmd.res.reply.endsWith('…'), longCmd.res.reply.slice(-8));
assert('the chat reply is longer than the command reply', chat.res.reply.length > longCmd.res.reply.length);

// The say__reply capability clips its own argument before the loop ever sees it,
// so a slice left at 250 would pre-truncate every conversational answer.
const spoken = await callAction('say.reply', { text: 'x'.repeat(600) }, 'todo');
is('say__reply passes a conversational answer through', spoken.summary.length, 500);

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
