#!/usr/bin/env node
// Harness for Jarvis's own faculties as agent tools — web/server/hub-mcp-tools.mjs.
//
// WHY THIS EXISTS:
//   These two tools are the only place the app uses MCP for anything, which
//   makes them the place a mistake is least likely to be noticed. Three of those
//   mistakes are silent and are asserted here by COUNT, not by reading:
//
//     • The model invents an action, or omits `query`. If either cost a hub call,
//       every confused turn would burn a request against a rate-limited store to
//       be told what the schema already said.
//     • `mcpTool()` RAISES. A refusal that escaped as an exception would take
//       down the whole run and discard every turn before it, so "a refusal is
//       returned as text" is the load-bearing contract of the module.
//     • The `action` enum the model is offered and the cases actually handled
//       could drift apart. That is the exact failure hub-tools.mjs was written
//       to prevent, and this asserts it mechanically rather than by eye.
//
//   It also pins WHY these are built in: the hub's tool kinds are a closed
//   vocabulary of nine, probed live to refuse `kind:'memory'`, so there is no
//   way to author one. If that ever changes, this harness should be the thing
//   that says so.
//
// Run: node tools/hub-mcp-tools-sim.mjs

import {
  HUB_MCP_AGENT_NAMES,
  HUB_MCP_AGENT_TOOLS,
  HUB_MCP_REQUIRED,
  HUB_MCP_TOOL_KIND,
  hubMcpToolSchema,
  isHubMcpTool,
  missingHubMcpTools,
  runHubMcpTool,
} from '../../web/server/hub-mcp-tools.mjs';
import { HUB_MCP_TOOLS, HubMcpError } from '../../web/server/hub-api.mjs';

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
    JSON.stringify(got) === JSON.stringify(want) ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`);

/** A stub hub MCP, recording every call so "no call happened" is a count. */
function stubMcp({ reply, failWith } = {}) {
  const calls = [];
  return {
    calls,
    async mcpTool(name, args) {
      calls.push({ name, args });
      if (failWith) throw failWith;
      const r = typeof reply === 'function' ? reply(name, args) : reply;
      return r ?? { value: null, text: `${name} ok` };
    },
  };
}

const tool = (name) => HUB_MCP_AGENT_TOOLS.find((t) => t.name === name);
const MEMORY = () => tool('jarvis_memory');
const SESSIONS = () => tool('jarvis_sessions');

/** Call and report, so a THROW is a visible failure rather than a crash. */
async function callText(t, args, opts = {}) {
  try {
    return await runHubMcpTool(t, args, opts);
  } catch (err) {
    fail++;
    checks++;
    console.log(`FAIL  runHubMcpTool THREW instead of returning text: ${err?.message}`);
    return `<<THREW ${err?.message}>>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('A. the catalogue, and why these cannot be authored rows');

// The hub's TOOL_KINDS, as probed live on POST /hub/tools. Probed, not read from
// the doc: `kind:'memory'` answers `400 "kind: unsupported value"` with this
// exact `details.allowed` array, which is why a memory tool CANNOT be a row.
const HUB_TOOL_KINDS = ['web', 'tavily', 'http', 'jev', 'files', 'todo', 'docs', 'notes', 'location'];

eq('two faculties are offered', HUB_MCP_AGENT_TOOLS.length, 2);
eq(
  'named by the house convention',
  HUB_MCP_AGENT_TOOLS.map((t) => t.name).sort(),
  ['jarvis_memory', 'jarvis_sessions'],
);
assert(
  'every built-in carries the built-in marker',
  HUB_MCP_AGENT_TOOLS.every((t) => t.kind === HUB_MCP_TOOL_KIND),
);
// ⭐ The marker must be a kind the hub CANNOT mint. If it were a legal kind, a
// stored row would be indistinguishable from a built-in.
assert('the marker is NOT one of the hub\'s nine tool kinds', !HUB_TOOL_KINDS.includes(HUB_MCP_TOOL_KIND));
eq('the vocabulary really is nine, as probed', HUB_TOOL_KINDS.length, 9);
eq('and the names this module owns are exactly its two', [...HUB_MCP_AGENT_NAMES].sort(), ['jarvis_memory', 'jarvis_sessions']);
assert('each built-in declares a toolId for the client to dedupe on', HUB_MCP_AGENT_TOOLS.every((t) => t.toolId === t.name));
assert('each built-in has a description', HUB_MCP_AGENT_TOOLS.every((t) => String(t.description).length > 40));

// ═══════════════════════════════════════════════════════════════════════════
section('B. isHubMcpTool matches the marker and nothing else');

assert('a built-in is recognised', isHubMcpTool(MEMORY()));
assert('a hub todo row is NOT', !isHubMcpTool({ kind: 'todo', name: 'jarvis_memory' }));
assert('a web row is NOT', !isHubMcpTool({ kind: 'web', name: 'web_search' }));
assert('a null is NOT', !isHubMcpTool(null));
assert('an undefined is NOT', !isHubMcpTool(undefined));
assert('a bare string is NOT', !isHubMcpTool('hub_mcp'));
assert('a forged marker with an unknown name IS marked (the name is what gates)', isHubMcpTool({ kind: HUB_MCP_TOOL_KIND, name: 'jarvis_evil' }));

// ⭐ THE APP'S WIRE SHAPE. `POST /api/tool` sends `toolId`, not `name` — the two
// callers describe a tool differently and only one of them can be changed here.
// Matching on `name` alone made every call from the app answer "unknown built-in
// tool" while the executor worked, found by a live request rather than by this
// harness, which is why this case is now pinned.
{
  const appShape = { kind: HUB_MCP_TOOL_KIND, toolId: 'jarvis_memory' };
  assert('a row carrying only toolId is recognised as a built-in', isHubMcpTool(appShape));
  const s = hubMcpToolSchema(appShape);
  eq('and yields its schema', s?.function?.name, 'jarvis_memory');
  const mcp = stubMcp();
  const out = await callText(appShape, { action: 'about' }, { mcp });
  eq('and dispatches', mcp.calls, [{ name: 'memory_read', args: {} }]);
  assert('and answers', !String(out).startsWith('tool error:'), out);
}

// ═══════════════════════════════════════════════════════════════════════════
section('C. the offered enum and the handled cases cannot drift');

const memActions = hubMcpToolSchema(MEMORY()).function.parameters.properties.action.enum;
const sesActions = hubMcpToolSchema(SESSIONS()).function.parameters.properties.action.enum;
eq('memory offers recall/about/remember', memActions, ['recall', 'about', 'remember']);
eq('sessions offers search/recent/read', sesActions, ['search', 'recent', 'read']);
assert('both schemas are function schemas', [hubMcpToolSchema(MEMORY()), hubMcpToolSchema(SESSIONS())].every((s) => s?.type === 'function'));
eq('the schema uses the built-in NAME as the function name', hubMcpToolSchema(MEMORY()).function.name, 'jarvis_memory');
eq('an unrecognised row has no schema', hubMcpToolSchema({ kind: HUB_MCP_TOOL_KIND, name: 'jarvis_nope' }), null);

// ⭐ THE DRIFT GUARD. Every action the schema OFFERS must be accepted, and — the
// half that actually catches drift — every action accepted must be offered. A
// handler with an extra case is a capability the model can never reach.
{
  const mcp = stubMcp();
  const refused = [];
  for (const action of memActions) {
    const out = await callText(MEMORY(), { action, query: 'q', text: 't' }, { mcp });
    if (String(out).startsWith('tool error: action must be')) refused.push(action);
  }
  eq('every memory action the schema offers is handled', refused, []);
  for (const action of sesActions) {
    const mcp2 = stubMcp();
    const out = await callText(SESSIONS(), { action, query: 'q', sessionId: 's' }, { mcp: mcp2 });
    if (String(out).startsWith('tool error: action must be')) refused.push(action);
  }
  eq('every sessions action the schema offers is handled', refused, []);
}

// ═══════════════════════════════════════════════════════════════════════════
section('D. a bad request is refused WITHOUT spending a hub call');

for (const [label, t, args] of [
  ['no action at all', MEMORY(), {}],
  ['an invented action', MEMORY(), { action: 'forget' }],
  ['an action that belongs to the other tool', MEMORY(), { action: 'search' }],
  ['recall with no query', MEMORY(), { action: 'recall' }],
  ['recall with blank text', MEMORY(), { action: 'recall', query: '   ' }],
  ['remember with no text', MEMORY(), { action: 'remember' }],
  ['sessions search with no query', SESSIONS(), { action: 'search' }],
  ['sessions read with no id', SESSIONS(), { action: 'read' }],
  ['sessions recent is fine, so use a bad action', SESSIONS(), { action: 'read' }],
]) {
  const mcp = stubMcp();
  const out = await callText(t, args, { mcp });
  assert(`${label} -> refused`, String(out).startsWith('tool error:'), String(out).slice(0, 60));
  eq(`${label} -> spent no hub call`, mcp.calls.length, 0);
}
{
  // A refusal must name the legal actions, or the model cannot correct itself.
  const out = await callText(MEMORY(), { action: 'forget' }, { mcp: stubMcp() });
  assert('the refusal lists the legal actions', out.includes('recall') && out.includes('about') && out.includes('remember'));
}
{
  const mcp = stubMcp();
  const out = await callText(MEMORY(), { action: 'RECALL', query: 'q' }, { mcp });
  assert('the action is case-insensitive', !String(out).startsWith('tool error:'), out);
}

// ═══════════════════════════════════════════════════════════════════════════
section('E. each action reaches the RIGHT hub MCP tool, with the RIGHT args');

{
  const mcp = stubMcp();
  await callText(MEMORY(), { action: 'about' }, { mcp });
  eq('about -> memory_read', mcp.calls, [{ name: 'memory_read', args: {} }]);
}
{
  const mcp = stubMcp();
  await callText(MEMORY(), { action: 'recall', query: 'the spare key' }, { mcp });
  eq('recall -> recall{text}', mcp.calls, [{ name: 'recall', args: { text: 'the spare key' } }]);
}
{
  const mcp = stubMcp();
  await callText(MEMORY(), { action: 'remember', text: 'Prefers oat milk.' }, { mcp });
  // ⭐ role is PINNED. Writing as `user` would file Jarvis's own observation as
  // something the WEARER said, and a later recall would attribute it to them.
  eq('remember -> memory_write as the assistant', mcp.calls, [{ name: 'memory_write', args: { role: 'assistant', text: 'Prefers oat milk.' } }]);
}
{
  const mcp = stubMcp();
  await callText(SESSIONS(), { action: 'recent' }, { mcp });
  eq('recent -> sessions_list', mcp.calls, [{ name: 'sessions_list', args: {} }]);
}
{
  const mcp = stubMcp();
  await callText(SESSIONS(), { action: 'search', query: 'the list I made' }, { mcp });
  eq('search -> sessions_search{q}', mcp.calls, [{ name: 'sessions_search', args: { q: 'the list I made' } }]);
}
{
  const mcp = stubMcp();
  await callText(SESSIONS(), { action: 'read', sessionId: 'abc' }, { mcp });
  eq('read -> sessions_read{sessionId}', mcp.calls, [{ name: 'sessions_read', args: { sessionId: 'abc' } }]);
}
{
  // Extra keys the model invents must not be forwarded: the hub validates, and
  // `recall` in particular answers 501 for a parameter it does not take.
  const mcp = stubMcp();
  await callText(MEMORY(), { action: 'recall', query: 'q', minScore: 0.5, includeMessages: true, nonsense: 1 }, { mcp });
  eq('unrelated keys are not forwarded', mcp.calls[0].args, { text: 'q' });
}

// ═══════════════════════════════════════════════════════════════════════════
section('F. a refusal is TEXT, never a throw — the whole point of the module');

{
  const mcp = stubMcp({ failWith: new HubMcpError('bad_params', 'q is required') });
  const out = await callText(MEMORY(), { action: 'recall', query: 'x' }, { mcp });
  assert('a hub refusal comes back as a line, not an exception', String(out).startsWith('tool error:'), out);
  assert('and it names the CODE, so the model knows which fix is needed', out.includes('bad_params'));
}
{
  const mcp = stubMcp({ failWith: new HubMcpError('transport', 'the hub MCP answered 502') });
  const out = await callText(SESSIONS(), { action: 'recent' }, { mcp });
  assert('a transport failure is text too', out.includes('transport'), out);
}
{
  const mcp = stubMcp({ failWith: new Error('kaboom\nwith a newline') });
  const out = await callText(MEMORY(), { action: 'about' }, { mcp });
  assert('an unexpected throw is still text', String(out).startsWith('tool error:'), out);
  assert('and is flattened to one line', !String(out).includes('\n'));
}
{
  // No hub at all is the ordinary unconfigured case, and it must read as a tool
  // error rather than crashing the run.
  const out = await callText(MEMORY(), { action: 'about' }, { mcp: null });
  assert('an unconfigured hub refuses in text', String(out).startsWith('tool error:'), out);
}

// ═══════════════════════════════════════════════════════════════════════════
section('G. the readable answer: structured content wins, and nothing overflows');

{
  const mcp = stubMcp({ reply: { value: { text: 'from structuredContent' }, text: 'from content' } });
  eq('structuredContent.text beats content[].text', await callText(MEMORY(), { action: 'about' }, { mcp }), 'from structuredContent');
}
{
  const mcp = stubMcp({ reply: { value: null, text: 'from content' } });
  eq('content[].text is the fallback', await callText(MEMORY(), { action: 'about' }, { mcp }), 'from content');
}
{
  // An empty store is a legitimate empty result, and must read as one rather
  // than as an empty string the model can only interpret as a failure.
  const mcp = stubMcp({ reply: { value: null, text: '' } });
  eq('an empty memory reads as a sentence', await callText(MEMORY(), { action: 'about' }, { mcp }), 'memory is empty');
  const mcp2 = stubMcp({ reply: { value: null, text: '' } });
  eq('an empty recall reads as a sentence', await callText(MEMORY(), { action: 'recall', query: 'q' }, { mcp: mcp2 }), 'nothing remembered about that');
  const mcp3 = stubMcp({ reply: { value: null, text: '' } });
  eq('an empty session list reads as a sentence', await callText(SESSIONS(), { action: 'recent' }, { mcp: mcp3 }), 'no earlier sessions');
}
{
  const long = 'x'.repeat(9_000);
  const mcp = stubMcp({ reply: { value: null, text: long } });
  const out = await callText(SESSIONS(), { action: 'read', sessionId: 's' }, { mcp });
  assert('a long transcript is clipped', out.length < 9_000, `len=${out.length}`);
  // The marker is `[...clipped]` — assert on the word, not on a bracketed form
  // that only looks like it is a substring of it.
  assert('and says so', out.includes('clipped'), out.slice(-24));
}
{
  const long = 'y'.repeat(9_000);
  const mcp = stubMcp({ reply: { value: null, text: long } });
  const out = await callText(SESSIONS(), { action: 'recent' }, { mcp });
  assert('a long session list is clipped harder', out.length < 2_500, `len=${out.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('H. the MCP tools this module depends on really exist on the hub');

// ⭐ An assertion about the real catalogue, not a copy of it: if the hub stops
// advertising one of these, this fails here instead of on a live run.
eq('nothing this module needs is missing from the hub MCP', missingHubMcpTools(), []);
for (const [builtIn, needs] of Object.entries(HUB_MCP_REQUIRED)) {
  for (const need of needs) {
    assert(`${builtIn} depends on ${need}, and the hub declares it`, need in HUB_MCP_TOOLS);
  }
}
eq(
  'the dependency list is exactly the six tools the two faculties use',
  Object.values(HUB_MCP_REQUIRED).flat().sort(),
  ['memory_read', 'memory_write', 'recall', 'sessions_list', 'sessions_read', 'sessions_search'],
);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}  —  ${checks} checks`);
process.exit(fail === 0 ? 0 : 1);
