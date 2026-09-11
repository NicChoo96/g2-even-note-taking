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
//      terminal frame can never show a permanently stuck "working" overlay;
//   4. a mirror never takes the canvas from THIS instance's own state, and a
//      frame that carries no run on it (`idle`, or anything unrecognised) — or
//      that is too old to be from this session — is refused outright. A
//      replayed or empty frame must never be able to blank a reply the wearer is
//      in the middle of reading.
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
  mirrorableStatus,
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
/**
 * Oldest frame still worth adopting — see rule 4. Deliberately loose: it only has
 * to separate "a frame from this session" from "a frame the relay kept from an
 * earlier one", without depending on the two surfaces' clocks agreeing (a tight
 * bound would silently stop mirroring across even a small clock skew). A live
 * frame is re-announced every `HEARTBEAT_MS` and swept after `MIRROR_TTL_MS`, so
 * nothing real is ever close to this old.
 */
export const MIRROR_MAX_AGE_MS = 3_600_000;
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
  now: number = Date.now(),
): boolean {
  if (!remote || typeof remote !== 'object') return false;
  if (typeof remote.owner !== 'string' || !remote.owner) return false;
  if (remote.owner === selfId) return false; // rule 2 — our own echo
  if (!mirrorableStatus(remote.status)) return false;
  // Rule 4b — the frame must be from THIS session. This is a REPLAY guard, not a
  // liveness check (that is `mirrorExpired`'s job, on our own clock), so the
  // bound is deliberately loose: `at` is the SENDER's clock, and a tighter bound
  // would silently stop mirroring between two surfaces whose clocks disagree by
  // more than a few seconds. An hour is beyond any skew that would not break
  // everything else, while still being far past the lifetime of a real frame —
  // an owner re-announces every HEARTBEAT_MS and a mirror is swept after
  // MIRROR_TTL_MS, so nothing live is ever anywhere near this old. Without it, a
  // frame the relay kept from an earlier connection would arrive as live intent.
  if (typeof remote.at !== 'number' || now - remote.at > MIRROR_MAX_AGE_MS) return false;
  return true;
}

/**
 * Rule 4a — may a peer's run take the canvas right now?
 *
 * Only when this instance has nothing of its own on it. A mirrored run is worth
 * showing over an empty HUD; it must never displace a reply being held, a run
 * this instance owns, or a confirmation it is waiting on. (`mirrored` is let
 * through so a live mirror can keep updating itself.)
 */
export function mayMirror(local: { status: string; mirrored: boolean } = getAi()): boolean {
  return local.status === 'idle' || local.mirrored;
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
      if (!acceptRemote(remote)) {
        // Expected traffic (our own echo) is not worth a line, but a dropped
        // FOREIGN frame is exactly what a "Jarvis killed itself" report needs:
        // it says which surface sent it and how late it arrived.
        if (remote && typeof remote === 'object' && remote.owner && remote.owner !== AI_INSTANCE_ID) {
          console.log('[hub] mirror frame refused', {
            owner: remote.owner,
            status: remote.status,
            ageMs: Date.now() - Number(remote.at ?? 0),
          });
        }
        return;
      }
      if (!mayMirror()) {
        console.log('[hub] mirror refused — this surface owns the HUD', { status: getAi().status });
        return;
      }
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
