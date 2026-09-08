#!/usr/bin/env node
// Regression harness for the v0.3.13 dictation self-stop fix.
// Run: node tools/dictate-selfstop-sim.mjs
//
// Two independent bugs made dictation "stop after ~2 seconds" in the
// contextual menu. This harness pins both of them down with source-level
// assertions so they cannot silently come back.
//
// BUG 1 (glasses/src/main.ts, event router)
//   `const sysType = event.sysEvent?.eventType ?? 0;`
//   `OsEventTypeList.CLICK_EVENT === 0`, so ANY event without a sysEvent was
//   coerced into a CLICK. While dictating, the SDK emits a PCM frame every
//   ~100 ms as `{ audioEvent: { audioPcm } }` with NO sysEvent -> onTap() ran
//   ~10x/s. onTap() ignores taps during the 1200 ms grace window, so the mic
//   survived ~1.2-1.7 s and then stopped: the "self-stop after 2 seconds".
//   FIX: only a real `sysEvent` may drive input; a tap is a sysEvent whose
//   `eventType` is undefined (documented), so `?? CLICK_EVENT` is applied
//   INSIDE a real sysEvent, never to the whole event.
//
// BUG 2 (glasses/src/dictate.ts)
//   An STT round-trip timeout of 8 s plus `consecErr >= 3` ending the session
//   meant three slow/aborted Deepgram calls killed dictation outright.
//   FIX: 15 s timeout (>= the requested 10 s debounce), 8 consecutive errors
//   before giving up, and only when nothing was ever transcribed.
//
// The EvenHub simulator cannot drive the real mic or reach Deepgram, so this
// harness verifies the SOURCE invariants that encode the fix, plus a faithful
// replay of the router decision table.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');
const dictateSrc = readFileSync(join(here, '..', 'src', 'dictate.ts'), 'utf8');

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const num = (src, name) => {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};

// ── OsEventTypeList values (SDK 0.0.14) ────────────────────────────────────
const CLICK = 0;
const DOUBLE_CLICK = 3;
const FOREGROUND_ENTER = 4;
const FOREGROUND_EXIT = 5;

// ── BUG 1: the router must never coerce a missing sysEvent into a tap ──────
console.log('\n== router: audio frames must not be read as taps ==');
assert(
  'no `event.sysEvent?.eventType ?? 0` remains in main.ts',
  !/event\.sysEvent\?\.eventType\s*\?\?\s*0/.test(mainSrc),
);
assert(
  'router guards on sysEvent presence (`if (!sys)` / `if (!event.sysEvent)`)',
  /const sys = event\.sysEvent;[\s\S]{0,80}if \(!sys\) return;/.test(mainSrc) ||
    /if \(!event\.sysEvent\) return;/.test(mainSrc),
);
assert(
  '`?? CLICK_EVENT` is applied to sys.eventType (tap arrives with no eventType)',
  /sys\.eventType \?\? OsEventTypeList\.CLICK_EVENT/.test(mainSrc) ||
    /event\.sysEvent\.eventType \?\? OsEventTypeList\.CLICK_EVENT/.test(mainSrc),
);
assert(
  'the sysEvent guard runs BEFORE the CLICK check (no handler can see a stray event)',
  /if \(!sys\) return;[\s\S]{0,400}=== OsEventTypeList\.CLICK_EVENT/.test(mainSrc),
);
assert(
  'main.ts never treats audioEvent as input (audio is owned by dictate.ts)',
  !/event\.audioEvent/.test(mainSrc),
);

// Replay the EXACT decision table the router implements, for the payloads the
// SDK really sends, and assert which of them may call onTap().
const routeOf = (ev) => {
  const sys = ev.sysEvent;
  if (!sys) return 'ignored'; // FIX: was 'tap' via `?? 0`
  const t = sys.eventType ?? CLICK; // tap = sysEvent with undefined eventType
  if (t === CLICK) return 'tap';
  if (t === DOUBLE_CLICK) return 'double';
  if (t === FOREGROUND_ENTER) return 'foreground';
  return 'ignored';
};
const cases = [
  ['audio frame (dictation)', { audioEvent: { audioPcm: new Uint8Array(4) } }, 'ignored'],
  ['list item click', { listEvent: { currentSelectItemIndex: 2 } }, 'ignored'],
  ['menu item click', { menuItemClickEvent: { itemID: 9 } }, 'ignored'],
  ['text scroll', { textEvent: { eventType: 2 } }, 'ignored'],
  ['real tap (sysEvent, no eventType)', { sysEvent: { eventSource: 1 } }, 'tap'],
  ['real tap (sysEvent, eventType 0)', { sysEvent: { eventType: 0 } }, 'tap'],
  ['double click', { sysEvent: { eventType: 3 } }, 'double'],
  ['foreground enter', { sysEvent: { eventType: 4 } }, 'foreground'],
  ['foreground exit', { sysEvent: { eventType: 5 } }, 'ignored'],
];
for (const [label, ev, want] of cases) {
  const got = routeOf(ev);
  assert(`route: ${label} -> ${want}`, got === want, got === want ? '' : `got ${got}`);
}

// ── BUG 2: STT debounce + non-fatal errors ────────────────────────────────
console.log('\n== dictate engine: >=10s debounce, non-fatal STT errors ==');
const sttTimeout = num(dictateSrc, 'STT_TIMEOUT_MS');
const stopFlush = num(dictateSrc, 'STOP_FLUSH_MS');
const maxErr = num(dictateSrc, 'MAX_CONSEC_ERR');
assert('STT_TIMEOUT_MS is >= 10000 (requested debounce)', sttTimeout >= 10000, `= ${sttTimeout}`);
assert('STT_TIMEOUT_MS is <= 30000 (still bounds a wedged server)', sttTimeout <= 30000, `= ${sttTimeout}`);
assert('STOP_FLUSH_MS >= STT_TIMEOUT_MS (last phrase can still land)', stopFlush >= sttTimeout, `= ${stopFlush}`);
assert('MAX_CONSEC_ERR is > 3 (was the old fatal threshold)', maxErr > 3, `= ${maxErr}`);
assert(
  'STT errors give up only after MAX_CONSEC_ERR AND nothing transcribed',
  /consecErr >= MAX_CONSEC_ERR && transcript\.length === 0/.test(dictateSrc),
);
assert(
  'no `consecErr >= 3` fatal path remains',
  !/consecErr >= 3\b/.test(dictateSrc),
);
assert(
  'mic frame-stall reopen waits > 2s (closing the mic costs audio)',
  /lastFrameAt > 4000/.test(dictateSrc),
);

// Simulate the error policy: transient failures must NOT end the session.
const sessionEnds = (errors, transcriptLen) => errors >= maxErr && transcriptLen === 0;
assert('3 consecutive STT failures do NOT end the session', !sessionEnds(3, 0));
assert('7 consecutive STT failures do NOT end the session', !sessionEnds(7, 0));
assert('8 consecutive failures with nothing transcribed DOES end it', sessionEnds(maxErr, 0));
assert('8 consecutive failures WITH a transcript does NOT end it', !sessionEnds(maxErr, 40));

// ── main.ts stop backstop must outlast the engine's own flush budget ───────
console.log('\n== main.ts: forced-end backstop outlasts the engine flush ==');
const backstop = num(mainSrc, 'DICTATION_STOP_BACKSTOP_MS') ?? (() => {
  const m = mainSrc.match(/now - dictationStopAt > (\d+)/);
  return m ? Number(m[1]) : null;
})();
assert('stop backstop exists', backstop !== null, `= ${backstop}`);
assert('stop backstop > STOP_FLUSH_MS (never drops the final phrase)', backstop > stopFlush, `${backstop} > ${stopFlush}`);

// ── tap-to-stop must still work while dictating ───────────────────────────
console.log('\n== tap-to-stop still functional ==');
assert(
  'onTap() stops an active dictation',
  /if \(dictationActive\) \{[\s\S]{0,600}void stopDictation\(\)/.test(mainSrc),
);
assert(
  'onTap() ignores taps inside the start grace window',
  /Date\.now\(\) < dictationStopAfter\) return/.test(mainSrc),
);

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);
