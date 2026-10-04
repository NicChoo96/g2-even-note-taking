#!/usr/bin/env node
// The agent-chain harness — the `agent` tool, the two brakes, and the honesty
// rule that makes a child's answer trustworthy.
//
// WHY THIS EXISTS:
//   The `agent` tool is the only tool that starts ANOTHER RUN, and the only one
//   whose failure mode is a fluent sentence about work that never happened. Every
//   way of getting it wrong is invisible from the outside:
//
//     • a placeholder returned instead of the child's own words, which is
//       indistinguishable to the model reading it from a real answer — and is the
//       exact false-success bug the tool was written to end, moved one layer down;
//     • a child that fails, is stopped or says nothing, reported as "no result",
//       which reads as an invitation to fill the gap;
//     • the depth brake checked AFTER the child exists, so the grandchild runs and
//       gets cut off — a model staring at a half-run writes the rest itself;
//     • a second hub client created to read the roster, which rotates the refresh
//       token family and takes the wearer's whole hub link down;
//     • a second run-construction path, which is a second answer to "what is a
//       run" and quietly misses the tool cap, the name dedupe and the faults;
//     • a `kind` the client can author that the relay cannot execute. That one is
//       caught by location-sim §7, which is why this file asserts the two branches
//       exist on both sides rather than trusting the wiring to stay.
//
//   So this drives the pure module directly (it takes its data as arguments and
//   knows nothing about sockets), asserts every refusal names WHAT happened, and
//   then reads the real relay source to assert the wiring and — the point of the
//   whole file — that there is exactly ONE run constructor.
//
// Run: node tools/agent-chain-sim.mjs

import { readFileSync } from 'node:fs';
import {
  AGENT_KIND,
  AGENT_TOOL_NAMES,
  CHILD_TIMEOUT_MS,
  MAX_AGENT_DEPTH,
  MAX_CHILDREN_PER_RUN,
  agentToolSchema,
  budgetRefusalText,
  depthRefusalText,
  findAgent,
  formatChildResult,
  formatRoster,
  isAgentTool,
  parseAgents,
  readChildResult,
  timedOutText,
  unknownAgentText,
} from '../../web/server/agent-tool.mjs';

let fail = 0;
let total = 0;
const assert = (label, cond, detail = '') => {
  total++;
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  assert(
    label,
    got === want,
    got === want ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
const deepEq = (label, got, want) => eq(label, JSON.stringify(got), JSON.stringify(want));
const has = (label, haystack, needle) => {
  const found = String(haystack).includes(needle);
  return assert(label, found, found ? '' : `\n      missing: ${needle}`);
};
const unset = (label, haystack, needle) => {
  const found = String(haystack).includes(needle);
  return assert(label, !found, found ? `\n      unexpected: ${needle}` : '');
};
/** A one-line excerpt, for a failure message that has to stay readable. */
const clip40 = (text) => String(text ?? '').replace(/\s+/g, ' ').slice(0, 60);

/**
 * The source of ONE top-level function. Loose regexes are not usable here: the
 * relay's own comments name `startAgentRun`, `runAgentTool` and `hubRuntime`, and
 * a count taken over the whole file would be satisfied by the prose describing the
 * rule instead of the code obeying it.
 */
const fnSource = (src, name) => {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return '';
  const next = src.slice(start + 1).search(/\n(?:export )?(?:async )?function \w+/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
};
/** Every top-level function DEFINITION of that name — a count, never a presence. */
const fnCount = (src, name) => (src.match(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`, 'g')) ?? []).length;

const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');

const relaySrc = read('../../web/server/local-sse.mjs');
const schemaFn = fnSource(relaySrc, 'toolSchemaFor');
const dispatchFn = fnSource(relaySrc, 'runToolOnce');
const rosterFn = fnSource(relaySrc, 'hubAgentRoster');
const runToolFn = fnSource(relaySrc, 'runAgentTool');
const startFn = fnSource(relaySrc, 'startAgentRun');
const runRouteSrc = read('../../web/server/local-sse.mjs').slice(
  read('../../web/server/local-sse.mjs').indexOf("url.pathname === '/api/agent/run'"),
);
/** The builder's seed table — the vocabulary that decides which kind a phrase IS. */
const capSrc = read('../src/ai/capabilities/agents.ts');

// ── 1. the module's contract ────────────────────────────────────────────────
console.log('\n§1  the kind, the name and the brakes');
eq('the kind is the string the client authors', AGENT_KIND, 'agent');
eq('the model-facing name is stable', AGENT_TOOL_NAMES.agent, 'jarvis_agent');
assert('isAgentTool matches the kind', isAgentTool({ kind: 'agent' }) && !isAgentTool({ kind: 'web' }));
assert('  ...and never throws on a tool that is not one', !isAgentTool(null) && !isAgentTool(undefined) && !isAgentTool({}));
assert('  ...and every ToolDef uses a lowercase kind', AGENT_KIND === AGENT_KIND.toLowerCase());
// The brakes are the numbers the assertions below depend on, and they are the
// difference between bounded work and unbounded work multiplied by unbounded work.
eq('a chain is one level deep', MAX_AGENT_DEPTH, 1);
eq('a parent may start eight children', MAX_CHILDREN_PER_RUN, 8);
eq('a child gets four minutes', CHILD_TIMEOUT_MS, 240000);
assert(
  'the child ceiling is far inside the run TTL',
  CHILD_TIMEOUT_MS < 30 * 60 * 1000,
  `${CHILD_TIMEOUT_MS}ms`,
);

const schema = agentToolSchema({ kind: 'agent' });
eq('the schema is a function schema', schema.type, 'function');
eq('  ...named what the dispatch matches', schema.function.name, AGENT_TOOL_NAMES.agent);
deepEq('  ...taking a name and an ask', Object.keys(schema.function.parameters.properties), ['name', 'ask']);
deepEq('  ...and requiring neither, so the roster call is legal', schema.function.parameters.required, []);
has('the description says the answer comes back as text', schema.function.description, 'its finished answer back as text');
has('  ...says it WAITS, so a model does not treat it as fire-and-forget', schema.function.description, 'then compile what came back');
has('  ...and forbids writing down a result it did not return', schema.function.description, 'Never write down a result this tool did not return to you');
// Both description rules land in ONE string, and a model reads them once. Losing
// either half is invisible: the tool still works, and the run still invents.
assert(
  'the prohibition is in the schema, not only in the failure text',
  /failure is not a finding/.test(schema.function.description),
);

// ── 2. reading the child's answer ───────────────────────────────────────────
console.log('\n§2  the child\'s own answer, or the reason there is not one');
const done = (messages) => ({ status: 'done', messages });
eq('no child at all is a refusal, not a crash', readChildResult(null).reason, 'the run could not be found after it started');
eq('a stopped child says it was stopped', readChildResult({ status: 'stopped' }).reason, 'it was stopped before it answered');
has('an errored child carries the reason it recorded', readChildResult({ status: 'error', error: 'socket hang up' }).reason, 'socket hang up');
has('  ...and says it FAILED rather than giving a bare reason', readChildResult({ status: 'error' }).reason, 'it failed');
eq('a still-running child is not a result', readChildResult({ status: 'running', messages: [] }).reason, 'it had not finished');
eq('a finished child with nothing to say says so', readChildResult(done([])).reason, 'it finished without saying anything');
eq(
  '  ...and an empty final turn is not filled in from the one before it',
  readChildResult(done([{ role: 'assistant', content: 'a real answer' }, { role: 'assistant', content: '  ' }])).reason,
  'it finished without saying anything',
);
const answered = readChildResult(done([{ role: 'user', content: 'go' }, { role: 'assistant', content: '  the answer  ' }]));
eq('the final assistant turn IS the answer', answered.text, 'the answer');
assert('  ...and it is marked as one', answered.ok === true && answered.text !== undefined);
// The last assistant turn is a TOOL CALL, so it is skipped and the earlier
// answer stands — a child that looks something up and then answers must not be
// reported as silent, and a child whose planning text is read as its answer would
// hand the parent a sentence about what it was ABOUT to do.
const withTool = readChildResult(
  done([
    { role: 'assistant', content: 'Here is what I found.' },
    { role: 'assistant', content: '', tool: 'jarvis_web' },
  ]),
);
eq('a trailing tool call is skipped, not read as the answer', withTool.text, 'Here is what I found.');
// A user turn is never the answer. Without this the parent would be handed the
// prompt it sent and could quote it back as the child's finding.
const userLast = readChildResult(done([{ role: 'user', content: 'what is the weather' }]));
eq('the prompt is never mistaken for the answer', userLast.ok, false);

// ── 3. what the parent actually reads ──────────────────────────────────────
console.log('\n§3  the tool result the PARENT reads');
const goodText = formatChildResult('Singapore Weather', 'a1b2c3d4', { ok: true, text: 'Rain by 4pm.' }, 9000);
has('the header names the child', goodText, 'Singapore Weather');
has('  ...names the run, so the wearer can look it up', goodText, 'a1b2c3d4');
has('  ...says it finished', goodText, 'finished');
has('  ...and gives a duration', goodText, '9s');
has('the child\u2019s own words are in there verbatim', goodText, 'Rain by 4pm.');
has('the footer says the text is the child\u2019s own', goodText, 'in its own words');
has('  ...and forbids adding to it', goodText, 'do not add anything it did not say');
const badText = formatChildResult('Bank Stocks', 'ff00ff00', { ok: false, reason: 'it had not finished' }, 500);
has('a failure is labelled as one', badText, 'did NOT finish');
has('  ...says the child produced no result', badText, 'produced no result');
has('  ...repeats the reason', badText, 'it had not finished');
has('  ...and calls it a FAILURE, not a finding', badText, 'This is a FAILURE, not a finding.');
has('  ...telling the parent to say it did not return a result', badText, 'did not return a result.');
assert('a failure carries no invented body', !badText.includes('Rain'));
eq(
  'a negative duration cannot go out on the wire',
  formatChildResult('X', 'deadbeef', { ok: true, text: 'y' }, -5000).includes(', 0s]'),
  true,
);

// ── 4. the roster and the four refusals ────────────────────────────────────
console.log('\n§4  the roster, and every refusal saying WHICH one it was');
const agents = parseAgents({
  agents: [
    { id: 't1', name: 'Singapore Weather', systemPrompt: 'system', prompt: 'the saved task', toolIds: ['tool-web'] },
    { id: 't2', name: 'Gaming News Today', prompt: 'the saved task', toolIds: [] },
  ],
});
eq('two agents survive the envelope', agents.length, 2);
has('an empty roster is never silent', formatRoster([]), 'no agents saved on this account');
has('  ...and forbids inventing one in its place', formatRoster([]), 'Do not invent an agent name');
has('  ...or describing a result that never arrived', formatRoster([]), 'do not describe a result you did not receive');
const two = formatRoster(agents);
has('a roster counts them', two, '2 agents exist');
has('  ...names them', two, 'Singapore Weather');
has('  ...names all of them', two, 'Gaming News Today');
has('  ...and tells the model the next step', two, 'Call this tool again with the exact name');
eq('one agent is not "1 agents"', formatRoster([agents[0]]).startsWith('1 agent exists and'), true);
const unknown = unknownAgentText('Singapour Weather', agents);
has('an unknown name is a tool error', unknown, 'tool error:');
has('  ...quoting what was asked for', unknown, '"Singapour Weather"');
has('  ...and carrying the roster, so recovery is one step', unknown, 'Gaming News Today');
const depth = depthRefusalText('Gaming News Today', 1);
has('the depth refusal says the agent was NOT run', depth, 'was NOT run');
has('  ...says no result exists for it', depth, 'no result exists for it');
has('  ...says the limit, not just that a limit exists', depth, `limited to ${MAX_AGENT_DEPTH} level`);
has('  ...says why it cannot retry', depth, 'was itself started by another agent');
has('  ...and forbids writing down a result for it', depth, 'do not write down any result for it');
const budget = budgetRefusalText('Trending', 8);
has('the budget refusal says how many were spent', budget, 'already started 8 agents');
has('  ...says the limit', budget, `the limit of ${MAX_CHILDREN_PER_RUN}`);
has('  ...says this one was NOT run', budget, 'was NOT run');
has('  ...and tells it to compile what it has and name the rest', budget, 'which agents you did not reach');
const timeout = timedOutText('Workday Brief', CHILD_TIMEOUT_MS);
has('the timeout refusal says it was stopped', timeout, 'was stopped');
has('  ...in minutes, not milliseconds', timeout, 'within about 4 minute');
has('  ...that nothing is known about what it found', timeout, 'NOTHING is known');
has('  ...and forbids guessing', timeout, 'Do not state or guess a result for it');
has('one minute reads as one minute', timedOutText('X', 60000), 'about 1 minute,');
// The prose here is this file's own and may use typographic punctuation — every
// module in this directory does. The NAMES are not this file's own: they come off
// the hub, one boundary away, and they are clipped to ASCII wherever they are
// quoted, because the model's next move is to call the tool again with that exact
// name and a curly quote or a CJK glyph cannot be typed back on the glasses. So the
// assertion is not "this text is ASCII" — it is "nothing that arrived from the hub
// survives as a glyph", and it is made with a name made of nothing but glyphs.
const TYPOGRAPHIC = /[\u2014\u2018\u2019\u201c\u201d]/g;
const noGlyphs = (text) => /^[\x20-\x7E\n]*$/.test(String(text).replace(TYPOGRAPHIC, ''));
const GLYPHS = 'Caf\u00e9 \u4e2d\u6587 \u2018quoted\u2019';
const glyphCase = [
  ['the unknown-name refusal', unknownAgentText(GLYPHS, agents)],
  ['the depth refusal', depthRefusalText(GLYPHS, 1)],
  ['the budget refusal', budgetRefusalText(GLYPHS, 8)],
  ['the timeout refusal', timedOutText(GLYPHS, 1000)],
  ['the roster', formatRoster([{ name: GLYPHS }])],
  ['  ...and so does the roster call on an empty account', unknownAgentText(GLYPHS, [])],
];
for (const [label, text] of glyphCase) {
  assert(`${label} leaves no glyph from the hub behind`, noGlyphs(text), clip40(text));
}
// The child-result header is ONE line, because it is a header: a name carrying a
// newline would push the run id and the duration onto a line of their own and the
// model would read the id as part of the answer.
const headerLine = formatChildResult(GLYPHS, 'aa', { ok: true, text: '' }, 0).split('\n');
assert('the child result header is a single line', headerLine.length > 1 && noGlyphs(headerLine[0]), clip40(headerLine[0]));
assert('  ...and it is the FIRST line', headerLine[0].startsWith('[agent "'), clip40(headerLine[0]));
assert(
  '  ...which the failure branch keeps too',
  noGlyphs(formatChildResult(GLYPHS, 'aa', { ok: false, reason: 'it was stopped' }, 0)),
);

// ── 5. parsing the hub's payload ───────────────────────────────────────────
console.log('\n§5  the roster crosses a boundary this file does not control');
eq('a bare array is accepted as well as an envelope', parseAgents([{ name: 'A' }]).length, 1);
eq('anything that is not a list yields nothing', parseAgents(null).length, 0);
eq('  ...including a string', parseAgents('agents').length, 0);
eq('  ...and an object with no agents key', parseAgents({ tools: [] }).length, 0);
deepEq(
  'a nameless row is DROPPED, not repaired',
  parseAgents([{ id: 'x' }, { name: '' }, { name: '   ' }, { name: 42 }, null, 'nope', { name: 'Real' }]).map((a) => a.name),
  ['Real'],
);
const shaped = parseAgents([{ name: '  Padded  ', toolIds: ['a', 7, null] }]);
eq('a name is trimmed', shaped[0].name, 'Padded');
deepEq('  ...and non-string tool ids are dropped', shaped[0].toolIds, ['a']);
eq('a missing systemPrompt becomes a string, never undefined', shaped[0].systemPrompt, '');
eq('  ...and so does a missing prompt', shaped[0].prompt, '');

// ── 6. resolving a name ────────────────────────────────────────────────────
console.log('\n§6  exact, then case-insensitive, and never a guess');
eq('an exact name resolves', findAgent(agents, 'Singapore Weather').id, 't1');
eq('a lowercase name resolves', findAgent(agents, 'singapore weather').id, 't1');
eq('  ...and an uppercase one', findAgent(agents, 'GAMING NEWS TODAY').id, 't2');
eq('the exact match wins over a case-insensitive one', findAgent([{ name: 'Weather' }, { name: 'weather' }], 'weather').name, 'weather');
eq('an empty name resolves to nothing', findAgent(agents, ''), null);
eq('  ...and so does whitespace', findAgent(agents, '   '), null);
eq('the lookup trims the model\u2019s input', findAgent(agents, '  Gaming News Today  ').id, 't2');
eq('a PREFIX is not a match', findAgent(agents, 'Singapore'), null);
eq('a SUBSTRING is not a match', findAgent(agents, 'Weather'), null);
eq('a near-miss is not a match', findAgent(agents, 'Singapore Weather Today'), null);
eq('  ...and a name that only appeared in ANOTHER agent\u2019s is not one', findAgent(agents, 'Today'), null);
eq('  ...nor a word that is only a seed, not a name', findAgent(agents, 'agents'), null);

// ── 7. the wiring, read off the real relay ─────────────────────────────────
console.log('\n§7  the relay actually executes it');
has('toolSchemaFor describes the agent kind', schemaFn, 'isAgentTool(t)) return agentToolSchema(t);');
has('  ...and never lets it reach the generic REST fallback', schemaFn, 'return httpToolSchema(t);');
assert(
  '  ...because the agent branch is ABOVE that fallback',
  schemaFn.indexOf('isAgentTool(t)') < schemaFn.indexOf('return httpToolSchema(t);'),
);
has('runToolOnce dispatches it', dispatchFn, 'if (isAgentTool(tool)) return runAgentTool(tool, args, ctx);');
assert(
  '  ...before the files branch, so a files tool is not read as an agent',
  dispatchFn.indexOf('isAgentTool(tool)') < dispatchFn.indexOf('isFilesTool(tool)'),
);
has('  ...and the agent branch is the one that starts a run', dispatchFn, 'isAgentTool(tool)) return runAgentTool(tool, args, ctx);');
// The context is built at the CALL SITE, not inside the dispatcher, so it is read
// from `executeRun`. Both halves matter and neither is optional: without `run` there
// is no parent, so the depth brake can never fire and the chain is unbounded; without
// `signal` the wearer pressing Stop on the parent leaves the child running behind it,
// still spending tokens and still writing to the hub.
const callSiteFn = fnSource(relaySrc, 'executeRun');
const ctxAt = callSiteFn.indexOf('await runToolOnce(tool, rawArgs, ac.signal, {');
const ctxSrc = ctxAt < 0 ? '' : callSiteFn.slice(ctxAt, callSiteFn.indexOf('})', ctxAt));
has('the dispatch call site forwards the run', ctxSrc, 'run,');
has('  ...and the signal, so the wearer\u2019s Stop can reach the child', ctxSrc, 'signal: ac.signal,');
has('  ...inside ONE context object, so the two arrive together', ctxSrc, 'location: runLocations.get(run.id),');
// The roster goes through the ONE hub client the process has. A second client is a
// second refresh token in the same family, and the hub revokes the family when two
// rotate — which takes down the wearer's whole hub link, not just this tool.
assert('the roster is read through the SHARED hub runtime', /hubRuntime\(\)/.test(rosterFn) && /hub\.client/.test(rosterFn));
unset('  ...and no second client is ever built for it', rosterFn, 'createClient');
unset('  ...nor does it reach for the files runtime', rosterFn, 'filesRuntime');
has('the roster asks the hub\u2019s own agent list', rosterFn, "'/agents'");
has('  ...with a documented fallback for tools', rosterFn, "'/tools'");
// The whole reason this tool is safe to put in a run: it cannot take the run down
// with it. Every unhappy path is a RETURN, because a rejection here would surface
// as an agent that failed for a reason that has nothing to do with the agent.
assert('the roster never throws \u2014 every unhappy path is a return', !/\bthrow\b/.test(rosterFn.replace(/^[ \t]*\/\/.*$/gm, '')));
assert('  ...and neither does the tool itself', !/\bthrow\b/.test(runToolFn.replace(/^[ \t]*\/\/.*$/gm, '')));
assert(
  '  ...it reports the hub\u2019s own words when the hub refuses',
  /error: hub\.error \|\| /.test(rosterFn) && /String\(err\)/.test(rosterFn),
);

// ── 8. the brakes are BEFORE the child exists ──────────────────────────────
console.log('\n§8  the brakes refuse at the start, never mid-flight');
has('the depth brake reads the carried depth', runToolFn, 'runDepths.get(parent.id)');
assert(
  '  ...and refuses before the child is constructed',
  runToolFn.indexOf('depthRefusalText') < runToolFn.indexOf('startAgentRun('),
);
has('the fan-out brake counts the children already started', runToolFn, 'runChildren.get(parent.id)?.length');
assert(
  '  ...and refuses before the child is constructed',
  runToolFn.indexOf('budgetRefusalText') < runToolFn.indexOf('startAgentRun('),
);
has('the child is created through the ONE constructor', runToolFn, 'startAgentRun({');
has('  ...at depth + 1, which is what the grandchild is refused by', runToolFn, 'depth: depth + 1,');
has('the child is recorded against its parent', runToolFn, 'runChildren.set(parent.id, list)');
has('the child\u2019s own answer is read off its transcript', runToolFn, 'readChildResult(child)');
has('  ...and handed over with its run id', runToolFn, 'formatChildResult(agent.name, child.id');
has('the child is AWAITED', runToolFn, 'await loop;');
has('a child that throws is failed, never left running', runToolFn, 'failRun(child, err)');
has('the timeout stops the child', runToolFn, 'stopChild();');
has('  ...on the module\u2019s ceiling', runToolFn, '}, CHILD_TIMEOUT_MS);');
has('the wearer stopping the PARENT stops the child', runToolFn, 'runAbort.get(parent.id)');
has('  ...and the listener is removed when the child ends', runToolFn, 'removeEventListener');

// ── 9. exactly ONE run constructor ─────────────────────────────────────────
console.log('\n§9  one answer to "what is a run"');
eq('startAgentRun is defined exactly once', fnCount(relaySrc, 'startAgentRun'), 1);
eq('  ...and runAgentTool exactly once', fnCount(relaySrc, 'runAgentTool'), 1);
eq('  ...and hubAgentRoster exactly once', fnCount(relaySrc, 'hubAgentRoster'), 1);
// A second constructor is a second answer, and the copy is always the one that
// misses the tool cap, the name dedupe and the two faults — because the copy is
// written by whoever needed a run, not by whoever maintains the first one.
eq(
  'the route does not build a run of its own',
  (relaySrc.match(/\bruns\.set\(/g) ?? []).length,
  1,
);
has('  ...it calls the constructor', runRouteSrc, 'startAgentRun({');
has('  ...and takes the run back out of it', runRouteSrc, 'const run = started.run;');
has('  ...refusing a bad toolset with the constructor\u2019s own error', runRouteSrc, 'started.error');
has('the constructor owns the tool cap', startFn, 'toolSetFault');
has('  ...and the model/provider fault', startFn, 'modelProviderFault');
has('the child\u2019s depth is CARRIED, not inferred', startFn, 'runDepths.set(run.id');
has('  ...so a run that never says is depth 0, the wearer', startFn, 'Number(spec.depth) : 0');
has('  ...and a child is given no intent side table', startFn, 'if (intentTool) runIntents.set');
eq('  ...which the agent tool never passes', /intentTool/.test(runToolFn), false);
// Depth and children are side tables rather than fields on the run, because the
// run is serialized verbatim to both clients. A field would ship the ancestry and
// the child list to the glasses on every broadcast.
unset('the run object carries no depth field', startFn, 'depth:');
unset('the run object carries no children field', startFn, 'children:');
has('both side tables are pruned with the runs', fnSource(relaySrc, 'pruneRuns'), 'runDepths.delete');
has('  ...in both the TTL and the eviction loops', fnSource(relaySrc, 'pruneRuns'), 'runChildren.delete');

// ── 10. the seed table cannot steal a phrase ───────────────────────────────
console.log('\n§10  the seed vocabulary, in table order');
// This kind's seed sits FIRST and `find` takes the FIRST match, so every word
// AGENT_SEED gains is a word taken off whichever seed sits behind it — and the
// symptom is not an error, it is a phrase quietly attaching the wrong tool. The
// table is read out of the real source instead of restated here, so a loose word
// added to any seed shows up as a phrase resolving to the wrong kind.
const seedNames =
  capSrc
    .slice(
      capSrc.indexOf('export const SEED_TOOLS'),
      capSrc.indexOf('];', capSrc.indexOf('export const SEED_TOOLS')),
    )
    .match(/[A-Z]+_SEED/g) ?? [];
const seeds = seedNames.map((name) => {
  const at = capSrc.indexOf(`const ${name}: SeedTool = {`);
  const body = at < 0 ? '' : capSrc.slice(at, capSrc.indexOf('\n};', at));
  const raw = /words:\s*\/((?:\\[\s\S]|[^\\/])*)\/([a-z]*)/.exec(body);
  return {
    kind: /kind:\s*'([a-z]+)'/.exec(body)?.[1] ?? name,
    ...(raw ? { re: new RegExp(raw[1], raw[2]) } : {}),
  };
});
const seedFind = (phrase) => seeds.find((s) => s.re?.test(phrase.toLowerCase()))?.kind ?? null;
/** A resolution that is wrong, phrased so the failure names the phrase and both ends. */
const misread = (cases) =>
  cases
    .filter(([phrase, kind]) => seedFind(phrase) !== kind)
    .map(([phrase, kind]) => `${clip40(phrase)} -> ${seedFind(phrase)} (want ${kind})`);

has('the lookup consults the table in the declared order', capSrc, 'SEED_TOOLS.find((s) => s.words.test(t))');
eq('the table has one seed per kind', seeds.length, 8);
deepEq(
  '  ...and the agent kind is FIRST, because find takes the first match',
  seeds.map((s) => s.kind),
  ['agent', 'web', 'todo', 'docs', 'notes', 'location', 'files', 'jev'],
);

// Every way an orchestrator is asked for by voice.
const ORCHESTRATOR = misread(
  [
    'the agents',
    'the daily digest agent',
    'run the agents',
    'run the six daily agents',
    'ask the other agents',
    'gather the agents',
    'multi-agent',
    'the orchestrator',
    'summarize the six agents',
    'my daily digest',
    'the digest',
    'trigger the daily agents',
    'compile the other agents',
    'run all six agents',
    'call the agents',
    'all six agents',
  ].map((p) => [p, 'agent']),
);
assert('every way the wearer names it resolves to it', ORCHESTRATOR.length === 0, ORCHESTRATOR.join('; '));
// The phrases the seeds BEHIND it own. Sitting first is only safe while this
// holds: the day a word here belongs to a store, the store stops being reachable.
const NEIGHBOURS = misread([
  ['web search', 'web'],
  ['the internet', 'web'],
  ['my to-do list', 'todo'],
  ['the reminders', 'todo'],
  ['docs tab', 'docs'],
  ['my own documents', 'docs'],
  ['my journals', 'docs'],
  ['the notes', 'notes'],
  ['scratchpad', 'notes'],
  ['where am i', 'location'],
  ['near me', 'location'],
  ['the document store', 'files'],
  ['publish', 'files'],
  ['the reports', 'files'],
  ['jev', 'jev'],
  ['score the options', 'jev'],
].map(([p, k]) => [p, k]));
assert('and it takes nothing that belongs to another kind', NEIGHBOURS.length === 0, NEIGHBOURS.join('; '));
// And the verbs that must drag nothing: the seed comment says so in prose, and
// "run" alone is the one word most likely to be added to it next.
const UNCLAIMED = misread(
  ['run', 'start', 'stop', 'the weather', 'my photos', 'the music'].map((p) => [p, null]),
);
assert('a bare verb, or anything no kind owns, is still not a tool', UNCLAIMED.length === 0, UNCLAIMED.join('; '));

console.log(
  fail
    ? `\n${fail} of ${total} FAILED`
    : `\nALL CHECKS PASSED (${total} checks, ${total - fail})`,
);
process.exitCode = fail ? 1 : 0;
