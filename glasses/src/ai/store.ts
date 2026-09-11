// AI run store — observable state for the "Jarvis" agent, shared by the glasses
// renderer and the companion panel.
//
// The agent LOOP lives in ai/agent.ts and is deliberately store-free; this module
// only holds what the UI needs to draw (status, steps, the pending confirmation)
// plus the durable settings. Keeping them apart means the loop can be unit
// tested in node without a renderer.
import type { PageId } from './types';

export type AiStatus = 'idle' | 'running' | 'confirm' | 'done' | 'error';

// ── Cross-surface mirroring ─────────────────────────────────────────────────
//
// A run belongs to exactly ONE instance — the one that ran `aiBegin`, because
// that instance is the one holding the agent loop and the platform bridge that
// paints the HUD. The other surface (phone panel ↔ glasses) shows a read-only
// mirror of it, and answers it through the directed control channel.
//
// `mirrored` is therefore not decoration: the sync layer refuses to re-broadcast
// a mirrored run (two surfaces would pillory the same run back and forth), and
// the controls route to the owner instead of mutating local state.

// `think` is the model's OWN reasoning (or the plan sentence it writes next to
// a tool call). It is what the user means by "the chain of thought": the other
// kinds are written by our loop, this one comes from the model itself. It is
// shown on the glasses HUD and in full in the companion panel.
export type AiStepKind = 'focus' | 'think' | 'call' | 'ok' | 'fail' | 'reply' | 'note';

/**
 * How many steps to keep. A long run with reasoning can emit hundreds of
 * fragments, and every one is mirrored to the other surface on each change —
 * the HUD only ever draws the last few, so drop the far end instead of growing
 * the payload (and the mirrored frame) without bound.
 */
const MAX_STEPS_KEPT = 60;

export interface AiStep {
  kind: AiStepKind;
  text: string;
  at: number;
}

export interface AiSettings {
  /** Master switch for the Jarvis menu item / panel. */
  enabled: boolean;
  /** Model override. '' → whatever the relay is configured with. */
  model: string;
  /** Hard cap on model turns before the loop forces a final answer. */
  maxSteps: number;
}

export interface AiState {
  status: AiStatus;
  /** The page layer-2 actions are currently allowed to run on. */
  focus: PageId;
  utterance: string;
  steps: AiStep[];
  /** Model turn currently in flight, and the cap — drives the HUD's counter. */
  turn: number;
  maxSteps: number;
  /** Set while the run waits for a tap-to-confirm on a destructive action. */
  pending: { title: string; lines: string[] } | null;
  result: string;
  error: string;
  /** A companion-UI tab the AI asked to open ('settings'), consumed by App.tsx. */
  webTab: string | null;
  settings: AiSettings;
  /**
   * True while this HUD is showing a run owned by ANOTHER surface (phone ↔
   * glasses). Part of the rendered state on purpose: the controls have to tell
   * the user to act on the owning surface instead of silently doing nothing.
   */
  mirrored: boolean;
}

/**
 * A Jarvis run as it travels between surfaces. Trimmed to what a renderer draws:
 * settings and the companion-tab request stay local to the owner.
 */
export interface AiSnapshot {
  /** Per-boot instance id of the surface that owns the run. */
  owner: string;
  at: number;
  status: AiStatus;
  focus: PageId;
  utterance: string;
  steps: AiStep[];
  turn: number;
  maxSteps: number;
  pending: { title: string; lines: string[] } | null;
  result: string;
  error: string;
}

/** A directed instruction to the surface that owns the run. */
export interface AiControl {
  /** Instance id the frame is addressed to. Everyone else drops it. */
  target: string;
  at: number;
  action: 'stop' | 'confirm';
  approve?: boolean;
}

const LS_KEY = 'hub:ai';

const DEFAULT_SETTINGS: AiSettings = { enabled: true, model: '', maxSteps: 6 };

let state: AiState = {
  status: 'idle',
  focus: 'todo',
  utterance: '',
  steps: [],
  turn: 0,
  maxSteps: DEFAULT_SETTINGS.maxSteps,
  pending: null,
  result: '',
  error: '',
  webTab: null,
  settings: loadSettings(),
  mirrored: false,
};

const listeners = new Set<() => void>();
/** Resolver for the in-flight confirmation. Never part of rendered state. */
let confirmResolver: ((ok: boolean) => void) | null = null;
/**
 * Set when the user abandons a run. The in-flight /api/llm request cannot be
 * aborted, so instead every later write from that loop is dropped — otherwise a
 * cancelled run would repaint its HUD over whatever the user moved on to.
 */
let cancelled = false;

function loadSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      enabled: parsed.enabled !== false,
      model: typeof parsed.model === 'string' ? parsed.model : '',
      maxSteps:
        typeof parsed.maxSteps === 'number' && parsed.maxSteps >= 1 && parsed.maxSteps <= 12
          ? Math.floor(parsed.maxSteps)
          : DEFAULT_SETTINGS.maxSteps,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.settings));
  } catch {
    /* ignore */
  }
}

function emit(): void {
  for (const l of [...listeners]) l();
}

function set(patch: Partial<AiState>): void {
  state = { ...state, ...patch };
  emit();
}

export function getAi(): AiState {
  return state;
}

export function subscribeAi(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ── Settings ────────────────────────────────────────────────────────────────

export function updateAiSettings(patch: Partial<AiSettings>): void {
  const next: AiSettings = { ...state.settings, ...patch };
  // Guard the values that drive the loop itself. A stray localStorage edit or a
  // number input can otherwise hand `maxSteps` a NaN/huge value, and one spoken
  // sentence would spend dozens of model turns before answering.
  if (!Number.isFinite(next.maxSteps)) next.maxSteps = DEFAULT_SETTINGS.maxSteps;
  next.maxSteps = Math.max(1, Math.min(12, Math.floor(next.maxSteps)));
  if (typeof next.model !== 'string') next.model = '';
  state = { ...state, settings: next };
  persistSettings();
  emit();
}

/** Effective model for a run (empty → let the relay's configured model win). */
export function aiModel(): string {
  return state.settings.model.trim();
}

export function aiMaxSteps(): number {
  return state.settings.maxSteps;
}

// ── Focus (layer 2 gate) ────────────────────────────────────────────────────

export function getAiFocus(): PageId {
  return state.focus;
}

export function setAiFocus(page: PageId): void {
  if (state.focus === page) return;
  set({ focus: page });
}

// ── Run lifecycle ───────────────────────────────────────────────────────────

export function aiBegin(utterance: string, focus: PageId): void {
  confirmResolver = null;
  cancelled = false;
  set({
    status: 'running',
    focus,
    utterance,
    steps: [{ kind: 'focus', text: focus, at: Date.now() }],
    turn: 1,
    maxSteps: aiMaxSteps(),
    pending: null,
    result: '',
    error: '',
    // Starting our own run takes ownership back from any mirror we were showing.
    mirrored: false,
  });
}

/** 1-based model turn, so the HUD can show "2/6" instead of a spinner. */
export function aiSetTurn(turn: number): void {
  if (cancelled || state.turn === turn) return;
  set({ turn });
}

export function aiStep(kind: AiStepKind, text: string): void {
  if (cancelled) return;
  const next = [...state.steps, { kind, text, at: Date.now() }];
  set({ steps: next.length > MAX_STEPS_KEPT ? next.slice(-MAX_STEPS_KEPT) : next });
}

/** Replace the whole step list (used when the loop re-renders from messages). */
export function aiSetSteps(steps: AiStep[]): void {
  if (cancelled) return;
  set({ steps });
}

/**
 * Park the run until the user answers. Resolves true = approved.
 * A no-resolver call (headless harness) resolves false immediately.
 */
export function aiAskConfirm(title: string, lines: string[]): Promise<boolean> {
  if (cancelled) return Promise.resolve(false);
  // Never leave an earlier prompt dangling.
  if (confirmResolver) {
    const prev = confirmResolver;
    confirmResolver = null;
    prev(false);
  }
  return new Promise<boolean>((resolve) => {
    confirmResolver = resolve;
    set({ status: 'confirm', pending: { title, lines } });
  });
}

/** Answer a pending confirmation. Returns true when one was waiting. */
export function aiAnswerConfirm(ok: boolean): boolean {
  // A mirrored prompt has no local resolver. Without this guard the call would
  // fall through to the "plain dismiss" branch below and visually clear a
  // confirmation that is still waiting on the OWNER — the user taps Approve,
  // the prompt vanishes, and nothing runs.
  if (state.mirrored) return false;
  const resolve = confirmResolver;
  confirmResolver = null;
  if (resolve) {
    set({ pending: null, status: 'running' });
    resolve(ok);
    return true;
  }
  // No prompt was waiting — treat it as a plain dismiss of the HUD.
  if (state.status === 'confirm') set({ pending: null, status: 'running' });
  return false;
}

export function aiFinish(result: string): void {
  if (cancelled) return;
  confirmResolver = null;
  set({ status: 'done', result, pending: null, mirrored: false });
}

/**
 * Show a terminal HUD line with NO run behind it (the "Undid: …" confirmation).
 * Unlike `aiFinish` this is a fresh user action, not the tail of a loop, so it
 * clears the cancel flag — otherwise a flash raised after dismissing a HUD
 * would be swallowed by the previous run's cancellation.
 */
export function aiFlash(text: string): void {
  cancelled = false;
  confirmResolver = null;
  set({ status: 'done', result: text, pending: null, error: '', steps: [], utterance: '', mirrored: false });
}

export function aiFail(error: string, result = ''): void {
  if (cancelled) return;
  confirmResolver = null;
  set({ status: 'error', error, result, pending: null, mirrored: false });
}

export function aiReset(): void {
  if (confirmResolver) {
    const prev = confirmResolver;
    confirmResolver = null;
    prev(false);
  }
  set({ status: 'idle', steps: [], pending: null, result: '', error: '', utterance: '', turn: 0, mirrored: false });
}

/**
 * Abandon the run: decline anything pending and drop every later write from the
 * loop still in flight. This is the single "get me out of the HUD" primitive —
 * the glasses tap-during-thinking path, `Stop AI`, and double-tap all use it.
 */
export function aiCancel(): void {
  cancelled = true;
  const resolve = confirmResolver;
  confirmResolver = null;
  if (resolve) resolve(false);
  set({ status: 'idle', steps: [], pending: null, result: '', error: '', utterance: '', turn: 0, mirrored: false });
}

/**
 * Whether the current run has been abandoned.
 *
 * The agent loop MUST consult this before every action. Dropping the HUD writes
 * alone is not enough: the /api/llm request cannot be aborted, so a run that was
 * dismissed would otherwise go on to execute the tool calls that were already
 * queued — the user taps "Stop AI" and the to-do list clears anyway.
 */
export function isAiAborted(): boolean {
  return cancelled;
}

// ── Companion tab requests ──────────────────────────────────────────────────

/**
 * Ask the companion UI to switch tabs (used by `settings.open`, which is a
 * web-only page). Kept here so both the glasses renderer and the web panel can
 * raise it without knowing about each other.
 */
export function requestWebTab(tab: string): void {
  set({ webTab: tab });
}

export function consumeWebTab(): string | null {
  const tab = state.webTab;
  if (tab !== null) set({ webTab: null });
  return tab;
}

/** Test seam: reset to a pristine state (harnesses only). */
export function resetAiForTest(): void {
  confirmResolver = null;
  state = {
    status: 'idle',
    focus: 'todo',
    utterance: '',
    steps: [],
    turn: 0,
    maxSteps: DEFAULT_SETTINGS.maxSteps,
    pending: null,
    result: '',
    error: '',
    webTab: null,
    settings: { ...DEFAULT_SETTINGS },
    mirrored: false,
  };
  confirmResolver = null;
  cancelled = false;
  emit();
}

/**
 * Render a snapshot that belongs to ANOTHER surface, or `null` to clear one.
 *
 * The only writer that leaves `mirrored` set. It goes through `set()` so
 * subscribers repaint — which is exactly why the sync layer, not this function,
 * is responsible for never echoing a mirrored run back onto the wire.
 */
export function applyRemoteAi(snapshot: AiSnapshot | null): void {
  if (!snapshot) {
    if (!state.mirrored) return; // nothing mirrored — don't fight a local run
    set({
      status: 'idle',
      steps: [],
      pending: null,
      result: '',
      error: '',
      utterance: '',
      turn: 0,
      mirrored: false,
    });
    return;
  }
  set({
    status: snapshot.status,
    focus: snapshot.focus,
    utterance: typeof snapshot.utterance === 'string' ? snapshot.utterance : '',
    // Bounded on purpose: the frame is re-sent on every step, and a runaway
    // owner must not be able to grow this store without limit.
    steps: Array.isArray(snapshot.steps) ? snapshot.steps.slice(-14) : [],
    turn: Number(snapshot.turn) || 0,
    maxSteps: Number(snapshot.maxSteps) || DEFAULT_SETTINGS.maxSteps,
    pending: snapshot.pending ?? null,
    result: typeof snapshot.result === 'string' ? snapshot.result : '',
    error: typeof snapshot.error === 'string' ? snapshot.error : '',
    mirrored: true,
  });
}

/** Whether the HUD is currently showing a run owned by another surface. */
export function isAiMirrored(): boolean {
  return state.mirrored;
}
