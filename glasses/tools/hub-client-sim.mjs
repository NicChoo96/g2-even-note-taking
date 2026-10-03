// Verifies the HUB CLIENT's rules, by bundling the real module (no
// re-implementation) and driving it against a scripted hub. No network, no
// relay, no backend.
//
// Run: node tools/hub-client-sim.mjs        (from `glasses/`)
//      SIM_QUIET=1 node tools/hub-client-sim.mjs
//
// WHY THIS IS WORTH A HARNESS
//   `src/web/hub-client.ts` owns four things that are all silently wrong when
//   they are wrong, and none of them are visible by eye:
//     • `rev` — a write token that must come from the SERVER's response, must
//       never go backwards, and on a 409 has to be re-read from `details.rev`
//       (NOT `details.current.rev`, which is always null — the published spec
//       gets this wrong).
//     • `Idempotency-Key` — must be a CANONICAL uuid v4 with hyphens, and must
//       be REUSED across a retry. A fresh key on retry double-applies the write.
//     • the bodiless `204` — reading `.json()` on it throws on a delete that
//       actually succeeded.
//     • the two error ENVELOPES — the hub puts a STRING in `error` with a `code`
//       beside it; the gateway nests an OBJECT. Reading `body.error.code` on a
//       hub reply yields undefined and the UI shows a bare "HTTP 409".
//   Each of those gets an explicit assertion below, negative cases included.

import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// SIM_QUIET=1 prints only failures and the verdict.
const QUIET = !!process.env.SIM_QUIET;
let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  if (ok && QUIET) return;
  if (ok) console.log(`PASS  ${label}`);
  else
    console.log(
      `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`,
    );
}

function assert(label, cond, detail = '') {
  if (cond) pass++;
  else fail++;
  if (cond && QUIET) return;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

// ── The scripted hub ────────────────────────────────────────────────────────
// `calls` is the ledger of everything the client actually sent; `scripted` is
// keyed by `METHOD path` and consumed front-to-back.
const calls = [];
const scripted = new Map();

function script(key, ...replies) {
  scripted.set(key, replies.slice());
}

/** One canned reply. `bodiless` marks a response whose body must NOT be read. */
const reply = (status, body, headers = {}, bodiless = false) => ({ status, body, headers, bodiless });

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const path = `${u.pathname}${u.search}`;
    const rel = u.pathname.replace(/^\/api\/hub/, '') + u.search;
    const record = {
      url: String(url),
      path,
      rel,
      method,
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      bodyRead: false,
    };
    calls.push(record);

    const lookup = scripted.get(`${method} ${rel}`) ?? scripted.get(`${method} ${rel.split('?')[0]}`);
    const next = lookup?.shift();
    // An unscripted call is a harness bug, so it fails loudly rather than
    // looking like a plain backend error the client handled correctly.
    const spec = next ?? reply(599, { ok: false, error: `UNSCRIPTED ${method} ${rel}`, code: 'UNSCRIPTED' });

    return {
      status: spec.status,
      ok: spec.status >= 200 && spec.status < 300,
      headers: {
        get: (k) => {
          const key = String(k).toLowerCase();
          for (const [hk, hv] of Object.entries(spec.headers)) {
            if (hk.toLowerCase() === key) return hv;
          }
          return null;
        },
      },
      text: async () => {
        record.bodyRead = true;
        return spec.body === undefined ? '' : JSON.stringify(spec.body);
      },
      // `fetchHubConfig` is the one call that reads `res.json()` directly rather
      // than going through `hubRequest`, so the stub has to offer both.
      json: async () => {
        record.bodyRead = true;
        return spec.body ?? null;
      },
    };
  };
}

// ── Bundle the real module ──────────────────────────────────────────────────
// The relay base is injected through `import.meta.env`, exactly as
// `stream-mux-sim.mjs` does, because `stream.ts` derives `API_BASE` from
// `VITE_HUB_STREAM_URL` and a relative base is not a URL `fetch` can take.
const out = mkdtempSync(join(tmpdir(), 'hub-client-sim-'));
const outfile = join(out, 'hub.mjs');
await build({
  stdin: {
    // One bundle, so the harness and the client share ONE auth-token instance
    // and therefore one stream credential.
    contents: `
export * from './web/hub-client.ts';
export { setStreamToken, onAuthRejected } from './auth-token.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  define: {
    'import.meta.env': JSON.stringify({
      VITE_HUB_STREAM_URL: 'http://relay.test/api/stream?channel=hub',
    }),
  },
});

stubFetch();
const hub = await import(pathToFileURL(outfile).href);

const { setStreamToken, onAuthRejected } = hub;
setStreamToken('test-token');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE = 'http://relay.test/api/hub';

/** A monotonically rising rev, so `noteRev`'s forward-only rule is never faked. */
let R = 100;
const nextRev = () => ++R;

const hubSnapshot = (over = {}) => ({
  activeSection: 'todo',
  activeDocId: null,
  sections: { todo: [], docs: [], files: [], notes: '' },
  updatedAt: 7,
  ...over,
});

const todoItem = (over = {}) => ({ id: 't1', text: 'buy milk', done: false, ...over });

console.log('hub-client contract\n');

// ── 1. URL, auth header, and no key on a read ───────────────────────────────
{
  calls.length = 0;
  const rev = nextRev();
  script('GET /todos', reply(200, { ok: true, rev, items: [] }));
  const res = await hub.fetchTodos();

  check('GET /todos is addressed under /api/hub', calls[0]?.url, `${BASE}/todos`);
  check('the bearer is attached from the stream credential', calls[0]?.headers.Authorization, 'Bearer test-token');
  check('a GET carries no Idempotency-Key', calls[0]?.headers['Idempotency-Key'], undefined);
  check('a GET with no body carries no Content-Type', calls[0]?.headers['Content-Type'], undefined);
  assert('a read success reports ok', res.ok === true);
  check('the rev from the response is adopted', res.rev, rev);
}

// ── 2. No credential means no Authorization header (not an empty one) ───────
{
  calls.length = 0;
  script('GET /todos', reply(200, { ok: true, rev: nextRev(), items: [] }));
  setStreamToken(null);
  await hub.fetchTodos();
  check('no credential sends no Authorization header', calls[0]?.headers.Authorization, undefined);
  setStreamToken('test-token');
}

// ── 3. A create: 201, a canonical uuid key, and the rev from the RESPONSE ───
{
  calls.length = 0;
  const rev = nextRev();
  script('POST /todos', reply(201, { ok: true, rev, updatedAt: 1, item: todoItem() }));
  const before = hub.currentRev();
  const res = await hub.createTodo('buy milk');

  check('a create is a POST to /todos', calls[0]?.method, 'POST');
  assert('a create sends JSON', calls[0]?.headers['Content-Type'] === 'application/json');
  assert('the Idempotency-Key is a canonical uuid v4 (hyphens included)', UUID_V4.test(String(calls[0]?.headers['Idempotency-Key'])), String(calls[0]?.headers['Idempotency-Key']));
  check('a create stamps the cached rev into the body', typeof calls[0]?.body?.rev, 'number');
  assert('the rev advanced from the response, not by counting', res.rev === rev && rev > before);
  check('the created item is returned', res.item, todoItem());
  assert('a create reports ok', res.ok === true && res.duplicate === false);
  // The typed wrappers carry `status` only on a failure; `hubRequest` carries it
  // always, which is what the 204 assertions below exercise.
  check('a typed wrapper does not pretend to carry a status', res.status, undefined);
}

// ── 4. A replay is a SUCCESS, in the body and in the header ─────────────────
{
  calls.length = 0;
  script('POST /todos', reply(200, { ok: true, Duplicate: true, rev: nextRev(), item: todoItem() }));
  const viaBody = await hub.createTodo('buy milk');
  assert('Duplicate:true in the body reads as duplicate', viaBody.duplicate === true);
  assert('a replayed write is still ok', viaBody.ok === true);

  calls.length = 0;
  script('POST /todos', reply(200, { ok: true, rev: nextRev(), item: todoItem() }, { duplicate: 'true' }));
  const viaHeader = await hub.createTodo('buy milk');
  assert('duplicate:true in the header reads as duplicate', viaHeader.duplicate === true);
}

// ── 5. STALE_REV: adopt `details.rev` and retry once — SAME key ─────────────
{
  calls.length = 0;
  const stale = nextRev();
  const fresh = nextRev();
  let sawStale = null;
  const off = hub.onStaleState((s) => {
    sawStale = s;
  });
  script(
    'POST /todos',
    reply(409, {
      ok: false,
      error: 'rev is stale',
      code: 'STALE_REV',
      // The server's shape: the rev is a SIBLING of `current`, and `current` is
      // the hub state with NO rev of its own. The published spec calls this "a
      // complete GET /hub body"; it is not.
      details: { rev: fresh, given: stale, current: hubSnapshot({ updatedAt: 7 }) },
    }),
    reply(201, { ok: true, rev: fresh, item: todoItem() }),
  );
  const res = await hub.createTodo('buy milk');
  off();

  check('a stale rev is retried exactly once', calls.length, 2);
  check('the retry sends the SAME Idempotency-Key', calls[1]?.headers['Idempotency-Key'], calls[0]?.headers['Idempotency-Key']);
  check('the retry uses details.rev, not details.current.rev', calls[1]?.body?.rev, fresh);
  assert('the retried write succeeds', res.ok === true && res.item.id === 't1');
  check('the authoritative rev is adopted', hub.currentRev(), fresh);
  assert('the 409 hands the caller the current state', sawStale?.updatedAt === 7);
}

// ── 6. STALE_REV with NO rev stamped is NOT retried ─────────────────────────
// Only a request that carried a rev can be fixed by a new rev; retrying an
// unguarded write would just repeat a validation failure.
{
  calls.length = 0;
  script('POST /todos', reply(409, { ok: false, error: 'stale', code: 'STALE_REV', details: { rev: nextRev() } }));
  const res = await hub.hubRequest('POST', '/todos', { body: { text: 'x' } });
  check('an unguarded 409 is not retried', calls.length, 1);
  assert('and the failure is surfaced', res.ok === false && res.code === 'STALE_REV');
}

// ── 7. STALE_REV retries a BOUNDED number of times (no infinite loop) ───────
// More than one retry is required, not optional: `rev` is a single per-user
// token, and a `204` (a delete) returns no rev and no ETag at all, so a delete
// leaves the client provably stale. A hub that keeps refusing therefore has to
// be retried a few times — and then reported, never looped on forever.
{
  calls.length = 0;
  const a = nextRev();
  const staleReply = (n) =>
    reply(409, { ok: false, error: 'stale', code: 'STALE_REV', details: { rev: a + n, current: hubSnapshot() } });
  script('POST /todos', staleReply(0), staleReply(1), staleReply(2), staleReply(3));
  const res = await hub.createTodo('buy milk');
  check('a persistently stale hub is retried four times in total', calls.length, 4);
  check('…all with the same Idempotency-Key', calls.every((c) => c.headers['Idempotency-Key'] === calls[0].headers['Idempotency-Key']), true);
  check(
    '…each carrying the rev the refusal before it handed back',
    calls.map((c) => c.body.rev),
    [calls[0].body.rev, a, a + 1, a + 2],
  );
  assert('and then reports the failure', res.ok === false && res.code === 'STALE_REV');
}

// ── 7b. A burst in one tick is SERIALISED, not fired in parallel ────────────
// `rev` is ONE per-user token, so two writes carrying the same rev cannot both
// be accepted: N writes issued in one tick are N-1 guaranteed refusals, and a
// retry budget alone does not save the overflow. The observable proof of
// serialisation is the request bodies — each write carries the rev its
// PREDECESSOR's response handed back, which is only possible if the second
// write waited for the first to resolve.
{
  calls.length = 0;
  const before = hub.currentRev();
  script(
    'POST /todos',
    reply(201, { ok: true, rev: before + 1, item: todoItem() }),
    reply(201, { ok: true, rev: before + 2, item: todoItem() }),
    reply(201, { ok: true, rev: before + 3, item: todoItem() }),
  );
  const [a, b, c] = await Promise.all([hub.createTodo('one'), hub.createTodo('two'), hub.createTodo('three')]);
  check('three writes issued in one tick all went out', calls.length, 3);
  check(
    '…and each carried the rev its predecessor returned',
    calls.map((x) => x.body.rev),
    [before, before + 1, before + 2],
  );
  check('…with three distinct Idempotency-Keys', new Set(calls.map((x) => x.headers['Idempotency-Key'])).size, 3);
  assert('…and all three succeeded', a.ok === true && b.ok === true && c.ok === true);
}

// ── 8. A missing rev is surfaced, not invented ──────────────────────────────
{
  calls.length = 0;
  script('POST /todos', reply(400, { ok: false, error: 'rev is required', code: 'REV_REQUIRED' }));
  const res = await hub.createTodo('buy milk');
  assert('REV_REQUIRED surfaces with its code', res.ok === false && res.code === 'REV_REQUIRED');
  check('and with the server’s message', res.error, 'rev is required');
}

// ── 9. A bad key is passed through and its refusal surfaces ─────────────────
// The client must never BUILD one of these; the point is that a caller can and
// that the refusal is legible.
{
  calls.length = 0;
  const hex = 'deadbeefdeadbeefdeadbeefdeadbeef';
  script(
    'POST /todos',
    reply(400, { ok: false, error: 'Idempotency-Key must be a uuid v4', code: 'VALIDATION_ERROR', details: { header: 'Idempotency-Key' } }),
  );
  const res = await hub.hubRequest('POST', '/todos', { body: { text: 'x' }, rev: true, key: hex });
  check('a caller-supplied key is sent verbatim', calls[0]?.headers['Idempotency-Key'], hex);
  assert('a non-uuid key surfaces VALIDATION_ERROR', res.ok === false && res.code === 'VALIDATION_ERROR');
  check('the failure detail is preserved', res.details, { header: 'Idempotency-Key' });
}

// ── 10. A 204 is bodiless: read nothing, succeed ────────────────────────────
{
  calls.length = 0;
  script('DELETE /todos/t1', reply(204, undefined, {}, true));
  const res = await hub.deleteTodo('t1');
  assert('a 204 is a success', res.ok === true && res.status === 204);
  check('a 204 yields no data', res.data, null);
  assert('a 204 body is never read', calls[0]?.bodyRead === false);
  check('a delete carries a rev', typeof calls[0]?.body?.rev, 'number');
}

// ── 11. No response at all is an ordinary failure, not a throw ──────────────
{
  calls.length = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  let threw = false;
  let res = null;
  try {
    res = await hub.fetchTodos();
  } catch {
    threw = true;
  }
  globalThis.fetch = real;
  assert('a dead network does not throw', threw === false);
  assert('and is reported as a failure with status 0', res?.ok === false && res?.status === 0);
  check('with the transport message', res?.error, 'fetch failed');
}

// ── 12. A 401 tells the auth UI the credential is gone ──────────────────────
{
  calls.length = 0;
  let rejected = 0;
  const off = onAuthRejected(() => {
    rejected += 1;
  });
  script('GET /todos', reply(401, { ok: false, error: 'no credential', code: 'NO_CREDENTIAL' }));
  const res = await hub.fetchTodos();
  off();
  assert('a 401 notifies auth rejection', rejected === 1);
  assert('and is surfaced as a failure', res.ok === false && res.code === 'NO_CREDENTIAL');
}

// ── 13. The two envelopes: hub `error` is a string, gateway `error` an object ─
{
  calls.length = 0;
  script('GET /todos', reply(403, { ok: false, error: 'this route requires the owner credential', code: 'SCOPE_DENIED', details: { route: '/diag' } }));
  const hubErr = await hub.fetchTodos();
  check('a hub error is read from the top level', hubErr.error, 'this route requires the owner credential');
  check('its code is read from `code`, not `error.code`', hubErr.code, 'SCOPE_DENIED');
  check('its details survive', hubErr.details, { route: '/diag' });

  calls.length = 0;
  script('GET /todos', reply(500, { error: { code: 'INTERNAL', message: 'boom', detail: 'trace' } }));
  const gwErr = await hub.fetchTodos();
  check('a gateway error is read from inside `error`', gwErr.error, 'boom');
  check('and its code comes from the nested object', gwErr.code, 'INTERNAL');

  calls.length = 0;
  script('GET /todos', reply(502, undefined));
  const bare = await hub.fetchTodos();
  assert('a non-JSON failure still reports', bare.ok === false && bare.error === 'HTTP 502');
}

// ── 14. The rev only ever moves FORWARD ─────────────────────────────────────
// Responses can arrive out of order over one SSE channel; a backwards rev would
// fail a write that would otherwise have succeeded.
{
  calls.length = 0;
  // The harness counter is not an upper bound on the client's cached rev — a
  // scripted reply greater than it is the only way to move the cache forward.
  const high = Math.max(nextRev(), hub.currentRev() + 1);
  script('GET /todos', reply(200, { ok: true, rev: high, items: [] }));
  await hub.fetchTodos();
  calls.length = 0;
  script('GET /todos', reply(200, { ok: true, rev: high - 50, items: [] }));
  await hub.fetchTodos();
  check('a lower rev does not lower the cache', hub.currentRev(), high);

  calls.length = 0;
  script('GET /todos', reply(200, { ok: true, items: [] }));
  await hub.fetchTodos();
  check('a response with no rev leaves it alone', hub.currentRev(), high);
}

// ── 15. Reads normalise what the hub sends ─────────────────────────────────
{
  calls.length = 0;
  const rev = nextRev();
  script(
    'GET /todos',
    reply(200, {
      ok: true,
      rev,
      items: [todoItem(), { id: 'bad' }, null, todoItem({ id: 't2', text: 'eggs', done: true })],
    }),
  );
  const res = await hub.fetchTodos();
  check('junk rows are dropped from a todo list', res.items.map((t) => t.id), ['t1', 't2']);
}

// ── 16. Docs: the list omits content unless it was asked for ────────────────
{
  calls.length = 0;
  const rev = nextRev();
  script('GET /docs', reply(200, { ok: true, rev, includeContent: false, items: [{ id: 'd1', title: 'First', updatedAt: 1 }] }));
  const list = await hub.fetchDocs();
  check('a docs list asks for metadata only', calls[0]?.rel, '/docs');
  assert('and the items carry NO content key', list.items[0]?.content === undefined);

  calls.length = 0;
  script('GET /docs?include=content', reply(200, { ok: true, rev, items: [{ id: 'd1', title: 'First', content: 'body', updatedAt: 1 }] }));
  const full = await hub.fetchDocs({ includeContent: true });
  check('content is requested explicitly', calls[0]?.rel, '/docs?include=content');
  check('and comes back when asked for', full.items[0]?.content, 'body');
}

// ── 17. fetchHub normalises a partial snapshot instead of trusting it ───────
{
  calls.length = 0;
  const rev = nextRev();
  script(
    'GET ',
    reply(200, {
      ok: true,
      rev,
      hub: {
        sections: {
          todo: [todoItem(), { bogus: true }],
          docs: [{ id: 'd1', title: 'First', content: 'c', updatedAt: 1 }],
          notes: 'n',
        },
      },
    }),
  );
  const res = await hub.fetchHub();
  check('the snapshot filters junk todos', res.hub.sections.todo.map((t) => t.id), ['t1']);
  check('a missing activeSection defaults', res.hub.activeSection, 'todo');
  check('a missing activeDocId defaults to null', res.hub.activeDocId, null);
  check('missing files becomes an empty list', res.hub.sections.files, []);
  check('notes survive', res.hub.sections.notes, 'n');
  check('docs survive', res.hub.sections.docs.map((d) => d.id), ['d1']);

  calls.length = 0;
  script('GET ', reply(200, { ok: true, rev: nextRev() }));
  const empty = await hub.fetchHub();
  assert('an empty hub does not throw', empty.ok === true);
  check('and yields empty sections', empty.hub.sections, { todo: [], docs: [], files: [], notes: '' });
}

// ── 18. Docs: the etag guard is sent, and its 412 is legible ────────────────
{
  calls.length = 0;
  const rev = nextRev();
  script('PUT /docs/d1', reply(412, { ok: false, error: 'the document has moved', code: 'IF_MATCH_FAILED', details: { current: { id: 'd1', title: 'First' } } }));
  const res = await hub.updateDocContent('d1', 'new body', { etag: 'W/"7:abc"' });
  check('the etag is sent as If-Match', calls[0]?.headers['If-Match'], 'W/"7:abc"');
  assert('an etag mismatch surfaces IF_MATCH_FAILED', res.ok === false && res.code === 'IF_MATCH_FAILED');
  check('and the body is still sent', calls[0]?.body?.content, 'new body');
  check('a 412 is not retried', calls.length, 1);

  calls.length = 0;
  script('PUT /docs/d1', reply(200, { ok: true, rev }));
  await hub.updateDocContent('d1', 'x');
  check('no If-Match is sent when no etag is known', calls[0]?.headers['If-Match'], undefined);
}

// ── 18b. The doc READ hands over the etag the WRITE needs ──────────────────
// `PUT /hub/docs/{id}` is guarded by `If-Match`, so a read that drops the ETag
// leaves the caller no way to save the body it just fetched: the hub answers
// `412 IF_MATCH_REQUIRED` and the edit is lost with no error anywhere in the UI.
// The server sends the value QUOTED (verified live) and the quotes are part of
// it, like an `Idempotency-Key`'s hyphens.
{
  calls.length = 0;
  const rev = nextRev();
  const ETAG = '"1790181965349:6fb413f8af3cb497"';
  script('GET /docs/d1', reply(200, { ok: true, rev, doc: { id: 'd1', title: 'First', content: 'body', updatedAt: 1 } }, { etag: ETAG }));
  const read = await hub.fetchDoc('d1');
  assert('fetchDoc reports ok', read.ok === true);
  check('fetchDoc returns the body', read.doc?.content, 'body');
  check('fetchDoc carries the ETag out of the header', read.etag, ETAG);

  // The real contract: whatever the read handed back is what the write sends.
  calls.length = 0;
  script('PUT /docs/d1', reply(200, { ok: true, rev, doc: { id: 'd1', title: 'First', updatedAt: 2 } }, { etag: '"1790181969000:beef"' }));
  const wrote = await hub.updateDocContent('d1', read.doc?.content, { etag: read.etag });
  check('the read etag is echoed verbatim as If-Match', calls[0]?.headers['If-Match'], ETAG);
  assert('and the write succeeds', wrote.ok === true);
  check('the write returns the NEXT etag', wrote.etag, '"1790181969000:beef"');

  calls.length = 0;
  script('GET /docs/nope', reply(404, { ok: false, error: 'no such document', code: 'NOT_FOUND' }));
  const missing = await hub.fetchDoc('nope');
  assert('a missing doc is a legible failure, not a silent null', missing.ok === false && missing.code === 'NOT_FOUND');
  check('and still carries no doc', missing.doc, null);
}

// ── 19. The control plane sends only what it was given ─────────────────────
{
  calls.length = 0;
  const rev = nextRev();
  script('PATCH ', reply(200, { ok: true, rev, hub: hubSnapshot({ activeSection: 'docs', activeDocId: 'd9' }) }));
  const res = await hub.patchHub({ activeSection: 'docs', activeDocId: 'd9' });
  check('PATCH /hub targets the hub root', calls[0]?.rel, '');
  check('only the named fields are sent', Object.keys(calls[0]?.body ?? {}).sort(), ['activeDocId', 'activeSection', 'rev']);
  assert('and the new snapshot is returned', res.ok === true && res.hub.activeDocId === 'd9');

  calls.length = 0;
  script('POST /notes/append', reply(200, { ok: true, rev, content: 'a\nb' }));
  const notes = await hub.appendNotes('b');
  check('append targets the append route', calls[0]?.rel, '/notes/append');
  check('and sends the text, not the whole note', calls[0]?.body?.text, 'b');
  check('returning the merged content', notes.content, 'a\nb');
}

// ── 20. Config: where the hub actually lives ───────────────────────────────
{
  calls.length = 0;
  script('GET /config', reply(200, { ok: true, hubPrefix: '/hub' }));
  const cfg = await hub.fetchHubConfig();
  check('config is read from the relay', calls[0]?.url, `${BASE}/config`);
  assert('config reports ok', cfg.ok === true);
  check('and names the prefix', cfg.hubPrefix, '/hub');

  calls.length = 0;
  script('GET /config', reply(501, { ok: false, error: 'no gateway credential', code: 'NOT_CONFIGURED' }));
  const none = await hub.fetchHubConfig();
  assert('an unconfigured relay is reported, not thrown', none.ok === false && none.code === 'NOT_CONFIGURED');
}

// ── 21. Docs: create → rename → delete route correctly ─────────────────────
{
  calls.length = 0;
  const rev = nextRev();
  script(
    'POST /docs',
    reply(201, { ok: true, rev, doc: { id: 'dNEW', title: 'Untitled', updatedAt: 2 } }),
  );
  script('PATCH /docs/dNEW', reply(200, { ok: true, rev, doc: { id: 'dNEW', title: 'Renamed', updatedAt: 3 } }));
  script('DELETE /docs/dNEW', reply(204, undefined, {}, true));

  const created = await hub.createDoc('Untitled', '');
  const renamed = await hub.renameDoc('dNEW', 'Renamed');
  const removed = await hub.deleteDoc('dNEW');

  assert('a created doc comes back', created.ok === true && created.doc?.id === 'dNEW');
  check('a rename returns the new title', renamed.doc?.title, 'Renamed');
  assert('a delete is a bodiless success', removed.ok === true && removed.status === 204);
  check('the three routes are distinct', calls.map((c) => `${c.method} ${c.rel}`), [
    'POST /docs',
    'PATCH /docs/dNEW',
    'DELETE /docs/dNEW',
  ]);
  assert('a rename is metadata-only (no content in the body)', !('content' in (calls[1]?.body ?? {})));
}

// ── verdict ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? 'RESULT FAILURES PRESENT' : 'RESULT ALL PASS');
process.exit(fail ? 1 : 0);
