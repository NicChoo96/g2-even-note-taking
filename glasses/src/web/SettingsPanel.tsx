// Settings panel (companion web UI).
//
// Stores the OpenRouter + Tavily credentials, the default model and the Tavily
// search depth. Values are POSTed to the relay and written to
// `.g2-hub-secrets.json` server-side (mode 0600) — they are NEVER put into the
// synced state or the glasses bundle. The response only reports booleans.
//
// Precedence: the relay's process environment ALWAYS wins over this page, so a
// host (Railway, Docker…) that already injects OPENROUTER_API_KEY / TAVILY_API_KEY
// takes over automatically. The status response reports the `source` of each
// field and we render those inputs as locked with an "env" badge, so a hosted
// deployment never looks like "no key set" and can never be shadowed from here.
import { useEffect, useState } from 'react';
import { getAgents, subscribeAgents, updateAgents } from '../agents-store';
import { FREE_TOOL_MODELS } from '../models';
import { DEFAULT_MODEL } from '../types';
import { fetchAgentStatus, saveSettings, type AgentStatus, type ValueSource } from './agents-client';

/** A small pill that says where a value comes from. */
function SourceBadge({ source }: { source?: ValueSource }) {
  if (!source || source === 'none') return null;
  const label =
    source === 'env' ? 'server env' : source === 'settings' ? 'settings page' : 'default';
  return <span className={`source-badge ${source}`}>{label}</span>;
}

function isEnv(source?: ValueSource): boolean {
  return source === 'env';
}

export function SettingsPanel() {
  const [info, setInfo] = useState<AgentStatus | null>(null);
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [depth, setDepth] = useState<'basic' | 'advanced'>('basic');
  const [referer, setReferer] = useState('');
  const [title, setTitle] = useState('G2 Even Reality Hub');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const refresh = async () => {
    const s = await fetchAgentStatus();
    setInfo(s);
    if (s) {
      setModel(s.model || DEFAULT_MODEL);
      setDepth(s.depth === 'advanced' ? 'advanced' : 'basic');
    }
  };

  useEffect(() => {
    void refresh();
    // Keep the local model field in sync with the synced store.
    const unsub = subscribeAgents(() => setModel(getAgents().llm.model || DEFAULT_MODEL));
    return unsub;
  }, []);

  const src = info?.source;
  const keyFromEnv = isEnv(src?.llm?.key);
  const tavilyFromEnv = isEnv(src?.tavily?.key);
  const modelFromEnv = isEnv(src?.llm?.model);
  const depthFromEnv = isEnv(src?.tavily?.depth);
  const refererFromEnv = isEnv(src?.llm?.referer);
  const titleFromEnv = isEnv(src?.llm?.title);
  const anyEnv = keyFromEnv || tavilyFromEnv || modelFromEnv || depthFromEnv;

  const save = async () => {
    setBusy(true);
    setMsg('');
    setErr('');
    // Never send a field the server environment owns — it would be stored but
    // silently ignored, which is exactly the confusion this panel is fixing.
    const patch: Record<string, string> = {};
    if (!modelFromEnv) patch.model = model;
    if (!depthFromEnv) patch.depth = depth;
    if (!titleFromEnv) patch.title = title;
    if (!keyFromEnv && openrouterKey.trim()) patch.openrouterKey = openrouterKey.trim();
    if (!tavilyFromEnv && tavilyKey.trim()) patch.tavilyKey = tavilyKey.trim();
    if (!refererFromEnv && referer.trim()) patch.referer = referer.trim();
    const r = await saveSettings(patch);
    setBusy(false);
    if (r.ok) {
      setInfo(r);
      setOpenrouterKey('');
      setTavilyKey('');
      setMsg('Saved server-side ✓');
      updateAgents((s) => ({ ...s, llm: { ...s.llm, model } }));
    } else {
      setErr(r.error ?? 'save failed');
    }
  };

  return (
    <div className="settings-panel">
      {anyEnv && (
        <p className="hint-line ok-line">
          ✓ Some values are injected by the server environment. Those fields are locked here —
          the environment always wins.
        </p>
      )}

      <div className="panel-label">Provider · OpenRouter</div>
      <div className="status-grid">
        <span className={info?.llm ? 'pill ok' : 'pill bad'}>
          {info?.llm ? '✓ API key set' : '✕ no API key'}
          <SourceBadge source={src?.llm?.key} />
        </span>
        <span className={info?.tavily ? 'pill ok' : 'pill bad'}>
          {info?.tavily ? '✓ Tavily key set' : '✕ no Tavily key'}
          <SourceBadge source={src?.tavily?.key} />
        </span>
        <span className="pill">
          model: {info?.model ?? model}
          <SourceBadge source={src?.llm?.model} />
        </span>
        <span className="pill">
          depth: {info?.depth ?? depth}
          <SourceBadge source={src?.tavily?.depth} />
        </span>
      </div>

      <label className="field-label">
        OpenRouter API key <SourceBadge source={src?.llm?.key} />
      </label>
      {keyFromEnv ? (
        <p className="locked-field">
          🔒 Managed by <code>OPENROUTER_API_KEY</code> in the server environment.
        </p>
      ) : (
        <input
          type="password"
          value={openrouterKey}
          onChange={(e) => setOpenrouterKey(e.target.value)}
          placeholder={info?.llm ? '••••••• (saved — type to replace)' : 'sk-or-v1-…'}
        />
      )}

      <label className="field-label">
        Tavily API key <SourceBadge source={src?.tavily?.key} />
      </label>
      {tavilyFromEnv ? (
        <p className="locked-field">
          🔒 Managed by <code>TAVILY_API_KEY</code> in the server environment.
        </p>
      ) : (
        <input
          type="password"
          value={tavilyKey}
          onChange={(e) => setTavilyKey(e.target.value)}
          placeholder={info?.tavily ? '••••••• (saved — type to replace)' : 'tvly-dev-…'}
        />
      )}

      <label className="field-label">
        Default model <SourceBadge source={src?.llm?.model} />
      </label>
      <input
        list="settings-models"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        disabled={modelFromEnv}
      />
      <datalist id="settings-models">
        {FREE_TOOL_MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <p className="hint-line">
        Free models must advertise <code>tools</code> support or the agent loop will fail. The list
        above is the verified free + tool-capable set.
      </p>

      <label className="field-label">
        Tavily default search depth <SourceBadge source={src?.tavily?.depth} />
      </label>
      <select
        value={depth}
        onChange={(e) => setDepth(e.target.value as 'basic' | 'advanced')}
        disabled={depthFromEnv}
      >
        <option value="basic">basic (fast, cheap — default)</option>
        <option value="advanced">advanced (deeper, slower)</option>
      </select>

      <label className="field-label">
        OpenRouter HTTP-Referer (optional) <SourceBadge source={src?.llm?.referer} />
      </label>
      {refererFromEnv ? (
        <p className="locked-field">
          🔒 Managed by <code>OPENROUTER_REFERER</code> in the server environment.
        </p>
      ) : (
        <input
          value={referer}
          onChange={(e) => setReferer(e.target.value)}
          placeholder="https://your-app.example"
        />
      )}

      <label className="field-label">
        OpenRouter X-OpenRouter-Title (optional) <SourceBadge source={src?.llm?.title} />
      </label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={titleFromEnv} />

      <div className="docs-actions">
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        <button onClick={() => void refresh()}>Refresh status</button>
      </div>
      {msg && <p className="hint-line ok-line">{msg}</p>}
      {err && <p className="warn-line">⚠️ {err}</p>}
      <p className="hint-line">
        Keys are written to <code>.g2-hub-secrets.json</code> on the relay (never synced, never in
        the glasses bundle). Set <code>OPENROUTER_API_KEY</code> / <code>TAVILY_API_KEY</code> in
        <code> web/.env.local</code> (or your host's env vars) to override — environment values win.
      </p>
    </div>
  );
}

