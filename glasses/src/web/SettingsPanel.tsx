// Settings panel (companion web UI).
//
// Stores the LLM credentials, the web-search credentials (Tavily AND Brave —
// the active one is a setting), the default model and the default search depth.
// Values are POSTed to the relay and written to `.g2-hub-secrets.json`
// server-side (mode 0600) — they are NEVER put into the synced state or the
// glasses bundle. The response only reports booleans.
//
// Precedence: the relay's process environment ALWAYS wins over this page, so a
// host (Railway, Docker…) that already injects OPENROUTER_API_KEY /
// TAVILY_API_KEY / BRAVE_SEARCH_API_KEY takes over automatically. The status
// response reports the `source` of each field and we render those inputs as
// locked with an "env" badge, so a hosted deployment never looks like "no key
// set" and can never be shadowed from here.
import { useEffect, useState } from 'react';
import { getAgents, subscribeAgents, updateAgents } from '../agents-store';
import { compactMemory, getMemoryView, resetMemory, subscribeMemory, type MemoryView } from '../ai';
import { FREE_TOOL_MODELS, DEEPSEEK_MODELS } from '../models';
import { DEFAULT_MODEL } from '../types';
import { fetchAgentStatus, saveSettings, type AgentStatus, type SettingsPatch, type ValueSource } from './agents-client';
import { DevicesPanel } from './DevicesPanel';
import { buildSettingsSave, settingsBody } from './settings-patch';

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

/**
 * Jarvis conversation memory (see ../ai/memory). This readout exists because the
 * log is otherwise invisible: on the glasses it is only ever a prompt block, so
 * without it the wearer cannot tell "Jarvis forgot" from "Jarvis kept quiet" —
 * which is exactly the confusion that produced the feature request.
 */
function MemoryPanel() {
  const [view, setView] = useState<MemoryView>(getMemoryView);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsub = subscribeMemory(() => setView(getMemoryView()));
    return () => {
      unsub();
    };
  }, []);

  const empty = !view.turns && !view.folded;
  const sync = () => setView(getMemoryView());
  const compact = async () => {
    setBusy(true);
    // Runs a REAL summarisation through the relay — the same path an automatic
    // compaction takes, which is the only way to find out it is broken before
    // the log is long enough for it to matter.
    await compactMemory();
    setBusy(false);
    sync();
  };

  return (
    <>
      <div className="panel-label">Jarvis memory</div>
      <div className="status-grid">
        <span className="pill">{view.turns} turn(s) kept verbatim</span>
        <span className="pill">
          {view.words.toLocaleString()} / {view.capWords.toLocaleString()} words
        </span>
        <span className="pill">
          {view.folded ? `${view.folded} turn(s) in the summary` : 'nothing summarised yet'}
        </span>
        {view.updatedAt > 0 && (
          <span className="pill">updated {new Date(view.updatedAt).toLocaleString()}</span>
        )}
      </div>
      <p className="hint-line">
        Every Jarvis turn is replayed with the tail of this log, and the transcript also carries a
        summary of what was compacted. Past {view.capWords.toLocaleString()} words the oldest turns
        are folded into one ~{view.digestWords}-word summary instead of being dropped. It lives on
        this device, so the next Jarvis session reads it back.
      </p>
      {view.digest && <p className="memory-digest">{view.digest}</p>}
      <div className="docs-actions">
        <button onClick={() => void compact()} disabled={busy || empty}>
          {busy ? 'Compacting…' : 'Compact now'}
        </button>
        {confirming ? (
          <>
            <button
              onClick={() => {
                resetMemory();
                setConfirming(false);
                sync();
              }}
            >
              Really forget everything
            </button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirming(true)} disabled={empty}>
            Forget everything
          </button>
        )}
      </div>
    </>
  );
}

/**
 * One line under a field saying where its CURRENT value comes from and what is
 * used if the box is emptied.
 *
 * Every field is EDITABLE. The environment is a fallback, not a lock, so this
 * explains the fallback instead of disabling the control — a locked box with a
 * value you cannot change is precisely how the model read as "switched by the
 * web-search provider".
 */
function FieldNote({ source, envVar }: { source?: ValueSource; envVar: string }) {
  if (source === 'settings') {
    return (
      <p className="hint-line">
        Saved on this page. Clear it to fall back to <code>{envVar}</code>.
      </p>
    );
  }
  if (source === 'env') {
    return (
      <p className="hint-line">
        From the server environment (<code>{envVar}</code>). A value saved here overrides it.
      </p>
    );
  }
  if (source === 'default') {
    return (
      <p className="hint-line">
        Built-in default. Set <code>{envVar}</code> in the environment, or type a value here.
      </p>
    );
  }
  return (
    <p className="hint-line">
      Not set anywhere. <code>{envVar}</code> in the environment, or a value here, will be used.
    </p>
  );
}

/**
 * "Remove the saved value", pending until Save.
 *
 * Needed because a key is write-only: the relay reports only whether one exists,
 * so an empty box cannot be told apart from "leave it alone" and must not be
 * sent as blank. Removing therefore has to be said explicitly.
 */
function ClearToggle({ pending, onToggle }: { pending: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={pending ? 'clear-toggle pending' : 'clear-toggle'} onClick={onToggle}>
      {pending ? '↺ will be removed on save — undo' : '↺ remove saved value'}
    </button>
  );
}

export function SettingsPanel() {
  const [info, setInfo] = useState<AgentStatus | null>(null);
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [deepseekKey, setDeepseekKey] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [braveKey, setBraveKey] = useState('');
  /** '' = auto: whichever key is present (the relay's own default). */
  const [searchProvider, setSearchProvider] = useState<'' | 'tavily' | 'brave'>('');
  /**
   * The model field is a DRAFT plus a "has the wearer actually typed here?"
   * flag, because two other values must never be mistaken for a choice:
   *
   *   • `relayModel` — the relay's `model` slot. Only a FALLBACK: every client
   *     sends its own model, and the relay resolves `body.model || cfg.model`.
   *   • `storeModel` — the synced agents store. This is what a run actually
   *     sends, so it is what really decides.
   *
   * One shared `model` state was fed by both, so the field flipped on its own,
   * and `save()` echoed whatever it happened to hold back into the shared store.
   * That is how saving the web-search provider rewrote the LLM model.
   */
  const [model, setModel] = useState('');
  const [modelTouched, setModelTouched] = useState(false);
  const [relayModel, setRelayModel] = useState('');
  const [storeModel, setStoreModel] = useState('');
  const [depth, setDepth] = useState<'basic' | 'advanced'>('basic');
  const [referer, setReferer] = useState('');
  const [title, setTitle] = useState('G2 Even Reality Hub');
  /**
   * Saved values the wearer has asked to REMOVE, applied on Save. Held as a list
   * rather than mutating immediately so a save stays one atomic action and an
   * accidental click can be undone.
   */
  const [clearFields, setClearFields] = useState<string[]>([]);
  const toggleClear = (name: string) =>
    setClearFields((f) => (f.includes(name) ? f.filter((x) => x !== name) : [...f, name]));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const refresh = async () => {
    const s = await fetchAgentStatus();
    setInfo(s);
    if (s) {
      setRelayModel(s.model || '');
      // Seed every field from the relay's own values, so what is shown IS what
      // is stored. Guessing a default and writing it back is how a field ends up
      // carrying a value nobody chose.
      setDepth((s.fields?.depth ?? s.search?.depth ?? s.depth) === 'advanced' ? 'advanced' : 'basic');
      setReferer(s.fields?.referer ?? '');
      setTitle(s.fields?.title ?? 'G2 Even Reality Hub');
      // Only echo an EXPLICIT choice. 'default' means the relay is on auto, and
      // pinning the select to the resolved provider here would silently turn
      // auto into a pin the moment anything is saved. An older relay reports no
      // `fields`, so fall back to reading the provenance.
      const saved = s.fields
        ? s.fields.searchProvider
        : s.source?.search?.provider === 'env' || s.source?.search?.provider === 'settings'
          ? s.search?.provider === 'brave'
            ? 'brave'
            : 'tavily'
          : '';
      setSearchProvider(saved === 'brave' ? 'brave' : saved === 'tavily' ? 'tavily' : '');
    }
  };

  useEffect(() => {
    void refresh();
    // Track the synced store, NOT the relay's fallback slot: the store's model
    // is what a run sends, so it is the one the field has to reflect.
    const sync = () => setStoreModel(getAgents().llm.model || '');
    const unsub = subscribeAgents(sync);
    sync();
    return unsub;
  }, []);

  const src = info?.source;
  const provider = info?.provider === 'deepseek' ? 'deepseek' : 'openrouter';
  // The new relay reports a per-provider `search` block; an older one reports
  // only the flat `tavily` mirror. Fall back so either layout renders correctly.
  const searchSrc = src?.search;
  const search = info?.search;
  const liveProvider = (search?.provider ?? 'tavily') === 'brave' ? 'brave' : 'tavily';
  const liveLabel = liveProvider === 'brave' ? 'Brave Search' : 'Tavily';
  /**
   * Does this relay understand the provider setting at all? One older than the
   * web-search release reports no `search` block; it would accept our POST and
   * silently ignore `searchProvider`, so the choice would look saved and do
   * nothing. A control that lies is worse than a disabled one that explains.
   */
  const relaySupportsProvider = search !== undefined;
  /**
   * What the field shows while the wearer is not editing it: the model a run
   * will ACTUALLY use. `storeModel` wins because a run always sends its own
   * model and the relay only ever falls back to its slot (see local-sse.mjs,
   * `body.model || cfg.model`). DEFAULT_MODEL is the last resort, for when
   * neither source has an opinion yet.
   */
  const effectiveModel = storeModel || relayModel || DEFAULT_MODEL;
  const shownModel = modelTouched ? model : effectiveModel;
  /**
   * The two backends do not share a model namespace. The DeepSeek API serves
   * only `deepseek*` names, so a model saved while the OTHER provider was active
   * is not merely odd here — it will be rejected. One saved value surviving a
   * provider switch is exactly the kind of silent mismatch worth naming.
   * (The reverse is not checkable: OpenRouter legitimately serves both sets.)
   */
  const modelWrongForProvider =
    provider === 'deepseek' && !effectiveModel.toLowerCase().startsWith('deepseek');
  /** Offer the active provider's models first; the other set stays available. */
  const modelChoices =
    provider === 'deepseek' ? [...DEEPSEEK_MODELS, ...FREE_TOOL_MODELS] : [...FREE_TOOL_MODELS, ...DEEPSEEK_MODELS];
  const openrouterHasKey = (src?.llm?.openrouterKey ?? 'none') !== 'none';
  const deepseekHasKey = (src?.llm?.deepseekKey ?? 'none') !== 'none';
  const searchKeysKnown = search?.keys !== undefined;
  const modelFromEnv = isEnv(src?.llm?.model);
  const anyEnv =
    isEnv(src?.llm?.openrouterKey) ||
    isEnv(src?.llm?.deepseekKey) ||
    isEnv(searchSrc?.tavilyKey ?? src?.tavily?.key) ||
    isEnv(searchSrc?.braveKey) ||
    isEnv(searchSrc?.provider) ||
    modelFromEnv ||
    isEnv(searchSrc?.depth ?? src?.tavily?.depth);

  /** Does the provider the relay will actually use have a key? */
  const searchConfigured = search?.configured ?? info?.tavily ?? false;
  /** An explicit choice whose key is missing — the silent-failure case to flag. */
  const searchMissingKey =
    searchProvider !== '' &&
    searchKeysKnown &&
    !(searchProvider === 'brave' ? search.keys?.brave : search.keys?.tavily);

  const save = async () => {
    setBusy(true);
    setMsg('');
    setErr('');
    // The body is built by a pure function so that the independence of these
    // settings is a TESTED property rather than a habit. The model is the one
    // field sent only when the wearer edited it: its displayed value is the
    // EFFECTIVE model whenever nothing was typed, so echoing it back on every
    // save made an unrelated change — the web-search provider — rewrite it.
    const save = buildSettingsSave({
      model: { value: model, touched: modelTouched },
      depth: { value: depth },
      title: { value: title },
      openrouterKey: { value: openrouterKey },
      deepseekKey: { value: deepseekKey },
      tavilyKey: { value: tavilyKey },
      braveKey: { value: braveKey },
      searchProvider: { value: searchProvider },
      referer: { value: referer },
    });
    // A field the wearer marked for removal is an explicit instruction, so it
    // joins the clear list whatever else this save is doing.
    for (const name of clearFields) if (!save.clear.includes(name)) save.clear.push(name);
    const r = await saveSettings(settingsBody(save) as SettingsPatch);
    setBusy(false);
    if (r.ok) {
      setInfo(r);
      setRelayModel(r.model || '');
      setOpenrouterKey('');
      setDeepseekKey('');
      setTavilyKey('');
      setBraveKey('');
      setClearFields([]);
      // Same rule for the synced store, and this is the half the glasses feel:
      // a run sends the STORE's model, so an unedited save must not touch it.
      // Writing it on every save is what let the web-search provider silently
      // retarget the LLM.
      if (modelTouched) {
        const edited = model.trim();
        updateAgents((s) => ({ ...s, llm: { ...s.llm, model: edited } }));
        setStoreModel(edited);
      }
      void refresh();
      setMsg('Saved server-side ✓');
    } else {
      setErr(r.error ?? 'save failed');
    }
  };

  return (
    <div className="settings-panel">
      {anyEnv && (
        <p className="hint-line ok-line">
          ✓ Some values also come from the server environment. Nothing here is locked — a value
          saved on this page wins over the environment, and clearing a field hands it back.
        </p>
      )}

      <div className="panel-label">
        Provider · {provider === 'deepseek' ? 'DeepSeek' : 'OpenRouter'}
      </div>
      <div className="status-grid">
        <span className={info?.llm ? 'pill ok' : 'pill bad'}>
          {info?.llm ? '✓ API key set' : '✕ no API key'}
          <SourceBadge source={src?.llm?.key} />
        </span>
        <span className={searchConfigured ? 'pill ok' : 'pill bad'}>
          {searchConfigured ? `✓ ${liveLabel} key set` : `✕ no ${liveLabel} key`}
          <SourceBadge source={searchSrc?.key ?? src?.tavily?.key} />
        </span>
        {/* Same credential as the OpenRouter chat backend, but its own check:
            the provider can be DeepSeek, so "API key set" above may be reporting
            a DeepSeek key and says nothing about jev. jev always reads the
            OpenRouter key, which is why it gets its own pill. */}
        <span className={info?.jev ? 'pill ok' : 'pill bad'}>
          {info?.jev ? '✓ Jev ready' : '✕ Jev needs OpenRouter key'}
          <SourceBadge source={src?.jev?.key} />
        </span>
        {/* The EFFECTIVE model, not the relay's fallback slot — and the badge
            describes where the value actually shown came from. */}
        <span className="pill">
          model: {effectiveModel}
          {!storeModel && <SourceBadge source={src?.llm?.model} />}
        </span>
        <span className="pill">
          search: {liveLabel}
          <SourceBadge source={searchSrc?.provider} />
        </span>
        <span className="pill">
          depth: {info?.search?.depth ?? info?.depth ?? depth}
          <SourceBadge source={searchSrc?.depth ?? src?.tavily?.depth} />
        </span>
      </div>

      <label className="field-label">
        OpenRouter API key <SourceBadge source={src?.llm?.openrouterKey} />
      </label>
      <input
        type="password"
        value={openrouterKey}
        onChange={(e) => setOpenrouterKey(e.target.value)}
        placeholder={openrouterHasKey ? '••••••• (saved — type to replace)' : 'sk-or-v1-…'}
      />
      <FieldNote source={src?.llm?.openrouterKey} envVar="OPENROUTER_API_KEY" />
      {src?.llm?.openrouterKey === 'settings' && (
        <ClearToggle
          pending={clearFields.includes('openrouterKey')}
          onToggle={() => toggleClear('openrouterKey')}
        />
      )}

      <label className="field-label">
        DeepSeek API key <SourceBadge source={src?.llm?.deepseekKey} />
      </label>
      <input
        type="password"
        value={deepseekKey}
        onChange={(e) => setDeepseekKey(e.target.value)}
        placeholder={deepseekHasKey ? '••••••• (saved — type to replace)' : 'sk-…'}
      />
      <FieldNote source={src?.llm?.deepseekKey} envVar="DEEPSEEK_API_KEY" />
      {src?.llm?.deepseekKey === 'settings' && (
        <ClearToggle
          pending={clearFields.includes('deepseekKey')}
          onToggle={() => toggleClear('deepseekKey')}
        />
      )}

      <label className="field-label">
        Tavily API key <SourceBadge source={searchSrc?.tavilyKey ?? src?.tavily?.key} />
      </label>
      <input
        type="password"
        value={tavilyKey}
        onChange={(e) => setTavilyKey(e.target.value)}
        placeholder={info?.search?.keys?.tavily ? '••••••• (saved — type to replace)' : 'tvly-dev-…'}
      />
      <FieldNote source={searchSrc?.tavilyKey ?? src?.tavily?.key} envVar="TAVILY_API_KEY" />
      {(searchSrc?.tavilyKey ?? src?.tavily?.key) === 'settings' && (
        <ClearToggle
          pending={clearFields.includes('tavilyKey')}
          onToggle={() => toggleClear('tavilyKey')}
        />
      )}

      <label className="field-label">
        Brave Search API key <SourceBadge source={searchSrc?.braveKey} />
      </label>
      <input
        type="password"
        value={braveKey}
        onChange={(e) => setBraveKey(e.target.value)}
        placeholder={info?.search?.keys?.brave ? '••••••• (saved — type to replace)' : 'BSA…'}
      />
      <FieldNote source={searchSrc?.braveKey} envVar="BRAVE_SEARCH_API_KEY" />
      {searchSrc?.braveKey === 'settings' && (
        <ClearToggle
          pending={clearFields.includes('braveKey')}
          onToggle={() => toggleClear('braveKey')}
        />
      )}

      <label className="field-label">
        Web-search provider <SourceBadge source={searchSrc?.provider} />
      </label>
      <select
        value={searchProvider}
        onChange={(e) => setSearchProvider(e.target.value as '' | 'tavily' | 'brave')}
        disabled={!relaySupportsProvider}
      >
        <option value="">Auto — whichever key is set (Tavily first)</option>
        <option value="tavily">Tavily</option>
        <option value="brave">Brave Search</option>
      </select>
      {!relaySupportsProvider && (
        <p className="warn-line">
          ⚠️ The running relay is older than swappable web search, so it ignores the setting above.
          Restart the relay — it loads its own code at boot — then reload this page.
        </p>
      )}
      <FieldNote source={searchSrc?.provider} envVar="SEARCH_PROVIDER" />
      {searchMissingKey && (
        <p className="warn-line">
          ⚠️{' '}
          <code>{searchProvider === 'brave' ? 'BRAVE_SEARCH_API_KEY' : 'TAVILY_API_KEY'}</code> is
          not set, so web-search tools will report an error. Nothing is substituted — a
          different provider's result would be a silently wrong source.
        </p>
      )}

      {/* Always editable — there is no lock to inherit. This field edits the
          SYNCED STORE's model, which is what a run sends and therefore what
          takes effect; the relay's own model is the fallback behind it, and the
          web-search provider is not consulted for it at all. */}
      <label className="field-label">
        Default model {!storeModel && <SourceBadge source={src?.llm?.model} />}
      </label>
      <input
        list="settings-models"
        value={shownModel}
        onChange={(e) => {
          setModel(e.target.value);
          setModelTouched(true);
        }}
      />
      <datalist id="settings-models">
        {modelChoices.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {storeModel ? (
        <p className="hint-line">
          <code>{storeModel}</code>, from the synced agents store — this is what a run sends, so
          it is what takes effect. Saving a change here updates both sides.
        </p>
      ) : (
        <FieldNote
          source={src?.llm?.model}
          envVar={provider === 'deepseek' ? 'DEEPSEEK_MODEL' : 'OPENROUTER_MODEL'}
        />
      )}
      {src?.llm?.model === 'settings' && (
        <ClearToggle
          pending={clearFields.includes('model')}
          onToggle={() => toggleClear('model')}
        />
      )}
      {modelWrongForProvider && (
        <p className="warn-line">
          ⚠️ <code>{effectiveModel}</code> is not a DeepSeek model name, but the active provider
          is DeepSeek — the value was saved while the other provider was selected, and DeepSeek
          will reject it. Pick one of the <code>deepseek*</code> models above, or set{' '}
          <code>LLM_PROVIDER</code> back.
        </p>
      )}
      <p className="hint-line">
        Free models must advertise <code>tools</code> support or the agent loop will fail. The list
        above is the verified free + tool-capable set, plus DeepSeek models for when the provider
        is switched to DeepSeek. Your own API keys do not belong in this box — they go in the fields
        above.
      </p>

      <label className="field-label">
        Default search depth <SourceBadge source={searchSrc?.depth ?? src?.tavily?.depth} />
      </label>
      <select value={depth} onChange={(e) => setDepth(e.target.value as 'basic' | 'advanced')}>
        <option value="basic">basic (fast, cheap — default)</option>
        <option value="advanced">advanced (deeper, slower)</option>
      </select>
      <FieldNote source={searchSrc?.depth ?? src?.tavily?.depth} envVar="WEB_SEARCH_DEPTH" />
      <p className="hint-line">
        Applies to whichever provider is active; each tool can still override it. On Brave this
        maps onto its context budget (sources + tokens), on Tavily onto{' '}
        <code>search_depth</code>.
      </p>

      <label className="field-label">
        OpenRouter HTTP-Referer (optional) <SourceBadge source={src?.llm?.referer} />
      </label>
      <input
        value={referer}
        onChange={(e) => setReferer(e.target.value)}
        placeholder="https://your-app.example"
      />
      <FieldNote source={src?.llm?.referer} envVar="OPENROUTER_REFERER" />
      {src?.llm?.referer === 'settings' && (
        <ClearToggle pending={clearFields.includes('referer')} onToggle={() => toggleClear('referer')} />
      )}

      <label className="field-label">
        OpenRouter X-OpenRouter-Title (optional) <SourceBadge source={src?.llm?.title} />
      </label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      <FieldNote source={src?.llm?.title} envVar="OPENROUTER_TITLE" />
      {src?.llm?.title === 'settings' && (
        <ClearToggle pending={clearFields.includes('title')} onToggle={() => toggleClear('title')} />
      )}

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
        the glasses bundle). Everything on this page is stored the same way and each field is
        independent: saving one never rewrites another. Values from the server environment —{' '}
        <code>OPENROUTER_API_KEY</code>, <code>TAVILY_API_KEY</code>, <code>BRAVE_SEARCH_API_KEY</code>,{' '}
        <code>OPENROUTER_MODEL</code>, <code>SEARCH_PROVIDER</code>, … — are used only where nothing
        is saved here; use "remove saved value" to hand a field back to them.
      </p>

      <MemoryPanel />

      <DevicesPanel />
    </div>
  );
}

