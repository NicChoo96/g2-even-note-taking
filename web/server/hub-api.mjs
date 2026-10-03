// Authenticated proxy for the jarvis-content-gateway HUB API (`/hub/*`).
//
// The hub is a SECOND API family on the SAME service this relay already talks to
// for documents: one origin, one credential, one JWT + rotating refresh family.
// The backend spec puts it exactly that way — "One HTTP service, two API
// families, one credential" (docs/backend-true-specs/backend-specs-integration.md
// §2) — and that one sentence decides the three design choices in this file.
//
//   1. NO SECOND SESSION. The caller hands in the session the relay already
//      owns (`createFilesClient` in jarvis-files.mjs, cached in filesRuntime()).
//      A second client would hold a second refresh token against the one
//      account, and the two would rotate against each other; the loser's next
//      refresh is answered `refresh_token_reuse`, which REVOKES THE WHOLE
//      FAMILY and signs every surface out. So there is exactly one session, and
//      the hub shares it.
//
//   2. THE BROWSER CANNOT CALL THE HUB ITSELF. Verified live: `cors_origins` is
//      `[]`, and `OPTIONS /hub/todos` answers 204 with NO
//      `Access-Control-Allow-Origin` header, so a direct call from the dashboard
//      or the glasses WebView dies at the preflight. The credential is also a
//      server secret that must never reach the bundle. Both are the same two
//      reasons `/api/files/*` already proxies instead of calling out.
//
//   3. THE PREFIX IS DISCOVERED, NOT ASSUMED. The hub mounts under `HUB_PREFIX`
//      (default `/hub`), published by `GET /config`. Hard-coding `/hub` is a
//      documented trap (§15.6 trap 10), so the prefix is read once and cached.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//   It is a PASSTHROUGH, not a hub client. Everything awkward about the hub
//   stays in the browser client (glasses/src/web/hub-client.ts), because that is
//   where the user action that produced it lives:
//     • the `rev` write token, and `STALE_REV` recovery from `details.current`
//     • `Idempotency-Key` — one UUID per ACTION, replayed on retry
//     • `If-Match` on agents/docs, and the 412 that carries the etag
//     • `204` HAS NO BODY — do not call `.json()` on it
//   Reinterpreting any of that here would put one decision in two places and let
//   them drift, so the relay only: resolves the prefix, injects the bearer,
//   retries a 401 ONCE, and forwards the bytes.
//
// THE ONE BOUNDARY IT ENFORCES: `/hub/mcp` is NOT reachable over HTTP.
//   The app's rule is that every data path uses the REST routes and MCP exists
//   only for Jarvis and the agent loop — which call it in-process through the
//   shared session. A browser-reachable `/api/hub/mcp` would make that rule
//   unenforceable, so it is refused here rather than merely left undocumented.

export const HUB_PREFIX_FALLBACK = '/hub';

/** Where the hub publishes its own mount point. Public, unauthenticated. */
export const HUB_CONFIG_PATH = '/config';

/**
 * The request cap for a hub write.
 *
 * Set just ABOVE the gateway's own `max_html_bytes` (4 MiB, read live from
 * `/config`), for the same reason files uses it: being over the limit must come
 * back as the gateway's own validation error naming the real limit, not as a
 * generic "body too large" from this process that hides which limit bit.
 */
export const HUB_MAX_BODY_BYTES = 4 * 1024 * 1024 + 64 * 1024;

/** How long a discovered `hub_prefix` is trusted before `/config` is re-read. */
const PREFIX_TTL_MS = 5 * 60 * 1000;

/** Methods the proxy will forward. Anything else is a 405, not a guess. */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/**
 * Paths the HTTP proxy refuses, matched against the hub-relative path.
 *
 * MCP is the only one. `/hub/mcp` is how Jarvis and the agent loop reach the
 * twelve hub tools; the dashboard's data never should, and the app's rule is
 * explicit about it. Those callers run IN this process, so nothing legitimate
 * ever arrives here wanting it.
 */
const BLOCKED_PATHS = [/^\/mcp(?:\/|$|\?)/];

/**
 * Response headers worth handing back to the browser — and no others.
 *
 * `etag` matters because the agents/docs optimistic-concurrency guard is driven
 * by it, and it is NOT a CORS-safelisted response header, so a cross-origin
 * caller (the glasses WebView) cannot read it unless it is explicitly exposed.
 * `duplicate` matters because a replayed write answers `200` with
 * `Duplicate: true` and that is a SUCCESS the caller must be able to detect.
 */
const PASS_HEADERS = [
  'content-type',
  'etag',
  'duplicate',
  'idempotency-key',
  'cache-control',
];

/** Is this hub-relative path one the HTTP surface must never expose? */
export function isBlockedHubPath(path) {
  const p = String(path || '');
  return BLOCKED_PATHS.some((re) => re.test(p));
}

// ─── The hub's MCP endpoint, IN-PROCESS ONLY ────────────────────────────────
//
// WHY THIS LIVES HERE: this file is the one place that knows how to reach the
// hub with the shared session and where the hub is mounted. The MCP endpoint is
// the same service, the same prefix and the same session, so it belongs to the
// same client rather than to a second module that would have to rediscover the
// prefix and could drift from it.
//
// WHY IT IS NOT A `call()` PATH: `call()` takes a PATH, and the path is what the
// HTTP proxy forwards. `mcpTool()` takes a TOOL NAME and a parameters object, so
// there is no path for a URL to inject — the two cannot be confused, which is
// what keeps BLOCKED_PATHS a real boundary instead of a naming convention.
//
// WHAT THE HUB'S MCP ACTUALLY IS (all probed live): twelve tools over SESSIONS,
// MEMORY, RECALL, LEDGER and SETTINGS — and NOTHING ELSE. There is no todo,
// document or notes tool here, which is why the agent's todo/docs/notes tools
// ride the REST routes instead. Anything that treats this endpoint as a
// general-purpose data API is wrong about it.

/** Where the hub mounts its MCP endpoint, relative to the hub prefix. */
export const HUB_MCP_PATH = '/mcp';

/** The protocol version the hub reports (live: "2024-11-05"). */
export const HUB_MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * The twelve tools the hub's `tools/list` advertises, with the arguments each
 * one REQUIRES. This is a LOCAL copy of a live catalogue, kept for two reasons:
 * a caller can be told it is calling a tool that cannot exist without waiting
 * for a round trip, and a harness can assert the surface has not moved.
 *
 * It is a CHECK, never an authority — `tools/list` is the authority, and
 * `mcpTools()` returns what the hub actually said.
 */
export const HUB_MCP_TOOLS = {
  sessions_save: ['kind', 'messages'],
  sessions_list: [],
  sessions_read: ['sessionId'],
  sessions_search: ['q'],
  sessions_summarize: ['sessionId'],
  sessions_clear: [],
  sessions_stats: [],
  memory_read: [],
  memory_write: ['role', 'text'],
  recall: ['text'],
  ledger_read: [],
  settings_read: [],
};

/**
 * A refusal from the hub's MCP — transport, protocol or tool.
 *
 * `code` is a STRING (the house style), so a caller branches on `unknown_tool`
 * rather than on `-32602`. The JSON-RPC number is kept in `jsonrpc` because it is
 * what actually crossed the wire, and losing it would make a support question
 * unanswerable.
 */
export class HubMcpError extends Error {
  constructor(code, message, { jsonrpc = null, status = null, detail = null } = {}) {
    super(message);
    this.name = 'HubMcpError';
    this.code = code;
    this.jsonrpc = jsonrpc;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Pull the readable answer out of an MCP `tools/call` result.
 *
 * The hub wraps a tool's answer as `content: [{type:'text', text}]` — and the
 * text is written for a MODEL to read, not a parser (`memory_read` answers
 * `turns: 0  words: 0 of 4000 …`). `structuredContent` is preferred when the
 * server supplies it, because that is the machine-readable twin, and `text` is
 * the fallback rather than the primary.
 */
export function mcpResultOf(result) {
  if (!result || typeof result !== 'object') return { value: null, text: '' };
  const text = Array.isArray(result.content)
    ? result.content
        .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
    : '';
  const value = result.structuredContent ?? null;
  return { value, text };
}

/**
 * A JSON-RPC failure -> a HubMcpError.
 *
 * The mapping is probed, not borrowed from the spec, because the spec is wrong
 * about the most important case: an UNKNOWN TOOL is `-32602`, not `-32601`.
 * `-32601` is reserved for an unknown METHOD. Getting those two confused matters
 * because "you called a tool that does not exist" and "you asked for an operation
 * that does not exist" need different fixes.
 *
 * `-32602` is the hub's ONE code for invalid params, and it covers an unknown
 * tool AND a missing argument alike (`sessionId is required`). So there is one
 * code here for both — `bad_params` — and the MESSAGE is what tells them apart.
 * Inventing two codes would claim a distinction the server does not make.
 */
export function mcpErrorOf(error, status) {
  const code = Number(error?.code);
  const message = String(error?.message || 'the hub MCP refused the request');
  const named =
    code === -32601
      ? 'unknown_method'
      : code === -32602
        ? 'bad_params'
        : code === -32000
          ? 'tool_refused'
          : code === -32700
            ? 'parse_error'
            : code === -32600
              ? 'invalid_request'
              : code === -32603
                ? 'internal_error'
                : `jsonrpc_${code}`;
  return new HubMcpError(named, message, { jsonrpc: Number.isFinite(code) ? code : null, status, detail: error?.data ?? null });
}

/**
 * Pick the headers worth forwarding back out of an upstream response.
 *
 * Returns a plain object because the upstream is a `fetch` Response: its headers
 * are a `Headers` instance, and spreading one does not give a usable map.
 */
export function forwardedHeaders(upstream) {
  const out = {};
  for (const name of PASS_HEADERS) {
    const value = upstream?.headers?.get?.(name);
    if (value) out[name] = value;
  }
  return out;
}

/**
 * Wrap a shared session (see `createFilesClient`) as a hub caller.
 *
 * `session` must expose the four primitives jarvis-files.mjs hands out:
 * `request`, `ensureToken`, `forget` and `configured`. It is passed in rather
 * than constructed here on purpose — this file must never be able to create a
 * second session, which is what would break the one-rotating-family rule.
 */
export function createHubClient(session, { fetchPrefix = true, now = () => Date.now() } = {}) {
  let prefixCache = '';
  let prefixAt = 0;
  /**
   * The JSON-RPC `id`. Monotonic and process-local: the hub only echoes it, so
   * anything unique within one process would do, and a counter is the smallest
   * thing that cannot collide with itself.
   */
  let mcpSeq = 0;
  const mcpId = () => ++mcpSeq;

  /**
   * The hub's mount point, from `/config`, cached.
   *
   * A `/config` that is down must NOT take the hub down with it: the documented
   * default is used and re-read once the TTL lapses. Getting this wrong is worse
   * than being stale, because every route would 404 at once.
   */
  async function prefix(signal) {
    if (!fetchPrefix) return HUB_PREFIX_FALLBACK;
    if (prefixCache && now() - prefixAt < PREFIX_TTL_MS) return prefixCache;
    let found = HUB_PREFIX_FALLBACK;
    try {
      const token = await session.ensureToken(signal);
      const r = await session.request(HUB_CONFIG_PATH, { token, signal });
      const raw = r?.body?.hub_prefix;
      if (typeof raw === 'string' && raw.trim()) {
        const trimmed = raw.trim().replace(/\/+$/, '');
        // Accept both `hub` and `/hub`; a bare string must not produce `hub/x`.
        const normalised = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
        // A prefix of just `/` would make every route `//hub/...`, so fall back.
        if (normalised && normalised !== '/') found = normalised;
      }
    } catch {
      /* fall back to the documented default; the TTL will retry */
    }
    prefixCache = found;
    prefixAt = now();
    return found;
  }

  /**
   * One hub call. NEVER throws: every outcome is a value the route can render.
   *
   * Retries EXACTLY ONCE, and only on a transport 401 — the one failure a fresh
   * token could plausibly fix. `forget()` before the retry is what makes the
   * retry take the sign-in path instead of replaying the dead token; retrying
   * without it would just send the same rejected bearer again.
   */
  async function call(method, path, { body, headers, signal, retried = false } = {}) {
    const p = String(path || '');
    const verb = String(method || 'GET').toUpperCase();

    const reject = (status, code, message) =>
      ({ status, ok: false, text: JSON.stringify({ ok: false, error: message, code }), headers: null });

    if (isBlockedHubPath(p)) {
      return reject(403, 'SCOPE_DENIED', 'MCP is not exposed over the HTTP proxy');
    }
    if (!ALLOWED_METHODS.has(verb)) {
      return reject(405, 'VALIDATION_ERROR', `method ${verb} is not allowed`);
    }
    // Reject a path that could escape the hub mount before it is concatenated.
    if (!p.startsWith('/') || p.includes('..')) {
      return reject(400, 'VALIDATION_ERROR', 'hub path must start with / and must not contain ..');
    }

    const base = await prefix(signal);
    const token = await session.ensureToken(signal);
    const r = await session.request(`${base}${p}`, {
      method: verb,
      body,
      token,
      headers,
      signal,
      // RAW: hand the bytes through unchanged. Parsing here would lose a 204's
      // empty body and would have to re-serialise the hub's own JSON, which is
      // exactly the kind of second interpretation this file refuses to have.
      raw: true,
    });

    if (r.status === 401 && !retried) {
      session.forget();
      return call(method, path, { body, headers, signal, retried: true });
    }
    return r;
  }

  // ─── MCP, for Jarvis and the agent loop only ──────────────────────────────

  /** One JSON-RPC message to the hub's MCP. The shared session, no exceptions. */
  async function mcpSend(payload, { signal, retried = false } = {}) {
    const base = await prefix(signal);
    const token = await session.ensureToken(signal);
    const r = await session.request(`${base}${HUB_MCP_PATH}`, {
      method: 'POST',
      body: payload,
      token,
      signal,
    });
    if (r.status === 401 && !retried) {
      session.forget();
      return mcpSend(payload, { signal, retried: true });
    }
    // A message with NO `id` is a notification and the hub answers 204 with an
    // EMPTY body. Every call here sends an id, so a 204 is a protocol surprise
    // worth naming rather than an empty object pretending to be a result.
    if (r.status === 204) {
      throw new HubMcpError('no_content', 'the hub MCP answered 204 with no body', { status: 204 });
    }
    if (!r.ok) {
      throw new HubMcpError('transport', `the hub MCP answered ${r.status}`, {
        status: r.status,
        detail: r.body?.error ?? null,
      });
    }
    if (!r.body || typeof r.body !== 'object') {
      throw new HubMcpError('bad_json', 'the hub MCP did not answer JSON', { status: r.status });
    }
    if (r.body.error) throw mcpErrorOf(r.body.error, r.status);
    return r.body.result ?? null;
  }

  /** `tools/list` — what the hub ACTUALLY advertises, not the local table. */
  async function mcpTools({ signal } = {}) {
    const result = await mcpSend({ jsonrpc: '2.0', id: mcpId(), method: 'tools/list', params: {} }, { signal });
    const tools = result?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  /**
   * `tools/call`, unwrapped into `{ value, text }`.
   *
   * A tool that RAN AND REFUSED is still a JSON-RPC success carrying
   * `isError: true` (spec §9.1, and deliberate: the model should read the reason
   * instead of losing the transport). So `isError` is raised as an error HERE,
   * where a caller can catch it, rather than handed back as a truthy field
   * somebody has to remember to check.
   */
  async function mcpTool(name, args = {}, { signal } = {}) {
    const tool = String(name || '');
    if (!tool) throw new HubMcpError('bad_params', 'a tool name is required');
    const result = await mcpSend(
      {
        jsonrpc: '2.0',
        id: mcpId(),
        method: 'tools/call',
        params: { name: tool, arguments: args && typeof args === 'object' ? args : {} },
      },
      { signal },
    );
    if (result?.isError) {
      const e = result.structuredContent?.error;
      throw new HubMcpError(String(e?.code || 'tool_error'), String(e?.message || mcpResultOf(result).text || 'the tool failed'), {
        status: 200,
        detail: e?.detail ?? null,
      });
    }
    return mcpResultOf(result);
  }

  return {
    call,
    prefix,
    mcpSend,
    mcpTools,
    mcpTool,
    get configured() {
      return Boolean(session.configured);
    },
    /** Drop the cached prefix — used when a test or a config change demands it. */
    resetPrefix() {
      prefixCache = '';
      prefixAt = 0;
    },
  };
}
