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
  pruneSessions,
  tavilyTool,
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

let conn: ConnStatus = 'idle';
const connListeners = new Set<(s: ConnStatus) => void>();

function loadLocal(): AgentsState {
  const base = emptyAgentsState();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AgentsState>;
    const agents: AgentDef[] = Array.isArray(parsed.agents)
      ? parsed.agents.filter((a) => a && typeof a.id === 'string')
      : [];
    let tools: ToolDef[] = Array.isArray(parsed.tools)
      ? parsed.tools.filter((t) => t && typeof t.id === 'string')
      : [];
    // Always keep the seeded Tavily tool available.
    if (!tools.some((t) => t.kind === 'tavily')) tools = [tavilyTool(), ...tools];
    const llm: LlmSettings = { ...base.llm, ...(parsed.llm ?? {}) };
    const sessions: AgentSession[] = Array.isArray(parsed.sessions)
      ? parsed.sessions.filter((s) => s && typeof s.id === 'string')
      : [];
    return { agents, tools, llm, sessions: pruneSessions(sessions), updatedAt: Date.now() };
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

function schedulePublish(): void {
  if (pubTimer !== null) window.clearTimeout(pubTimer);
  pubTimer = window.setTimeout(() => {
    pubTimer = null;
    lastPublishedAt = state.updatedAt;
    void publishAgents(state);
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

/** Apply a local edit and broadcast it to all devices. Sessions are pruned. */
export function updateAgents(fn: (s: AgentsState) => AgentsState): void {
  const next = fn(state);
  state = { ...next, sessions: pruneSessions(next.sessions), updatedAt: Date.now() };
  persist(state);
  schedulePublish();
  emit();
}

/** Apply an agents frame received from the relay (another device or our echo). */
export function applyRemoteAgents(next: AgentsState): void {
  if (!next || !Array.isArray(next.agents)) return;
  if (next.updatedAt === lastPublishedAt) return; // our own echo — already applied
  const base = emptyAgentsState();
  state = {
    agents: next.agents,
    tools: next.tools?.length ? next.tools : base.tools,
    llm: { ...base.llm, ...(next.llm ?? {}) },
    sessions: pruneSessions(next.sessions ?? []),
    updatedAt: next.updatedAt ?? Date.now(),
  };
  persist(state);
  emit();
}

/** Seed the relay from local storage if the server has no agents state yet. */
export function seedAgentsIfEmpty(): void {
  const local = getAgents();
  const hasData =
    local.agents.length > 0 || local.sessions.length > 0 || local.tools.length > 1;
  if (hasData) {
    lastPublishedAt = Date.now();
    void publishAgents({ ...local, updatedAt: lastPublishedAt });
  }
}

/**
 * Re-read the bridge-durable copy once the startup handshake is complete.
 * The bridge is often unavailable during the very first frames, so the initial
 * loadLocal() may have missed data written by a previous run.
 */
export async function hydrateAgentsDurable(): Promise<void> {
  const [saved, sessions] = await Promise.all([loadAgentsDurable(), loadSessionsDurable()]);
  if (!saved && !sessions) return;
  state = {
    agents: saved?.agents ?? state.agents,
    tools: saved?.tools?.length ? saved.tools : state.tools,
    llm: { ...state.llm, ...(saved?.llm ?? {}) },
    sessions: pruneSessions(sessions ?? state.sessions),
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
    return { ...s, sessions: [session, ...s.sessions.filter((x) => x.id !== id)] };
  });
  return id;
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
