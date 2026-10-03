// Verifies the STORE's hub semantics, by bundling the real module (no
// re-implementation) and driving it against a small in-memory hub that mimics
// the real one's `rev`, `ETag` and idempotency rules. No network, no relay, no
// backend.
//
// Run: node tools/store-sim.mjs        (from `glasses/`)
//      SIM_QUIET=1 node tools/store-sim.mjs
//
// WHY THIS IS WORTH A HARNESS
//   `hub-client-sim.mjs` proves the TRANSPORT contract; nothing proved that
//   `src/store.ts` actually USES it correctly. Every rule below is silently
//   wrong when it is wrong — the UI still looks right:
//     • a local id never swapped for the server's → the next edit names an id
//       the hub has never heard of and the write 404s.
//     • an etag read but not kept → the save is refused with `412` and the edit
//       is lost. `GET /hub` carries NO per-document etags, so this is the
//       NORMAL first-save path, not an edge case.
//     • a debounce that does not collapse → one request per keystroke.
//     • `update()` standing in for a hub write → the change is painted and
//       never saved, which is strictly worse than the live-sync it replaced.
//     • adopting the server's whole snapshot from a control-plane `PATCH` → a
//       concurrent local edit is repainted away before it is ever sent.
//     • `restoreHub` replaying every document instead of only the ones that
//       differ → an undo rewrites the whole library.
//   A tiny REAL hub is used rather than canned strings because most of these
//   depend on state — the rev the client must send next, the etag it must echo
//   back — and canned replies cannot model that honestly.

import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

function section(name) {
  if (!QUIET) console.log(`\n── ${name} ──`);
}

// ── the fake clock the store's debounces run on ─────────────────────────────
// `debounce()` uses `window.setTimeout`, so the harness owns the timers and can
// run them on demand — which is what makes "3 keystrokes, 1 request" provable
// rather than a race against a real 400 ms wait.
let fakeNow = 1_700_000_000_000;
let timerSeq = 0;
const timers = new Map();

globalThis.window = {
  setTimeout: (fn, ms) => {
    const id = ++timerSeq;
    timers.set(id, { fn, at: fakeNow + (Number(ms) || 0) });
    return id;
  },
  clearTimeout: (id) => timers.delete(id),
};

/** Run every pending timer, earliest first. */
function flush() {
  let guard = 0;
  while (timers.size && guard++ < 50) {
    const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    fakeNow = t.at;
    t.fn();
  }
}

/** Let microtasks and the stubbed fetches settle. Uses the REAL timer. */
async function tick(n = 6) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

// ── localStorage, pre-seeded so the "cache paints first" path is exercised ──
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
  clear: () => ls.clear(),
};
ls.set(
  'hub:state',
  JSON.stringify({
    activeSection: 'docs',
    activeDocId: 'cached-doc-1',
    sections: {
      todo: [{ id: 'cached-todo-1', text: 'cached task', done: false }],
      docs: [{ id: 'cached-doc-1', title: 'Cached', content: 'from cache', updatedAt: 111 }],
      files: [],
      notes: 'cached notes',
    },
    updatedAt: 111,
  }),
);

// ── the mini hub ────────────────────────────────────────────────────────────
const calls = [];
let mode = 'hub'; // 'hub' | 'dead'
let nextFailure = null;
const patches = { emptyTodos: false, controlDropsTodos: false, alwaysStale: false };

const hub = {
  rev: 40,
  seq: 0,
  clock: 1_700_000_000_000,
  activeDocId: 'doc-1',
  activeSection: 'todo',
  todos: [{ id: 'todo-1', text: 'server task', done: false }],
  docs: new Map(),
  notes: 'server notes',
  applied: new Map(), // Idempotency-Key -> { sig, spec }
};

function touchDoc(d) {
  d.updatedAt = ++hub.clock;
  d.etag = `"${d.updatedAt}:n${++hub.seq}"`;
  hub.rev += 1;
}

function seedDoc(id, title, content) {
  const d = { id, title, content, updatedAt: ++hub.clock, etag: `"${hub.clock}:s${++hub.seq}"` };
  hub.docs.set(id, d);
  return d;
}

seedDoc('doc-1', 'First', 'first body');
seedDoc('doc-2', 'Second', 'second body');

const meta = (d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt });

function stateBody() {
  return {
    activeDocId: hub.activeDocId,
    activeSection: hub.activeSection,
    sections: {
      todo: hub.todos.map((t) => ({ ...t })),
      // `GET /hub` really does inline every body (63 KB across 19 documents) —
      // that is why it is a boot read and never a poll.
      docs: [...hub.docs.values()].map((d) => ({ id: d.id, title: d.title, content: d.content, updatedAt: d.updatedAt })),
      files: [],
      notes: hub.notes,
    },
    updatedAt: hub.clock,
  };
}

function controlBody() {
  const b = stateBody();
  if (patches.controlDropsTodos) b.sections.todo = [];
  return b;
}

const reply = (status, body, headers = {}, bodiless = false) => ({ status, body, headers, bodiless });
const bad = (status, error, code, details = {}) => reply(status, { ok: false, error, code, details });

/**
 * A `409` in the shape the SERVER really sends — verified live, and NOT what the
 * published document describes: the authoritative rev is a SIBLING of
 * `current` (`details.rev`), and `details.current` is the hub STATE only, with
 * no `ok` and no `rev`. The document claims `details.current` is "a complete
 * GET /hub body", which would make `details.current.rev` always null.
 */
const stale = (given) =>
  reply(409, {
    ok: false,
    error: 'rev is stale',
    code: 'STALE_REV',
    details: { current: stateBody(), given, rev: hub.rev },
  });

function header(headers, name) {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}

function route(method, rel, body, headers) {
  const rev = typeof body?.rev === 'number' ? body.rev : undefined;
  const requireRev = () => {
    if (rev === undefined) return bad(400, 'rev is required', 'REV_REQUIRED');
    // A hub that NEVER accepts our rev, so the retry budget can be proved finite.
    if (patches.alwaysStale) return stale(rev);
    if (rev !== hub.rev) return stale(rev);
    return null;
  };
  const bump = () => {
    hub.rev += 1;
    hub.clock += 1;
  };

  // ── control plane ──
  if (rel === '') {
    if (method === 'GET') return reply(200, { ok: true, rev: hub.rev, hub: stateBody() });
    if (method === 'PATCH') {
      const e = requireRev();
      if (e) return e;
      if ('activeDocId' in body) hub.activeDocId = body.activeDocId ?? null;
      if ('activeSection' in body) hub.activeSection = body.activeSection;
      bump();
      return reply(200, { ok: true, rev: hub.rev, hub: controlBody() });
    }
  }

  // ── todos ──
  if (rel === '/todos') {
    if (method === 'GET') return reply(200, { ok: true, rev: hub.rev, items: hub.todos.map((t) => ({ ...t })) });
    if (method === 'POST') {
      const e = requireRev();
      if (e) return e;
      const item = { id: `srv-todo-${++hub.seq}`, text: String(body.text ?? ''), done: false };
      hub.todos.push(item);
      bump();
      return reply(201, { ok: true, rev: hub.rev, item });
    }
    if (method === 'PUT') {
      const e = requireRev();
      if (e) return e;
      hub.todos = Array.isArray(body.items)
        ? body.items.map((t) => ({ id: String(t.id), text: String(t.text), done: !!t.done }))
        : [];
      bump();
      return reply(200, { ok: true, rev: hub.rev, items: patches.emptyTodos ? [] : hub.todos.map((t) => ({ ...t })) });
    }
  }
  if (rel === '/todos/reorder' && method === 'POST') {
    const e = requireRev();
    if (e) return e;
    const byId = new Map(hub.todos.map((t) => [t.id, t]));
    hub.todos = (Array.isArray(body.ids) ? body.ids : []).map((id) => byId.get(id)).filter(Boolean);
    bump();
    return reply(200, { ok: true, rev: hub.rev, items: patches.emptyTodos ? [] : hub.todos.map((t) => ({ ...t })) });
  }
  if (rel === '/todos/clear-done' && method === 'POST') {
    const e = requireRev();
    if (e) return e;
    hub.todos = hub.todos.filter((t) => !t.done);
    bump();
    return reply(200, { ok: true, rev: hub.rev, items: patches.emptyTodos ? [] : hub.todos.map((t) => ({ ...t })) });
  }
  if (rel.startsWith('/todos/')) {
    const id = decodeURIComponent(rel.slice('/todos/'.length));
    const i = hub.todos.findIndex((t) => t.id === id);
    if (i < 0) return bad(404, 'no such task', 'NOT_FOUND');
    if (method === 'PATCH') {
      const e = requireRev();
      if (e) return e;
      if (typeof body.done === 'boolean') hub.todos[i].done = body.done;
      if (typeof body.text === 'string') hub.todos[i].text = body.text;
      bump();
      return reply(200, { ok: true, rev: hub.rev, item: { ...hub.todos[i] } });
    }
    if (method === 'DELETE') {
      const e = requireRev();
      if (e) return e;
      hub.todos.splice(i, 1);
      bump();
      return reply(204, undefined, {}, true);
    }
  }

  // ── notes ──
  if (rel === '/notes') {
    if (method === 'GET') return reply(200, { ok: true, rev: hub.rev, content: hub.notes });
    if (method === 'PUT') {
      const e = requireRev();
      if (e) return e;
      hub.notes = String(body.content ?? '');
      bump();
      return reply(200, { ok: true, rev: hub.rev, content: hub.notes });
    }
  }
  if (rel === '/notes/append' && method === 'POST') {
    const e = requireRev();
    if (e) return e;
    const line = String(body.text ?? '');
    // The SERVER joins. That is the whole point of append over put.
    hub.notes = hub.notes ? `${hub.notes.replace(/\s+$/, '')}\n${line}` : line;
    bump();
    return reply(200, { ok: true, rev: hub.rev, content: hub.notes });
  }

  // ── docs ──
  if (rel.split('?')[0] === '/docs') {
    if (method === 'GET') {
      // Metadata only, exactly like the real list.
      return reply(200, { ok: true, rev: hub.rev, items: [...hub.docs.values()].map(meta) });
    }
    if (method === 'POST') {
      const e = requireRev();
      if (e) return e;
      const d = { id: `doc-${++hub.seq}`, title: String(body.title ?? 'Untitled'), content: String(body.content ?? ''), updatedAt: 0, etag: '' };
      touchDoc(d);
      hub.docs.set(d.id, d);
      return reply(201, { ok: true, rev: hub.rev, doc: { ...meta(d), content: d.content } }, { etag: d.etag });
    }
  }
  if (rel.startsWith('/docs/')) {
    const id = decodeURIComponent(rel.slice('/docs/'.length));
    const d = hub.docs.get(id);
    if (!d) return bad(404, 'no such document', 'NOT_FOUND');
    if (method === 'GET') {
      return reply(200, { ok: true, rev: hub.rev, doc: { ...meta(d), content: d.content } }, { etag: d.etag });
    }
    if (method === 'PATCH') {
      const e = requireRev();
      if (e) return e;
      if ('title' in body) d.title = String(body.title);
      touchDoc(d);
      return reply(200, { ok: true, rev: hub.rev, doc: { ...meta(d), content: d.content } }, { etag: d.etag });
    }
    if (method === 'PUT') {
      // THE ONLY doc route guarded by If-Match instead of a rev — and the only
      // one that can destroy someone else's edit in silence.
      const match = header(headers, 'If-Match');
      if (!match) return bad(412, 'If-Match is required', 'IF_MATCH_REQUIRED', { doc: d.id });
      if (match !== d.etag) return bad(412, 'If-Match failed', 'IF_MATCH_FAILED', { doc: d.id });
      if (typeof body.content === 'string') d.content = body.content;
      if (typeof body.title === 'string') d.title = body.title;
      touchDoc(d);
      return reply(200, { ok: true, rev: hub.rev, doc: { ...meta(d), content: d.content } }, { etag: d.etag });
    }
    if (method === 'DELETE') {
      const e = requireRev();
      if (e) return e;
      hub.docs.delete(id);
      bump();
      return reply(204, undefined, {}, true);
    }
  }

  return reply(599, { ok: false, error: `UNSCRIPTED ${method} ${rel}`, code: 'UNSCRIPTED' });
}

function respond(spec, record) {
  record.status = spec.status;
  return {
    status: spec.status,
    ok: spec.status >= 200 && spec.status < 300,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        for (const [hk, hv] of Object.entries(spec.headers)) if (hk.toLowerCase() === key) return hv;
        return null;
      },
    },
    // A 204 must NOT be read. Reading it here throws on a delete that worked.
    text: async () => {
      record.bodyRead = true;
      return spec.body === undefined ? '' : JSON.stringify(spec.body);
    },
    json: async () => {
      record.bodyRead = true;
      return spec.body ?? null;
    },
  };
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? 'GET';
  const rel = u.pathname.replace(/^\/api\/hub/, '') + u.search;
  const headers = init.headers ?? {};
  const body = init.body === undefined ? undefined : JSON.parse(init.body);
  const record = { method, rel, headers, body, status: 0, bodyRead: false };
  calls.push(record);

  // A dead network REJECTS. It does not return a fake object — the client reads
  // response headers, so a hand-rolled stub throws inside it.
  if (mode === 'dead') throw new TypeError('fetch failed');
  if (nextFailure) {
    const f = nextFailure;
    nextFailure = null;
    return respond(f, record);
  }

  // Idempotency: a replay of the SAME key with the SAME body is a SUCCESS that
  // does not apply twice. That is what makes the stale-rev retry safe.
  const key = header(headers, 'Idempotency-Key');
  if (key) {
    const prev = hub.applied.get(key);
    if (prev) {
      if (prev.sig === JSON.stringify(body)) {
        // The real hub answers `200` for a replay — not the original `201` —
        // with the `Duplicate` flag in both the body and a header.
        return respond(
          {
            ...prev.spec,
            status: 200,
            headers: { ...prev.spec.headers, duplicate: 'true' },
            body: prev.spec.body === undefined ? undefined : { ...prev.spec.body, Duplicate: true },
          },
          record,
        );
      }
      return respond(bad(409, 'same key, different body', 'DUPLICATE_OP'), record);
    }
  }

  const spec = route(method, rel, body, headers);
  if (key && spec.status >= 200 && spec.status < 300) {
    hub.applied.set(key, { sig: JSON.stringify(body), spec });
  }
  return respond(spec, record);
};

// ── bundle the real modules ─────────────────────────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'store-sim-'));
const outfile = join(out, 'store.mjs');
await build({
  stdin: {
    // One bundle, so the harness and the store share ONE auth-token instance.
    contents: `
export * from './store.ts';
export { emptyHubState, uid } from './types.ts';
export { currentRev } from './web/hub-client.ts';
export { setStreamToken } from './auth-token.ts';
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
    // `API_BASE` is derived from this, and a relative base is not a URL `fetch`
    // can take.
    'import.meta.env': JSON.stringify({
      VITE_HUB_STREAM_URL: 'http://relay.test/api/stream?channel=hub',
    }),
  },
});

const store = await import(pathToFileURL(outfile).href);
const { setStreamToken } = store;
setStreamToken('test-token');

const {
  addDoc,
  addTask,
  appendDoc,
  appendNote,
  applyRemote,
  clearDoneTasks,
  getConnStatus,
  getHubError,
  getState,
  hubReady,
  loadDoc,
  loadHub,
  noteServerHandshake,
  removeDoc,
  removeTask,
  reorderTasks,
  restoreHub,
  seedIfEmpty,
  selectDoc,
  selectSection,
  setDocContent,
  setDocTitle,
  setNotes,
  setTaskDone,
  setTaskText,
  setTasks,
  subscribe,
  subscribeConn,
  subscribeHubError,
  update,
} = store;

// ── ledger helpers ──────────────────────────────────────────────────────────
const allCalls = (method, relPrefix) => calls.filter((c) => c.method === method && c.rel.startsWith(relPrefix));
const okCalls = (method, relPrefix) =>
  calls.filter((c) => c.method === method && c.rel.startsWith(relPrefix) && c.status >= 200 && c.status < 300);
const exactCalls = (method, rel) => calls.filter((c) => c.method === method && c.rel === rel);
const exactOk = (method, rel) => exactCalls(method, rel).filter((c) => c.status >= 200 && c.status < 300);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ════════════════════════════════════════════════════════════════════════════
section('A. cold start — the cache paints before the hub answers');
check('hubReady() is false until the hub answers', hubReady(), false);
check('the cached docs paint immediately', getState().sections.docs.map((d) => d.id), ['cached-doc-1']);
check('…and the cached todos', getState().sections.todo.map((t) => t.text), ['cached task']);
check('…and the cached notes', getState().sections.notes, 'cached notes');
check('painting it touched no network', calls.length, 0);

{
  let repaints = 0;
  const un = subscribe(() => (repaints += 1));
  update((s) => ({ ...s, sections: { ...s.sections, notes: 'local only' } }));
  check('update() repaints', repaints, 1);
  check('update() never calls the network', calls.length, 0);
  check('update() was applied locally', getState().sections.notes, 'local only');
  check('…and written to the cache', JSON.parse(ls.get('hub:state')).sections.notes, 'local only');
  un();
}

{
  // The deprecated no-ops must stay no-ops: "my local list is the truth" is how
  // one device overwrites another's data.
  const before = JSON.stringify(getState());
  seedIfEmpty();
  noteServerHandshake(true);
  check('seedIfEmpty() sends nothing', calls.length, 0);
  check('noteServerHandshake() changes nothing', JSON.stringify(getState()), before);
}

applyRemote({
  activeSection: 'todo',
  activeDocId: null,
  sections: { todo: [{ id: 'frame-todo', text: 'from frame', done: false }], docs: [], files: [], notes: 'from frame' },
  updatedAt: 222,
});
check('a frame IS adopted before the hub answers', getState().sections.todo.map((t) => t.text), ['from frame']);

// ════════════════════════════════════════════════════════════════════════════
section('B. boot — loadHub() adopts the server and the frame becomes subordinate');
calls.length = 0;
check('loadHub() succeeds', await loadHub(), true);
check('…after exactly one GET /hub', exactCalls('GET', '').length, 1);
check('hubReady() is now true', hubReady(), true);
check('the server snapshot replaced the frame', getState().sections.todo.map((t) => t.text), ['server task']);
check('…docs', getState().sections.docs.map((d) => d.id), ['doc-1', 'doc-2']);
check('…notes', getState().sections.notes, 'server notes');
check('…and the active point', getState().activeDocId, 'doc-1');
check('the client adopted the server rev', store.currentRev(), hub.rev);
check('no error is reported', getHubError(), '');

{
  const before = JSON.stringify(getState());
  applyRemote({
    activeSection: 'todo',
    activeDocId: null,
    sections: { todo: [{ id: 'stale', text: 'STALE FRAME', done: false }], docs: [], files: [], notes: 'stale' },
    updatedAt: 999,
  });
  check('a frame is IGNORED once the hub has answered', JSON.stringify(getState()), before);
}

// ════════════════════════════════════════════════════════════════════════════
section('C. todos — id swap, rev, debounce, and the empty-list guard');
{
  const revBefore = hub.rev;
  const localId = 'pending';
  calls.length = 0;
  addTask('  buy milk  ');
  const painted = getState().sections.todo.at(-1);
  check('the task is painted locally at once', painted.text, 'buy milk');
  check('…under a LOCAL id, not the server’s', painted.id.startsWith('srv-'), false);
  assert('…and it is not the string we guessed', painted.id !== localId);
  check('the POST went out with a rev', exactCalls('POST', '/todos')[0]?.body.rev, revBefore);
  assert('…and an Idempotency-Key that is a canonical uuid v4', UUID_V4.test(exactCalls('POST', '/todos')[0]?.headers['Idempotency-Key'] ?? ''));

  const tempId = painted.id;
  await tick();
  const after = getState().sections.todo.find((t) => t.text === 'buy milk');
  check('the local id was swapped for the server’s', after.id, hub.todos.at(-1).id);
  check('…so the local row is no longer the temp id', after.id === tempId, false);
  check('…and the list length is right', getState().sections.todo.length, 2);
  check('the client adopted the new rev', store.currentRev(), hub.rev);

  calls.length = 0;
  addTask('   ');
  check('a blank task is not sent', calls.length, 0);
  check('…and not painted', getState().sections.todo.length, 2);
}

{
  const revBefore = hub.rev;
  calls.length = 0;
  setTaskDone('todo-1', true);
  check('setTaskDone is immediate, not debounced', exactCalls('PATCH', '/todos/todo-1').length, 1);
  check('…and sends only the flag', exactCalls('PATCH', '/todos/todo-1')[0].body, { done: true, rev: revBefore });
  await tick();
  check('…and the local row follows', getState().sections.todo.find((t) => t.id === 'todo-1').done, true);
}

{
  calls.length = 0;
  setTaskText('todo-1', 's');
  setTaskText('todo-1', 'se');
  setTaskText('todo-1', 'sea');
  check('typing sends nothing yet', calls.length, 0);
  check('…but the UI already shows the final text', getState().sections.todo.find((t) => t.id === 'todo-1').text, 'sea');
  flush();
  await tick();
  check('a burst of keystrokes is ONE write', exactCalls('PATCH', '/todos/todo-1').length, 1);
  check('…carrying the FINAL text', exactCalls('PATCH', '/todos/todo-1')[0].body.text, 'sea');
}

{
  calls.length = 0;
  clearDoneTasks();
  check('clearDone drops the done rows locally', getState().sections.todo.some((t) => t.done), false);
  check('…with one write, not N', exactCalls('POST', '/todos/clear-done').length, 1);
  await tick();
  check('…and adopts the server list', getState().sections.todo.map((t) => t.id), hub.todos.map((t) => t.id));
}

{
  // `adoptTodos` trusts the server's list whenever it is offered — the hub is
  // the authority. Its guard is narrower than it looks: it skips the adopt only
  // when BOTH lists are empty, which is a pointless-commit guard, not a
  // data-protection one. Both halves are asserted so the distinction is pinned.
  setTasks([{ id: 'local-only', text: 'just typed', done: false }]);
  await tick();
  patches.emptyTodos = true;
  calls.length = 0;
  setTasks([{ id: 'local-only', text: 'just typed', done: false }]);
  await tick();
  patches.emptyTodos = false;
  check('the server’s list wins, even when it is empty', getState().sections.todo.map((t) => t.text), []);

  // Both empty: the guard skips the adopt entirely, so the RESPONSE adds no
  // second repaint. The optimistic commit is expected and is zeroed out below —
  // it is the adopt, not the local edit, that must be skipped here.
  setTasks([]);
  await tick();
  let repaints = 0;
  const un = subscribe(() => (repaints += 1));
  patches.emptyTodos = true;
  setTasks([]);
  repaints = 0;
  await tick();
  patches.emptyTodos = false;
  check('an empty-on-empty adopt is skipped, not repainted', repaints, 0);
  un();
}

{
  calls.length = 0;
  const rows = [
    { id: 'r1', text: 'one', done: false },
    { id: 'r2', text: 'two', done: true },
  ];
  await tick();
  setTasks(rows);
  check('setTasks replaces the list in one write', exactCalls('PUT', '/todos').length, 1);
  check('…with the whole list', exactCalls('PUT', '/todos')[0].body.items, rows);
  await tick();

  calls.length = 0;
  reorderTasks(['r2', 'r1']);
  await tick();
  check('reorder sends the ids in order', exactCalls('POST', '/todos/reorder')[0].body.ids, ['r2', 'r1']);
  check('…and adopts the server order', getState().sections.todo.map((t) => t.id), ['r2', 'r1']);
}

{
  calls.length = 0;
  removeTask('r2');
  await tick();
  check('removeTask issues a DELETE', exactOk('DELETE', '/todos/r2').length, 1);
  check('…and a 204 is NOT parsed for a body', exactCalls('DELETE', '/todos/r2')[0].bodyRead, false);
  check('…and the row is gone locally', getState().sections.todo.map((t) => t.id), ['r1']);
  check('…with no error reported', getHubError(), '');
}

// ════════════════════════════════════════════════════════════════════════════
section('D. docs — id swap, the etag the write MUST have, and metadata-only rename');
let createdId = '';
{
  calls.length = 0;
  const tempId = addDoc('New Doc', 'body');
  check('addDoc returns the optimistic id synchronously', typeof tempId, 'string');
  const row = getState().sections.docs.find((d) => d.id === tempId);
  check('…and the row is painted under it', row?.title, 'New Doc');
  check('…and it is the open document', getState().activeDocId, tempId);
  check('…and it opened the docs section', getState().activeSection, 'docs');
  check('the POST went out', exactCalls('POST', '/docs').length, 1);

  await tick();
  createdId = hub.docs.size ? [...hub.docs.keys()].at(-1) : '';
  check('the row was renamed to the server id', getState().sections.docs.some((d) => d.id === tempId), false);
  check('…and the server id is present', getState().sections.docs.some((d) => d.id === createdId), true);
  check('…and the OPEN doc followed the swap', getState().activeDocId, createdId);
  check('…and the body survived', getState().sections.docs.find((d) => d.id === createdId).content, 'body');
}

{
  // The create response handed over an etag, so the first save must not need a
  // 412 round trip. If the etag were dropped, this would cost 2 PUTs + 1 GET.
  calls.length = 0;
  setDocContent(createdId, 'v2');
  flush();
  await tick();
  check('the first content write reuses the create’s etag', exactCalls('PUT', `/docs/${createdId}`).length, 1);
  check('…i.e. it carried If-Match', typeof exactCalls('PUT', `/docs/${createdId}`)[0].headers['If-Match'], 'string');
  check('…so no re-read was needed', allCalls('GET', `/docs/${createdId}`).length, 0);
  check('…and the server has the new body', hub.docs.get(createdId).content, 'v2');
  check('no error was reported', getHubError(), '');
}

{
  // COLD START. `GET /hub` carries NO per-document etags, so a doc adopted from
  // the boot snapshot has none — and the hub REFUSES a write without one. This
  // is the normal first-save path, not an edge case.
  calls.length = 0;
  setDocContent('doc-2', 'cold edit');
  flush();
  await tick();
  const puts = allCalls('PUT', '/docs/doc-2');
  check('a write with no etag is attempted', puts.length >= 1, true);
  check('…the first attempt carried NO If-Match', puts[0].headers['If-Match'], undefined);
  check('…so the hub refused it with 412', puts[0].status, 412);
  check('…the store re-read the doc for its etag', allCalls('GET', '/docs/doc-2').length, 1);
  check('…and retried with If-Match', typeof puts[1]?.headers['If-Match'], 'string');
  check('…and the retry succeeded', puts[1]?.status, 200);
  check('…so exactly two PUTs were needed', puts.length, 2);
  check('…and the body landed', hub.docs.get('doc-2').content, 'cold edit');
  check('…with the local copy agreeing', getState().sections.docs.find((d) => d.id === 'doc-2').content, 'cold edit');
  check('no error is surfaced for a recovered write', getHubError(), '');
}

{
  calls.length = 0;
  setDocContent(createdId, 'a');
  setDocContent(createdId, 'ab');
  setDocContent(createdId, 'abc');
  check('typing sends nothing yet', calls.length, 0);
  flush();
  await tick();
  check('…then ONE write', exactCalls('PUT', `/docs/${createdId}`).length, 1);
  check('…carrying the live final text', exactCalls('PUT', `/docs/${createdId}`)[0].body.content, 'abc');
}

{
  calls.length = 0;
  setDocTitle(createdId, 'Renamed');
  await tick();
  const patch = exactCalls('PATCH', `/docs/${createdId}`)[0];
  check('rename is a PATCH', patch?.body.title, 'Renamed');
  check('…that does NOT carry the body', Object.prototype.hasOwnProperty.call(patch?.body ?? {}, 'content'), false);
  check('…so it cannot clobber an edit in flight', hub.docs.get(createdId).content, 'abc');
  check('…and the local title follows', getState().sections.docs.find((d) => d.id === createdId).title, 'Renamed');
}

{
  calls.length = 0;
  appendDoc(createdId, 'appended');
  flush();
  await tick();
  check('appendDoc is a read-modify-write', exactCalls('PUT', `/docs/${createdId}`).length, 1);
  check('…that joins with a newline', exactCalls('PUT', `/docs/${createdId}`)[0].body.content, 'abc\nappended');
}

{
  calls.length = 0;
  const read = await loadDoc('doc-1');
  check('loadDoc returns the row', read?.id, 'doc-1');
  check('…with its body', read?.content, 'first body');
  check('…via one GET', allCalls('GET', '/docs/doc-1').length, 1);
  check('…and no write', calls.filter((c) => c.method !== 'GET').length, 0);
}

{
  calls.length = 0;
  removeDoc(createdId);
  await tick();
  check('removeDoc issues a DELETE', exactOk('DELETE', `/docs/${createdId}`).length, 1);
  check('…and the 204 is not parsed', exactCalls('DELETE', `/docs/${createdId}`)[0].bodyRead, false);
  check('…and the row is gone locally', getState().sections.docs.some((d) => d.id === createdId), false);
  calls.length = 0;
  setDocContent(createdId, 'write to a deleted doc');
  flush();
  await tick();
  check('writing to a deleted doc sends NOTHING', calls.length, 0);
}

// ════════════════════════════════════════════════════════════════════════════
section('E. notes — debounced replace, and an append the SERVER joins');
{
  calls.length = 0;
  setNotes('one');
  setNotes('one two');
  check('typing sends nothing yet', calls.length, 0);
  flush();
  await tick();
  check('the notes pane is ONE write', okCalls('PUT', '/notes').length, 1);
  check('…of the final text', okCalls('PUT', '/notes')[0]?.body.content, 'one two');
  check('…and the server agrees', hub.notes, 'one two');
}

{
  calls.length = 0;
  appendNote('dictated line');
  await tick();
  check('appendNote is a POST /notes/append, not a PUT', exactCalls('POST', '/notes/append').length, 1);
  check('…and never puts the whole body', exactCalls('PUT', '/notes').length, 0);
  check('…and sends only the line', exactCalls('POST', '/notes/append')[0].body.text, 'dictated line');
  check('…and adopts the SERVER’s join', getState().sections.notes, 'one two\ndictated line');
  check('…which is what the server holds', hub.notes, 'one two\ndictated line');
}

// ════════════════════════════════════════════════════════════════════════════
section('F. control plane — one PATCH for both fields, and only those fields adopted');
{
  await tick();
  calls.length = 0;
  patches.controlDropsTodos = true; // the response's sections deliberately differ
  const todosBefore = JSON.stringify(getState().sections.todo);
  selectSection('notes');
  selectDoc('doc-1');
  // Nothing may be WRITTEN on a tap: the control plane is debounced. A READ is
  // expected and is not a write — `selectDoc` probes the body it is opening.
  check('a flurry of taps sends no WRITE yet', calls.filter((c) => c.method !== 'GET').length, 0);
  check('…but the section is already painted', getState().activeSection, 'notes');
  flush();
  await tick();
  const patchesSent = exactCalls('PATCH', '');
  check('both control fields go in ONE PATCH', patchesSent.length, 1);
  check('…carrying the open doc', patchesSent[0].body.activeDocId, 'doc-1');
  check('…and the open section', patchesSent[0].body.activeSection, 'notes');
  check('…and the rev it needs', patchesSent[0].body.rev, patchesSent[0].body.rev);
  assert('…as a number', typeof patchesSent[0].body.rev === 'number');
  check('the local control point stays', [getState().activeSection, getState().activeDocId], ['notes', 'doc-1']);
  check('…and the sections are NOT repainted from the response', JSON.stringify(getState().sections.todo), todosBefore);
  patches.controlDropsTodos = false;
}

// ════════════════════════════════════════════════════════════════════════════
section('G. failure surface — an honest report, never a silent no-op');
{
  calls.length = 0;
  mode = 'dead';
  const connChanges = [];
  const un = subscribeConn((s) => connChanges.push(s));
  const errors = [];
  const unErr = subscribeHubError((m) => errors.push(m));

  const before = getState().sections.todo.length;
  addTask('typed while offline');
  check('the row IS painted — the user asked for it', getState().sections.todo.length, before + 1);
  await tick();
  check('a dead network is reported, not swallowed', getHubError().length > 0, true);
  check('…with a real message', getHubError(), 'fetch failed');
  check('…and the chip says offline', getConnStatus(), 'error');
  check('…and the error reached the subscriber', errors.at(-1), 'fetch failed');
  assert('…which is a distinct state from a hub refusal', connChanges.includes('error'));

  mode = 'hub';
  calls.length = 0;
  nextFailure = bad(403, 'this route requires the owner credential', 'SCOPE_DENIED');
  addTask('typed while refused');
  await tick();
  check('a hub REFUSAL is reported with the hub’s own words', getHubError(), 'this route requires the owner credential');
  check('…but the chip is NOT offline (we reached the hub)', getConnStatus(), 'open');

  calls.length = 0;
  addTask('typed again');
  await tick();
  check('the next successful write clears the banner', getHubError(), '');
  un();
  unErr();
}

// ════════════════════════════════════════════════════════════════════════════
section('H. restoreHub — an undo replays the DIFF, not the library');
{
  await tick();
  const snap = JSON.parse(JSON.stringify(getState()));
  const [first, ...rest] = snap.sections.docs;
  const restIds = rest.map((d) => d.id);

  // Diverge: delete a doc, add one, and change both collections.
  calls.length = 0;
  removeDoc(first.id);
  addDoc('Throwaway', 'nobody wants me');
  await tick();
  // `addDoc` swaps its optimistic id for the server's, so the row to expect a
  // DELETE for is whatever id the local throwaway row ended up with.
  const throwaway = getState().sections.docs.at(-1).id;
  setTasks([{ id: 'tmp', text: 'tmp', done: false }]);
  setNotes('diverged');
  await tick();

  calls.length = 0;
  restoreHub(snap);
  flush();
  await tick();

  check('the doc the snapshot still had is re-created', okCalls('POST', '/docs').length, 1);
  check('…with its title', okCalls('POST', '/docs')[0]?.body.title, first.title);
  check('…and its body', okCalls('POST', '/docs')[0]?.body.content, first.content);
  check('the doc that was not in the snapshot is deleted', okCalls('DELETE', `/docs/${throwaway}`).length, 1);
  check('…leaving exactly the snapshot’s library', getState().sections.docs.length, snap.sections.docs.length);
  // The ORDER is deliberately not asserted: `addDoc` appends, and the hub owns
  // doc ordering (a boot read re-imposes it), so a restore guarantees the SET.
  check(
    '…with the snapshot’s titles',
    getState()
      .sections.docs.map((d) => d.title)
      .sort(),
    snap.sections.docs.map((d) => d.title).sort(),
  );
  // The 409 this restore provokes schedules a `loadHub`, which adopts the hub’s
  // snapshot wholesale; when that refresh wins the race against the create’s own
  // response, the optimistic row is gone by the time the id comes back. The swap
  // must therefore UPSERT, or the re-created document exists on the hub while
  // being invisible here.
  const recreatedOnHub = [...hub.docs.values()].find((d) => d.title === first.title)?.id;
  check(
    '…and the re-created row is on the hub',
    typeof recreatedOnHub,
    'string',
  );
  check(
    '…so a refresh that raced its create must not lose it locally',
    getState().sections.docs.some((d) => d.id === recreatedOnHub),
    true,
  );
  check('untouched docs are NOT rewritten', restIds.flatMap((id) => allCalls('PUT', `/docs/${id}`)).length, 0);
  check('…and not renamed', restIds.flatMap((id) => allCalls('PATCH', `/docs/${id}`)).length, 0);
  check('the todos are restored', getState().sections.todo.map((t) => t.text), snap.sections.todo.map((t) => t.text));
  check('…in one write', okCalls('PUT', '/todos').length, 1);
  check('the notes are restored', getState().sections.notes, snap.sections.notes);
  check('…in one write', okCalls('PUT', '/notes').length, 1);
  check('the open document is restored', getState().activeDocId, snap.activeDocId);
}

{
  // An unchanged library must cost NOTHING: the diff is empty.
  await tick();
  const snap = JSON.parse(JSON.stringify(getState()));
  calls.length = 0;
  restoreHub(snap);
  flush();
  await tick();
  check(
    'an unchanged library issues no doc writes at all',
    calls.filter((c) => c.method !== 'GET' && c.rel.startsWith('/docs')).length,
    0,
  );
}

// ════════════════════════════════════════════════════════════════════════════
section('I. a stale rev is a retry, not a lost edit');
{
  await tick();
  // Another device writes. Our client still holds the old rev.
  hub.rev += 3;
  hub.todos.push({ id: 'other-device', text: 'from the other device', done: false });
  const before = hub.todos.length;
  const serverRev = hub.rev;

  calls.length = 0;
  addTask('mine, after a race');
  await tick();

  const posts = allCalls('POST', '/todos');
  check('the first attempt is refused as stale', posts[0].status, 409);
  check('…and retried once', posts.length, 2);
  check('…with the SAME Idempotency-Key', posts[1].headers['Idempotency-Key'], posts[0].headers['Idempotency-Key']);
  check('…and the SERVER’s rev, not ours', posts[1].body.rev, serverRev);
  check('…and it lands', posts[1].status, 201);
  check('the other device’s task survived', hub.todos.some((t) => t.id === 'other-device'), true);
  check('…and exactly one row was added, not two', hub.todos.length, before + 1);
  check('no error is surfaced — the edit landed', getHubError(), '');
}

{
  // A replay of the same key must be a SUCCESS that does not apply twice. This
  // is what makes the retry above safe when the first attempt DID land.
  const key = '5c3f8a2e-1d4b-4f6a-9c7e-2b8d0a1e3f45';
  const body = { text: 'replayed', rev: hub.rev };
  const first = await globalThis.fetch('http://relay.test/api/hub/todos', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  const seen = JSON.parse(await first.text());
  const second = await globalThis.fetch('http://relay.test/api/hub/todos', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  const replayed = JSON.parse(await second.text());
  check('a replayed key answers 200', second.status, 200);
  check('…flagged Duplicate', replayed.Duplicate, true);
  check('…and the item is the same row', replayed.item?.id, seen.item?.id);
  check('…and no second row was created', hub.todos.filter((t) => t.text === 'replayed').length, 1);
}

// ════════════════════════════════════════════════════════════════════════════
section('J. a burst in one tick is SERIALISED — rev is one token, not N');
{
  // `hub_state.rev` is a SINGLE per-user token, so N writes issued in one tick
  // cannot all be valid: N-1 are guaranteed `409 STALE_REV` no matter how the
  // network schedules them. A retry budget alone is not enough — under a flurry
  // the overflow loses its retries too. The client must therefore run ONE write
  // at a time, which is what this proves: not that the writes recover, but that
  // they are NEVER refused in the first place.
  await tick();
  calls.length = 0;
  hub.todos = [
    { id: 'burst-1', text: 'one', done: false },
    { id: 'burst-2', text: 'two', done: false },
    { id: 'burst-3', text: 'three', done: false },
  ];
  hub.rev = store.currentRev(); // in sync, so a refusal could only be self-inflicted
  const revBefore = hub.rev;

  setTaskDone('burst-1', true);
  setTaskDone('burst-2', true);
  setTaskDone('burst-3', true);
  await tick();

  const patchesSent = allCalls('PATCH', '/todos/');
  check('all three writes went out', patchesSent.length, 3);
  check('…and NONE of them was refused as stale', patchesSent.filter((c) => c.status === 409).length, 0);
  check(
    '…so each one carried a rev the hub accepted',
    patchesSent.every((c) => c.status === 200),
    true,
  );
  check('…and each went out exactly once', patchesSent.filter((c) => c.rel === '/todos/burst-1').length, 1);
  check('…with three distinct Idempotency-Keys', new Set(patchesSent.map((c) => c.headers['Idempotency-Key'])).size, 3);
  check('the writes were ordered', patchesSent.map((c) => c.body.rev), [revBefore, revBefore + 1, revBefore + 2]);
  check('…and the server holds all three', hub.todos.filter((t) => t.done).length, 3);
  check('…and the client is in sync', store.currentRev(), hub.rev);
  check('no error was reported', getHubError(), '');
}

{
  // The other half of the contract: the budget is FINITE. A hub that refuses
  // forever must produce a bounded number of attempts and an honest error, not
  // an infinite retry loop that looks like a hang.
  await tick();
  patches.alwaysStale = true;
  calls.length = 0;
  setTaskDone('burst-1', false);
  await tick();
  const attempts = exactCalls('PATCH', '/todos/burst-1');
  patches.alwaysStale = false;
  check('a permanently stale hub is retried a bounded number of times', attempts.length, 4);
  check('…and then the failure is REPORTED', getHubError().length > 0, true);
  check('…not swallowed', getHubError(), 'rev is stale');
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`} — ${pass} checks`);
process.exit(fail === 0 ? 0 : 1);
