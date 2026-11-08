// Agents panel (companion web UI).
//
// Mirrors the glasses experience but with a real keyboard: build agents, attach
// tools, pick the model, run a prompt and browse the last 5 sessions. Agents and
// tools are HUB-OWNED — every edit here is a semantic op in `agents-store` that
// issues one request to `/hub/agents` or `/hub/tools`, so the glasses, the
// desktop and any other paired device converge on `rev` rather than on whichever
// copy happened to be published last. Sessions still ride the `agents` SSE
// channel and are dual-written to durable storage.
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  clearSessionsFor,
  createAgent,
  createTool,
  getAgents,
  getAgentsError,
  installStarterAgents,
  recordSession,
  removeAgent as removeAgentFromStore,
  repairAgentTools,
  saveAgent,
  subscribeAgents,
  subscribeAgentsError,
  toolBody,
} from '../agents-store';
import { STARTER_AGENTS } from '../agent-starters';
import { planToolRepair } from '../agent-repair';
import { getRuns, subscribeRuns } from '../agent-runs';
import { startRun, stopRun } from '../stream';
import { intentCatalog } from '../ai/intents';
import { snapshotForRun } from '../location/run';
import {
  DOCS_TOOL_ID,
  docsTool,
  FILE_TOOL_ID,
  filesTool,
  JEV_TOOL_ID,
  jevTool,
  LOCATION_TOOL_ID,
  METRICS_TOOL_ID,
  metricsTool,
  locationTool,
  MAX_AGENT_TOOLS,
  NOTES_TOOL_ID,
  notesTool,
  orderedAgents,
  SEED_TOOL_ID,
  TODO_TOOL_ID,
  todoTool,
  webSearchTool,
  type AgentDef,
  type AgentMessage,
  type AgentSession,
  type AgentsState,
  type ToolDef,
} from '../types';
import { MicButton } from './Dictate';
import { RestToolConfig } from './ToolsPanel';
import { fetchAgentStatus, type AgentStatus } from './agents-client';

function useAgents(): AgentsState {
  return useSyncExternalStore(subscribeAgents, getAgents);
}

/**
 * How many of an agent's attachments the catalogue actually holds.
 *
 * Counted against `tools`, not `toolIds`: `run()` builds the run's toolset with
 * `state.tools.filter(agent.toolIds.includes(id))`, so an id naming a tool the
 * catalogue no longer holds is one the relay never receives — and a filter
 * cannot report what it did not find. A count that included it would be a number
 * the run cannot honour.
 */
function liveToolCount(agent: AgentDef, tools: ToolDef[]): number {
  return agent.toolIds.filter((id) => tools.some((t) => t.id === id)).length;
}

/** Live relay runs (transient — the finished transcript becomes a session). */
function useRuns() {
  return useSyncExternalStore(subscribeRuns, getRuns);
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Collapse a transcript into readable lines. */
function Transcript({ messages }: { messages: AgentMessage[] }) {
  return (
    <div className="agent-transcript">
      {messages.map((m, i) => {
        const cls =
          m.role === 'user' ? 'msg user' : m.role === 'tool' ? 'msg tool' : 'msg assistant';
        const label = m.role === 'user' ? 'You' : m.role === 'tool' ? `🔧 ${m.tool ?? 'tool'}` : '🤖';
        return (
          <div key={i} className={cls}>
            <span className="msg-label">{label}</span>
            <span className="msg-body">{m.content || '(empty)'}</span>
          </div>
        );
      })}
    </div>
  );
}

function AgentEditor({ agent }: { agent: AgentDef }) {
  const state = useAgents();
  /**
   * Paint now, PUT once the typing stops. A keystroke is not a request — sending
   * one `PUT` per character would turn a rename into a burst of `If-Match`
   * refreshes against a record nobody else is touching.
   */
  const patch = (p: Partial<AgentDef>) => saveAgent(agent.id, p);

  /** Why a tool could not be attached, in the wearer's words. Empty when fine. */
  const [seedNote, setSeedNote] = useState('');

  const toggleTool = (id: string) => {
    const on = agent.toolIds.includes(id);
    // Attaching past the cap is refused HERE rather than at run time, where it
    // would be a run that cannot start. Detaching is always allowed.
    if (!on && liveToolCount(agent, state.tools) >= MAX_AGENT_TOOLS) return;
    patch({
      toolIds: on ? agent.toolIds.filter((t) => t !== id) : [...agent.toolIds, id],
    });
  };

  /**
   * Opt this agent in to one of the seeded tool kinds, creating it if the
   * catalogue does not hold it yet. The two steps are ONE action because to a
   * wearer they are one decision — "give this agent the document store" — and
   * splitting them is what produced a second, near-identical row of buttons.
   *
   * Async now, and it has to be: the hub mints the tool's id, so the attach can
   * only name it once the create has answered. Attaching the id the seed was
   * authored with would reference a row that never existed.
   *
   * Nothing is pre-attached: a seed is only ever created by an explicit tap
   * here (or a spoken request, which resolves to the same kinds server-side).
   */
  const attachSeed = async (id: string, make: () => ToolDef) => {
    if (liveToolCount(agent, state.tools) >= MAX_AGENT_TOOLS) {
      setSeedNote(`This agent already holds ${MAX_AGENT_TOOLS} tools \u2014 remove one first.`);
      return;
    }
    setSeedNote('');
    const seed = make();
    const toolId = getAgents().tools.some((t) => t.id === id) ? id : await createTool(toolBody(seed));
    // A refused create used to `return` here, which left the chip looking like a
    // button that does nothing. It can genuinely be refused: the hub validates
    // `kind` against a closed list, so a kind it does not know yet cannot be
    // minted at all. Naming the tool is what makes that debuggable from a phone.
    if (!toolId) {
      setSeedNote(
        `The catalogue would not create the ${seed.name} tool, so nothing was attached. ` +
          'If the server does not support this tool kind yet, it has to be added there first.',
      );
      return;
    }
    const live = getAgents().agents.find((a) => a.id === agent.id);
    if (!live || live.toolIds.includes(toolId)) return;
    saveAgent(agent.id, { toolIds: [...live.toolIds, toolId] });
  };

  /**
   * The seed kinds, as chips. web, jev and the three hub stores need no
   * configuration (the relay holds their credentials, and the hub stores ARE the
   * relay's own state), which is why they can be created from here at all; files
   * is the same. A kind the catalogue already holds is NOT listed twice — it is
   * the toggle chip above, so there is exactly one chip per tool.
   */
  const addWebSearchToAgent = () => attachSeed(SEED_TOOL_ID, webSearchTool);
  const addJevToAgent = () => attachSeed(JEV_TOOL_ID, jevTool);
  const addFilesToAgent = () => attachSeed(FILE_TOOL_ID, filesTool);
  const addTodoToAgent = () => attachSeed(TODO_TOOL_ID, todoTool);
  const addDocsToAgent = () => attachSeed(DOCS_TOOL_ID, docsTool);
  const addNotesToAgent = () => attachSeed(NOTES_TOOL_ID, notesTool);
  const addLocationToAgent = () => attachSeed(LOCATION_TOOL_ID, locationTool);
  const addMetricsToAgent = () => attachSeed(METRICS_TOOL_ID, metricsTool);

  const seedChips = [
    { kind: 'web', label: 'Web search', add: addWebSearchToAgent },
    { kind: 'jev', label: 'Jev decision', add: addJevToAgent },
    { kind: 'files', label: 'Stored docs', add: addFilesToAgent },
    { kind: 'todo', label: 'To-do list', add: addTodoToAgent },
    { kind: 'docs', label: 'Docs', add: addDocsToAgent },
    { kind: 'notes', label: 'Notes', add: addNotesToAgent },
    { kind: 'location', label: 'Location', add: addLocationToAgent },
    { kind: 'metrics', label: 'Dashboard numbers', add: addMetricsToAgent },
  ];
  const missingSeeds = seedChips.filter((s) => !state.tools.some((t) => t.kind === s.kind));
  /**
   * Attached ids the catalogue no longer holds.
   *
   * `run()` builds the run's toolset with `state.tools.filter(agent.toolIds
   * .includes(id))`, so a dangling id is a tool the wearer believes is attached
   * and the relay never receives — silently, because a filter cannot report what
   * it did not find. That is the same class of failure as an advertises-but-absent
   * tool: the run looks wired up and behaves as if it is not. The chip row is
   * built from `state.tools`, so a dangling id draws NO chip at all and leaves
   * nothing on screen to explain the gap, which is why it is named here.
   */
  const missingToolIds = agent.toolIds.filter((id) => !state.tools.some((t) => t.id === id));
  /**
   * The REST tools THIS agent holds.
   *
   * A REST tool's URL and request shape describe the job the agent was built
   * for, so they are edited here, next to the chips that attach them, rather
   * than in the global catalogue where two agents would have to share one
   * endpoint. Only the attached ones get a card — settings for a tool the run
   * cannot call are settings that can never matter.
   */
  const attachedRestTools = state.tools.filter(
    (t) => t.kind === 'http' && agent.toolIds.includes(t.id),
  );

  /** Create a new REST tool and attach it to this agent in one step. */
  const addRestToolToAgent = async () => {
    if (liveToolCount(agent, state.tools) >= MAX_AGENT_TOOLS) return;
    const id = await createTool({
      name: `tool_${getAgents().tools.length + 1}`,
      kind: 'http',
      description: '',
      url: '',
      method: 'POST',
    });
    if (!id) return;
    const live = getAgents().agents.find((a) => a.id === agent.id);
    if (!live || live.toolIds.includes(id)) return;
    saveAgent(agent.id, { toolIds: [...live.toolIds, id] });
  };

  return (
    <div className="agent-editor">
      <label className="field-label">Name</label>
      <input
        value={agent.name}
        onChange={(e) => patch({ name: e.target.value })}
        placeholder="Research assistant"
      />

      <label className="field-label">System prompt</label>
      <div className="field-toolbar">
        <MicButton compact onText={(t) => patch({ systemPrompt: `${agent.systemPrompt}\n${t}`.trim() })} />
      </div>
      <textarea
        className="doc-textarea"
        rows={4}
        value={agent.systemPrompt}
        onChange={(e) => patch({ systemPrompt: e.target.value })}
        placeholder="You are a concise research assistant. Search the web when facts are needed, then answer in 3 bullet points."
      />

      <label className="field-label">Trigger prompt</label>
      <p className="hint-line">
        What the glasses run when you pick this agent and choose <strong>Trigger</strong>.
      </p>
      <div className="field-toolbar">
        <MicButton compact onText={(t) => patch({ prompt: `${agent.prompt}\n${t}`.trim() })} />
      </div>
      <textarea
        className="doc-textarea"
        rows={3}
        value={agent.prompt}
        onChange={(e) => patch({ prompt: e.target.value })}
        placeholder="What is new in AI this week?"
      />

      <label className="field-label">Tools</label>
      <p className="hint-line">
        Tap to attach or detach. A chip marked <strong>+</strong> is a tool this install does not
        hold yet — the first tap creates it.
      </p>
      <div className="chip-row">
        {state.tools.map((t) => (
          <button
            key={t.id}
            className={agent.toolIds.includes(t.id) ? 'doc-chip active' : 'doc-chip'}
            onClick={() => toggleTool(t.id)}
            title={t.description || t.kind}
          >
            {agent.toolIds.includes(t.id) ? '✓ ' : ''}
            {t.name}
          </button>
        ))}
        {missingSeeds.map((s) => (
          <button
            key={s.kind}
            className="doc-chip"
            onClick={s.add}
            title={`Create the ${s.label} tool and attach it to this agent`}
          >
            + {s.label}
          </button>
        ))}
        {seedNote && <p className="warn-line">{seedNote}</p>}
        <button
          className="doc-chip"
          onClick={addRestToolToAgent}
          title="Create a REST tool and attach it — then set its URL, method, headers and body below"
        >
          + REST tool
        </button>
      </div>

      {liveToolCount(agent, state.tools) >= MAX_AGENT_TOOLS && (
        <p className="hint-line">
          This agent carries the maximum {MAX_AGENT_TOOLS} tools a run can execute — detach one
          before attaching another.
        </p>
      )}

      {missingToolIds.length > 0 && (
        <p className="warn-line">
          ⚠️ {missingToolIds.length} attached tool{missingToolIds.length === 1 ? '' : 's'} no longer
          exist{missingToolIds.length === 1 ? 's' : ''} — the run cannot call{' '}
          {missingToolIds.length === 1 ? 'it' : 'them'}.{' '}
          <button
            className="doc-chip"
            onClick={() =>
              patch({ toolIds: agent.toolIds.filter((id) => state.tools.some((t) => t.id === id)) })
            }
          >
            Remove missing
          </button>
        </p>
      )}

      {attachedRestTools.map((t) => (
        <RestToolConfig key={t.id} tool={t} />
      ))}

      <label className="field-label">Model override (blank = global)</label>
      <input
        value={agent.model ?? ''}
        onChange={(e) => patch({ model: e.target.value || undefined })}
        placeholder={state.llm.model}
        list="free-tool-models"
      />
    </div>
  );
}

/**
 * Fleet maintenance: the two things a fleet of twenty makes visible at once.
 *
 * WHY IT IS A BUTTON AND NOT AN AUTOMATIC FIX
 *   Both actions change agents the wearer owns, so both are shown as a PREVIEW
 *   ("12 agents cannot fetch anything") and applied only when tapped. An
 *   automatic migration of someone's own prompts and toolset is the kind of
 *   helpfulness that is indistinguishable from damage.
 *
 * WHY IT IS IN THIS PANEL
 *   These are exactly the two facts you can only see from the whole list: which
 *   agents have no way to fetch, and which of the worthwhile ones do not exist
 *   yet. Both write through `saveAgent`/`createAgent`, the same If-Match path
 *   every other edit here uses — there is no second way into the hub.
 *
 * It renders NOTHING when there is nothing to do, which is the normal state.
 */
function FleetMaintenance() {
  const state = useAgents();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const repairs = planToolRepair(state.agents, state.tools);
  const have = new Set(state.agents.map((a) => a.name.trim().toLowerCase()));
  const missing = STARTER_AGENTS.filter((s) => !have.has(s.name.trim().toLowerCase()));

  if (!repairs.length && !missing.length && !note) return null;

  const fixTools = () => {
    const n = repairAgentTools();
    setNote(`Attached ${n} tool row${n === 1 ? '' : 's'} — those agents can fetch now.`);
  };

  const install = async () => {
    setBusy(true);
    setNote('');
    try {
      const res = await installStarterAgents();
      const parts: string[] = [];
      if (res.created.length) parts.push(`Added ${res.created.join(', ')}.`);
      if (res.skipped.length) parts.push(`${res.skipped.length} were already there.`);
      if (res.blocked.length) parts.push(`Blocked: ${res.blocked.join('; ')}.`);
      setNote(parts.join(' ') || 'Nothing to install.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--line, #333)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 14,
      }}
    >
      <div className="panel-label">Fleet health</div>

      {repairs.length > 0 && (
        <>
          <p className="warn-line" style={{ marginTop: 6 }}>
            ⚠️ {repairs.length} agent{repairs.length === 1 ? '' : 's'} hold no tool that can
            fetch anything, so a prompt asking for current information has nothing to read it
            with.
          </p>
          <p className="hint-line">
            {repairs.slice(0, 6).map((r) => r.name).join(', ')}
            {repairs.length > 6 ? `, +${repairs.length - 6} more` : ''}
          </p>
          <div className="field-toolbar">
            <button className="primary" onClick={fixTools} disabled={busy}>
              Attach a fetching tool to {repairs.length}
            </button>
          </div>
        </>
      )}

      {missing.length > 0 && (
        <>
          <p className="hint-line" style={{ marginTop: 8 }}>
            {missing.length} starter agent{missing.length === 1 ? '' : 's'} not installed:{' '}
            {missing.map((s) => s.name).join(', ')}.
          </p>
          <ul className="hint-line" style={{ margin: '4px 0 6px 16px' }}>
            {missing.map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong> — {s.why} <em>({s.cadence})</em>
              </li>
            ))}
          </ul>
          <div className="field-toolbar">
            <button className="primary" onClick={install} disabled={busy}>
              {busy ? 'Adding…' : `Add ${missing.length} starter agent${missing.length === 1 ? '' : 's'}`}
            </button>
          </div>
          <p className="hint-line" style={{ marginTop: 6 }}>
            Adding one does not schedule it. A schedule lives in the relay — see{' '}
            <code>web/.g2-agent-cron.example.json</code>.
          </p>
        </>
      )}

      {note && (
        <p className="hint-line" style={{ marginTop: 8 }}>
          ✓ {note}
        </p>
      )}
    </div>
  );
}

// `ToolEditor` and the catalogue's seed buttons live in `./ToolsPanel` now —
// they are global settings, and the catalogue column that held them is what this
// move removed. `RestToolConfig` is there too, and is what the agent page
// renders under its chips.
export function AgentsPanel() {
  const state = useAgents();
  const runs = useRuns();
  /** A refused hub write must never be silent — it is the only signal there is. */
  const hubError = useSyncExternalStore(subscribeAgentsError, getAgentsError);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [statusInfo, setStatusInfo] = useState<AgentStatus | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null);
  /** Run id this tab started, so we only save the session once. */
  const [myRunId, setMyRunId] = useState<string | null>(null);

  useEffect(() => {
    void fetchAgentStatus().then(setStatusInfo);
  }, [state.updatedAt]);

  const agent = state.agents.find((a) => a.id === selected) ?? state.agents[0] ?? null;
  const sessions = agent ? state.sessions.filter((s) => s.agentId === agent.id) : [];
  const shown: AgentSession | null =
    sessions.find((s) => s.id === openSession) ?? sessions[0] ?? null;

  // A run started HERE (or on the glasses) streams in over SSE. Show THIS
  // agent's running run and nothing else. The old fallback to myRunId is what
  // let a neighbouring agent's live transcript paint under this agent's header
  // and left Run disabled for an agent that was not running at all.
  const live = agent
    ? (runs.find((r) => r.agentId === agent.id && r.status === 'running') ??
      null)
    : null;
  const running = live?.status === 'running';
  const status = live?.statusText ?? '';

  // The run this tab started, tracked by RUN id wherever the master list has
  // moved since — the transcript pane above is not its home any more.
  const myRun = myRunId ? (runs.find((r) => r.id === myRunId) ?? null) : null;

  // An outcome message belongs to the agent that produced it.
  useEffect(() => setError(''), [agent?.id]);

  // Persist the transcript as a session exactly once, using the RUN id so the
  // browser and the glasses converge on the same session id.
  useEffect(() => {
    if (!myRun || myRun.status === 'running') return;
    setMyRunId(null);
    // Only surface the outcome on the agent it belongs to.
    if (agent && myRun.agentId === agent.id) {
      setError(myRun.status === 'error' ? (myRun.error ?? 'run failed') : '');
    }
    setOpenSession(
      recordSession({
        id: myRun.id,
        agentId: myRun.agentId,
        title: myRun.title || myRun.prompt.slice(0, 48),
        messages: myRun.messages.map((m) => ({
          role: m.role,
          content: m.content,
          tool: m.tool,
          args: m.args,
          at: m.at,
        })),
        status: myRun.status === 'done' ? 'done' : 'error',
      }),
    );
  }, [myRun, myRunId, agent?.id]);

  /**
   * The hub assigns the id, so the selection can only follow the create's
   * answer. Nothing is painted optimistically here: a row with an invented id
   * would be a row that never exists upstream, and the editor would be naming
   * it in every subsequent write.
   */
  const addAgent = async () => {
    const id = await createAgent(`Agent ${getAgents().agents.length + 1}`);
    if (id) setSelected(id);
  };

  const removeAgent = (id: string) => {
    // One action, through the store: the agent is soft-deleted on the hub —
    // irreversibly, there is no restore route — and its history is tombstoned by
    // the same call. Filtering the array here would leave the hub holding a row
    // this device simply stopped drawing, and the next read would bring it back.
    removeAgentFromStore(id);
    if (selected === id) setSelected(null);
  };

  /**
   * Runs go to the RELAY, not this tab: the loop keeps executing if the phone
   * backgrounds, and both the glasses detail pane and this panel watch the same
   * transcript arrive over SSE.
   */
  const run = async (text?: string) => {
    const body = (text ?? prompt).trim();
    if (!agent || !body || running) return;
    const tools = state.tools.filter((t) => agent.toolIds.includes(t.id));
    setError('');
    const started = await startRun({
      agent: {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        model: agent.model,
      },
      tools,
      prompt: body,
      // Only an agent carrying the location tool pays for the read — it can
      // raise the browser's permission prompt, so it must never be raised for a
      // run that has no use for a position.
      location: await snapshotForRun(tools),
      // What the run may ask THIS device to do. The panel runs the same code as
      // the glasses, so the catalogue is the same registry-derived list — an
      // action reachable from a tab is reachable by an agent on either surface.
      capabilities: intentCatalog(),
      model: agent.model || state.llm.model,
    });
    if (!started.runId) {
      setError(`relay refused the run — ${started.error}`);
      return;
    }
    setMyRunId(started.runId);
    if (!text) setPrompt('');
  };

  return (
    <div className="agents-panel">
      {/* Only warn once the status probe has actually answered — an unresolved
          probe used to read as "no key", which is wrong on a hosted relay whose
          keys come from the server environment. */}
      {statusInfo && !statusInfo.llm && (
        <p className="warn-line">
          ⚠️ No LLM key yet — open <strong>Settings</strong> to add one, or set{' '}
          <code>{statusInfo.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENROUTER_API_KEY'}</code>{' '}
          in the server environment. Agents can be built and saved without it.
        </p>
      )}
      {statusInfo?.llm && !statusInfo.search?.configured && (
        <p className="warn-line">
          ⚠️ {statusInfo.search?.provider === 'brave' ? 'Brave Search' : 'Tavily'} key missing —
          web-search tools will fail until it is set.
        </p>
      )}
      {statusInfo?.llm && statusInfo.source?.llm?.key === 'env' && (
        <p className="hint-line">
          ✓ LLM key provided by the server environment
          {statusInfo.source?.search?.key === 'env' ? ' (web search too)' : ''}.
        </p>
      )}
      {/* Agents and tools live on the hub now, so a refused write is the whole
          story of why an edit did not stick. Saying it here is the difference
          between a stale screen and a visible failure. */}
      {hubError && <p className="warn-line">⚠️ {hubError}</p>}

      <FleetMaintenance />

      <div className="agents-split">
        {/* ── master: agents + tools ─────────────────────────────────── */}
        <div className="agents-master">
          <div className="panel-label">Agents</div>
          <ul className="agent-list">
            {state.agents.length === 0 && <li className="empty">No agents yet.</li>}
            {orderedAgents(state.agents).map((a) => (
              <li key={a.id} className={a.id === agent?.id ? 'agent-row active' : 'agent-row'}>
                <button className="agent-pick" onClick={() => setSelected(a.id)}>
                  <span className="agent-name">{a.name || '(unnamed)'}</span>
                  <span className="agent-meta">
                    {liveToolCount(a, state.tools)} tool
                    {liveToolCount(a, state.tools) === 1 ? '' : 's'}
                  </span>
                </button>
                <button className="icon-btn danger" onClick={() => removeAgent(a.id)} aria-label="Remove agent">
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button className="primary" onClick={addAgent}>
            + New agent
          </button>
          {/* The catalogue used to be drawn here, under the agent list, with the
              global model below it. Both are GLOBAL, and this column is about
              one agent, so they moved to Settings — where a catalogue belongs.
              What is left here is what an agent owns: its tools and its model
              OVERRIDE. */}
          <p className="hint-line">
            Tools and the global model now live in <strong>Settings</strong>. This page holds what
            belongs to one agent — its prompt, which tools it attaches, and its model override.
          </p>
        </div>

        {/* ── detail: run + history ──────────────────────────────────── */}
        <div className="agents-detail">
          {!agent ? (
            <p className="empty">Create an agent to get started.</p>
          ) : (
            <>
              <AgentEditor agent={agent} />

              <div className="panel-label spaced">
                Run
              </div>
              <div className="field-toolbar">
                <MicButton onText={(t) => setPrompt((p) => (p ? `${p} ${t}` : t))} />
              </div>
              <textarea
                className="doc-textarea"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
                }}
                placeholder="Ask the agent… (⌘/Ctrl+Enter to run)"
              />
              <div className="docs-actions">
                <button className="primary" onClick={() => void run()} disabled={running || !prompt.trim()}>
                  {running ? `Running… ${status}` : '▶ Run agent'}
                </button>
                <button
                  className="primary"
                  onClick={() => void run(agent.prompt)}
                  disabled={running || !agent.prompt.trim()}
                  title="Run the saved Trigger prompt (same as the glasses menu)"
                >
                  ⚡ Trigger prompt
                </button>
                {running && live && (
                  <button onClick={() => void stopRun(live.id)}>■ Stop</button>
                )}
              </div>
              {error && <p className="warn-line">⚠️ {error}</p>}

              {live && (
                <div className="agent-output">
                  <div className="panel-label">
                    Live run · {live.status}
                    {live.status === 'running' ? ` · ${live.statusText}` : ''}
                  </div>
                  <Transcript
                    messages={live.messages.map((m) => ({
                      role: m.role,
                      content: m.content,
                      tool: m.tool,
                      args: m.args,
                      at: m.at,
                    }))}
                  />
                </div>
              )}

              <div className="panel-label spaced">
                History · last {sessions.length}/5
              </div>
              {sessions.length === 0 ? (
                <p className="empty">No sessions yet.</p>
              ) : (
                <>
                  <div className="doc-tabs">
                    {sessions.map((s, i) => (
                      <button
                        key={s.id}
                        className={shown?.id === s.id ? 'doc-chip active' : 'doc-chip'}
                        onClick={() => setOpenSession(s.id)}
                        title={s.title}
                      >
                        {i + 1}. {s.title || 'Session'}
                        <span className="chip-time">{relTime(s.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                  {shown && (
                    <div className="agent-output">
                      <Transcript messages={shown.messages} />
                    </div>
                  )}
                  <div className="docs-actions">
                    <button
                      className="icon-btn wide danger"
                      onClick={() => clearSessionsFor(agent.id)}
                    >
                      Clear history
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
