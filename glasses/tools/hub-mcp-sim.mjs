#!/usr/bin/env node
// Harness for the hub's MCP client — `createHubClient().mcpSend/mcpTools/mcpTool`
// in web/server/hub-api.mjs.
//
// WHY THIS EXISTS:
//   The hub's MCP endpoint is the ONE surface where the app's rule is inverted:
//   the REST routes are for the app, and MCP is for Jarvis and the agent loop.
//   hub-api.mjs makes that a real boundary by refusing `/mcp` on the HTTP path.
//   Two things about it go wrong SILENTLY, and both are asserted here:
//
//     • Somebody "helpfully" adds a todo/docs/notes tool to the MCP table, or
//       routes an app data path through mcpTool(), because the surface LOOKS
//       like a general data API. It is not: the hub advertises twelve tools over
//       sessions/memory/recall/ledger/settings and nothing else. Probed live —
//       `tools/call todos_list` answers `-32602 "no such tool: todos_list"`.
//     • The lock-in of a SECOND SESSION. Refresh tokens are single-use and
//       rotate, so a second session on the one account makes the loser's next
//       refresh answer `refresh_token_reuse`, which revokes the whole family and
//       signs every surface out. So "this never logs in on its own" is asserted
//       as a COUNT, not reviewed by eye.
//
//   The error mapping is asserted against the PROBED numbers rather than the
//   spec's, because the spec is wrong about the one that matters: an unknown
//   TOOL is `-32602`, not `-32601`. `-32601` is an unknown METHOD, and the two
//   need different fixes.
//
//   Nothing here writes to a real hub: `request` is a stub, so "no call
//   happened" is a count assertion rather than a log to read.
//
// Run: node tools/hub-mcp-sim.mjs

import {
  HUB_MCP_PATH,
  HUB_MCP_PROTOCOL_VERSION,
  HUB_MCP_TOOLS,
  HubMcpError,
  createHubClient,
  isBlockedHubPath,
  mcpErrorOf,
  mcpResultOf,
} from '../../web/server/hub-api.mjs';

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

const throws = async (label, fn, code) => {
  try {
    await fn();
    checks++;
    fail++;
    console.log(`FAIL  ${label}  (nothing was thrown, wanted ${code})`);
    return null;
  } catch (err) {
    assert(label, err?.code === code, err?.code === code ? '' : `got code ${err?.code}: ${err?.message}`);
    return err;
  }
};

/**
 * A shared-session stub. Records every call so "never logged in" and "retried
 * exactly once" are counts, and lets a test force the 401 the retry exists for.
 *
 * `request` returns the NON-raw shape (`{status, ok, headers, body, text}`),
 * which is what jarvis-files.mjs hands back when `raw` is not set — and the MCP
 * client deliberately does not set it, because it wants the parsed body.
 */
function stubSession({ handler } = {}) {
  const calls = [];
  let tokens = 0;
  let logins = 0;
  const session = {
    configured: true,
    async ensureToken() {
      tokens++;
      return 'tok-1';
    },
    forget() {
      session.forgotten = (session.forgotten || 0) + 1;
    },
    async login() {
      logins++;
      return 'tok-1';
    },
    async request(path, opts = {}) {
      calls.push({ path, ...opts });
      const r = (handler || defaultHub)(path, opts, calls.length);
      return {
        status: 200,
        ok: true,
        headers: null,
        body: null,
        text: '',
        ...(typeof r === 'function' ? r() : r),
      };
    },
  };
  return {
    session,
    calls,
    count: () => calls.length,
    reset: () => {
      calls.length = 0;
    },
    tokens: () => tokens,
    logins: () => logins,
    mcpCalls: () => calls.filter((c) => String(c.path).endsWith(HUB_MCP_PATH)),
    bodies: () => calls.map((c) => c.body).filter(Boolean),
  };
}

/** `/config` once, then a JSON-RPC answer per method. */
function defaultHub(path, opts) {
  if (path === '/config') return { body: { hub_prefix: '/hub' } };
  const m = opts.body;
  if (m?.method === 'tools/list') {
    return {
      body: {
        jsonrpc: '2.0',
        id: m.id,
        result: {
          tools: Object.entries(HUB_MCP_TOOLS).map(([name, required]) => ({
            name,
            description: name,
            inputSchema: { type: 'object', properties: {}, required },
          })),
        },
      },
    };
  }
  if (m?.method === 'tools/call') {
    return { body: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ran ${m.params.name}` }] } } };
  }
  return { body: { jsonrpc: '2.0', id: m?.id, error: { code: -32601, message: 'no such method' } } };
}

// ═══════════════════════════════════════════════════════════════════════════
section('A. the catalogue is the hub\'s, and it has NO todo/docs/notes tool');

eq('twelve tools are declared', Object.keys(HUB_MCP_TOOLS).length, 12);
eq(
  'they are exactly the sessions/memory/recall/ledger/settings surface',
  Object.keys(HUB_MCP_TOOLS).sort(),
  [
    'ledger_read',
    'memory_read',
    'memory_write',
    'recall',
    'sessions_clear',
    'sessions_list',
    'sessions_read',
    'sessions_save',
    'sessions_search',
    'sessions_stats',
    'sessions_summarize',
    'settings_read',
  ],
);
for (const bad of ['todos_list', 'todos_save', 'docs_list', 'documents_list', 'notes_read', 'notes_write', 'files_list']) {
  assert(`no ${bad} tool exists on the hub MCP`, !(bad in HUB_MCP_TOOLS));
}
assert(
  'every declared name is a legal MCP tool name',
  Object.keys(HUB_MCP_TOOLS).every((n) => /^[a-z][a-z0-9_]*$/.test(n) && n.length <= 64),
);
eq('the endpoint is /mcp under the hub prefix', HUB_MCP_PATH, '/mcp');
eq('the protocol version is the one the hub reports', HUB_MCP_PROTOCOL_VERSION, '2024-11-05');
// The required-arg table is copied from a live `tools/list`; these five are the
// ones a caller gets wrong, so they are pinned rather than merely present.
eq('sessions_save needs kind + messages', HUB_MCP_TOOLS.sessions_save, ['kind', 'messages']);
eq('sessions_read needs sessionId', HUB_MCP_TOOLS.sessions_read, ['sessionId']);
eq('sessions_search needs q', HUB_MCP_TOOLS.sessions_search, ['q']);
eq('memory_write needs role + text', HUB_MCP_TOOLS.memory_write, ['role', 'text']);
eq('recall needs text', HUB_MCP_TOOLS.recall, ['text']);

// ═══════════════════════════════════════════════════════════════════════════
section('B. a tool result is unwrapped, and structuredContent wins');

eq('a single text part is read', mcpResultOf({ content: [{ type: 'text', text: 'hi' }] }).text, 'hi');
eq(
  'several text parts are joined, and a non-text part contributes nothing',
  mcpResultOf({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }).text,
  'a\nb',
);
eq(
  'structuredContent is preferred as the machine-readable value',
  mcpResultOf({ structuredContent: { turns: 2 }, content: [{ type: 'text', text: 'turns: 2' }] }).value,
  { turns: 2 },
);
eq('text survives alongside it', mcpResultOf({ structuredContent: { turns: 2 }, content: [{ type: 'text', text: 'turns: 2' }] }).text, 'turns: 2');
eq('a result with no structuredContent has a null value, not undefined', mcpResultOf({ content: [] }).value, null);
eq('a null result is tolerated', mcpResultOf(null), { value: null, text: '' });
eq('a garbage result is tolerated', mcpResultOf('nonsense'), { value: null, text: '' });
eq('a content entry that is not an object is skipped', mcpResultOf({ content: [null, { text: 'ok' }] }).text, 'ok');

// ═══════════════════════════════════════════════════════════════════════════
section('C. the JSON-RPC error map is PROBED, not copied from the spec');

eq('-32601 is an unknown METHOD', mcpErrorOf({ code: -32601, message: 'x' }).code, 'unknown_method');
eq('-32602 is bad PARAMS', mcpErrorOf({ code: -32602, message: 'x' }).code, 'bad_params');
// ⚠ THE ONE THE SPEC GETS WRONG. §9.1 and §9.5 both say an unknown tool is
// -32601; live it is -32602, and this is the assertion that keeps us honest.
eq(
  'an unknown TOOL arrives as -32602, never -32601',
  (() => {
    const e = mcpErrorOf({ code: -32602, message: 'no such tool: todos_list' });
    return [e.code, e.jsonrpc, e.message];
  })(),
  ['bad_params', -32602, 'no such tool: todos_list'],
);
eq('-32000 means the tool ran and refused', mcpErrorOf({ code: -32000, message: 'x' }).code, 'tool_refused');
eq('-32700 is a parse error', mcpErrorOf({ code: -32700, message: 'x' }).code, 'parse_error');
eq('-32600 is an invalid request', mcpErrorOf({ code: -32600, message: 'x' }).code, 'invalid_request');
eq('-32603 is an internal error', mcpErrorOf({ code: -32603, message: 'x' }).code, 'internal_error');
eq('an unmapped number keeps its number as text', mcpErrorOf({ code: -32099, message: 'x' }).code, 'jsonrpc_-32099');
eq('a missing code becomes jsonrpc_NaN rather than "undefined"', mcpErrorOf({ message: 'x' }).code, 'jsonrpc_NaN');
eq('a missing code reports jsonrpc: null, not NaN', mcpErrorOf({ message: 'x' }).jsonrpc, null);
assert('the mapped error is a real HubMcpError', mcpErrorOf({ code: -32602 }) instanceof HubMcpError);
assert('the raw message is carried through', mcpErrorOf({ code: -32000, message: 'refused' }).message === 'refused');

// ═══════════════════════════════════════════════════════════════════════════
section('D. the SHARED session, the cached prefix, and one id per call');

{
  const s = stubSession();
  const hub = createHubClient(s.session);
  eq('the prefix is discovered from /config', await hub.prefix(), '/hub');
  await hub.prefix();
  await hub.prefix();
  eq('and is read ONCE for three asks', s.calls.filter((c) => c.path === '/config').length, 1);

  const tools = await hub.mcpTools();
  eq('tools/list returns what the hub advertised', tools.length, 12);
  const c = s.mcpCalls()[0];
  eq('the MCP call goes to /hub/mcp', c.path, '/hub/mcp');
  eq('as a POST', c.method, 'POST');
  eq('with the SHARED bearer', c.token, 'tok-1');
  eq('claiming JSON-RPC 2.0', c.body.jsonrpc, '2.0');
  eq('and the tools/list method', c.body.method, 'tools/list');
  eq('...with no params object invented', c.body.params, {});

  const ids = [];
  await hub.mcpTool('memory_read', {});
  await hub.mcpTool('settings_read', {});
  await hub.mcpTool('sessions_stats', {});
  for (const b of s.bodies()) if (b.id !== undefined) ids.push(b.id);
  eq('every message carries a unique id', new Set(ids).size, ids.length);
  eq('and the id is not a string', ids.every((i) => typeof i === 'number'), true);

  const call = s.mcpCalls().at(-1);
  eq('a tool call uses tools/call', call.body.method, 'tools/call');
  eq('naming the tool in params.name', call.body.params.name, 'sessions_stats');
  eq('and passing an object for arguments', call.body.params.arguments, {});

  // ⭐ THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE.
  eq('the client never signs in on its own', s.logins(), 0);
  assert('it asked the shared session for a token instead', s.tokens() > 0);
}

eq('a bad prefix falls back to /hub rather than 404-ing every route', await (async () => {
  const s = stubSession({ handler: (p) => (p === '/config' ? { body: {} } : defaultHub(p)) });
  return createHubClient(s.session).prefix();
})(), '/hub');

eq('two clients cannot invent a second prefix read', await (async () => {
  const s = stubSession({ handler: (p) => (p === '/config' ? { body: { hub_prefix: 'hub' } } : defaultHub(p)) });
  const hub = createHubClient(s.session);
  const first = await hub.prefix();
  hub.resetPrefix();
  const second = await hub.prefix();
  return [first, second, s.calls.filter((c) => c.path === '/config').length];
})(), ['/hub', '/hub', 2]);

// ═══════════════════════════════════════════════════════════════════════════
section('E. a refusal is a typed error, never a truthy field');

{
  const s = stubSession({
    handler: (p, opts) =>
      p === '/config'
        ? { body: { hub_prefix: '/hub' } }
        : { body: { jsonrpc: '2.0', id: opts.body.id, error: { code: -32602, message: 'no such tool: todos_list' } } },
  });
  const hub = createHubClient(s.session);
  const err = await throws('an unknown tool is raised, not returned', () => hub.mcpTool('todos_list', {}), 'bad_params');
  eq('and it names the tool the hub refused to know', err?.message, 'no such tool: todos_list');
}

{
  const s = stubSession({
    handler: (p, opts) =>
      p === '/config'
        ? { body: { hub_prefix: '/hub' } }
        : { body: { jsonrpc: '2.0', id: opts.body.id, error: { code: -32601, message: 'no such method: nope' } } },
  });
  const hub = createHubClient(s.session);
  await throws('a bad method is unknown_method, not bad_params', () => hub.mcpSend({ jsonrpc: '2.0', id: 1, method: 'nope', params: {} }), 'unknown_method');
}

// A tool that RAN and refused is a JSON-RPC SUCCESS carrying isError. If it were
// handed back as a field somebody must remember to check, the model-facing text
// would be silently dropped and the caller would read a failure as a result.
{
  const s = stubSession({
    handler: (p, opts) =>
      p === '/config'
        ? { body: { hub_prefix: '/hub' } }
        : {
            body: {
              jsonrpc: '2.0',
              id: opts.body.id,
              result: {
                isError: true,
                content: [{ type: 'text', text: 'sessionId is required' }],
                structuredContent: { error: { code: 'validation_error', message: 'sessionId is required' } },
              },
            },
          },
  });
  const hub = createHubClient(s.session);
  const err = await throws('isError is RAISED, so a caller cannot read it as success', () => hub.mcpTool('sessions_read', {}), 'validation_error');
  eq('and the readable reason is carried', err?.message, 'sessionId is required');
}

// A 204 is the hub's answer to a notification. Every call here sends an id, so a
// 204 is a protocol surprise — an empty object pretending to be a result is the
// one wrong answer that looks like a successful call.
{
  const s = stubSession({
    handler: (p, opts) => (p === '/config' ? { body: { hub_prefix: '/hub' } } : { status: 204, ok: true, body: null, text: '' }),
  });
  const hub = createHubClient(s.session);
  await throws('a 204 is named, not read as an empty result', () => hub.mcpTool('memory_read', {}), 'no_content');
}

{
  const s = stubSession({
    handler: (p, opts) => (p === '/config' ? { body: { hub_prefix: '/hub' } } : { status: 502, ok: false, text: '<html>bad gateway</html>' }),
  });
  const hub = createHubClient(s.session);
  await throws('a non-JSON transport failure is a transport error', () => hub.mcpTool('memory_read', {}), 'transport');
}

{
  const s = stubSession({
    handler: (p, opts) => (p === '/config' ? { body: { hub_prefix: '/hub' } } : { status: 200, ok: true, body: null, text: '' }),
  });
  const hub = createHubClient(s.session);
  await throws('an empty 200 body is bad_json, not a null result', () => hub.mcpTool('memory_read', {}), 'bad_json');
}

// An empty tool name is OUR mistake, so it must not cost a round trip.
{
  const s = stubSession();
  const hub = createHubClient(s.session);
  await throws('an empty tool name is refused', () => hub.mcpTool('', {}), 'bad_params');
  eq('without a single MCP call', s.mcpCalls().length, 0);
}
{
  const s = stubSession();
  const hub = createHubClient(s.session);
  await hub.mcpTool('memory_read', null);
  eq('a null arguments object becomes {}', s.mcpCalls().at(-1).body.params.arguments, {});
}

// ═══════════════════════════════════════════════════════════════════════════
section('F. a 401 retries EXACTLY ONCE, and only with forget() between');

{
  const s = stubSession({
    // 401 on the FIRST MCP call only, so the retry has something to succeed at.
    handler: (p, opts, n) =>
      p === '/config'
        ? { body: { hub_prefix: '/hub' } }
        : n <= 1
          ? { status: 401, ok: false, body: null, text: 'expired' }
          : defaultHub(p, opts),
  });
  const hub = createHubClient(s.session, { fetchPrefix: false });
  const { text } = await hub.mcpTool('memory_read', {});
  eq('a dead bearer recovers on the retry', text, 'ran memory_read');
  eq('the session was FORGOTTEN first, or the retry replays the dead token', s.session.forgotten, 1);
  eq('the retry happened exactly once, not in a loop', s.mcpCalls().length, 2);
  eq('and it did not open a second session to do it', s.logins(), 0);
}
{
  // 401 on BOTH attempts: the retry must give up rather than loop. A second
  // rotation against a single-use refresh family is what logs the app out.
  const s = stubSession({
    handler: (p) => (p === '/config' ? { body: { hub_prefix: '/hub' } } : { status: 401, ok: false, body: null, text: 'no' }),
  });
  const hub = createHubClient(s.session, { fetchPrefix: false });
  await throws('a 401 that survives the retry gives up', () => hub.mcpTool('memory_read', {}), 'transport');
  eq('after exactly two attempts', s.mcpCalls().length, 2);
  eq('and only one forget', s.session.forgotten, 1);
}
{
  // A tool-level refusal must NOT be retried: it consumes a refresh rotation and
  // cannot succeed, so a retry here is pure cost.
  const s = stubSession({
    handler: (p, opts) =>
      p === '/config'
        ? { body: { hub_prefix: '/hub' } }
        : { body: { jsonrpc: '2.0', id: opts.body.id, error: { code: -32000, message: 'tool refused' } } },
  });
  const hub = createHubClient(s.session, { fetchPrefix: false });
  await throws('a refusal is surfaced', () => hub.mcpTool('recall', { text: 'x' }), 'tool_refused');
  eq('and is NOT retried', s.mcpCalls().length, 1);
  eq('nor does it drop the session', s.session.forgotten || 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('G. the HTTP boundary still holds — this is why MCP is in-process');

assert('the /mcp path is on the blocked list', isBlockedHubPath('/mcp'));
assert('and so is a trailing form', isBlockedHubPath('/mcp/'));
assert('and a query form', isBlockedHubPath('/mcp?x=1'));
assert('a lookalike is NOT blocked', !isBlockedHubPath('/mcpx'));
assert('nor is a prefix lookalike', !isBlockedHubPath('/nope/mcp'));

{
  const s = stubSession();
  const hub = createHubClient(s.session);
  const r = await hub.call('POST', '/mcp', { body: {} });
  eq('the HTTP proxy refuses /mcp with 403', r.status, 403);
  eq('...with SCOPE_DENIED in the body', JSON.parse(r.text).code, 'SCOPE_DENIED');
  eq('and NOTHING was sent upstream', s.calls.length, 0);
}
{
  // ⭐ The two halves of the boundary, side by side: the same endpoint is
  // unreachable as a PATH and reachable as a TOOL. If this ever flips, the
  // app's data could reach MCP (or Jarvis could not reach it at all).
  const s = stubSession();
  const hub = createHubClient(s.session);
  const refused = await hub.call('POST', '/mcp', { body: {} });
  const allowed = await hub.mcpTool('memory_read', {});
  eq('path => refused', refused.status, 403);
  eq('tool => allowed', allowed.text, 'ran memory_read');
  eq('on the SAME shared session', s.mcpCalls().length, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('H. the agent surfaces have an MCP home, and the data ones do not');

// The agent's todo/docs/notes tools have NO MCP twin, which is exactly why they
// must ride the REST routes instead. Asserted as a fact rather than a comment.
for (const kind of ['todo', 'docs', 'notes']) {
  const anyTool = Object.keys(HUB_MCP_TOOLS).some((n) => n.startsWith(kind));
  assert(`the ${kind} agent tool has no MCP twin (so it must use REST)`, !anyTool);
}
// And what MCP DOES offer the agent loop:
for (const need of ['memory_read', 'memory_write', 'recall', 'sessions_read', 'sessions_list', 'ledger_read']) {
  assert(`MCP DOES offer ${need}`, need in HUB_MCP_TOOLS);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}  —  ${checks} checks`);
process.exit(fail === 0 ? 0 : 1);
