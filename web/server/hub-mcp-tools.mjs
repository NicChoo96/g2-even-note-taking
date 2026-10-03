// Jarvis's OWN faculties, as tools for the server-side agent loop.
//
// WHY THESE ARE BUILT IN AND NOT TOOL ROWS
// ----------------------------------------
// The hub mints tool rows and validates `kind` against a CLOSED vocabulary of
// nine values — `web tavily http jev files todo docs notes location`. Probed
// live: `POST /hub/tools {kind:'memory'}` is refused with
// `400 "kind: unsupported value"` and `details.allowed` naming all nine. So a
// "memory" tool CANNOT be authored, and this module is the only way the agent
// gets one.
//
// That constraint happens to produce the better design. A wearer authors a tool
// because a run should reach a SERVICE — search, jev, an API. Memory is not a
// service the wearer configures; it is a faculty Jarvis has. Offering it in a
// per-agent picker would invite the wearer to switch off Jarvis's own memory.
// So these are appended to every run by the relay, and no stored row can
// shadow them.
//
// WHY MCP AND NOT THE REST ROUTES
// -------------------------------
// This is the one place MCP is correct, and it is exactly the boundary the app
// is built around: the app's data paths go over REST, and MCP is for the model.
// The hub's MCP is the sessions/memory/recall/ledger/settings surface — probed
// live, twelve tools, and no todo/docs/notes tool at all. So the agent's
// todo/docs/notes tools stay on their own channel (they have no MCP twin), while
// memory, recall and session history come from here.
//
// WHY IT NEVER THROWS
// -------------------
// Same contract as `runFilesTool`: a hub that is down, unconfigured or out of
// scope has to arrive as a `tool error:` line the model can read and route
// around. An exception would take down the whole run and discard every turn
// before it. `mcpTool()` raises `HubMcpError` by design; this module is the
// place that turns that into text the model can act on.

import { HUB_MCP_TOOLS, HubMcpError } from './hub-api.mjs';

/**
 * The marker that identifies a built-in.
 *
 * Deliberately NOT one of the nine valid tool kinds: the hub can never mint it,
 * so a row arriving from `/hub/tools` can never be mistaken for a built-in, and
 * an old client cannot accidentally send one.
 */
export const HUB_MCP_TOOL_KIND = 'hub_mcp';

/** `jarvis_memory` — what Jarvis knows, and remembering something new. */
const MEMORY_ACTIONS = ['recall', 'about', 'remember'];
/** `jarvis_sessions` — earlier runs: what was asked, and what came back. */
const SESSION_ACTIONS = ['search', 'recent', 'read'];

/** Readable result caps, so one long transcript cannot swamp the model's context. */
export const MEMORY_READ_CHARS = 2_000;
export const RECALL_CHARS = 2_000;
export const SESSION_READ_CHARS = 4_000;
export const SESSION_LIST_CHARS = 2_000;

/** Every tool this module offers. Appended to each run; never stored. */
export const HUB_MCP_AGENT_TOOLS = [
  {
    id: 'builtin:jarvis_memory',
    kind: HUB_MCP_TOOL_KIND,
    name: 'jarvis_memory',
    toolId: 'jarvis_memory',
    description:
      "Jarvis's own memory. `about` returns the current memory digest — the summary of everything held long-term — and is the read to use when you want to know what you already know. `recall` searches that same long-term memory for one topic; note it searches COMPACTED memory only, so on a memory that has not yet been summarised it legitimately finds nothing even though turns exist, and an empty recall is not proof you were never told. `remember` stores a fact worth keeping after this run ends. Use `recall` before asking the wearer something they may already have told you, and `remember` only for durable facts — preferences, names, recurring projects — never for the passing content of one reply.",
  },
  {
    id: 'builtin:jarvis_sessions',
    kind: HUB_MCP_TOOL_KIND,
    name: 'jarvis_sessions',
    toolId: 'jarvis_sessions',
    description:
      "Earlier runs. `search` finds past sessions by what they were about; `recent` lists the most recent ones; `read` returns one session's transcript given the id `recent` or `search` gave you. Use it when the wearer refers to something from before, such as 'the list you made yesterday'.",
  },
];

/** The names this module owns, for the dedupe in the run's tool list. */
export const HUB_MCP_AGENT_NAMES = new Set(HUB_MCP_AGENT_TOOLS.map((t) => t.name));

export function isHubMcpTool(t) {
  return t?.kind === HUB_MCP_TOOL_KIND;
}

/**
 * Which built-in a row is, by name.
 *
 * Resolved on BOTH `name` and `toolId`, because the two callers describe a tool
 * differently and only one of them can be changed here: the agent executor holds
 * the run's tool records, which carry `name`, while `POST /api/tool` — the wire
 * the app actually uses — sends `toolId`. Matching on `name` alone made every
 * call from the app answer `unknown built-in tool` while the executor worked,
 * which is the kind of split that only shows up in a live request.
 *
 * Returns null for anything unrecognised, including a client-supplied row that
 * forged the marker — the marker is what gets it this far, and the NAME is what
 * decides what it may do, so a forged row can only ever reach a built-in action
 * and never an arbitrary one.
 */
function builtInFor(t) {
  const keys = [t?.name, t?.toolId].map((v) => String(v ?? ''));
  return HUB_MCP_AGENT_TOOLS.find((b) => keys.includes(b.name)) ?? null;
}

const clip = (s, n) => {
  const text = String(s ?? '');
  return text.length > n ? `${text.slice(0, n)}\n[...clipped]` : text;
};

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The schema the model is shown. Built HERE, beside the switch that handles the
 * actions, so the `action` enum the model is offered and the cases actually
 * handled cannot drift — the same reason `hub-tools.mjs` builds its schemas
 * beside its reducer.
 */
export function hubMcpToolSchema(t) {
  const built = builtInFor(t);
  if (!built) return null;
  const isMemory = built.name === 'jarvis_memory';
  const actions = isMemory ? MEMORY_ACTIONS : SESSION_ACTIONS;
  const properties = {
    action: {
      type: 'string',
      enum: actions,
      description: isMemory
        ? 'recall = search what is remembered about a topic; about = the current long-term digest; remember = store a durable fact for later runs.'
        : 'search = find past sessions about a topic; recent = the latest sessions; read = one session\'s transcript, by id.',
    },
  };
  if (isMemory) {
    properties.query = { type: 'string', description: 'recall: what to look for. Include the names and nouns the wearer used.' };
    properties.text = { type: 'string', description: 'remember: the fact to keep, written as one self-contained sentence.' };
  } else {
    properties.query = { type: 'string', description: 'search: what the earlier session was about.' };
    properties.sessionId = { type: 'string', description: 'read: the session id supplied by recent or search. Not the wearer\'s own words.' };
  }
  // Only the fields the chosen action needs are required, and the hub enforces
  // it too — a call that omits them comes back `bad_params` with the reason, not
  // a silently empty answer.
  const required = isMemory ? ['action'] : ['action'];
  return {
    type: 'function',
    function: {
      name: built.name,
      description: built.description,
      parameters: { type: 'object', properties, required },
    },
  };
}

/**
 * Run one built-in against the hub's MCP. Returns TEXT, never a throw — see the
 * module header. `mcp` is `hubRuntime().client`, passed in rather than looked up
 * so a harness can drive this without a server or a credential.
 */
export async function runHubMcpTool(tool, args = {}, { mcp, signal } = {}) {
  const built = builtInFor(tool);
  if (!built) return 'tool error: unknown built-in tool';
  const action = String(args?.action ?? '').trim().toLowerCase();
  const allowed = built.name === 'jarvis_memory' ? MEMORY_ACTIONS : SESSION_ACTIONS;
  // Refuse BEFORE opening a connection: an action the model invented is a model
  // mistake, and spending a hub call to be told so is pure cost. The message
  // names the legal actions, which is what lets the model correct itself.
  if (!allowed.includes(action)) {
    return `tool error: action must be one of ${allowed.join(', ')} — got ${action || '(none)'}`;
  }
  if (!mcp) return 'tool error: Jarvis memory is unavailable — the hub is not configured';

  const call = async (name, params) => {
    const { text, value } = await mcp.mcpTool(name, params, { signal });
    // Structured content wins when the hub sends it; the readable line is the
    // fallback. Either can be empty for a legitimate empty result.
    if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
    return text;
  };

  try {
    if (built.name === 'jarvis_memory') {
      if (action === 'about') return clip(await call('memory_read', {}), MEMORY_READ_CHARS) || 'memory is empty';
      if (action === 'recall') {
        const query = String(args?.query ?? '').trim();
        if (!query) return 'tool error: query is required for recall';
        const out = await call('recall', { text: query });
        return clip(out, RECALL_CHARS) || 'nothing remembered about that';
      }
      // remember
      const text = String(args?.text ?? '').trim();
      if (!text) return 'tool error: text is required for remember';
      const out = await call('memory_write', { role: 'assistant', text });
      return clip(out, MEMORY_READ_CHARS) || 'remembered';
    }

    // jarvis_sessions
    if (action === 'recent') return clip(await call('sessions_list', {}), SESSION_LIST_CHARS) || 'no earlier sessions';
    if (action === 'search') {
      const query = String(args?.query ?? '').trim();
      if (!query) return 'tool error: query is required for search';
      const out = await call('sessions_search', { q: query });
      return clip(out, SESSION_LIST_CHARS) || 'no earlier sessions matched';
    }
    // read
    const sessionId = String(args?.sessionId ?? '').trim();
    if (!sessionId) return 'tool error: sessionId is required for read — take it from recent or search';
    const out = await call('sessions_read', { sessionId });
    return clip(out, SESSION_READ_CHARS) || 'that session has no turns';
  } catch (err) {
    // `mcpTool` raises on a refusal as well as a transport failure. The code is
    // kept in the line because it is the part that says WHICH fix is needed —
    // `bad_params` means the model asked wrongly, `transport` means the hub is
    // unreachable, and a model told the difference can retry usefully.
    if (err instanceof HubMcpError) {
      return `tool error: ${err.code} — ${oneLine(err.message)}`;
    }
    return `tool error: ${oneLine(err instanceof Error ? err.message : err)}`;
  }
}

/**
 * Names this module owns that the hub's MCP does NOT actually advertise.
 *
 * A guard rather than decoration: the hub is the authority on its own thirteen
 * names, and if one of ours stopped existing the failure would be a runtime
 * `bad_params` on a live run instead of a red harness. Checked here so the
 * harness can assert it without reaching the network.
 */
export const HUB_MCP_REQUIRED = {
  jarvis_memory: ['memory_read', 'memory_write', 'recall'],
  jarvis_sessions: ['sessions_list', 'sessions_read', 'sessions_search'],
};

/** The hub MCP tools this module depends on that the hub does not declare. */
export function missingHubMcpTools() {
  const declared = new Set(Object.keys(HUB_MCP_TOOLS));
  const missing = [];
  for (const [builtIn, needs] of Object.entries(HUB_MCP_REQUIRED)) {
    for (const need of needs) if (!declared.has(need)) missing.push(`${builtIn} -> ${need}`);
  }
  return missing;
}
