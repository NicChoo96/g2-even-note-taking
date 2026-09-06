#!/usr/bin/env node
// Dictation watchdog simulator — sanity-check the silence-based auto-stop
// thresholds in glasses/src/dictate.ts.
//
// WHY THIS ISN'T THE GLASSES SIMULATOR:
//   The EvenHub glasses simulator does NOT implement audioControl (no mic
//   capture), and the relay -> Deepgram leg is unreachable from this sandbox.
//   So a full end-to-end "press Dictate, talk, watch it not stop" sim is not
//   possible here. What we CAN verify faithfully is the actual KILL DECISION:
//   replay a real 16 kHz s16le mono WAV through the EXACT watchdog predicates
//   + RMS speech rule each engine uses (copied verbatim from dictate.ts) in
//   virtual time, and prove the session survives a LONG CONTINUOUS TALK and
//   only ends on a genuine trailing silence.
//
// Usage:
//   node tools/dictate-watchdog-sim.mjs                 # synthetic continuous talk
//   node tools/dictate-watchdog-sim.mjs path/to.wav     # any 16k mono s16le wav
//
// The synthetic talk is generated to have natural 0.3-2.0 s pauses between
// phrases (worst case << the 3.5 s thresholds) over ~90 s, plus an 8 s
// trailing silence that SHOULD end the session.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Constants mirrored EXACTLY from glasses/src/dictate.ts ─────────────────
const SR = 16000; // samples/sec, 16k s16le mono
const FRAME_MS = 100; // Even Hub audioEvent frame cadence (approx)
const FRAME = (SR * FRAME_MS) / 1000; // 1600 samples per frame
const TICK_MS = 250; // all engines' setInterval period

// Speech / silence energy rules (dictate.ts):
//   startBridge  onAudio:  rms(pcm) > 700          → spoken
//   startMedia   analyser: float rms > 0.02 (≈655 in s16 units)
//   (live/webspeech track Deepgram RESULTS instead, see model below)
const BATCH_RMS = 700;
const MEDIA_RMS = Math.floor(0.02 * 32768); // 655
const LIVE_SPEECH_RMS = 300; // Deepgram "has speech" floor (emits results)

// Auto-stop quiet thresholds (dictate.ts):
//   live stream (startBridgeStream) + webspeech (startWebSpeech): 5 s
//   batch (startBridge) + media (startMedia):                      5 s  (all unified)
const LIVE_QUIET_MS = 5000;
const BATCH_QUIET_MS = 5000;

// ── Tiny WAV parser (16-bit PCM; resample handled outside) ────────────────
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(p + 8),
        channels: buf.readUInt16LE(p + 10),
        sampleRate: buf.readUInt32LE(p + 12),
        bits: buf.readUInt16LE(p + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(p + 8, p + 8 + sz);
    }
    p += 8 + sz + (sz % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  if (fmt.audioFormat !== 1 || fmt.channels !== 1 || fmt.bits !== 16) {
    throw new Error(`expected 16-bit mono PCM, got fmt=${JSON.stringify(fmt)}`);
  }
  if (fmt.sampleRate !== SR) {
    throw new Error(`expected sample rate ${SR}, got ${fmt.sampleRate} — convert first (ffmpeg -i in -ar 16000 -ac 1 -sample_fmt s16 out.wav)`);
  }
  const out = new Int16Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2);
  return out;
}

function rms(frame) {
  // s16le RMS, identical math to dictate.ts rms().
  let sum = 0;
  let n = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]; // already signed
    sum += s * s;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

// ── Engine-state machines (predicates copied from dictate.ts) ─────────────
// Each is fed a per-100ms frame and stepped every 250ms. Returns 'end-commit'
// when it would call finish/shutdown/settle(true) — i.e. auto-stop.

function makeBatchEngine(kind, quietMs) {
  // kind 'batch' (rms>700) or 'media' (rms>655). Tracks lastSpeech; ends when
  // spoken && now-lastSpeech > quietMs.  (mirrors startBridge/startMedia watchdog)
  const threshold = kind === 'batch' ? BATCH_RMS : MEDIA_RMS;
  let spoken = false;
  let lastSpeech = 0;
  let tickCount = 0;
  return {
    name: kind,
    quietMs,
    feed(now, r) {
      if (r > threshold) {
        spoken = true;
        lastSpeech = now;
      }
      tickCount++;
      if (tickCount % Math.ceil(FRAME_MS / TICK_MS) === 0) {
        // evaluate every 250ms (2-3 frames) like the real setInterval
        const age = now;
        if (spoken && now - lastSpeech > quietMs) return 'end-commit';
        if (!spoken && age > 20000) return 'end-abort';
        if (age > 180000) return 'end-commit';
      }
      return null;
    },
  };
}

function makeLiveEngine(quietMs) {
  // LIVE + Web Speech model: while speech energy is present, Deepgram/the API
  // emits interim Results that refresh "lastActivity". At the end of a phrase
  // (energy dips below the speech floor) it emits a final and then goes quiet.
  // Watchdog ends when spoken && now-lastActivity > quietMs (startBridgeStream /
  // startWebSpeech), which means "no new speech result for quietMs".
  let wasVoiced = false;
  let phraseEnd = 0; // time the last phrase's final result arrived
  let lastActivity = 0;
  let spoken = false;
  return {
    name: 'live+webspeech',
    quietMs,
    feed(now, r) {
      const voiced = r > LIVE_SPEECH_RMS;
      if (voiced) {
        // Deepgram streams interims during speech → refreshes lastActivity
        if (!wasVoiced) spoken = true; // first voiced frame counts as speech
        lastActivity = now;
        // Deepgram finalizes ~150 ms after speech energy stops; approximate by
        // stamping phrase end as the last voiced moment (seen on the transition).
      } else if (wasVoiced) {
        phraseEnd = now; // speech just ended → a final is in flight
        lastActivity = now;
      }
      wasVoiced = voiced;
      if (spoken && now - lastActivity > quietMs) return 'end-commit';
      if (!spoken && now > 20000) return 'end-abort';
      if (now > 180000) return 'end-commit';
      return null;
    },
  };
}

// ── Synthetic continuous-talk generator ────────────────────────────────────
// Deterministic. Produces ~TALK_S of speech-like energy (modulated noise with
// natural 0.3-2.0 s pauses) then an 8 s trailing silence.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthTalk(TALK_S = 90) {
  const rnd = mulberry32(0x5eed);
  const total = (TALK_S + 8) * SR; // + 8 s trailing silence
  const out = new Int16Array(total);
  // per-100ms frame plan
  let t = 0.3; // small lead-in silence (seconds)
  const frames = [];
  while (t < TALK_S) {
    const dur = 2 + rnd() * 4; // phrase 2-6 s
    frames.push({ t, dur, voiced: true });
    t += dur;
    if (t >= TALK_S) break;
    const pause = 0.3 + rnd() * 1.7; // 0.3-2.0 s
    frames.push({ t, dur: pause, voiced: false });
    t += pause;
  }
  for (const f of frames) {
    const start = Math.floor(f.t * SR);
    const len = Math.floor(f.dur * SR);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= out.length) break;
      if (!f.voiced) {
        out[idx] = Math.floor((rnd() - 0.5) * 60); // near-silent floor
        continue;
      }
      // speech-like: amplitude-modulated noise + weak tone
      const tt = i / SR;
      const env =
        0.55 +
        0.45 * Math.sin(2 * Math.PI * 3.5 * tt + rnd() * 6) +
        0.2 * Math.sin(2 * Math.PI * 9 * tt);
      const amp = 0.15 + 0.85 * rnd(); // 800..~6500 RMS-ish
      out[idx] = Math.max(-32768, Math.min(32767, Math.floor((rnd() * 2 - 1) * amp * env * 22000)));
    }
  }
  return out;
}

// ── Runner ─────────────────────────────────────────────────────────────────
function runScenario(name, pcm) {
  const quiet = { batch: BATCH_QUIET_MS, media: BATCH_QUIET_MS, live: LIVE_QUIET_MS };
  const engs = { batch: makeBatchEngine('batch', quiet.batch), media: makeBatchEngine('media', quiet.media), live: makeLiveEngine(quiet.live) };

  const nFrames = Math.floor(pcm.length / FRAME);
  let maxQuietInTalk = 0;
  let inTalk = true;

  // Pre-scan: max silence gap while energy could still be speech (before the
  // final 8 s trailing silence).
  let lastVoicedFrame = -1;
  const voicedFrames = [];
  for (let i = 0; i < nFrames; i++) {
    const f = pcm.subarray(i * FRAME, (i + 1) * FRAME);
    if (rms(f) > LIVE_SPEECH_RMS) voicedFrames.push(i);
  }
  for (let k = 1; k < voicedFrames.length; k++) {
    const gap = (voicedFrames[k] - voicedFrames[k - 1]) * FRAME_MS;
    if (gap > maxQuietInTalk) maxQuietInTalk = gap;
  }
  const lastVoicedMs = (voicedFrames[voicedFrames.length - 1] ?? 0) * FRAME_MS;
  const talkEndsAtMs = lastVoicedMs; // trailing silence begins after last voiced frame

  const ends = {};
  for (let i = 0; i < nFrames; i++) {
    const now = i * FRAME_MS;
    if (inTalk && now > talkEndsAtMs + 1000) inTalk = false; // past trailing-silence onset
    const f = pcm.subarray(i * FRAME, (i + 1) * FRAME);
    const r = rms(f);
    for (const key of Object.keys(engs)) {
      const v = engs[key].feed(now, r);
      if (v) {
        ends[key] = { atMs: now, duringTalk: inTalk, verdict: v };
      }
    }
  }

  console.log(`\n=== ${name} ===`);
  console.log(`  duration            : ${(pcm.length / SR).toFixed(1)} s (${pcm.length} samples)`);
  console.log(`  last voiced @       : ${(talkEndsAtMs / 1000).toFixed(1)} s`);
  console.log(`  trailing silence    : ${((pcm.length / SR) * 1000 - talkEndsAtMs) / 1000} s`);
  console.log(`  max quiet gap mid-talk (frame-to-frame): ${(maxQuietInTalk / 1000).toFixed(2)} s`);

  let allOk = true;
  for (const key of Object.keys(engs)) {
    const eng = engs[key];
    const e = ends[key];
    const trailing = (pcm.length / SR) * 1000 - talkEndsAtMs; // silence after last voiced
    if (!e) {
      if (trailing >= eng.quietMs) {
        console.log(`  [${eng.name}]  ✗ should have ended on ${(trailing / 1000).toFixed(1)} s trailing silence but NEVER ended`);
        allOk = false;
      } else {
        console.log(`  [${eng.name}]  ✓ survived whole file (no end needed — trailing silence ${(trailing / 1000).toFixed(1)} s < ${(eng.quietMs / 1000).toFixed(1)} s threshold)`);
      }
      continue;
    }
    if (e.duringTalk) {
      console.log(`  [${eng.name}]  ✗ KILLED ITSELF mid-talk at ${(e.atMs / 1000).toFixed(1)} s  (${e.verdict})`);
      allOk = false;
    } else {
      console.log(`  [${eng.name}]  ✓ survived full talk; ended only on silence at ${(e.atMs / 1000).toFixed(1)} s  (${e.verdict})`);
    }
  }
  return allOk;
}

// ── main ───────────────────────────────────────────────────────────────────
const wavPath = process.argv[2];
let pcm;
if (wavPath) {
  pcm = parseWav(readFileSync(wavPath));
} else {
  pcm = synthTalk(90);
  const out = join(dirname(fileURLToPath(import.meta.url)), 'continuous-talk.wav');
  writeFileSync(out, wavToBuffer(pcm));
  console.log(`Generated synthetic continuous talk → ${out}`);
}

function wavToBuffer(pcm) {
  const len = pcm.length * 2;
  const b = Buffer.alloc(44 + len);
  b.write('RIFF', 0); b.writeUInt32LE(36 + len, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(len, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2);
  return b;
}

const ok = runScenario(
  wavPath ? `real file: ${wavPath}` : 'SYNTHETIC continuous talk (pauses 0.3–2.0 s)',
  pcm,
);
console.log(`\nRESULT: ${ok ? 'PASS — no engine killed a continuous long talk' : 'FAIL — an engine auto-stopped mid-talk'}`);
process.exit(ok ? 0 : 1);
