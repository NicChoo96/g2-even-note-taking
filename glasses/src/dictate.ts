// Speech-to-text module for the G2 Even Reality Hub.
//
// One engine-agnostic API for "talk → text" that can be attached to ANY text
// input in the app. The engine is auto-selected at runtime and microphone
// permission is requested explicitly:
//
//   1. browser    — getUserMedia permission is requested FIRST, inside the tap
//                   gesture (iOS Safari rejects mic access after an await), so
//                   dictation works on mobile and desktop web. Then:
//   2. webspeech  — the free browser Web Speech API when available; if its
//                   service is unavailable it falls back to engine 4.
//   3. bridge     — inside the Even App: the G2 four-mic array (falls back to
//                   the phone mic) via even_hub_sdk audioControl, which
//                   surfaces the host/OS microphone permission dialog, then
//                   transcribes server-side (relay → Deepgram/Whisper).
//   4. media      — a browser without Web Speech (e.g. Firefox/iOS): the same
//                   granted getUserMedia stream → MediaRecorder → relay.
//
// The running transcript arrives through the `onText` hook (DISPLAY only). It is
// written to the caller's target field exactly ONCE, when the session ends: the
// caller reads `dictationSnapshot().commit` + `dictationText()` from its
// `onState('idle')` handler. Committing mid-session re-renders the host page,
// and on the glasses a page write while the mic is open makes the host drop the
// audio stream — which is what used to kill dictation mid-utterance. The React
// wrapper in web/Dictate.tsx turns this into a reusable <MicButton> that drops
// the finished transcript into whichever input it is mounted on.
import {
  AudioInputSource,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { getDurableBridge, isStartupReady } from './durable-docs';
import { getStreamToken, notifyAuthRejected } from './auth-token';
import { API_BASE } from './stream';

export type DictState = 'idle' | 'listening' | 'transcribing' | 'error' | 'unsupported';
export type DictEngine = 'webspeech' | 'bridge' | 'media' | 'none';

export interface DictHooks {
  /** State transitions (idle/listening/transcribing/error/unsupported). */
  onState?: (state: DictState, detail?: string) => void;
  /** Transient live hypothesis while the user is speaking (Web Speech only). */
  onPartial?: (text: string) => void;
  /**
   * The FULL transcript so far — every committed phrase joined, newest last.
   * Fires as it grows, and once more with the final value just before
   * `onState('idle')`, so a listener can render it live.
   *
   * This is a DISPLAY channel, NOT a commit channel. A session must never hand
   * per-phrase text to the caller's target field: writing a field mid-session
   * re-renders the glasses page, and a page write while the mic is open makes
   * the host drop the audio stream (the G2 dies mid-utterance). Callers commit
   * ONCE when the session ends — read `dictationSnapshot().commit` and
   * `dictationText()` inside `onState('idle')`.
   */
  onText?: (full: string) => void;
}

interface DictController {
  /** Stop and commit whatever was heard. */
  stop(): void;
  /** Discard the current capture. */
  abort(): void;
}

let session: DictController | null = null;

// ── On-device diagnostics ──────────────────────────────────────────────────
// Ring buffer of the most recent dictation session's event log so an auto-exit
// can be shown on the glasses for the user to report back. Reset each session.
const DIAG_MAX = 60;
const diagLines: string[] = [];
let diagStart = 0;
let diagReason = 'unknown';

function dlog(...parts: unknown[]): void {
  if (!diagStart) diagStart = Date.now();
  const rel = ((Date.now() - diagStart) / 1000).toFixed(1);
  const line = `+${rel}s ${parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  diagLines.push(line);
  if (diagLines.length > DIAG_MAX) diagLines.shift();
  // Mirror to the devtools console too (useful on the phone-browser path).
  console.log('[dictate]', line);
}

/** Why the last session ended, e.g. 'auto-stop (ws-close-1006)'. */
export function lastDictationReason(): string {
  return diagReason;
}

/** The last session's diagnostic log lines (timestamps relative to its start). */
export function lastDictationLog(): string[] {
  return [...diagLines];
}

// ── Live session snapshot (shared with ANY surface) ─────────────────────────
// Lets other UI (e.g. the glasses, when dictation is started from the web/phone
// MicButton) mirror the active session and refresh live via onDictationSnapshot.
export interface DictationSnapshot {
  active: boolean;
  state: DictState;
  detail: string;
  /** Transient hypothesis (Web Speech only); the streaming engine leaves this ''. */
  interim: string;
  /** Every phrase committed so far, joined — the whole utterance. */
  text: string;
  /** True when the FINISHED session's `text` should be written to the target. */
  commit: boolean;
}
const snap: DictationSnapshot = {
  active: false,
  state: 'idle',
  detail: '',
  interim: '',
  text: '',
  commit: false,
};
let snapCb: (() => void) | null = null;

export function dictationSnapshot(): DictationSnapshot {
  return { ...snap };
}

/**
 * The full transcript accumulated by the active (or most recently ended)
 * session. Read this inside `onState('idle')` — together with
 * `dictationSnapshot().commit` — to write the utterance to the target ONCE.
 */
export function dictationText(): string {
  return snap.text;
}

/** Register a callback fired whenever the live snapshot changes. Returns unsub. */
export function onDictationSnapshot(cb: () => void): () => void {
  snapCb = cb;
  return () => {
    if (snapCb === cb) snapCb = null;
  };
}

/** Wrap a caller's hooks so state/interim also update the shared snapshot. */
function mirrorHooks(hooks: DictHooks): DictHooks {
  return {
    onState: (s, d) => {
      snap.state = s;
      snap.detail = d || '';
      snap.interim = s === 'idle' || s === 'error' || s === 'unsupported' ? '' : snap.interim;
      snap.active = s === 'listening' || s === 'transcribing';
      snapCb?.();
      hooks.onState?.(s, d);
    },
    onPartial: (t) => {
      snap.interim = t;
      snapCb?.();
      hooks.onPartial?.(t);
    },
    onText: (full) => {
      snap.text = full;
      snapCb?.();
      hooks.onText?.(full);
    },
  };
}

export function isDictating(): boolean {
  return session !== null;
}

/** True while running inside the Even App WebView (Flutter). */
export function isEvenApp(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(
    w.flutter_inappwebview ||
      w.flutterWebview ||
      w.FlutterWebView ||
      w.evenapp ||
      /EvenApp|Even Hub|Flutter/i.test(navigator.userAgent),
  );
}

/**
 * Which microphone the app should use:
 *   'glasses' → G2 (Even App): the SDK bridge captures the glasses four-mic
 *               array (or the phone mic) — the "g2 glass skill" path.
 *   'browser' → any web browser (PC or phone): getUserMedia / Web Speech API.
 */
export type MicTarget = 'glasses' | 'browser';
export function micTarget(): MicTarget {
  return isEvenApp() || !!getDurableBridge() ? 'glasses' : 'browser';
}

function hasWebSpeech(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

// ── Microphone permission ────────────────────────────────────────────────────
// getUserMedia is the universal browser mic gate: granting it covers BOTH the
// MediaRecorder engine AND the Web Speech API (same "microphone" permission in
// Chrome). iOS Safari only honours getUserMedia when it's called inside the
// user's tap gesture — before any await — so we probe permission FIRST in
// startDictation, then pick an engine. The Even App/glasses path requests the
// host permission through audioControl when an engine opens the mic.
function browserMedia(): MediaDevices | null {
  if (typeof navigator === 'undefined') return null;
  const nd = navigator as { mediaDevices?: MediaDevices };
  return nd.mediaDevices && typeof nd.mediaDevices.getUserMedia === 'function'
    ? nd.mediaDevices
    : null;
}

let lastMicProbeError: unknown = null;

/** Best-effort read of the site's mic permission state. */
export async function getMicPermission(): Promise<
  'granted' | 'denied' | 'prompt' | 'unsupported'
> {
  if (isEvenApp() || getDurableBridge()) return 'prompt'; // host decides via audioControl
  if (!browserMedia()) return 'unsupported';
  try {
    const perms = navigator.permissions;
    if (perms && typeof perms.query === 'function') {
      const st = await perms.query({ name: 'microphone' as PermissionName });
      return st.state as 'granted' | 'denied' | 'prompt';
    }
  } catch {
    /* permission API unavailable — assume prompt */
  }
  return 'prompt';
}

/**
 * Explicitly ask for browser microphone access (shows the browser prompt).
 * MUST be invoked inside the user's click gesture and before any other await
 * (iOS Safari rejects getUserMedia otherwise). On success the tracks are
 * released immediately — the browser remembers the grant.
 */
export async function requestBrowserMicPermission(): Promise<boolean> {
  const media = browserMedia();
  if (!media) return false;
  try {
    const stream = await media.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (err) {
    lastMicProbeError = err;
    return false;
  }
}

/** Human-readable reason for a failed getUserMedia call. */
function micDeniedMsg(err: unknown): string {
  const name =
    (err && typeof err === 'object' && 'name' in err
      ? String((err as { name?: string }).name)
      : '') || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'Microphone is blocked. Tap the 🔒 in the address bar → Site settings → allow Microphone, then tap the mic again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is in use by another app.';
  }
  return 'Microphone access failed — allow the mic for this site and try again.';
}

// ── Even App (G2 glasses) mic opening ────────────────────────────────────────
// Glasses-mic capture (AudioInputSource.Glasses) only works AFTER the startup
// page container exists; the phone mic does not need it. Both are requested via
// the SDK bridge (audioControl) which surfaces the host/OS permission dialog.
const EVEN_MIC_COPY =
  'Mic blocked — grant Even Hub microphone (phone Settings → Even Hub → Microphone → Allow), then try Dictate again.';

async function openEvenMic(bridge: EvenAppBridge): Promise<{ source: AudioInputSource } | null> {
  // Glasses mic first — but only once the startup page has been created.
  const tryOnce = async (): Promise<{ source: AudioInputSource } | null> => {
    if (isStartupReady()) {
      try {
        if (await bridge.audioControl(true, AudioInputSource.Glasses)) {
          return { source: AudioInputSource.Glasses };
        }
      } catch {
        /* glasses mic unavailable */
      }
    }
    // Phone mic fallback (no startup-page requirement).
    try {
      if (await bridge.audioControl(true, AudioInputSource.Phone)) {
        return { source: AudioInputSource.Phone };
      }
    } catch {
      /* phone mic unavailable */
    }
    return null;
  };
  // Try twice: the host surfaces its mic-permission dialog on the first open,
  // which can race the very first call right after startup. Retrying ~1s later
  // reliably brings up the prompt so the user can grant access.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ok = await tryOnce();
    if (ok) return ok;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 900));
  }
  return null;
}

/** Last resort inside the Even App: some WebViews expose a browser mic. */
async function tryWebviewMic(hooks: DictHooks): Promise<boolean> {
  dlog('engine: webview mic (fallback)');
  const media = browserMedia();
  if (!media) return false;
  if (!(await requestBrowserMicPermission())) {
    hooks.onState?.('error', micDeniedMsg(lastMicProbeError));
    return true; // handled with a denial message
  }
  if (!(await serverSttStatus()).supported) return false;
  void startBrowserStream(hooks);
  return true;
}

async function waitForBridge(ms: number): Promise<EvenAppBridge | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const b = getDurableBridge();
    if (b) return b;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getDurableBridge();
}

export interface SttStatus {
  supported: boolean;
  provider: 'openai' | 'deepgram' | null;
}

/** What speech backend is the relay configured with (if any)? */
async function serverSttStatus(): Promise<SttStatus> {
  try {
    const res = await fetch(`${API_BASE}/api/stt/status`);
    if (!res.ok) return { supported: false, provider: null };
    const j = (await res.json()) as { supported?: boolean; provider?: string };
    return {
      supported: !!j.supported,
      provider: j.provider === 'openai' || j.provider === 'deepgram' ? j.provider : null,
    };
  } catch {
    return { supported: false, provider: null };
  }
}

/** POST raw audio bytes to the relay; returns the transcript text. */
async function sendToStt(
  audio: Uint8Array,
  contentType: string,
  timeoutMs = 15000,
): Promise<string> {
  const token = getStreamToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? window.setTimeout(() => ctrl?.abort(), timeoutMs) : 0;
  try {
    const res = await fetch(`${API_BASE}/api/stt${q}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: audio as unknown as BodyInit,
      signal: ctrl ? (ctrl.signal as AbortSignal) : undefined,
    });
    const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (res.status === 401) notifyAuthRejected(); // session no longer valid
    if (!res.ok) throw new Error(j.error || `Speech server error (${res.status})`);
    return (j.text || '').trim();
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

/**
 * Start a dictation session. Returns false if one is already active or no
 * engine is available (the reason is delivered via hooks.onState).
 *
 * Permission flow:
 *  - Web/mobile browser: getUserMedia is requested FIRST, synchronously inside
 *    the tap gesture (required by iOS Safari). Once granted, both the Web
 *    Speech API and the MediaRecorder engine can start without re-prompting.
 *  - Even App: the SDK engine opens the mic via audioControl, which surfaces
 *    the host/OS permission dialog.
 */
export async function startDictation(hooks: DictHooks = {}): Promise<boolean> {
  if (session) return false; // already dictating — call stopDictation() first

  // Fresh diagnostic log + transcript for this session.
  diagStart = Date.now();
  diagLines.length = 0;
  diagReason = 'running';
  snap.text = '';
  snap.commit = false;
  dlog('start: inApp=', micTarget() === 'glasses', 'bridge=', !!getDurableBridge(), 'webspeech=', hasWebSpeech());

  // Mirror state/interim into the shared snapshot (drives any glasses indicator
  // even when this session was started from the web/phone MicButton).
  const w = mirrorHooks(hooks);

  const inApp = micTarget() === 'glasses';
  const media = browserMedia();

  // Web/mobile browser → ask for the mic now, inside the user gesture.
  // (Skipped in the Even App: getUserMedia may not exist there and the host
  // permission is requested by the SDK bridge instead.)
  let mediaGranted = !inApp && media ? await requestBrowserMicPermission() : false;
  if (!inApp && media && !mediaGranted) {
    w.onState?.('error', micDeniedMsg(lastMicProbeError));
    return false;
  }

  // Inside the Even App → G2/phone mic through the SDK bridge, transcribed by
  // the relay (server-side key, so none ships in this bundle).
  if (inApp) {
    const bridge = getDurableBridge() || (await waitForBridge(2500));
    if (bridge) {
      const status = await serverSttStatus();
      if (!status.supported) {
        w.onState?.(
          'error',
          'Voice server not configured — set OPENAI_API_KEY or DEEPGRAM_API_KEY on the server.',
        );
        return false;
      }
      dlog('engine: continuous streaming (Even mic, per-phrase REST)');
      void startBridge(bridge, w);
      return true;
    }
    // Bridge not ready yet → fall through to a browser-style capture if the
    // WebView exposes getUserMedia (e.g. the Even App WebView).
  }

  // Browser (or Even App WebView without a ready bridge) → the SAME streaming
  // engine, fed by a getUserMedia mic downsampled to 16k.
  if (media) {
    void startBrowserStream(w);
    return true;
  }

  w.onState?.('unsupported', 'Speech-to-text is not available in this browser/app.');
  return false;
}

/** Stop the active session and commit whatever was heard. */
export async function stopDictation(): Promise<void> {
  session?.stop();
}

/** Cancel the active session and discard the capture. */
export function cancelDictation(): void {
  session?.abort();
}

// ── Engine 1: browser Web Speech API ─────────────────────────────────────────
function startWebSpeech(hooks: DictHooks): boolean {
  const w = window as unknown as Record<string, never>;
  const SR = (w.SpeechRecognition || w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined;
  if (!SR) return false;
  dlog('engine webspeech');
  const rec = new SR();
  let finalText = '';
  let lastResult = Date.now();
  let spoken = false;
  let done = false;
  let fallbackTried = false;
  const startedAt = Date.now();
  let watchdog = 0;

  const settle = (commit: boolean) => {
    if (done) return;
    done = true;
    diagReason = commit ? 'webspeech-commit' : 'webspeech-abort';
    window.clearInterval(watchdog);
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
    const text = finalText.trim();
    // Publish the whole utterance + whether it should be written, then go idle.
    // The caller commits the target field from the idle handler — never here.
    snap.commit = commit && !!text;
    hooks.onText?.(text);
    hooks.onPartial?.('');
    hooks.onState?.('idle');
    if (session === ctl) session = null;
  };
  const fail = (detail: string) => {
    if (done) return;
    done = true;
    window.clearInterval(watchdog);
    try {
      rec.abort();
    } catch {
      /* noop */
    }
    hooks.onState?.('error', detail);
    if (session === ctl) session = null;
  };

  const ctl: DictController = { stop: () => settle(true), abort: () => settle(false) };
  session = ctl;

  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;

  rec.onresult = (ev: SpeechResultLike) => {
    lastResult = Date.now();
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    const live = (finalText + interim).trim();
    if (live) {
      spoken = true;
      // Interim is transient; onText is the running transcript (display only).
      hooks.onPartial?.(interim.trim());
      hooks.onText?.(live);
    }
  };
  // Some browsers expose SpeechRecognition but its service is unavailable
  // (e.g. no engine, enterprise policy, language pack). In that case fall back
  // to the mic → server engine so dictation still works.
  const tryFallback = () => {
    if (fallbackTried || done) return;
    fallbackTried = true;
    done = true;
    window.clearInterval(watchdog);
    try {
      rec.abort();
    } catch {
      /* noop */
    }
    if (session === ctl) session = null;
    void (async () => {
      const media = browserMedia();
      if (!media) {
        hooks.onState?.('error', 'Browser speech service is unavailable on this device.');
        return;
      }
      if (!(await requestBrowserMicPermission())) {
        hooks.onState?.('error', micDeniedMsg(lastMicProbeError));
        return;
      }
      if (!(await serverSttStatus()).supported) {
        hooks.onState?.('error', 'Browser speech is unavailable here and no server voice engine is configured.');
        return;
      }
      void startMedia(hooks);
    })();
  };

  rec.onerror = (ev: { error?: string }) => {
    const code = String(ev?.error || '');
    dlog('webspeech onerror code=', code);
    if (code === 'no-speech' || code === 'audio-capture') {
      settle(false);
    } else if (code === 'aborted') {
      // handled by onend
    } else {
      // 'not-allowed', 'service-not-allowed', 'network', 'language-not-supported',
      // 'bad-grammar', or anything unknown → speech service failed, try the mic.
      tryFallback();
    }
  };
  rec.onend = () => settle(true);

  watchdog = window.setInterval(() => {
    if (done) return;
    const idle = Date.now() - lastResult;
    const age = Date.now() - startedAt;
    // End only after a REAL pause (~5s of no speech), an explicit tap/stop, or caps.
    if (spoken && idle > 5000) {
      dlog(`webspeech watchdog: quiet idle=${Math.round(idle)}ms`);
      settle(true);
    } else if (!spoken && age > 20000) {
      dlog(`webspeech watchdog: never-heard age=${Math.round(age)}ms`);
      settle(false);
    } else if (age > 300000) {
      dlog(`webspeech watchdog: hard-cap age=${Math.round(age)}ms`);
      settle(true);
    }
  }, 250);

  hooks.onState?.('listening');
  try {
    rec.start();
    return true;
  } catch {
    fail('Speech recognition could not start.');
    return false;
  }
}

// ── Engine 2: continuous per-phrase streaming — ONE engine for every source ─
// Even-Realities-style pipeline: a single source of 16k s16le mono frames (Even
// App glasses/phone mic, or a browser mic downsampled via Web Audio) is
// VAD-segmented into phrases on short pauses; each finished phrase is
// transcribed over the relay REST ASR while the user keeps talking. The running
// transcript is published through `onText` as it grows, but NOTHING is written
// to the caller's target field until the session ENDS — a field write
// re-renders the glasses page, and a page write while the mic is open makes the
// host drop the audio stream (dictation dies mid-utterance). The session is
// TAP-TO-STOP: it ends only on an explicit stop, or the safety caps (never
// heard anything / 10 min) — never on silence, so pausing to think/read does
// not end it. EVERY entry point (glasses contextual menu, web/phone MicButton,
// browser) funnels into this one engine so behaviour is identical everywhere.

/** A live source of 16 kHz s16le mono PCM frames. */
interface DictStream {
  label: string;
  /** Start delivering frames (call cb per frame); returns an unsubscribe. */
  subscribe(cb: (pcm: Uint8Array) => void): () => void;
  /** Stop the mic/source. */
  close(): void;
  /** Optional: try to recover the source if its frames stall. */
  reopen?(): void;
}

async function runStreamingStream(src: DictStream, hooks: DictHooks): Promise<void> {
  dlog(`engine: streaming (${src.label}, per-phrase REST)`);
  let unsub: (() => void) | null = null;
  let watchdog = 0;
  let closed = false;
  let anySpeech = false;
  let lastFrameAt = Date.now(); // any frame (even silence) → mic liveness
  let micReopened = false;
  const startedAt = Date.now();
  let phraseChunks: Uint8Array[] = []; // current (unfinished) phrase PCM
  let phraseVoicedMs = 0; // voiced audio inside the current phrase
  let phraseQuietMs = 0; // trailing quiet since the phrase's last voiced frame
  let queue: Uint8Array[] = []; // finished phrases awaiting transcription
  let busy = false;
  let wantEnd = false;
  let wantCommit = false; // write the transcript to the target when we end
  let endWhy = 'quiet';
  let stopDeadline = 0; // when the user stopped, cap how long we flush
  let consecErr = 0;
  let transcript = '';

  const PHRASE_END_MS = 700; // trailing quiet that cuts a phrase
  const MAX_PHRASE_MS = 2800; // force-split a phrase this long (bounds latency)
  const MIN_VOICED_MS = 250; // ignore blips shorter than this (noise/click)
  const VAD_RMS = 700;
  // NO silence auto-stop: dictation keeps listening until an explicit tap/Stop,
  // so pausing to think/read never ends it. Only safety nets remain below.
  const NEVER_MS = 90000; // opened but never heard anything → idle (90s)
  const CAP_MS = 600000; // hard cap (10 min)
  const STT_TIMEOUT_MS = 8000; // a hung server call must never wedge the session
  const STOP_FLUSH_MS = 5000; // worst-case time to finish after a stop

  const finalize = (why: string) => {
    if (closed) return;
    closed = true;
    diagReason = `auto-stop (${why})`;
    window.clearInterval(watchdog);
    unsub?.();
    try {
      src.close();
    } catch {
      /* noop */
    }
    // Publish the FINISHED transcript + whether it should be committed. The
    // caller writes the target field from here (never mid-session): a field
    // write re-renders the glasses page, and a page write while the mic is
    // open makes the host drop the audio stream.
    snap.commit = wantCommit && transcript.length > 0;
    hooks.onText?.(transcript);
    hooks.onPartial?.('');
    if (session === ctl) session = null;
    hooks.onState?.('idle');
    dlog(`finalize why=${why} text=${transcript.length}ch commit=${snap.commit}`);
  };

  // Transcribe finished phrases one at a time. Every call has a timeout, so a
  // slow/hung server response can never block the rest of the session or a stop.
  const pump = async () => {
    if (busy || closed) return;
    if (queue.length === 0) {
      if (wantEnd) finalize(endWhy);
      return;
    }
    busy = true;
    const pcm = queue.shift() as Uint8Array;
    try {
      const text = ((await sendToStt(wavFromPcm(pcm), 'audio/wav', STT_TIMEOUT_MS)) || '').trim();
      if (closed) return;
      consecErr = 0;
      if (text) {
        transcript = transcript ? `${transcript} ${text}` : text;
        // Grow the transcript only — the target field is written once, on end.
        hooks.onText?.(transcript);
        dlog(`phrase ok ch=${text.length} total=${transcript.length}`);
      } else {
        dlog('phrase empty (no speech detected server-side)');
      }
    } catch (err) {
      if (closed) return;
      consecErr++;
      dlog('phrase error', errMsg(err));
      if (consecErr >= 3) {
        endWhy = 'stt-failing';
        wantEnd = true;
        finalize('stt-failing');
        return;
      }
    } finally {
      busy = false;
      void pump();
    }
  };

  const enqueuePhrase = () => {
    const pcm = concatBytes(phraseChunks);
    phraseChunks = [];
    phraseVoicedMs = 0;
    phraseQuietMs = 0;
    if (pcm.length < 1600) return; // micro-blip — ignore
    queue.push(pcm);
    dlog(`phrase queued pcm=${pcm.length}B queue=${queue.length} busy=${busy}`);
    void pump();
  };

  const onFrame = (pcm: Uint8Array) => {
    if (pcm.length === 0 || closed) return;
    const now = Date.now();
    const dt = Math.min(1000, Math.max(10, now - lastFrameAt)); // cadence-proof
    lastFrameAt = now;
    const voiced = rms(pcm) > VAD_RMS;
    if (voiced) {
      anySpeech = true;
      phraseQuietMs = 0;
      phraseVoicedMs += dt;
      phraseChunks.push(pcm);
      // NOTE: once an end has been requested (tap / cap) we do NOT cancel it
      // here — a stray voiced frame during the flush window must not keep the
      // session alive forever.
      // Bound phrase size so text streams out in ~2-3s chunks, not one giant
      // clip after a long run-on pause.
      if (phraseVoicedMs >= MAX_PHRASE_MS) {
        phraseVoicedMs = 0;
        phraseQuietMs = 0;
        enqueuePhrase();
      }
    } else if (phraseChunks.length > 0) {
      phraseQuietMs += dt;
      phraseChunks.push(pcm); // keep a natural trailing-silence tail
      if (phraseQuietMs >= PHRASE_END_MS) {
        if (phraseVoicedMs >= MIN_VOICED_MS) enqueuePhrase();
        else {
          phraseChunks = [];
          phraseVoicedMs = 0;
          phraseQuietMs = 0;
        }
      }
    }
    // silence with no phrase in progress → nothing to do (idle is the watchdog's job)
  };

  unsub = src.subscribe(onFrame);

  const ctl: DictController = {
    stop: () => {
      if (closed) return;
      wantEnd = true;
      wantCommit = true; // explicit stop → write the utterance
      endWhy = 'tap';
      stopDeadline = Date.now() + STOP_FLUSH_MS;
      // Stop capturing NOW so the user immediately gets feedback; we still
      // transcribe whatever phrase is in flight / was just spoken.
      hooks.onPartial?.('');
      hooks.onState?.('transcribing');
      try {
        src.close();
      } catch {
        /* noop */
      }
      if (phraseChunks.length) enqueuePhrase(); // flush the trailing phrase
      if (!busy && queue.length === 0) finalize('tap');
      else if (!busy) void pump();
    },
    abort: () => {
      wantEnd = true;
      wantCommit = false; // discard
      endWhy = 'abort';
      phraseChunks = [];
      queue = [];
      finalize('abort');
    },
  };
  session = ctl;

  watchdog = window.setInterval(() => {
    if (closed) return;
    if (wantEnd) {
      if (!busy && queue.length === 0) finalize(endWhy);
      else if (stopDeadline && Date.now() > stopDeadline) finalize(endWhy); // never hang a stop
      return;
    }
    const age = Date.now() - startedAt;
    // If the source stops delivering frames entirely (OS hiccup), try to reopen
    // it once so dictation doesn't die after the first captured word.
    if (anySpeech && !micReopened && Date.now() - lastFrameAt > 2000) {
      micReopened = true;
      dlog('mic frames stalled -> reopening source once');
      try {
        src.close();
      } catch {
        /* noop */
      }
      src.reopen?.();
    }
    // Tap-to-stop only — we do NOT auto-stop on silence. Safety nets only:
    // opened but never heard anything, or the hard cap.
    if (!anySpeech && age > NEVER_MS) {
      dlog(`watchdog: never-heard ${Math.round(age)}ms`);
      wantEnd = true;
      wantCommit = false; // nothing heard — nothing to write
      endWhy = 'never-heard';
      finalize('never-heard');
    } else if (age > CAP_MS) {
      dlog(`watchdog: hard-cap ${Math.round(age)}ms`);
      wantEnd = true;
      wantCommit = true; // hit the cap mid-utterance → keep what was said
      endWhy = 'cap';
      stopDeadline = Date.now() + STOP_FLUSH_MS;
      if (phraseChunks.length) enqueuePhrase();
      if (!busy && queue.length === 0) finalize('cap');
    }
  }, 250);

  hooks.onState?.('listening', src.label);
}

// ── Even App entry: glasses/phone SDK mic → the shared streaming engine ─────
async function startBridge(bridge: EvenAppBridge, hooks: DictHooks): Promise<void> {
  // G2 glasses mic (needs the startup page) → phone mic → WebView/browser mic.
  const opened = await openEvenMic(bridge);
  if (!opened) {
    dlog('streaming mic open FAILED -> browser/webview fallback');
    if (await tryWebviewMic(hooks)) return;
    hooks.onState?.('error', EVEN_MIC_COPY);
    return;
  }
  const label = opened.source === AudioInputSource.Glasses ? 'Glasses mic' : 'Phone mic';
  dlog('streaming mic open source=', label);
  const src: DictStream = {
    label,
    subscribe: (cb) => {
      const u = bridge.onEvenHubEvent((ev) => {
        const pcm = toBytes(ev?.audioEvent?.audioPcm);
        if (pcm && pcm.length) cb(pcm);
      });
      return () => u();
    },
    close: () => void bridge.audioControl(false).catch(() => undefined),
    reopen: () => {
      void bridge.audioControl(false).catch(() => undefined);
      void openEvenMic(bridge).then((o) => dlog(o ? 'mic reopened' : 'mic reopen failed'));
    },
  };
  await runStreamingStream(src, hooks);
}

// ── Browser entry: getUserMedia mic → 16k s16le frames → shared engine ──────
// Downmix + resample the browser mic to 16 kHz mono and feed 100ms frames into
// the SAME streaming engine the Even App uses — so the web/phone MicButton and
// the glasses behave identically (live text, tap-to-stop, 5s auto-stop).
async function startBrowserStream(hooks: DictHooks): Promise<void> {
  const media = browserMedia();
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
  const Ctx = window.AudioContext || w.webkitAudioContext;
  if (!media || !Ctx) {
    // No raw-PCM capture path — fall back to Web Speech (desktop) or one-shot.
    if (hasWebSpeech()) {
      dlog('engine: no audio pipeline -> webspeech fallback');
      startWebSpeech(hooks);
    } else {
      void startMedia(hooks);
    }
    return;
  }
  if (!(await requestBrowserMicPermission())) {
    hooks.onState?.('error', micDeniedMsg(lastMicProbeError));
    return;
  }
  if (!(await serverSttStatus()).supported) {
    hooks.onState?.(
      'error',
      'Voice server not configured — set OPENAI_API_KEY or DEEPGRAM_API_KEY on the server.',
    );
    return;
  }
  dlog('engine: browser streaming (getUserMedia -> 16k -> server)');
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({ audio: true });
  } catch (err) {
    hooks.onState?.('error', micDeniedMsg(err));
    return;
  }
  const ctx = new Ctx();
  const srcNode = ctx.createMediaStreamSource(stream);
  const sp = ctx.createScriptProcessor(4096, 1, 1) as ScriptProcessorNode;
  // A silent sink keeps the ScriptProcessor node processing without feedback.
  const sink = ctx.createMediaStreamDestination();
  srcNode.connect(sp);
  sp.connect(sink);

  const TARGET = 16000;
  const FRAME_N = 1600; // 100ms
  const ratio = TARGET / ctx.sampleRate;
  let sBuf: number[] = [];
  let sPos = 0;
  let fBuf: number[] = [];

  const src: DictStream = {
    label: 'Browser mic',
    subscribe: (cb) => {
      sp.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < ch.length; i++) sBuf.push(ch[i]);
        while (sPos + ratio < sBuf.length) {
          const i0 = Math.floor(sPos);
          const i1 = Math.min(i0 + 1, sBuf.length - 1);
          const frac = sPos - i0;
          fBuf.push(sBuf[i0] * (1 - frac) + sBuf[i1] * frac);
          sPos += ratio;
        }
        const consumed = Math.floor(sPos);
        if (consumed > 0) {
          sBuf = sBuf.slice(consumed);
          sPos -= consumed;
        }
        while (fBuf.length >= FRAME_N) {
          const i16 = new Int16Array(FRAME_N);
          for (let k = 0; k < FRAME_N; k++)
            i16[k] = Math.max(-32768, Math.min(32767, Math.round(fBuf[k] * 32767)));
          fBuf = fBuf.slice(FRAME_N);
          cb(new Uint8Array(i16.buffer));
        }
      };
      return () => {
        sp.onaudioprocess = null;
      };
    },
    close: () => {
      try {
        sp.onaudioprocess = null;
        sp.disconnect();
      } catch {
        /* noop */
      }
      try {
        srcNode.disconnect();
      } catch {
        /* noop */
      }
      void ctx.close();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
  await runStreamingStream(src, hooks);
}

// ── Engine 3: browser getUserMedia → MediaRecorder → relay ───────────────────
async function startMedia(hooks: DictHooks): Promise<void> {
  dlog('engine media (mic->server)');
  const media = browserMedia();
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
  const Ctx = window.AudioContext || w.webkitAudioContext;
  if (!media) {
    hooks.onState?.('unsupported', 'Recording is not supported in this browser.');
    return;
  }
  if (!Ctx) {
    hooks.onState?.('error', 'Audio is not supported here.');
    return;
  }

  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({ audio: true });
  } catch (err) {
    hooks.onState?.('error', micDeniedMsg(err));
    return;
  }

  const mime = pickRecorderMime();
  let recorder: MediaRecorder;
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch {
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      hooks.onState?.('error', 'Recording is not supported here.');
      return;
    }
  }

  const parts: Blob[] = [];
  let closed = false;
  let spoken = false;
  let lastSpeech = Date.now();
  let commit = true;
  const startedAt = Date.now();
  let timer = 0;
  const ctx = new Ctx();
  let analyser: AnalyserNode | null = null;
  try {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
  } catch {
    /* silence detection unavailable — manual stop still works */
  }
  const meterBuf = new Float32Array(analyser?.fftSize || 1024);

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) parts.push(e.data);
  };

  const stopRec = (commitNow: boolean) => {
    if (closed) return;
    commit = commitNow;
    window.clearInterval(timer);
    try {
      void ctx.close();
    } catch {
      /* noop */
    }
    if (recorder.state !== 'inactive') recorder.stop();
    else void transcribe();
  };

  const ctl: DictController = {
    stop: () => stopRec(true),
    abort: () => stopRec(false),
  };
  session = ctl;

  const transcribe = async () => {
    if (closed) return;
    closed = true;
    stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || 'audio/webm';
    const blob = new Blob(parts, { type });
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (!commit || buf.length < 4096) {
      snap.commit = false;
      hooks.onText?.('');
      hooks.onState?.('idle');
      if (session === ctl) session = null;
      return;
    }
    hooks.onState?.('transcribing');
    try {
      const text = await sendToStt(buf, type);
      // One-shot engine: the whole transcript arrives at once, so publish it
      // here and let the caller commit from its idle handler.
      snap.commit = !!text;
      hooks.onText?.(text);
      hooks.onState?.('idle');
    } catch (err) {
      snap.commit = false;
      hooks.onState?.('error', errMsg(err));
    } finally {
      if (session === ctl) session = null;
    }
  };

  recorder.onstop = () => void transcribe();

  timer = window.setInterval(() => {
    if (closed) return;
    // Silence detection from the analyser (if available).
    if (analyser) {
      analyser.getFloatTimeDomainData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
      if (Math.sqrt(sum / meterBuf.length) > 0.02) {
        spoken = true;
        lastSpeech = Date.now();
      }
    }
    const age = Date.now() - startedAt;
    // Wait ~5s of quiet so natural pauses mid-note don't end dictation.
    if (spoken && Date.now() - lastSpeech > 5000) {
      dlog(`media watchdog: quiet ${Math.round(Date.now() - lastSpeech)}ms`);
      stopRec(true);
    } else if (!spoken && age > 20000) {
      dlog(`media watchdog: never-heard ${Math.round(age)}ms`);
      stopRec(false);
    } else if (age > 300000) {
      dlog(`media watchdog: hard-cap ${Math.round(age)}ms`);
      stopRec(true);
    }
  }, 250);

  recorder.start(250);
  hooks.onState?.('listening');
}

// ── PCM / WAV / misc helpers ─────────────────────────────────────────────────
function toBytes(a: unknown): Uint8Array | null {
  if (!a) return null;
  if (a instanceof Uint8Array) return a;
  if (Array.isArray(a)) return Uint8Array.from(a as number[]);
  return null;
}

/** Root-mean-square of a 16 kHz s16le PCM frame (0..32767). */
function rms(pcm: Uint8Array): number {
  const len = pcm.length;
  if (len < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < len; i += 2) {
    let s = pcm[i] | (pcm[i + 1] << 8);
    if (s & 0x8000) s -= 0x10000; // sign-extend s16le
    sum += s * s;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Wrap 16 kHz s16le mono PCM into a standard WAV file. */
function wavFromPcm(pcm: Uint8Array): Uint8Array {
  const len = pcm.length;
  const buf = new ArrayBuffer(44 + len);
  const v = new DataView(buf);
  const put = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  put(0, 'RIFF');
  v.setUint32(4, 36 + len, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 16000, true); // sample rate
  v.setUint32(28, 16000 * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  put(36, 'data');
  v.setUint32(40, len, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

function pickRecorderMime(): string | null {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  for (const c of cands) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* noop */
    }
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Minimal structural types for the (non-DOM) Web Speech API ────────────────
interface SpeechResultLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((ev: SpeechResultLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
