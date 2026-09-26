#!/usr/bin/env node
// MCP tool substrate + JEV router harness.
//
// WHY THIS EXISTS:
//   mcp-tools.mjs exists so a tool's SCHEMA stops being a hand-written copy of
//   what the server declares. The copy is what failed before: `hard` was live
//   upstream and implemented in our own client, but absent from the schema the
//   model was shown, and nothing in the codebase could notice.
//
//   So the failures worth asserting are not "does tools/list parse". They are the
//   ones that go wrong silently and once:
//
//     • a schema that loses part of the server's inputSchema in translation
//     • a cache that re-reads on every turn, or poisons itself on one bad read
//     • N concurrent turns spending N discoveries against a rate-limited server
//     • a tool-level failure thrown as if it were our bug, so the model never
//       gets the text that would let it work around it
//     • a router that DROPS tools when it cannot rank, turning a degraded turn
//       into "I have no access to that"
//     • a ranking answer that clips two tool names to one label, so the wrong
//       tool gets called
//
//   Everything below drives the real modules against a stubbed transport, so a
//   request that should not happen is a count assertion rather than a log.
//
// Run: node tools/mcp-tools-sim.mjs

import {
  MAX_TOOLS,
  McpToolsError,
  createMcpTools,
  diffParams,
  foldDrift,
  normalizeCatalogue,
  rpcRequest,
  sanitizeInputSchema,
  sanitizeToolName,
  toFunctionSchema,
} from '../../web/server/mcp-tools.mjs';
import {
  DEFAULT_TOP,
  MAX_CANDIDATES,
  routeLabels,
  routeTools,
} from '../../web/server/mcp-router.mjs';
import { filesToolSchema } from '../../web/server/jarvis-files.mjs';

let fail = 0;
const assert = (label, cond, detail = '') => {
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
const has = (label, hay, needle) => assert(label, String(hay).includes(needle), needle);
const lacks = (label, hay, needle) => assert(label, !String(hay).includes(needle), needle);
const throws = async (label, fn, code) => {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label}  (nothing was thrown, wanted ${code})`);
    return null;
  } catch (err) {
    assert(label, err?.code === code, err?.code === code ? '' : `got code ${err?.code}: ${err?.message}`);
    return err;
  }
};

/** A transport that records every call, so "this never happened" is assertable. */
function stubTransport(handler) {
  const calls = [];
  const t = async (method, params, opts = {}) => {
    const rec = { method, params, opts };
    calls.push(rec);
    return handler(rec, calls);
  };
  t.calls = calls;
  return t;
}

const tool = (name, props = {}, description = `Does ${name}.`) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: props, required: [] },
});

// ── §1  discovery passes the server's own schema through ────────────────────
console.log('\n§1  discovery: the server is the source of truth');

eq('a plain name is kept verbatim', sanitizeToolName('read_session'), 'read_session');
eq('a dotted name is made legal rather than dropped', sanitizeToolName('search.web'), 'search_web');
eq('a slash is made legal too', sanitizeToolName('list/sessions'), 'list_sessions');
eq('a leading digit is stripped, not rejected', sanitizeToolName('9lives'), 'lives');
eq('an unsalvageable name still yields a callable one', sanitizeToolName('123'), 'tool');

const nested = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'the document id' },
    depth: { type: 'string', enum: ['basic', 'advanced'], default: 'basic' },
    opts: { type: 'object', properties: { hard: { type: 'boolean' } } },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'ghost'],
  $schema: 'https://json-schema.org/draft/2020-12/schema',
};
const clean = sanitizeInputSchema(nested);
eq('a property survives untouched', clean.properties.id, { type: 'string', description: 'the document id' });
eq('an enum survives untouched', clean.properties.depth.enum, ['basic', 'advanced']);
eq('a default survives untouched', clean.properties.depth.default, 'basic');
eq('a nested object survives', clean.properties.opts.properties.hard, { type: 'boolean' });
eq('an array survives', clean.properties.tags.items, { type: 'string' });
eq('$schema is dropped', clean.$schema, undefined);
eq(
  'required is filtered to properties that exist',
  clean.required,
  ['id'],
  '(a required key the server never defines would fail every call)',
);

const cat = normalizeCatalogue({
  tools: [tool('read_session', { id: { type: 'string' } }), tool('search.web'), tool('read_session', {})],
});
eq('every tool is catalogued', cat.length, 2, '(the duplicate name is dropped, first wins)');
eq('the model-facing name is the sanitized one', cat[1].name, 'search_web');
eq(
  'the name the SERVER answers to is kept beside it',
  cat[1].serverName,
  'search.web',
  '(so a call can be translated back)',
);
eq('the catalogued params are the server\'s', cat[0].parameters.properties, { id: { type: 'string' } });
eq('a prefix namespaces a whole server', normalizeCatalogue({ tools: [tool('search')] }, { prefix: 'gw__' })[0].name, 'gw__search');
eq('no description still yields a usable one', toFunctionSchema(tool('bare', {}, '')).function.description, 'Call bare.');
await throws('a nameless tool is refused', async () => toFunctionSchema({ name: '' }), 'bad_tool');
eq('the catalogue is capped', normalizeCatalogue({ tools: Array.from({ length: MAX_TOOLS + 5 }, (_, i) => tool(`t${i}`)) }).length, MAX_TOOLS);

// ── §2  the cache: shared, bounded, and never poisoned ──────────────────────
console.log('\n§2  the cache is shared, bounded, and never poisoned');

{
  const tx = stubTransport(() => ({ tools: [tool('a'), tool('b')] }));
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  const first = await mcp.list();
  eq('a first read returns the catalogue', first.length, 2);
  eq('the read happened once', tx.calls.length, 1);
  await mcp.list();
  await mcp.list();
  eq('a warm read spends nothing', tx.calls.length, 1, '(three reads, one discovery)');
  eq('the method is tools/list', tx.calls[0].method, 'tools/list');
  await mcp.list({ refresh: true });
  eq('a forced refresh reads again', tx.calls.length, 2);
}

{
  const tx = stubTransport(() => ({ tools: [tool('a')] }));
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  await Promise.all([mcp.list(), mcp.list(), mcp.list(), mcp.list()]);
  eq(
    'four COLD callers cost exactly one discovery',
    tx.calls.length,
    1,
    '(this is the burst that hits a rate limit without single-flight)',
  );
}

{
  let mode = 'fail';
  const tx = stubTransport(() => {
    if (mode === 'fail') throw new McpToolsError('transport', 'server is down');
    return { tools: [tool('recovered')] };
  });
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  await throws('a failed read raises a typed error', () => mcp.list(), 'transport');
  eq('nothing was cached', mcp.peek(), null);
  mode = 'ok';
  const second = await mcp.list();
  eq('the next read retries rather than inheriting the failure', second[0].name, 'recovered');
  eq('and it really did go back to the server', tx.calls.length, 2);
}

{
  let clock = 1000;
  const tx = stubTransport(() => ({ tools: [tool('a')] }));
  const mcp = createMcpTools({ name: 'stub', transport: tx, ttlMs: 500, now: () => clock });
  await mcp.list();
  clock = 1400;
  await mcp.list();
  eq('inside the TTL the cache is used', tx.calls.length, 1);
  clock = 1600;
  await mcp.list();
  eq('past the TTL it is re-read', tx.calls.length, 2);
}

// ── §3  a failed OPERATION is a value, a failed CALL is a throw ─────────────
console.log('\n§3  the two failure levels stay separate');

{
  const tx = stubTransport(() => ({
    content: [{ type: 'text', text: 'deleted doc-1' }],
    structuredContent: { id: 'doc-1', deleted: true },
  }));
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  await mcp.list();
  const r = await mcp.call('a', { id: 'doc-1' });
  eq('the tool text is returned', r.text, 'deleted doc-1');
  eq('the structured payload is kept', r.data, { id: 'doc-1', deleted: true });
  eq('success is not an error', r.isError, false);
  eq('the call names the tool the SERVER knows', tx.calls[1].params.name, 'a');
  eq('the method is tools/call', tx.calls[1].method, 'tools/call');
}

{
  const tx = stubTransport(() => ({ isError: true, content: [{ type: 'text', text: 'not_found: no such id' }] }));
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  await mcp.list();
  const r = await mcp.call('a', {});
  eq('a tool-level failure comes back as a VALUE', r.isError, true, '(the model can read it and adapt)');
  has('…carrying the text that says why', r.text, 'not_found');
}

{
  const tx = stubTransport((rec) => {
    if (rec.method === 'tools/call') throw new McpToolsError('jsonrpc', 'no such tool', { detail: { code: -32601 } });
    return { tools: [tool('a')] };
  });
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  await mcp.list();
  const err = await throws('a refused CALL throws', () => mcp.call('ghost', {}), 'jsonrpc');
  eq('…and the JSON-RPC detail is preserved', err.detail.code, -32601);
}

{
  const tx = stubTransport(() => ({ tools: [tool('a', {}, 'A')] }));
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  const schemas = await mcp.schemas();
  eq('schemas() is the OpenAI shape', schemas[0].type, 'function');
  eq('…with the tool name', schemas[0].function.name, 'a');
  eq('…and the server params', schemas[0].function.parameters.type, 'object');
  const listed = await mcp.catalog();
  eq('catalog() is the flat shape the router ranks', Object.keys(listed[0]).sort(), ['description', 'name', 'parameters', 'serverName']);
}

// ── the gateway's own catalogue ─────────────────────────────────────────────
//
// Kept verbatim, as the live `tools/list` returned it, and declared HERE rather
// than next to the section that first needed it: a fixture invented for
// convenience would assert the drift check against a shape that does not exist,
// and every section that compares the hand-written schema against the server has
// to compare it against the same real one. Duplicating it was how §4 ended up
// asking about ten parameters out of the twenty-two the gateway accepts.

/** `[tool name, [every parameter it accepts]]` — the whole server, nothing added. */
const GATEWAY_PAIRS = [
  ['create_session', ['html', 'agent', 'title', 'tags', 'content_type', 'id', 'overwrite', 'slug']],
  ['read_session', ['id', 'include_html']],
  ['update_session', ['id', 'html', 'title', 'agent', 'tags', 'content_type', 'if_version']],
  ['delete_session', ['id', 'hard', 'reason']],
  ['list_sessions', ['limit', 'offset', 'agent', 'tag', 'q', 'order', 'include_deleted']],
  ['search_sessions', ['q', 'limit']],
  ['session_stats', []],
  ['list_revisions', ['id', 'change', 'subject', 'agent', 'order', 'limit', 'offset']],
  ['read_revision', ['id', 'revision', 'include_html']],
  ['restore_revision', ['id', 'revision', 'restore_metadata', 'if_version', 'subject']],
  ['revision_stats', ['id']],
];

const GATEWAY = GATEWAY_PAIRS.map(([name, props]) =>
  tool(name, Object.fromEntries(props.map((p) => [p, { type: 'boolean' }]))),
);
const gatewayCatalogue = normalizeCatalogue({ tools: GATEWAY });

/**
 * Every parameter name the gateway accepts anywhere, plus our own switch key.
 *
 * This is the ONE correct answer to "what may the model be told to send?", and
 * deriving it from the fixture is the point: a hand-typed list is a second
 * hand-written schema, which is the exact failure this whole module exists to
 * catch.
 */
const GATEWAY_PARAMS = ['action', ...new Set(GATEWAY_PAIRS.flatMap(([, props]) => props))];

// ── §4  the drift check reports both directions ──────────────────────────────
console.log('\n§4  drift is reported in both directions, and they are not the same thing');

eq(
  'a parameter we advertise that the server lacks is flagged',
  diffParams({ id: {}, hard: {} }, ['id']).missingOnServer,
  ['hard'],
  '(this one makes every call that uses it fail)',
);
eq(
  'a parameter the server has that we never offer is flagged',
  diffParams({ id: {} }, ['id', 'reason']).missingLocally,
  ['reason'],
  '(this one makes a capability unreachable, silently)',
);
eq('agreement produces no drift', diffParams({ id: {} }, ['id']), { missingOnServer: [], missingLocally: [] });

{
  const tx = stubTransport(() => ({ tools: [tool('read_session', { id: {} })] }));
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  const d = await mcp.drift({ read_session: { id: {}, include_html: {} } });
  eq('drift runs against the real catalogue', d.length, 1);
  eq('…and names the over-claimed parameter', d[0].missingOnServer, ['include_html']);
}

{
  // THE REAL BUG, PINNED — now as the guard on its own fix.
  //
  // `hard` and `reason` existed upstream and were implemented in our own client
  // (remove() in jarvis-files.mjs), while the schema the model was shown omitted
  // both — so "delete it permanently" said to Jarvis was a soft delete and
  // nothing anywhere reported the gap. The same was true of seven whole tools.
  // Checked in BOTH directions against the verbatim catalogue, because
  // over-claiming fails every call that uses the parameter and under-offering
  // silently removes a capability: they are different bugs and this schema had
  // one of each.
  const advertised = filesToolSchema().function.parameters.properties;
  const d = diffParams(advertised, GATEWAY_PARAMS);
  eq('the files tool over-claims nothing', d.missingOnServer, []);
  eq(
    'the files tool under-offers nothing',
    d.missingLocally,
    [],
    '(hard is what makes a delete permanent; reason is its audit note)',
  );
}

// ── §5  the router fails OPEN, never closed ─────────────────────────────────
console.log('\n§5  an unrankable turn keeps every tool');

const six = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((n) => ({
  name: n,
  serverName: n,
  description: `${n} does ${n} things.`,
}));

{
  const r = await routeTools({ ask: 'do something', catalogue: six, top: 10, respond: async () => ({}) });
  eq('a catalogue that already fits is not ranked', r.routed, false);
  eq('…and every tool is kept', r.chosen.length, 6);
  has('…and it says why', r.reason, 'already fits');
}

{
  const r = await routeTools({ ask: 'do something', catalogue: six, top: 3 });
  eq('no ranker configured is not an error', r.routed, false);
  eq('…and every tool is still kept', r.chosen.length, 6);
  has('…and it says so', r.reason, 'no ranker');
}

{
  const r = await routeTools({
    ask: 'do something',
    catalogue: six,
    top: 3,
    respond: async () => {
      throw new Error('ranker is down');
    },
  });
  eq('a ranker that throws does not cost the turn its tools', r.chosen.length, 6);
  has('…and the failure is surfaced', r.reason, 'ranker failed');
}

{
  const r = await routeTools({ ask: 'do something', catalogue: six, top: 3, respond: async () => ({}) });
  eq('an empty answer keeps every tool', r.chosen.length, 6);
  has('…rather than choosing nothing', r.reason, 'no basis to order');
}

{
  // JEV is deliberate about this: an answer with no distribution degrades to
  // DECLARED order with top=null, so that a caller cannot mistake it for a
  // ranking. If the router took that order it would narrow the turn to the first
  // N tools in CATALOG order — an arbitrary subset reported as a decision, which
  // is the exact failure mode this whole layer exists to remove.
  const r = await routeTools({
    ask: 'do something',
    catalogue: six,
    top: 2,
    respond: async () => ({ use: { type: 'choice', choice: 'gamma' } }),
  });
  eq('a claimed choice with NO distribution is not a ranking', r.routed, false);
  eq('…so the turn keeps every tool', r.chosen.length, 6, '(not just the catalogue leader)');
  has('…and the reason is the one JEV gave', r.reason, 'probabilities');
}

{
  const big = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({
    name: `t${i}`,
    serverName: `t${i}`,
    description: `tool ${i}`,
  }));
  let asked = false;
  const r = await routeTools({
    ask: 'do something',
    catalogue: big,
    top: 3,
    respond: async () => {
      asked = true;
      return {};
    },
  });
  eq('a catalogue above the ranking limit is not ranked', r.routed, false);
  eq('…and NOT truncated', r.chosen.length, MAX_CANDIDATES + 1, '(a dropped tool is a vanishing capability)');
  has('…the reason names the limit', r.reason, String(MAX_CANDIDATES));
  eq('…and no pointless call was made', asked, false);
}

{
  const r = await routeTools({ ask: '   ', catalogue: six, top: 3, respond: async () => ({}) });
  eq('nothing to route against keeps everything', r.chosen.length, 6);
  has('…and says so', r.reason, 'no request');
}

// ── §6  ranking: the shortlist, and the answer is taken at its word ─────────
console.log('\n§6  ranking picks the shortlist and reports an untrustworthy order');

const probs = (map) => ({ use: { type: 'choice', probabilities: map, confidence: 0.9 } });

{
  const r = await routeTools({
    ask: 'delete the old report permanently',
    catalogue: six,
    top: 3,
    respond: async () => probs({ alpha: 0.05, beta: 0.7, gamma: 0.15, delta: 0.05, epsilon: 0.03, zeta: 0.02 }),
  });
  eq('the turn is routed', r.routed, true);
  eq('the shortlist is `top` long', r.chosen.length, 3);
  eq('the leader is first', r.chosen[0].name, 'beta');
  eq('the rest follow the ranking', r.chosen.map((c) => c.name), ['beta', 'gamma', 'alpha']);
  eq('a separated leader is not flagged', r.unresolved, false);
  eq('…and no reason is attached', r.reason, null);
  eq('every tool is still reported', r.all.length, 6);
}

{
  const r = await routeTools({
    ask: 'do a thing',
    catalogue: six,
    top: 2,
    respond: async () => probs({ alpha: 0.28, beta: 0.27, gamma: 0.1, delta: 0.1, epsilon: 0.15, zeta: 0.1 }),
  });
  eq('a coin-toss leader is flagged', r.unresolved, true, '(top two are inside JEV\'s margin)');
  eq('…but the shortlist is still handed back', r.chosen.length, 2, '(a caller asked for several tools, not a winner)');
  has('…with the reason attached', r.reason, 'top two');
}

{
  let seen = null;
  await routeTools({
    ask: 'summarise the report',
    catalogue: six,
    top: 2,
    respond: async (req) => {
      seen = req;
      return probs({ alpha: 0.6, beta: 0.1, gamma: 0.1, delta: 0.1, epsilon: 0.05, zeta: 0.05 });
    },
  });
  has('the REQUEST is the state', JSON.stringify(seen), 'summarise the report');
  has('…and every tool is a candidate', JSON.stringify(seen), 'epsilon');
  has(
    '…each candidate carries the tool\'s OWN description',
    JSON.stringify(seen),
    'epsilon does epsilon things',
    '(this is what makes the ranking semantic rather than on names)',
  );
}

{
  // A distribution that covers only SOME candidates. Worth pinning, because JEV's
  // `unresolved` is about the TOP TWO and nothing else: if both of those carry a
  // number the order is comparable, however many candidates below them are
  // unscored. The router must therefore trust it rather than failing open — and
  // must never let an unscored candidate outrank a scored one.
  const r = await routeTools({
    ask: 'anything',
    catalogue: six,
    top: 2,
    respond: async () => ({ use: { type: 'choice', probabilities: { zeta: 0.9, epsilon: 0.05 } } }),
  });
  eq('a partial distribution still routes', r.routed, true);
  eq('…on the candidates it actually scored', r.chosen.map((c) => c.name), ['zeta', 'epsilon']);
  eq('…and a clear top two is NOT flagged', r.unresolved, false, '(unscored candidates sort below, never above)');
  eq('…so no reason is attached', r.reason, null);
}

{
  // But when the top two are NOT both scored, there is no comparison to make and
  // JEV says so. The shortlist is still returned — dropping the unscored tail
  // would remove tools the caller never chose to remove — but the caller is told
  // the separation is unsupported. This is the only honest option: the padded
  // entries are in CATALOG order, which is arbitrary, so it must not be silent.
  const r = await routeTools({
    ask: 'anything',
    catalogue: six,
    top: 2,
    respond: async () => ({ use: { type: 'choice', probabilities: { zeta: 0.9 } } }),
  });
  eq('one scored candidate still routes', r.routed, true);
  eq('…the scored one leads', r.chosen[0].name, 'zeta');
  eq('…and the rest is padding', r.chosen.length, 2);
  eq('…so the order is flagged as not comparable', r.unresolved, true);
  has('…with the reason attached', r.reason, 'does not cover');
}

// ── §7  labels are unique and legal, because an answer is read verbatim ─────
console.log('\n§7  labels are unique and legal');

{
  const labels = routeLabels(['alpha', 'beta']);
  eq('a short name is its own label', labels[0].label, 'alpha');
  eq('…and maps back to the name', labels[0].name, 'alpha');
}

{
  const long = 'x'.repeat(58) + 'aaaa';
  const alsoLong = 'x'.repeat(58) + 'bbbb';
  const labels = routeLabels([long, alsoLong]);
  assert('an over-long name is clipped to the limit', labels[0].label.length <= 60, `${labels[0].label.length}`);
  assert(
    '…and two names that clip alike still get DISTINCT labels',
    labels[0].label !== labels[1].label,
    '(an answer is read verbatim, so a collision calls the wrong tool)',
  );
  eq('…both still map back to their real names', [labels[0].name, labels[1].name], [long, alsoLong]);
}

{
  const r = await routeTools({
    ask: 'x'.repeat(2000),
    catalogue: six,
    top: 1,
    respond: async (req) => {
      assert('a 2000-char ask is clipped into the instruction bound', req.questions.use.instructions.length <= 400, `${req.questions.use.instructions.length}`);
      return probs({ alpha: 0.6, beta: 0.1, gamma: 0.1, delta: 0.1, epsilon: 0.05, zeta: 0.05 });
    },
  });
  eq('…and the turn still routes', r.routed, true);
  assert('the shortlist honours top', r.chosen.length === 1);
}

{
  const r = await routeTools({
    ask: 'anything',
    catalogue: six,
    top: DEFAULT_TOP,
    respond: async () => probs(Object.fromEntries(six.map((t) => [t.name, 0.1 + six.indexOf(t) * 0.01]))),
  });
  eq('the default shortlist size is used', r.chosen.length, DEFAULT_TOP);
}

// ── §8  the substrate and the router compose ────────────────────────────────
console.log('\n§8  discovery and routing compose into one turn');

{
  // A catalogue large enough to need routing, served over the real substrate —
  // the exact path a second MCP server would take with no schema code at all.
  const tools = Array.from({ length: 8 }, (_, i) => tool(`tool_${i}`, { id: { type: 'string' } }, `Tool number ${i}.`));
  const tx = stubTransport(() => ({ tools }));
  const mcp = createMcpTools({ name: 'stub', transport: tx });
  const catalog = await mcp.catalog();
  const r = await routeTools({
    ask: 'use the best one',
    catalogue: catalog,
    top: 2,
    respond: async () => probs(Object.fromEntries(catalog.map((t, i) => [t.name, i === 5 ? 0.9 : 0.02]))),
  });
  eq('the catalogue came from tools/list', catalog.length, 8);
  eq('the router narrowed it', r.chosen.length, 2);
  eq('…to the tool the ranker named', r.chosen[0].name, 'tool_5');
  const schemas = await mcp.schemas();
  const chosen = schemas.filter((s) => r.chosen.some((c) => c.name === s.function.name));
  eq('…and each chosen tool has a schema to send', chosen.length, 2);
  eq('…with the server\'s parameter intact', chosen[0].function.parameters.properties.id, { type: 'string' });
  eq('…and only ONE discovery was spent for the whole turn', tx.calls.length, 1);
}

{
  // The message envelope is what a real server sees, so pin its shape.
  const req = rpcRequest(7, 'tools/list', {});
  eq('a JSON-RPC request is well formed', req, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
}

// ── §9  the drift check fires on the bug that actually happened ─────────────
console.log('\n§9  fold drift: the check the hand-written schema never had');

/**
 * The gateway's OWN catalogue, exactly as the live `tools/list` returned it.
 * Defined once, above §4 — see GATEWAY_PAIRS there for why it is not repeated.
 */

/** The fold the relay actually declares. Must match FILES_FOLD in local-sse.mjs. */
const FOLD = {
  publish: 'create_session',
  list: 'list_sessions',
  search: 'search_sessions',
  stats: 'session_stats',
  read: 'read_session',
  update: 'update_session',
  delete: 'delete_session',
  history: 'list_revisions',
  revision: 'read_revision',
  revert: 'restore_revision',
  revision_stats: 'revision_stats',
};

{
  const drift = foldDrift({
    localProperties: filesToolSchema({}).function.parameters.properties,
    fold: FOLD,
    catalogue: gatewayCatalogue,
  });

  eq(
    'the fold tells no lies',
    drift.missingOnServer,
    [],
    '(every parameter it offers is accepted by a tool it folds)',
  );
  eq(
    'the fold invents no tool',
    drift.unknownFoldedTools,
    [],
    '(a stale name here is a dead action)',
  );
  assert(
    'the fold does not cry wolf about its own switch key',
    !drift.missingOnServer.includes('action') && !drift.missingLocally.includes('action'),
    'action is ours, no server tool defines it',
  );
  // ELEVEN OF ELEVEN. This started as "7 of the gateway is unreachable through
  // the fold", measured — a fold covering four tools out of eleven, which left
  // editing a document, its whole history, reading a past revision, reverting to
  // one, searching, and both stats calls impossible to express. The number in
  // this assertion is the feature: it is the one place the gap is counted.
  eq('every gateway tool is reachable through the fold', drift.unusedTools, []);
  assert(
    'nothing the gateway defines is left unreachable',
    drift.missingLocally.length === 0,
    drift.missingLocally.join(', '),
  );
  assert('…so the editing and history tools are no longer orphans', [
    'update_session',
    'search_sessions',
    'session_stats',
    'list_revisions',
    'read_revision',
    'restore_revision',
    'revision_stats',
  ].every((n) => !drift.unusedTools.includes(n)), drift.unusedTools.join(', '));
}

{
  // NEGATIVE CONTROL. The check above passing proves nothing on its own: a check
  // that can never fire also never fails. So feed it a fold that IS wrong and
  // require it to say so — one invented parameter (a lie that fails every call)
  // and one stale tool name (a dead action).
  const drift = foldDrift({
    localProperties: { ...filesToolSchema({}).function.parameters.properties, ghost_param: { type: 'string' } },
    fold: { ...FOLD, publish: 'create_document' },
    catalogue: gatewayCatalogue,
  });
  assert(
    'a parameter no folded tool accepts IS reported as a lie',
    drift.missingOnServer.includes('ghost_param'),
    drift.missingOnServer.join(', '),
  );
  assert(
    'a fold naming a tool that no longer exists IS reported',
    drift.unknownFoldedTools.includes('create_document'),
    drift.unknownFoldedTools.join(', '),
  );
  // …and the two directions stay separate: a stale name must not be dressed up
  // as a lie the model can act on.
  lacks('a stale fold name is not also a lie', drift.missingOnServer.join(','), 'create_document');
}

{
  // A server with no catalogue at all must produce empty reports, not throw:
  // this runs at boot, where a gateway that is down must not stop the relay.
  const drift = foldDrift({ localProperties: { a: {} }, fold: { x: 'y' }, catalogue: [] });
  eq('an empty catalogue reports nothing missing', drift.missingLocally, []);
  eq('…and names the fold entry it could not find', drift.unknownFoldedTools, ['y']);
  eq('…and invents nothing', drift.unusedTools, []);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
