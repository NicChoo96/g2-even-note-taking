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
  'The Even App could not open a mic. Grant Even Hub microphone access (phone Settings → Even Hub → Microphone → Allow), make sure this app build declares g2-microphone / phone-microphone, then restart the Even app and try again.';

async function openEvenMic(bridge: EvenAppBridge): Promise<{ source: AudioInputSource } | null> {
  if (isStartupReady()) {
    // Glasses mic first — but only once the startup page has been created.
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
}

/** Last resort inside the Even App: some WebViews expose a browser mic. */
async function tryWebviewMic(hooks: DictHooks): Promise<boolean> {
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

function hasWebSocket(): boolean {
  return typeof WebSocket !== 'undefined';
}

/** WebSocket URL for live streaming STT (this relay → Deepgram). */
function sttWsUrl(): string {
  const token = getStreamToken();
  let base = API_BASE.trim();
  if (!base || base.startsWith('/')) {
    const proto =
      typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
    base = `${proto}//${location.host}`;
  } else {
    base = base.replace(/^http/i, 'ws');
  }
  return `${base}/api/stt/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** POST raw audio bytes to the relay; returns the transcript text. */
async function sendToStt(audio: Uint8Array, contentType: string): Promise<string> {
  const token = getStreamToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const res = await fetch(`${API_BASE}/api/stt${q}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: audio as unknown as BodyInit,
  });
  const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (res.status === 401) notifyAuthRejected(); // session no longer valid
  if (!res.ok) throw new Error(j.error || `Speech server error (${res.status})`);
  return (j.text || '').trim();
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

  const inApp = micTarget() === 'glasses';
  const media = browserMedia();

  // Web/mobile browser → ask for the mic now, inside the user gesture.
  // (Skipped in the Even App: getUserMedia may not exist there and the host
  // permission is requested by the SDK bridge instead.)
  let mediaGranted = !inApp && media ? await requestBrowserMicPermission() : false;
  if (!inApp && media && !mediaGranted) {
    hooks.onState?.('error', micDeniedMsg(lastMicProbeError));
    return false;
  }

  // Plain browser with the Web Speech API → free, keyless, no audio upload.
  if (!inApp && !getDurableBridge() && hasWebSpeech()) {
    return startWebSpeech(hooks);
  }

  // Inside the Even App → G2/phone mic through the SDK bridge, transcribed by
  // the relay (server-side key, so none ships in this bundle). Deepgram gets
  // live streaming; otherwise fall back to the record-then-upload batch path.
  if (inApp) {
    const bridge = getDurableBridge() || (await waitForBridge(2500));
    if (bridge) {
      const status = await serverSttStatus();
      if (!status.supported) {
        hooks.onState?.(
          'error',
          'Voice server not configured — set OPENAI_API_KEY or DEEPGRAM_API_KEY on the server.',
        );
        return false;
      }
      if (status.provider === 'deepgram' && hasWebSocket()) {
        void startBridgeStream(bridge, hooks);
      } else {
        void startBridge(bridge, hooks); // OpenAI batch (or Deepgram batch fallback)
      }
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
      hooks.onState?.('error', micDeniedMsg(lastMicProbeError));
      return false;
    }
    if (!(await serverSttStatus()).supported) {
      hooks.onState?.(
        'error',
        'Voice server not configured — set OPENAI_API_KEY or DEEPGRAM_API_KEY on the server.',
      );
      return false;
    }
    void startMedia(hooks);
    return true;
  }

  hooks.onState?.('unsupported', 'Speech-to-text is not available in this browser/app.');
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
    // End only after a REAL pause (~3.5s of no speech), an explicit stop, or caps.
    if (spoken && idle > 3500) settle(true); // genuinely stopped talking
    else if (!spoken && age > 20000) settle(false); // never heard anything
    else if (age > 180000) settle(true); // hard cap (3 min)
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

// ── Engine 2: Even App SDK mic (glasses, falling back to phone) → relay ─────
async function startBridge(bridge: EvenAppBridge, hooks: DictHooks): Promise<void> {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let spoken = false;
  let lastSpeech = Date.now();
  const startedAt = Date.now();
  let watchdog = 0;
  let unsub: (() => void) | null = null;
  let source: AudioInputSource = AudioInputSource.Glasses;

  const finish = async (commit: boolean) => {
    if (closed) return;
    closed = true;
    window.clearInterval(watchdog);
    unsub?.();
    try {
      await bridge.audioControl(false);
    } catch {
      /* noop */
    }
    const pcm = concatBytes(chunks);
    if (!commit || pcm.length < 1600) {
      // Too little audio to transcribe.
      hooks.onState?.('idle');
      if (session === ctl) session = null;
      return;
    }
    hooks.onState?.('transcribing');
    try {
      const text = await sendToStt(wavFromPcm(pcm), 'audio/wav');
      if (text) hooks.onFinal?.(text);
      hooks.onState?.('idle');
    } catch (err) {
      hooks.onState?.('error', errMsg(err));
    } finally {
      if (session === ctl) session = null;
    }
  };

  const onAudio = (ev: EvenHubEvent) => {
    const pcm = toBytes(ev?.audioEvent?.audioPcm);
    if (!pcm || pcm.length === 0) return;
    chunks.push(pcm);
    if (rms(pcm) > 700) {
      spoken = true;
      lastSpeech = Date.now();
    }
  };

  unsub = bridge.onEvenHubEvent(onAudio);

  // G2 glasses mic (needs the startup page) → phone mic → WebView mic.
  const opened = await openEvenMic(bridge);
  if (!opened) {
    unsub();
    if (await tryWebviewMic(hooks)) return;
    hooks.onState?.('error', EVEN_MIC_COPY);
    return;
  }
  source = opened.source;

  const ctl: DictController = {
    stop: () => void finish(true),
    abort: () => void finish(false),
  };
  session = ctl;

  watchdog = window.setInterval(() => {
    if (closed) return;
    const age = Date.now() - startedAt;
    // Wait ~2.5s of quiet so natural pauses mid-note don't end dictation.
    if (spoken && Date.now() - lastSpeech > 2500) void finish(true); // pause → transcribe
    else if (!spoken && age > 20000) void finish(false);
    else if (age > 120000) void finish(true);
  }, 250);

  hooks.onState?.(
    'listening',
    source === AudioInputSource.Glasses ? 'Glasses mic' : 'Phone mic',
  );
}

// ── Engine 2b: LIVE streaming (glasses/phone mic → relay WS → Deepgram) ──────
// Like the official @deepgram/sdk live sample, but the Deepgram leg runs on the
// relay so the API key never leaves the server. The glasses PCM is streamed in
// real time and Results (interim + final) come back as you speak.
async function startBridgeStream(bridge: EvenAppBridge, hooks: DictHooks): Promise<void> {
  let ws: WebSocket | null = null;
  let unsub: (() => void) | null = null;
  let watchdog = 0;
  let source: AudioInputSource = AudioInputSource.Glasses;
  let closed = false;
  let spoken = false;
  let lastActivity = Date.now();
  const startedAt = Date.now();
  let finalText = '';
  let interimText = '';

  const emitLive = () => {
    const live = `${finalText}${interimText ? ` ${interimText}` : ''}`.trim();
    if (live) hooks.onPartial?.(live);
  };

  let ctl: DictController = { stop: () => undefined, abort: () => undefined };

  const finalize = () => {
    if (session !== ctl) return;
    session = null;
    hooks.onPartial?.('');
    const t = finalText.trim();
    if (t) hooks.onFinal?.(t);
    hooks.onState?.('idle');
  };

  const shutdown = (commit: boolean) => {
    if (closed) return;
    closed = true;
    window.clearInterval(watchdog);
    unsub?.();
    void bridge.audioControl(false).catch(() => undefined);
    if (commit && spoken && ws && ws.readyState === WebSocket.OPEN) {
      // Tell Deepgram to flush its final transcript, then let it close us.
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* noop */
      }
      window.setTimeout(() => {
        try {
          ws?.close();
        } catch {
          /* noop */
        }
      }, 2500);
      window.setTimeout(() => {
        if (session === ctl) finalize();
      }, 4500);
      return;
    }
    try {
      ws?.close();
    } catch {
      /* noop */
    }
    if (session === ctl) finalize();
  };

  const onAudio = (ev: EvenHubEvent) => {
    const pcm = toBytes(ev?.audioEvent?.audioPcm);
    if (!pcm || pcm.length === 0) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
    }
  };

  // Open the live relay → Deepgram socket first (5s cap), then start the mic.
  try {
    ws = await openSttSocket(5000);
  } catch {
    // Deepgram live unreachable here — fall back to the verified batch path so
    // dictation still works (relay → Deepgram REST, no live interim).
    hooks.onState?.('idle');
    void startBridge(bridge, hooks);
    return;
  }

  ws.onmessage = (ev) => {
    lastActivity = Date.now();
    let msg: { type?: string; is_final?: boolean; speech_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string }> } };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type !== 'Results' || !msg.channel?.alternatives?.[0]) return;
    const transcript = (msg.channel.alternatives[0].transcript || '').trim();
    if (!transcript) return;
    spoken = true;
    if (msg.is_final) {
      finalText = `${finalText} ${transcript}`.trim();
      interimText = '';
    } else {
      interimText = transcript;
    }
    emitLive();
  };
  ws.onerror = () => {
    if (!closed) hooks.onState?.('error', 'Live voice stream error.');
    if (session === ctl) session = null;
    closed = true;
    window.clearInterval(watchdog);
    unsub?.();
    void bridge.audioControl(false).catch(() => undefined);
  };
  ws.onclose = () => {
    if (session === ctl) finalize();
  };

  unsub = bridge.onEvenHubEvent(onAudio);

  // G2 glasses mic (needs the startup page) → phone mic → WebView mic.
  const opened = await openEvenMic(bridge);
  if (!opened) {
    unsub();
    closed = true;
    try {
      ws.close();
    } catch {
      /* noop */
    }
    if (await tryWebviewMic(hooks)) return;
    hooks.onState?.('error', EVEN_MIC_COPY);
    return;
  }
  source = opened.source;

  ctl = {
    stop: () => shutdown(true),
    abort: () => shutdown(false),
  };
  session = ctl;

  watchdog = window.setInterval(() => {
    if (closed) return;
    const age = Date.now() - startedAt;
    const idle = Date.now() - lastActivity;
    // NOTE: Deepgram fires is_final + speech_final at the end of EVERY phrase
    // (endpointing). Treating that as "done" (as a ~900ms auto-commit did) made
    // dictation stop itself right after the first phrase/pause. Instead we keep
    // listening across phrases and only end after a REAL silence (~3.5s with no
    // new speech), an explicit tap (stop), or the caps below.
    if (spoken && idle > 3500) shutdown(true); // genuinely stopped talking
    else if (!spoken && age > 20000) shutdown(false); // never heard anything
    else if (age > 180000) shutdown(true); // hard cap (3 min)
  }, 300);

  hooks.onState?.(
    'listening',
    source === AudioInputSource.Glasses ? 'Glasses mic · live' : 'Phone mic · live',
  );
}

/** Open the relay WebSocket with a connect timeout. */
function openSttSocket(timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(sttWsUrl());
    } catch (err) {
      reject(err);
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error('voice socket timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      window.clearTimeout(timer);
      ws.onerror = null;
      resolve(ws);
    };
    ws.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('voice socket error'));
    };
  });
}

// ── Engine 3: browser getUserMedia → MediaRecorder → relay ───────────────────
async function startMedia(hooks: DictHooks): Promise<void> {
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
    // Wait ~2.5s of quiet so natural pauses mid-note don't end dictation.
    if (spoken && Date.now() - lastSpeech > 2500) stopRec(true);
    else if (!spoken && age > 20000) stopRec(false);
    else if (age > 120000) stopRec(true);
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
