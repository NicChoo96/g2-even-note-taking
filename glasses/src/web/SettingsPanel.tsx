// Settings panel (companion web UI).
//
// Stores the OpenRouter + Tavily credentials, the default model and the Tavily
// search depth. Values are POSTed to the relay and written to
// `.g2-hub-secrets.json` server-side (mode 0600) — they are NEVER put into the
// synced state or the glasses bundle. The response only reports booleans.
import { useEffect, useState } from 'react';
import { getAgents, subscribeAgents, updateAgents } from '../agents-store';
import { FREE_TOOL_MODELS } from '../models';
import { DEFAULT_MODEL } from '../types';
import { fetchAgentStatus, saveSettings, type AgentStatus } from './agents-client';

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

  const save = async () => {
    setBusy(true);
    setMsg('');
    setErr('');
    const patch: Record<string, string> = { model, depth, title };
    if (openrouterKey.trim()) patch.openrouterKey = openrouterKey.trim();
    if (tavilyKey.trim()) patch.tavilyKey = tavilyKey.trim();
    if (referer.trim()) patch.referer = referer.trim();
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
      <div className="panel-label">Provider · OpenRouter</div>
      <div className="status-grid">
        <span className={info?.llm ? 'pill ok' : 'pill bad'}>
          {info?.llm ? '✓ API key set' : '✕ no API key'}
        </span>
        <span className={info?.tavily ? 'pill ok' : 'pill bad'}>
          {info?.tavily ? '✓ Tavily key set' : '✕ no Tavily key'}
        </span>
        <span className="pill">model: {info?.model ?? model}</span>
        <span className="pill">depth: {info?.depth ?? depth}</span>
      </div>

      <label className="field-label">OpenRouter API key</label>
      <input
        type="password"
        value={openrouterKey}
        onChange={(e) => setOpenrouterKey(e.target.value)}
        placeholder={info?.llm ? '••••••• (saved — type to replace)' : 'sk-or-v1-…'}
      />

      <label className="field-label">Tavily API key</label>
      <input
        type="password"
        value={tavilyKey}
        onChange={(e) => setTavilyKey(e.target.value)}
        placeholder={info?.tavily ? '••••••• (saved — type to replace)' : 'tvly-dev-…'}
      />

      <label className="field-label">Default model</label>
      <input list="settings-models" value={model} onChange={(e) => setModel(e.target.value)} />
      <datalist id="settings-models">
        {FREE_TOOL_MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <p className="hint-line">
        Free models must advertise <code>tools</code> support or the agent loop will fail. The list
        above is the verified free + tool-capable set.
      </p>

      <label className="field-label">Tavily default search depth</label>
      <select value={depth} onChange={(e) => setDepth(e.target.value as 'basic' | 'advanced')}>
        <option value="basic">basic (fast, cheap — default)</option>
        <option value="advanced">advanced (deeper, slower)</option>
      </select>

      <label className="field-label">OpenRouter HTTP-Referer (optional)</label>
      <input value={referer} onChange={(e) => setReferer(e.target.value)} placeholder="https://your-app.example" />

      <label className="field-label">OpenRouter X-OpenRouter-Title (optional)</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />

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
        <code> web/.env.local</code> to override.
      </p>
    </div>
  );
}
