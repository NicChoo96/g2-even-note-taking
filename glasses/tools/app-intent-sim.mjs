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
// The SCHEMA's description is what the model reads, so that is where the two
// things it must know have to be: this proposes rather than performs, and the
// result will not come back.
assert(
  'the schema tells the model it will not see the result',
  intentToolSchema(TOOL()).function.description.includes('will not see the result'),
);
assert(
  'and that the device may ask the wearer first',
  intentToolSchema(TOOL()).function.description.includes('confirm'),
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
assert('the hint tells the model it is done', String(first.hint).includes('say what you asked for'));

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

const fatList = newList();
const fat = call(TOOL(), { action: 'todo.add', why: 'w', args: { text: 'x'.repeat(1400) } }, { list: fatList, runId: 'r' });
eq('arguments too large to hand the device are refused', fat.ok, false);
assert('and the refusal says why', String(fat.summary).includes('too large'));
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
has('  ...read from the run own side table', execFn, 'const intentState = runIntents.get(run.id)');
has('  ...and the dispatcher is given the same context', execFn, 'intents: runIntents.get(run.id)');

const runRoute = routeSource(relaySrc, "url.pathname === '/api/agent/run'");
has(
  'the run route builds the tool from the catalogue the device sent',
  runRoute,
  'const intentTool = intentToolFor(body?.capabilities);',
);
has('  ...and installs the side table for this run', runRoute, 'runIntents.set(run.id, { tool: intentTool, list: [] })');
assert(
  '  ...only when the device delegates something',
  runRoute.includes('if (intentTool) runIntents.set('),
  'an older client keeps its old toolset instead of an empty enum',
);
has(
  '  ...and refuses a caller smuggling one in as an authored tool',
  runRoute,
  't.name !== INTENT_TOOL_NAME',
  'HUB_MCP_AGENT_NAMES already covers its siblings',
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
  handler.includes('if (done.length) console.log(\'[hub] agent intents settled\', done);'),
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
