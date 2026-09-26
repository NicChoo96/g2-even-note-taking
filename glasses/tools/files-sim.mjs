#!/usr/bin/env node
// Jarvis document-store harness (the `jarvis_files` tool).
//
// WHY THIS EXISTS:
//   This is the only module in the app that talks to a system we do NOT own,
//   over a protocol we did not design, holding a credential that can be revoked
//   by a mistake we cannot see: the refresh token ROTATES on every renewal, and
//   replaying a consumed one revokes the WHOLE session family. So the failures
//   worth a test are not "does list work" — they are the ones that go wrong
//   quietly, once, in production:
//
//     • a login race: two concurrent calls on a cold client both logging in,
//       orphaning the first refresh token
//     • a retry that eats a rotation and buys nothing (`-32601` is a NAME
//       problem, never a token one)
//     • a renewal that is not adopted before the next request
//     • the document BODY leaking into the model's tool message, or into state
//     • a body proxied to a sandboxed frame WITHOUT the sandbox
//
//   Everything below drives the real client against a stubbed fetch and a
//   scripted gateway, so a request that should not happen fails the count.
//
// Run: node tools/files-sim.mjs

import {
  DEFAULT_AGENT,
  FILES_KIND,
  FILES_TOOL_ID,
  FILES_TOOL_NAME,
  MAX_HTML_BYTES,
  MEDIA_MAX,
  RENEW_SKEW_MS,
  LIST_MAX_LIMIT,
  LIST_MAX_PAGES,
  RESULT_CHARS,
  SANDBOX_CSP,
  compactDoc,
  compactList,
  createFilesClient,
  extractMedia,
  filesConfig,
  filesToolSchema,
  htmlResponseHeaders,
  isFilesTool,
  isHtmlish,
  normalizeBaseUrl,
  renderToolResult,
} from '../../web/server/jarvis-files.mjs';
import {
  DOC_TICKET_TTL_MS,
  docCsp,
  docFrameUrl,
  docResponseHeaders,
  docTicketFromPath,
  signDocTicket,
  verifyDocTicket,
} from '../../web/server/doc-origin.mjs';
import { readFileSync } from 'node:fs';

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

const BASE = 'http://167.172.77.136';

// ── A scripted gateway ──────────────────────────────────────────────────────
// Responses are scripted per REQUEST, so "this request never happened" is a
// count assertion rather than a log inspection. The signal is honoured because
// the client's timeout path depends on fetch rejecting with AbortError.
function stubFetch(handler) {
  const calls = [];
  const impl = (url, init = {}) =>
    new Promise((resolve, reject) => {
      const full = String(url);
      const path = full.slice(BASE.length);
      const rec = {
        url: full,
        path,
        method: (init.method || 'GET').toUpperCase(),
        headers: init.headers || {},
        body: init.body ? JSON.parse(init.body) : undefined,
        signal: init.signal,
      };
      calls.push(rec);
      const sig = init.signal;
      if (sig) {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (sig.aborted) return onAbort();
        sig.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve()
        .then(() => handler(rec, calls))
        .then((r = {}) => {
          const status = r.status ?? 200;
          const text = typeof r.text === 'string' ? r.text : r.json === undefined ? '' : JSON.stringify(r.json);
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers: new Headers(r.headers || {}),
            text: async () => text,
          });
        }, reject);
    });
  return { impl, calls };
}

const loginOk = (over = {}) => ({
  json: {
    access_token: 'at-1',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor((Date.now() + 3600_000) / 1000),
    refresh_token: 'rt-1',
    session_id: 'sess-1',
    subject: 'mcp-client',
    scopes: ['content:read', 'content:write'],
    ...over,
  },
});
const mcpOk = (structured = {}) => ({
  json: { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: structured } },
});
const mcpRpcError = (code, message) => ({ json: { jsonrpc: '2.0', id: 1, error: { code, message } } });
const mcpToolError = (error, text = '') => ({
  json: {
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: true,
      content: text ? [{ type: 'text', text }] : [],
      structuredContent: { error },
    },
  },
});
/** Records the requests and answers from a queue; queued-out steps succeed. */
function scripted(steps) {
  const s = stubFetch(() => steps.shift() ?? mcpOk({}));
  return s;
}

const clientFor = (stub, opts = {}) =>
  createFilesClient({ fetchImpl: stub.impl, baseUrl: BASE, username: 'mcp-client', password: 'pw', ...opts });

// ── 1. Module surface ───────────────────────────────────────────────────────
console.log('\n§1  module surface');
eq('kind is "files"', FILES_KIND, 'files');
eq('tool id', FILES_TOOL_ID, 'tool-files');
eq('tool name the model sees', FILES_TOOL_NAME, 'jarvis_files');
eq('default author', DEFAULT_AGENT, 'g2-hub');
eq('the gateway ceiling is 4 MiB', MAX_HTML_BYTES, 4 * 1024 * 1024);
eq('renewal skew', RENEW_SKEW_MS, 120_000);
eq('list carries its own bounds', [LIST_MAX_LIMIT, LIST_MAX_PAGES], [200, 10]);

assert("kind 'files' is a files tool", isFilesTool({ kind: 'files' }));
assert("kind 'http' is not", !isFilesTool({ kind: 'http' }));
assert("kind 'web' is not", !isFilesTool({ kind: 'web' }));
assert("the legacy 'tavily' kind is not", !isFilesTool({ kind: 'tavily' }));
assert('undefined/null are not', !isFilesTool(undefined) && !isFilesTool(null));
assert('a kind-less tool is not', !isFilesTool({ id: FILES_TOOL_ID }));

console.log('\n§1b  normalizeBaseUrl');
eq('a trailing slash is stripped', normalizeBaseUrl(`${BASE}/`), BASE);
eq('many trailing slashes are stripped', normalizeBaseUrl(`${BASE}///`), BASE);
eq('whitespace is trimmed', normalizeBaseUrl(`  ${BASE}  `), BASE);
eq('https is allowed', normalizeBaseUrl('https://x.test'), 'https://x.test');
eq('a non-http scheme is refused outright', normalizeBaseUrl('ftp://167.172.77.136'), '');
eq('so is a scheme-less host', normalizeBaseUrl('167.172.77.136'), '');
eq('empty stays empty', normalizeBaseUrl('   '), '');

// ── 2. filesConfig precedence ───────────────────────────────────────────────
console.log('\n§2  filesConfig');
const envOnly = filesConfig({ JARVIS_FILE_USER: 'u', JARVIS_FILE_PWD: 'p' });
eq('env user/password configure it', [envOnly.username, envOnly.password, envOnly.configured], ['u', 'p', true]);
eq('an unset URL falls back to the gateway default', envOnly.url, BASE);
eq('…and is reported as a default, not a setting', envOnly.source.url, 'default');
eq('the hint names both variables', envOnly.hintVar.includes('JARVIS_FILE_USER'), true);

const saved = filesConfig({}, { filesUser: 'saved-u', filesPwd: 'saved-p', filesUrl: 'https://s.test/' });
eq('a saved setting wins over the env', [saved.username, saved.password], ['saved-u', 'saved-p']);
eq('…and its trailing slash is still stripped', saved.url, 'https://s.test');
eq('…and the source is reported as settings', saved.source.user, 'settings');

const mixed = filesConfig({ JARVIS_FILE_USER: 'env-u', JARVIS_FILE_PWD: 'env-p' }, { filesPwd: 'saved-p' });
eq('precedence is PER FIELD', [mixed.username, mixed.password], ['env-u', 'saved-p']);

const keyed = filesConfig({ JARVIS_FILE_API_KEY: 'jvk_1', JARVIS_FILE_USER: 'u', JARVIS_FILE_PWD: 'p' });
eq('an API key is preferred mode', keyed.apiKey, 'jvk_1');
eq('…but the pair is still carried for a fallback', [keyed.username, keyed.password], ['u', 'p']);
eq('no credentials at all is not configured', filesConfig({}).configured, false);
eq('a legacy alias still works', filesConfig({ JARVIS_USERNAME: 'lu' }).username, 'lu');
eq('a bad saved URL is not adopted as a usable base', filesConfig({}, { filesUrl: 'nope' }).url, '');

// ── 3. compactDoc — the ONE shape this app ever stores ──────────────────────
console.log('\n§3  compactDoc never carries a body');
const record = {
  id: 'a'.repeat(32),
  title: '  Weekly report  ',
  agent: 'analyst',
  slug: 'weekly-report',
  tags: Array.from({ length: 15 }, (_, i) => `t${i}`),
  version: 3,
  size: 1234,
  updated_at: '2024-05-06T07:08:09.000Z',
  html_url: `/sessions/${'a'.repeat(32)}/html`,
  html: '<h1>the whole document</h1>',
  deleted: false,
};
const doc = compactDoc(record, BASE);
eq('the title is trimmed', doc.title, 'Weekly report');
eq('the tags are capped at 12', doc.tags.length, 12);
eq('version and size are numeric', [doc.version, doc.size], [3, 1234]);
eq('updated_at is turned into an instant', doc.updatedAt, Date.parse('2024-05-06T07:08:09.000Z'));
eq('the relative html_url is made absolute', doc.url, `${BASE}/sessions/${'a'.repeat(32)}/html`);
eq('the id survives verbatim', doc.id, 'a'.repeat(32));
lacks('…and there is NO html field', JSON.stringify(doc), 'the whole document');
assert('…and no html key at all', doc.html === undefined);

assert('a record with no id is not a document', compactDoc({ title: 'x' }) === null);
assert('a non-object is not a document', compactDoc(null) === null);
eq('a missing title is labelled, not blank', compactDoc({ id: 'z' }).title, 'Untitled');
eq('a missing html_url is derived from the id', compactDoc({ id: 'z' }, BASE).url, `${BASE}/sessions/z/html`);
eq('an unparseable date still yields an instant', Number.isFinite(compactDoc({ id: 'z', updated_at: 'nope' }).updatedAt), true);
eq('a deleted flag is kept as a boolean', compactDoc({ id: 'z', deleted: 1 }).deleted, true);
eq('no base URL leaves the path relative', compactDoc({ id: 'z' }).url, '/sessions/z/html');

// Deletion provenance: what makes a restore list informative rather than a bare
// set of greyed-out titles.
const gone = compactDoc(
  {
    id: 'z',
    deleted: true,
    deleted_at: '2024-05-06T07:08:09.000Z',
    deleted_reason: 'deleted by mcp client',
  },
  BASE,
);
eq('a deleted document records WHEN', gone.deletedAt, Date.parse('2024-05-06T07:08:09.000Z'));
eq('…and WHY', gone.deletedReason, 'deleted by mcp client');
eq('a live document records no deletion time', doc.deletedAt, null);
eq('…and no reason', doc.deletedReason, '');
eq('an unparseable deleted_at is null, not NaN', compactDoc({ id: 'z', deleted: true, deleted_at: 'nope' }).deletedAt, null);

const pageIn = {
  items: [record, { id: 'b' }, null],
  total: 99,
  has_more: true,
  next_offset: 20,
};
const page = compactList(pageIn, BASE);
eq('a page maps its items', page.items.length, 2);
eq('…dropping the unusable ones', page.items.every((d) => d.id), true);
eq('the envelope is carried through', [page.total, page.hasMore, page.nextOffset], [99, true, 20]);
eq('count stands in for total when absent', compactList({ items: [], count: 7 }).total, 7);

// ── 4. renderToolResult — what the MODEL reads ──────────────────────────────
console.log('\n§4  renderToolResult never carries a body');
const listed = renderToolResult('list_sessions', page);
has('a list is numbered', listed, '1. Weekly report [analyst]');
has('…with the id, so the model can act on it', listed, 'a'.repeat(32));
has('…and the tags', listed, '#t0 #t1');
has('…and says when there is more', listed, 'more available');
lacks('…and NOT the document body', listed, 'the whole document');
assert('an empty list says so plainly', renderToolResult('list_sessions', { items: [], total: 0 }).includes('No documents'));

const published = renderToolResult('create_session', doc);
has('a publish confirms the id', published, doc.id);
has('…and points at where it is read', published, 'Files page');
lacks('…and never the body', published, 'the whole document');

has('a soft delete says it is restorable', renderToolResult('delete_session', doc), 'recoverable');
has('…and names where it is restored', renderToolResult('delete_session', doc), 'Files page');
has('a hard delete says the bytes are gone', renderToolResult('delete_session', { ...doc, hard: true }), 'Permanently deleted');
has('…and that it cannot come back', renderToolResult('delete_session', { ...doc, hard: true }), 'cannot be restored');
lacks('a soft delete never claims permanence', renderToolResult('delete_session', doc), 'cannot be restored');
lacks('a hard delete never claims recoverability', renderToolResult('delete_session', { ...doc, hard: true }), 'recoverable');
has('an update names the version', renderToolResult('update_session', doc), 'v3');
assert('a result with no document still answers', renderToolResult('list_sessions', null).length > 0);

const huge = renderToolResult('list_sessions', {
  items: Array.from({ length: 200 }, (_, i) => ({ ...doc, id: `${i}`.padStart(32, '0'), title: 'x'.repeat(200), tags: [] })),
  total: 200,
});
assert('a huge list is clipped to the result budget', huge.length <= RESULT_CHARS + 1, String(huge.length));
assert('…and says it was clipped', huge.endsWith('…'));

// ── 5. isHtmlish — the 422 guard ────────────────────────────────────────────
console.log('\n§5  isHtmlish');
for (const html of ['<!doctype html><p>x</p>', '<html><body>x', '<div>x</div>', '<H1>x', '<script>x</script>', '<svg/>']) {
  assert(`looks like HTML: ${html.slice(0, 18)}`, isHtmlish(html));
}
for (const not of ['hello world', '', 'a > b', '2 < 3', '# Heading']) {
  assert(`does not: ${JSON.stringify(not)}`, !isHtmlish(not));
}

// ── 6. The sandbox the relay serves a body under ────────────────────────────
console.log('\n§6  htmlResponseHeaders');
const headers = htmlResponseHeaders();
has('the frame is sandboxed', headers['Content-Security-Policy'], 'sandbox allow-scripts');
has('…with no network at all', headers['Content-Security-Policy'], "default-src 'none'");
assert('…and NOT with allow-same-origin (that would hand it our origin)', !headers['Content-Security-Policy'].includes('allow-same-origin'));
has('…inline script is kept (generated reports chart)', headers['Content-Security-Policy'], "script-src 'unsafe-inline'");
has('…forms are closed', headers['Content-Security-Policy'], "form-action 'none'");
eq('only our own origin may frame it', headers['X-Frame-Options'], 'SAMEORIGIN');
eq('the type cannot be sniffed', headers['X-Content-Type-Options'], 'nosniff');
lacks('no referrer leaks to the gateway', headers['Referrer-Policy'], 'unsafe');
has('nothing is cached', headers['Cache-Control'], 'no-store');
eq('the policy is one join, not a hand-built string', SANDBOX_CSP.split('; ').length, 9);

// ── 6b. extractMedia — the videos in a document ─────────────────────────────
//
// This is the ONE feature that reads the document body, so the tests that
// matter are not "does it find a video" but "can the BODY influence what the
// panel loads". A document is model-authored code; every URL the panel plays
// must be rebuilt from an id, never passed through.
console.log('\n§6b  extractMedia');
{
  // Every shape a model actually writes, including the escaped separator that a
  // hand-built tag produces, plus one exact duplicate.
  const doc = [
    '<iframe src="https://www.youtube.com/embed/O7he_E-H8Xg?si=OYEun4uzfanT6vM0"></iframe>',
    '<iframe src="https://www.youtube-nocookie.com/embed/BZbC3NpgVfM"></iframe>',
    '<iframe src="https://m.youtube.com/watch?v=dBFm3zm_3l8&amp;t=42s"></iframe>',
    '<a href="https://youtu.be/DdCEmlAydcw">short form</a>',
    "<a href='https://www.youtube.com/shorts/m35NljDbPTI'>shorts</a>",
    '<iframe src="https://www.youtube.com/embed/O7he_E-H8Xg"></iframe>',
  ].join('\n');
  const found = extractMedia(doc);
  eq('every embed shape is found, the duplicate collapses', found.length, 5);
  eq(
    '…and they come back in document order',
    found.map((v) => v.id),
    ['O7he_E-H8Xg', 'BZbC3NpgVfM', 'dBFm3zm_3l8', 'DdCEmlAydcw', 'm35NljDbPTI'],
  );
  eq('the provider is named', found[0].provider, 'youtube');
  eq('…and labelled for the button', found[0].label, 'YouTube');
  eq('the `?si=` tracking param never reaches the id', found[0].id, 'O7he_E-H8Xg');
  eq(
    'the thumbnail is built from the id alone',
    found[0].thumb,
    'https://i.ytimg.com/vi/O7he_E-H8Xg/hqdefault.jpg',
  );
  has('the embed is the no-cookie host', found[0].embed, 'youtube-nocookie.com/embed/O7he_E-H8Xg');
  eq(
    '…and the watch link is the real page',
    found[0].watch,
    'https://www.youtube.com/watch?v=O7he_E-H8Xg',
  );

  // ── the rule that makes reading a body safe ──
  const hostile = [
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
    '<a href="https://evil.example/watch?v=O7he_E-H8Xg">decoy</a>',
    '<iframe src="//evil.example/embed/O7he_E-H8Xg"></iframe>',
    '<a href="/watch?v=O7he_E-H8Xg">relative</a>',
    '<iframe src="https://www.youtube.com.evil.example/watch?v=O7he_E-H8Xg"></iframe>',
    '<iframe src="https://www.youtube.com/embed/TOOSHORT"></iframe>',
  ].join('\n');
  eq('a body cannot inject a URL into the player', extractMedia(hostile).length, 0);

  const ids = Array.from({ length: 80 }, (_, i) => `vid${i}`.padEnd(11, 'x'));
  const flood = ids
    .map((id) => `<iframe src="https://www.youtube.com/embed/${id}"></iframe>`)
    .join('\n');
  eq('a flood is capped so one body cannot fill the panel', extractMedia(flood).length, MEDIA_MAX);

  eq('a document with no videos says so with an empty list', extractMedia('<p>prose</p>'), []);
  eq('an empty body is safe', extractMedia(''), []);
  eq('…and so is a missing one', extractMedia(null), []);
}

// ── 7. The client: lazy login, one session, one request shape ──────────────
console.log('\n§7  the client');
{
  const stub = scripted([loginOk(), mcpOk({ items: [], total: 0 })]);
  const client = clientFor(stub);
  eq('constructing a client makes NO request', stub.calls.length, 0);
  assert('…and reports itself configured', client.configured);
  eq('…in password mode', client.state.mode, 'password');
  eq('…unauthenticated', client.state.authenticated, false);
  assert('…and never exposes a token', !JSON.stringify(client.state).includes('at-1'));

  await client.list();
  eq('the first call logs in', stub.calls[0].path, '/auth/login');
  eq('…by POST', stub.calls[0].method, 'POST');
  eq('…with the configured pair', [stub.calls[0].body.username, stub.calls[0].body.password], ['mcp-client', 'pw']);
  eq('…sending no bearer', stub.calls[0].headers.Authorization, undefined);
  eq('…and a JSON content type', stub.calls[0].headers['Content-Type'], 'application/json');

  eq('then it calls MCP', stub.calls[1].path, '/mcp');
  eq('…with the access token', stub.calls[1].headers.Authorization, 'Bearer at-1');
  eq('…as JSON-RPC 2.0', stub.calls[1].body.jsonrpc, '2.0');
  eq('…method tools/call', stub.calls[1].body.method, 'tools/call');
  eq('…naming the tool', stub.calls[1].body.params.name, 'list_sessions');
  eq('…with a default page size', stub.calls[1].body.params.arguments.limit, 20);

  eq('the pair is adopted', [client.state.subject, client.state.scopes.join(',')], ['mcp-client', 'content:read,content:write']);
  assert('…and the session reads as authenticated', client.state.authenticated);
  assert('…with a positive lifetime', client.state.expiresInSeconds > 3000, String(client.state.expiresInSeconds));

  await client.list();
  eq('a live token is reused, not re-fetched', stub.calls.filter((c) => c.path === '/auth/login').length, 1);
  eq('…so the second call is one request', stub.calls.length, 3);
}

console.log('\n§7b  expires_at beats expires_in');
{
  const at = Date.now() + 7200_000;
  const stub = scripted([loginOk({ expires_at: Math.floor(at / 1000), expires_in: 5 }), mcpOk({})]);
  const client = clientFor(stub);
  await client.list();
  assert('an ABSOLUTE expiry is preferred (a slow reply cannot shorten it)', client.state.expiresInSeconds > 7000, String(client.state.expiresInSeconds));
}
{
  const at = Date.now() + 7200_000;
  const stub = scripted([loginOk({ expires_at: at, expires_in: 5 }), mcpOk({})]);
  const client = clientFor(stub);
  await client.list();
  assert('a millisecond-style expiry is not multiplied again', client.state.expiresInSeconds > 7000, String(client.state.expiresInSeconds));
}
{
  const stub = scripted([loginOk({ expires_at: undefined, expires_in: 900 }), mcpOk({})]);
  const client = clientFor(stub);
  await client.list();
  assert('…and expires_in still works alone', client.state.expiresInSeconds > 800, String(client.state.expiresInSeconds));
}

console.log('\n§7c  one login per process, whatever the concurrency');
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const stub = stubFetch(async (c) => {
    if (c.path === '/auth/login') {
      await gate;
      return loginOk();
    }
    return mcpOk({ items: [] });
  });
  const client = clientFor(stub);
  const all = Promise.all([client.list(), client.list(), client.list()]);
  release();
  await all;
  eq('three cold calls make ONE login (no orphaned refresh token)', stub.calls.filter((c) => c.path === '/auth/login').length, 1);
  eq('…and each gets its own MCP call', stub.calls.filter((c) => c.path === '/mcp').length, 3);
}

// ── 8. Auth failures: retry once, or not at all ─────────────────────────────
console.log('\n§8  auth failures');
{
  const stub = scripted([
    loginOk({ access_token: 'at-1', refresh_token: 'rt-1' }),
    mcpRpcError(-32001, 'authentication required'),
    loginOk({ access_token: 'at-2', refresh_token: 'rt-2' }),
    mcpOk({ items: [], total: 0 }),
  ]);
  const client = clientFor(stub);
  const r = await client.list();
  eq('a -32001 is retried exactly once', stub.calls.length, 4);
  eq('…by logging in again, not refreshing', stub.calls.filter((c) => c.path === '/auth/login').length, 2);
  eq('…and the retry carries the NEW token', stub.calls[3].headers.Authorization, 'Bearer at-2');
  eq('…and the call succeeds', r.items.length, 0);
  const later = await client.list();
  eq('…proving the retry left a GOOD session, not another login', stub.calls.filter((c) => c.path === '/auth/login').length, 2);
  eq('…which keeps working', later.items.length, 0);
}
{
  const stub = scripted([loginOk(), mcpRpcError(-32601, 'no such tool')]);
  const client = clientFor(stub);
  const err = await throws('a wrong tool NAME is not retried', () => client.list(), 'unknown_tool');
  eq('…exactly one MCP call', stub.calls.filter((c) => c.path === '/mcp').length, 1);
  eq('…and no second login (a rotation would buy nothing)', stub.calls.filter((c) => c.path === '/auth/login').length, 1);
  has('…and the gateway wording survives', err.message, 'no such tool');
}
{
  const stub = scripted([loginOk(), mcpRpcError(-32602, 'bad params')]);
  const client = clientFor(stub);
  await throws('invalid params is not retried either', () => client.list(), 'jsonrpc_-32602');
  eq('…one MCP call', stub.calls.filter((c) => c.path === '/mcp').length, 1);
}
{
  const stub = scripted([loginOk(), mcpRpcError(-32002, 'missing scope')]);
  const client = clientFor(stub);
  await throws('a scope denial is reported as a scope problem', () => client.list(), 'insufficient_scope');
  eq('…and is not retried', stub.calls.filter((c) => c.path === '/mcp').length, 1);
}
{
  const stub = scripted([
    loginOk({ access_token: 'at-1' }),
    { status: 401, json: { error: { code: 'token_expired', message: 'expired' } } },
    loginOk({ access_token: 'at-2' }),
    mcpOk({ ok: true }),
  ]);
  const client = clientFor(stub);
  await client.list();
  eq('a transport 401 IS retried once', stub.calls.length, 4);
  eq('…after a fresh login', stub.calls[2].path, '/auth/login');
  eq('…with the new token', stub.calls[3].headers.Authorization, 'Bearer at-2');
}
{
  const stub = scripted([{ status: 500, json: { error: { code: 'internal', message: 'boom' } } }]);
  const client = clientFor(stub);
  const err = await throws('a 5xx is surfaced, not swallowed', () => client.list(), 'internal');
  eq('…with the status on it', err.status, 500);
  eq('…and is not retried', stub.calls.length, 1);
}

console.log('\n§8b  the nested REST envelope');
{
  const stub = scripted([{ status: 401, json: { code: 'invalid_credentials', message: 'top-level' } }]);
  const err = await throws('a top-level code is NOT trusted (the spec is wrong here)', () => clientFor(stub).list(), 'invalid_credentials');
  eq('…the code falls back rather than reading the wrong place', err.code, 'invalid_credentials');
  const stub2 = scripted([{ status: 401, json: { message: 'no envelope at all' } }]);
  const err2 = await throws('…and a body with no envelope still names something', () => clientFor(stub2).list(), 'invalid_credentials');
  has('…the message it found', err2.message, 'no envelope');
}
{
  const stub = scripted([loginOk(), mcpToolError({ code: 'not_found', message: 'no such document', detail: { id: 'x' } })]);
  const client = clientFor(stub);
  const err = await throws('an in-band tool error is an error', () => client.list(), 'not_found');
  eq('…with its own message', err.message, 'no such document');
  eq('…and its detail', err.detail, { id: 'x' });
  eq('…carried on a 200, because that is what the gateway sends', err.transportStatus, 200);
  eq('…while the relay is told 404, so a missing document is not a bad gateway', err.status, 404);
  eq('…and the session it took is still usable', stub.calls.length, 2);
}
{
  const stub = scripted([loginOk(), mcpToolError({}, 'the operation failed badly')]);
  const err = await throws('an error with no code is still an error', () => clientFor(stub).list(), 'tool_error');
  has('…and falls back to the text block', err.message, 'operation failed badly');
}
{
  const stub = scripted([loginOk(), { json: { jsonrpc: '2.0', id: 1 } }]);
  await throws('a result-less reply is an error, not a silent success', () => clientFor(stub).list(), 'empty_result');
}

console.log('\n§8c  transport failures');
{
  const hanging = stubFetch(() => new Promise(() => {}));
  const client = createFilesClient({ fetchImpl: hanging.impl, baseUrl: BASE, username: 'u', password: 'p', timeoutMs: 30 });
  await throws('a gateway that never answers times out', () => client.list(), 'timeout');
}
{
  const stalling = stubFetch(() => new Promise(() => {}));
  const client = createFilesClient({ fetchImpl: stalling.impl, baseUrl: BASE, username: 'u', password: 'p' });
  const ac = new AbortController();
  const p = client.list({ signal: ac.signal });
  ac.abort();
  const err = await throws('a caller abort is told apart from a timeout', () => p, 'aborted');
  eq('…and carries no gateway status', err.status, 0);
}
{
  const broken = stubFetch(() => { throw new TypeError('fetch failed'); });
  await throws('a dead socket is a network error', () => clientFor(broken).list(), 'network');
}
{
  const noCreds = createFilesClient({ fetchImpl: stubFetch(() => mcpOk({})).impl, baseUrl: BASE });
  eq('no credentials is not configured', noCreds.configured, false);
  const stub = stubFetch(() => mcpOk({}));
  const c = createFilesClient({ fetchImpl: stub.impl, baseUrl: BASE });
  await throws('…and a call says exactly what to set', () => c.list(), 'not_configured');
  eq('…without touching the network', stub.calls.length, 0);
}
{
  const stub = stubFetch(() => mcpOk({}));
  const c = createFilesClient({ fetchImpl: stub.impl, baseUrl: 'ftp://x.test', username: 'u', password: 'p' });
  await throws('an unusable base URL fails by name, not deep inside fetch', () => c.list(), 'bad_base_url');
  eq('…before any request', stub.calls.length, 0);
}

// ── 9. Rotation: the trap the whole design exists for ──────────────────────
console.log('\n§9  token rotation');
{
  // The clock is injected, because the point of a proactive renewal is what
  // happens as a token AGES. A token minted just now is always used as-is —
  // rotating it would burn a rotation to gain nothing.
  let clock = 1_700_000_000_000;
  let n = 1;
  const stub = stubFetch((c) => {
    if (c.path === '/auth/login') return loginOk({ access_token: 'at-1', refresh_token: 'rt-1', expires_at: undefined, expires_in: 300 });
    if (c.path === '/auth/refresh') {
      n += 1;
      return { json: { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 300 } };
    }
    return mcpOk({ items: [], total: 0 });
  });
  const client = createFilesClient({ fetchImpl: stub.impl, baseUrl: BASE, username: 'u', password: 'p', now: () => clock });

  await client.list();
  eq('a token minted just now is used as-is (no pointless rotation)', stub.calls.map((c) => c.path), ['/auth/login', '/mcp']);
  eq('…and the expiry it was told is the one it believes', client.state.expiresInSeconds, 300);

  clock += 190_000; // 300 s token, 120 s skew → inside the window
  await client.list();
  const refreshes = stub.calls.filter((c) => c.path === '/auth/refresh');
  eq('a token inside the skew window is renewed BEFORE it is used', stub.calls.map((c) => c.path), ['/auth/login', '/mcp', '/auth/refresh', '/mcp']);
  eq('…by POSTing the refresh token', refreshes[0].body.refresh_token, 'rt-1');
  eq('…never the bare token in a header', refreshes[0].headers.Authorization, undefined);
  eq('…and the NEW access token is what goes to MCP', stub.calls.at(-1).headers.Authorization, 'Bearer at-2');

  clock += 190_000;
  await client.list();
  const again = stub.calls.filter((c) => c.path === '/auth/refresh');
  eq('the rotated refresh token is adopted, not replayed', again[1].body.refresh_token, 'rt-2');
  eq('…so there are exactly two renewals', again.length, 2);
  eq('…and no extra login was needed', stub.calls.filter((c) => c.path === '/auth/login').length, 1);
}
{
  let renewals = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const stub = stubFetch(async (c) => {
    if (c.path === '/auth/login') return loginOk({ access_token: 'at-1', refresh_token: 'rt-1', expires_at: undefined, expires_in: 30 });
    if (c.path === '/auth/refresh') {
      renewals += 1;
      // Hold the renewal until all three callers are provably waiting on it.
      await gate;
      return { json: { access_token: `at-${renewals + 1}`, refresh_token: `rt-${renewals + 1}`, expires_in: 30 } };
    }
    return mcpOk({ items: [] });
  });
  const client = clientFor(stub);
  await client.list();
  eq('the setup call logged in and did NOT rotate (the token was new)', stub.calls.map((c) => c.path), ['/auth/login', '/mcp']);
  const all = Promise.all([client.list(), client.list(), client.list()]);
  release();
  await all;
  eq('concurrent calls share ONE renewal', stub.calls.filter((c) => c.path === '/auth/refresh').length, 1);
  eq('…and each still gets its own MCP call', stub.calls.filter((c) => c.path === '/mcp').length, 4);
}
{
  const stub = scripted([
    loginOk({ access_token: 'at-1', refresh_token: 'rt-1', expires_at: undefined, expires_in: 1 }),
    mcpOk({ items: [], total: 0 }),
    { status: 401, json: { error: { code: 'refresh_token_reuse', message: 'replayed' } } },
    loginOk({ access_token: 'at-2', refresh_token: 'rt-9' }),
    mcpOk({ items: [], total: 0 }),
  ]);
  const client = clientFor(stub);
  await client.list();
  await client.list();
  eq('a replayed refresh token is NOT replayed again', stub.calls.filter((c) => c.path === '/auth/refresh').length, 1);
  eq('…the dead session is dropped and re-established', stub.calls.map((c) => c.path), ['/auth/login', '/mcp', '/auth/refresh', '/auth/login', '/mcp']);
  eq('…and the new pair is adopted', stub.calls.at(-1).headers.Authorization, 'Bearer at-2');
}
{
  const stub = scripted([
    loginOk({ expires_at: undefined, expires_in: 1 }),
    mcpOk({ items: [], total: 0 }),
    { status: 503, json: { error: { code: 'unavailable', message: 'maintenance' } } },
  ]);
  const client = clientFor(stub);
  await client.list();
  const err = await throws('a FAILED renewal is not papered over as a re-login', () => client.list(), 'unavailable');
  eq('…with its status', err.status, 503);
  eq('…and one attempt only', stub.calls.filter((c) => c.path === '/auth/refresh').length, 1);
}

console.log('\n§9b  an API key has no session to rotate');
{
  const stub = stubFetch((c) => (c.path === '/mcp' ? mcpOk({ items: [], total: 0 }) : { status: 500, json: {} }));
  const client = createFilesClient({ fetchImpl: stub.impl, baseUrl: BASE, apiKey: 'jvk_secret' });
  await client.list();
  eq('a key sends no login', stub.calls.length, 1);
  eq('…and is used directly as the bearer', stub.calls[0].headers.Authorization, 'Bearer jvk_secret');
  eq('…in api_key mode', client.state.mode, 'api_key');
  assert('…with no expiry to renew', client.state.expiresInSeconds === null);
  eq('…and it never appears in state', JSON.stringify(client.state).includes('jvk_secret'), false);
}
{
  const stub = stubFetch(() => ({ status: 401, json: { error: { code: 'invalid_token', message: 'bad key' } } }));
  const client = createFilesClient({ fetchImpl: stub.impl, baseUrl: BASE, apiKey: 'jvk_bad' });
  const err = await throws('a 401 on a key fails immediately', () => client.list(), 'invalid_token');
  eq('…because re-logging in cannot fix a key', stub.calls.length, 1);
  eq('…and the status is kept', err.status, 401);
}

// ── 10. Operations map onto the gateway's arguments ─────────────────────────
console.log('\n§10  operations');
{
  const stub = scripted([loginOk(), mcpOk({ items: [] })]);
  const client = clientFor(stub);
  await client.list({ limit: 9999, offset: -5 });
  const args = stub.calls[1].body.params.arguments;
  eq('an absurd limit is clamped to the gateway max', args.limit, LIST_MAX_LIMIT);
  eq('a negative offset is floored', args.offset, 0);
}
{
  const stub = scripted([loginOk(), mcpOk({ items: [] })]);
  const client = clientFor(stub);
  await client.list({ limit: 5, offset: 20, q: 'budget', agent: 'g2-hub', tag: 'daily', order: 'oldest', includeDeleted: true });
  eq('every filter is forwarded under the gateway name', stub.calls[1].body.params.arguments, {
    limit: 5,
    offset: 20,
    agent: 'g2-hub',
    tag: 'daily',
    q: 'budget',
    order: 'oldest',
    include_deleted: true,
  });
}
{
  const pages = [
    { items: [{ id: '1' }, { id: '2' }], total: 5, has_more: true, next_offset: 2 },
    { items: [{ id: '3' }], total: 5, has_more: true, next_offset: 3 },
    { items: [{ id: '4' }], total: 5, has_more: false },
  ];
  const stub = stubFetch((c) => (c.path === '/auth/login' ? loginOk() : mcpOk(pages.shift() ?? { items: [] })));
  const client = clientFor(stub);
  const all = await client.listAll();
  eq('listAll walks every page', all.items.map((d) => d.id), ['1', '2', '3', '4']);
  eq('…and reports no more', all.hasMore, false);
  eq('…using the cursor the gateway sent', stub.calls[2].body.params.arguments.offset, 2);
}
{
  let n = 0;
  const stub = stubFetch((c) => {
    if (c.path === '/auth/login') return loginOk();
    n += 1;
    return mcpOk({ items: [{ id: String(n) }], total: 999, has_more: true, next_offset: 0 });
  });
  const client = clientFor(stub);
  const all = await client.listAll();
  eq('a stuck cursor cannot spin forever', stub.calls.filter((c) => c.path === '/mcp').length, 1);
  eq('…and the one page is returned', all.items.length, 1);
}
{
  let n = 0;
  const stub = stubFetch((c) => {
    if (c.path === '/auth/login') return loginOk();
    n += 1;
    return mcpOk({ items: [{ id: String(n) }], total: 999, has_more: true, next_offset: n });
  });
  const client = clientFor(stub);
  const all = await client.listAll();
  eq('…and a gateway that always says "more" is capped', stub.calls.filter((c) => c.path === '/mcp').length, LIST_MAX_PAGES);
  eq('…with every page collected', all.items.length, LIST_MAX_PAGES);
}

console.log('\n§10b  read');
{
  const stub = scripted([loginOk(), mcpOk(record)]);
  const client = clientFor(stub);
  const got = await client.read('a'.repeat(32));
  eq('read asks for the id', stub.calls[1].body.params.arguments.id, 'a'.repeat(32));
  eq('…and does not pull the body by default', stub.calls[1].body.params.arguments.include_html, false);
  assert('…so the result has no html', got.html === undefined);
  eq('…but every reference field', [got.id, got.title, got.url], ['a'.repeat(32), 'Weekly report', `${BASE}/sessions/${'a'.repeat(32)}/html`]);
}
{
  const stub = scripted([loginOk(), mcpOk(record)]);
  const client = clientFor(stub);
  const got = await client.read('a'.repeat(32), { includeHtml: true });
  eq('include_html is opt-in', stub.calls[1].body.params.arguments.include_html, true);
  eq('…and is the only way a body is returned', got.html, '<h1>the whole document</h1>');
}
{
  const stub = scripted([loginOk(), mcpOk({})]);
  await throws('read with no document is not_found', () => clientFor(stub).read('x'), 'not_found');
}

console.log('\n§10c  publish');
{
  const stub = scripted([loginOk(), mcpOk(record)]);
  const client = clientFor(stub);
  const out = await client.create({ html: '<h1>hi</h1>', title: 'T', tags: ['a'] });
  const args = stub.calls[1].body.params.arguments;
  eq('the tool name is create_session', stub.calls[1].body.params.name, 'create_session');
  eq('the body is sent', args.html, '<h1>hi</h1>');
  eq('the author defaults to us', args.agent, DEFAULT_AGENT);
  eq('real HTML needs no content_type', args.content_type, undefined);
  eq('no id means no overwrite flag', 'overwrite' in args, false);
  assert('…and the result is a reference, never the body', out.html === undefined);
}
{
  const stub = scripted([loginOk(), mcpOk(record)]);
  await clientFor(stub).create({ html: 'just a sentence about the week' });
  const args = stub.calls[1].body.params.arguments;
  eq('prose is declared text/plain, so the gateway does not 422 it', args.content_type, 'text/plain');
  eq('…and an absent title is simply omitted', 'title' in args, false);
}
{
  const stub = scripted([loginOk(), mcpOk(record)]);
  await clientFor(stub).create({ html: '<p>x</p>', contentType: 'application/xhtml+xml' });
  eq('an explicit content type wins over the guess', stub.calls[1].body.params.arguments.content_type, 'application/xhtml+xml');
}
{
  const id = 'c'.repeat(32);
  const stub = scripted([loginOk(), mcpOk(record)]);
  await clientFor(stub).create({ html: '<p>x</p>', id, overwrite: true, title: 'x'.repeat(400), tags: Array.from({ length: 20 }, (_, i) => `t${i}`), slug: 's'.repeat(300) });
  const args = stub.calls[1].body.params.arguments;
  eq('an id makes the publish idempotent', args.id, id);
  eq('…and overwrite is explicit', args.overwrite, true);
  eq('the title is capped at the gateway limit', args.title.length, 300);
  eq('the tags are capped at 12', args.tags.length, 12);
  eq('the slug is capped at 200', args.slug.length, 200);
}
{
  const stub = stubFetch(() => mcpOk(record));
  const client = clientFor(stub);
  await throws('an empty document is refused', () => client.create({ html: '   ' }), 'validation_error');
  await throws('…and so is a missing one', () => client.create({}), 'validation_error');
  eq('…without any request at all', stub.calls.length, 0);
}
{
  const huge = 'x'.repeat(MAX_HTML_BYTES + 1);
  const stub = stubFetch(() => mcpOk(record));
  const client = clientFor(stub);
  const err = await throws('a document over 4 MiB is refused before it is sent', () => client.create({ html: huge }), 'payload_too_large');
  has('…naming the limit', err.message, '4.0 MB');
  eq('…with no request', stub.calls.length, 0);
}
{
  const stub = scripted([loginOk(), mcpOk({ id: 'z' })]);
  await clientFor(stub).create({ html: '<p>x</p>' });
  eq('a create with no id returned is still a success', stub.calls.length, 2);
}

console.log('\n§10d  delete');
{
  const stub = scripted([loginOk(), mcpOk({ id: 'a'.repeat(32), deleted: true })]);
  const out = await clientFor(stub).remove('a'.repeat(32));
  const args = stub.calls[1].body.params.arguments;
  eq('the default delete is SOFT', 'hard' in args, false);
  eq('…and restorable', [out.hard, out.deleted], [false, true]);
}
{
  const stub = scripted([loginOk(), mcpOk({ id: 'a'.repeat(32), hard: true, deleted: true })]);
  const out = await clientFor(stub).remove('a'.repeat(32), { hard: true, reason: 'r'.repeat(500) });
  const args = stub.calls[1].body.params.arguments;
  eq('a hard delete purges the bytes', args.hard, true);
  eq('…and its reason is capped', args.reason.length, 200);
  eq('…and is reported as hard', out.hard, true);
}
{
  const stub = scripted([loginOk(), mcpOk({ id: 'a'.repeat(32), deleted: false })]);
  const out = await clientFor(stub).remove('a'.repeat(32));
  eq('a refusal to delete is not reported as success', out.deleted, false);
}

// ── 10d2. restore — the ONE operation the gateway has no MCP tool for ───────
// This is the whole point of the fix: a soft delete was advertised as
// restorable and there was no way to restore it, because `restore_session` does
// not exist and `restore_revision` does not undelete a session. The only route
// back is REST, so what matters is that the client takes that route and does not
// silently settle for a JSON-RPC error.
console.log('\n§10d2  restore (REST, because there is no MCP tool)');
{
  const restored = {
    id: 'a'.repeat(32),
    title: 'Weekly report',
    agent: 'analyst',
    size: 1234,
    version: 3,
    deleted: false,
    html_url: `/sessions/${'a'.repeat(32)}/html`,
  };
  const stub = scripted([loginOk(), { json: restored }]);
  const out = await clientFor(stub).restore('a'.repeat(32));
  eq('it goes to the REST path, not MCP', stub.calls[1].path, `/sessions/${'a'.repeat(32)}/restore`);
  eq('…as a POST', stub.calls[1].method, 'POST');
  eq('…with the session token', stub.calls[1].headers.Authorization, 'Bearer at-1');
  eq('…and NO JSON-RPC envelope', 'jsonrpc' in (stub.calls[1].body || {}), false);
  eq('it returns the restored document', [out.id, out.deleted], ['a'.repeat(32), false]);
  eq('…as full metadata, not a bare flag', out.title, 'Weekly report');
}
{
  const stub = scripted([loginOk(), { json: { id: 'x', deleted: false } }]);
  await clientFor(stub).restore('a b/c');
  eq('an awkward id is URL-encoded', stub.calls[1].path, '/sessions/a%20b%2Fc/restore');
}
{
  const stub = stubFetch((c) =>
    c.path === '/auth/login'
      ? loginOk()
      : { status: 404, json: { error: { code: 'not_found', message: 'document not found' } } },
  );
  const err = await throws('restoring a missing document is not_found', () => clientFor(stub).restore('gone'), 'not_found');
  eq('…and keeps the gateway status', err.status, 404);
}
{
  const stub = stubFetch((c) => (c.path === '/auth/login' ? loginOk() : { status: 500, json: { message: 'boom' } }));
  await throws('a gateway fault is not read as a successful restore', () => clientFor(stub).restore('x'), 'restore_failed');
}
{
  const stub = scripted([loginOk(), { json: {} }]);
  const out = await clientFor(stub).restore('a'.repeat(32));
  eq('a 200 with a body we cannot read still names the id back', out.id, 'a'.repeat(32));
}

// ── 10f. not_found is a 404, never a 502 ────────────────────────────────────
// The relay maps a FilesError's `status` straight onto the HTTP response, and a
// bare JSON-RPC tool error arrives over HTTP 200 — so a missing document used to
// surface as "502 bad gateway", which tells the app the SERVICE is broken when
// the document is simply gone (a soft delete reads exactly the same way).
console.log('\n§10f  a missing document is a 404, not a 502');
{
  const stub = scripted([loginOk(), mcpToolError({ code: 'not_found', message: 'document not found' })]);
  const err = await throws(
    'a missing or soft-deleted document reads as not_found',
    () => clientFor(stub).read('a'.repeat(32)),
    'not_found',
  );
  eq('…and is reported as 404', err.status, 404);
}
{
  const stub = scripted([loginOk(), mcpToolError({ code: 'insufficient_scope', message: 'nope' })]);
  const err = await throws('a scope denial keeps its own code', () => clientFor(stub).read('x'), 'insufficient_scope');
  eq('…and is NOT dressed up as a 404', err.status, 200);
}
{
  const stub = scripted([loginOk(), mcpOk({ title: 'no id here' })]);
  const err = await throws('a record with no id is not_found', () => clientFor(stub).read('x'), 'not_found');
  eq('…also as a 404', err.status, 404);
}

console.log('\n§10e  body (the only reason the relay proxies at all)');
{
  const stub = stubFetch((c) =>
    c.path === '/auth/login'
      ? loginOk()
      : { text: '<h1>body</h1>', headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
  const client = clientFor(stub);
  const got = await client.body('a'.repeat(32));
  eq('it fetches the gateway html path, not MCP', stub.calls[1].path, `/sessions/${'a'.repeat(32)}/html`);
  eq('…with the session token', stub.calls[1].headers.Authorization, 'Bearer at-1');
  eq('…and returns the bytes', got.text, '<h1>body</h1>');
  eq('…with the gateway content type', got.contentType, 'text/html; charset=utf-8');
}
{
  const stub = stubFetch((c) => (c.path === '/auth/login' ? loginOk() : { text: 'x', headers: {} }));
  await clientFor(stub).body('a b/c');
  eq('an awkward id is URL-encoded', stub.calls[1].path, '/sessions/a%20b%2Fc/html');
}
{
  const stub = stubFetch((c) => (c.path === '/auth/login' ? loginOk() : { status: 404, text: 'no' }));
  await throws('a missing body is not_found', () => clientFor(stub).body('gone'), 'not_found');
  const stub2 = stubFetch((c) => (c.path === '/auth/login' ? loginOk() : { status: 500, text: 'boom' }));
  await throws('…and a gateway fault keeps its status', () => clientFor(stub2).body('x'), 'http_500');
}
{
  const stub = scripted([loginOk(), mcpOk({ sessions: 3 })]);
  const out = await clientFor(stub).stats();
  eq('stats calls its own tool', stub.calls[1].body.params.name, 'session_stats');
  eq('…with no arguments', stub.calls[1].body.params.arguments, {});
  eq('…and returns the payload', out.sessions, 3);
}

// ── 11. The tool schema the model writes against ────────────────────────────
console.log('\n§11  filesToolSchema');
{
  const s = filesToolSchema({});
  eq('the name defaults', s.function.name, FILES_TOOL_NAME);
  eq('it is an OpenAI-style function', s.type, 'function');
  // ONE tool, eleven actions. Not eleven tools: the client budget is 12 tools a
  // turn (MAX_TOOLS in agent.ts) and page navigation needs most of them, so a
  // second document tool would evict a page. The cost is that this enum is
  // hand-written, which is why §12 pins it to the fold.
  eq(
    'every action the gateway offers is offered here',
    s.function.parameters.properties.action.enum,
    [
      'publish', 'list', 'search', 'stats', 'read', 'update',
      'delete', 'history', 'revision', 'revert', 'revision_stats',
    ],
  );
  eq('only the action is required', s.function.parameters.required, ['action']);
  has('the description says the body is NOT returned', s.function.description, 'NOT returned');
  const custom = filesToolSchema({ name: 'my_files', description: 'custom' });
  eq('a tool-defined name wins', custom.function.name, 'my_files');
  eq('…and so does its description', custom.function.description, 'custom');
}

// ── 12. The relay wiring cannot drift ──────────────────────────────────────
console.log('\n§12  the relay is wired to this module');
{
  const relay = readFileSync(new URL('../../web/server/local-sse.mjs', import.meta.url), 'utf8');
  has('it imports the module', relay, "from './jarvis-files.mjs'");
  has('…and dispatches on the shared kind check', relay, 'isFilesTool(');
  has('…and builds the schema from here', relay, 'filesToolSchema(');
  has('…and serves the body under the module\'s headers', relay, 'htmlResponseHeaders()');
  lacks('…with no inline copy of the frame policy', relay, "'X-Frame-Options'");
  has('…and the HTML proxy route exists', relay, '/api/files/');
  has('…including the body route', relay, '/html$');
  has('…and the media route', relay, '/media$');
  has('…extracting through the module that owns the document contract', relay, 'extractMedia(');
  has('…and status', relay, '/api/files/status');
  lacks('…with no gateway credential baked into the relay', relay, 'JARVIS_FILE_PWD=');

  // THE TWO HAND-WRITTEN LISTS, PINNED TO EACH OTHER.
  //
  // The action enum lives in this module and the fold lives in the relay. Both
  // are typed by hand, three files apart, and each is individually plausible —
  // the fold merely lacking an entry means that action silently does nothing,
  // which is the failure this whole exercise started from. Deriving both from
  // the gateway would remove the class of bug; until then this is the assertion
  // that notices, because no single-file test can: an entry added to one and not
  // the other is only visible from outside both.
  {
    const at = relay.indexOf('const FILES_FOLD = {');
    const body = at < 0 ? '' : relay.slice(at, relay.indexOf('};', at));
    const folded = [...body.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
    eq(
      'the fold and the offered actions are the same set',
      [...folded].sort(),
      [...filesToolSchema({}).function.parameters.properties.action.enum].sort(),
      '(an action in the enum but not the fold is accepted by the model and then dropped)',
    );
  }

  // The panel is where the sandbox and the player meet, and the ONE way to
  // break video without breaking any server test is to sandbox the player too —
  // which is exactly what produced a blank box when this was tested. Pin both
  // halves so neither can be "hardened" back into not working.
  const panel = readFileSync(new URL('../src/web/FilesPanel.tsx', import.meta.url), 'utf8');
  // Pinned in its EXACT code form, not as the attribute text: the comments in
  // this file quote `sandbox="allow-scripts"` in prose, so an attribute-text
  // assertion would pass on a comment even if the frame lost its sandbox.
  has(
    'the document frame is sandboxed on our own origin',
    panel,
    "sandbox={docUrl ? undefined : 'allow-scripts'}",
  );
  lacks(
    '…and is never handed our origin',
    panel,
    'sandbox="allow-scripts allow-same-origin',
  );
  has(
    '…and only a real document origin drops it',
    panel,
    'src={docUrl || fileBodyUrl(active.id)}',
  );
  has('…a ticket that is asked of the relay', panel, 'fetchDocTicket(');
  has('the videos are asked of the relay', panel, 'fetchFileMedia(');
  has('…and played in this app\'s own DOM', panel, 'files-player-frame');
  has('…as a real cross-origin frame, not a sandboxed one', panel, 'allowFullScreen');

  const clientSrc = readFileSync(new URL('../../web/server/jarvis-files.mjs', import.meta.url), 'utf8');
  has('the gateway password is never logged or returned', clientSrc, 'hintVar');
  lacks('…no console.log of a token', clientSrc, 'console.log(accessToken');
}

// ── 13. The document origin: a ticket, and a frame with no sandbox ──────────
console.log('\n§13  a document can be served from an origin of its own');
{
  const SECRET = 'unit-test-secret';
  const at = 1_700_000_000_000;
  const expiry = at + DOC_TICKET_TTL_MS;

  const ticket = signDocTicket('doc-abc_123', { secret: SECRET, now: at });
  const parts = ticket.split('.');

  eq('a ticket is id, expiry and signature', parts.length, 3);
  eq('…the id comes back verbatim', parts[0], 'doc-abc_123');
  eq('…the expiry is now plus the TTL', Number(parts[1]), expiry);
  assert(
    '…and the whole thing is URL-path safe',
    /^[A-Za-z0-9_-]+\.[0-9]+\.[A-Za-z0-9_-]+$/.test(ticket),
    ticket,
  );

  const ok = verifyDocTicket(ticket, { secret: SECRET, now: at });
  eq('a fresh ticket verifies', [ok.ok, ok.id], [true, 'doc-abc_123']);
  eq('…and reports when it dies', ok.expiresAt, expiry);
  eq(
    'one millisecond before expiry it still works',
    verifyDocTicket(ticket, { secret: SECRET, now: expiry - 1 }).ok,
    true,
  );
  eq(
    'at expiry it is refused',
    verifyDocTicket(ticket, { secret: SECRET, now: expiry }),
    { ok: false, reason: 'expired' },
  );

  // The whole point of the ticket: a browser holding one cannot forge another,
  // and cannot widen this one to a different document.
  eq(
    'a different secret is refused',
    verifyDocTicket(ticket, { secret: 'not-the-secret', now: at }),
    { ok: false, reason: 'signature' },
  );
  eq('no secret is refused', verifyDocTicket(ticket, { now: at }), {
    ok: false,
    reason: 'signature',
  });
  const macB = signDocTicket('doc-other', { secret: SECRET, now: at }).split('.')[2];
  eq(
    'another document\'s signature does not open this one',
    verifyDocTicket(`${parts[0]}.${parts[1]}.${macB}`, { secret: SECRET, now: at }),
    { ok: false, reason: 'signature' },
  );
  // The expiry is signed as the TEXT it arrived as, so a padded form is not
  // quietly normalised into the value it looks like.
  eq(
    'a zero-padded expiry fails the signature, not the parse',
    verifyDocTicket(`${parts[0]}.0${parts[1]}.${parts[2]}`, { secret: SECRET, now: at }),
    { ok: false, reason: 'signature' },
  );

  for (const [label, bad] of [
    ['an empty string', ''],
    ['not a string', 42],
    ['two parts', 'a.b'],
    ['four parts', 'a.b.c.d'],
    ['a non-numeric expiry', 'doc-abc.zzz.sig'],
    ['no signature', 'doc-abc.123.'],
    ['an unusable id', 'has space.123.sig'],
    ['an oversized id', `${'a'.repeat(65)}.123.sig`],
    ['an absurdly long string', 'a'.repeat(600)],
    ['nothing at all', null],
  ]) {
    eq(`malformed is refused: ${label}`, verifyDocTicket(bad, { secret: SECRET, now: at }), {
      ok: false,
      reason: 'malformed',
    });
  }

  const refuse = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  assert(
    'minting refuses an id the relay would not serve',
    refuse(() => signDocTicket('has space', { secret: SECRET })),
  );
  assert('…and refuses to mint without a secret', refuse(() => signDocTicket('ok-id', {})));

  // ── The policy that replaces the sandbox ──────────────────────────────────
  const csp = docCsp('http://localhost:5198');
  has('the document policy names who may embed it', csp, 'frame-ancestors http://localhost:5198');
  lacks('…and carries NO sandbox directive at all', csp, 'sandbox');
  lacks('…so the document keeps a real origin', csp, 'allow-same-origin');
  has('…while nested frames a page embeds are allowed through', csp, "frame-src 'self' https: http:");
  has('…and inline scripts still run', csp, "script-src 'self' 'unsafe-inline'");
  has('…and it still refuses to be a form target', csp, "form-action 'none'");

  const headers = docResponseHeaders('https://app.example.com');
  has(
    'the response lets exactly that app frame it',
    headers['Content-Security-Policy'],
    'frame-ancestors https://app.example.com',
  );
  assert(
    '…and sends NO X-Frame-Options, which would blank the frame',
    !('X-Frame-Options' in headers),
    JSON.stringify(Object.keys(headers)),
  );
  eq('…it does not let the browser guess the type', headers['X-Content-Type-Options'], 'nosniff');
  eq(
    '…and a cross-origin subresource never learns the ticket in the path',
    headers['Referrer-Policy'],
    'strict-origin-when-cross-origin',
  );
  has('…and a document is never cached', headers['Cache-Control'], 'no-store');

  eq('the frame URL is origin + prefix + ticket', docFrameUrl('http://localhost:5199/', 'tkt'), 'http://localhost:5199/d/tkt');
  eq('…and a doubling slash does not survive', docFrameUrl('http://localhost:5199///', 'tkt'), 'http://localhost:5199/d/tkt');
  eq('…and an unusable origin is refused, not concatenated', docFrameUrl('not a url', 'tkt'), '/d/tkt');

  eq('the ticket is read out of the path', docTicketFromPath('/d/abc.123.sig'), 'abc.123.sig');
  eq('…a bare prefix is not a ticket', docTicketFromPath('/d/'), null);
  eq('…a deeper path is not a ticket', docTicketFromPath('/d/a/b'), null);
  eq('…and neither is any other route', docTicketFromPath('/api/files'), null);

  // ── The wiring cannot drift, and the safety argument still holds ─────────
  const relay = readFileSync(new URL('../../web/server/local-sse.mjs', import.meta.url), 'utf8');
  has('the relay imports the document origin', relay, "from './doc-origin.mjs'");
  has('…mints a ticket beside the body route', relay, '/ticket$');
  has('…drawing the policy from the module that owns it', relay, 'docResponseHeaders(');
  has('…verifying a ticket before it fetches anything', relay, 'verifyDocTicket(');
  has('…on a listener of its own', relay, 'startDocServer(');
  has('…and tells the app, so it can drop the sandbox', relay, 'docOrigin: DOCS_ORIGIN');
  // The ENTIRE safety argument for a second origin is that no ambient authority
  // exists to leak. That is true today only because this relay sets no cookie,
  // so a document served from the other host inherits nothing. If a cookie is
  // ever introduced, this assertion is what should stop the build.
  lacks('…and no cookie exists anywhere for a document to inherit', relay, 'Set-Cookie');
  lacks('…and the gateway credential stays out of the frame path', relay, 'JARVIS_FILE_PWD=');

  const filesClientSrc = readFileSync(new URL('../src/web/files-client.ts', import.meta.url), 'utf8');
  has('the browser asks the relay for a ticket, never builds one', filesClientSrc, '/ticket');
  lacks('…and holds no ticket secret', filesClientSrc, 'DOC_TICKET_SECRET');
  has('…and keeps the sandboxed proxy as the fallback', filesClientSrc, 'fileBodyUrl');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
