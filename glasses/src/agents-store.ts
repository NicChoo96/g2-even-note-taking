// Agents store — the single source of truth for the agent builder, its tools,
// the LLM settings and the (last 5) session history.
//
// THE HUB OWNS THE AGENTS AND THE TOOLS.
//   `GET /hub/agents` answers with `agents`, `tools` and `llm` together, so a
//   single boot call settles the whole catalogue, and the ids in it are
//   guaranteed to agree with each other. Every mutation below is one hub request
//   (`agents-store`-level semantic op) rather than a state blob pushed at a
//   relay, which is what makes two devices converge: `rev` decides, not
//   whichever device published last.
//
// WHAT STAYS LOCAL, AND WHY (all probed against the live server)
//   • A tool's `bodyTemplate` — the hub DROPS it under every name tried
//     (`bodyTemplate`, `body_template`, `body`, `template`, `params`,
//     `queryParams`), so the column does not exist. It is re-attached by id on
//     every adoption. A device that has never seen a REST tool therefore cannot
//     recover the parameter shape its author wrote — the one real cost of the
//     migration, stated rather than hidden.
//   • A tool's `headers` — same column gap, same treatment: re-attached by id on
//     every adoption, and absent on a device that never saw the tool.
//   • A tool's `hasToken` — in this app that means "the RELAY holds a
//     credential", which is a different mechanism from the hub's own
//     `PUT /hub/tools/{id}/token` store. The relay is what executes a run, so the
//     hub's flag would always read false and blank the indicator.
//   • An agent's `model` — an optional per-agent override the hub has no column
//     for; it never comes back, so it is preserved from the local copy.
//   • `sessions` — still relay-synced (todo: move to `/hub/sessions`). The hub
//     has sessions, but they are keyed by agent and carry `seq`; that move is
//     deliberately separate so this change cannot delete anyone's history.
//   • `llm` — RELAY-owned, and the hub's copy is an unconfigured second opinion
//     (`provider:"deepseek"`, `hasKey:false`). Adopting it would overwrite a
//     working model choice, so it is read past on purpose.
//
// Deliberately SEPARATE from store.ts/HubState:
//   • HubState is broadcast to every device AND mirrored to the relay's state
//     file, so secrets or bulky transcripts must never live there.
//   • API keys are NOT stored here at all — they are held server-side by the
//     relay (see web/server/local-sse.mjs /api/llm). Only `llm.hasKey` (a
//     boolean) is ever synced.
import { publishAgents } from './stream';
import { loadAgentsDurable, loadSessionsDurable, saveAgentsDurable, saveSessionsDurable } from './durable-agents';
import {
  cloneAgent as hubCloneAgent,
  createAgent as hubCreateAgent,
  createTool as hubCreateTool,
  deleteAgent as hubDeleteAgent,
  deleteTool as hubDeleteTool,
  fetchAgent as hubFetchAgent,
  fetchAgents as hubFetchAgents,
  fetchSessionMessages as hubFetchSessionMessages,
  fetchSessions as hubFetchSessions,
  clearSessions as hubClearSessions,
  patchTool as hubPatchTool,
  putAgent as hubPutAgent,
  saveSession as hubSaveSession,
  type HubSession,
  type HubError,
} from './web/hub-client';
import {
  MAX_SESSIONS_TOTAL,
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
/** Set once `GET /hub/agents` has answered. After that the hub is the source. */
let hubLoaded = false;
let lastPublishedAt = 0;
let pubTimer: number | null = null;

/** One debounced write per agent/tool id — a keystroke storm is one PUT. */
const writers = new Map<string, number>();
const EDIT_DEBOUNCE_MS = 400;
/**
 * The `If-Match` each agent's next write must carry.
 *
 * `GET /hub/agents` carries NO per-agent etag (verified live — the list records
 * are exactly `id,name,systemPrompt,prompt,toolIds,createdAt,updatedAt`), so the
 * first write of an agent costs one `GET /hub/agents/{id}` to learn it. A 412
 * hands back a fresh one, so the read happens at most once per agent per session
 * in the common case.
 */
const agentEtags = new Map<string, string>();

let lastError = '';
const errorListeners = new Set<(e: string) => void>();

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

/**
 * Mirror the local state to the relay so the GLASSES keep a current agent list.
 *
 * DOWNSTREAM ONLY. The relay's snapshot is no longer a source of truth for
 * agents or tools — `applyRemoteAgents` ignores those fields — so this can only
 * ever publish, never overwrite. What it publishes is itself hub-derived, which
 * is what keeps the glasses agreeing with the hub.
 */
function schedulePublish(): void {
  if (pubTimer !== null) window.clearTimeout(pubTimer);
  pubTimer = window.setTimeout(() => {
    pubTimer = null;
    lastPublishedAt = state.updatedAt;
    void publishAgents(state);
  }, 250);
}

// ─────────────────────────────────────────────────────────────────────────────
// The hub layer
// ─────────────────────────────────────────────────────────────────────────────

/** Records changes only when the text actually differs — keeps the error quiet. */
function reportAgentsError(msg: string): void {
  if (msg === lastError) return;
  lastError = msg;
  for (const l of [...errorListeners]) l(msg);
}

function settleHub(res: HubError & { ok?: boolean }): void {
  if (res.ok !== false && (res.status === undefined || res.status < 400)) {
    reportAgentsError('');
    setAgentsConn('open');
    return;
  }
  // A status of 0 is a `fetch` that never got a response, which is a different
  // problem from a refused write and is worth saying differently.
  setAgentsConn(res.status === 0 ? 'error' : 'open');
  reportAgentsError(res.error || 'Could not reach the hub');
}

/** One debounced hub write per id. The local paint has already happened. */
function debounce(key: string, run: () => void): void {
  const prior = writers.get(key);
  if (prior !== undefined) window.clearTimeout(prior);
  writers.set(
    key,
    window.setTimeout(() => {
      writers.delete(key);
      run();
    }, EDIT_DEBOUNCE_MS),
  );
}

/**
 * The parts of a tool the hub has no column for, as a sparse patch. Only defined
 * values are returned, so spreading this never blanks a field.
 */
function localOnlyToolFields(t: Omit<ToolDef, 'id'>): Partial<ToolDef> {
  const out: Partial<ToolDef> = {};
  if (t.bodyTemplate !== undefined) out.bodyTemplate = t.bodyTemplate;
  if (t.headers !== undefined) out.headers = t.headers;
  if (t.hasToken) out.hasToken = true;
  return out;
}

/**
 * Fields the hub cannot hold, carried across an adoption.
 *
 * Without this a boot would erase every REST tool's parameter shape and blank
 * the token indicator — silently, because both are optional. See the header.
 */
function keepLocalToolFields(next: ToolDef[], prev: ToolDef[]): ToolDef[] {
  const byId = new Map(prev.map((t) => [t.id, t]));
  return next.map((t) => {
    const old = byId.get(t.id);
    if (!old) return t;
    const merged: ToolDef = { ...t, ...localOnlyToolFields(old) };
    return merged;
  });
}

/**
 * Everything but the id.
 *
 * The hub assigns tool ids, so the one a seed carries is noise on the wire — and
 * a caller that needs to reference the new tool must use the id `createTool`
 * RETURNS, never the one it passed in.
 */
export function toolBody(t: ToolDef): Omit<ToolDef, 'id'> {
  const { id: _ignored, ...rest } = t;
  return rest;
}

/** Same idea for an agent's hubless `model` override. */
function keepLocalAgentFields(next: AgentDef[], prev: AgentDef[]): AgentDef[] {
  const byId = new Map(prev.map((a) => [a.id, a]));
  return next.map((a) => {
    const old = byId.get(a.id);
    return old?.model ? { ...a, model: old.model } : a;
  });
}

/** Read the quoted etag a 412 hands back. Never strip the quotes off it. */
function etagOf(res: HubError): string | undefined {
  const raw = res.details?.etag;
  return typeof raw === 'string' && raw ? raw : undefined;
}

/** The four fields the hub stores on an agent. `model` is deliberately absent. */
function agentBody(a: AgentDef): {
  name: string;
  systemPrompt: string;
  prompt: string;
  toolIds: string[];
} {
  return { name: a.name, systemPrompt: a.systemPrompt, prompt: a.prompt, toolIds: a.toolIds };
}

/**
 * Write one agent, whole. Last write wins.
 *
 * Guarded by `If-Match`, so the etag is fetched once and then carried forward; a
 * `412` — either kind, and both carry a fresh QUOTED etag — is recovered from
 * once and the write retried against the newest value. The retry re-reads the
 * LOCAL agent at entry, so a keystroke that arrived while the first attempt was
 * in flight is sent rather than lost.
 */
async function pushAgent(id: string, attempt = 0): Promise<void> {
  const a = state.agents.find((x) => x.id === id);
  if (!a) return;
  let etag = agentEtags.get(id);
  if (!etag) {
    const read = await hubFetchAgent(id);
    if (!read.ok) {
      settleHub(read);
      return;
    }
    etag = read.etag;
    if (etag) agentEtags.set(id, etag);
  }
  const res = await hubPutAgent(id, agentBody(a), { etag });
  if (res.ok) {
    if (res.etag) agentEtags.set(id, res.etag);
    settleHub(res);
    return;
  }
  if ((res.code === 'IF_MATCH_FAILED' || res.code === 'IF_MATCH_REQUIRED') && attempt < 1) {
    const fresh = etagOf(res);
    if (fresh) agentEtags.set(id, fresh);
    else agentEtags.delete(id);
    await pushAgent(id, attempt + 1);
    return;
  }
  // The etag we hold is provably wrong from here on; drop it so the next edit
  // re-reads instead of failing the same way twice.
  agentEtags.delete(id);
  settleHub(res);
}

/**
 * Write one tool's stored fields, as a PATCH.
 *
 * `bodyTemplate` and `hasToken` are never sent: the first is discarded by the
 * hub and the second is a relay fact, and sending either would only invite a
 * reader to believe they travel. An omitted field is left alone (the hub's own
 * semantics), so an undefined `searchDepth` changes nothing.
 */
async function pushTool(id: string): Promise<void> {
  const t = state.tools.find((x) => x.id === id);
  if (!t) return;
  const res = await hubPatchTool(id, {
    name: t.name,
    kind: t.kind,
    description: t.description,
    url: t.url ?? '',
    method: t.method ?? 'POST',
    searchDepth: t.searchDepth,
  });
  settleHub(res);
}

/**
 * Load the whole catalogue. One request for agents, tools and the rev.
 *
 * A failure is NOT allowed to empty the list: the local copy is left exactly as
 * it was, so a flaky network shows the last known agents instead of a blank
 * screen while still reporting the failure through `getAgentsError`.
 */
export async function loadAgents(): Promise<void> {
  const res = await hubFetchAgents();
  if (!res.ok) {
    settleHub(res);
    return;
  }
  hubLoaded = true;
  applyCatalogue(res.agents, res.tools);
  settleHub(res);
}

/**
 * Keep the LOCAL copy of any row that has an unsent edit.
 *
 * `debounce()` means a keystroke is on screen ~400 ms before it is on the wire,
 * and any adoption landing inside that window (a create, a clone, a delete, the
 * restore half of an undo) would overwrite it — after which the pending push,
 * which deliberately re-reads the row at send time so late keystrokes are not
 * lost, posts the REVERTED value straight back to the hub. The user's edit is
 * the newest intent there is and it is about to be written; the hub's copy of
 * that one row is known-stale, so it loses. Every other row still adopts.
 */
function preferPending<T extends { id: string }>(next: T[], prev: T[], kind: 'agent' | 'tool'): T[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  return next.map((r) => (writers.has(`${kind}:${r.id}`) ? (byId.get(r.id) ?? r) : r));
}

/** Adopt a catalogue, keeping the fields the hub cannot hold. */
function applyCatalogue(agents: AgentDef[], tools: ToolDef[]): void {
  updateAgents((s) => ({
    ...s,
    agents: preferPending(keepLocalAgentFields(agents.map(normalizeAgent), s.agents), s.agents, 'agent'),
    tools: preferPending(keepLocalToolFields(tools, s.tools), s.tools, 'tool'),
  }));
}

/** True once the hub has answered — the local copy may still be a cache. */
export function agentsReady(): boolean {
  return hubLoaded;
}

/**
 * Create an agent and return its SERVER id.
 *
 * The id cannot be minted here: the hub assigns it, and a locally-invented one
 * would be a row that never exists upstream. So the caller selects the returned
 * id rather than one it made up — which is why this is async and why the
 * optimistic paint is deliberately skipped.
 *
 * `POST /hub/agents` answers `201` with the WHOLE catalogue, so the new agent is
 * the row whose id was not present a moment ago; adopting that list reconciles
 * it without a second read.
 *
 * `extra` exists so a spoken create can set the role, task and tools in the SAME
 * request. Doing it with a follow-up `PUT` would leave a window in which the
 * agent exists upstream with no tools and no prompt — a state a second device
 * can read and a run can be started against.
 */
export async function createAgent(
  name: string,
  extra: { systemPrompt?: string; prompt?: string; toolIds?: string[] } = {},
): Promise<string | null> {
  const before = new Set(state.agents.map((a) => a.id));
  const res = await hubCreateAgent({
    name,
    systemPrompt: '',
    prompt: '',
    toolIds: [],
    ...extra,
  });
  settleHub(res);
  if (!res.ok) return null;
  if (res.agents) {
    applyCatalogue(res.agents, res.tools ?? state.tools);
    const created = res.agents.find((a) => !before.has(a.id));
    if (created) return created.id;
  }
  return res.agent?.id ?? null;
}

/** Copy an agent, its tools and their order. Returns the new agent's id. */
export async function cloneAgent(id: string): Promise<string | null> {
  const before = new Set(state.agents.map((a) => a.id));
  const res = await hubCloneAgent(id);
  settleHub(res);
  const list = res.agents;
  if (!res.ok || !list) return null;
  applyCatalogue(list, res.tools ?? state.tools);
  return list.find((a) => !before.has(a.id))?.id ?? null;
}

/**
 * Edit one agent: paint immediately, write to the hub once the typing stops.
 *
 * Every keystroke in the editor lands here, so the write is debounced per agent
 * — an un-debounced `PUT` per character is what turns a rename into a burst of
 * `If-Match` failures.
 */
export function saveAgent(id: string, patch: Partial<AgentDef>): void {
  updateAgents((s) => ({
    ...s,
    agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a)),
  }));
  debounce(`agent:${id}`, () => {
    void pushAgent(id);
  });
}

/**
 * Delete one agent. SOFT and IRREVERSIBLE on the hub — there is no restore route
 * — and its history is tombstoned in the same action, exactly as before.
 */
export function removeAgent(id: string): void {
  clearSessionsFor(id);
  updateAgents((s) => ({ ...s, agents: s.agents.filter((a) => a.id !== id) }));
  agentEtags.delete(id);
  // A pending edit for the row being deleted would otherwise be pushed at a row
  // that no longer exists, so drop it before adopting the surviving catalogue.
  const pending = writers.get(`agent:${id}`);
  if (pending !== undefined) {
    window.clearTimeout(pending);
    writers.delete(`agent:${id}`);
  }
  void hubDeleteAgent(id).then((res) => {
    settleHub(res);
    if (res.ok && res.agents) applyCatalogue(res.agents, res.tools ?? state.tools);
  });
}

/**
 * Edit one tool: paint immediately, write to the hub once the typing stops.
 *
 * `hasToken` is filtered out of the hub write because it is a RELAY fact; the
 * local flag is what the token button renders, and it is set by `saveSettings`
 * on the relay, not by the tool row.
 */
export function saveTool(id: string, patch: Partial<ToolDef>): void {
  updateAgents((s) => ({
    ...s,
    tools: s.tools.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  }));
  debounce(`tool:${id}`, () => {
    void pushTool(id);
  });
}

/**
 * Create a tool and return its SERVER id.
 *
 * The id is whatever the hub assigns, so a caller that needs to reference the new
 * tool (attaching it to an agent, selecting it) must use the returned value and
 * never the id it passed in.
 */
export async function createTool(tool: Omit<ToolDef, 'id'>): Promise<string | null> {
  const before = new Set(state.tools.map((t) => t.id));
  const res = await hubCreateTool(tool);
  settleHub(res);
  if (!res.ok) return null;
  const freshId = res.items.find((t) => !before.has(t.id))?.id ?? null;
  // Adopt the hub's list, then put back the fields the hub could not keep. This
  // second step matters ONLY for a freshly minted row: `keepLocalToolFields`
  // matches by id, and this id did not exist a moment ago, so an authored
  // `bodyTemplate` would otherwise be discarded in the same commit that created
  // the row — the seeded parameter shape would be gone before the user saw it.
  updateAgents((s) => ({
    ...s,
    tools: keepLocalToolFields(res.items, s.tools).map((t) =>
      t.id === freshId ? { ...t, ...localOnlyToolFields(tool) } : t,
    ),
  }));
  return freshId;
}

/** Remove a tool. HARD on the hub, and `agent_tool` cascades there — so the
 *  dangling ids are pruned locally too, in the same commit. */
export function removeTool(id: string): void {
  updateAgents((s) => ({
    ...s,
    tools: s.tools.filter((t) => t.id !== id),
    agents: s.agents.map((a) =>
      a.toolIds.includes(id) ? { ...a, toolIds: a.toolIds.filter((t) => t !== id) } : a,
    ),
  }));
  writers.delete(`tool:${id}`);
  void hubDeleteTool(id).then((res) => {
    settleHub(res);
    // The hub answered with the surviving catalogue, which is authoritative —
    // adopt it so a tool another device added meanwhile appears here too.
    if (res.ok && res.items.length) updateAgents((s) => ({ ...s, tools: keepLocalToolFields(res.items, s.tools) }));
  });
}

/**
 * Undo: replay the DIFF against the snapshot, not the snapshot itself.
 *
 * Restoring the whole thing would re-send every unchanged row and — far worse —
 * would resurrect an agent the hub has since deleted, because a snapshot is a
 * claim about the past and the hub is a claim about the present. So: rows that
 * differ are written, rows that are new are deleted, and rows that vanished are
 * put back through a real create (which gets a NEW id — the hub does not accept
 * a caller's).
 */
export function restoreAgents(snapshot: AgentsState): void {
  const stamp = (a: AgentDef) => `${a.name}\u0000${a.systemPrompt}\u0000${a.prompt}\u0000${a.toolIds.join(',')}`;
  const before = new Map(snapshot.agents.map((a) => [a.id, a]));
  const now = new Map(state.agents.map((a) => [a.id, a]));
  applyCatalogue(snapshot.agents, snapshot.tools);
  for (const [id, a] of before) {
    const current = now.get(id);
    if (!current) {
      void createAgent(a.name).then((fresh) => {
        if (fresh) saveAgent(fresh, { systemPrompt: a.systemPrompt, prompt: a.prompt, toolIds: a.toolIds });
      });
      continue;
    }
    if (stamp(a) !== stamp(current)) saveAgent(id, { ...agentBody(a) });
  }
  for (const id of now.keys()) if (!before.has(id)) {
    // Adopt what the DELETE reports as surviving. A row created since the
    // snapshot may already have been removed locally by the adoption above, but
    // the re-create in this same loop can land ITS adoption in between and put
    // this row back — leaving a ghost in the list that 404s on the next edit.
    void hubDeleteAgent(id).then((res) => {
      settleHub(res);
      if (res.ok && res.agents) applyCatalogue(res.agents, res.tools ?? state.tools);
    });
  }
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

/**
 * Apply a LOCAL edit and mirror it to the relay.
 *
 * This never reaches the hub. Every agent and tool mutation has its own semantic
 * op — `saveAgent`, `createTool`, `removeTool`, … — because the hub owns those
 * rows and a state blob is not a write. What lands here is the optimistic paint
 * those ops make before they talk to the server, plus the session bookkeeping and
 * the durable cache. Sessions never shrink.
 */
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

/**
 * Apply an agents frame received from the relay.
 *
 * SESSIONS ONLY. Agents and tools are not read from here any more: the hub is
 * their authority, and taking them off an SSE frame would reintroduce exactly the
 * clobber this migration removed — whichever device published last would win
 * regardless of `rev`. `llm` is likewise relay-owned but never arrives this way.
 *
 * The relay's copy still matters for the glasses, which read it; it is a
 * downstream mirror, and `schedulePublish` keeps it current.
 */
export function applyRemoteAgents(next: AgentsState): void {
  if (!next || !Array.isArray(next.agents)) return;
  if (next.updatedAt === lastPublishedAt) return; // our own echo — already applied
  const sessionsClearedAt = mergeClearedAt(state.sessionsClearedAt, next.sessionsClearedAt);
  const sessions = mergeSessions(state.sessions, next.sessions ?? [], sessionsClearedAt);
  if (sessions === state.sessions && sessionsClearedAt === state.sessionsClearedAt) return;
  state = { ...state, sessions, sessionsClearedAt, updatedAt: next.updatedAt ?? Date.now() };
  persist(state);
  emit();
}

/**
 * Kept for the startup wiring, and deliberately a NO-OP.
 *
 * A one-shot seed of the local copy into the relay exists to populate an empty
 * server. The hub is that server now, and it is never empty in the sense this
 * guard meant: pushing a browser cache at it would create agents nobody asked
 * for. The call sites in main.ts can disappear with the agents SSE channel.
 */
export function seedAgentsIfEmpty(): void {
  /* no-op — see above */
}

/**
 * Kept for the startup wiring, and deliberately inconsequential: it no longer
 * records anything, because nothing reads it after the agents SSE channel goes.
 */
export function noteAgentsHandshake(_hasSnapshot: boolean): void {
  /* no-op — see seedAgentsIfEmpty */
}

/**
 * Re-read the bridge-durable copy once the startup handshake is complete.
 * The bridge is often unavailable during the very first frames, so the initial
 * loadLocal() may have missed data written by a previous run.
 *
 * SESSIONS ONLY. The bridge is written by THIS device alone, so applying its
 * agents or tools would silently revert what the hub — or another device — has
 * since stored: the same clobber, reached by a different road.
 */
export async function hydrateAgentsDurable(): Promise<void> {
  const [saved, sessions] = await Promise.all([loadAgentsDurable(), loadSessionsDurable()]);
  if (!saved && !sessions) return;
  const sessionsClearedAt = mergeClearedAt(state.sessionsClearedAt, saved?.sessionsClearedAt);
  const merged = mergeSessions(state.sessions, sessions ?? [], sessionsClearedAt);
  if (merged === state.sessions) return;
  state = { ...state, sessions: merged, sessionsClearedAt, updatedAt: Date.now() };
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
  // The local row is the optimistic paint and the readable transcript; this is
  // the durable write. It cannot block the settle path, and the id it comes back
  // with is remembered against `id` because the hub mints its own.
  mirrorSessionToHub(id, input);
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
  // The hub models the same deletion itself: `clearSessions({agentId})` writes
  // `tombstone.byAgent[agentId]`, which is the server-side twin of the stamp
  // above. Sending it is what makes the clear travel — a second device reads the
  // tombstone and stops showing history the wearer deleted.
  void hubClearSessions(agentId)
    .then((res) => settleHub(res))
    .catch(() => {
      /* the local stamp stands; the hub copy is reconciled on the next boot */
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions on the hub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local session id → hub session id.
 *
 * ⚠ THE HUB MINTS SESSION IDS AND IGNORES A CLIENT ONE. Probed: a `POST` that
 *   carried `id: "c34c4ba6-…"` answered `201` with a *different* `sessionId`
 *   (`c2528eac-…`), the sent id was absent from `GET /sessions`, and a message
 *   append against it was a `404`. There is no error — the field is dropped. So
 *   the id the app records (`run.id`) can never be the key the hub stores, and
 *   every later call — an append, a patch, a delete — needs this mapping.
 *
 * Device-local by nature, which is why it lives under its OWN key rather than in
 * `AgentsState`: a second device has its own local ids for its own runs, and
 * putting this in the shared state blob would make one device's ids look
 * meaningful to another.
 */
const SESSION_ID_MAP_KEY = 'hub:session-ids';

function loadSessionIds(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_ID_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

const sessionIds: Record<string, string> = loadSessionIds();

function rememberHubSessionId(localId: string, hubId: string): void {
  if (!localId || !hubId || sessionIds[localId] === hubId) return;
  sessionIds[localId] = hubId;
  try {
    localStorage.setItem(SESSION_ID_MAP_KEY, JSON.stringify(sessionIds));
  } catch {
    /* ignore — the mapping is re-learned from the hub list on the next boot */
  }
}

/**
 * The id to talk to the hub with, given a local session id.
 *
 * Falls back to the id itself, which is correct for a session that arrived FROM
 * the hub: `sessionFromHub` adopts the hub id as the local id for anything this
 * device did not itself record, so the two coincide for those rows.
 */
export function hubIdForSession(localId: string): string {
  return sessionIds[localId] ?? localId;
}

/** How many unseen sessions to pull transcripts for on one boot. */
const HISTORY_FETCH_SESSIONS = 10;
/** Messages requested per transcript — under `MAX_PAGE_LIMIT` (500). */
const HISTORY_FETCH_MESSAGES = 200;

/** A local message onto the wire. `at` is sent because the type requires it. */
function messageToHub(m: AgentMessage): {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  at: number;
  tool?: string;
  args?: string;
} {
  const out: {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    at: number;
    tool?: string;
    args?: string;
  } = { role: m.role, content: m.content, at: m.at ?? Date.now() };
  if (m.tool) out.tool = m.tool;
  if (m.args) out.args = m.args;
  return out;
}

/**
 * A hub session as the app's own type.
 *
 * `claimed` holds the local ids already taken in this pass. The hub does NOT
 * dedupe on `runId` — probed: two creates with the same `runId` produced TWO
 * sessions — so two rows can legitimately share one, and mapping both onto the
 * same local id would silently collapse them into one. The first (the list is
 * newest-first) takes the `runId`; any later twin falls back to its hub id and
 * shows up as its own row, which is what actually happened.
 *
 * `stopped` has no local equivalent: it is a run that ended deliberately, so it
 * maps onto `done`. `at` is the SERVER's clock — the hub stamps it and ignores
 * anything sent.
 */
function sessionFromHub(h: HubSession, claimed: Set<string>): AgentSession {
  const id = localIdForHubSession(h, claimed);
  claimed.add(id);
  return {
    id,
    agentId: h.agentId ?? '',
    title: h.title,
    messages: [],
    status: h.status === 'error' ? 'error' : h.status === 'running' ? 'running' : 'done',
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

/**
 * Which local id a hub session should be filed under.
 *
 * `runId` is tried FIRST, because it is the round trip of the id this device
 * recorded — the hub stores it verbatim (probed on both the list and the single
 * read). That is what makes a create whose response was LOST recoverable: the
 * next list read re-learns the mapping without a second session appearing.
 * Then the alias table, for a create that landed before `runId` was sent. Then
 * the hub id itself, which is right for a session recorded on another device.
 */
function localIdForHubSession(h: HubSession, claimed: Set<string>): string {
  if (h.runId && !claimed.has(h.runId)) {
    rememberHubSessionId(h.runId, h.id);
    return h.runId;
  }
  const known = Object.entries(sessionIds).find(([, mapped]) => mapped === h.id)?.[0];
  if (known && !claimed.has(known)) return known;
  return h.id;
}

function messageFromHub(m: {
  role: string;
  content: string;
  at: number;
  tool?: string;
  args?: string;
}): AgentMessage {
  const role: AgentMessage['role'] =
    m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool' : 'user';
  const out: AgentMessage = { role, content: m.content, at: m.at };
  if (m.tool) out.tool = m.tool;
  if (m.args) out.args = m.args;
  return out;
}

/**
 * A stable `Idempotency-Key` for the create, or `undefined`.
 *
 * The key exists so that saving the same run twice — a double settle, a retried
 * request — folds onto ONE session instead of two, which is what the hub's own
 * dedup does when it sees the key again (`200` + `duplicate: true` + the SAME
 * `sessionId`). `uid()` returns a canonical uuid v4 in the WebView, and the hub
 * refuses any other shape, so it is used verbatim when it matches and no key is
 * sent when it does not (a legacy `id-…` fallback id) — the local duplicate
 * guard in `settleRun` is the backstop in that case.
 *
 * NOT reused for appends: the hub dedups per operation, so a fresh key is right
 * for each append, and `sendRequest` already holds ONE key across that call's
 * own retries.
 */
function sessionCreateKey(localId: string): string | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localId)
    ? localId
    : undefined;
}

/**
 * Mirror a recorded run onto the hub, and remember the id it minted.
 *
 * Fire-and-forget: `recordSession` is called from the run-settling path, which
 * must not block on a network round-trip, and the local row is already in place.
 * `summarise: false` because the hub would otherwise ask its own provider to
 * write a summary on every run, and it has no credential configured anyway.
 *
 * The WHOLE transcript goes in this one call — the hub stores a create body's
 * `messages` (probed: three turns of `user`/`assistant`/`tool`, `seq` 1-3,
 * `turnCount` 3, the tool name and `args` all preserved), so a finished run needs
 * no follow-up appends.
 *
 * `runId` carries the local id so a LOST response is recoverable from any later
 * list read. It is a LABEL, not a key: probed, a second create with the same
 * `runId` made a SECOND session. The `Idempotency-Key` is the only thing that
 * folds a repeated save onto one session.
 */
function mirrorSessionToHub(
  localId: string,
  input: { agentId: string; title: string; messages: AgentMessage[]; status: string },
): void {
  void hubSaveSession(
    {
      kind: 'agent',
      agentId: input.agentId,
      runId: localId,
      title: input.title,
      // The hub allows `running | done | error | stopped`; the app has the first
      // three, so the value passes through.
      status: input.status === 'running' ? 'running' : input.status === 'error' ? 'error' : 'done',
      messages: input.messages.map(messageToHub),
      summarise: false,
    },
    { key: sessionCreateKey(localId) },
  )
    .then((res) => {
      settleHub(res);
      if (res.ok && res.sessionId) rememberHubSessionId(localId, res.sessionId);
    })
    .catch(() => {
      /* the session is still in the local cache; the next boot re-reads the hub */
    });
}

/**
 * Pull the session list from the hub — the authority for what EXISTS.
 *
 * The list carries no transcript, so a session this device has no turns for gets
 * one extra call for its messages. That is deliberate: `GET /hub/sessions/{id}`
 * deliberately answers metadata and NEVER messages, and rendering a session from
 * it alone produces an empty transcript with no error.
 *
 * ⚠ `tombstone.all` IS NOT ADOPTED, only `byAgent`. `all` is a WATERMARK that
 *   the hub RE-STAMPS TO NOW on every session write, not a deletion predicate —
 *   adopting it as a clear stamp would filter out every session whose
 *   `updatedAt` was in the past, which is all of them but the newest. `byAgent`
 *   is the real per-agent clear and is exactly this app's `sessionsClearedAt`.
 */
export async function hydrateHubSessions(): Promise<void> {
  const res = await hubFetchSessions({ limit: MAX_SESSIONS_TOTAL });
  if (!res.ok) {
    settleHub(res);
    return;
  }
  settleHub(res);
  const claimed = new Set<string>();
  const incoming = res.items.map((h) => sessionFromHub(h, claimed));
  // A transcript is fetched when this device holds NONE for that session — either
  // because it has never seen it, or because its own copy carries only metadata
  // (the local cache is capped, and a restored row can arrive with no turns).
  const have = new Map(state.sessions.map((s) => [s.id, s.messages?.length ?? 0]));
  const needTurns = incoming.filter((s) => !(have.get(s.id) ?? 0)).slice(0, HISTORY_FETCH_SESSIONS);
  await Promise.all(
    needTurns.map(async (s) => {
      const page = await hubFetchSessionMessages(s.id, { limit: HISTORY_FETCH_MESSAGES });
      if (page.ok && page.items.length) s.messages = page.items.map(messageFromHub);
    }),
  );
  const cleared = mergeClearedAt(state.sessionsClearedAt, res.tombstone.byAgent);
  state = {
    ...state,
    sessions: mergeSessions(state.sessions, incoming, cleared),
    sessionsClearedAt: cleared,
    updatedAt: Date.now(),
  };
  persist(state);
  emit();
}

/** The last hub failure, or `''`. Surfaced so a failed write is never silent. */
export function getAgentsError(): string {
  return lastError;
}
export function subscribeAgentsError(fn: (e: string) => void): () => void {
  errorListeners.add(fn);
  fn(lastError);
  return () => {
    errorListeners.delete(fn);
  };
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
