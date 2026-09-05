// Speech-to-text module for the G2 Even Reality Hub.
//
// One engine-agnostic API for "talk → text" that can be attached to ANY text
// input in the app. The engine is auto-selected at runtime:
//
//   1. bridge    — inside the Even App: captures the G2 four-mic array (falls
//                  back to the phone mic) via even_hub_sdk audioControl, then
//                  batches the 16 kHz PCM and transcribes it server-side
//                  (the relay proxies to a speech API with a server-side key).
//                  This is the "g2 even skill" path — the mic is on the glasses.
//   2. webspeech — a plain browser that supports the Web Speech API
//                  (Chrome/Edge/Safari): free, no key, no audio upload.
//   3. media     — a browser without Web Speech (e.g. Firefox): getUserMedia →
//                  MediaRecorder → same server-side transcription.
//
// Transcribed text arrives through the onFinal hook. The React wrapper in
// web/Dictate.tsx turns this into a reusable <MicButton> that drops the text
// into whichever input it is mounted on.
import {
  AudioInputSource,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { getDurableBridge } from './durable-docs';
import { getStreamToken } from './auth-token';
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

function hasWebSpeech(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
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
  if (!res.ok) throw new Error(j.error || `Speech server error (${res.status})`);
  return (j.text || '').trim();
}

/**
 * Start a dictation session. Returns false if one is already active or no
 * engine is available (the reason is delivered via hooks.onState).
 */
export async function startDictation(hooks: DictHooks = {}): Promise<boolean> {
  if (session) return false; // already dictating — call stopDictation() first

  // Plain browser with the Web Speech API → start synchronously so the mic
  // permission prompt stays inside the user's click gesture.
  if (!isEvenApp() && !getDurableBridge() && hasWebSpeech()) {
    return startWebSpeech(hooks);
  }

  // Inside the Even App → G2/phone mic through the SDK bridge, transcribed by
  // the relay (server-side key, so none ships in this bundle). Deepgram gets
  // live streaming; otherwise fall back to the record-then-upload batch path.
  if (isEvenApp() || getDurableBridge()) {
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
  }

  // Any other browser without Web Speech → record the mic + transcribe server-side.
  const mediaDevices =
    (typeof navigator !== 'undefined'
      ? (navigator as { mediaDevices?: MediaDevices }).mediaDevices
      : undefined) || null;
  if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') {
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
  rec.onerror = (ev: { error?: string }) => {
    const code = String(ev?.error || '');
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      fail('Microphone access blocked — allow the mic for this site.');
    } else if (code === 'no-speech' || code === 'audio-capture') {
      settle(false);
    } else if (code === 'network') {
      fail('Speech recognition network error.');
    }
    // 'aborted' → onend settles.
  };
  rec.onend = () => settle(true);

  watchdog = window.setInterval(() => {
    if (done) return;
    const idle = Date.now() - lastResult;
    const age = Date.now() - startedAt;
    if (spoken && idle > 1800) settle(true); // pause after speech → commit
    else if (!spoken && age > 15000) settle(false); // never heard anything
    else if (age > 60000) settle(true); // hard cap
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

  // Prefer the glasses four-mic array; fall back to the phone mic.
  try {
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses);
    if (!ok) throw new Error('glasses mic rejected');
  } catch {
    try {
      const ok = await bridge.audioControl(true, AudioInputSource.Phone);
      source = AudioInputSource.Phone;
      if (!ok) throw new Error('phone mic rejected');
    } catch {
      unsub();
      hooks.onState?.('error', 'No microphone available on this device.');
      return;
    }
  }

  const ctl: DictController = {
    stop: () => void finish(true),
    abort: () => void finish(false),
  };
  session = ctl;

  watchdog = window.setInterval(() => {
    if (closed) return;
    const age = Date.now() - startedAt;
    if (spoken && Date.now() - lastSpeech > 1500) void finish(true); // pause → transcribe
    else if (!spoken && age > 15000) void finish(false);
    else if (age > 60000) void finish(true);
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
  let utteranceEnded = false;
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
      utteranceEnded = !!msg.speech_final;
    } else {
      interimText = transcript;
      utteranceEnded = false;
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

  // Prefer the glasses four-mic array; fall back to the phone mic.
  try {
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses);
    if (!ok) throw new Error('glasses mic rejected');
  } catch {
    try {
      const ok = await bridge.audioControl(true, AudioInputSource.Phone);
      source = AudioInputSource.Phone;
      if (!ok) throw new Error('phone mic rejected');
    } catch {
      unsub();
      closed = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      hooks.onState?.('error', 'No microphone available on this device.');
      return;
    }
  }

  ctl = {
    stop: () => shutdown(true),
    abort: () => shutdown(false),
  };
  session = ctl;

  watchdog = window.setInterval(() => {
    if (closed) return;
    const age = Date.now() - startedAt;
    const idle = Date.now() - lastActivity;
    if (utteranceEnded && idle > 900) shutdown(true); // Deepgram said end-of-speech → flush
    else if (spoken && idle > 6000) shutdown(true); // long quiet after speech → flush
    else if (!spoken && age > 15000) shutdown(false); // never heard anything
    else if (age > 120000) shutdown(true); // hard cap
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
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
  const Ctx = window.AudioContext || w.webkitAudioContext;
  if (!Ctx) {
    hooks.onState?.('error', 'Audio is not supported here.');
    return;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    hooks.onState?.('error', 'Microphone access blocked — allow the mic for this site.');
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
    if (spoken && Date.now() - lastSpeech > 1500) stopRec(true);
    else if (!spoken && age > 15000) stopRec(false);
    else if (age > 60000) stopRec(true);
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
