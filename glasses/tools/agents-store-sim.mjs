// Verifies the AGENTS/TOOLS store's hub semantics, by bundling the real module
// (no re-implementation) and driving it against a small in-memory hub that
// mimics the real one's `rev`, `ETag`, `If-Match` and id-minting rules. No
// network, no relay, no backend.
//
// Run: node tools/agents-store-sim.mjs        (from `glasses/`)
//      SIM_QUIET=1 node tools/agents-store-sim.mjs
//
// ⚠ NOT CALLED `agents-sim.mjs` ON PURPOSE — that name is taken by a harness that
// bundles `src/agents.ts`, a module this migration deleted, so it fails before
// it tests anything. It is pre-existing and must not be "fixed" from here.
//
// WHY THIS IS WORTH A HARNESS
//   `hub-client-sim.mjs` proves the TRANSPORT contract for these routes and
//   nothing proves `src/agents-store.ts` USES it correctly. Every rule below is
//   silently wrong when it is wrong — the panel still renders:
//     • adopting the hub's catalogue without re-attaching `bodyTemplate`,
//       `hasToken` and `model` → a boot silently erases every REST tool's
//       parameter shape, the token indicator, and every per-agent model. All
//       three are OPTIONAL fields, so nothing looks broken.
//     • adopting the hub's `llm` → the working relay-owned model choice is
//       overwritten by the hub's `{provider:"deepseek", hasKey:false}`.
//     • a `PUT` without the etag → `412` on the NORMAL first-save path, because
//       `GET /hub/agents` carries NO per-agent etag. The edit is lost.
//     • an un-debounced `PUT` per keystroke → a burst of `If-Match` failures.
//     • using the id a seed carried as if the hub had minted it → the next
//       reference names a row that has never existed.
//     • `restoreAgents` re-sending the whole snapshot instead of the diff → an
//       undo rewrites every agent, and resurrects rows another device deleted.
//     • a failure empty()ing the list → a flaky network blanks the agents page.
//   A tiny REAL hub is used rather than canned strings because most of these
//   depend on state — the etag the client must echo, the rev it must send next,
//   which id the hub minted — and canned replies cannot model that honestly.

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
async function tick(n = 8) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

// ── localStorage, pre-seeded so ADOPTION has local fields to preserve ───────
// This is the whole point of section B: the cache holds three things the hub
// cannot (`bodyTemplate`, `hasToken`, `model`) plus a relay-owned `llm`, and the
// boot read must not destroy any of them.
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
  clear: () => ls.clear(),
};
ls.set(
  'hub:agents',
  JSON.stringify({
    agents: [
      {
        id: 'a1',
        name: 'Alpha',
        systemPrompt: 'cached role',
        prompt: 'cached task',
        toolIds: ['t1'],
        // No hub column for this — it must survive the adoption.
        model: 'cached-model-override',
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    tools: [
      {
        id: 't1',
        name: 'tool_http',
        kind: 'http',
        description: 'cached rest tool',
        url: 'https://cached.invalid',
        method: 'POST',
        // No hub column under ANY of six probed spellings.
        bodyTemplate: '{"from":"cache"}',
        // A RELAY fact: in this app it means the relay holds a credential.
        hasToken: true,
      },
    ],
    // Relay-owned and working. The hub's copy is `provider:"deepseek"`.
    llm: { provider: 'openrouter', model: 'relay-model', title: 'G2 Even Reality Hub', hasKey: true },
    sessions: [],
  }),
);

// ── the mini hub ────────────────────────────────────────────────────────────
const calls = [];

let mode = 'hub'; // 'hub' | 'dead'
let nextFailure = null;
/**
 * One-shot 412 injection, as the code the server really sends (`IF_MATCH_FAILED`
 * / `IF_MATCH_REQUIRED`). It also BUMPS the row first, because a 412 only means
 * anything if the etag the client holds is now wrong — which is what another
 * device writing in the meantime does.
 */
let force412 = '';
const patches = { toolWriteMovesRev: false, alwaysIfMatchFails: false };

const hub = {
  rev: 50,
  seq: 0,
  clock: 1_700_000_000_000,
  /** id -> quoted etag. NEVER sent in a body: `GET /hub/agents` carries no etag. */
  etags: new Map(),
  agents: [
    {
      id: 'a1',
      name: 'Alpha',
      systemPrompt: 'hub role',
      prompt: 'hub task',
      toolIds: ['t1'],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'a3',
      name: 'Third',
      systemPrompt: 'third role',
      prompt: 'third task',
      toolIds: [],
      createdAt: 2,
      updatedAt: 2,
    },
  ],
  tools: [
    {
      id: 't1',
      name: 'tool_http',
      kind: 'http',
      description: 'hub rest tool',
      url: 'https://hub.invalid',
      method: 'POST',
      searchDepth: 'basic',
    },
    // The hub holds its own web-search row, minted by the hub — which is why the
    // local seed's id (`tool-web`) is a RELAY handle and not a hub id.
    { id: 't-web', name: 'web_search', kind: 'web', description: 'Search the web', searchDepth: 'basic' },
  ],
  llm: {
    provider: 'deepseek',
    model: 'deepseek-flash',
    referer: '',
    title: 'G2 Even Reality Hub',
    hasKey: false,
  },
};

const reply = (status, body, headers = {}, bodiless = false) => ({ status, body, headers, bodiless });
const bad = (status, error, code, details = {}) => reply(status, { ok: false, error, code, details });

function touchAgent(a) {
  a.updatedAt = ++hub.clock;
  hub.etags.set(a.id, `"${a.updatedAt}:h${++hub.seq}"`);
  hub.rev += 1;
}

function touchTool(t) {
  hub.clock += 1;
  t.updatedAt = hub.clock;
  if (patches.toolWriteMovesRev) hub.rev += 1;
}

for (const a of hub.agents) hub.etags.set(a.id, `"${a.updatedAt}:h${++hub.seq}"`);

// The hub's wire shape, EXACTLY — verified live against the real server.
const agentWire = (a) => ({
  id: a.id,
  name: a.name,
  systemPrompt: a.systemPrompt,
  prompt: a.prompt,
  toolIds: [...a.toolIds],
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

const toolWire = (t) => {
  const out = {
    id: t.id,
    name: t.name,
    kind: t.kind,
    description: t.description,
  };
  if (t.url !== undefined) out.url = t.url;
  if (t.method !== undefined) out.method = t.method;
  if (t.searchDepth !== undefined) out.searchDepth = t.searchDepth;
  // Always reported, always false on the hub — the flag this app renders means
  // something else entirely (a relay-held credential).
  out.hasToken = false;
  return out;
};

const catalogue = () => ({
  ok: true,
  rev: hub.rev,
  agents: hub.agents.map(agentWire),
  tools: hub.tools.map(toolWire),
  llm: { ...hub.llm },
  updatedAt: hub.clock,
});

function header(headers, name) {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}

/**
 * The two 412s the hub really sends — and both carry the recovering etag under
 * `details`, QUOTED. Stripping the quotes is what turns a recoverable 412 into a
 * permanent failure.
 */
let last412Etag = '';
function ifMatch412(code, id) {
  const a = hub.agents.find((x) => x.id === id);
  const etag = a ? hub.etags.get(a.id) : undefined;
  // Remember it: the hub re-mints the etag on the successful retry, so the
  // handback value cannot be recovered afterwards.
  if (etag) last412Etag = etag;
  return bad(412, 'If-Match failed', code, {
    current: a ? agentWire(a) : null,
    etag,
  });
}

const AGENT_BODY_KEYS = ['name', 'systemPrompt', 'prompt', 'toolIds'];

function route(method, rel, body, headers) {
  const rev = typeof body?.rev === 'number' ? body.rev : undefined;
  const requireRev = () => {
    if (rev === undefined) return bad(400, 'rev is required', 'REV_REQUIRED');
    if (rev !== hub.rev) return bad(409, 'rev is stale', 'STALE_REV', { given: rev, rev: hub.rev });
    return null;
  };

  // ── the catalogue: agents + tools + llm in ONE read ──
  if (rel === '/agents') {
    if (method === 'GET') return reply(200, catalogue());
    if (method === 'POST') {
      const e = requireRev();
      if (e) return e;
      // `name` is the only field the hub requires — anything else may be absent.
      const a = {
        id: `ag-${++hub.seq}`,
        name: String(body?.name ?? ''),
        systemPrompt: String(body?.systemPrompt ?? ''),
        prompt: String(body?.prompt ?? ''),
        toolIds: Array.isArray(body?.toolIds) ? body.toolIds.filter((x) => typeof x === 'string') : [],
        createdAt: hub.clock,
        updatedAt: hub.clock,
      };
      // `model` has no column. Sending it is not an error; it simply evaporates.
      hub.agents.push(a);
      touchAgent(a);
      return reply(201, catalogue());
    }
  }

  const agentClone = /^\/agents\/([^/]+)\/clone$/.exec(rel);
  if (agentClone && method === 'POST') {
    const e = requireRev();
    if (e) return e;
    const src = hub.agents.find((a) => a.id === decodeURIComponent(agentClone[1]));
    if (!src) return bad(404, 'no such agent', 'NOT_FOUND');
    const copy = {
      ...src,
      id: `ag-${++hub.seq}`,
      name: `${src.name} (copy)`,
      toolIds: [...src.toolIds],
      createdAt: hub.clock,
      updatedAt: hub.clock,
    };
    hub.agents.push(copy);
    touchAgent(copy);
    return reply(201, catalogue());
  }

  const agentOne = /^\/agents\/([^/]+)$/.exec(rel);
  if (agentOne) {
    const id = decodeURIComponent(agentOne[1]);
    const a = hub.agents.find((x) => x.id === id);
    if (!a) return bad(404, 'no such agent', 'NOT_FOUND');
    if (method === 'GET') {
      // The ONLY agent read that carries an etag.
      return reply(200, { ok: true, rev: hub.rev, agent: agentWire(a) }, { etag: hub.etags.get(id) });
    }
    if (method === 'PUT') {
      // Guarded by If-Match, NOT by a rev. Whole-agent last-write-wins.
      const match = header(headers, 'If-Match');
      if (!match) return ifMatch412('IF_MATCH_REQUIRED', id);
      if (patches.alwaysIfMatchFails) {
        // Someone else wins the race every single time.
        touchAgent(a);
        return ifMatch412('IF_MATCH_FAILED', id);
      }
      if (match !== hub.etags.get(id)) return ifMatch412('IF_MATCH_FAILED', id);
      if (force412) {
        const f = force412;
        force412 = '';
        touchAgent(a); // a second device landed a write in between
        return ifMatch412(f, id);
      }
      for (const k of AGENT_BODY_KEYS) if (k in (body ?? {})) a[k] = body[k];
      touchAgent(a);
      return reply(200, catalogue(), { etag: hub.etags.get(id) });
    }
    if (method === 'DELETE') {
      const e = requireRev();
      if (e) return e;
      hub.agents = hub.agents.filter((x) => x.id !== id);
      hub.etags.delete(id);
      hub.rev += 1;
      hub.clock += 1;
      return reply(200, catalogue());
    }
  }

  // ── tools: every write needs a rev and NONE of them moves it ──
  if (rel === '/tools') {
    if (method === 'GET') return reply(200, { ok: true, rev: hub.rev, items: hub.tools.map(toolWire) });
    if (method === 'POST') {
      const e = requireRev();
      if (e) return e;
      // THE HUB MINTS THE ID. Everything else about the row is echoed back minus
      // `bodyTemplate`, which has no column under any probed spelling.
      const t = {
        id: `tool-${++hub.seq}`,
        name: String(body?.name ?? ''),
        kind: String(body?.kind ?? 'http'),
        description: String(body?.description ?? ''),
      };
      if (typeof body?.url === 'string') t.url = body.url;
      if (typeof body?.method === 'string') t.method = body.method;
      if (typeof body?.searchDepth === 'string') t.searchDepth = body.searchDepth;
      hub.tools.push(t);
      touchTool(t);
      return reply(201, { ok: true, rev: hub.rev, items: hub.tools.map(toolWire) });
    }
  }

  const toolOne = /^\/tools\/([^/]+)$/.exec(rel);
  if (toolOne) {
    const id = decodeURIComponent(toolOne[1]);
    const t = hub.tools.find((x) => x.id === id);
    if (method === 'PUT') {
      const e = requireRev();
      if (e) return e;
      if (!t) return bad(404, 'no such tool', 'NOT_FOUND');
      // A field left OUT is left alone. A field set to `null` is ALSO left
      // alone — the document says otherwise and the server does not.
      for (const [k, v] of Object.entries(body ?? {})) {
        if (k === 'rev' || v === null) continue;
        t[k] = v;
      }
      touchTool(t);
      return reply(200, { ok: true, rev: hub.rev, items: hub.tools.map(toolWire) });
    }
    if (method === 'DELETE') {
      const e = requireRev();
      if (e) return e;
      // HARD, and `agent_tool` cascades — no agent may keep a dangling id.
      hub.tools = hub.tools.filter((x) => x.id !== id);
      for (const a of hub.agents) a.toolIds = a.toolIds.filter((x) => x !== id);
      return reply(200, { ok: true, rev: hub.rev, items: hub.tools.map(toolWire) });
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
  const record = { method, rel, path: u.pathname, headers, body, status: 0, bodyRead: false };
  calls.push(record);

  // A dead network REJECTS. It does not return a fake object — the client reads
  // response headers, so a hand-rolled stub throws inside it.
  if (mode === 'dead') throw new TypeError('fetch failed');
  if (nextFailure) {
    const f = nextFailure;
    nextFailure = null;
    return respond(f, record);
  }

  // A relative publish URL (`/api/stream?channel=agents`) is NOT a hub route:
  // the store mirrors to the relay on a best-effort basis and that must never
  // stand in for a hub write.
  if (!u.pathname.startsWith('/api/hub')) {
    return respond(reply(200, { ok: true, relay: true }), record);
  }
  return respond(route(method, rel, body, headers), record);
};

// ── ledger helpers ──────────────────────────────────────────────────────────
/** Every call whose route STARTS with `prefix` (so `/agents` sees `/agents/x`). */
const allCalls = (method, prefix) => calls.filter((c) => c.method === method && c.rel.startsWith(prefix));
/** Every call to exactly this route. */
const exactCalls = (method, rel) => calls.filter((c) => c.method === method && c.rel === rel);
const exactOk = (method, rel) => exactCalls(method, rel).filter((c) => c.status < 300);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── bundle the real modules ─────────────────────────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'agents-store-sim-'));
const outfile = join(out, 'agents.mjs');
await build({
  stdin: {
    // One bundle, so the harness and the store share ONE auth-token instance.
    contents: `
export * from './agents-store.ts';
export { emptyAgentsState, webSearchTool, uid, SEED_TOOL_ID } from './types.ts';
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
  SEED_TOOL_ID,
  agentsReady,
  applyRemoteAgents,
  cloneAgent: _cloneAgent,
  createAgent,
  createTool,
  currentRev,
  getAgents,
  getAgentsError,
  loadAgents,
  removeAgent,
  removeTool,
  restoreAgents,
  saveAgent,
  saveTool,
  setStreamToken,
  toolBody,
  updateAgents,
  webSearchTool,
} = store;
setStreamToken('test-token');

// A real call is only counted once the write has actually gone out.
const namedAgent = (id) => getAgents().agents.find((a) => a.id === id);

// ═══════════════════════════════════════════════════════════════════════════
section('A. boot — one read covers agents AND tools');
// ═══════════════════════════════════════════════════════════════════════════
check('agentsReady() is false before the hub answers', agentsReady(), false);
check(
  'the local cache paints first (the cached agent is on screen)',
  namedAgent('a1')?.name,
  'Alpha',
);

calls.length = 0;
const booted = await loadAgents();
await tick();

check('loadAgents() resolves with no value', booted, undefined);
check('exactly ONE read at boot', allCalls('GET', '/agents').length, 1);
check('the read was the catalogue route, not one per agent', exactCalls('GET', '/agents').length, 1);
check('the hub is now the source', agentsReady(), true);
check('the rev is adopted', currentRev(), hub.rev);
check('no error after a clean boot', getAgentsError(), '');
check(
  'agents adopted from the hub',
  getAgents().agents.map((a) => a.id).sort(),
  ['a1', 'a3'],
);
check(
  'tools adopted from the hub',
  getAgents().tools.map((t) => t.id).sort(),
  ['t-web', 't1'],
);
check(
  'the LOCAL seed tool is gone — the hub owns the catalogue',
  getAgents().tools.some((t) => t.id === SEED_TOOL_ID),
  false,
);

// ═══════════════════════════════════════════════════════════════════════════
section('B. adoption keeps what the hub CANNOT hold');
// ═══════════════════════════════════════════════════════════════════════════
check(
  'a tool keeps its bodyTemplate (no hub column, six spellings probed)',
  getAgents().tools.find((t) => t.id === 't1')?.bodyTemplate,
  '{"from":"cache"}',
);
check(
  'a tool keeps its hasToken flag (a RELAY fact, not the hub’s)',
  getAgents().tools.find((t) => t.id === 't1')?.hasToken,
  true,
);
check(
  'an agent keeps its model override (no hub column)',
  namedAgent('a1')?.model,
  'cached-model-override',
);
check('the hub’s own tool fields still win', getAgents().tools.find((t) => t.id === 't1')?.url, 'https://hub.invalid');
check('the hub’s agent fields still win', namedAgent('a1')?.name, 'Alpha');
check(
  'the NEW hub tool needs no local field re-attached',
  'bodyTemplate' in (getAgents().tools.find((t) => t.id === 't-web') ?? {}),
  false,
);
// The single most destructive thing this read could do.
check("the hub's llm is NOT adopted — model", getAgents().llm.model, 'relay-model');
check("the hub's llm is NOT adopted — provider", getAgents().llm.provider, 'openrouter');
check("the hub's llm is NOT adopted — hasKey", getAgents().llm.hasKey, true);
check(
  'a local change survives a later adoption',
  (() => {
    saveAgent('a1', { model: 'newer-override' });
    updateAgents((s) => ({ ...s, agents: s.agents.map((a) => (a.id === 'a1' ? { ...a, model: 'newer-override' } : a)) }));
    return namedAgent('a1')?.model;
  })(),
  'newer-override',
);

// ═══════════════════════════════════════════════════════════════════════════
section('C. a failed read must NOT empty the list');
// ═══════════════════════════════════════════════════════════════════════════
const beforeC = getAgents();
mode = 'dead';
calls.length = 0;
await loadAgents();
await tick();
check('the agents are still there', getAgents().agents.length, beforeC.agents.length);
check('the tools are still there', getAgents().tools.length, beforeC.tools.length);
assert('the failure is reported', getAgentsError().length > 0, getAgentsError());
check('the connection is flagged, not "open"', store.getAgentsConn(), 'error');
check('the list object was not replaced', getAgents() === beforeC, true);
mode = 'hub';
await loadAgents();
await tick();
check('a recovered read clears the error', getAgentsError(), '');

// ═══════════════════════════════════════════════════════════════════════════
section('D. saveAgent — debounce per agent, then ONE If-Match write');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
// The etag the client holds BEFORE this edit — the hub re-mints it on success,
// so comparing against the post-write value would prove nothing.
const etagD0 = hub.etags.get('a1');
saveAgent('a1', { name: 'A' });
saveAgent('a1', { name: 'Al' });
saveAgent('a1', { name: 'Alp' });
check('nothing is sent before the typing stops', allCalls('GET', '/agents/').length + allCalls('PUT', '/agents/').length, 0);
check('but the paint is instant', namedAgent('a1')?.name, 'Alp');
flush();
await tick();

check('one GET for the etag — `GET /hub/agents` carries none', exactCalls('GET', '/agents/a1').length, 1);
check('one PUT for three keystrokes', exactCalls('PUT', '/agents/a1').length, 1);
const putD = exactCalls('PUT', '/agents/a1')[0];
check('the PUT carries the LATEST text', putD.body.name, 'Alp');
check('the PUT carries the quoted etag it was given', putD.headers['If-Match'], etagD0);
assert('the etag moved because the write succeeded', hub.etags.get('a1') !== etagD0, hub.etags.get('a1'));
check('the etag is quoted on the wire', /^".*"$/.test(String(putD.headers['If-Match'])), true);
check('`model` is NOT on the wire (no hub column)', 'model' in putD.body, false);
check(
  'only the four hub fields are sent',
  Object.keys(putD.body).sort(),
  ['name', 'prompt', 'systemPrompt', 'toolIds'],
);
check('no rev is sent — this route is If-Match guarded', 'rev' in putD.body, false);
check('the write reported no error', getAgentsError(), '');

// ═══════════════════════════════════════════════════════════════════════════
section('E. the stored etag saves the NEXT write a read');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const etagE0 = hub.etags.get('a1');
saveAgent('a1', { prompt: 'second edit' });
flush();
await tick();
check('no second GET — the etag was kept', exactCalls('GET', '/agents/a1').length, 0);
check('exactly one PUT', exactCalls('PUT', '/agents/a1').length, 1);
check('carrying the CURRENT etag', exactCalls('PUT', '/agents/a1')[0].headers['If-Match'], etagE0);

// ═══════════════════════════════════════════════════════════════════════════
section('F. a 412 is recovered from details.etag, ONCE');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
force412 = 'IF_MATCH_FAILED';
saveAgent('a1', { name: 'Recovered' });
flush();
await tick();
check('it retried once (2 PUTs)', exactCalls('PUT', '/agents/a1').length, 2);
check('no refetch was needed', exactCalls('GET', '/agents/a1').length, 0);
const putF = exactCalls('PUT', '/agents/a1');
assert('the retry carried a DIFFERENT etag (the fresh one)', putF[1].headers['If-Match'] !== putF[0].headers['If-Match'], `${putF[0].headers['If-Match']} -> ${putF[1].headers['If-Match']}`);
check('and it is the QUOTED etag the 412 handed back', putF[1].headers['If-Match'], last412Etag);
check('the quotes were not stripped', /^".*"$/.test(String(putF[1].headers['If-Match'])), true);
check('the edit landed', namedAgent('a1')?.name, 'Recovered');
check('and the failure is not reported', getAgentsError(), '');

// A 412 that never clears must not spin forever.
calls.length = 0;
patches.alwaysIfMatchFails = true;
saveAgent('a1', { name: 'Never' });
flush();
await tick();
patches.alwaysIfMatchFails = false;
check('a permanently failing If-Match is bounded to 2 attempts', exactCalls('PUT', '/agents/a1').length, 2);
assert('the failure IS surfaced once it gives up', getAgentsError().length > 0, getAgentsError());
const etagF1 = hub.etags.get('a1');
calls.length = 0;
saveAgent('a1', { name: 'Now' });
flush();
await tick();
check('the etag is dropped on failure, so the next edit re-reads', exactCalls('GET', '/agents/a1').length, 1);
check('and that edit succeeds', namedAgent('a1')?.name, 'Now');
check('with the etag the read supplied', exactCalls('PUT', '/agents/a1')[0].headers['If-Match'], etagF1);
assert('which differs from the one that was failing', hub.etags.get('a1') !== etagF1, hub.etags.get('a1'));

// ═══════════════════════════════════════════════════════════════════════════
section('G. saveTool — never sends what the hub cannot hold');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
saveTool('t1', { description: 'edited' });
saveTool('t1', { name: 'tool_renamed' });
flush();
await tick();
check('two keystrokes, one PATCH', exactCalls('PUT', '/tools/t1').length, 1);
const patchG = exactCalls('PUT', '/tools/t1')[0];
check('the PATCH carries the last edit', patchG.body.name, 'tool_renamed');
check('bodyTemplate is NOT sent (the hub would discard it)', 'bodyTemplate' in patchG.body, false);
check('hasToken is NOT sent (a relay fact)', 'hasToken' in patchG.body, false);
check('a tool write REQUIRES a rev', typeof patchG.body.rev, 'number');
check('the rev sent is the one adopted at boot', patchG.body.rev, hub.rev);
check('a tool write does NOT move the rev', hub.rev, patchG.body.rev);
check('the catalogue is adopted back', getAgents().tools.find((t) => t.id === 't1')?.name, 'tool_renamed');
check(
  'and the local-only fields SURVIVE that adoption',
  getAgents().tools.find((t) => t.id === 't1')?.bodyTemplate,
  '{"from":"cache"}',
);

// ═══════════════════════════════════════════════════════════════════════════
section('H. createTool — the hub mints the id');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const authored = { id: 'tool-web', name: 'probe_tool', kind: 'http', description: 'made here', url: 'https://x.invalid/?q={q}', method: 'POST', bodyTemplate: '{"q":""}' };
check('toolBody() strips the id', 'id' in toolBody(authored), false);
check(
  'toolBody() keeps everything else',
  Object.keys(toolBody(authored)).sort(),
  ['bodyTemplate', 'description', 'kind', 'method', 'name', 'url'],
);
const madeId = await createTool(toolBody(authored));
await tick();
const postH = exactCalls('POST', '/tools')[0];
check('exactly one create', exactCalls('POST', '/tools').length, 1);
check('the create carried the fields', postH.body.name, 'probe_tool');
check('the create did NOT carry the authored id', 'id' in postH.body, false);
assert('the returned id is the SERVER’s, not the authored one', madeId !== authored.id, String(madeId));
assert('and it is a hub-minted id', typeof madeId === 'string' && madeId.startsWith('tool-'), String(madeId));
check('the new tool is in the catalogue', getAgents().tools.some((t) => t.id === madeId), true);
check(
  'the authored bodyTemplate is re-attached locally',
  getAgents().tools.find((t) => t.id === madeId)?.bodyTemplate,
  '{"q":""}',
);
check('the hub dropped bodyTemplate, as documented', 'bodyTemplate' in (hub.tools.find((t) => t.id === madeId) ?? {}), false);

// ═══════════════════════════════════════════════════════════════════════════
section('I. createAgent — server id, and extra rides the SAME request');
// ═══════════════════════════════════════════════════════════════════════════
calls.length = 0;
const newAgentId = await createAgent('Bravo', { systemPrompt: 'role', prompt: 'task', toolIds: ['t1'] });
await tick();
const postI = exactCalls('POST', '/agents')[0];
check('exactly one POST', exactCalls('POST', '/agents').length, 1);
check('the role is set in the SAME request', postI.body.systemPrompt, 'role');
check('the task is set in the SAME request', postI.body.prompt, 'task');
check('the tools are set in the SAME request', postI.body.toolIds, ['t1']);
assert('the id is the hub’s, not one invented here', typeof newAgentId === 'string' && /^ag-/.test(newAgentId), String(newAgentId));
check('the new agent is on screen', namedAgent(newAgentId)?.name, 'Bravo');
check('a create MOVES the rev (it is a rev-required route)', postI.body.rev, hub.rev - 1);

const cloneId = await store.cloneAgent('a1');
await tick();
check('clone returns a NEW id', cloneId !== 'a1', true);
check('clone copies the tools in order', namedAgent(cloneId)?.toolIds, ['t1']);
check('the clone route was used', exactCalls('POST', '/agents/a1/clone').length, 1);

// ═══════════════════════════════════════════════════════════════════════════
section('J. removeTool prunes the dangling ids in the SAME commit');
// ═══════════════════════════════════════════════════════════════════════════
check('t1 is referenced by an agent beforehand', namedAgent('a1')?.toolIds.includes('t1'), true);
calls.length = 0;
removeTool('t1');
check('the row is gone from the local list at once', getAgents().tools.some((t) => t.id === 't1'), false);
check('and so is the reference', namedAgent('a1')?.toolIds.includes('t1'), false);
await tick();
check('the hub was told', exactCalls('DELETE', '/tools/t1').length, 1);
check('the hub cascaded too', hub.agents.every((a) => !a.toolIds.includes('t1')), true);
check('the surviving catalogue is adopted', getAgents().tools.map((t) => t.id).sort(), ['t-web', madeId].sort());
check('no dangling id survives locally', getAgents().agents.every((a) => a.toolIds.every((id) => getAgents().tools.some((t) => t.id === id))), true);

// ═══════════════════════════════════════════════════════════════════════════
section('K. removeAgent — soft upstream, tombstoned history locally');
// ═══════════════════════════════════════════════════════════════════════════
updateAgents((s) => ({
  ...s,
  sessions: [
    { id: 's1', agentId: 'a3', title: 'run', messages: [], status: 'done', createdAt: 1, updatedAt: 1 },
    { id: 's2', agentId: 'a1', title: 'keep', messages: [], status: 'done', createdAt: 2, updatedAt: 2 },
  ],
}));
calls.length = 0;
removeAgent('a3');
check('gone locally at once', namedAgent('a3'), undefined);
check('the other agent’s history is untouched', getAgents().sessions.some((s) => s.id === 's2'), true);
await tick();
check('the DELETE went out', exactCalls('DELETE', '/agents/a3').length, 1);
check('with a rev (this route requires one)', typeof exactCalls('DELETE', '/agents/a3')[0].body.rev, 'number');
check('the hub dropped it', hub.agents.some((a) => a.id === 'a3'), false);
check(
  'its sessions are tombstoned so the cap is not eaten by a dead agent',
  (getAgents().sessionsClearedAt ?? {})['a3'] > 0,
  true,
);

// ═══════════════════════════════════════════════════════════════════════════
section('L. restoreAgents replays the DIFF, not the snapshot');
// ═══════════════════════════════════════════════════════════════════════════
// Snapshot the current catalogue, then move the world: rename a row, create a
// row, delete a row. An undo must undo exactly those three and nothing else.
// `cloneId` is used as the vanishing row because it demonstrably exists now —
// a3 was already deleted in section K.
const snapL = JSON.parse(JSON.stringify({ agents: getAgents().agents, tools: getAgents().tools }));
const snapIds = snapL.agents.map((a) => a.id);
const snapNameL = snapL.agents.find((a) => a.id === 'a1').name;
check('the snapshot holds the row that will vanish', snapIds.includes(cloneId), true);
check('the snapshot holds a row that will stay untouched', snapIds.includes(newAgentId), true);
saveAgent('a1', { name: 'Changed later' });
await tick();
flush();
await tick();
const deltaId = await createAgent('Delta');
await tick();
removeAgent(cloneId);
await tick();
check(
  'three differences exist',
  [namedAgent('a1')?.name, !!namedAgent(deltaId), !!namedAgent(cloneId)],
  ['Changed later', true, false],
);

calls.length = 0;
restoreAgents(snapL);
await tick();
flush();
await tick();
assert('the renamed row is restored to its SNAPSHOT value', namedAgent('a1')?.name === snapNameL, String(namedAgent('a1')?.name));
assert('...which was not its current value', snapNameL !== 'Changed later', snapNameL);
check('exactly one PUT for the ONE changed row', allCalls('PUT', '/agents/a1').length, 1);
check('an UNCHANGED row is never re-sent', allCalls('PUT', `/agents/${newAgentId}`).length, 0);
check('no tool was touched by an agent undo', allCalls('PUT', '/tools/').length + allCalls('DELETE', '/tools/').length + allCalls('POST', '/tools/').length, 0);
check('the row created since the snapshot is DELETED', allCalls('DELETE', '/agents/').length, 1);
check('...and it is the right one', exactCalls('DELETE', `/agents/${deltaId}`).length, 1);
check('the row deleted since the snapshot is re-created', allCalls('POST', '/agents').length, 1);
check('with a REAL create (the hub does not take a caller’s id)', 'id' in (exactCalls('POST', '/agents')[0]?.body ?? {}), false);
check('...and the re-created row is named as it was', hub.agents.filter((a) => a.name === snapL.agents.find((x) => x.id === cloneId).name).length, 1);
check('the hub list ends up matching the snapshot by name', hub.agents.map((a) => a.name).sort(), snapL.agents.map((a) => a.name).sort());
check('the re-created row got a NEW id, as the hub dictates', getAgents().agents.some((a) => a.id === cloneId), false);
check('the live list is the same LENGTH as the snapshot', getAgents().agents.length, snapL.agents.length);
// The ghost: a concurrent re-create adopts the catalogue BETWEEN the delete
// going out and coming back, so a naive delete leaves a row on screen that the
// hub does not have — and whose next edit 404s.
check('and it holds no ghost row the hub does not have', getAgents().agents.every((a) => hub.agents.some((h) => h.id === a.id)), true);
check('nor is the hub missing a row the list shows', hub.agents.every((h) => getAgents().agents.some((a) => a.id === h.id)), true);

// ═══════════════════════════════════════════════════════════════════════════
section('M. the relay frame is SESSIONS-ONLY and downstream-only');
// ═══════════════════════════════════════════════════════════════════════════
const beforeM = getAgents();
calls.length = 0;
applyRemoteAgents({
  agents: [{ id: 'ghost', name: 'Ghost', systemPrompt: '', prompt: '', toolIds: [], createdAt: 0, updatedAt: 0 }],
  tools: [{ id: 'ghost-tool', name: 'ghost', kind: 'web', description: '' }],
  llm: { provider: 'deepseek', model: 'ghost-model', hasKey: false },
  sessions: [{ id: 's9', agentId: 'a1', title: 'from relay', messages: [], status: 'done', createdAt: 9, updatedAt: 9 }],
  updatedAt: Date.now() + 5000,
});
check('a relay frame cannot inject an agent', getAgents().agents.some((a) => a.id === 'ghost'), false);
check('a relay frame cannot inject a tool', getAgents().tools.some((t) => t.id === 'ghost-tool'), false);
check('a relay frame cannot replace the llm settings', getAgents().llm.model !== 'ghost-model', true);
check('a relay frame DOES carry sessions', getAgents().sessions.some((s) => s.id === 's9'), true);
check('and it does not wipe the catalogue', getAgents().agents.length >= beforeM.agents.length, true);

calls.length = 0;
saveAgent('a1', { prompt: 'publish me' });
flush();
await tick();
const posts = calls.filter((c) => c.method === 'POST');
assert(
  'the only POSTs are the hub write and the relay mirror',
  posts.every((c) => c.rel === '/agents/a1' || c.path === '/api/stream'),
  posts.map((c) => c.rel).join(' | '),
);
assert(
  'the mirror goes to the RELAY, never the hub',
  calls.some((c) => c.path === '/api/stream'),
  'expected a publish',
);

// ═══════════════════════════════════════════════════════════════════════════
section('N. defaults and guards');
// ═══════════════════════════════════════════════════════════════════════════
check('no-op handshake still exists for the retiring SSE wiring', typeof store.noteAgentsHandshake, 'function');
check('and its seeding twin is a no-op', store.seedAgentsIfEmpty(), undefined);
check('the seeded web-search tool is still offered locally', webSearchTool().kind, 'web');
check('with the relay’s handle as its id', webSearchTool().id, SEED_TOOL_ID);
check('agentsReady() stays true', agentsReady(), true);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}  —  ${pass} checks passed`);
process.exit(fail === 0 ? 0 : 1);
