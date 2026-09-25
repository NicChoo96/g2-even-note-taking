// MCP tool substrate — discover and call the tools of ANY MCP server.
//
// WHY THIS MODULE EXISTS
//   The app already speaks MCP to one server (the Jarvis Content Gateway, see
//   jarvis-files.mjs), but its tool schema is HAND-WRITTEN: the parameter names,
//   types and descriptions in filesToolSchema are a copy of what the gateway
//   declares in `tools/list`. A copy cannot be checked. That is how the model
//   ended up unable to hard-delete: `hard` exists upstream and in the client's
//   own `remove()`, but nobody wrote it into the copy, and nothing could tell
//   anyone the copy had fallen behind.
//
//   This module is the seam that removes the copy. It treats the SERVER as the
//   source of truth: `tools/list` is read once, and each tool's `inputSchema` is
//   passed through to the model as-is. Adding a second, third or tenth MCP
//   server is then a matter of pointing a transport at it — no schema code.
//
// THREE THINGS THAT MAKE IT REUSABLE RATHER THAN GATEWAY-SHAPED
//   1. TRANSPORT IS INJECTED, not built in. Credentials are not this module's
//      business: the gateway rotates an opaque refresh token and revokes the
//      whole session family if one is replayed (see jarvis-files.mjs), which is
//      a policy only that client can implement. A caller hands over a
//      `transport(method, params)` and everything above it is identical for an
//      unauthenticated server and an OAuth one. `httpTransport()` is supplied
//      for the plain case so a simple server needs no glue at all.
//   2. THE SCHEMA IS PASSED THROUGH, not translated. `inputSchema` is already
//      JSON Schema, which is what an OpenAI-style `parameters` field wants. Any
//      translation would be a second place to be wrong (see sanitizeInputSchema
//      for the one narrow repair we do make).
//   3. NOTHING IS FATAL. Discovery can fail — the server may be down, the
//      credential expired, the protocol version mismatched. Every caller here
//      is expected to fall back rather than take a run down with it, so failures
//      are raised as one typed error and the CACHE IS LEFT EMPTY rather than
//      poisoned with a partial catalogue.
//
// THE TWO FAILURE LEVELS, MIRRORED FROM THE GATEWAY (jarvis-files.mjs)
//   • the call reached a tool and the TOOL failed  -> a result with isError:true
//   • the call never reached a tool                -> a JSON-RPC `error`, no result
//   Both are surfaced here, and `call()` reports the first as a VALUE (the model
//   can read and work around it) and the second as a THROW (our bug, or theirs).
//
// ASCII only, no import side effects: this file must be drivable from a harness
// against a stubbed transport, exactly like jarvis-files.mjs.

/** The three methods this substrate uses. */
export const MCP_INIT_METHOD = 'initialize';
export const MCP_LIST_METHOD = 'tools/list';
export const MCP_CALL_METHOD = 'tools/call';

/** Sent with `initialize`; servers that ignore the handshake never see it. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** How long a discovered catalogue is reused before it is re-read. */
export const TOOLS_TTL_MS = 10 * 60_000;

/** The JSON-RPC/OpenAI ceiling on a function name; also the reason for prefixes. */
export const MAX_TOOL_NAME = 64;

/** Hard cap, so a server with a thousand tools cannot be pulled into one turn. */
export const MAX_TOOLS = 64;

/**
 * One error type for every failure, so callers read `code` and not a string.
 *
 * `jsonrpc` vs `transport` is the distinction the whole module rests on: a
 * `jsonrpc` failure means the server ANSWERED and refused (our request was
 * wrong), while a `transport` failure means we never got an answer (the server,
 * the network or the credential is the problem). The first is a bug to fix, the
 * second is a condition to report.
 */
export class McpToolsError extends Error {
  constructor(code, message, { status = 0, method = '', detail = null } = {}) {
    super(message);
    this.name = 'McpToolsError';
    this.code = code;
    this.status = status;
    this.method = method;
    this.detail = detail;
  }
}

/** True when a decoded body is a JSON-RPC error envelope rather than a result. */
export function isJsonRpcError(body) {
  return Boolean(body) && typeof body === 'object' && Boolean(body.error);
}

/** A JSON-RPC 2.0 request envelope. */
export function rpcRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, params: params ?? {} };
}

/**
 * Repair an MCP `inputSchema` for use as an OpenAI `parameters` field.
 *
 * Deliberately NARROW. The shape is already right, so this makes only the four
 * repairs that are real rather than stylistic:
 *   • a missing/non-object schema becomes an empty object schema, because a
 *     caller that spreads `undefined` crashes and a tool with no arguments is
 *     legitimate and common;
 *   • `$schema`/`$id` are dropped: a draft URI is a document concern and some
 *     function-calling validators reject unknown top-level keywords;
 *   • `required` is filtered to names that actually exist in `properties`.
 *     A server that lists a required key it does not define would otherwise make
 *     every call we send fail validation, and the model cannot invent a name it
 *     was never shown;
 *   • `properties` is always an object, for the same reason as `required`.
 * Everything else — nested objects, enums, defaults, arrays — is returned as
 * received, because passing it through untouched is the entire point.
 */
export function sanitizeInputSchema(schema) {
  const src = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
  const properties =
    src.properties && typeof src.properties === 'object' && !Array.isArray(src.properties)
      ? src.properties
      : {};
  const rawRequired = Array.isArray(src.required) ? src.required : [];
  const required = rawRequired
    .map((r) => String(r))
    .filter((r, i, all) => Object.prototype.hasOwnProperty.call(properties, r) && all.indexOf(r) === i);

  const out = { ...src, type: 'object', properties, required };
  delete out.$schema;
  delete out.$id;
  delete out.$comment;
  return out;
}

/**
 * An MCP tool record -> an OpenAI function schema.
 *
 * `prefix` exists because tool names collide across servers: two MCP servers may
 * each expose `search`, and one flat namespace is what the model is given. A
 * prefixed name is also what lets a call be routed back to the right transport
 * without a second lookup table.
 */
export function toFunctionSchema(tool, { prefix = '' } = {}) {
  const raw = String(tool?.name ?? '').trim();
  if (!raw) throw new McpToolsError('bad_tool', 'an MCP tool has no name');
  const name = sanitizeToolName(prefix ? `${prefix}${raw}` : raw);
  return {
    type: 'function',
    function: {
      name,
      description: String(tool?.description ?? '').trim() || `Call ${name}.`,
      parameters: sanitizeInputSchema(tool?.inputSchema),
    },
  };
}

/**
 * Coerce a name into the `^[a-zA-Z0-9_-]{1,64}$` an OpenAI-style field accepts.
 *
 * A server is free to name a tool `search.web` or `list/sessions`; those are
 * legal MCP names and would be rejected here, and a rejected tool is one the
 * model is never told about. Replacing the illegal character keeps the tool
 * reachable, and the map back to the original lives with the catalogue.
 */
export function sanitizeToolName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^[^a-zA-Z]+/, (m) => m.replace(/[^a-zA-Z]/g, ''))
    .slice(0, MAX_TOOL_NAME);
  return cleaned || 'tool';
}

/**
 * A `tools/list` result -> a flat, name-keyed catalogue, newest read wins.
 *
 * The `schemaName` is kept ALONGSIDE the name the model sees, so a call can be
 * translated back to what the server actually answers to even when the two
 * differ (see sanitizeToolName).
 */
export function normalizeCatalogue(listResult, { prefix = '' } = {}) {
  const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
  const out = [];
  const seen = new Set();
  for (const t of tools.slice(0, MAX_TOOLS)) {
    const serverName = String(t?.name ?? '').trim();
    if (!serverName) continue;
    const schema = toFunctionSchema(t, { prefix });
    const name = schema.function.name;
    // Two distant tools can collide once sanitized (`a.b` and `a/b`). First
    // wins, because the alternative — handing the model two functions with one
    // name — is a provider error on every turn, not a degraded one.
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      serverName,
      description: String(t?.description ?? '').trim(),
      parameters: schema.function.parameters,
      schema,
    });
  }
  return out;
}

/**
 * What a locally-declared parameter set and the server's disagree about.
 *
 * This is the check the hand-written schema never had, and it reports the two
 * directions separately because only one of them is dangerous:
 *   • `missingOnServer` — we advertise a parameter the server does not define.
 *     The model will send it, and every such call fails. THIS is a lie.
 *   • `missingLocally` — the server defines a parameter we never offer. No call
 *     fails; a capability is merely unreachable. This is the `hard` case.
 */
export function diffParams(localProperties, remoteCatalogue) {
  const local = Object.keys(localProperties ?? {});
  const remote = (remoteCatalogue ?? []).map((c) => c.name ?? c.serverName ?? String(c));
  const remoteSet = new Set(remote);
  const localSet = new Set(local);
  return {
    missingOnServer: local.filter((n) => !remoteSet.has(n)),
    missingLocally: remote.filter((n) => !localSet.has(n)),
  };
}

/**
 * Drift for a FOLDED tool — the case where several server tools are shown to the
 * model as ONE function with an `action` switch.
 *
 * `diffParams` cannot be pointed at this case directly, and comparing the fold's
 * parameters against any single server tool would be wrong in both directions,
 * so the comparison is against the UNION of the tools the fold actually calls.
 *
 * `switchKey` is the parameter the fold INVENTS: it names no server tool's
 * parameter, so it is excluded from both directions instead of being reported as
 * a lie on every single boot — a check that cries wolf is a check nobody reads.
 *
 * Reports four separate facts, because they call for different responses:
 *   • `missingOnServer` — the fold offers a parameter no folded tool accepts.
 *     The model sends it and the call fails. A LIE: fix the fold or the call.
 *   • `missingLocally` — a folded tool accepts a parameter the fold never
 *     offers. No call fails; the capability is merely UNREACHABLE.
 *   • `unknownFoldedTools` — the fold names a tool the server does not list, so
 *     the fold's own map is stale and one of its actions is dead.
 *   • `unusedTools` — the server lists a tool the fold never calls. A whole
 *     capability the model cannot reach, which is what seven of the gateway's
 *     eleven tools were.
 */
export function foldDrift({ localProperties, fold, catalogue, switchKey = 'action' }) {
  const used = new Set(Object.values(fold ?? {}));
  const names = (catalogue ?? []).map((t) => String(t.serverName ?? t.name ?? ''));
  const union = new Set();
  for (let i = 0; i < names.length; i += 1) {
    if (!used.has(names[i])) continue;
    for (const key of Object.keys(catalogue[i].parameters?.properties ?? {})) union.add(key);
  }
  const local = Object.keys(localProperties ?? {}).filter((n) => n !== switchKey);
  const { missingOnServer, missingLocally } = diffParams(
    Object.fromEntries(local.map((name) => [name, true])),
    [...union].filter((n) => n !== switchKey).map((name) => ({ name })),
  );
  return {
    missingOnServer,
    missingLocally,
    unknownFoldedTools: [...used].filter((n) => !names.includes(n)),
    unusedTools: names.filter((n) => !used.has(n)),
  };
}

/**
 * A plain MCP-over-HTTP transport: one JSON-RPC POST per call.
 *
 * `handshake: true` sends `initialize` first, which the MCP specification asks
 * for and the Jarvis gateway does not require. It is OFF by default so a caller
 * pointed at a server that answers `tools/call` directly spends no extra request
 * — and because a session-negotiating handshake needs the session id returned by
 * `initialize` to be echoed on later calls, which is a server-specific detail
 * this helper deliberately does not guess at.
 */
export function httpTransport({
  url,
  headers = {},
  fetch: doFetch = globalThis.fetch,
  handshake = false,
  timeoutMs = 30_000,
} = {}) {
  if (!/^https?:\/\//i.test(String(url ?? ''))) {
    throw new McpToolsError('bad_url', `MCP url must be http(s), got: ${url}`);
  }
  let handshook = false;
  let nextId = 1;

  return async function transport(method, params, { signal } = {}) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const onAbort = () => timeout.abort();
    if (signal) {
      if (signal.aborted) timeout.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      if (handshake && !handshook && method !== MCP_INIT_METHOD) {
        await transport(MCP_INIT_METHOD, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'reality-hub', version: '1' },
        });
        handshook = true;
      }
      const r = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The MCP HTTP binding asks for both, so a server MAY stream the
          // answer back as SSE. We read JSON only, and say so, rather than
          // pretending to parse an event stream we do not handle.
          Accept: 'application/json',
          ...headers,
        },
        body: JSON.stringify(rpcRequest(nextId++, method, params)),
        signal: timeout.signal,
      });
      const text = await r.text().catch(() => '');
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new McpToolsError(
          'transport',
          `MCP answered with something that is not JSON (HTTP ${r.status})`,
          { status: r.status, method },
        );
      }
      if (isJsonRpcError(body)) {
        throw new McpToolsError('jsonrpc', String(body.error.message || 'MCP refused the call'), {
          status: r.status,
          method,
          detail: body.error.data ?? null,
        });
      }
      if (!r.ok || !body) {
        throw new McpToolsError('transport', `MCP HTTP ${r.status}`, { status: r.status, method });
      }
      return body.result ?? {};
    } catch (err) {
      if (err instanceof McpToolsError) throw err;
      const aborted = err?.name === 'AbortError';
      throw new McpToolsError(
        aborted ? 'timeout' : 'transport',
        aborted ? 'the MCP server did not answer in time' : String(err?.message ?? err),
        { method },
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * A cached, single-flight view of one MCP server's tools.
 *
 * SINGLE-FLIGHT because discovery is not free and a cold relay can take several
 * agent turns at once: without it, N concurrent turns each spend a `tools/list`,
 * and against the Jarvis gateway a burst like that is how a token limit is hit.
 * One shared promise means N cold callers cost exactly one read.
 *
 * THE CACHE IS NOT WRITTEN ON FAILURE. A server that is briefly down must not
 * leave a half-built catalogue behind for the next ten minutes, so a failed read
 * clears the promise and the next caller retries — the same reasoning the token
 * client applies to a dead session.
 */
export function createMcpTools({
  name = 'mcp',
  transport,
  prefix = '',
  ttlMs = TOOLS_TTL_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (typeof transport !== 'function') {
    throw new McpToolsError('bad_transport', 'createMcpTools needs a transport function');
  }

  let catalogue = null;
  let fetchedAt = 0;
  let inFlight = null;

  async function read({ signal } = {}) {
    const result = await transport(MCP_LIST_METHOD, {}, { signal });
    const list = normalizeCatalogue(result, { prefix });
    if (!list.length) {
      // An empty list is a legitimate answer, but it is far more often a
      // protocol or credential problem wearing a success code. Say which.
      log(`${name}: tools/list returned no tools`);
    }
    return list;
  }

  /** The catalogue, from cache when fresh, otherwise read once and shared. */
  async function list({ refresh = false, signal } = {}) {
    const fresh = catalogue && now() - fetchedAt < ttlMs && !refresh;
    if (fresh) return catalogue;
    if (inFlight) return inFlight;
    inFlight = read({ signal })
      .then((tools) => {
        catalogue = tools;
        fetchedAt = now();
        return tools;
      })
      .catch((err) => {
        // Never cache a failure: leave the cache empty so the next caller tries
        // again instead of inheriting a stale or partial answer.
        catalogue = null;
        fetchedAt = 0;
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** OpenAI function schemas for the whole catalogue. */
  async function schemas(opts = {}) {
    return (await list(opts)).map((t) => t.schema);
  }

  /** The catalogue in the flat shape the JEV router ranks over. */
  async function catalog(opts = {}) {
    return (await list(opts)).map((t) => ({
      name: t.name,
      serverName: t.serverName,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Call one tool by the name the MODEL was shown.
   *
   * A tool-level failure is returned as a value with `isError: true` rather than
   * thrown, because that is what it is: the call worked and the operation did
   * not, and the text of it is the most useful thing the model can be given. A
   * name that matches nothing is OUR bug, and throws.
   */
  async function call(toolName, args = {}, { signal } = {}) {
    const entry = (catalogue ?? []).find((t) => t.name === toolName);
    const serverName = entry?.serverName ?? String(toolName);
    if (!entry) {
      // Allow a verified miss to proceed rather than hard-failing a benign
      // race (a refresh landing between read and call), but say so loudly.
      log(`${name}: calling "${serverName}" which was not in the cached catalogue`);
    }
    const result = await transport(
      MCP_CALL_METHOD,
      { name: serverName, arguments: args ?? {} },
      { signal },
    );
    const text = Array.isArray(result?.content)
      ? result.content
          .map((c) => (typeof c?.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';
    return {
      isError: result?.isError === true,
      text,
      data: result?.structuredContent ?? null,
      raw: result,
    };
  }

  /**
   * Compare locally-declared parameter sets against the server's own.
   *
   * `localSchemas` is a function name -> `parameters.properties` map, i.e. what
   * we currently promise the model. Returns one entry per checked tool, and
   * SKIPS a tool the server does not have at all (that is a naming problem, not
   * a parameter one, and reporting it as sixteen missing parameters buries it).
   */
  async function drift(localSchemas, opts = {}) {
    const tools = await list(opts);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const out = [];
    for (const [toolName, properties] of Object.entries(localSchemas ?? {})) {
      const entry = byName.get(toolName);
      if (!entry) continue;
      const remoteNames = Object.keys(entry.parameters?.properties ?? {});
      const localNames = Object.keys(properties ?? {});
      const d = diffParams(properties, remoteNames);
      out.push({ tool: toolName, ...d });
    }
    return out;
  }

  return {
    name,
    list,
    schemas,
    catalog,
    call,
    drift,
    /** Drop the cache; the next read goes to the server. */
    clear() {
      catalogue = null;
      fetchedAt = 0;
    },
    /** What the cache currently holds, or null — for a probe or a log line. */
    peek() {
      return catalogue;
    },
  };
}
