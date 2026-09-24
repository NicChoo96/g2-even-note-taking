// Shared protocol types for G2 Even Reality Hub.
// Mirror these in web/src/types.ts — keep them in sync.

export type SectionId = 'todo' | 'docs' | 'files' | 'notes' | 'agents';

/** Display order, mirrored by `SECTIONS` (glasses menu) and `TAB_ORDER` (web). */
export const SECTION_IDS: SectionId[] = ['agents', 'todo', 'docs', 'files', 'notes'];

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

/**
 * A document in the external store (Files section) — a REFERENCE, never a copy.
 *
 * Deliberately has no body field, and must never gain one. These documents are
 * written by a model and live on the Jarvis Content Gateway; the app stores only
 * where to find one so the list can be drawn and the body can be fetched on
 * demand. Two consequences worth stating, because both are the point:
 *   • HubState is broadcast to every device AND mirrored to the relay's state
 *     file, so a body stored here would be copied into a public-ish place, and
 *   • a 4 MiB document would blow the glasses' 999-byte frame budget — the
 *     list row is all the glasses can ever show anyway.
 */
export interface FileRef {
  id: string;
  title: string;
  /** The authoring agent recorded by the publisher ('' when unset). */
  agent: string;
  /** Absolute URL of the BODY on the gateway. For display/debug, not to frame
   *  (the gateway refuses to be framed, so the app fetches the body instead). */
  url: string;
  size: number;
  updatedAt: number;
}

export interface HubState {
  activeSection: SectionId;
  sections: {
    todo: TodoItem[];
    /** Multiple named docs — pick one with `activeDocId`. */
    docs: DocEntry[];
    /** References to documents held in the external store. Never their bodies. */
    files: FileRef[];
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
    sections: { todo: [], docs: [], files: [], notes: '' },
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

/**
 * Tool transports. 'web' is the seeded web-search tool — the BACKEND (Tavily or
 * Brave Search) is a relay setting, deliberately not a property of the tool, so
 * the same tool swaps provider without being re-created. 'http' is any REST API,
 * and 'jev' is a typed-decision tool: instead of returning prose it answers a
 * yes/no, pick-one or rubric question and returns a calibrated probability. jev
 * has no per-tool config — it uses the relay's OpenRouter key.
 *
 * 'tavily' is the LEGACY kind for the same tool. It is accepted on every read
 * path (see normalizeTool) because persisted agents, bridge snapshots and an
 * older client bundle can all still carry it, but nothing writes it any more.
 */
export type ToolKind = 'web' | 'http' | 'jev' | 'files';
/** Legacy spelling, read-only — kept so normalizing old state type-checks. */
export type LegacyToolKind = 'tavily';
export type WebDepth = 'basic' | 'advanced';

/** The seeded web-search tool's id. A legacy install has 'tool-tavily'. */
export const SEED_TOOL_ID = 'tool-web';
const LEGACY_SEED_TOOL_ID = 'tool-tavily';
/** The legacy model-facing name for the same tool. */
const LEGACY_SEED_TOOL_NAME = 'tavily_search';

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
  /** Web search only — how much to read. Defaults to 'basic'. */
  searchDepth?: WebDepth;
}

/**
 * Map a stored tool onto the current vocabulary.
 *
 * Three renames are folded in one place so every ingress path agrees: the kind
 * `tavily` → `web`, the id `tool-tavily` → `tool-web`, and the seeded tool's
 * model-facing name `tavily_search` → `web_search`. The NAME is only rewritten
 * for a tool that was actually of the legacy kind AND still had the seed name —
 * a user who deliberately named a tool `tavily_search` keeps their label.
 *
 * Every field is optional on the way in because this runs against localStorage,
 * a bridge snapshot and a relay frame, none of which are ours to trust.
 */
export function normalizeTool(t: ToolDef): ToolDef {
  const legacy = (t as { kind?: string }).kind === 'tavily';
  const kind: ToolKind = legacy ? 'web' : t.kind;
  const id = t.id === LEGACY_SEED_TOOL_ID ? SEED_TOOL_ID : t.id;
  const name = legacy && (!t.name || t.name === LEGACY_SEED_TOOL_NAME) ? 'web_search' : t.name;
  return { ...t, id, kind, name };
}

/** Map a stored tool id onto the current vocabulary. */
export function normalizeToolId(id: string): string {
  return id === LEGACY_SEED_TOOL_ID ? SEED_TOOL_ID : id;
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
  /**
   * Saved task prompt. Selecting the agent on the glasses and choosing
   * "Trigger" runs THIS text — no dictation, no typing on the glasses.
   */
  prompt: string;
  /** Ids of the ToolDefs this agent may call. */
  toolIds: string[];
  /** Optional per-agent model override (falls back to LlmSettings.model). */
  model?: string;
  createdAt: number;
  /** Last time the agent was created or edited — drives the list order. */
  updatedAt?: number;
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
  /** Most recent FIRST, capped at MAX_SESSIONS per agent. */
  sessions: AgentSession[];
  /**
   * agentId -> ms. Every session for that agent stamped at or before it is GONE
   * on every device. This is what keeps an explicit delete working under the
   * merge in `mergeSessions`: sessions are append-only, so "missing from a
   * frame" cannot mean "deleted", and a plain union would resurrect history the
   * wearer just cleared.
   */
  sessionsClearedAt?: Record<string, number>;
  updatedAt: number;
}

/** Sessions kept + synced PER AGENT (user-set optimisation). */
export const MAX_SESSIONS = 5;

/**
 * Hard ceiling across all agents. This list is published in full on every
 * `agents` edit and persisted verbatim by the relay, so it must not be
 * unbounded. At MAX_SESSIONS per agent this starts to bite at 7+ agents that
 * all hold full histories.
 */
export const MAX_SESSIONS_TOTAL = MAX_SESSIONS * 6;

/** Free OpenRouter model that actually supports tool calling. */
export const DEFAULT_MODEL = 'inclusionai/ling-3.0-flash-sante:free';

export function emptyLlmSettings(): LlmSettings {
  return { provider: 'openrouter', model: DEFAULT_MODEL, hasKey: false };
}

/**
 * The web-search tool every new install starts with (searchDepth 'basic').
 *
 * Named for what it does, not for who serves it: the provider is a relay setting
 * (Tavily or Brave Search) so the model's tool list does not change, the agent's
 * `toolIds` do not change, and no agent is invalidated when the backend swaps.
 */
export function webSearchTool(): ToolDef {
  return {
    id: SEED_TOOL_ID,
    name: 'web_search',
    kind: 'web',
    description:
      'Search the web for current information. Use for facts, news, prices, or anything not in the prompt.',
    searchDepth: 'basic',
    hasToken: false,
  };
}

/**
 * A tool that decides rather than describes. The agent supplies the text to
 * judge plus one typed question, and gets back a probability or a label — not a
 * paragraph it would have to interpret. Needs no token of its own.
 */
export function jevTool(): ToolDef {
  return {
    id: 'tool-jev',
    name: 'jev_decide',
    kind: 'jev',
    description:
      'Ask a typed question about a piece of text and get a calibrated answer back: a yes/no ' +
      'probability, a pick from options you define, or a position on an ordered scale. Use for ' +
      'routing, ranking and verification instead of asking for prose.',
    hasToken: false,
  };
}

/** The seeded document-store tool's id. */
export const FILE_TOOL_ID = 'tool-files';

/**
 * The document-store tool: publish an HTML report the wearer can actually read.
 *
 * The one tool whose OUTPUT is not text. A search result is something the model
 * consumes; a stored document is something the WEARER consumes, on a screen the
 * model cannot draw on. That is why its description tells the model the body is
 * not returned to it — otherwise it would publish a document and then try to
 * summarise the HTML it never received.
 */
export function filesTool(): ToolDef {
  return {
    id: FILE_TOOL_ID,
    name: 'jarvis_files',
    kind: 'files',
    description:
      'Publish an HTML document to the wearer library, or list and read what is already ' +
      'stored there. Use it when the answer is a report, table, chart or briefing that is ' +
      'better read on screen than dictated. The document body is NOT returned to you — ' +
      'the wearer reads it on the Files page.',
    hasToken: false,
  };
}

export function emptyAgentsState(): AgentsState {
  return {
    agents: [],
    tools: [webSearchTool()],
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
    prompt: 'What is new in AI this week?',
    // Web search is ON by default for every agent (the seeded web-search tool).
    toolIds: [SEED_TOOL_ID],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Sort key: the last edit time, falling back to creation for legacy agents. */
export function agentUpdatedAt(a: AgentDef): number {
  return a.updatedAt ?? a.createdAt ?? 0;
}

/** Agents in the order every surface shows them: most recently updated first. */
export function orderedAgents(agents: readonly AgentDef[]): AgentDef[] {
  return [...agents].sort((a, b) => agentUpdatedAt(b) - agentUpdatedAt(a));
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

/**
 * Cap history to the newest MAX_SESSIONS PER AGENT, most-recent-first overall.
 *
 * WHY PER AGENT — this is the reported bug. Both read paths already promise a
 * per-agent history: the web panel prints "History · last N/5" for the SELECTED
 * agent, and the glasses detail pane pages within one agent's list. But the cap
 * was applied to the whole array, so "5 sessions" really meant "5 sessions for
 * the entire app". Finishing a run for agent B inserted a session and evicted
 * the globally-oldest one — routinely the last surviving session of agent A.
 * The panel, filtered to A, dropped towards "No sessions yet.", which reads
 * exactly as "my session history was cleared when the run finished". Nothing
 * was deleted; a shared pool was drained by a neighbour.
 */
export function pruneSessions(list: AgentSession[]): AgentSession[] {
  const sorted = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const perAgent = new Map<string, number>();
  const out: AgentSession[] = [];
  for (const s of sorted) {
    const n = perAgent.get(s.agentId) ?? 0;
    if (n >= MAX_SESSIONS) continue;
    perAgent.set(s.agentId, n + 1);
    out.push(s);
  }
  return out.length > MAX_SESSIONS_TOTAL ? out.slice(0, MAX_SESSIONS_TOTAL) : out;
}

/**
 * Merge two session lists into one that can only ever GROW (then get capped).
 *
 * WHY THIS IS A MERGE AND NOT A REPLACE: `sessions` is append-only, but it
 * rides the `agents` channel, whose payload is whole-state last-write-wins.
 * Every device that settles a run publishes ITS list — and a device that was
 * backgrounded never learned about the runs it did not witness (the run replay
 * carries only RUNNING runs), so its list is legitimately shorter. Replacing
 * with that shorter list deleted the sessions the other device had recorded, in
 * the relay's cached and persisted copy too. That is the reported "my session
 * history was cleared out when the run finished": the run that finishes is a
 * new session, and everything else disappears with it.
 *
 * For a shared id the RICHER transcript wins, so a device holding a
 * half-streamed run can never truncate the copy another device stored in full.
 * Otherwise the INCOMING copy wins — including when it is stamped older, which
 * is deliberate: a caller may legitimately rewrite one of its own sessions (a
 * correction, or backdating a fixture). "Fresher timestamp wins" looks safer but
 * silently swallows those rewrites — it made the monitor harness's backdated
 * fixtures a no-op and flipped its newest-first ordering.
 * Ordering and the cap are `pruneSessions`' job.
 */
export function mergeSessions(
  local: readonly AgentSession[],
  incoming: readonly AgentSession[],
  clearedAt: Record<string, number> = {},
): AgentSession[] {
  const byId = new Map<string, AgentSession>();
  for (const s of [...local, ...incoming]) {
    if (!s || typeof s.id !== 'string') continue;
    const prev = byId.get(s.id);
    if (!prev) {
      byId.set(s.id, s);
      continue;
    }
    // Incoming wins unless it is strictly POORER than what we hold. Writing it
    // the other way round (`>` on the local side) makes the incoming rewrite lose
    // on equal lengths, which breaks backdating and corrections.
    if ((s.messages?.length ?? 0) >= (prev.messages?.length ?? 0)) byId.set(s.id, s);
  }
  // Tombstones drop BEFORE the cap, or a cleared session would still consume a
  // slot a live one could have used. No stamp means nothing was ever cleared for
  // that agent, so every session is kept — the filter must never act as an
  // accidental "updatedAt > 0" test.
  const live = [...byId.values()].filter((s) => {
    const stamp = clearedAt[s.agentId];
    return !stamp || (s.updatedAt ?? 0) > stamp;
  });
  return pruneSessions(live);
}

/** Newest-wins union of two clear-stamp maps — a later clear beats an earlier. */
export function mergeClearedAt(
  local: Record<string, number> | undefined,
  incoming: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...(local ?? {}) };
  for (const [id, at] of Object.entries(incoming ?? {})) {
    if (typeof at === 'number' && at > (out[id] ?? 0)) out[id] = at;
  }
  return out;
}
