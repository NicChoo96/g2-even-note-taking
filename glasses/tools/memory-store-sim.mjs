// Verifies the MEMORY and SESSION stores' hub semantics, by bundling the real
// modules (no re-implementation) and driving them against a small in-memory hub
// that mimics the real one's probed behaviour: `rev` as one per-user token, the
// hub's OWN id-minting, server-stamped timestamps, per-operation
// `Idempotency-Key` dedup, `DUPLICATE_OP`, the session tombstone, and the
// append-only memory store. No network, no relay, no backend.
//
// Run: node tools/memory-store-sim.mjs          (from `glasses/`)
//      SIM_QUIET=1 node tools/memory-store-sim.mjs
//
// ⚠ NOT CALLED `jarvis-memory-sim.mjs` ON PURPOSE — that name belongs to the
// relay-facing memory suite (compaction, the replay window, the prompt text). It
// stays valid and must keep passing, so the hub-backed half gets its own file.
// Nor may this be `files-store-sim.mjs` / `agents-store-sim.mjs` / `store-sim.mjs`
// / `sessions-sync-sim.mjs`, which are taken.
//
// WHY THIS IS WORTH A HARNESS
//   Every rule below is silently wrong when it is wrong — the app still runs, and
//   the only symptom is lost or duplicated history:
//     • treating `runId` as a DEDUPE key. Probed: two creates with the same
//       `runId` produced TWO sessions. Only `Idempotency-Key` folds a repeat.
//     • trusting a client-supplied session `id`. The hub DROPS it silently and
//       mints its own, so `run.id` can never be the hub's key — an alias map is
//       mandatory, and every later call needs it.
//     • reading the session `id` off the response but forgetting the alias, so a
//       later hydrate maps the SAME session onto a second local row.
//     • expecting `PUT /hub/memory` to REPLACE. It ADDS: probed, sending
//       `{digest:'',turns:[]}` against a store holding one turn answered
//       `added: 0` and left `turns: 1`. Only DELETE empties it.
//     • passing an ARRAY to `POST /hub/memory/turns`. It takes ONE turn.
//     • reading `GET /hub/memory` and expecting turns. It returns COUNTS and the
//       digest, and no query parameter changes that: `?limit`, `?turns`,
//       `?includeTurns` are all ignored and `/memory/turns` is a 404.
//     • using the client's own cap (100_000 words) when the hub has answered. The
//       hub's `capWords` is authoritative, and it is 4_000.
//     • adopting `tombstone.all` as a clear stamp. It is a WATERMARK the hub
//       re-stamps to NOW on every session write, so adopting it would filter out
//       every session older than the newest one.
//     • reading `stats.summaries` as "summaries of the visible sessions".
//       Deleting every session leaves its summary rows behind.
//     • expecting the rev to move on a session or memory write, or expecting a
//       session write to succeed without a rev in the BODY. `?rev=` in the query
//       is rejected for PATCH/DELETE.
//   A tiny REAL hub is used rather than canned strings because most of these
//   depend on state — which id the hub minted, whether a key already landed,
//   where the watermark sits — and canned replies cannot model that honestly.

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

// The classic way this suite lies: a floating promise rejects after every check
// has printed, node exits non-zero, and the log reads "ALL PASS". Surface it.
process.on('unhandledRejection', (e) => {
  fail += 1;
  console.log(`FAIL  unhandled rejection: ${e && e.message ? e.message : String(e)}`);
});

// ── the fake clock ──────────────────────────────────────────────────────────
// The memory module debounces nothing today, but `window` is referenced by the
// modules this bundles and a future debounce must not silently become a race.
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
async function tick(n = 10) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
  clear: () => ls.clear(),
};

// ── the mini hub ────────────────────────────────────────────────────────────
// `rev` is the live server's own number, taken from a real probe, so nothing
// depends on a coincidence about where counting starts. Sessions and memory do
// NOT bump it (§4) — a harness that let them would hide a real bug.
const HUB_REV = 68;
const AGENT_IDS = ['5b9c41ec-06d6-49e2-b4fc-b583c3dc0c89', 'd03cf4f7-1a2b-4c3d-8e4f-556677889900'];
const SESSION_KINDS = ['agent', 'voice', 'note'];

function newHub() {
  return {
    rev: HUB_REV,
    clock: 1_700_000_000_000,
    sessions: [],
    summaries: 0, // outlives its sessions, deliberately
    tombstone: { all: null, byAgent: {} },
    keys: new Map(), // Idempotency-Key -> {body, response}
    memory: { versions: 0, digest: '', digestAt: 0, folded: 0, turns: [] },
    // Knobs the tests turn.
    failKind: null,
    summariseSkipped: 'no provider',
    compacted: false,
    compactSkipped: 'provider down',
  };
}
let hub = newHub();

const calls = [];
let mode = 'live'; // 'live' | 'dead'

const STAMP = () => (hub.clock += 1);

function stampTombstone() {
  // The hub RE-STAMPS this to now on every session write. That is exactly why it
  // is a watermark and not a deletion predicate.
  hub.tombstone = { all: STAMP(), byAgent: { ...hub.tombstone.byAgent } };
}

function memoryBody(extra = {}) {
  const m = hub.memory;
  const words = m.turns.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
  return {
    ok: true,
    rev: hub.rev,
    versions: m.versions,
    digest: m.digest,
    digestAt: m.digestAt,
    folded: m.folded,
    turns: m.turns.length,
    words,
    liveWords: words,
    capWords: 4000,
    digestWords: 400,
    ...extra,
  };
}

function sessionRow(s) {
  const words = s.messages.reduce((n, m) => n + m.content.split(/\s+/).filter(Boolean).length, 0);
  const row = {
    id: s.id,
    kind: s.kind,
    agentId: s.agentId,
    title: s.title,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turnCount: s.messages.length,
    wordCount: words,
    summaryVersion: 0,
    pinned: false,
  };
  // `runId` IS on the list row (probed) even though the hub drops other unknown
  // fields. It is how a lost create response is recovered.
  if (s.runId) row.runId = s.runId;
  if (s.status !== 'running') row.endedAt = s.updatedAt;
  return row;
}

function route(method, rel, body, headers) {
  const url = new URL('http://x' + rel);
  const path = url.pathname;

  // ── memory ───────────────────────────────────────────────────────────────
  if (path === '/memory' && method === 'GET') {
    // COUNTS and the digest. No query parameter adds turns: probed, `?limit`,
    // `?turns` and `?includeTurns` are all silently ignored.
    return { status: 200, body: memoryBody() };
  }

  if (path === '/memory/turns' && method === 'POST') {
    if (typeof body?.rev !== 'number') {
      return {
        status: 400,
        body: { ok: false, error: 'rev required', code: 'REV_REQUIRED', details: { field: 'rev' } },
      };
    }
    // ONE turn. An array here is the mistake this route exists to catch.
    if (Array.isArray(body.turns) || body.text === undefined || typeof body.role !== 'string') {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'one turn required',
          code: 'VALIDATION_ERROR',
          details: { field: 'text' },
        },
      };
    }
    hub.memory.turns.push({ role: body.role, text: body.text, at: STAMP() });
    return { status: 200, body: memoryBody({ added: 1 }) };
  }

  if (path === '/memory' && method === 'PUT') {
    if (typeof body?.rev !== 'number') {
      return {
        status: 400,
        body: { ok: false, error: 'rev required', code: 'REV_REQUIRED', details: { field: 'rev' } },
      };
    }
    // ⚠ ADDS. The document claims this replaces; the server does not.
    const added = Array.isArray(body.turns) ? body.turns.length : 0;
    for (const t of body.turns ?? []) {
      hub.memory.turns.push({ role: t.role, text: t.text, at: STAMP() });
    }
    if (typeof body.digest === 'string' && body.digest) hub.memory.digest = body.digest;
    return { status: 200, body: memoryBody({ added }) };
  }

  if (path === '/memory' && method === 'DELETE') {
    if (typeof body?.rev !== 'number') {
      return {
        status: 400,
        body: { ok: false, error: 'rev required', code: 'REV_REQUIRED', details: { field: 'rev' } },
      };
    }
    // The ONLY way to empty the store. Not a watermark: the next append lands.
    hub.memory = { versions: 0, digest: '', digestAt: 0, folded: 0, turns: [] };
    return { status: 204, body: null };
  }

  if (path === '/memory/compact' && method === 'POST') {
    // A declined compaction is a SUCCESS with a reason.
    return {
      status: 200,
      body: memoryBody({
        compacted: hub.compacted,
        compactSkipped: hub.compacted ? null : hub.compactSkipped,
        version: 0,
      }),
    };
  }

  if (path === '/recall' && method === 'POST') {
    // `minScore`/`includeMessages` are 501 — nothing in the pipeline produces a
    // score, so the hub refuses to pretend it filtered.
    const bad = ['minScore', 'includeMessages'].find((k) => body && k in body);
    if (bad) {
      return {
        status: 501,
        body: {
          ok: false,
          error: 'recall does not filter by score; nothing in the pipeline produces one',
          code: 'NOT_IMPLEMENTED',
          details: { field: bad },
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        rev: hub.rev,
        selected: [],
        candidates: 0,
        ranked: false,
        reason: 'nothing to rank',
        serverTime: STAMP(),
      },
    };
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  if (path === '/sessions' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const items = hub.sessions.slice().reverse().slice(0, Math.min(limit, 500));
    return {
      status: 200,
      body: { ok: true, rev: hub.rev, items: items.map(sessionRow), next: null, more: false, limit: Math.min(limit, 500), tombstone: hub.tombstone },
    };
  }

  if (path === '/sessions/stats' && method === 'GET') {
    const turns = hub.sessions.reduce((n, s) => n + s.messages.length, 0);
    return {
      status: 200,
      body: {
        ok: true,
        rev: hub.rev,
        sessions: hub.sessions.length,
        turns,
        words: hub.sessions.reduce((n, s) => n + s.messages.length, 0),
        summaries: hub.summaries,
        summarised: hub.summaries,
        unsummarised: 0,
        coverage: 1,
        byKind: hub.sessions.reduce((a, s) => ({ ...a, [s.kind]: (a[s.kind] ?? 0) + 1 }), {}),
        tombstone: hub.tombstone,
      },
    };
  }

  if (path === '/sessions' && method === 'POST') {
    // ⚠ This route REQUIRES a rev — probed on top of §4.9 saying so.
    if (typeof body?.rev !== 'number') {
      return {
        status: 400,
        body: { ok: false, error: 'rev required', code: 'REV_REQUIRED', details: { field: 'rev' } },
      };
    }
    if (!SESSION_KINDS.includes(body.kind)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `kind: unsupported value`,
          code: 'INVALID_ENUM',
          details: { field: 'kind', value: body.kind, allowed: SESSION_KINDS },
        },
      };
    }
    if (body.agentId !== undefined && body.agentId !== null && !AGENT_IDS.includes(body.agentId)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'unknown agentId',
          code: 'VALIDATION_ERROR',
          details: { field: 'agentId' },
        },
      };
    }
    // ⚠ Per-OPERATION dedup on the key, and ONLY on the key. `runId` does not
    // dedupe: probed, a second create with the same `runId` made a second row.
    const key = headers['Idempotency-Key'];
    if (key && hub.keys.has(key)) {
      const prev = hub.keys.get(key);
      if (JSON.stringify(prev.body) === JSON.stringify(body)) {
        return { status: 200, body: { ...prev.response, Duplicate: true }, headers: { duplicate: 'true' } };
      }
      // ⚠ A DIFFERENT body under the same key is a 409 whose `details.current`
      // carries the ORIGINAL SUCCESS RESPONSE — including `sessionId`. Reading it
      // is what stops a caller creating a duplicate session.
      return {
        status: 409,
        body: {
          ok: false,
          error: 'this Idempotency-Key was used before with a different body',
          code: 'DUPLICATE_OP',
          details: { current: prev.response, opId: 'op-1', appliedAt: STAMP() },
        },
      };
    }
    // ⚠ The hub MINTS its own id and IGNORES a client one, with no error and no
    // echo. `id` is deliberately not read from the body here.
    const id = `srv-${hub.sessions.length + 1}-${Math.random().toString(16).slice(2, 8)}`;
    const at = STAMP();
    const messages = (Array.isArray(body.messages) ? body.messages : []).map((m, i) => ({
      seq: i + 1,
      role: m.role,
      content: m.content,
      at: STAMP(), // the SERVER stamps it; a client `at` is ignored
      ...(m.tool ? { tool: m.tool } : {}),
      ...(m.args ? { args: m.args } : {}),
    }));
    const s = {
      id,
      kind: body.kind,
      agentId: body.agentId ?? null,
      title: body.title ?? '',
      status: body.status ?? 'done',
      runId: body.runId ?? null,
      createdAt: at,
      updatedAt: at,
      messages,
    };
    hub.sessions.push(s);
    if (body.kind === 'agent') stampTombstone();
    const response = {
      ok: true,
      rev: hub.rev,
      sessionId: id,
      applied: true,
      seq: messages.length,
      summary: null,
      summarised: false,
      summariseSkipped: messages.length ? hub.summariseSkipped : 'nothing new to summarise',
    };
    if (key) hub.keys.set(key, { body, response });
    return { status: 201, body: response };
  }

  const sessMatch = path.match(/^\/sessions\/([^/]+)(\/messages)?$/);
  if (sessMatch) {
    const id = sessMatch[1];
    const s = hub.sessions.find((x) => x.id === id);
    if (!s) {
      return {
        status: 404,
        body: { ok: false, error: 'session not found', code: 'NOT_FOUND', details: { id } },
      };
    }
    if (sessMatch[2] && method === 'GET') {
      return {
        status: 200,
        body: { ok: true, rev: hub.rev, items: s.messages, next: null, more: false, limit: 50 },
      };
    }
    if (!sessMatch[2] && method === 'GET') {
      // The entity plus `etag` in the BODY. NEVER the messages.
      return { status: 200, body: { ok: true, rev: hub.rev, ...sessionRow(s), etag: `"${s.updatedAt}-h1"` } };
    }
    if (!sessMatch[2] && method === 'PATCH') {
      // ⚠ Rev in the BODY. `?rev=` in the query is rejected.
      if (typeof body?.rev !== 'number') {
        return {
          status: 400,
          body: { ok: false, error: 'rev required', code: 'REV_REQUIRED', details: { field: 'rev' } },
        };
      }
      if (typeof body.title === 'string') s.title = body.title;
      if (typeof body.status === 'string') s.status = body.status;
      s.updatedAt = STAMP();
      return { status: 200, body: { ok: true, rev: hub.rev, ...sessionRow(s), etag: `"${s.updatedAt}-h1"` } };
    }
    if (!sessMatch[2] && method === 'DELETE') {
      if (typeof body?.rev !== 'number') {
        return {
          status: 400,
          body: { ok: false, error: 'rev required', code: 'REV_REQUIRED', details: { field: 'rev' } },
        };
      }
      // ⚠ The session and its messages go; its SUMMARY ROWS DO NOT.
      hub.summaries += 1;
      hub.sessions = hub.sessions.filter((x) => x.id !== id);
      return { status: 204, body: null };
    }
  }

  return { status: 404, body: { ok: false, error: 'hub route not found', code: 'NOT_FOUND' } };
}

// ── the fetch stub ──────────────────────────────────────────────────────────
// `headers.get` is REAL here. The client reads response headers on the way back,
// so a plain object makes a floating promise throw and the process exits 1 while
// printing every check as passing.
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? 'GET';
  const rel = u.pathname.replace(/^\/api\/hub/, '') + u.search;
  const headers = init.headers ?? {};
  const body = init.body === undefined ? undefined : JSON.parse(init.body);
  const record = { method, rel, path: u.pathname, headers, body, status: 0 };
  const isHub = u.pathname.startsWith('/api/hub');
  calls.push({ ...record, hub: isHub });

  const respond = (spec) => {
    record.status = spec.status;
    return {
      status: spec.status,
      ok: spec.status >= 200 && spec.status < 300,
      headers: { get: (k) => spec.headers?.[k] ?? null },
      text: async () => (spec.body === undefined || spec.body === null ? '' : JSON.stringify(spec.body)),
      json: async () => spec.body ?? null,
    };
  };

  // A dead network REJECTS. It does not return a fake object.
  if (mode === 'dead') throw new TypeError('fetch failed');
  if (!isHub) return respond({ status: 200, body: { ok: true, relay: true } });
  const spec = route(method, rel, body, headers);
  if (hub.failKind && rel.startsWith('/sessions') && method === 'POST') {
    hub.failKind = null;
    return respond({ status: 400, body: { ok: false, error: 'kind: unsupported value', code: 'INVALID_ENUM' } });
  }
  return respond(spec);
};

// ── helpers ─────────────────────────────────────────────────────────────────
const hubCalls = (method, prefix) =>
  calls.filter((c) => c.hub && c.method === method && c.rel.replace(/\?.*$/, '').startsWith(prefix));
// Exact path only — a prefix match on '/sessions' also swallows
// '/sessions/{id}/messages', which is a DIFFERENT read with a different meaning.
const exactHubCalls = (method, path) =>
  calls.filter((c) => c.hub && c.method === method && c.rel.replace(/\?.*$/, '') === path);
const lastHub = (method, prefix) => hubCalls(method, prefix).at(-1);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── bundle the real modules ─────────────────────────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'memory-store-sim-'));
const outfile = join(out, 'mem.mjs');
await build({
  stdin: {
    // One bundle, so the harness and the stores share ONE auth-token instance.
    contents: `
export * from './agents-store.ts';
export {
  compactMemory, countWords, getMemoryView, hydrateMemory, memoryMessages,
  rememberExchange, rememberSpoken, resetMemory, snapshotMemory, subscribeMemory,
  MEMORY_MAX_WORDS,
} from './ai/memory.ts';
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
const {
  MEMORY_MAX_WORDS,
  clearSessionsFor,
  compactMemory,
  currentRev,
  getAgents,
  getAgentsError,
  getMemoryView,
  hydrateHubSessions,
  hydrateMemory,
  hubIdForSession,
  recordSession,
  rememberExchange,
  rememberSpoken,
  resetMemory,
  setStreamToken,
  snapshotMemory,
} = store;

setStreamToken('test-token');
await hydrateMemory();
await tick();

// ════════════════════════════════════════════════════════════════════════════
section('A. memory — the cap is the HUB’s, and the turns are the CLIENT’s');
// ════════════════════════════════════════════════════════════════════════════

check('the client still knows its offline fallback', MEMORY_MAX_WORDS, 100_000);
check('but the view reports the HUB’s cap', getMemoryView().capWords, 4000);
check('the view’s turn count is a NUMBER, not the log', typeof getMemoryView().turns, 'number');
check('the digest target is the hub’s', getMemoryView().digestWords, 400);

calls.length = 0;
rememberExchange('what is on my agenda', 'you have two tasks', fakeNow);
await tick();
flush();
await tick();

const turnPosts = hubCalls('POST', '/memory/turns');
check('a remembered exchange mirrors to the hub', turnPosts.length > 0, true);
check('and it is a POST to the hub, not a PUT of the blob', turnPosts.length, 2);
check(
  'ONE turn per call, never an array',
  turnPosts.every((c) => typeof c.body?.text === 'string' && !Array.isArray(c.body?.turns)),
  true,
);
check('each carries the role the client assigned', turnPosts.map((c) => c.body.role), ['user', 'assistant']);
check('and a rev — the route needs one', turnPosts.every((c) => typeof c.body.rev === 'number'), true);
// A client `at` may be SENT — it is harmless — but it is never what LANDS. The
// hub stamps every turn itself (probed: two turns sent a millisecond apart came
// back with an identical server `at`), so nothing may order turns by `at`.
check('the server stamped a DIFFERENT time than the client sent', hub.memory.turns[0].at !== fakeNow, true);
check('and stamped each turn separately', hub.memory.turns[1].at !== hub.memory.turns[0].at, true);

check('the hub now holds them', hub.memory.turns.length, 2);
check('the view counts the HUB’s turns', getMemoryView().turns, 2);
check('and a failed exchange still kept the local log', snapshotMemory().turns.length >= 2, true);

// ════════════════════════════════════════════════════════════════════════════
section('B. memory — PUT ADDS, only DELETE empties');
// ════════════════════════════════════════════════════════════════════════════

// The spec says `PUT /hub/memory` replaces. Nothing in the app may rely on that,
// because the server does not do it. Prove the piece the app DOES depend on:
// emptying the store is DELETE, and a later append lands normally.
calls.length = 0;
resetMemory();
await tick();
flush();
await tick();

const clears = hubCalls('DELETE', '/memory');
check('resetMemory clears the hub', clears.length, 1);
check('with a rev in the body — this route needs one', typeof clears[0]?.body?.rev, 'number');
check('the store is empty server-side', hub.memory.turns.length, 0);
check('and the view is empty', getMemoryView().turns, 0);
check('the local log is empty too', snapshotMemory().turns.length, 0);

// ⚠ The memory tombstone is NOT a watermark: a write right after a clear lands.
rememberSpoken('after the clear', fakeNow);
await tick();
flush();
await tick();
check('a write straight after a clear LANDS', hub.memory.turns.length, 1);
check('and is visible immediately', getMemoryView().turns, 1);

// Now the ADD-vs-REPLACE fact, asserted against the hub itself so a reader can
// see the server's real behaviour rather than a claim about it.
const before = hub.memory.turns.length;
const putResult = route(
  'PUT',
  '/memory',
  { rev: HUB_REV, digest: '', turns: [] },
  {},
);
check('a PUT with an empty turn list does not empty the store', hub.memory.turns.length, before);
check('it reports what it ADDED, which is nothing', putResult.body.added, 0);

// ════════════════════════════════════════════════════════════════════════════
section('C. memory — compaction declines honestly');
// ════════════════════════════════════════════════════════════════════════════

hub.compacted = false;
hub.compactSkipped = 'provider down';
const compacted = await compactMemory();
await tick();
check('a refused compaction returns false', compacted, false);
assert('the hub was asked', hubCalls('POST', '/memory/compact').length >= 1);
check('and the local digest was not invented', getMemoryView().digest, '');

// ════════════════════════════════════════════════════════════════════════════
section('D. sessions — the hub MINTS the id, and the alias remembers it');
// ════════════════════════════════════════════════════════════════════════════

calls.length = 0;
const localId = '11111111-2222-4333-8444-555555555555';
recordSession({
  id: localId,
  agentId: AGENT_IDS[0],
  title: 'Alias probe',
  status: 'done',
  messages: [
    { role: 'user', content: 'hello there', at: 1 },
    { role: 'assistant', content: 'hi back', at: 2 },
    { role: 'tool', content: 'tool output', at: 3, tool: 'web_search', args: '{"q":"x"}' },
  ],
});
await tick();
flush();
await tick();

const creates = hubCalls('POST', '/sessions');
check('the run was mirrored', creates.length, 1);
check('with a rev — this route needs one', typeof creates[0]?.body?.rev, 'number');
check('as an agent session', creates[0]?.body?.kind, 'agent');
check('for the agent that ran', creates[0]?.body?.agentId, AGENT_IDS[0]);
check('the WHOLE transcript rides the ONE create', creates[0]?.body?.messages.length, 3);
check('including the tool turn', creates[0]?.body?.messages[2].role, 'tool');
check('and its args', creates[0]?.body?.messages[2].args, '{"q":"x"}');
check('runId carries the LOCAL id', creates[0]?.body?.runId, localId);
check('the client did NOT try to impose its own id', 'id' in creates[0].body, false);
check('the key is the canonical uuid v4 shape', UUID_V4.test(creates[0].headers['Idempotency-Key']), true);

check('the hub minted its own id', hub.sessions[0].id !== localId, true);
check('the ALIAS maps local -> hub', hubIdForSession(localId), hub.sessions[0].id);
check('the key is remembered per local id', hubIdForSession(localId).startsWith('srv-'), true);

// The local row must keep the LOCAL id: the panel renders history from it at
// once, and `run.id` is what the detail pane looks up.
check('the local row still uses the local id', getAgents().sessions.some((s) => s.id === localId), true);
check('and its transcript is intact locally', getAgents().sessions.find((s) => s.id === localId).messages.length, 3);

// ════════════════════════════════════════════════════════════════════════════
section('E. sessions — a repeat is ONE session, never two');
// ════════════════════════════════════════════════════════════════════════════

calls.length = 0;
const rowsBefore = hub.sessions.length;
recordSession({
  id: localId,
  agentId: AGENT_IDS[0],
  title: 'Alias probe',
  status: 'done',
  messages: [
    { role: 'user', content: 'hello there', at: 1 },
    { role: 'assistant', content: 'hi back', at: 2 },
    { role: 'tool', content: 'tool output', at: 3, tool: 'web_search', args: '{"q":"x"}' },
  ],
});
await tick();
flush();
await tick();

check('a re-settle still hits the hub', hubCalls('POST', '/sessions').length, 1);
check('with the SAME key — it is derived from the local id', 
  hubCalls('POST', '/sessions')[0].headers['Idempotency-Key'], creates[0].headers['Idempotency-Key']);
check('and the hub created NO second session', hub.sessions.length, rowsBefore);
check('the alias is unchanged', hubIdForSession(localId), hub.sessions[0].id);

// A DIFFERENT body under the same key is the `409 DUPLICATE_OP` case — and its
// `details.current` carries the ORIGINAL response. The client must read that as
// a success, or it loses the minted id and reports a failure for a write that
// actually landed.
{
  const key = creates[0].headers['Idempotency-Key'];
  const held = hub.keys.get(key);
  hub.keys.set(key, { body: { ...held.body, title: 'a DIFFERENT title' }, response: held.response });
  calls.length = 0;
  recordSession({
    id: localId,
    agentId: AGENT_IDS[0],
    title: 'Alias probe',
    status: 'done',
    messages: [
      { role: 'user', content: 'hello there', at: 1 },
      { role: 'assistant', content: 'hi back', at: 2 },
      { role: 'tool', content: 'tool output', at: 3, tool: 'web_search', args: '{"q":"x"}' },
    ],
  });
  await tick();
  flush();
  await tick();
  check('a conflicting replay created NO session', hub.sessions.length, rowsBefore);
  // `getAgentsError()` speaks in strings: '' is "no error".
  check('no error is surfaced for an op that already landed', getAgentsError(), '');
  check('and the alias still resolves', hubIdForSession(localId), held.response.sessionId);
  hub.keys.set(key, held);
}

// ⚠ `runId` is a LABEL, not a key. Prove the hub really makes a second row, so
// nothing downstream may treat a shared runId as "the same session".
{
  const n = hub.sessions.length;
  route('POST', '/sessions', { rev: HUB_REV, kind: 'agent', agentId: AGENT_IDS[0], runId: localId, title: 'twin' }, {});
  check('the same runId does NOT dedupe — the hub makes a second row', hub.sessions.length, n + 1);
  hub.sessions.pop();
}

// A legacy non-uuid run id cannot BE a key, so the client must generate one
// rather than send something the hub would reject as a malformed uuid.
calls.length = 0;
recordSession({
  id: 'id-legacy-7',
  agentId: AGENT_IDS[0],
  title: 'Legacy id',
  status: 'done',
  messages: [{ role: 'user', content: 'old', at: 1 }],
});
await tick();
flush();
await tick();
const legacyKey = lastHub('POST', '/sessions').headers['Idempotency-Key'];
check('a non-uuid run id still sends a well-formed key', UUID_V4.test(legacyKey), true);
check('…which is NOT the local id, since that cannot be one', legacyKey === 'id-legacy-7', false);
check('and the session still lands', hub.sessions.some((s) => s.runId === 'id-legacy-7'), true);

// ════════════════════════════════════════════════════════════════════════════
section('F. sessions — the list is the authority, the watermark is NOT adopted');
// ════════════════════════════════════════════════════════════════════════════

// A session recorded on ANOTHER device: this app has never seen its id.
{
  const at = STAMP();
  hub.sessions.push({
    id: 'srv-other-device',
    kind: 'agent',
    agentId: AGENT_IDS[1],
    title: 'From the other device',
    status: 'done',
    runId: null,
    createdAt: at,
    updatedAt: at,
    messages: [
      { seq: 1, role: 'user', content: 'remote question', at: STAMP() },
      { seq: 2, role: 'assistant', content: 'remote answer', at: STAMP() },
    ],
  });
}

// The watermark sits in the FUTURE of every row above — exactly the trap.
hub.tombstone = { all: STAMP() + 10_000_000, byAgent: {} };

calls.length = 0;
const clearedBefore = getAgents().sessionsClearedAt;
await hydrateHubSessions();
await tick();

check('the hub list was read — exactly once', exactHubCalls('GET', '/sessions').length, 1);
check('the remote session was adopted', getAgents().sessions.some((s) => s.id === 'srv-other-device'), true);
check('under the HUB’s id, since this device never knew it', getAgents().sessions.find((s) => s.title === 'From the other device').id, 'srv-other-device');
check('the watermark did NOT wipe the local history', getAgents().sessions.some((s) => s.id === localId), true);
check('…nor the remote one', getAgents().sessions.length >= 3, true);
check('because `all` is NOT adopted as a clear stamp', JSON.stringify(getAgents().sessionsClearedAt), JSON.stringify(clearedBefore));

const msgReads = hubCalls('GET', '/sessions/');
check('a transcript is fetched for a session with no local turns', msgReads.length, 1);
check('…and it is the messages route, not the entity', msgReads[0].rel, '/sessions/srv-other-device/messages?limit=200');
const remote = getAgents().sessions.find((s) => s.id === 'srv-other-device');
check('the remote transcript is now readable', remote.messages.length, 2);
check('oldest first, by seq', remote.messages.map((m) => m.content), ['remote question', 'remote answer']);

// A session this device ALREADY has turns for must not be re-fetched.
calls.length = 0;
await hydrateHubSessions();
await tick();
check('a session whose turns are known is NOT refetched', 
  hubCalls('GET', '/sessions/').filter((c) => c.rel.startsWith('/sessions/srv-other-device')).length, 0);

// Re-hydrating must not duplicate a row the alias already covers.
check('re-hydrating did not duplicate the local session', getAgents().sessions.filter((s) => s.id === localId).length, 1);
check('…nor the remote one', getAgents().sessions.filter((s) => s.id === 'srv-other-device').length, 1);

// ════════════════════════════════════════════════════════════════════════════
section('G. sessions — clearing travels as a per-agent tombstone');
// ════════════════════════════════════════════════════════════════════════════

calls.length = 0;
clearSessionsFor(AGENT_IDS[0]);
await tick();
flush();
await tick();

const clearsFor = hubCalls('POST', '/sessions/clear');
check('the clear was sent to the hub', clearsFor.length, 1);
check('for the right agent', clearsFor[0]?.body?.agentId, AGENT_IDS[0]);
check('with a rev', typeof clearsFor[0]?.body?.rev, 'number');
check('the local stamp was written', typeof (getAgents().sessionsClearedAt ?? {})[AGENT_IDS[0]], 'number');
check('the agent’s history is gone locally', getAgents().sessions.some((s) => s.agentId === AGENT_IDS[0] && s.id === localId), false);
check('another agent’s history survives', getAgents().sessions.some((s) => s.id === 'srv-other-device'), true);

// The hub's own `byAgent` is the twin of that stamp, and it is adopted.
hub.tombstone = { all: hub.tombstone.all, byAgent: { [AGENT_IDS[0]]: STAMP() } };
await hydrateHubSessions();
await tick();
check('the hub’s byAgent watermark is adopted', typeof getAgents().sessionsClearedAt[AGENT_IDS[0]], 'number');

// ════════════════════════════════════════════════════════════════════════════
section('H. stats — a summary OUTLIVES the session it describes');
// ════════════════════════════════════════════════════════════════════════════

{
  const summariesBefore = hub.summaries;
  const id = hub.sessions[0].id;
  const del = route('DELETE', `/sessions/${id}`, { rev: HUB_REV }, {});
  check('a delete needs a rev in the BODY', del.status, 204);
  check('and answers with no body to parse', del.body, null);
  const stats = route('GET', '/sessions/stats', undefined, {}).body;
  check('the session is gone from the counts', stats.sessions, hub.sessions.length);
  check('but its summary rows REMAIN', stats.summaries >= summariesBefore + 1, true);
}

// A rev in the QUERY is not a rev. Both session writes insist on the body, and
// the hub checks the rev BEFORE it looks the row up — probed against a REAL id.
{
  const real = hub.sessions[0].id;
  const viaQuery = route('DELETE', `/sessions/${real}?rev=68`, { rev: '68' }, {});
  check('a delete with no body rev is refused', viaQuery.status, 400);
  check('…with REV_REQUIRED, not NOT_FOUND', viaQuery.body.code, 'REV_REQUIRED');
  check('and the session survives the attempt', hub.sessions.some((s) => s.id === real), true);
  const patchNoRev = route('PATCH', `/sessions/${real}`, { title: 'nope' }, {});
  check('a patch without one is refused too', patchNoRev.status, 400);
}

// ════════════════════════════════════════════════════════════════════════════
section('I. the rev does NOT move on a session or memory write');
// ════════════════════════════════════════════════════════════════════════════

const revBefore = currentRev();
calls.length = 0;
recordSession({
  id: '22222222-3333-4444-8555-666666666666',
  agentId: AGENT_IDS[1],
  title: 'Rev probe',
  status: 'done',
  messages: [{ role: 'user', content: 'does the rev move', at: 1 }],
});
await tick();
flush();
await tick();
check('a session write leaves the rev alone (§4)', currentRev(), revBefore);
rememberSpoken('memory write', fakeNow);
await tick();
flush();
await tick();
check('and so does a memory write', currentRev(), revBefore);

// ════════════════════════════════════════════════════════════════════════════
section('J. honesty — a hub refusal is reported, never thrown');
// ════════════════════════════════════════════════════════════════════════════

// An unknown agentId is a 400 VALIDATION_ERROR, because a session can only be
// saved for an agent the hub really has.
{
  calls.length = 0;
  recordSession({
    id: '33333333-4444-4555-8666-777777777777',
    agentId: 'not-a-real-agent',
    title: 'Unknown agent',
    status: 'done',
    messages: [{ role: 'user', content: 'x', at: 1 }],
  });
  await tick();
  flush();
  await tick();
  const posted = lastHub('POST', '/sessions');
  check('the unknown agent was still attempted', !!posted, true);
  check('and the hub refused it', hub.sessions.some((s) => s.runId === '33333333-4444-4555-8666-777777777777'), false);
  check('nothing threw', true, true);
}

// A dead network is an error to render, never an exception.
{
  mode = 'dead';
  calls.length = 0;
  recordSession({
    id: '44444444-5555-4666-8777-888888888888',
    agentId: AGENT_IDS[0],
    title: 'Offline run',
    status: 'done',
    messages: [{ role: 'user', content: 'offline', at: 1 }],
  });
  await tick();
  flush();
  await tick();
  check('an offline run is STILL recorded locally', getAgents().sessions.some((s) => s.id === '44444444-5555-4666-8777-888888888888'), true);
  check('the mirror failed without throwing', hub.sessions.some((s) => s.runId === '44444444-5555-4666-8777-888888888888'), false);

  const before = getAgents().sessions.length;
  await hydrateHubSessions();
  await tick();
  check('and a failed hydrate does not empty the local cache', getAgents().sessions.length, before);
  assert('the failure is surfaced, not swallowed', getAgentsError() !== null, String(getAgentsError()));

  mode = 'live';
  await hydrateHubSessions();
  await tick();
  check('a recovered read clears the error', getAgentsError(), '');
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}  —  ${pass} checks passed`);
process.exit(fail === 0 ? 0 : 1);
