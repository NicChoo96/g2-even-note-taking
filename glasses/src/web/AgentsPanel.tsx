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
  recordSession,
  removeAgent as removeAgentFromStore,
  saveAgent,
  subscribeAgents,
  subscribeAgentsError,
  toolBody,
} from '../agents-store';
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
  locationTool,
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

  const toggleTool = (id: string) =>
    patch({
      toolIds: agent.toolIds.includes(id)
        ? agent.toolIds.filter((t) => t !== id)
        : [...agent.toolIds, id],
    });

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
    const toolId = getAgents().tools.some((t) => t.id === id) ? id : await createTool(toolBody(make()));
    if (!toolId) return;
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

  const seedChips = [
    { kind: 'web', label: 'Web search', add: addWebSearchToAgent },
    { kind: 'jev', label: 'Jev decision', add: addJevToAgent },
    { kind: 'files', label: 'Stored docs', add: addFilesToAgent },
    { kind: 'todo', label: 'To-do list', add: addTodoToAgent },
    { kind: 'docs', label: 'Docs', add: addDocsToAgent },
    { kind: 'notes', label: 'Notes', add: addNotesToAgent },
    { kind: 'location', label: 'Location', add: addLocationToAgent },
  ];
  const missingSeeds = seedChips.filter((s) => !state.tools.some((t) => t.kind === s.kind));
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
        <button
          className="doc-chip"
          onClick={addRestToolToAgent}
          title="Create a REST tool and attach it — then set its URL, method, headers and body below"
        >
          + REST tool
        </button>
      </div>

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
                    {a.toolIds.length} tool{a.toolIds.length === 1 ? '' : 's'}
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
