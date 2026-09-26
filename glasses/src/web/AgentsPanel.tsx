// Agents panel (companion web UI).
//
// Mirrors the glasses experience but with a real keyboard: build agents, attach
// tools, pick the model, run a prompt and browse the last 5 sessions. All state
// lives in the shared `agents-store` (synced over the `agents` SSE channel and
// dual-written to durable storage), so anything created here shows up on the
// glasses instantly — and vice versa.
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  clearSessionsFor,
  getAgents,
  recordSession,
  subscribeAgents,
  updateAgents,
} from '../agents-store';
import { getRuns, subscribeRuns } from '../agent-runs';
import { startRun, stopRun } from '../stream';
import { FREE_TOOL_MODELS } from '../models';
import {
  DOCS_TOOL_ID,
  docsTool,
  emptyAgent,
  emptyLlmSettings,
  FILE_TOOL_ID,
  filesTool,
  JEV_TOOL_ID,
  jevTool,
  NOTES_TOOL_ID,
  notesTool,
  orderedAgents,
  SEED_TOOL_ID,
  TODO_TOOL_ID,
  todoTool,
  uid,
  webSearchTool,
  type AgentDef,
  type AgentMessage,
  type AgentSession,
  type AgentsState,
  type ToolDef,
} from '../types';
import { MicButton } from './Dictate';
import { fetchAgentStatus, saveSettings, type AgentStatus } from './agents-client';

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
  const patch = (p: Partial<AgentDef>) =>
    updateAgents((s) => ({
      ...s,
      agents: s.agents.map((a) =>
        a.id === agent.id ? { ...a, ...p, updatedAt: Date.now() } : a,
      ),
    }));

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
   * Nothing is pre-attached: a seed is only ever created by an explicit tap
   * here (or a spoken request, which resolves to the same kinds server-side).
   */
  const attachSeed = (id: string, make: () => ToolDef) =>
    updateAgents((s) => ({
      ...s,
      tools: s.tools.some((t) => t.id === id) ? s.tools : [...s.tools, make()],
      agents: s.agents.map((a) =>
        a.id === agent.id
          ? { ...a, toolIds: [...new Set([...a.toolIds, id])], updatedAt: Date.now() }
          : a,
      ),
    }));

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

  const seedChips = [
    { kind: 'web', label: 'Web search', add: addWebSearchToAgent },
    { kind: 'jev', label: 'Jev decision', add: addJevToAgent },
    { kind: 'files', label: 'Stored docs', add: addFilesToAgent },
    { kind: 'todo', label: 'To-do list', add: addTodoToAgent },
    { kind: 'docs', label: 'Docs', add: addDocsToAgent },
    { kind: 'notes', label: 'Notes', add: addNotesToAgent },
  ];
  const missingSeeds = seedChips.filter((s) => !state.tools.some((t) => t.kind === s.kind));

  /** Create a new REST tool and attach it to this agent in one step. */
  const addRestToolToAgent = () => {
    const id = uid();
    updateAgents((s) => ({
      ...s,
      tools: [
        ...s.tools,
        {
          id,
          name: `tool_${s.tools.length + 1}`,
          kind: 'http',
          description: '',
          url: '',
          method: 'POST',
        },
      ],
      agents: s.agents.map((a) =>
        a.id === agent.id ? { ...a, toolIds: [...a.toolIds, id], updatedAt: Date.now() } : a,
      ),
    }));
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
          title="Create a REST tool and attach it — then set its URL and request body under Tools"
        >
          + REST tool
        </button>
      </div>

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

function ToolEditor({
  tool,
  jevReady,
  filesReady,
  searchProvider,
  searchConfigured,
}: {
  tool: ToolDef;
  jevReady: boolean;
  /** True when the relay holds a credential for the Jarvis document store. */
  filesReady: boolean;
  /** Which backend serves web-search tools, as chosen on the relay. */
  searchProvider?: string;
  searchConfigured?: boolean;
}) {
  const [token, setToken] = useState('');
  const searchProviderLabel = searchConfigured
    ? searchProvider === 'brave'
      ? 'Brave Search'
      : 'Tavily'
    : null;
  const patch = (p: Partial<ToolDef>) =>
    updateAgents((s) => ({
      ...s,
      tools: s.tools.map((t) => (t.id === tool.id ? { ...t, ...p } : t)),
    }));

  const method = tool.method ?? 'POST';
  /** GET puts the template in the query string, POST in the body. */
  const payloadLabel = method === 'GET' ? 'Query parameters (JSON)' : 'Request body (JSON)';
  /**
   * Read the authored template the same way the relay does (see
   * `http-tool.mjs`), so what this field promises and what a run sends cannot
   * disagree. The relay degrades an unparseable template to "no template"
   * rather than failing a run, so the error is surfaced here, where it can be
   * fixed, instead of being discovered by a model that got the wrong shape.
   */
  const template = (() => {
    const raw = (tool.bodyTemplate ?? '').trim();
    if (!raw) return { keys: [] as string[], error: null as string | null };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { keys: [] as string[], error: 'must be a JSON object, e.g. {"query": ""}' };
      }
      return { keys: Object.keys(parsed as Record<string, unknown>), error: null as string | null };
    } catch {
      return { keys: [] as string[], error: 'is not valid JSON' };
    }
  })();

  const saveToken = async () => {
    if (!token.trim()) return;
    await saveSettings({ toolTokens: { [tool.id]: token.trim() } });
    patch({ hasToken: true });
    setToken('');
  };

  return (
    <div className="tool-row">
      <div className="tool-head">
        <input
          className="tool-name"
          value={tool.name}
          onChange={(e) => patch({ name: e.target.value.replace(/\s+/g, '_') })}
          placeholder="tool_name"
        />
        <select value={tool.kind} onChange={(e) => patch({ kind: e.target.value as ToolDef['kind'] })}>
          <option value="web">Web search</option>
          <option value="jev">Jev decision</option>
          <option value="http">REST API</option>
          <option value="files">Stored documents</option>
          {/* The hub's own stores. Changing a tool's kind to one of these is
              legitimate — it is how a wearer turns a REST tool they built into
              "actually, just my notes" — and every one of them is server-held,
              so there is nothing further to configure. */}
          <option value="todo">To-do list</option>
          <option value="docs">Docs (my documents)</option>
          <option value="notes">Notes</option>
        </select>
        <button
          className="icon-btn danger"
          aria-label="Remove tool"
          onClick={() =>
            updateAgents((s) => ({
              ...s,
              tools: s.tools.filter((t) => t.id !== tool.id),
              agents: s.agents.map((a) => ({
                ...a,
                toolIds: a.toolIds.filter((id) => id !== tool.id),
              })),
            }))
          }
        >
          ✕
        </button>
      </div>

      <input
        value={tool.description}
        onChange={(e) => patch({ description: e.target.value })}
        placeholder="What this tool does (the model reads this to decide when to call it)"
      />

      {tool.kind === 'web' && (
        <label className="inline-field">
          Search depth
          <select
            value={tool.searchDepth ?? 'basic'}
            onChange={(e) => patch({ searchDepth: e.target.value as ToolDef['searchDepth'] })}
          >
            <option value="basic">basic (fast, cheap)</option>
            <option value="advanced">advanced (deeper)</option>
          </select>
        </label>
      )}

      {tool.kind === 'web' && (
        <p className="hint-line">
          Served by <strong>{searchProviderLabel}</strong>
          {searchProviderLabel === null
            ? ' — set a search key in Settings.'
            : ' (change the provider in Settings; this tool does not change).'}
        </p>
      )}

      {tool.kind === 'jev' && (
        <p className="empty">
          {jevReady
            ? 'Ready — uses the OpenRouter key held server-side, so there is nothing to configure here.'
            : 'No OpenRouter key on the server yet. Add one in Settings; until then this tool reports that it was skipped rather than guessing.'}
        </p>
      )}

      {tool.kind === 'files' && (
        <p className="empty">
          {filesReady
            ? 'Ready — publishes HTML pages the wearer reads on the Files tab. The document body is never returned to the model, so agents publish and stop.'
            : 'No document-store credential on the server yet. Set JARVIS_FILE_USER and JARVIS_FILE_PWD (or JARVIS_FILE_API_KEY) in the relay environment.'}
        </p>
      )}

      {tool.kind === 'http' && (
        <>
          <input
            value={tool.url ?? ''}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="https://api.example.com/v1/endpoint"
          />
          <label className="inline-field">
            Method
            <select
              value={method}
              onChange={(e) => patch({ method: e.target.value as 'GET' | 'POST' })}
            >
              <option value="POST">POST (JSON body)</option>
              <option value="GET">GET (query params)</option>
            </select>
          </label>
          <textarea
            className="doc-textarea"
            rows={4}
            value={tool.bodyTemplate ?? ''}
            onChange={(e) => patch({ bodyTemplate: e.target.value })}
            placeholder={'{"query": "", "limit": 5}'}
          />
          <p className={template.error ? 'warn-line' : 'hint-line'}>
            {template.error ? (
              <>
                {payloadLabel}: {template.error}
              </>
            ) : template.keys.length ? (
              <>
                {payloadLabel}: the model is offered <strong>{template.keys.join(', ')}</strong>. An
                empty value is <strong>required</strong> of the model; a filled one is the default it
                may omit or override.
              </>
            ) : (
              <>
                {payloadLabel} is empty, so the model sends whatever JSON it decides — which is how a
                REST tool becomes a guessing game. Write an object (e.g.{' '}
                <code>{'{"query": ""}'}</code>) and its keys become the parameters the model is told
                to send.
              </>
            )}
          </p>
          <div className="token-row">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={tool.hasToken ? '••••••• (saved — type to replace)' : 'Bearer token (stored server-side)'}
            />
            <button className="primary" onClick={() => void saveToken()} disabled={!token.trim()}>
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function AgentsPanel() {
  const state = useAgents();
  const runs = useRuns();
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

  const addAgent = () => {
    const a = emptyAgent(`Agent ${state.agents.length + 1}`);
    updateAgents((s) => ({ ...s, agents: [...s.agents, a] }));
    setSelected(a.id);
  };

  const removeAgent = (id: string) => {
    // The agent's history goes with it, through the SAME tombstoned delete as
    // the Clear-history button: filtering the array here would be undone by the
    // next merged frame that still carried those sessions.
    clearSessionsFor(id);
    updateAgents((s) => ({ ...s, agents: s.agents.filter((a) => a.id !== id) }));
    if (selected === id) setSelected(null);
  };

  const addTool = () =>
    updateAgents((s) => ({
      ...s,
      tools: [
        ...s.tools,
        {
          id: uid(),
          name: `tool_${s.tools.length + 1}`,
          kind: 'http',
          description: '',
          url: '',
          method: 'POST',
        },
      ],
    }));

  /**
   * Add one of the seeded kinds to the catalogue if it is not already there.
   *
   * Matched on `kind` rather than `id` so a worn-in install that somehow holds
   * the tool under another id is not given a second, identical one — the same
   * rule the per-agent chips use, and the reason the buttons below are keyed by
   * kind instead of id.
   */
  const addSeed = (kind: ToolDef['kind'], make: () => ToolDef) =>
    updateAgents((s) =>
      s.tools.some((t) => t.kind === kind) ? s : { ...s, tools: [...s.tools, make()] },
    );

  const catalogueSeeds: Array<{ kind: ToolDef['kind']; label: string; make: () => ToolDef }> = [
    { kind: 'web', label: 'Web search', make: webSearchTool },
    { kind: 'jev', label: 'Jev decision', make: jevTool },
    { kind: 'files', label: 'Stored docs', make: filesTool },
    // The hub's own stores — the To-Do list, the Docs library and Notes. They
    // are seeded from here for the same reason the others are: an agent cannot
    // be given a tool the catalogue does not hold, and the wearer should not have
    // to visit the to-do page first to make one exist.
    { kind: 'todo', label: 'To-do list', make: todoTool },
    { kind: 'docs', label: 'Docs', make: docsTool },
    { kind: 'notes', label: 'Notes', make: notesTool },
  ];

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

          <div className="panel-label spaced">
            Tools
          </div>
          {state.tools.map((t) => (
            <ToolEditor
              key={t.id}
              tool={t}
              jevReady={statusInfo?.jev === true}
              filesReady={statusInfo?.files?.configured === true}
              searchProvider={statusInfo?.search?.provider}
              searchConfigured={statusInfo?.search?.configured}
            />
          ))}
          <div className="docs-actions">
            <button onClick={addTool}>+ Custom REST tool</button>
            {catalogueSeeds.map((seed) => (
              <button key={seed.kind} onClick={() => addSeed(seed.kind, seed.make)}>
                + {seed.label}
              </button>
            ))}
          </div>

          <div className="panel-label spaced">
            Model
          </div>
          <input
            list="free-tool-models"
            value={state.llm.model}
            onChange={(e) =>
              updateAgents((s) => ({ ...s, llm: { ...s.llm, model: e.target.value } }))
            }
            placeholder={emptyLlmSettings().model}
          />
          <datalist id="free-tool-models">
            {FREE_TOOL_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="hint-line">
            Only tool-capable free models work here. The key itself is stored server-side in
            Settings.
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
