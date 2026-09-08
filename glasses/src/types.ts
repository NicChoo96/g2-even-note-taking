// Shared protocol types for G2 Even Reality Hub.
// Mirror these in web/src/types.ts — keep them in sync.

export type SectionId = 'todo' | 'docs' | 'notes' | 'agents';

export const SECTION_IDS: SectionId[] = ['todo', 'docs', 'notes', 'agents'];

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/** A named, saved document (Docs section is now a library of these). */
export interface DocEntry {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
}

export interface HubState {
  activeSection: SectionId;
  sections: {
    todo: TodoItem[];
    /** Multiple named docs — pick one with `activeDocId`. */
    docs: DocEntry[];
    notes: string;
  };
  /** The currently-open doc (Docs mode). Null → fall back to the first doc. */
  activeDocId: string | null;
  updatedAt: number;
}

export interface StreamFrame<T = HubState> {
  type: 'init' | 'state';
  state: T;
}

export function emptyHubState(): HubState {
  return {
    activeSection: 'todo',
    sections: { todo: [], docs: [], notes: '' },
    activeDocId: null,
    updatedAt: Date.now(),
  };
}

export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyDoc(title = 'Untitled'): DocEntry {
  return { id: uid(), title, content: '', updatedAt: Date.now() };
}

/** Resolve the doc that should be shown in Docs mode. */
export function activeDoc(state: HubState): DocEntry | null {
  return (
    state.sections.docs.find((d) => d.id === state.activeDocId) ??
    state.sections.docs[0] ??
    null
  );
}

/** Rewrite one doc in the collection (adds it if missing). */
export function upsertDoc(
  state: HubState,
  doc: DocEntry,
): { docs: DocEntry[]; activeDocId: string } {
  const exists = state.sections.docs.some((d) => d.id === doc.id);
  const docs = exists
    ? state.sections.docs.map((d) => (d.id === doc.id ? { ...doc, updatedAt: Date.now() } : d))
    : [...state.sections.docs, { ...doc, updatedAt: Date.now() }];
  return { docs, activeDocId: doc.id };
}

// ── Agents ───────────────────────────────────────────────────────────────────
// A SEPARATE data channel from HubState. Agent configs, tool secrets and session
// transcripts must never ride the hub channel: HubState is broadcast to every
// device AND mirrored to the relay's state file, so anything in it is effectively
// public. Agents therefore live in their own SSE channel ('agents') and their own
// durable keys, and only compact summaries are rendered on the glasses.

/** Tool transports. Tavily is the seeded web-search tool; http is any REST API. */
export type ToolKind = 'tavily' | 'http';
export type TavilyDepth = 'basic' | 'advanced';

export interface ToolDef {
  id: string;
  name: string;
  kind: ToolKind;
  /** What the model reads when deciding whether to call this tool. */
  description: string;
  /** http tools: absolute endpoint URL. */
  url?: string;
  /** http tools: request method (default POST). */
  method?: 'GET' | 'POST';
  /** Secret is stored server-side (relay env / settings store) — never here. */
  hasToken?: boolean;
  /** Tavily only — defaults to 'basic' as the user requested. */
  searchDepth?: TavilyDepth;
}

export interface LlmSettings {
  provider: 'openrouter';
  /** e.g. 'nvidia/nemotron-3.5-lightning:free' (free + tool-calling capable). */
  model: string;
  /** Sent as HTTP-Referer / X-OpenRouter-Title. */
  referer?: string;
  title?: string;
  /** True once a key is configured SERVER-SIDE; the key itself never reaches us. */
  hasKey?: boolean;
}

export interface AgentDef {
  id: string;
  name: string;
  /** System prompt — the agent's instructions. */
  systemPrompt: string;
  /** Ids of the ToolDefs this agent may call. */
  toolIds: string[];
  /** Optional per-agent model override (falls back to LlmSettings.model). */
  model?: string;
  createdAt: number;
}

export type AgentRole = 'user' | 'assistant' | 'tool';

/** One turn of an agent session (assistant turns may carry a tool call). */
export interface AgentMessage {
  role: AgentRole;
  content: string;
  /** assistant: name of the tool it called. */
  tool?: string;
  /** assistant: JSON args (stringified) — shown in the detail pane. */
  args?: string;
  at: number;
}

export interface AgentSession {
  id: string;
  agentId: string;
  /** First prompt, truncated — the history-list label. */
  title: string;
  messages: AgentMessage[];
  status: 'running' | 'done' | 'error';
  createdAt: number;
  updatedAt: number;
}

/** The 'agents' channel payload (SSE channel + durable keys). */
export interface AgentsState {
  agents: AgentDef[];
  tools: ToolDef[];
  llm: LlmSettings;
  /** Most recent FIRST, capped at MAX_SESSIONS. */
  sessions: AgentSession[];
  updatedAt: number;
}

/** Only the 5 most recent sessions are kept + synced (user-set optimisation). */
export const MAX_SESSIONS = 5;

/** Free OpenRouter model that actually supports tool calling. */
export const DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning:free';

export function emptyLlmSettings(): LlmSettings {
  return { provider: 'openrouter', model: DEFAULT_MODEL, hasKey: false };
}

/** The web-search tool every new install starts with (searchDepth 'basic'). */
export function tavilyTool(): ToolDef {
  return {
    id: 'tool-tavily',
    name: 'tavily_search',
    kind: 'tavily',
    description:
      'Search the web for current information. Use for facts, news, prices, or anything not in the prompt.',
    searchDepth: 'basic',
    hasToken: false,
  };
}

export function emptyAgentsState(): AgentsState {
  return {
    agents: [],
    tools: [tavilyTool()],
    llm: emptyLlmSettings(),
    sessions: [],
    updatedAt: Date.now(),
  };
}

export function emptyAgent(name = 'New Agent'): AgentDef {
  return {
    id: uid(),
    name,
    systemPrompt:
      'You are a concise research assistant. Use the available tools when you need ' +
      'current information, then answer briefly in plain text.',
    toolIds: [],
    createdAt: Date.now(),
  };
}

export function agentById(s: AgentsState, id: string | null | undefined): AgentDef | null {
  return s.agents.find((a) => a.id === id) ?? null;
}

export function toolById(s: AgentsState, id: string): ToolDef | undefined {
  return s.tools.find((t) => t.id === id);
}

/** Sessions for one agent, most recent first. */
export function sessionsForAgent(s: AgentsState, agentId: string): AgentSession[] {
  return s.sessions
    .filter((x) => x.agentId === agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The newest session for an agent (what the glasses detail pane shows). */
export function latestSession(s: AgentsState, agentId: string): AgentSession | null {
  return sessionsForAgent(s, agentId)[0] ?? null;
}

/** Keep only the newest MAX_SESSIONS, most-recent-first. */
export function pruneSessions(list: AgentSession[]): AgentSession[] {
  return [...list]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS);
}
