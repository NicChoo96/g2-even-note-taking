// Cross-surface mirroring for the Jarvis run.
//
// The run is per-instance: the loop drives THIS app's store, and the platform
// bridge that paints the glasses HUD only exists on the instance that started
// it. But the glasses and the phone panel are two views of ONE user — starting
// Jarvis on the phone and then looking up must not show a blank HUD, and the
// HUD's Stop must reach the loop that is actually running.
//
// Ownership in one line: exactly one instance owns a run, it broadcasts a
// compact snapshot on the `ai` channel, and every other surface renders it
// read-only and answers it through the directed `ai-ctl` channel.
//
// Three rules keep that from becoming a feedback loop:
//   1. an instance never publishes a run it is only MIRRORING, so two surfaces
//      cannot bounce the same run between them forever;
//   2. an instance drops any snapshot stamped with its OWN owner id;
//   3. a mirror expires if the owner stops speaking, so a surface that missed the
//      terminal frame can never show a permanently stuck "working" overlay.
//
// The owner only re-announces a run that is still IN FLIGHT (`running` /
// `confirm`). A terminal frame (`done` / `error`) is published exactly once, so
// rule 3 can actually take effect on it — see `isLiveStatus`.
import {
  connectAiControlStream,
  connectAiStream,
  publishAi,
  publishAiControl,
} from '../stream';
import {
  aiAnswerConfirm,
  aiCancel,
  applyRemoteAi,
  getAi,
  isAiMirrored,
  subscribeAi,
  type AiControl,
  type AiSnapshot,
} from './store';

/**
 * Per-boot instance id. Random on purpose — two tabs, a reload, or the same
 * device reconnecting must never mistake a peer's run for its own echo.
 */
export const AI_INSTANCE_ID = `ai-${Math.random().toString(36).slice(2, 10)}`;

/** How often the owner re-announces a live run (picks up late subscribers). */
export const HEARTBEAT_MS = 2000;
/** A mirror with no owner heartbeat for this long is presumed dead. */
export const MIRROR_TTL_MS = 8000;
/** A control frame older than this is a reconnect replay, not a live intent. */
export const CONTROL_TTL_MS = 15000;
/** Cap on mirrored steps — the HUD draws a handful, and frames repeat often. */
const MAX_MIRROR_STEPS = 14;

/**
 * Should this instance render the given snapshot?
 *
 * Pure, so the ownership rule can be tested without a relay. `null` means the
 * frame was malformed and must be ignored rather than cleared.
 */
export function acceptRemote(
  remote: AiSnapshot | null | undefined,
  selfId: string = AI_INSTANCE_ID,
): boolean {
  if (!remote || typeof remote !== 'object') return false;
  if (typeof remote.owner !== 'string' || !remote.owner) return false;
  return remote.owner !== selfId;
}

/** Should this instance act on the given control frame? */
export function acceptControl(
  ctl: AiControl | null | undefined,
  selfId: string = AI_INSTANCE_ID,
  now: number = Date.now(),
): boolean {
  if (!ctl || typeof ctl !== 'object') return false;
  if (ctl.target !== selfId) return false;
  if (ctl.action !== 'stop' && ctl.action !== 'confirm') return false;
  // A replayed instruction from before a reconnect must not fire: the owner may
  // have moved on to a completely different run in the meantime.
  if (typeof ctl.at !== 'number' || now - ctl.at > CONTROL_TTL_MS) return false;
  return true;
}

/**
 * Rule 1 as a predicate: only the OWNER broadcasts a run. A mirrored run is
 * another surface's business — re-publishing it here would bounce the same run
 * between the two surfaces forever.
 */
export function shouldBroadcast(mirrored: boolean = isAiMirrored()): boolean {
  return !mirrored;
}

/** The snapshot this instance would broadcast for its own run. */
export function localSnapshot(now: number = Date.now()): AiSnapshot {
  const s = getAi();
  return {
    owner: AI_INSTANCE_ID,
    at: now,
    status: s.status,
    focus: s.focus,
    utterance: s.utterance,
    steps: s.steps.slice(-MAX_MIRROR_STEPS),
    turn: s.turn,
    maxSteps: s.maxSteps,
    pending: s.pending,
    result: s.result,
    error: s.error,
  };
}

/**
 * Should the mirror be dropped right now? A mirrored run whose owner has gone
 * quiet (crash, killed tab, lost connection) would otherwise freeze the HUD on
 * "working 2/6" forever.
 */
export function mirrorExpired(
  mirrored: boolean,
  status: string,
  lastFrameAt: number,
  now: number = Date.now(),
): boolean {
  return mirrored && status !== 'idle' && now - lastFrameAt > MIRROR_TTL_MS;
}

// ── The owning side: start / stop timers ────────────────────────────────────

let heartbeat: ReturnType<typeof setInterval> | null = null;
/** Owner id of the run currently mirrored here — the target for our controls. */
let mirrorOwner: string | null = null;
let lastFrameAt = 0;
let started = false;

function stopHeartbeat(): void {
  if (heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/**
 * Is this status still *in flight*?
 *
 * Only a live run is worth re-announcing. `done` and `error` are terminal: the
 * final frame is published once (by the store subscriber), and the mirror is
 * then allowed to age out. Without this, a finished run would re-announce every
 * couple of seconds forever — keeping the peer's TTL permanently refreshed, so
 * a stale "JARVIS · done" overlay would never leave the other surface's HUD.
 */
export function isLiveStatus(status: string): boolean {
  return status === 'running' || status === 'confirm';
}

/**
 * Keep re-announcing while — and only while — this instance owns a LIVE run.
 * A non-idle mirrored run must NOT start a heartbeat: that is rule 1.
 */
function syncHeartbeat(): void {
  const owning = shouldBroadcast() && isLiveStatus(getAi().status);
  if (owning && heartbeat === null) {
    heartbeat = setInterval(() => {
      if (!shouldBroadcast() || !isLiveStatus(getAi().status)) {
        stopHeartbeat();
        return;
      }
      void publishAi(localSnapshot());
    }, HEARTBEAT_MS);
  } else if (!owning) {
    stopHeartbeat();
  }
}

// ── The mirroring side: controls answered on behalf of the user ─────────────

/**
 * The wire shape of "stop that run". Pure so it can be verified without a live
 * credential (`postJson` no-ops when this instance is not authenticated).
 */
export function stopFrame(owner: string, at: number = Date.now()): AiControl {
  return { target: owner, at, action: 'stop' };
}

/** The wire shape of an answer to the owner's pending confirmation. */
export function confirmFrame(owner: string, approve: boolean, at: number = Date.now()): AiControl {
  return { target: owner, at, action: 'confirm', approve };
}

/** Ask the owning surface to abandon its run (the HUD's Stop). */
export function requestRemoteStop(): void {
  if (!mirrorOwner) return;
  void publishAiControl(stopFrame(mirrorOwner));
}

/** Answer the owning surface's pending confirmation. */
export function requestRemoteConfirm(approve: boolean): void {
  if (!mirrorOwner) return;
  void publishAiControl(confirmFrame(mirrorOwner, approve));
}

/**
 * Start mirroring. Safe to call once per app boot; returns a teardown for tests.
 *
 * Deliberately NOT re-exported from `ai/index.ts`: this module owns live network
 * subscriptions, and the harness imports the pure predicates above directly.
 */
export function startAiMirror(): () => void {
  if (started) return () => {};
  started = true;

  const offLocal = subscribeAi(() => {
    if (!shouldBroadcast()) return; // rule 1 — never echo a mirror back onto the wire
    syncHeartbeat();
    void publishAi(localSnapshot());
  });

  const offMirror = connectAiStream<AiSnapshot>({
    onState: (remote) => {
      if (!acceptRemote(remote)) return; // rule 2 — ignore our own echo
      mirrorOwner = remote.owner;
      lastFrameAt = Date.now();
      applyRemoteAi(remote);
    },
  });

  const offControl = connectAiControlStream<AiControl>({
    onState: (ctl) => {
      if (!acceptControl(ctl)) return;
      if (ctl.action === 'stop') aiCancel();
      else aiAnswerConfirm(ctl.approve === true);
    },
  });

  const sweep = setInterval(() => {
    // rule 3 — drop a mirror whose owner went quiet
    if (mirrorExpired(getAi().mirrored, getAi().status, lastFrameAt)) {
      mirrorOwner = null;
      applyRemoteAi(null);
    }
  }, 1000);

  return () => {
    started = false;
    offLocal();
    offMirror();
    offControl();
    clearInterval(sweep);
    stopHeartbeat();
  };
}
