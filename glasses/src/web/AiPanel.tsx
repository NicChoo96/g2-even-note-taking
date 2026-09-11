// Jarvis — the companion surface for the AI dictation-agent.
//
// This panel is a WINDOW onto the same run the glasses are showing, never a
// second agent: it reads `ai/store`, and every action it can take (talk, answer
// a confirmation, undo) is a call into the shared store. That is what keeps the
// glasses HUD and this panel from ever disagreeing about what is happening.
//
// Two things it adds that the glasses physically cannot show:
//   • the full step timeline (the HUD only fits the last three actions), and
//   • the ACTION CATALOG, read live from the capability registry — so when a new
//     page or feature is registered the browser immediately documents what the
//     agent can do, with no UI change required.
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import {
  aiAnswerConfirm,
  aiBegin,
  aiCancel,
  aiFail,
  aiMaxSteps,
  aiModel,
  capabilitiesForPage,
  getAi,
  GLOBAL_PAGE,
  hasUndo,
  listPages,
  requestRemoteConfirm,
  requestRemoteStop,
  runAiAgent,
  subscribeAi,
  subscribeUndo,
  undoLabel,
  undoLastAiBatch,
  updateAiSettings,
  type AiState,
  type AiStep,
} from '../ai';
import { DEEPSEEK_MODELS, FREE_TOOL_MODELS } from '../models';
import { getState } from '../store';
import { MicButton } from './Dictate';

function useAi(): AiState {
  // getAi() returns the same object until a mutation replaces it, which is
  // exactly what useSyncExternalStore needs.
  return useSyncExternalStore(subscribeAi, getAi);
}

// Undo availability is two derived values, so cache the pair and hand back the
// SAME object until something changes — otherwise React re-renders forever.
let undoCache: { available: boolean; label: string } | null = null;
function undoSnapshot(): { available: boolean; label: string } {
  const available = hasUndo();
  const label = undoLabel();
  if (!undoCache || undoCache.available !== available || undoCache.label !== label) {
    undoCache = { available, label };
  }
  return undoCache;
}

function useUndo(): { available: boolean; label: string } {
  return useSyncExternalStore(subscribeUndo, undoSnapshot);
}

/**
 * A focus step records the page id as it was at that moment. Resolve it to the
 * same label the glasses HUD uses, so the two surfaces read identically —
 * unknown text falls through unchanged rather than rendering "undefined".
 */
function focusLabel(text: string): string {
  if (text === GLOBAL_PAGE) return 'App';
  return listPages().find((p) => p.id === text)?.title ?? text;
}

/**
 * Glyph per step kind. These are the panel's own marks — the glasses HUD cannot
 * draw them (they are not in the firmware font), so it uses ASCII instead. The
 * two surfaces therefore read the same SEQUENCE in different ink.
 */
const STEP_MARK: Record<AiStep['kind'], string> = {
  focus: '▸',
  think: '✻',
  call: '…',
  ok: '✓',
  fail: '✕',
  reply: '»',
  note: '·',
};

function Timeline({ ai }: { ai: AiState }) {
  if (!ai.steps.length) return null;
  return (
    <ol className="ap-timeline">
      {ai.steps.map((s, i) => (
        <li key={`${s.at}-${i}`} className={`ap-step ap-step-${s.kind}`}>
          <span className="ap-step-mark" aria-hidden>
            {STEP_MARK[s.kind] || '·'}
          </span>
          <span className="ap-step-text">
            {s.kind === 'focus' ? `Focused ${focusLabel(s.text)}` : s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Live view of the registry — the adaptive layer, documented by itself. */
function ActionCatalog({ focused }: { focused: string }) {
  const [open, setOpen] = useState<string | null>(null);
  // The registry is static once the modules load, so this is a cheap read — no
  // memo needed, and no stale copy to invalidate when new pages get registered.
  const groups = listPages().map((page) => ({ page, caps: capabilitiesForPage(page.id) }));
  const total = groups.reduce((n, g) => n + g.caps.length, 0);

  return (
    <div className="ap-catalog">
      <div className="panel-label">
        Action catalog · {total} actions across {groups.length} pages, generated from the registry
      </div>
      <div className="ap-page-chips">
        {groups.map(({ page, caps }) => (
          <button
            key={page.id}
            type="button"
            className={`ap-chip ${open === page.id ? 'active' : ''} ${
              focused === page.id ? 'here' : ''
            }`}
            onClick={() => setOpen(open === page.id ? null : page.id)}
            title={page.summary}
          >
            {page.title} <span className="count">{caps.length}</span>
          </button>
        ))}
      </div>
      {open && (
        <ul className="ap-actions">
          {(groups.find((g) => g.page.id === open)?.caps ?? []).map((c) => (
            <li key={c.name}>
              <code>{c.name}</code>
              <span className="ap-action-title">
                {c.title}
                {c.confirm ? <em className="ap-needs-confirm"> · asks first</em> : null}
              </span>
              <span className="ap-action-desc">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AiPanel() {
  const ai = useAi();
  const undo = useUndo();
  const [typed, setTyped] = useState('');
  const live = ai.status === 'running' || ai.status === 'confirm';
  const settings = ai.settings;
  // `enabled` gates THIS panel's controls only — the glasses "Jarvis" menu item
  // is always available, so turning the panel off can never strand a user who
  // is wearing the glasses and not looking at a screen.
  const on = settings.enabled;
  const blocked = live || !on;

  /** One command, spoken or typed — identical path in both cases. */
  const ask = useCallback(async (text: string) => {
    const utterance = text.trim();
    if (!utterance) return;
    // Focus always follows what the user is actually looking at, so "add milk"
    // means the To-Do list without them having to name the page.
    const focus = getState().activeSection;
    aiBegin(utterance, focus);
    const res = await runAiAgent({ utterance, focus });
    if (getAi().status === 'idle') return; // dismissed mid-run
    // `unreachable` = the very first model call failed and nothing was touched.
    // There is no renderer-local section to fall back into from the browser, so
    // say so plainly instead of leaving a spinner.
    if (!res.ok && res.unreachable) {
      aiFail(
        res.error
          ? `AI unavailable — ${res.error}`
          : 'AI unavailable — check the model + key in Settings',
        res.reply || '',
      );
    }
  }, []);

  // The panel is a client of the registry, so the model picker must offer the
  // list that matches whatever the relay is actually running.
  const modelOptions = useMemo(
    () => (DEEPSEEK_MODELS.includes(aiModel()) ? DEEPSEEK_MODELS : FREE_TOOL_MODELS),
    [],
  );

  return (
    <div className="ap-panel">
      <div className="ap-head">
        <div>
          <div className="panel-label">Jarvis · AI agent for the glasses</div>
          <p className="ap-lede">
            Speak one instruction. The agent works out which page you mean, calls the right
            actions, and mirrors every step onto the glasses HUD.
          </p>
        </div>
        <span className={`ap-status ap-status-${ai.status}`}>
          {ai.status === 'idle'
            ? 'Ready'
            : ai.mirrored
              ? ai.status === 'confirm'
                ? 'On the glasses · tap to answer'
                : `On the glasses · ${ai.turn}/${ai.maxSteps}`
              : ai.status === 'running'
                ? `Working ${ai.turn}/${ai.maxSteps}`
                : ai.status === 'confirm'
                  ? 'Needs a tap'
                  : ai.status === 'done'
                    ? 'Done'
                    : 'Failed'}
        </span>
      </div>

      {!on && (
        <div className="ap-off">
          Jarvis is switched off here. Turn it back on below — the glasses{' '}
          <strong>Jarvis</strong> menu item keeps working either way.
        </div>
      )}

      <div className="ap-ask">
        <MicButton
          mode="ai"
          onText={(t) => void ask(t)}
          hint={on ? 'Ask Jarvis to do something' : 'Jarvis is off'}
          title={on ? 'Speak one instruction for the agent' : 'Enable Jarvis to use the mic'}
        />
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !blocked) {
              const t = typed;
              setTyped('');
              void ask(t);
            }
          }}
          placeholder={
            on
              ? '…or type a command, e.g. “add milk to my list and open docs”'
              : 'Jarvis is switched off'
          }
          disabled={blocked}
        />
        <button
          className="primary"
          onClick={() => {
            const t = typed;
            setTyped('');
            void ask(t);
          }}
          disabled={blocked || !typed.trim()}
        >
          {live ? 'Running…' : 'Run'}
        </button>
        {live && (
          <button
            className="icon-btn danger"
            onClick={() => (ai.mirrored ? requestRemoteStop() : aiCancel())}
            title={ai.mirrored ? 'Stop the run on the glasses' : 'Stop Jarvis'}
          >
            ◼
          </button>
        )}
      </div>

      {ai.utterance && (
        <p className="ap-heard">
          <span className="ap-heard-label">{live ? 'Heard' : 'Asked'}</span> “{ai.utterance}”
        </p>
      )}

      <Timeline ai={ai} />

      {ai.mirrored && live && (
        <div className="ap-mirror">
          This run started on the <strong>glasses</strong>. Stop and confirm work from here, and
          the glasses HUD is showing the same steps.
        </div>
      )}

      {ai.status === 'confirm' && ai.pending && (
        <div className="ap-confirm" role="alertdialog" aria-live="assertive">
          <div className="ap-confirm-body">
            <strong>{ai.pending.title}</strong>
            {ai.pending.lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
            <em>This is destructive — approve on purpose.</em>
          </div>
          <div className="ap-confirm-actions">
            <button
              className="primary"
              onClick={() => (ai.mirrored ? requestRemoteConfirm(true) : aiAnswerConfirm(true))}
            >
              Approve
            </button>
            <button
              onClick={() => (ai.mirrored ? requestRemoteConfirm(false) : aiAnswerConfirm(false))}
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {ai.status === 'done' && ai.result && <div className="ap-result ok">{ai.result}</div>}
      {ai.status === 'error' && (
        <div className="ap-result bad">{ai.error || 'Something went wrong'}</div>
      )}

      {(undo.available || ai.status === 'done') && (
        <div className="ap-undo">
          <button
            className="primary"
            disabled={!undo.available}
            onClick={() => undoLastAiBatch()}
            title={undo.label ? `Revert: ${undo.label}` : 'Nothing to revert'}
          >
            ↩ Undo last AI change
          </button>
          <span className="ap-undo-label">
            {undo.available ? undo.label : 'Nothing to undo — the next AI change will appear here.'}
          </span>
        </div>
      )}

      <ActionCatalog focused={ai.focus} />

      <div className="ap-settings">
        <label className="ap-toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => updateAiSettings({ enabled: e.target.checked })}
          />
          <span>Show Jarvis controls in this panel (the glasses menu item is always on)</span>
        </label>
        <div className="ap-field">
          <span>Model</span>
          <select
            value={settings.model || ''}
            onChange={(e) => updateAiSettings({ model: e.target.value })}
          >
            <option value="">Relay default ({aiModel() || 'unset'})</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="ap-field">
          <span>Max agent steps</span>
          <input
            type="number"
            min={1}
            max={12}
            value={settings.maxSteps}
            onChange={(e) =>
              updateAiSettings({ maxSteps: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })
            }
          />
          <em>currently {aiMaxSteps()}</em>
        </div>
      </div>
    </div>
  );
}
