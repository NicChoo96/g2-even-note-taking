// Verifies the FILES store's hub semantics, by bundling the real modules (no
// re-implementation) and driving them against a small in-memory hub that mimics
// the real one's `rev`, id-minting, soft-delete and `204` behaviour. No network,
// no relay, no backend.
//
// Run: node tools/files-store-sim.mjs          (from `glasses/`)
//      SIM_QUIET=1 node tools/files-store-sim.mjs
//
// ⚠ NOT CALLED `files-sim.mjs` ON PURPOSE — that name is taken by a harness for
// the RELAY's file module (`web/server/jarvis-files.mjs`: htmlToText, tickets,
// the document policy). That suite stays valid and must keep passing, so the
// hub-backed registry gets its own file. Nor may this be `agents-sim.mjs`, which
// bundles a module this migration deleted.
//
// WHY THIS IS WORTH A HARNESS
//   `hub-client-sim.mjs` proves the TRANSPORT contract for these routes;
//   nothing proves `src/web/files-client.ts` USES it correctly. Every rule below
//   is silently wrong when it is wrong — the Files page still renders, and the
//   only symptom is an empty tab or a lost document:
//     • reading `deleted` OFF THE WIRE instead of deriving it from `deletedAt`
//       → every row files as live, so the Deleted tab is empty and the undo
//       affordance never appears. A live `file_ref` has NO `deletedAt` key at
//       all — it is ABSENT, not null — which is what makes `!== undefined` the
//       one true test.
//     • sending the wrong filter spelling: the hub honours `includeDeleted`
//       (camel), and its `?deleted=true` DOES work as an alias while the app's
//       older snake_case `include_deleted` is simply IGNORED by the hub. A
//       filter that returns the live list "successfully" is the worst kind of
//       wrong: the Deleted tab looks like a feature with nothing in it.
//     • looking for a published record under `item`/`items` — files use `file`.
//       Getting that wrong costs the new id, the only handle on the page just
//       published. (The live probe made exactly this mistake and leaked a row.)
//     • treating a `204` as parseable, or expecting a rev in it. It has neither,
//       so the client IS stale immediately after a delete and the NEXT write is a
//       certified `409`. That is expected: the queue must recover on its own.
//     • moving `readFileText` to the hub. The hub answers the RAW HTML and
//       IGNORES `limit`/`offset` (probed), so Jarvis would be handed a full HTML
//       document instead of readable, resumable prose.
//     • moving `fetchFileMedia` to the hub. The relay REBUILDS every player URL
//       from a validated id; a document is untrusted code, and passing its text
//       through could put a `javascript:` URL in an embed.
//   A tiny REAL hub is used rather than canned strings because most of these
//   depend on state — the rev the client must send next, which id the hub
//   minted, whether a row is soft-deleted — and canned replies cannot model that
//   honestly.

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
// Nothing in the files path debounces today, but `window` is referenced by the
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
async function tick(n = 8) {
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
// depends on a coincidence about where counting starts.
const hub = {
  rev: 68,
  seq: 0,
  clock: 1_700_000_000_000,
  files: [
    {
      id: 'f-live',
      title: 'Quarterly report',
      agent: 'g2-hub',
      url: 'http://167.172.77.136/sessions/f-live/html',
      size: 1200,
      tags: ['finance'],
      slug: 'quarterly-report',
      version: 2,
      updatedAt: 1_700_000_500_000,
    },
    {
      id: 'f-other',
      title: 'Design notes',
      agent: 'console',
      url: 'http://167.172.77.136/sessions/f-other/html',
      size: 300,
      tags: ['design'],
      updatedAt: 1_700_000_100_000,
    },
  ],
  /** id -> ISO string. The hub's revision entries use ISO where docs use ms. */
  revisions: new Map(),
};

hub.revisions.set('f-live', [
  {
    revision: 2,
    version: 2,
    change: 'update',
    content_changed: true,
    size: 1200,
    sha256: 'aaa',
    previous_sha256: 'bbb',
    created_at: '2026-09-24T12:08:35.325537+00:00',
    agent: 'g2-hub',
    agent_slug: 'g2-hub',
    title: 'Quarterly report',
    slug: 'quarterly-report',
    subject: 'mcp',
    tags: ['finance'],
  },
  {
    revision: 1,
    version: 1,
    change: 'create',
    content_changed: true,
    size: 900,
    sha256: 'ccc',
    previous_sha256: '',
    created_at: '2026-09-24T11:00:00.000000+00:00',
    agent: 'g2-hub',
    agent_slug: 'g2-hub',
    title: 'Quarterly report',
    slug: 'quarterly-report',
    subject: 'mcp',
    tags: ['finance'],
  },
]);

const liveFiles = () => hub.files.filter((f) => f.deletedAt === undefined);

function touchFile(f) {
  f.updatedAt = (hub.clock += 1000);
  hub.rev += 1;
}

/**
 * The hub's wire shape, EXACTLY — verified live against the real server.
 *
 * ⚠ There is NO `deleted` boolean, and `deletedAt`/`deletedReason` appear ONLY
 * on a soft-deleted row. A live row simply has no such key.
 */
const fileWire = (f) => {
  const out = {
    id: f.id,
    title: f.title,
    agent: f.agent,
    url: f.url,
    size: f.size,
    tags: [...f.tags],
    updatedAt: f.updatedAt,
    slug: f.slug,
    version: f.version,
  };
  if (f.deletedAt !== undefined) {
    out.deletedAt = f.deletedAt;
    out.deletedReason = f.deletedReason ?? null;
  }
  return out;
};

const statsWire = () => {
  const byAgent = {};
  for (const f of hub.files) byAgent[f.agent] = (byAgent[f.agent] ?? 0) + 1;
  return {
    ok: true,
    rev: hub.rev,
    total: hub.files.length,
    bytes: hub.files.reduce((n, f) => n + f.size, 0),
    deleted: hub.files.filter((f) => f.deletedAt !== undefined).length,
    byAgent,
  };
};

/** Toggles a switch a section can flip to prove a recovery path really runs. */
const patches = {
  alwaysStale: false,
  restoreEchoesFile: false,
  statsFails: false,
};

const reply = (status, body, headers = {}, bodiless = false) => ({ status, body, headers, bodiless });
const bad = (status, error, code, details = {}) => reply(status, { ok: false, error, code, details });

function header(headers, name) {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}

// ── the hub's routes ────────────────────────────────────────────────────────
function route(method, path, search, body, headers) {
  const rev = typeof body?.rev === 'number' ? body.rev : undefined;
  const requireRev = () => {
    if (rev === undefined) return bad(400, 'rev is required', 'REV_REQUIRED');
    if (patches.alwaysStale || rev !== hub.rev) {
      // The recovering value is `details.rev`, a SIBLING of `current` — the
      // document prints it nested inside `current`, and the server disagrees.
      return bad(409, 'rev is stale', 'STALE_REV', { given: rev, current: { activeDocId: null }, rev: hub.rev });
    }
    return null;
  };

  // ── list ──
  if (path === '/files' && method === 'GET') {
    const includeDeleted = search.get('includeDeleted') === 'true' || search.get('deleted') === 'true';
    const q = (search.get('q') ?? '').toLowerCase();
    const agent = search.get('agent');
    const tag = search.get('tag');
    const limit = Number(search.get('limit')) || 50;
    const offset = Number(search.get('offset')) || 0;
    let rows = includeDeleted ? hub.files.slice() : liveFiles();
    if (q) rows = rows.filter((f) => f.title.toLowerCase().includes(q));
    if (agent) rows = rows.filter((f) => f.agent === agent);
    if (tag) rows = rows.filter((f) => f.tags.includes(tag));
    const page = rows.slice(offset, offset + limit);
    return reply(200, {
      ok: true,
      rev: hub.rev,
      items: page.map(fileWire),
      limit,
      next: offset + page.length < rows.length ? String(offset + page.length) : null,
      more: offset + page.length < rows.length,
    });
  }

  // ── stats ── (must be matched BEFORE `/files/{id}`)
  if (path === '/files/stats' && method === 'GET') {
    if (patches.statsFails) return bad(500, 'stats exploded', 'INTERNAL');
    return reply(200, statsWire());
  }

  // ── publish ──
  if (path === '/files' && method === 'POST') {
    const e = requireRev();
    if (e) return e;
    const f = {
      id: body?.id ?? `f-${++hub.seq}${(hub.rev * 7).toString(16)}`,
      title: String(body?.title ?? ''),
      agent: String(body?.agent ?? ''),
      url: `http://167.172.77.136/sessions/new/html`,
      size: String(body?.html ?? '').length,
      tags: Array.isArray(body?.tags) ? body.tags.map(String) : [],
      slug: body?.slug,
      version: 1,
      updatedAt: hub.clock,
    };
    hub.files.push(f);
    touchFile(f);
    // The record is under `file` — and `updatedAt` is a SIBLING of `rev`, never
    // inside the record (the record carries its own `updatedAt` too; the hub
    // sends both).
    return reply(201, { ok: true, rev: hub.rev, file: fileWire(f), updatedAt: f.updatedAt });
  }

  // ── one reference, soft delete, hard delete ──
  const one = /^\/files\/([^/]+)$/.exec(path);
  if (one) {
    const id = decodeURIComponent(one[1]);
    const f = hub.files.find((x) => x.id === id);
    if (method === 'GET') {
      // A soft-deleted row is NOT readable: the hub answers 404, not a record
      // carrying a deleted flag.
      if (!f || f.deletedAt !== undefined) {
        return bad(404, 'file not found', 'NOT_FOUND', { id });
      }
      return reply(200, { ok: true, rev: hub.rev, file: fileWire(f) });
    }
    if (method === 'DELETE') {
      const e = requireRev();
      if (e) return e;
      if (!f) return bad(404, 'file not found', 'NOT_FOUND', { id });
      const hard = search.get('hard') === 'true';
      if (hard) hub.files = hub.files.filter((x) => x.id !== id);
      else {
        f.deletedAt = (hub.clock += 1000);
        f.deletedReason = null;
      }
      hub.rev += 1;
      // 204: NO body, and NO rev. The client is stale from here.
      return reply(204, null, {}, true);
    }
  }

  // ── restore ──
  const restore = /^\/files\/([^/]+)\/restore$/.exec(path);
  if (restore && method === 'POST') {
    const e = requireRev();
    if (e) return e;
    const id = decodeURIComponent(restore[1]);
    const f = hub.files.find((x) => x.id === id);
    if (!f) return bad(404, 'file not found', 'NOT_FOUND', { id });
    delete f.deletedAt;
    delete f.deletedReason;
    touchFile(f);
    // 200, not 201 — nothing was created. Whether a record is echoed is left
    // switchable, because the spec does not say and the client must cope with
    // either.
    return reply(200, {
      ok: true,
      rev: hub.rev,
      ...(patches.restoreEchoesFile ? { file: fileWire(f) } : {}),
    });
  }

  // ── revisions (the LIST only) ──
  const revs = /^\/files\/([^/]+)\/revisions$/.exec(path);
  if (revs && method === 'GET') {
    const id = decodeURIComponent(revs[1]);
    const items = hub.revisions.get(id) ?? [];
    return reply(200, { ok: true, rev: hub.rev, id, count: items.length, items });
  }

  // ── text / media: the hub HAS these, and they are the raw bytes / counts ──
  const text = /^\/files\/([^/]+)\/text$/.exec(path);
  if (text && method === 'GET') {
    // Deliberately reports a full-body window whatever was asked for, which is
    // what the live server does — and the reason the app must not use it.
    const id = decodeURIComponent(text[1]);
    const f = hub.files.find((x) => x.id === id);
    return reply(200, {
      ok: true,
      rev: hub.rev,
      id,
      limit: f ? f.size : 0,
      offset: 0,
      more: false,
      next: null,
      total: f ? f.size : 0,
      text: '<p>raw html, not prose</p>',
    });
  }
  const media = /^\/files\/([^/]+)\/media$/.exec(path);
  if (media && method === 'GET') {
    return reply(200, { ok: true, rev: hub.rev, id: decodeURIComponent(media[1]), count: 0, items: [] });
  }

  return reply(599, { ok: false, error: `UNSCRIPTED ${method} ${path}`, code: 'UNSCRIPTED' });
}

// ── the relay's own routes ──────────────────────────────────────────────────
// Only the DERIVATIONS are here, plus the two routes the hub has no equivalent
// for. Reading anything else off this server is the bug these sections exist to
// catch, so an unscripted relay path is a 599 rather than a tolerant 200.
const READABLE = 'The quarterly report is ready. Revenue rose four per cent.';

function relayRoute(method, path, search, body) {
  if (path === '/api/files/status') {
    return reply(200, { ok: true, configured: true, mode: 'password', url: 'http://167.172.77.136' });
  }
  if (path === '/api/stream') {
    return reply(200, { ok: true, relay: true });
  }

  const text = /^\/api\/files\/([^/]+)\/text$/.exec(path);
  if (text && method === 'GET') {
    const offset = Number(search.get('offset')) || 0;
    const limit = Number(search.get('limit')) || READABLE.length;
    const slice = READABLE.slice(offset, offset + limit);
    const next = offset + slice.length < READABLE.length ? offset + slice.length : null;
    return reply(200, { ok: true, text: slice, offset, total: READABLE.length, next, more: next !== null });
  }

  const media = /^\/api\/files\/([^/]+)\/media$/.exec(path);
  if (media && method === 'GET') {
    return reply(200, {
      ok: true,
      media: [
        {
          provider: 'youtube',
          label: 'A video',
          id: 'dQw4w9WgXcQ',
          thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg',
          embed: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
          watch: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      ],
    });
  }

  const ticket = /^\/api\/files\/([^/]+)\/ticket$/.exec(path);
  if (ticket && method === 'POST') {
    return reply(200, { ok: true, url: `http://docs.test/d/${ticket[1]}.99999.sig` });
  }

  const one = /^\/api\/files\/([^/]+)$/.exec(path);
  if (one && method === 'PATCH') {
    return reply(200, {
      ok: true,
      document: {
        id: decodeURIComponent(one[1]),
        title: body?.title ?? 'patched',
        agent: 'g2-hub',
        slug: 'x',
        tags: [],
        version: 2,
        size: 10,
        url: 'http://167.172.77.136/sessions/x/html',
        updatedAt: 1,
        deleted: false,
        deletedAt: null,
      },
    });
  }

  const oneRev = /^\/api\/files\/([^/]+)\/revisions\/(\d+)$/.exec(path);
  if (oneRev && method === 'GET') {
    return reply(200, {
      ok: true,
      revision: {
        id: decodeURIComponent(oneRev[1]),
        revision: Number(oneRev[2]),
        version: Number(oneRev[2]),
        change: 'create',
        title: 'Quarterly report',
        agent: 'g2-hub',
        size: 900,
        contentChanged: true,
        createdAt: 1_700_000_000_000,
        tags: ['finance'],
      },
    });
  }

  const oneRevRestore = /^\/api\/files\/([^/]+)\/revisions\/(\d+)\/restore$/.exec(path);
  if (oneRevRestore && method === 'POST') {
    return reply(200, {
      ok: true,
      revision: {
        id: decodeURIComponent(oneRevRestore[1]),
        revision: Number(oneRevRestore[2]),
        version: Number(oneRevRestore[2]),
        change: 'restore',
        title: 'Quarterly report',
        agent: 'g2-hub',
        size: 900,
        contentChanged: true,
        createdAt: 1_700_000_000_000,
        tags: ['finance'],
      },
    });
  }

  return reply(599, { ok: false, error: `UNSCRIPTED RELAY ${method} ${path}`, code: 'UNSCRIPTED' });
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

let mode = 'hub';
let nextFailure = null;
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? 'GET';
  const isHub = u.pathname.startsWith('/api/hub');
  const record = {
    method,
    hub: isHub,
    path: u.pathname,
    search: u.searchParams,
    headers: init.headers ?? {},
    body: init.body === undefined ? undefined : JSON.parse(init.body),
    status: 0,
    bodyRead: false,
  };
  calls.push(record);

  // A dead network REJECTS. It does not return a fake object — the client reads
  // response headers, so a hand-rolled stub throws inside it.
  if (mode === 'dead') throw new TypeError('fetch failed');
  if (nextFailure) {
    const f = nextFailure;
    nextFailure = null;
    // A one-shot failure on a hub route, so a retry can be proven either way.
    return respond(f.spec, record);
  }

  if (!isHub) return respond(relayRoute(method, u.pathname, u.searchParams, record.body), record);
  const path = u.pathname.replace(/^\/api\/hub/, '');
  return respond(route(method, path, u.searchParams, record.body, record.headers), record);
};

// ── ledger helpers ──────────────────────────────────────────────────────────
const hubCalls = (method, prefix) => calls.filter((c) => c.hub && c.method === method && c.path.replace(/^\/api\/hub/, '').startsWith(prefix));
const relayCalls = (method, prefix) => calls.filter((c) => !c.hub && c.method === method && c.path.startsWith(prefix));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── bundle the real modules ─────────────────────────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'files-store-sim-'));
const outfile = join(out, 'files.mjs');
await build({
  stdin: {
    // One bundle, so the harness and the store share ONE auth-token instance.
    contents: `
export * from './web/files-client.ts';
export { currentRev } from './web/hub-client.ts';
export { setStreamToken } from './auth-token.ts';
export { filesCapabilities } from './ai/capabilities/files.ts';
export { getState } from './store.ts';
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

const mod = await import(pathToFileURL(outfile).href);
const {
  SELF_AGENT,
  currentRev,
  deleteFile,
  fetchDocTicket,
  fetchFileMedia,
  fetchFileStats,
  fetchFilesStatus,
  fileBodyUrl,
  filesCapabilities,
  getState,
  listFiles,
  listRevisions,
  publishFile,
  readFile,
  readFileText,
  readRevision,
  restoreFile,
  restoreRevision,
  setStreamToken,
  updateFile,
} = mod;
setStreamToken('test-token');

const capability = (name) => filesCapabilities.find((c) => c.name === name);

// ═══════════════════════════════════════════════════════════════════════════
section('A. the registry is the hub’s');
// ═══════════════════════════════════════════════════════════════════════════
check('nothing has been fetched yet', calls.length, 0);
const listed = await listFiles();
check('the list came from the hub', hubCalls('GET', '/files').length, 1);
check('…on the proxied prefix, not a direct backend call', calls[0].path, '/api/hub/files');
check('the request was authorised', header(calls[0].headers, 'authorization'), 'Bearer test-token');
check('it succeeded', listed.ok, true);
check('with every reference', listed.items.length, 2);
check('newest first, as the hub sends them', listed.items[0].id, 'f-live');
check('a title survives the trip', listed.items[0].title, 'Quarterly report');
check('the size is the hub’s number', listed.items[0].size, 1200);
check('the tags are the hub’s list', listed.items[0].tags, ['finance']);
check('the slug is the hub’s', listed.items[0].slug, 'quarterly-report');
check('the version is the hub’s', listed.items[0].version, 2);
check('the url is the hub’s reference', listed.items[0].url, 'http://167.172.77.136/sessions/f-live/html');
check(
  'a row the hub left slugless reads as an empty slug, not undefined',
  listed.items[1].slug,
  '',
);
check('…and a row with no version reads as v1', listed.items[1].version, 1);
check('`total` is this page’s length — the hub reports no total for a list', listed.total, 2);
check('`hasMore` mirrors the hub’s `more`', listed.hasMore, false);
check('a live row is NOT deleted', listed.items[0].deleted, false);
check('…and carries no deletedAt', listed.items[0].deletedAt, null);
check(
  'the client learned the hub’s rev from the read',
  currentRev(),
  hub.rev,
  `${currentRev()} vs ${hub.rev}`,
);

// ═══════════════════════════════════════════════════════════════════════════
section('B. `deleted` is DERIVED, and the filter spelling matters');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const withGone = await listFiles({ includeDeleted: true });
check('one read answers both questions', hubCalls('GET', '/files').length, 1);
check('the hub is asked with ITS spelling', calls[0].search.get('includeDeleted'), 'true');
check('…and never the app’s older snake_case', calls[0].search.get('include_deleted'), null);
check('both rows come back', withGone.items.length, 2);

// Park one row, the way the hub does it: a timestamp appears.
const parked = hub.files.find((f) => f.id === 'f-live');
parked.deletedAt = (hub.clock += 1000);
parked.deletedReason = null;
hub.rev += 1;

calls.length = 0;
const afterDelete = await listFiles({ includeDeleted: true });
const liveAfter = afterDelete.items.filter((d) => !d.deleted);
const goneAfter = afterDelete.items.filter((d) => d.deleted);
check('a soft-deleted row is READ as deleted', goneAfter.length, 1);
check('…by its id', goneAfter[0]?.id, 'f-live');
check('and it leaves the live list', liveAfter.length, 1);
check('the surviving live row is the other one', liveAfter[0].id, 'f-other');
check('a deleted row keeps its timestamp', goneAfter[0].deletedAt, parked.deletedAt);

// The trap: ask the way the hub does NOT honour, and the deleted row vanishes
// silently — a filter that "works" and returns the wrong list.
calls.length = 0;
const wrongSpelling = await listFiles({ includeDeleted: false });
check('the plain list hides the parked row', wrongSpelling.items.length, 1);
check('…and looks perfectly successful doing it', wrongSpelling.ok, true);

// ═══════════════════════════════════════════════════════════════════════════
section('C. a read is metadata only, and a deleted row is a 404');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const one = await readFile('f-other');
check('the read went to the hub', hubCalls('GET', '/files/f-other').length, 1);
check('…and asked for nothing else', calls.length, 1);
check('it succeeded', one.ok, true);
check('with the record', one.document?.title, 'Design notes');
check('and NO body — there is no content column', 'content' in (one.document ?? {}), false);

calls.length = 0;
const gone = await readFile('f-live');
check('a soft-deleted reference reads as a failure', gone.ok, false);
check('…with the hub’s own message', gone.error, 'file not found');
check('…and no document', gone.document, undefined);

// ═══════════════════════════════════════════════════════════════════════════
section('D. publish — the record is under `file`, and contentType has no column');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
// Captured BEFORE the write: the client stamps the rev it has learned, which the
// parked row above has already moved on from.
const revBeforePublish = currentRev();
const published = await publishFile({
  html: '<p>a fresh page</p>',
  title: 'A fresh page',
  tags: ['g2-hub'],
});
check('the write went to the hub', hubCalls('POST', '/files').length, 1);
check('it succeeded', published.ok, true);
const post = calls[0];
check('the body carries the html', post.body.html, '<p>a fresh page</p>');
check('the body carries the title', post.body.title, 'A fresh page');
check('the body claims no content type — the hub has no such column', 'contentType' in post.body, false);
check('…and no content_type either', 'content_type' in post.body, false);
check('the tags survive', post.body.tags, ['g2-hub']);
check('the author is this app', post.body.agent, SELF_AGENT);
check('the client stamped the rev it had learned', post.body.rev, revBeforePublish);
check(
  'the write carried a canonical uuid v4 idempotency key',
  UUID_V4.test(header(post.headers, 'idempotency-key') ?? ''),
  true,
  header(post.headers, 'idempotency-key'),
);
// ⚠ The hub MINTS the id; the app must take the one it is handed, so the test
// asserts against the row the hub actually created rather than a guess.
const mintedId = hub.files[hub.files.length - 1].id;
check('the new id came back — from `file`, where the hub puts it', published.document?.id, mintedId);
check('…and it is not something this app invented', mintedId.startsWith('f-'), true, mintedId);
check('…with its title', published.document?.title, 'A fresh page');
check('…and it is live', published.document?.deleted, false);
check('the write moved the hub’s rev', hub.rev, 70);

// ═══════════════════════════════════════════════════════════════════════════
section('E. delete — soft by default, and a `204` leaves the client stale');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const soft = await deleteFile('f-other');
check('one request', calls.length, 1);
check('it is a DELETE on the hub', calls[0].method, 'DELETE');
check('…without the hard flag', calls[0].search.get('hard'), null);
check('…carrying a rev', typeof calls[0].body.rev, 'number');
check('it succeeded', soft.ok, true);
check('reported as soft', soft.hard, false);
check('and gone from the live list', soft.deleted, true);
check('the hub answered 204', calls[0].status, 204);
check('…whose body was NEVER read', calls[0].bodyRead, false);

calls.length = 0;
const purged = await deleteFile(mintedId, true);
check('the hard delete also succeeded', purged.ok, true);
check('reported as hard', purged.hard, true);
const hardCalls = calls.filter((c) => c.path === `/api/hub/files/${mintedId}`);
check('a 204 carries NO rev, so the next write is a certified stale refusal', hardCalls[0].status, 409);
check('…which the queue retries rather than surfacing', hardCalls.length, 2);
check('the retry is the one that lands', hardCalls[1].status, 204);
check('…with the hard flag', hardCalls[1].search.get('hard'), 'true');
check('…and re-stamped with the rev the hub reported', hardCalls[1].body.rev, hardCalls[0].body.rev + 1);

// ═══════════════════════════════════════════════════════════════════════════
section('F. restore — 200, not 201, and it must not claim a failure');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const back = await restoreFile('f-other');
// TWO calls, and that is the point: the `204` before it could not carry a rev,
// so the first attempt is a stale refusal the queue recovers from.
check('the restore went to the hub', hubCalls('POST', '/files/f-other/restore').length, 2);
check('it succeeded', back.ok, true);
check('the row is live again', hub.files.find((f) => f.id === 'f-other')?.deletedAt, undefined);
const restoreCalls = calls.filter((c) => c.path === '/api/hub/files/f-other/restore');
check('a 409 first, from the rev the `204` could not carry', restoreCalls[0].status, 409);
check('then the real one, now that the hub echoes the record', restoreCalls.at(-1).status, 200);
check('the title came back', back.document?.title, 'Design notes');

calls.length = 0;
patches.restoreEchoesFile = true;
const back2 = await restoreFile('f-other');
check('an echoed record is used directly', back2.document?.title, 'Design notes');
check('…with a single read for the whole restore', hubCalls('GET', '/files/f-other').length, 0);
patches.restoreEchoesFile = false;

// ═══════════════════════════════════════════════════════════════════════════
section('G. revisions — the LIST moved to the hub');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const history = await listRevisions('f-live');
check('the history came from the hub', hubCalls('GET', '/files/f-live/revisions').length, 1);
check('…and NOT from the relay', relayCalls('GET', '/api/files/f-live/revisions').length, 0);
check('it succeeded', history.ok, true);
check('count stands in for total', history.total, 2);
check('the hub pages nothing, so there is no next page', history.hasMore, false);
check('newest first, as the hub sends them', history.items[0].revision, 2);
check('`content_changed` becomes contentChanged', history.items[0].contentChanged, true);
// The hub sends an ISO STRING here where every other route sends ms. Callers
// hand this straight to `new Date(...)`, so it must be a number.
check('the ISO timestamp is parsed to ms', history.items[0].createdAt, Date.parse('2026-09-24T12:08:35.325537+00:00'));
check('…so it is a number, not the raw string', typeof history.items[0].createdAt, 'number');
check('the change kind survives', history.items[0].change, 'update');
check('the subject survives', history.items[0].subject, 'mcp');
check('the agent survives', history.items[0].agent, 'g2-hub');
check('the id the entry lacks is the file’s', history.items[0].id, 'f-live');

// The hub accepts NO revision filters, so they are applied here — otherwise a
// caller asking "what has anything deleted?" would silently get everything.
calls.length = 0;
const creates = await listRevisions('f-live', { change: 'create' });
check('a change filter still narrows the list', creates.items.length, 1);
check('…to the right entry', creates.items[0].revision, 1);
check('…without a second request', calls.length, 1);
check('…and `total` reflects the filtered set', creates.total, 1);
const asc = await listRevisions('f-live', { order: 'revision_asc' });
check('an ascending order reverses', asc.items[0].revision, 1);
const windowed = await listRevisions('f-live', { limit: 1, offset: 1 });
check('a window slices', windowed.items.length, 1);
check('…from the offset', windowed.items[0].revision, 1);
check('…and says when there is more', windowed.hasMore, false);

// ═══════════════════════════════════════════════════════════════════════════
section('H. stats — five hub numbers, and nothing invented');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const stats = await fetchFileStats();
check('the totals came from the hub', hubCalls('GET', '/files/stats').length, 1);
check('…before the one-record route could match it', calls[0].path, '/api/hub/files/stats');
check('it succeeded', stats.ok, true);
check('live + deleted is the total', stats.sessions, hub.files.length);
check('live is the total minus the deleted', stats.live_sessions, hub.files.length - 1);
check('the deleted count is reported separately', stats.deleted_sessions, 1);
check('the byte total is the hub’s', stats.bytes, hub.files.reduce((n, f) => n + f.size, 0));
check('agents are the distinct publishers, off byAgent', stats.agents, Object.keys(statsWire().byAgent).length);
check('a field the hub does not report is NOT invented', stats.tags, undefined);
check('…nor is an archive-wide revision count', stats.revisions, undefined);

calls.length = 0;
const scoped = await fetchFileStats('f-live');
check('a per-document ask uses that document’s revisions', hubCalls('GET', '/files/f-live/revisions').length, 1);
check('…and reports the count', scoped.revisions, 2);
check('…without a hub stats read', hubCalls('GET', '/files/stats').length, 0);

calls.length = 0;
patches.statsFails = true;
const broken = await fetchFileStats();
check('a hub fault is a failure, not zeros', broken.ok, false);
check('…carrying the hub’s message', broken.error, 'stats exploded');
patches.statsFails = false;

// ═══════════════════════════════════════════════════════════════════════════
section('I. the derivations STAY on the relay');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const window = await readFileText('f-live', { offset: 5, limit: 7 });
check('text comes from the relay', relayCalls('GET', '/api/files/f-live/text').length, 1);
check('…and NEVER from the hub', hubCalls('GET', '/files/f-live/text').length, 0);
check('the window is passed through', calls[0].search.get('limit'), '7');
check('…including the offset', calls[0].search.get('offset'), '5');
check('the text is readable prose, not markup', window.text, READABLE.slice(5, 12));
check('the resume offset is the relay’s', window.next, 12);
check('…and it says there is more', window.more, true);

calls.length = 0;
await fetchFileMedia('f-live');
check('media comes from the relay, where the URLs are rebuilt', relayCalls('GET', '/api/files/f-live/media').length, 1);
check('…and never from the hub’s own media route', hubCalls('GET', '/files/f-live/media').length, 0);

calls.length = 0;
const ticket = await fetchDocTicket('f-live');
check('a frame ticket comes from the relay', relayCalls('POST', '/api/files/f-live/ticket').length, 1);
check('it is a POST', calls[0].method, 'POST');
check('and yields a url', ticket.ok, true);

const body = fileBodyUrl('f-live');
check('the sandboxed body url is the relay’s', body.startsWith('http://relay.test/api/files/f-live/html?token='), true, body);

calls.length = 0;
const patched = await updateFile('f-other', { title: 'Renamed' });
check('a metadata PATCH still goes to the gateway', relayCalls('PATCH', '/api/files/f-other').length, 1);
check('…because the hub has no PATCH for a file', hubCalls('PATCH', '/files/f-other').length, 0);
check('…and it succeeded', patched.ok, true);
check('…returning the document', patched.document?.title, 'Renamed');

calls.length = 0;
await readRevision('f-live', 1);
check('one past revision is read from the relay', relayCalls('GET', '/api/files/f-live/revisions/1').length, 1);
check('…because the hub has no per-revision route', hubCalls('GET', '/files/f-live/revisions/1').length, 0);

calls.length = 0;
await restoreRevision('f-live', 1);
check('restoring a past revision is a relay POST', relayCalls('POST', '/api/files/f-live/revisions/1/restore').length, 1);
check('…and never a hub call', calls.filter((c) => c.hub).length, 0);

calls.length = 0;
const status = await fetchFilesStatus();
check('the configuration probe is still the relay’s', relayCalls('GET', '/api/files/status').length, 1);
check('…and reports the credential', status.configured, true);

// ═══════════════════════════════════════════════════════════════════════════
section('J. a dead network is an error to render, never a throw');
// ═══════════════════════════════════════════════════════════════════════════
mode = 'dead';
const offlineList = await listFiles();
check('the list fails honestly', offlineList.ok, false);
check('…without an exception', offlineList.error, 'fetch failed');
check('…and an empty list rather than undefined items', offlineList.items, []);
check('the same for a read', (await readFile('f-other')).ok, false);
check('the same for a write', (await deleteFile('f-other')).ok, false);
mode = 'hub';
await tick();

// ═══════════════════════════════════════════════════════════════════════════
section('K. the capability layer reads the new keys');
// ═══════════════════════════════════════════════════════════════════════════
check('the history capability exists', typeof capability('files.history')?.run, 'function');
const capStats = await capability('files.history').run({});
check('it answers', capStats.ok, true);
check(
  'the summary counts live documents, not every row',
  capStats.summary,
  `${hub.files.length - 1} document(s), 1 deleted, ${(hub.files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(0)} KB stored`,
  capStats.summary,
);
check('the data reports live documents', capStats.data.documents, hub.files.length - 1);
check('…and the deleted count', capStats.data.deleted, 1);
check('…and the distinct publishers', capStats.data.agents, Object.keys(statsWire().byAgent).length);
check(
  'the hint points at the restore affordance',
  typeof capStats.hint === 'string' && capStats.hint.includes('restore'),
  true,
);

calls.length = 0;
const capList = await capability('files.list').run({});
check('a list still asks the hub', hubCalls('GET', '/files').length, 1);
check('…with the tool’s cap as the limit', calls[0].search.get('limit'), '40');
check('it answers', capList.ok, true);
check('the refs were mirrored for the glasses', getState().sections.files.length, hub.files.length - 1);
check(
  '…and a deleted document is NOT among them',
  getState().sections.files.some((f) => f.id === 'f-live'),
  false,
);

// A request the hub cannot answer must not be reported as an empty library.
calls.length = 0;
const capSearch = await capability('files.list').run({ query: 'quarterly' });
check('a search is forwarded', calls[0].search.get('q'), 'quarterly');
check('…under the hub’s own parameter name', calls[0].search.get('query'), null);
check('…and answers', capSearch.ok, true);

// ═══════════════════════════════════════════════════════════════════════════
flush();
await tick();
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}  —  ${pass} checks passed`);
process.exit(fail === 0 ? 0 : 1);
