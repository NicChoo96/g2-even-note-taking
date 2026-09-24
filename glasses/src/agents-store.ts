// Agents store — the single source of truth for the agent builder, its tools,
// the LLM settings and the (last 5) session history.
//
// Deliberately SEPARATE from store.ts/HubState:
//   • HubState is broadcast to every device AND mirrored to the relay's state
//     file, so secrets or bulky transcripts must never live there.
//   • Agents ride their own SSE channel ('agents') and their own durable keys.
//   • API keys are NOT stored here at all — they are held server-side by the
//     relay (see web/server/local-sse.mjs /api/llm). Only `llm.hasKey` (a
//     boolean) is ever synced.
import { publishAgents } from './stream';
import { loadAgentsDurable, loadSessionsDurable, saveAgentsDurable, saveSessionsDurable } from './durable-agents';
import {
  emptyAgentsState,
  mergeClearedAt,
  mergeSessions,
  normalizeTool,
  normalizeToolId,
  webSearchTool,
  uid,
  type AgentDef,
  type AgentMessage,
  type AgentSession,
  type AgentsState,
  type LlmSettings,
  type ToolDef,
} from './types';

const LS_KEY = 'hub:agents';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'error';

let state: AgentsState = loadLocal();
const listeners = new Set<() => void>();
let lastPublishedAt = 0;
let pubTimer: number | null = null;
// Set once the relay has answered the SSE handshake (or accepted a publish).
// Until then the local copy is the only source; afterwards pushing it back would
// clobber a newer server snapshot (the reason a saved agent vanished from the
// glasses, and the reason agents reappeared after a delete).
let sawServerState = false;
let serverReportedEmpty = false;
let seedArmed = false;
let seeded = false;

let conn: ConnStatus = 'idle';
const connListeners = new Set<(s: ConnStatus) => void>();

function loadLocal(): AgentsState {
  const base = emptyAgentsState();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AgentsState>;
    const agents: AgentDef[] = Array.isArray(parsed.agents)
      ? parsed.agents.filter((a) => a && typeof a.id === 'string').map(normalizeAgent)
      : [];
    let tools: ToolDef[] = Array.isArray(parsed.tools)
      ? parsed.tools.filter((t) => t && typeof t.id === 'string').map(normalizeTool)
      : [];
    // Always keep the seeded web-search tool available. (Its kind used to be
    // 'tavily'; normalizeTool above rewrites that on the way in, so this check
    // catches a legacy snapshot too.)
    if (!tools.some((t) => t.kind === 'web')) tools = [webSearchTool(), ...tools];
    const llm: LlmSettings = { ...base.llm, ...(parsed.llm ?? {}) };
    const sessions: AgentSession[] = Array.isArray(parsed.sessions)
      ? parsed.sessions.filter((s) => s && typeof s.id === 'string')
      : [];
    const cleared = parsed.sessionsClearedAt;
    return {
      agents,
      tools,
      llm,
      // Load through the merge, not a bare prune: the durable bridge mirrors
      // `{agents,tools,llm}` while localStorage holds the full state, so the two
      // copies disagree about sessions by design. Merging them here is what
      // stops the narrower copy from deleting the other one's history.
      sessions: mergeSessions([], sessions, cleared),
      sessionsClearedAt: cleared,
      updatedAt: Date.now(),
    };
  } catch {
    /* ignore */
  }
  return base;
}

function persist(s: AgentsState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  // Dual-write to the Even App bridge so the state survives a WebView teardown.
  void saveAgentsDurable(s);
  void saveSessionsDurable(s.sessions);
}

function emit(): void {
  for (const l of [...listeners]) l();
}

/**
 * Agents persisted before the Trigger prompt existed have no `prompt`; the
 * glasses menu calls `.trim()` on it, so backfill it on every ingress path.
 */
function normalizeAgent(a: AgentDef): AgentDef {
  return {
    ...a,
    prompt: typeof a.prompt === 'string' ? a.prompt : '',
    // Legacy agents predate `updatedAt`; fall back to their creation stamp so
    // the newest-first ordering still has a key to sort on.
    updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : a.createdAt,
    // The seeded web-search tool was 'tool-tavily'. Rewriting the id HERE — not
    // just on the tool — is what keeps the pair consistent: a migrated tool with
    // an un-migrated reference would leave the agent with no working tools,
    // silently, which is far worse than the rename itself.
    toolIds: (Array.isArray(a.toolIds) ? a.toolIds : []).map(normalizeToolId),
  };
}

function schedulePublish(): void {
  if (pubTimer !== null) window.clearTimeout(pubTimer);
  pubTimer = window.setTimeout(() => {
    pubTimer = null;
    lastPublishedAt = state.updatedAt;
    void publishAgents(state).then((ok) => {
      if (ok) sawServerState = true;
    });
  }, 250);
}

export function getAgents(): AgentsState {
  return state;
}

/** Subscribe to agents-state changes. Returns an unsubscribe function. */
export function subscribeAgents(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Apply a local edit and broadcast it to all devices. Sessions never shrink. */
export function updateAgents(fn: (s: AgentsState) => AgentsState): void {
  const next = fn(state);
  const sessionsClearedAt = mergeClearedAt(state.sessionsClearedAt, next.sessionsClearedAt);
  state = {
    ...next,
    // One invariant, applied in one place: the stored list is the UNION of what
    // was there and what the edit produced (minus anything tombstoned). An edit
    // that rebuilt `sessions` from a stale snapshot therefore cannot delete
    // history — only `clearSessionsFor` can, and it leaves a stamp.
    sessions: mergeSessions(state.sessions, next.sessions, sessionsClearedAt),
    sessionsClearedAt,
    updatedAt: Date.now(),
  };
  persist(state);
  schedulePublish();
  emit();
}

/** Apply an agents frame received from the relay (another device or our echo). */
export function applyRemoteAgents(next: AgentsState): void {
  if (!next || !Array.isArray(next.agents)) return;
  sawServerState = true;
  if (next.updatedAt === lastPublishedAt) return; // our own echo — already applied
  const base = emptyAgentsState();
  const sessionsClearedAt = mergeClearedAt(state.sessionsClearedAt, next.sessionsClearedAt);
  state = {
    agents: next.agents.map(normalizeAgent),
    tools: next.tools?.length ? next.tools.map(normalizeTool) : base.tools,
    llm: { ...base.llm, ...(next.llm ?? {}) },
    // MERGE, never replace. `agents`/`tools`/`llm` are edited by one surface at
    // a time and last-write-wins is right for them, but `sessions` is
    // append-only and every device that settles a run publishes its own list —
    // a peer that was backgrounded ships a shorter one, and replacing with it
    // deleted history the wearer had already recorded (and the relay persisted
    // that deletion). See mergeSessions.
    sessions: mergeSessions(state.sessions, next.sessions ?? [], sessionsClearedAt),
    sessionsClearedAt,
    updatedAt: next.updatedAt ?? Date.now(),
  };
  persist(state);
  emit();
}

/**
 * Arm a one-shot seed of the agents channel. The seed only runs once the relay
 * reports an EMPTY snapshot — the agents list is shared by every paired device,
 * so pushing a stale browser copy after the relay snapshot arrived would delete
 * agents another device just created (the reason a saved agent never showed up
 * on the glasses).
 */
export function seedAgentsIfEmpty(): void {
  seedArmed = true;
  maybeSeedAgents();
}

function maybeSeedAgents(): void {
  if (!seedArmed || seeded || sawServerState || !serverReportedEmpty) return;
  const local = getAgents();
  const hasData =
    local.agents.length > 0 || local.sessions.length > 0 || local.tools.length > 1;
  if (!hasData) return;
  seeded = true;
  lastPublishedAt = Date.now();
  void publishAgents({ ...local, updatedAt: lastPublishedAt }).then((ok) => {
    if (ok) sawServerState = true;
  });
}

/**
 * Called when the relay's agents handshake arrives. A snapshot means "don't
 * seed"; a null snapshot means "server is empty".
 */
export function noteAgentsHandshake(hasSnapshot: boolean): void {
  if (hasSnapshot) {
    sawServerState = true;
    return;
  }
  serverReportedEmpty = true;
  maybeSeedAgents();
}

/**
 * Re-read the bridge-durable copy once the startup handshake is complete.
 * The bridge is often unavailable during the very first frames, so the initial
 * loadLocal() may have missed data written by a previous run.
 */
export async function hydrateAgentsDurable(): Promise<void> {
  const [saved, sessions] = await Promise.all([loadAgentsDurable(), loadSessionsDurable()]);
  if (!saved && !sessions) return;
  // The relay snapshot is authoritative once it has arrived. The bridge copy is
  // written by THIS device only, so applying it afterwards would silently revert
  // agents another device added — the same clobber, just via a different path.
  if (sawServerState) return;
  const sessionsClearedAt = mergeClearedAt(state.sessionsClearedAt, saved?.sessionsClearedAt);
  state = {
    // Normalize: a durable snapshot written before 0.3.5 has no `prompt`, and
    // the glasses menu calls `.trim()` on it.
    agents: saved?.agents ? saved.agents.map(normalizeAgent) : state.agents,
    tools: saved?.tools?.length ? saved.tools.map(normalizeTool) : state.tools,
    llm: { ...state.llm, ...(saved?.llm ?? {}) },
    sessions: mergeSessions(state.sessions, sessions ?? [], sessionsClearedAt),
    sessionsClearedAt,
    updatedAt: Date.now(),
  };
  persist(state);
  emit();
}

/**
 * Record a finished agent run as a session (capped at the 5 most recent) and
 * return the session id.
 */
export function recordSession(input: {
  id?: string;
  agentId: string;
  title: string;
  messages: AgentMessage[];
  status: AgentSession['status'];
}): string {
  const id = input.id ?? uid();
  let created = Date.now();
  updateAgents((s) => {
    const existing = s.sessions.find((x) => x.id === id);
    if (existing) created = existing.createdAt;
    const session: AgentSession = {
      id,
      agentId: input.agentId,
      title: input.title,
      messages: input.messages,
      status: input.status,
      createdAt: created,
      updatedAt: Date.now(),
    };
    // Merge rather than prepend-and-drop: BOTH devices settle the same run (the
    // run id IS the session id), and the second one to publish may be holding a
    // transcript it only partly streamed. `[session, ...filter]` used to let
    // that shorter copy overwrite the complete one.
    return { ...s, sessions: mergeSessions(s.sessions, [session], s.sessionsClearedAt) };
  });
  return id;
}

/**
 * Delete one agent's whole history — and REMEMBER that it was deleted.
 *
 * The stamp is the whole trick. Sessions are merged, not replaced, so a bare
 * filter would be undone by the very next frame that still carried them (the
 * other device's copy, or this device's own in-flight publish). `mergeSessions`
 * drops anything at or before the stamp, so the deletion is idempotent, travels
 * with the state, and survives a restart.
 */
export function clearSessionsFor(agentId: string): void {
  updateAgents((s) => ({
    ...s,
    sessions: s.sessions.filter((x) => x.agentId !== agentId),
    sessionsClearedAt: { ...(s.sessionsClearedAt ?? {}), [agentId]: Date.now() },
  }));
}

export function getAgentsConn(): ConnStatus {
  return conn;
}

export function setAgentsConn(s: ConnStatus): void {
  conn = s;
  for (const l of [...connListeners]) l(s);
}

export function subscribeAgentsConn(fn: (s: ConnStatus) => void): () => void {
  connListeners.add(fn);
  fn(conn);
  return () => {
    connListeners.delete(fn);
  };
}
