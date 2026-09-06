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
// Transcribed text arrives through the onFinal hook. The React wrapper in
// web/Dictate.tsx turns this into a reusable <MicButton> that drops the text
// into whichever input it is mounted on.
import {
  AudioInputSource,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { getDurableBridge, isStartupReady } from './durable-docs';
import { getStreamToken, notifyAuthRejected } from './auth-token';
import { API_BASE } from './stream';

export type DictState = 'idle' | 'listening' | 'transcribing' | 'error' | 'unsupported';
export type DictEngine = 'webspeech' | 'bridge' | 'media' | 'none';

export interface DictHooks {
  /** State transitions (idle/listening/transcribing/error/unsupported). */
  onState?: (state: DictState, detail?: string) => void;
  /** Interim live text while the user is speaking (Web Speech only). */
  onPartial?: (text: string) => void;
  /** A committed transcript chunk — insert this into the input. */
  onFinal?: (text: string) => void;
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
  interim: string;
}
const snap: DictationSnapshot = { active: false, state: 'idle', detail: '', interim: '' };
let snapCb: (() => void) | null = null;

export function dictationSnapshot(): DictationSnapshot {
  return { ...snap };
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
    onFinal: (t) => hooks.onFinal?.(t),
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
  void startMedia(hooks);
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

  // Fresh diagnostic log for this session.
  diagStart = Date.now();
  diagLines.length = 0;
  diagReason = 'running';
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

  // Plain browser with the Web Speech API → free, keyless, no audio upload.
  if (!inApp && !getDurableBridge() && hasWebSpeech()) {
    return startWebSpeech(w);
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
      // Continuous streaming session: ONE clean mic open, per-phrase REST
      // commits so text appears live and the session stays open until tap or
      // ~5s of silence. (The Deepgram-LIVE ws leg is unreliable from Railway —
      // it closes ~0.7s in, code 1006 — so we stream via REST.)
      dlog('engine: continuous streaming (single mic, per-phrase REST)');
      void startBridge(bridge, w);
      return true;
    }
    // Bridge not ready yet → fall through to a browser-style capture if the
    // WebView exposes getUserMedia (e.g. the Even App WebView).
  }

  // Browser without Web Speech (or WebView without a ready bridge) → record the
  // mic with getUserMedia + MediaRecorder, transcribe server-side.
  if (media) {
    // Request permission here too if we haven't yet (only possible on the
    // Even-app-without-bridge path above).
    if (!mediaGranted && !(await requestBrowserMicPermission())) {
      w.onState?.('error', micDeniedMsg(lastMicProbeError));
      return false;
    }
    if (!(await serverSttStatus()).supported) {
      w.onState?.(
        'error',
        'Voice server not configured — set OPENAI_API_KEY or DEEPGRAM_API_KEY on the server.',
      );
      return false;
    }
    void startMedia(w);
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
    if (commit && text) hooks.onFinal?.(text);
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
      hooks.onPartial?.(live);
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

// ── Engine 2: Even App SDK mic (glasses/phone) → continuous streaming ───────
// Mirrors Even Realities' own low-latency pipeline as closely as our infra
// allows: the mic is opened ONCE and left open, speech is cut into phrases on
// short pauses, and each finished phrase is transcribed over the relay's REST
// ASR as you keep talking. Text grows live (onPartial = running transcript,
// onFinal = committed phrase) so it appears on the glasses/note in near-real
// time. The session stays open until an explicit tap, ~5s of real silence, or
// the time cap — it never ends just because you paused mid-note.
async function startBridge(bridge: EvenAppBridge, hooks: DictHooks): Promise<void> {
  dlog('engine: streaming (single mic, per-phrase REST)');
  let unsub: (() => void) | null = null;
  let watchdog = 0;
  let source: AudioInputSource = AudioInputSource.Glasses;
  let closed = false;
  let anySpeech = false;
  let lastVoicedAt = Date.now(); // any voiced frame → resets the 5s auto-stop
  let lastFrameAt = Date.now(); // any frame (even silence) → mic liveness
  let micReopened = false;
  const startedAt = Date.now();
  let phraseChunks: Uint8Array[] = []; // current (unfinished) phrase PCM
  let phraseVoicedMs = 0; // voiced audio inside the current phrase
  let phraseQuietMs = 0; // trailing quiet since the phrase's last voiced frame
  let queue: Uint8Array[] = []; // finished phrases awaiting transcription
  let busy = false;
  let wantEnd = false;
  let endWhy = 'quiet';
  let stopDeadline = 0; // when the user tapped, cap how long we flush
  let consecErr = 0;
  let transcript = '';

  const PHRASE_END_MS = 700; // trailing quiet that cuts a phrase
  const MAX_PHRASE_MS = 2800; // force-split a phrase this long (bounds latency)
  const MIN_VOICED_MS = 250; // ignore blips shorter than this (noise/click)
  const VAD_RMS = 700;
  const STOP_QUIET_MS = 5000; // real silence → auto-stop (flush then idle)
  const NEVER_MS = 20000; // never heard anything → idle
  const CAP_MS = 300000; // hard cap
  const STT_TIMEOUT_MS = 8000; // a hung server call must never wedge the session
  const STOP_FLUSH_MS = 5000; // worst-case time to finish after a tap

  const finalize = (why: string) => {
    if (closed) return;
    closed = true;
    diagReason = `auto-stop (${why})`;
    window.clearInterval(watchdog);
    unsub?.();
    void bridge.audioControl(false).catch(() => undefined);
    hooks.onPartial?.('');
    if (session === ctl) session = null;
    hooks.onState?.('idle');
    dlog(`finalize why=${why} text=${transcript.length}ch`);
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
        hooks.onPartial?.(transcript);
        hooks.onFinal?.(text); // commit this phrase to the target live
        dlog(`phrase ok ch=${text.length}`);
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

  const onAudio = (ev: EvenHubEvent) => {
    const pcm = toBytes(ev?.audioEvent?.audioPcm);
    if (!pcm || pcm.length === 0 || closed) return;
    const now = Date.now();
    const dt = Math.min(1000, Math.max(10, now - lastFrameAt)); // cadence-proof
    lastFrameAt = now;
    const voiced = rms(pcm) > VAD_RMS;
    if (voiced) {
      anySpeech = true;
      lastVoicedAt = now;
      phraseQuietMs = 0;
      phraseVoicedMs += dt;
      phraseChunks.push(pcm);
      if (wantEnd) wantEnd = false; // still talking — don't end yet
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

  unsub = bridge.onEvenHubEvent(onAudio);

  // G2 glasses mic (needs the startup page) → phone mic → WebView mic.
  const opened = await openEvenMic(bridge);
  if (!opened) {
    dlog('streaming mic open FAILED -> webview fallback');
    unsub();
    if (await tryWebviewMic(hooks)) return;
    hooks.onState?.('error', EVEN_MIC_COPY);
    return;
  }
  source = opened.source;
  dlog('streaming mic open source=', source === AudioInputSource.Glasses ? 'glasses' : 'phone');

  const ctl: DictController = {
    stop: () => {
      if (closed) return;
      wantEnd = true;
      endWhy = 'tap';
      stopDeadline = Date.now() + STOP_FLUSH_MS;
      // Stop capturing NOW so the user immediately gets feedback; we still
      // transcribe whatever phrase is in flight / was just spoken.
      hooks.onPartial?.(transcript);
      hooks.onState?.('transcribing');
      void bridge.audioControl(false).catch(() => undefined);
      if (phraseChunks.length) enqueuePhrase(); // flush the trailing phrase
      if (!busy && queue.length === 0) finalize('tap');
      else if (!busy) void pump();
    },
    abort: () => {
      wantEnd = true;
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
      else if (stopDeadline && Date.now() > stopDeadline) finalize(endWhy); // never hang a tap
      return;
    }
    const age = Date.now() - startedAt;
    const idle = Date.now() - lastVoicedAt;
    // If the glasses mic stops delivering frames entirely (OS hiccup), reopen
    // it once so dictation doesn't die after the first captured word.
    if (anySpeech && !micReopened && Date.now() - lastFrameAt > 2000) {
      micReopened = true;
      dlog('mic frames stalled -> reopening mic once');
      void bridge.audioControl(false).catch(() => undefined);
      void openEvenMic(bridge).then((o) => dlog(o ? 'mic reopened' : 'mic reopen failed'));
    }
    if (anySpeech && idle > STOP_QUIET_MS) {
      dlog(`watchdog: quiet ${Math.round(idle)}ms`);
      wantEnd = true;
      endWhy = 'quiet';
      stopDeadline = Date.now() + STOP_FLUSH_MS;
      if (phraseChunks.length) enqueuePhrase();
      if (!busy && queue.length === 0) finalize('quiet');
    } else if (!anySpeech && age > NEVER_MS) {
      dlog(`watchdog: never-heard ${Math.round(age)}ms`);
      wantEnd = true;
      endWhy = 'never-heard';
      finalize('never-heard');
    } else if (age > CAP_MS) {
      dlog(`watchdog: hard-cap ${Math.round(age)}ms`);
      wantEnd = true;
      endWhy = 'cap';
      stopDeadline = Date.now() + STOP_FLUSH_MS;
      if (phraseChunks.length) enqueuePhrase();
      if (!busy && queue.length === 0) finalize('cap');
    }
  }, 250);

  hooks.onState?.(
    'listening',
    source === AudioInputSource.Glasses ? 'Glasses mic' : 'Phone mic',
  );
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
      hooks.onState?.('idle');
      if (session === ctl) session = null;
      return;
    }
    hooks.onState?.('transcribing');
    try {
      const text = await sendToStt(buf, type);
      if (text) hooks.onFinal?.(text);
      hooks.onState?.('idle');
    } catch (err) {
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
