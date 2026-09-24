#!/usr/bin/env node
// SIGN-IN page harness — the pairing code on the lens.
//
// WHY THIS EXISTS:
//   A pairing code is meant to be read off the GLASSES and typed into a browser
//   that is already signed in as the owner. The phone that also prints it is, at
//   that moment, the thing in your pocket. So the code has to be legible on the
//   lens — and the lens is the one surface where "just add a line" is not free.
//
//   The 288px canvas holds exactly ten 27px lines, and the sign-in page already
//   used all ten (three of them blank). Appending a code line took it to twelve.
//   One line past the screen the firmware SCROLLS the text container instead of
//   leaving it alone, and a scrolling container swallows the ring's swipe — so the
//   fix was to SPEND the two lines that used to read "Pairing is only for a device
//   / that cannot sign in." on the offer and the code rather than add to them. The
//   page gained the code and stayed exactly the same height.
//
//   What must not regress:
//     1. The two builds are the SAME HEIGHT. That is the entire design, and the
//        twelve-line page above is the bug this harness was born from.
//     2. Neither build exceeds the canvas, in lines or in bytes (999 UTF-8).
//     3. No single line exceeds the container's inner width, or the firmware wraps
//        it and every count above silently becomes wrong.
//     4. A pending code never REPLACES the sign-in instruction. Pairing is the
//        fallback; signing in is the normal path on every surface including the
//        Even App WebView, and the wearer of a device that CAN sign in must not be
//        steered off it.
//     5. Clearing the code restores the sign-in page byte for byte, and a code that
//        was never fetched cannot be invited.
//
//   The canvas limits are READ OUT OF sections.ts rather than hard-coded, so this
//   harness and the renderer cannot drift apart: move a limit and the harness
//   follows it, change the page and the harness catches it.
//
// Run: node tools/signin-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// SIM_QUIET=1 prints only failures and the verdict.
const QUIET = !!process.env.SIM_QUIET;
let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  if (ok && QUIET) return;
  if (ok) console.log(`PASS  ${label}`);
  else
    console.log(
      `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`,
    );
}

function checkTrue(label, got) {
  const ok = got === true;
  if (ok) pass++;
  else fail++;
  if (ok && QUIET) return;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label} (got ${JSON.stringify(got)})`);
}

// ── The canvas limits, taken from the source that enforces them ─────────────
const src = readFileSync(resolve(here, '../src/sections.ts'), 'utf8');
const num = (name) => {
  const m = src.match(new RegExp(`const ${name} = (\\d+)`));
  return m ? Number(m[1]) : null;
};
const INNER_W = num('INNER_W');
const AI_SCREEN_LINES = num('AI_SCREEN_LINES');

// ── Bundle the REAL modules ─────────────────────────────────────────────────
// One bundle, so the sign-in page and the pub/sub that feeds it are the very
// objects the app ships, not re-implementations of them.
const out = mkdtempSync(join(tmpdir(), 'signin-sim-'));
const stub = join(out, 'sdk-stub.mjs');
writeFileSync(
  stub,
  `export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }
export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }
export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }
export const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
`,
);

const outfile = join(out, 'signin.mjs');
await build({
  stdin: {
    contents: `
export { signInView, MAX_CONTENT_BYTES } from './sections.ts';
export { setPairCode, getPairCode, onPairCode } from './pair-code.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '@evenrealities/even_hub_sdk': stub },
  define: { 'import.meta.env': '{}' },
});

// ── Fake host: localStorage + timers before any module loads ────────────────
globalThis.window = globalThis; // store.ts publishes through window.setTimeout
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });

const { signInView, MAX_CONTENT_BYTES, setPairCode, getPairCode, onPairCode } = await import(
  pathToFileURL(outfile).href
);
const { measureTextWrap } = await import('@evenrealities/pretext');

// ── The canvas these numbers are measured against ───────────────────────────
check('canvas inner width is the 568 this layout was measured at', INNER_W, 568);
check('the canvas fits exactly ten 27px lines', AI_SCREEN_LINES, 10);
check('the byte cap the caller clips to is 999', MAX_CONTENT_BYTES, 999);

function measure(text) {
  const r = measureTextWrap(text, INNER_W);
  return {
    lines: r.lineCount,
    height: r.height,
    widest: Math.max(...r.lineWidths),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

// ── The two builds ──────────────────────────────────────────────────────────
const plain = signInView(null);
const pending = signInView('ABC234');
const plainM = measure(plain);
const pendingM = measure(pending);

console.log(
  `\n          lines  height  widest  bytes\n` +
    `no code     ${String(plainM.lines).padStart(2)}   ${String(plainM.height).padStart(4)}   ${String(plainM.widest).padStart(5)}  ${String(plainM.bytes).padStart(5)}\n` +
    `pending     ${String(pendingM.lines).padStart(2)}   ${String(pendingM.height).padStart(4)}   ${String(pendingM.widest).padStart(5)}  ${String(pendingM.bytes).padStart(5)}\n`,
);

// ── 1+2+3. The page fits, in both builds, and does not change height ────────
checkTrue('no code: fits the canvas', plainM.height <= 288);
checkTrue('no code: no line overflows the inner width', plainM.widest <= INNER_W);
checkTrue('no code: under the byte cap', plainM.bytes < MAX_CONTENT_BYTES);

check('*** WITH a pending code: the line count did not change ***', pendingM.lines, plainM.lines);
check('with a code: still exactly the canvas, no scrolling', pendingM.lines, AI_SCREEN_LINES);
check('with a code: the height did not move by a single line', pendingM.height, plainM.height);
checkTrue('with a code: fits the canvas', pendingM.height <= 288);
checkTrue('with a code: no line overflows the inner width', pendingM.widest <= INNER_W);
checkTrue('with a code: under the byte cap', pendingM.bytes < MAX_CONTENT_BYTES);

// ── 4. The code is an offer, never a replacement ────────────────────────────
checkTrue('with a code: the code is on the page', pending.includes('ABC 234'));
checkTrue(
  'with a code: the wearer is still told to sign in with Google',
  pending.includes('Sign in to start') && pending.includes('Google account'),
);
checkTrue('with a code: it reads as the alternative', pending.includes('Or pair this device:'));
checkTrue(
  'no code: does not invite a code it cannot show',
  !plain.includes('Or pair this device') && !plain.includes('ABC'),
);
checkTrue(
  'no code: the offer is still explained',
  plain.includes('Pairing is only for a device'),
);

// ── 5. The wire between the auth UI and the renderer ────────────────────────
const seen = [];
const off = onPairCode((c) => seen.push(c));
check('a subscriber fires immediately with the current value', seen, [null]);

setPairCode('abc234');
check('the code is normalised to uppercase', getPairCode(), 'ABC234');
check('the subscriber was told', seen, [null, 'ABC234']);
checkTrue('the live code reaches the page', signInView(getPairCode()).includes('ABC 234'));

setPairCode('abc234');
check('setting the same value notifies nobody again', seen.length, 2);

setPairCode('ab-c 2_34');
check('separators are stripped', getPairCode(), 'ABC234');

setPairCode(null);
check('clearing it notifies', seen, [null, 'ABC234', null]);
check('clearing it restores the page byte for byte', signInView(getPairCode()), plain);
check(
  'clearing it leaves no code behind',
  /ABC|234/.test(signInView(getPairCode())),
  false,
);

setPairCode(null);
check('clearing twice is silent', seen.length, 3);

off();
setPairCode('ZZZ999');
check('an unsubscribed listener hears nothing', seen, [null, 'ABC234', null]);
check('but the value still changed', getPairCode(), 'ZZZ999');
setPairCode(null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
