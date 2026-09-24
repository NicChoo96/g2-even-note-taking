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
  emptyAgent,
  emptyLlmSettings,
  FILE_TOOL_ID,
  filesTool,
  jevTool,
  orderedAgents,
  SEED_TOOL_ID,
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

  /** Enable the seeded web-search tool (creating it if it was removed) and attach it. */
  const addWebSearchToAgent = () =>
    updateAgents((s) => {
      const has = s.tools.some((t) => t.id === SEED_TOOL_ID);
      return {
        ...s,
        tools: has ? s.tools : [...s.tools, webSearchTool()],
        agents: s.agents.map((a) =>
          a.id === agent.id
            ? {
                ...a,
                toolIds: [...new Set([...a.toolIds, SEED_TOOL_ID])],
                updatedAt: Date.now(),
              }
            : a,
        ),
      };
    });

  /**
   * Enable the document-store tool (creating it if it was removed) and attach it.
   * Like jev it needs no per-tool configuration — the credential lives on the
   * relay, which is what lets an agent publish a page without ever holding one.
   */
  const addFilesToAgent = () =>
    updateAgents((s) => {
      const has = s.tools.some((t) => t.id === FILE_TOOL_ID);
      return {
        ...s,
        tools: has ? s.tools : [...s.tools, filesTool()],
        agents: s.agents.map((a) =>
          a.id === agent.id
            ? {
                ...a,
                toolIds: [...new Set([...a.toolIds, FILE_TOOL_ID])],
                updatedAt: Date.now(),
              }
            : a,
        ),
      };
    });

  /**
   * Enable the typed-decision tool (creating it if it was removed) and attach it.
   * It needs no configuration of its own — it uses the relay's OpenRouter key,
   * so there is nothing to save here.
   */
  const addJevToAgent = () =>
    updateAgents((s) => {
      const has = s.tools.some((t) => t.id === 'tool-jev');
      return {
        ...s,
        tools: has ? s.tools : [...s.tools, jevTool()],
        agents: s.agents.map((a) =>
          a.id === agent.id
            ? {
                ...a,
                toolIds: [...new Set([...a.toolIds, 'tool-jev'])],
                updatedAt: Date.now(),
              }
            : a,
        ),
      };
    });

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
      {state.tools.length === 0 && <p className="empty">No tools yet — add one below.</p>}
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
      </div>
      <div className="docs-actions">
        <button onClick={addWebSearchToAgent}>+ Web search</button>
        <button onClick={addJevToAgent}>+ Jev decision</button>
        <button onClick={addFilesToAgent}>+ Stored docs</button>
        <button onClick={addRestToolToAgent}>+ REST tool</button>
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
              value={tool.method ?? 'POST'}
              onChange={(e) => patch({ method: e.target.value as 'GET' | 'POST' })}
            >
              <option value="POST">POST (JSON body)</option>
              <option value="GET">GET (query params)</option>
            </select>
          </label>
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
            <button
              onClick={() =>
                updateAgents((s) =>
                  s.tools.some((t) => t.id === SEED_TOOL_ID)
                    ? s
                    : { ...s, tools: [...s.tools, webSearchTool()] },
                )
              }
            >
              + Web search
            </button>
            <button
              onClick={() =>
                updateAgents((s) =>
                  s.tools.some((t) => t.id === FILE_TOOL_ID)
                    ? s
                    : { ...s, tools: [...s.tools, filesTool()] },
                )
              }
            >
              + Stored docs
            </button>
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
