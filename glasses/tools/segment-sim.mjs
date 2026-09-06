#!/usr/bin/env node
// Phrase-segmentation simulator for the new continuous streaming engine in
// glasses/src/dictate.ts (startBridge). Replays a 16k s16le mono WAV through
// the SAME VAD/phrase/watchdog rules (verbatim constants) in virtual time and
// reports how speech is cut into phrases + when the session would auto-stop.
// Goal: phrases land on real pauses (not mid-word), and the session never ends
// during continuous talk — only after a genuine ~5s silence.
//
// Usage: node tools/segment-sim.mjs path/to-16k-mono.wav

import { readFileSync } from 'node:fs';

const SR = 16000;
const FRAME_MS = 100;
const FRAME = (SR * FRAME_MS) / 1000;

// Engine constants (mirror dictate.ts startBridge)
const PHRASE_END_MS = 900;
const MIN_VOICED_MS = 250;
const VAD_RMS = 700;
const STOP_QUIET_MS = 5000;

function parseWav(buf) {
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
    } else if (id === 'data') data = buf.subarray(p + 8, p + 8 + sz);
    p += 8 + sz + (sz % 2);
  }
  if (fmt.channels !== 1 || fmt.bits !== 16 || fmt.sampleRate !== SR) {
    throw new Error('need 16k mono s16 wav');
  }
  const out = new Int16Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2);
  return out;
}

function rms(frame) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i];
    sum += s * s;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

const pcm = parseWav(readFileSync(process.argv[2]));
const nFrames = Math.floor(pcm.length / FRAME);

let anySpeech = false;
let lastVoicedAt = 0;
const phraseStarts = []; // [voicedMs, startMs, endMs]
let phraseVoicedMs = 0;
let phraseQuietMs = 0;
let phraseStartMs = -1;
let prevVoiced = false;
let lastFrameAt = 0;

for (let i = 0; i < nFrames; i++) {
  const now = i * FRAME_MS;
  const dt = lastFrameAt ? Math.min(1000, Math.max(10, now - lastFrameAt)) : 0;
  lastFrameAt = now;
  const f = pcm.subarray(i * FRAME, (i + 1) * FRAME);
  const voiced = rms(f) > VAD_RMS;
  if (voiced) {
    anySpeech = true;
    lastVoicedAt = now;
    phraseQuietMs = 0;
    if (!prevVoiced) {
      phraseStartMs = now; // (first voiced frame of a phrase)
      phraseVoicedMs = 0;
    }
    phraseVoicedMs += dt;
  } else if (prevVoiced) {
    // quiet after speech: start the trailing window
    phraseQuietMs = dt;
  } else if (phraseQuietMs > 0) {
    phraseQuietMs += dt;
  }
  if (prevVoiced && !voiced && phraseVoicedMs >= MIN_VOICED_MS && phraseStartMs >= 0) {
    phraseStarts.push({ voicedMs: Math.round(phraseVoicedMs), from: phraseStartMs, to: now });
    phraseStartMs = -1;
  } else if (phraseQuietMs >= PHRASE_END_MS && phraseStartMs >= 0) {
    phraseStarts.push({ voicedMs: Math.round(phraseVoicedMs), from: phraseStartMs, to: now });
    phraseStartMs = -1;
  }
  prevVoiced = voiced;
}
// trailing phrase
if (phraseStartMs >= 0 && phraseVoicedMs >= MIN_VOICED_MS) {
  phraseStarts.push({ voicedMs: Math.round(phraseVoicedMs), from: phraseStartMs, to: nFrames * FRAME_MS });
}

// Simulate the 5s auto-stop over the timeline (voiced gaps only)
let autoStopAt = -1;
let lastV = 0;
for (let i = 0; i < nFrames; i++) {
  const f = pcm.subarray(i * FRAME, (i + 1) * FRAME);
  if (rms(f) > VAD_RMS) lastV = i * FRAME_MS;
  if (anySpeech && lastV && i * FRAME_MS - lastV > STOP_QUIET_MS) {
    autoStopAt = i * FRAME_MS;
    break;
  }
}

const durS = (pcm.length / SR).toFixed(1);
console.log(`file: ${(pcm.length / SR).toFixed(1)}s`);
console.log(`phrases: ${phraseStarts.length}`);
if (phraseStarts.length) {
  const minV = Math.min(...phraseStarts.map((p) => p.voicedMs));
  const maxV = Math.max(...phraseStarts.map((p) => p.voicedMs));
  console.log(`  voiced range: ${minV}ms – ${maxV}ms per phrase`);
}
console.log(`auto-stop (5s no speech) would fire at: ${autoStopAt >= 0 ? (autoStopAt / 1000).toFixed(1) + 's' : 'never'}`);
const tooShort = phraseStarts.filter((p) => p.voicedMs < 350);
console.log(tooShort.length ? `⚠ ${tooShort.length} phrase(s) with voiced <350ms (may be word-fragments)` : '✓ no word-fragment phrases (<350ms voiced)');
const midTalk = autoStopAt >= 0 && autoStopAt < (nFrames * FRAME_MS - 4000);
console.log(midTalk ? '⚠ session would auto-stop BEFORE the file ends' : '✓ session survives to the end (or ends only on a real trailing silence)');
