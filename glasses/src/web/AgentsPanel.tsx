// Agents panel (companion web UI).
//
// Mirrors the glasses experience but with a real keyboard: build agents, attach
// tools, pick the model, run a prompt and browse the last 5 sessions. All state
// lives in the shared `agents-store` (synced over the `agents` SSE channel and
// dual-written to durable storage), so anything created here shows up on the
// glasses instantly — and vice versa.
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  getAgents,
  recordSession,
  subscribeAgents,
  updateAgents,
} from '../agents-store';
import { runAgent } from '../agents';
import {
  emptyAgent,
  emptyLlmSettings,
  tavilyTool,
  uid,
  type AgentDef,
  type AgentMessage,
  type AgentSession,
  type AgentsState,
  type ToolDef,
} from '../types';
import { MicButton } from './Dictate';
import { fetchAgentStatus, saveSettings, type AgentStatus } from './agents-client';

/** Free OpenRouter models that actually support tool calling (probed live). */
const FREE_TOOL_MODELS = [
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'cohere/north-mini-code:free',
  'liquid/lfm-2.5-2.6b:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'dots-studio/dots-3-note-preview:free',
  'inclusionai/ling-3.0-flash-fin:free',
  'inclusionai/ling-3.0-flash-sante:free',
];

function useAgents(): AgentsState {
  return useSyncExternalStore(subscribeAgents, getAgents);
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
      agents: s.agents.map((a) => (a.id === agent.id ? { ...a, ...p } : a)),
    }));

  const toggleTool = (id: string) =>
    patch({
      toolIds: agent.toolIds.includes(id)
        ? agent.toolIds.filter((t) => t !== id)
        : [...agent.toolIds, id],
    });

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

function ToolEditor({ tool }: { tool: ToolDef }) {
  const [token, setToken] = useState('');
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
          <option value="tavily">Tavily search</option>
          <option value="http">REST API</option>
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

      {tool.kind === 'tavily' ? (
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
      ) : (
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
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [live, setLive] = useState<AgentMessage[] | null>(null);
  const [error, setError] = useState('');
  const [statusInfo, setStatusInfo] = useState<AgentStatus | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null);

  useEffect(() => {
    void fetchAgentStatus().then(setStatusInfo);
  }, [state.updatedAt]);

  const agent = state.agents.find((a) => a.id === selected) ?? state.agents[0] ?? null;
  const sessions = agent ? state.sessions.filter((s) => s.agentId === agent.id) : [];
  const shown: AgentSession | null =
    sessions.find((s) => s.id === openSession) ?? sessions[0] ?? null;

  const addAgent = () => {
    const a = emptyAgent(`Agent ${state.agents.length + 1}`);
    updateAgents((s) => ({ ...s, agents: [...s.agents, a] }));
    setSelected(a.id);
  };

  const removeAgent = (id: string) => {
    updateAgents((s) => ({
      ...s,
      agents: s.agents.filter((a) => a.id !== id),
      sessions: s.sessions.filter((x) => x.agentId !== id),
    }));
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

  const run = async () => {
    if (!agent || !prompt.trim() || running) return;
    const tools = state.tools.filter((t) => agent.toolIds.includes(t.id));
    setRunning(true);
    setError('');
    setLive([{ role: 'user', content: prompt.trim(), at: Date.now() }]);
    const res = await runAgent(agent, tools, agent.model || state.llm.model, prompt.trim(), {
      onStatus: setStatus,
      onMessage: (m) => setLive((prev) => [...(prev ?? []), m]),
    });
    setRunning(false);
    setStatus('');
    setError(res.ok ? '' : (res.error ?? 'run failed'));
    const id = recordSession({
      agentId: agent.id,
      title: prompt.trim().slice(0, 48),
      messages: res.messages,
      status: res.ok ? 'done' : 'error',
    });
    setOpenSession(id);
    setPrompt('');
  };

  return (
    <div className="agents-panel">
      {!statusInfo?.llm && (
        <p className="warn-line">
          ⚠️ No OpenRouter key yet — open <strong>Settings</strong> to add one. Agents can be built
          and saved without it.
        </p>
      )}
      {statusInfo?.llm && !statusInfo.tavily && (
        <p className="warn-line">⚠️ Tavily key missing — web-search tools will fail until it is set.</p>
      )}

      <div className="agents-split">
        {/* ── master: agents + tools ─────────────────────────────────── */}
        <div className="agents-master">
          <div className="panel-label">Agents</div>
          <ul className="agent-list">
            {state.agents.length === 0 && <li className="empty">No agents yet.</li>}
            {state.agents.map((a) => (
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

          <div className="panel-label" style={{ marginTop: 18 }}>
            Tools
          </div>
          {state.tools.map((t) => (
            <ToolEditor key={t.id} tool={t} />
          ))}
          <div className="docs-actions">
            <button onClick={addTool}>+ Custom REST tool</button>
            <button
              onClick={() =>
                updateAgents((s) =>
                  s.tools.some((t) => t.id === 'tool-tavily')
                    ? s
                    : { ...s, tools: [...s.tools, tavilyTool()] },
                )
              }
            >
              + Tavily search
            </button>
          </div>

          <div className="panel-label" style={{ marginTop: 18 }}>
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

              <div className="panel-label" style={{ marginTop: 18 }}>
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
              </div>
              {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>⚠️ {error}</p>}

              {live && (
                <div className="agent-output">
                  <div className="panel-label">Live run</div>
                  <Transcript messages={live} />
                </div>
              )}

              <div className="panel-label" style={{ marginTop: 18 }}>
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
                      className="icon-btn danger"
                      onClick={() =>
                        updateAgents((s) => ({
                          ...s,
                          sessions: s.sessions.filter((x) => x.agentId !== agent.id),
                        }))
                      }
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
