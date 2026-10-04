#!/usr/bin/env node
// Harness for the delegated-intent tool — web/server/intents.mjs.
//
// WHY THIS EXISTS. This module is the relay's half of D2, and every property it
// has is one a reader would otherwise have to take on trust:
//
//   • It holds NO list of the app's actions. The catalogue arrives with the run
//     and is forwarded. The load-bearing consequence is asserted by MUTATION —
//     rename an action in the catalogue and the enum must lose it — because a
//     hard-coded enum would pass every other check in this file.
//   • The `action` enum the model is offered and the set this module accepts are
//     the SAME array. That is the `hubMcpToolSchema` discipline, and section C
//     asserts it by construction rather than by eye.
//   • A proposal is never an effect. Nothing here writes anywhere: the tool
//     records an ask and returns. Asserted by counting list writes.
//   • A refusal is TEXT. `runToolOnce` puts the return value straight into the
//     transcript, so an exception here would abort a run over a rejected propose
//     and discard the turns before it.
//
// Sections G and H are SOURCE assertions, and they exist because the failure they
// guard is SILENT. Nothing throws when the router drops the intent tool from the
// offer, or when a new trigger path forgets to send the catalogue: the agent
// simply never asks for anything, every behavioural check above still passes, and
// the feature is gone. The wiring is therefore pinned to the code that carries it.
//
// Run: node tools/app-intent-sim.mjs

import { readFileSync } from 'node:fs';

import {
  INTENT_MAX_CATALOG,
  INTENT_MAX_PER_RUN,
  INTENT_TOOL_KIND,
  INTENT_TOOL_NAME,
  MAX_ARGS_CHARS,
  intentToolFor,
  intentToolSchema,
  isIntentTool,
  runIntentTool,
} from '../../web/server/intents.mjs';

let fail = 0;
let checks = 0;
const assert = (label, cond, detail = '') => {
  checks++;
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  assert(
    label,
    JSON.stringify(got) === JSON.stringify(want),
    JSON.stringify(got) === JSON.stringify(want)
      ? ''
      : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`);
/** Present in a source slice — used by the wiring sections, where "it is there" is the whole assertion. */
const has = (label, haystack, needle, detail = '') => {
  const found = String(haystack).includes(needle);
  return assert(label, found, found ? detail : `\n      missing: ${needle}`);
};
/** Absent from a source slice — the negative twin of `has`. */
const unset = (label, haystack, needle, detail = '') => {
  const found = String(haystack).includes(needle);
  return assert(label, !found, found ? `\n      unexpected: ${needle}` : detail);
};

/** The hub's TOOL_KINDS as probed live on POST /hub/tools (see hub-mcp-tools-sim). */
const HUB_TOOL_KINDS = ['web', 'tavily', 'http', 'jev', 'files', 'todo', 'docs', 'notes', 'location'];

/** A catalogue in the shape the device sends, with every field exercised. */
const CATALOG = [
  {
    name: 'todo.add',
    title: 'Add a to-do',
    page: 'todo',
    effect: 'write',
    description: 'Add one item to the list.',
    params: [{ name: 'text', type: 'string', description: 'The item.', required: true }],
  },
  {
    name: 'todo.clear_all',
    title: 'Clear the list',
    page: 'todo',
    effect: 'irreversible',
    description: 'Delete every to-do.',
    params: [],
  },
  {
    name: 'agents.trigger',
    title: 'Run an agent',
    page: 'agents',
    effect: 'write',
    description: 'Start a saved agent.',
    params: [{ name: 'agent', type: 'string', description: 'Which one.', required: false }],
  },
  // In the catalogue because the false-success bug was reported against it: this
  // is the action whose argument is a whole document, so it is the one the size
  // ceiling was silently refusing.
  {
    name: 'files.publish',
    title: 'Publish an HTML page',
    page: 'files',
    effect: 'write',
    description: 'Publish a self-contained HTML document to the document store.',
    params: [{ name: 'html', type: 'string', description: 'The complete HTML document.', required: true }],
  },
];

const TOOL = () => intentToolFor(CATALOG);
/** Call and parse, so a THROW is a visible failure instead of a crash. */
function call(tool, args, ctx = {}) {
  try {
    return JSON.parse(runIntentTool(tool, args, ctx));
  } catch (err) {
    fail++;
    checks++;
    console.log(`FAIL  runIntentTool THREW instead of returning JSON: ${err?.message}`);
    return { ok: false, summary: `<<THREW ${err?.message}>>` };
  }
}
/** A run's proposal list, as local-sse keeps it in its side table. */
const newList = () => [];

// ═══════════════════════════════════════════════════════════════════════════
section('A. the marker, and why this cannot be an authored row');

// ⭐ The marker must be a kind the hub CANNOT mint. If it were one of the nine, a
// stored row would be indistinguishable from this built-in.
assert('the marker is NOT one of the hub\'s nine tool kinds', !HUB_TOOL_KINDS.includes(INTENT_TOOL_KIND));
eq('the vocabulary really is nine, as probed', HUB_TOOL_KINDS.length, 9);
eq('the name the model sees is the one the prompt names', INTENT_TOOL_NAME, 'jarvis_app');

// Identity is by KIND, not by name — a wearer's own tool may be called anything.
assert('matches on the marker', isIntentTool({ kind: INTENT_TOOL_KIND }));
assert('a row with the same NAME is not one of ours', !isIntentTool({ kind: 'http', name: INTENT_TOOL_NAME }));
assert('and neither is a missing tool', !isIntentTool(undefined) && !isIntentTool(null));

// ═══════════════════════════════════════════════════════════════════════════
section('B. the catalogue is the device\'s, and is sanitised rather than trusted');

eq('no catalogue, no tool', intentToolFor(undefined), null);
eq('an empty catalogue is no tool', intentToolFor([]), null);
eq('a non-array is no tool', intentToolFor({ name: 'todo.add' }), null);
eq(
  'entries that are not app actions are dropped, not repaired',
  intentToolFor([
    null,
    'todo.add',
    { name: 'no_dot_here' },
    { name: '   ' },
    { title: 'a title with no name' },
    { name: 'todo.add' },
    { name: 'todo.add', title: 'the same name twice' },
  ]).catalog.map((c) => c.name),
  ['todo.add'],
);
eq('the built-in carries the built-in marker and a stable id', [TOOL().kind, TOOL().id], [INTENT_TOOL_KIND, 'builtin:jarvis_app']);
eq('name and toolId agree, as every built-in does', TOOL().toolId, TOOL().name);
// The SCHEMA's description is what the model reads, so that is where the three
// things it cannot recover from being wrong about have to be.
const SCHEMA_TEXT = intentToolSchema(TOOL()).function.description;
assert(
  'the schema tells the model it will not see the result',
  SCHEMA_TEXT.includes('will not see the result'),
);
assert(
  'and that the device may ask the wearer first',
  SCHEMA_TEXT.includes('confirm'),
);
// ⭐ THE PROHIBITION, which is the fix for the reported bug.
//
// A run's transcript is read as evidence of what happened, and nothing
// downstream can correct it: the relay hands the ask over and never learns the
// outcome, and the wearer does not see the device's result either. So a model
// that reports an ask as a completed change makes the transcript lie, and the
// only place that can be prevented is here — in the words of the schema it is
// holding. This was the missing half: the description said "you will not see
// the result" and then, in the same breath, "say what you asked for and finish",
// which licenses exactly the sentence the wearer then believed.
assert(
  'the schema forbids reporting the change as done',
  SCHEMA_TEXT.includes('never report the change as done'),
);
// And the schema has to NAME the way work gets saved. A run asked for a report
// reads the action list to find out how to store it, and a tool described only
// as "change something of the wearer's" gives it nothing to find.
assert(
  'the schema names the action that saves an agent\'s own work',
  SCHEMA_TEXT.includes('files.publish') && SCHEMA_TEXT.includes('SAVE'),
);

const crowded = intentToolFor(
  Array.from({ length: INTENT_MAX_CATALOG + 7 }, (_, i) => ({ name: `page.action_${i}`, title: `t${i}` })),
);
eq('a crowded catalogue is truncated', crowded.catalog.length, INTENT_MAX_CATALOG);
assert(
  'truncation is safe because the enum is built from the truncated list',
  intentToolSchema(crowded).function.parameters.properties.action.enum.length === INTENT_MAX_CATALOG,
);

const padded = intentToolFor([
  {
    name: 'docs.new',
    title: 'x'.repeat(200),
    effect: undefined,
    description: 'y'.repeat(1000),
    params: [
      { name: 'p1', description: 'z'.repeat(500) },
      { name: 'p2' },
      { name: 'p3' },
      { name: 'p4' },
      { name: 'p5' },
      { name: 'p6' },
      { name: 'p7' },
      { description: 'a param with no name' },
    ],
  },
]).catalog[0];
assert('the effect defaults to write when the device omits it', padded.effect === 'write');
assert('a title is clipped', padded.title.length <= 60, `${padded.title.length}`);
assert('a description is clipped', padded.description.length <= 240, `${padded.description.length}`);
eq('a param list is capped', padded.params.length, 6);
assert('a param description is clipped', padded.params[0].description.length <= 120);
assert('a nameless param is dropped', padded.params.every((p) => typeof p.name === 'string' && p.name));

// ═══════════════════════════════════════════════════════════════════════════
section('C. the enum and the accepted set are one array');

const schema = intentToolSchema(TOOL());
const props = schema.function.parameters.properties;
eq('the tool is named for the relay-side tool name', schema.function.name, INTENT_TOOL_NAME);
eq('the enum IS the catalogue, in order', props.action.enum, CATALOG.map((c) => c.name));
eq('only action and why are required', schema.function.parameters.required, ['action', 'why']);
for (const entry of CATALOG) {
  assert(
    `the action description carries ${entry.name}'s effect and title`,
    props.action.description.includes(`${entry.name} (${entry.effect}) - ${entry.title}`),
  );
}

// ⭐ THE MUTATION CONTROL. Without this, a hard-coded enum would pass section C.
const renamed = intentToolSchema(
  intentToolFor(CATALOG.map((c) => (c.name === 'todo.add' ? { ...c, name: 'todo.append' } : c))),
);
assert('CONTROL: renaming an action in the catalogue removes it from the enum', !renamed.function.parameters.properties.action.enum.includes('todo.add'));
assert('CONTROL: and adds the new name', renamed.function.parameters.properties.action.enum.includes('todo.append'));

// ⭐ And the other direction: the enum a model sees must be a subset of what the
// tool will actually accept. Asserted by ASKING for each advertised action and
// requiring that none of them is refused as unknown.
const refused = TOOL().catalog
  .map((c) => c.name)
  .filter((name) => call(TOOL(), { action: name, why: 'because', args: {} }, { list: newList(), runId: 'r' }).summary.startsWith('no such app action'));
eq('every advertised action is a known action', refused, []);

// ═══════════════════════════════════════════════════════════════════════════
section('D. a proposal is recorded, never performed');

const list = newList();
const first = call(TOOL(), { action: 'todo.add', why: 'the wearer asked for milk', args: { text: 'milk' } }, { list, runId: 'run-7' });
assert('a known action is accepted', first.ok === true, `summary: ${first.summary}`);
eq('the list grows by exactly one', list.length, 1);
eq('nothing outside the list was touched', Object.keys(first.data), ['intent']);
eq('the key is namespaced by the run and its position', first.data.intent.key, 'run-7:1');
eq('the title comes from the catalogue, not from the model', first.data.intent.title, 'Add a to-do');
eq('so does the effect', first.data.intent.effect, 'write');
eq('the arguments are what the model sent', first.data.intent.args, { text: 'milk' });
eq('the why is what the prompt will show', first.data.intent.why, 'the wearer asked for milk');
// The tool result IS the model's last sight of its own ask, and it is read again
// whenever the transcript is replayed — so a hint that reads as "finished" is
// what licenses the sentence the wearer then believes.
assert('the hint forbids reporting the change as done', String(first.hint).includes('never that it is done'));
assert('and the summary is past-tense ASKED, never a completion', String(first.summary).startsWith('asked the app to '));

// ⭐ The exact field set, because the DEVICE reads this shape when it claims a
// proposal (src/ai/intents.ts, `intentsFromMessages`). A rename here would
// silently produce a run whose asks were never claimed.
eq(
  'the intent shape the device parses',
  Object.keys(first.data.intent).sort(),
  ['action', 'args', 'effect', 'key', 'title', 'why'],
);

const second = call(TOOL(), { action: 'todo.clear_all', why: 'start the week clean' }, { list, runId: 'run-7' });
eq('a second, different ask gets the next key', second.data.intent.key, 'run-7:2');
eq('an irreversible action is offered like any other', second.data.intent.effect, 'irreversible');
eq('and its empty argument list is preserved', second.data.intent.args, {});
eq('the list now holds two', list.length, 2);

const again = call(TOOL(), { action: 'todo.add', why: 'saying it twice', args: { text: 'milk' } }, { list, runId: 'run-7' });
eq('the same ask twice is not an error', again.ok, true);
eq('it returns the FIRST key, so the device dedupes', again.data.intent.key, 'run-7:1');
eq('and the list did not grow', list.length, 2);
assert('and it says so plainly', String(again.summary).startsWith('already proposed'));
assert('the duplicate is marked as one', again.data.duplicate === true);
// Different ARGS is a different ask — the dedupe is on the whole request.
const other = call(TOOL(), { action: 'todo.add', why: 'a second item', args: { text: 'bread' } }, { list, runId: 'run-7' });
eq('the same action with different arguments is not a duplicate', other.data.duplicate, undefined);
eq('and it gets its own key', other.data.intent.key, 'run-7:3');

// ⭐ Several runs at once must not collide: the key is per run.
const otherRun = call(TOOL(), { action: 'todo.add', why: 'another run', args: { text: 'eggs' } }, { list: newList(), runId: 'run-8' });
eq('a different run numbers from one', otherRun.data.intent.key, 'run-8:1');

// ═══════════════════════════════════════════════════════════════════════════
section('E. refusals are text, and the budget is a budget');

const bangedList = newList();
const banged = call(TOOL(), { action: 'todo.explode', why: 'why not' }, { list: bangedList, runId: 'r' });
eq('an unknown action is refused', banged.ok, false);
assert('with the action named', String(banged.summary).includes('todo.explode'));
assert('and the callable ones listed', String(banged.hint).includes('todo.add'));
// ⭐ A refused ask must leave NO trace, or a model looping on a typo would fill
// the budget with proposals nobody can act on.
eq('and nothing was recorded', bangedList.length, 0);
const empty = call(TOOL(), {}, { list: newList(), runId: 'r' });
assert('a missing action is refused by name', String(empty.summary).includes('(none given)'));

// Every shape a provider might send. None may throw, and each must be decidable.
eq('a JSON-string argument body is parsed', call(TOOL(), '{"action":"todo.add","args":{"text":"a"}}', { list: newList(), runId: 'r' }).ok, true);
eq('prose where JSON was expected is not fatal', call(TOOL(), 'I will add milk', { list: newList(), runId: 'r' }).ok, false);
eq('a number where an object was expected is not fatal', call(TOOL(), 42, { list: newList(), runId: 'r' }).ok, false);
eq('null arguments are not fatal', call(TOOL(), null, { list: newList(), runId: 'r' }).ok, false);
eq('a missing context is not fatal', call(TOOL(), { action: 'todo.add', why: 'w' }).ok, true);
eq('a missing tool is not fatal', call(undefined, { action: 'todo.add' }, { list: newList() }).ok, false);
eq(
  'a non-object args field is coerced to empty rather than refused',
  call(TOOL(), { action: 'todo.clear_all', why: 'w', args: [1, 2, 3] }, { list: newList(), runId: 'r' }).data.intent.args,
  {},
);

// ⭐ THE SIZE THE WHOLE BUG TURNED ON, and the reason the ceiling is asserted
// from both sides.
//
// It was 1200 characters. `files.publish`'s required argument is a COMPLETE HTML
// document, so 1200 is not a slightly narrow write path — it is the absence of
// one: no page an agent could build was ever handed over, and a run refused at
// this gate has one cheap sentence available to it, which is the sentence that
// claimed a 19.2 kB digest had been published. So the reported size is the size
// pinned here, and the ceiling is required to sit above the page a WEARER can
// read back in one go (`BODY_MAX_CHARS = 60_000`), because otherwise the app
// could show a page that no agent was allowed to write.
assert('the ceiling is above the page the wearer can read back', MAX_ARGS_CHARS > 60_000, `${MAX_ARGS_CHARS}`);
const PAGE = 'x'.repeat(19_200);
const pageList = newList();
const page = call(
  TOOL(),
  { action: 'files.publish', why: 'the daily digest', args: { html: PAGE, title: 'digest' } },
  { list: pageList, runId: 'r' },
);
eq('a page-sized argument is accepted, not refused', page.ok, true);
eq('and the whole page is what gets recorded', page.data.intent.args.html.length, PAGE.length);
eq('which is one entry in the list', pageList.length, 1);

const fatList = newList();
const fat = call(
  TOOL(),
  { action: 'todo.add', why: 'w', args: { text: 'x'.repeat(MAX_ARGS_CHARS + 1) } },
  { list: fatList, runId: 'r' },
);
eq('arguments too large to hand the device are refused', fat.ok, false);
assert('and the refusal says why', String(fat.summary).includes('too large'));
// A refusal with no recovery path is what produces an invented outcome, so the
// refusal has to name the limit, name the way out, and forbid the claim.
assert('and it names the limit that was hit', String(fat.summary).includes(String(MAX_ARGS_CHARS)));
assert('and points at the only real recovery', String(fat.hint).includes('send less'));
assert('and forbids reporting the change as made', String(fat.hint).includes('was not'));
eq('and nothing was recorded', fatList.length, 0);

// The budget. A model that has learned it can post work will propose twelve things.
const full = newList();
for (let i = 0; i < INTENT_MAX_PER_RUN; i++) {
  call(TOOL(), { action: 'todo.add', why: `item ${i}`, args: { text: `item ${i}` } }, { list: full, runId: 'r' });
}
eq('the budget is reached exactly', full.length, INTENT_MAX_PER_RUN);
const over = call(TOOL(), { action: 'todo.clear_all', why: 'one more' }, { list: full, runId: 'r' });
eq('one more is refused', over.ok, false);
assert('the refusal names the budget', String(over.summary).includes(String(INTENT_MAX_PER_RUN)));
assert('and points at the next run', String(over.hint).includes('start another one'));
eq('and the list did not grow', full.length, INTENT_MAX_PER_RUN);
// A duplicate INSIDE the budget is still free — the dedupe is checked first, so a
// looping model is not charged for repeating itself.
const dupAtCap = call(TOOL(), { action: 'todo.add', why: 'again', args: { text: 'item 0' } }, { list: full, runId: 'r' });
eq('a duplicate at the cap is still answered as a duplicate', dupAtCap.data.duplicate, true);

// ═══════════════════════════════════════════════════════════════════════════
section('F. the why is what the wearer reads on the gate');

const long = call(TOOL(), { action: 'todo.add', why: 'w'.repeat(400), args: { text: 'a' } }, { list: newList(), runId: 'r' });
assert('the reason is clipped for the prompt', long.data.intent.why.length <= 120, `${long.data.intent.why.length}`);
assert('and the summary stays one readable line', !String(long.summary).includes('\n'));
assert('a missing reason is simply empty', call(TOOL(), { action: 'todo.clear_all' }, { list: newList(), runId: 'r' }).data.intent.why === '');

// ═══════════════════════════════════════════════════════════════════════════
section('G. the relay wiring (local-sse.mjs)');

// The relay sources are CRLF on Windows; slicing a checked-in file without
// normalising first is how a multi-line needle stops matching for no reason.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const relaySrc = read('../../web/server/local-sse.mjs');

/** The source of ONE top-level function, up to the next one. */
const fnSource = (src, name) => {
  const at = src.indexOf(`function ${name}`);
  if (at < 0) return '';
  const next = src.slice(at + 1).search(/\n(?:export )?(?:async )?function \w+/);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
};
/** One route handler: from its marker to the next route test. */
const routeSource = (src, marker) => {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const next = src.indexOf('url.pathname ===', at + marker.length);
  return next < 0 ? src.slice(at) : src.slice(at, next);
};
/**
 * One arrow-function BODY passed to a named call, from the marker to the first
 * `\n  });` — the two-space indent a top-level statement inside it closes on.
 *
 * Needed because `subscribeRuns(() => { … })` is not a `function` declaration,
 * so `fnSource` finds nothing and every assertion below it would pass on an
 * empty string. The caller asserts the slice is non-empty for that reason.
 */
const blockSource = (src, marker) => {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const end = src.indexOf('\n  });', at);
  return src.slice(at, end < 0 ? src.length : end);
};

// The import is the one link that makes the other seven possible, and it is the
// one a rename breaks — so it is asserted symbol by symbol rather than by the
// module path alone.
const importAt = relaySrc.indexOf("from './intents.mjs'");
assert('the relay imports the module', importAt > 0);
const importBlock = relaySrc.slice(Math.max(0, importAt - 400), importAt);
for (const sym of ['INTENT_TOOL_NAME', 'intentToolFor', 'intentToolSchema', 'isIntentTool', 'runIntentTool']) {
  assert(`  ...including ${sym}`, importBlock.includes(sym), 'an unused-import cleanup would delete the wiring');
}

eq('one side table, keyed by the run id', (relaySrc.match(/const runIntents = new Map\(\)/g) ?? []).length, 1);
const pruneFn = fnSource(relaySrc, 'pruneRuns');
eq(
  'both eviction paths drop a run intent state',
  (pruneFn.match(/runIntents\.delete\(/g) ?? []).length,
  2,
  'an intents map that outlives its run is a leak that never throws',
);

const dispatchFn = fnSource(relaySrc, 'runToolOnce');
eq('the dispatcher gained exactly one intent branch', (dispatchFn.match(/isIntentTool\(/g) ?? []).length, 1);
has(
  '  ...that hands the args and the run own queue over',
  dispatchFn,
  'runIntentTool(tool, args, { runId: ctx.runId, list: ctx.intents?.list })',
);

const schemaFn = fnSource(relaySrc, 'toolSchemaFor');
has(
  'the schema builder answers the kind with a schema of its own',
  schemaFn,
  'if (isIntentTool(t)) return intentToolSchema(t);',
);

const execFn = fnSource(relaySrc, 'executeRun');
const offeredAt = execFn.indexOf('const offered = run.tools.filter');
const pushAt = execFn.indexOf('offered.push(intentState.tool)');
assert('the executor builds the offer from the router', offeredAt >= 0);
assert(
  'and appends the intent tool AFTER the router, never through it',
  pushAt > offeredAt,
  'ranked, a turn with a document to file would lose the ability to file it',
);
// ...and appends it only when the router did not already carry it. Presence was
// never the property that mattered: the run that prompted this was offering the
// tool TWICE, which the provider refuses outright.
const guardAt = execFn.indexOf('!offered.some((t) => t.name === intentState.tool.name)');
assert(
  'and appends it only when the shortlist does not already carry it',
  guardAt > offeredAt && guardAt < pushAt,
  'guarded after the push is not a guard; the second slot is what the provider refused',
);
has('  ...read from the run own side table', execFn, 'const intentState = runIntents.get(run.id)');
has('  ...and the dispatcher is given the same context', execFn, 'intents: runIntents.get(run.id)');

const runRoute = routeSource(relaySrc, "url.pathname === '/api/agent/run'");
// The ONE constructor every run in this process comes from — the wearer's run here
// and a child started by the `agent` tool. The refusals and the intent side table
// live in it now rather than in the route, because inlining them is how there came
// to be two homes for one tool in the first place. What is asserted below is that
// the constructor does each of them, and that the route does not also try.
const runCtorFn = fnSource(relaySrc, 'startAgentRun');
has(
  'the run route builds the tool from the catalogue the device sent',
  runRoute,
  'const intentTool = intentToolFor(body?.capabilities);',
);
has('  ...and the run constructor installs the side table for this run', runCtorFn, 'runIntents.set(run.id, { tool: intentTool, list: [] })');
assert(
  '  ...only when the device delegates something',
  runCtorFn.includes('if (intentTool) runIntents.set('),
  'an older client keeps its old toolset instead of an empty enum',
);
assert(
  '  ...and the route keeps no second copy of it',
  !/runIntents\.set/.test(runRoute),
  'one owner, so the queue cannot be installed twice — or missed by one of them',
);
has(
  '  ...and gives up the name only when the built-in is there to take it',
  runRoute,
  '!(intentTool && t.name === INTENT_TOOL_NAME)',
  'HUB_MCP_AGENT_NAMES already covers its siblings, but that name has no built-in unless the device sent a catalogue',
);
unset(
  '  ...and never drops it unconditionally',
  runRoute,
  't.name !== INTENT_TOOL_NAME',
  'unconditional was the hole: for a client that sends no capabilities there is no built-in, so the slot was left empty and nothing was said about it',
);
// POSITIVE CONTROL for that negative pin — the same predicate against a MUTANT
// with the unconditional filter put back.
const rewoundFilter = runRoute.replace(
  '!(intentTool && t.name === INTENT_TOOL_NAME)',
  't.name !== INTENT_TOOL_NAME',
);
assert(
  '...and that pin can actually fail (positive control)',
  rewoundFilter.includes('t.name !== INTENT_TOOL_NAME') && rewoundFilter !== runRoute,
  'the mutant did not apply, so the pin above proves nothing',
);
has(
  '  ...and says so when a tool was handed over rather than silently lost',
  runRoute,
  'given up for the built-in',
  'otherwise the wearer is left wondering where their own tool went',
);

// ── The duplicate slot, and the guard that made it impossible ───────────────
//
// WHAT WENT WRONG, because the shape of the fault is why these checks are here.
// The run route put the intent tool on `run.tools` as well as in the side table,
// so the executor offered it TWICE — once through the router's shortlist and once
// by appending the side table's copy. The request then carried two functions named
// `jarvis_app`, the provider refused it, and the run died before the first prompt
// landed: the queue showed a run that never arrived rather than one that failed.
//
// Every check ABOVE passed while that was true, because the tool WAS offered. So
// what is pinned is the COUNT, not the presence — and one home for the tool.
unset(
  'the run route keeps the intent tool OFF run.tools',
  runRoute,
  'HUB_MCP_AGENT_TOOLS, intentTool]',
  'two homes for one tool IS the duplicate slot, and on the list it is also rankable away',
);
has(
  '  ...so the run toolset is the authored tools plus the hub own faculties',
  runRoute,
  'const tools = [...authored, ...HUB_MCP_AGENT_TOOLS];',
);
// POSITIVE CONTROL for that negative pin. A `unset` whose needle no version of the
// code can produce is a check that cannot fail, which is worse than no check. The
// same predicate is run against a MUTANT with the duplicate home put back.
const rewound = runRoute.replace(
  'const tools = [...authored, ...HUB_MCP_AGENT_TOOLS];',
  'const tools = intentTool\n      ? [...authored, ...HUB_MCP_AGENT_TOOLS, intentTool]\n      : [...authored, ...HUB_MCP_AGENT_TOOLS];',
);
assert(
  '...and that pin can actually fail (positive control)',
  rewound.includes('HUB_MCP_AGENT_TOOLS, intentTool]') && rewound !== runRoute,
  'the mutant did not apply, so the pin above proves nothing',
);
// The executor's own guard is what makes the collision impossible rather than
// merely absent: a second home cannot produce a second slot.
has(
  'the offer names the intent tool at most once',
  execFn,
  'if (intentState && !offered.some((t) => t.name === intentState.tool.name))',
);
// The offer is built INSIDE the failure boundary. Above it, a throw while ranking
// was an unhandled rejection off `void executeRun(run)`: nothing recorded, the run
// left `running` until its TTL, and the wearer shown a run that never landed.
assert(
  'the offer is built inside the failure boundary',
  execFn.indexOf('runAbort.set(run.id, ac)') <
    execFn.indexOf('const route = await offerTools(run, resolved.text)'),
  'a throw in the offer build must land on the run, not vanish',
);
has('  ...and every failure records itself through one path', execFn, 'failRun(run, err)');
has(
  'a toolset that would collide is refused before the run exists',
  runCtorFn,
  'const fault = toolSetFault(intentTool ? [...tools, intentTool] : tools);',
);
has('  ...in words the caller can act on', runCtorFn, 'cannot start this run');
assert(
  '  ...from ONE place, so the route cannot refuse a different way',
  !/toolSetFault|modelProviderFault/.test(runRoute),
  'two refusals for one fault is how the route and the constructor drift apart',
);
has(
  '  ...and the launch keeps a net under the loop own guard',
  runRoute,
  'void executeRun(run).catch((err) => failRun(run, err));',
);
// An agent is a SAVED configuration, so its own model wins. The CALLER's does not
// — `body.model` is the device's session model, an OpenRouter id by default, and
// with the relay on DeepSeek that is a model the backend cannot serve: the
// provider rejects the request before the first prompt lands. The relay's own
// configured model is the fallback instead, because Settings writes THE RELAY, so
// the caller's copy is a mirror that can only go stale.
has('the run uses the model the AGENT was saved with', runRoute, 'const runModel = String(agentModel || cfg.model);');
has('  ...and never the caller own mirror of it', runRoute, 'const modelSource = agentModel ? \'agent\' : \'relay\';');
unset('  ...however loudly the caller asks', runRoute, 'agentModel || callerModel ||');
has(
  '  ...and a model the backend cannot serve is refused before the run exists',
  runCtorFn,
  'const modelFault = modelProviderFault(runModel, cfg.provider);',
);
has(
  '  ...by a rule that only rules on what the provider actually told us',
  fnSource(relaySrc, 'modelProviderFault'),
  "if (provider === 'deepseek' && id.includes('/'))",
);
// POSITIVE CONTROL, same shape as the one above: the needle must be able to
// appear, or the `unset` proves nothing at all.
const mirrored = runRoute.replace(
  'const runModel = String(agentModel || cfg.model);',
  'const runModel = String(agentModel || callerModel || cfg.model);',
);
assert(
  '...and that pin can actually fail (positive control)',
  mirrored.includes('agentModel || callerModel ||') && mirrored !== runRoute,
  'the mutant did not apply, so the pin above proves nothing',
);
has('  ...and the relay log says which layer supplied it', runRoute, 'model=${run.model} (from ${modelSource})');
has(
  '  ...naming the caller model it declined, when the two disagree',
  runRoute,
  "`, ignoring the caller's ${callerModel}`",
);

const toolRoute = routeSource(relaySrc, "url.pathname === '/api/tool'");
assert(
  'the tool proxy refuses a proposal, because a proposal belongs to a run',
  toolRoute.includes('isIntentTool(body)'),
  'posted there it would be an ask with no owner: recorded nowhere, gated by nobody',
);
has('  ...in words that say a run is required', toolRoute, 'can only be asked for from a run');

// ═══════════════════════════════════════════════════════════════════════════
section('H. the device side of the wire');

// Every `startRun` SITE must send the catalogue. Asserting the count rather than
// the presence is what catches a NEW trigger path: a fourth caller that forgets
// is a path where the agent silently cannot act, and it would be found here
// rather than in the field.
for (const [label, rel] of [
  ['main.ts', '../src/main.ts'],
  ['capabilities/agents.ts', '../src/ai/capabilities/agents.ts'],
  ['web/AgentsPanel.tsx', '../src/web/AgentsPanel.tsx'],
]) {
  const src = read(rel);
  const calls = (src.match(/await startRun\(/g) ?? []).length;
  const catalogues = (src.match(/capabilities: intentCatalog\(\)/g) ?? []).length;
  assert(
    `${label} sends the catalogue at every startRun site`,
    calls > 0 && calls === catalogues,
    `${calls} call(s), ${catalogues} catalogue(s)`,
  );
  assert(`  ...and imports the module`, /from '\.\.?(?:\/ai)?\/intents'/.test(src));
}

const mainSrc = read('../src/main.ts');
const claimFn = fnSource(mainSrc, 'claimRunIntents');
has('the ask is claimed from the run transcript', claimFn, 'claimIntents(');
has('  ...naming the run, so the ledger attributes it to the asker', claimFn, "{ id: run.id, agentId: run.agentId, agentName: run.agentName }");

// ⭐ THE HOLE THIS SWEEP EXISTS TO CLOSE. The monitor queue holds only the runs
// Jarvis was asked to watch — `ingestMonitoredRuns` says so in as many words —
// so a run started by hand from the Agents tab is never in it. Reading claims
// off that queue would mean a hand-triggered agent asks, and nobody answers.
const handler = blockSource(mainSrc, 'subscribeRuns(() => {');
assert(
  'the run subscription handler was located at all',
  handler.includes('ingestMonitoredRuns(getRuns())'),
  'without this the checks below pass on an empty string',
);
const sweepAt = handler.indexOf('claimRunIntents(run)');
assert(
  'a settled run is read for asks off the run MIRROR, not the monitor queue',
  sweepAt >= 0 && handler.slice(Math.max(0, sweepAt - 260), sweepAt).includes('for (const run of getRuns())'),
);
assert(
  '  ...and only once it has STOPPED, since a live transcript is still being written',
  /if \(run\.status === 'running'\) continue;/.test(handler),
);
const drainAt = handler.indexOf('runPendingIntents()');
assert('  ...then ONE drain is started for the pass', drainAt > sweepAt, 'claiming is per run, draining is per pass');
assert(
  '  ...and only when something was actually claimed',
  handler.slice(sweepAt, drainAt).includes('if (claimed)'),
);
assert(
  '  ...which drains EVERY pending ask, including one whose run frame was missed',
  handler.includes('runPendingIntents().then((done) => {') && handler.includes('if (!done.length) return;'),
);
// ⭐ AND ITS OUTCOME IS REPORTED, which is the other half of the same failure.
//
// The device is the ONLY party that learns whether an agent's ask actually ran:
// the relay forwards it and, by construction, never sees the result, and the
// wearer does not see the device's execution either. So a drain that only writes
// to the console left a failed publish indistinguishable from a landed one to
// everyone except a developer with devtools open — which is exactly how a run
// came to report a page that no read could find.
assert(
  '  ...and its OUTCOME becomes a step the wearer can see',
  /aiStep\(it\.ok \? 'ok' : 'fail', line\)/.test(handler),
);
assert(
  '  ...with a landed write recorded as landed',
  handler.includes("console.log('[hub] agent intent landed', it)"),
);
assert(
  '  ...and a failure logged as a WARNING, so it is loud',
  handler.includes("console.warn('[hub] agent intent did NOT land', it)"),
);
unset(
  '  ...and the monitor queue is not used as a claim edge at all',
  handler,
  'settleIntents(',
  'one claim site, so the two can never drift',
);
// CONTROL: the absence check above is only meaningful if the slice really is the
// handler, so the same slice is asked for a string it must contain.
has('  (control) and the slice is the handler', handler, 'void renderGlasses();');

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'ALL CHECKS PASSED'} — ${checks - fail} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
