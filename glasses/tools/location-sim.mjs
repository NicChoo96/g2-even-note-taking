#!/usr/bin/env node
// Location harness — the two hosts, the honesty rule, and the split trip.
//
// WHY THIS EXISTS:
//   `location` is the only agent tool whose data the RELAY cannot fetch. A fix
//   lives in the phone; a run executes server-side with no client round trip
//   mid-run, so the client resolves a position when the run is TRIGGERED and
//   sends it along, and the server tool reads that snapshot. Two halves, one
//   kind — and every way of getting it wrong is invisible:
//
//     • a host that REFUSED being papered over with a remembered fix, so the
//       wearer refuses once and keeps getting positions;
//     • a remember-then-serve that lets a coordinate from ten minutes ago be
//       presented as where the wearer is standing now;
//     • a snapshot read for an agent that has no location tool, which pops a
//       browser permission prompt for a question nobody asked;
//     • the snapshot being stored ON the run, which would serialize the wearer's
//       position to every client and into durable storage, outliving the one
//       tool call that needed it;
//     • a location tool reaching the relay's generic-REST fallback, where it is
//       told "tool url must be https://" — a description of a tool it is not.
//
//   So this drives both hosts with stubbed transports, asserts that a missing
//   fix is REFUSED rather than invented on both sides of the wire, and checks
//   the wiring (schema branch, dispatch branch, call sites, permission, parity
//   between the client's ToolKind set and the kinds the relay can execute) by
//   slicing the region that owns the behaviour rather than by a loose regex over
//   a whole file.
//
// Run: node tools/location-sim.mjs

import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  LOCATION_KIND as RELAY_LOCATION_KIND,
  LOCATION_TOOL_NAMES,
  NO_FIX_TEXT,
  formatAge,
  formatFix,
  isLocationTool,
  locationToolSchema,
  locationToolSummary,
  normalizeSnapshot,
  runLocationTool,
} from '../../web/server/location-tool.mjs';
import { HUB_TOOL_KINDS } from '../../web/server/hub-tools.mjs';

let fail = 0;
let total = 0;
const assert = (label, cond, detail = '') => {
  total++;
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  assert(
    label,
    got === want,
    got === want ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
const deepEq = (label, got, want) => eq(label, JSON.stringify(got), JSON.stringify(want));
const has = (label, haystack, needle) => {
  const found = String(haystack).includes(needle);
  return assert(label, found, found ? '' : `\n      missing: ${needle}`);
};
const unset = (label, haystack, needle) => {
  const found = String(haystack).includes(needle);
  return assert(label, !found, found ? `\n      unexpected: ${needle}` : '');
};

/**
 * The source of ONE top-level function.
 *
 * Slicing matters: a loose regex over the whole file also matches the comments
 * that DESCRIBE a rule, and this file's own comments name every string being
 * asserted. `export ` is optional because nearly every function in `src/` is
 * exported, and without it the search for the NEXT function finds nothing and the
 * "slice" silently runs to the end of the file.
 */
const fnSource = (src, name) => {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return '';
  const next = src.slice(start + 1).search(/\n(?:export )?(?:async )?function \w+/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
};

/** One route handler: from its marker to the next `url.pathname ===` test. */
const routeSource = (src, marker) => {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const next = src.indexOf('url.pathname ===', at + marker.length);
  return next < 0 ? src.slice(at) : src.slice(at, next);
};

/**
 * Pull a `words: /…/i` literal out of a seed block and rebuild the RegExp, so the
 * vocabulary can be TESTED against phrases instead of pattern-matched as source.
 */
const wordsOf = (src, from, to) => {
  const seg = src.slice(src.indexOf(from), src.indexOf(to));
  const m = /words:\s*(\/[\s\S]*?\/[a-z]*)/.exec(seg);
  if (!m) return null;
  const last = m[1].lastIndexOf('/');
  return new RegExp(m[1].slice(1, last), m[1].slice(last + 1));
};

const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');

const relaySrc = read('../../web/server/local-sse.mjs');
const typesSrc = read('../src/types.ts');
const seedSrc = read('../src/ai/capabilities/agents.ts');
const streamSrc = read('../src/stream.ts');
const appJson = JSON.parse(read('../app.json'));

// ── the fake host ───────────────────────────────────────────────────────────
//
// The modules being driven touch window/localStorage at import time, and the SDK
// has to be aliased because they import it as a TYPE only — the alias keeps the
// test off the real package and proves no RUNTIME SDK import crept in.
globalThis.window = globalThis;
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const outDir = mkdtempSync(join(tmpdir(), 'location-sim-'));
const sdkStub = join(outDir, 'sdk-stub.mjs');
writeFileSync(
  sdkStub,
  `export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }
export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }
export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }
export const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
export const measureTextWrap = () => ({ lineCount: 1 });
`,
);
const uiBundle = join(outDir, 'location-ui.mjs');
await build({
  stdin: {
    contents: `
// The registration side effect and the helpers come from different modules on
// purpose: pages.ts is the file that REGISTERS the catalog.
import './ai/pages.ts';
export { capabilityByName, callAction, toToolSchema, toWireName } from './ai/registry.ts';
export { MAX_TOOLS, RESERVED, selectTools } from './ai/agent.ts';
export { emptyAgentsState, locationTool, LOCATION_TOOL_ID } from './types.ts';
export { GLOBAL_PAGE } from './ai/types.ts';
export { setDurableBridge } from './durable-docs.ts';
export * as spec from './location/spec.ts';
export * as source from './location/source.ts';
export * as runmod from './location/run.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'location-ui-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: uiBundle,
  alias: { '@evenrealities/even_hub_sdk': sdkStub },
  define: { 'import.meta.env': '{}' },
});
const ui = await import(pathToFileURL(uiBundle).href);

/** Point the app's bridge at a stub host. `null` = no bridge at all. */
const setBridge = (bridge) => ui.setDurableBridge(bridge);
/** A hub host that can, or cannot, answer. */
const host = (fn) => (fn ? { getAppLocation: fn } : {});
const coords = (over = {}) => ({ latitude: 51.5, longitude: -0.12, ...over });

/** Install a browser geolocation stub (Node's navigator may be a getter). */
let geoOpts = null;
const installGeo = (geo) => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', geolocation: geo },
    configurable: true,
    writable: true,
  });
};
const browserAnswers = ({ position, error }) =>
  installGeo({
    getCurrentPosition: (ok, bad, opts) => {
      geoOpts = opts;
      if (error) bad(error);
      else ok(position);
    },
  });
const noGeo = () => installGeo(undefined);
const position = (over = {}) => ({
  coords: { latitude: 51.5, longitude: -0.12, accuracy: 8, ...over },
  timestamp: 1700000000000,
});

// ── 1. the vocabulary ───────────────────────────────────────────────────────
console.log('\n§1  the fix vocabulary (spec.ts)');
const spec = ui.spec;
eq('the stale horizon is ten minutes', spec.STALE_AFTER_MS, 600000);
eq('latitude and longitude are the only required members', spec.normalizeFix({ latitude: 1, longitude: 2 }, 'hub', 7).latitude, 1);
eq('a fix with no coordinate pair is no fix', spec.normalizeFix({ accuracy: 5 }, 'hub', 7), null);
eq('a non-object is no fix', spec.normalizeFix('51.5,-0.12', 'hub', 7), null);
// Range, not truthiness. 0/0 is the Gulf of Guinea, not "no data".
const origin = spec.normalizeFix({ latitude: 0, longitude: 0 }, 'hub', 7);
eq('0/0 is believed as a real coordinate', origin?.latitude, 0);
eq('  ...on both axes', origin?.longitude, 0);
eq('a latitude past the pole is refused', spec.normalizeFix({ latitude: 90.5, longitude: 0 }, 'hub', 7), null);
eq('a longitude past the meridian is refused', spec.normalizeFix({ latitude: 0, longitude: 180.5 }, 'hub', 7), null);
eq('a numeric STRING is not a coordinate', spec.normalizeFix({ latitude: '51.5', longitude: 0 }, 'hub', 7), null);
eq('Infinity is not a coordinate', spec.normalizeFix({ latitude: Infinity, longitude: 0 }, 'hub', 7), null);
eq('NaN is not a coordinate', spec.normalizeFix({ latitude: NaN, longitude: 0 }, 'hub', 7), null);
// One bad optional must not spoil the rest of the fix.
const partial = spec.normalizeFix(
  { latitude: 1, longitude: 2, accuracy: -5, speed: -1, heading: 400, altitude: null },
  'hub',
  7,
);
eq('a negative accuracy is dropped', partial.accuracy, undefined);
eq('a negative speed is dropped', partial.speed, undefined);
eq('a heading past 360 is dropped', partial.heading, undefined);
eq('a null altitude is dropped, NOT read as sea level', partial.altitude, undefined);
eq('and the coordinates survive all of that', partial.latitude, 1);
eq('the source is carried through', partial.source, 'hub');
eq('the caller stamp is kept', partial.capturedAt, 7);
assert(
  'a malformed stamp degrades to now, not to NaN',
  Math.abs(spec.normalizeFix({ latitude: 1, longitude: 2 }, 'hub', NaN).capturedAt - Date.now()) < 5000,
);

const fix = (over = {}) => spec.normalizeFix({ latitude: 51.507351, longitude: -0.127758, accuracy: 4.5, ...over }, 'hub', 1000);
eq('age is never negative, so clock skew reads as now', spec.fixAgeMs(fix(), 0), 0);
eq('an old fix is not stale until the horizon', spec.isStale(fix(), 1000 + spec.STALE_AFTER_MS), false);
eq('  ...and is stale one ms later', spec.isStale(fix(), 1001 + spec.STALE_AFTER_MS), true);
assert('the remembered label says stale when it is', spec.ageNote(fix(), 1001 + spec.STALE_AFTER_MS).startsWith('stale,'));
assert('and says last known when it is not', spec.ageNote(fix(), 2000).startsWith('last known,'));
eq('five decimals is about a metre', spec.formatCoords(51.507351, -0.127758), '51.50735, -0.12776');
eq('accuracy under ten metres keeps its decimal', spec.formatAccuracy(4.5), '\u00b14.5 m');
eq('accuracy over ten metres is a whole number', spec.formatAccuracy(12.4), '\u00b112 m');
eq('no accuracy renders as nothing at all', spec.formatAccuracy(undefined), '');
eq('a negative accuracy renders as nothing', spec.formatAccuracy(-3), '');
has('the glasses line carries the coordinates', spec.fixLine(fix()), '51.50735');
has('  ...and the uncertainty when it is known', spec.fixLine(fix()), '\u00b14.5 m');
unset('  ...and omits it when it is not', spec.fixLine(fix({ accuracy: undefined })), '\u00b1');
eq('speed is metric for the wearer', spec.formatSpeed(2.5), '9.0 km/h');
eq('altitude reads as a sentence', spec.formatAltitude(-12), '-12 m above sea level');
eq('heading is degrees plus a compass point', spec.formatHeading(90), '90\u00b0 E');
eq('both routes read the PHONE, and say which software asked', spec.describeSource('hub'), 'the phone, via the Even Hub app');
eq('  ...the browser case names the browser', spec.describeSource('browser'), 'the browser');
deepEq('the accuracy hints are the SDK enum values verbatim', [...spec.ACCURACY_HINTS], ['low', 'medium', 'high']);
eq('and are matched case-sensitively, as the SDK sends them', spec.isAccuracyHint('HIGH'), false);

// ── 2. the two hosts ────────────────────────────────────────────────────────
console.log('\n§2  acquiring a fix (source.ts)');

// (a) a host that answers owns the answer.
let seen = null;
setBridge(host(async (opts) => {
  seen = opts;
  return coords({ accuracy: 6 });
}));
let attempt = await ui.source.getCurrentFix({ accuracy: 'high', timeoutMs: 50 });
eq('a hub fix is a hub fix', attempt.fix?.source, 'hub');
eq('a fresh read is not cached', attempt.cached, false);
eq('no reason is invented when there is a fix', attempt.reason, '');
eq('the accuracy hint is the plain SDK value (no SDK import needed)', seen.accuracy, 'high');
eq('a too-small timeout is clamped up to the floor', seen.timeoutMs, 1000);
await ui.source.getCurrentFix({ timeoutMs: 999999 });
eq('a huge timeout is clamped down to the ceiling', seen.timeoutMs, 30000);
await ui.source.getCurrentFix();
eq('the default timeout is 8s', seen.timeoutMs, 8000);

// (b) a host that answers null. The SDK documents three causes; all are "no fix".
setBridge(host(async () => null));
ui.source.forgetFix();
attempt = await ui.source.getCurrentFix();
eq('a null from the host is no fix', attempt.fix, null);
eq('  ...and is not labelled cached', attempt.cached, false);
has('  ...and the reason names the host, not the browser', attempt.reason, 'the Even Hub app did not return a location');
has('  ...and says what the wearer can do about it', attempt.reason, 'switched off');

// (c) a host REFUSAL is obeyed: no remembered fix, because the wearer just said no.
setBridge(host(async () => coords()));
await ui.source.getCurrentFix();
ui.source.forgetFix();
setBridge(host(async () => coords()));
await ui.source.getCurrentFix(); // a fix is now remembered for this page
setBridge(host(async () => {
  throw new Error('permission denied');
}));
attempt = await ui.source.getCurrentFix();
eq('a throwing host is a refusal, not a fallback', attempt.fix, null);
eq('  ...and the refusal is not served from memory', attempt.cached, false);
has('  ...and it says so', attempt.reason, 'refused the location request');

// (d) a host WITHOUT the method is no support — older SDK, or the simulator, which
// ships no GPS at all. The browser route must be tried.
noGeo();
setBridge(host(null));
ui.source.forgetFix();
attempt = await ui.source.getCurrentFix();
eq('an unimplemented host method yields no fix', attempt.fix, null);
has('  ...and blames the browser, not the host', attempt.reason, 'no location support');

// (e) the plain web app: no bridge at all, browser prompt, browser answer.
setBridge(null);
browserAnswers({ position: position() });
attempt = await ui.source.getCurrentFix();
eq('a browser fix is a browser fix', attempt.fix?.source, 'browser');
eq('  ...with the browser reading of the timestamp folded in', attempt.fix?.timestamp, 1700000000000);
eq('  ...and the age measured from when THIS app read it', attempt.fix?.capturedAt === 1700000000000, false);
eq('the browser is asked for metres when asked for high accuracy', (await ui.source.getCurrentFix({ accuracy: 'high' }), geoOpts.enableHighAccuracy), true);
eq('  ...and not otherwise', (await ui.source.getCurrentFix(), geoOpts.enableHighAccuracy), false);
eq('a browser read is never satisfied from cache', geoOpts.maximumAge, 0);

// (f) a browser TIMEOUT may be served from the page's last fix — labelled.
browserAnswers({ error: { code: 3 } });
attempt = await ui.source.getCurrentFix();
eq('a timeout is served from the last fix', attempt.cached, true);
eq('  ...which is the fix we had', attempt.fix?.source, 'browser');
// (g) a browser DENIAL may not. The wearer's answer is an instruction.
browserAnswers({ error: { code: 1 } });
attempt = await ui.source.getCurrentFix();
eq('a denial is NOT served from the last fix', attempt.fix, null);
eq('  ...and is not cached', attempt.cached, false);
has('  ...and says how to undo it', attempt.reason, 'allow location for this site');
// With nothing remembered, the remaining failures state their own cause rather
// than borrowing one — a fallback must never supply the REASON for a failure.
ui.source.forgetFix();
browserAnswers({ error: { code: 2 } });
has('an unavailable reading says so plainly', (await ui.source.getCurrentFix()).reason, 'could not determine a position');
browserAnswers({ error: { message: 'kaboom' } });
has('an unknown failure keeps the platform message', (await ui.source.getCurrentFix()).reason, 'kaboom');

// ── 3. the run snapshot ─────────────────────────────────────────────────────
console.log('\n§3  the run snapshot (run.ts)');
eq('the kind is the same string on both sides of the wire', ui.runmod.LOCATION_KIND, RELAY_LOCATION_KIND);
eq('a toolset with no location tool needs no fix', ui.runmod.needsLocation([{ kind: 'web' }]), false);
eq('an absent toolset needs no fix', ui.runmod.needsLocation(undefined), false);
eq('a non-array needs no fix', ui.runmod.needsLocation('location'), false);
eq('a null entry is not a location tool', ui.runmod.needsLocation([null]), false);
eq('a location tool is recognised by kind alone', ui.runmod.needsLocation([{ kind: 'location' }]), true);
eq('  ...whatever else it carries', ui.runmod.needsLocation([{ id: 'x', name: 'n', kind: 'location' }]), true);

let calls = 0;
setBridge(host(async () => {
  calls++;
  return coords();
}));
eq('an agent without the tool sends no snapshot', await ui.runmod.snapshotForRun([{ kind: 'web' }]), undefined);
eq('  ...and the device is never asked', calls, 0);
assert('an agent with the tool sends one', (await ui.runmod.snapshotForRun([{ kind: 'location' }]))?.latitude === 51.5);
eq('  ...which is exactly one read', calls, 1);
setBridge(host(async () => null));
ui.source.forgetFix();
eq('a refused read sends nothing at all (not null in the body)', await ui.runmod.snapshotForRun([{ kind: 'location' }]), undefined);

// ── 4. the capability, through the real registry ────────────────────────────
console.log('\n§4  location.get (capabilities/location.ts)');
const cap = ui.capabilityByName('location.get');
assert('the catalog exposes location.get', !!cap);
eq('it is global, not tied to a page', cap?.page, ui.GLOBAL_PAGE);
eq('it REACHES the device, so it is a read and never a gate', cap?.effect, 'read');
eq('the one argument is an enum', cap?.params?.[0]?.type, 'enum');
deepEq('  ...over the SDK hint values', cap?.params?.[0]?.values, ['low', 'medium', 'high']);
eq('  ...with a default', cap?.params?.[0]?.fallback, 'medium');
eq('the wire name is legal for tool-calling APIs', /^[a-zA-Z0-9_-]+$/.test(ui.toWireName('location.get')), true);
eq('  ...and is the dotted name translated', ui.toWireName('location.get'), 'location__get');
eq('the schema is a function', ui.toToolSchema(cap).type, 'function');
eq('  ...whose name is the wire name', ui.toToolSchema(cap).function.name, 'location__get');

setBridge(host(async () => coords({ accuracy: 4.5 })));
ui.source.forgetFix();
let result = await ui.callAction('location.get', { accuracy: 'medium' }, ui.GLOBAL_PAGE);
eq('a fix is reported ok', result.ok, true);
has('the summary is the line the glasses render', result.summary, '51.5');
eq('and is labelled fresh', result.data.fresh, true);
eq('the age is stated', result.data.ageSeconds, 0);
eq('the source is spelled out for the model', result.data.sourceText, 'the phone, via the Even Hub app');

setBridge(host(async () => {
  throw new Error('nope');
}));
ui.source.forgetFix();
result = await ui.callAction('location.get', {}, ui.GLOBAL_PAGE);
eq('a refusal is NOT ok', result.ok, false);
eq('  ...and does not pretend to have a position', result.data.latitude, undefined);
has('  ...and hands the reason back', result.summary, 'no location available');
has('  ...with the refusal reason in the data', result.data.reason, 'refused');
has('  ...and an instruction that forbids guessing', result.hint, 'Do not guess a location');

// A remembered fix reaches the wearer LABELLED, or not at all.
browserAnswers({ position: position() });
setBridge(null);
ui.source.forgetFix();
await ui.callAction('location.get', {}, ui.GLOBAL_PAGE);
browserAnswers({ error: { code: 3 } });
result = await ui.callAction('location.get', {}, ui.GLOBAL_PAGE);
eq('a remembered fix is still reported', result.ok, true);
eq('  ...but is not called fresh', result.data.fresh, false);
has('  ...and the summary the glasses render says so', result.summary, 'last known');
has('  ...and the model is told to say so', result.hint, 'remembered fix');

// ── 5. the relay half ───────────────────────────────────────────────────────
console.log('\n§5  the relay tool (web/server/location-tool.mjs)');
eq('only the location kind is a location tool', isLocationTool({ kind: 'location' }), true);
eq('nothing else is', isLocationTool({ kind: 'web' }), false);
eq('  ...nor is a missing tool', isLocationTool(undefined), false);
eq('the snapshot keeps 0/0', normalizeSnapshot({ latitude: 0, longitude: 0 })?.latitude, 0);
eq('a snapshot with no pair is no snapshot', normalizeSnapshot({ accuracy: 5 }), null);
eq('a string coordinate is refused on the wire too', normalizeSnapshot({ latitude: '1', longitude: 0 }), null);
eq('  ...and an out-of-range one', normalizeSnapshot({ latitude: 91, longitude: 0 }), null);
eq('an unknown source is treated as the host', normalizeSnapshot(coords({ source: 'satellite' })).source, 'hub');
eq('a browser source survives the wire', normalizeSnapshot(coords({ source: 'browser' })).source, 'browser');
eq('capturedAt falls back to the host timestamp', normalizeSnapshot(coords({ timestamp: 12 })).capturedAt, 12);
eq('  ...and to 0 when there is neither', normalizeSnapshot(coords()).capturedAt, 0);
eq('a negative accuracy is dropped on the wire as well', normalizeSnapshot(coords({ accuracy: -1 })).accuracy, undefined);
assert('NO_FIX_TEXT forbids the guess in so many words', NO_FIX_TEXT.includes('Do NOT state, estimate or infer'));
has('and names the ordinary cause', NO_FIX_TEXT, 'location access');

const relayTool = { name: 'jarvis_location', kind: 'location', description: '' };
const refused = runLocationTool(relayTool, {}, null);
eq('no snapshot is not ok', refused.ok, false);
eq('  ...and returns the refusal verbatim', refused.text, NO_FIX_TEXT);
eq('a snapshot the client sent is used', runLocationTool(relayTool, {}, coords()).ok, true);

const freshText = runLocationTool(relayTool, {}, coords({ accuracy: 4.5, capturedAt: Date.now() })).text;
has('the result states the position', freshText, 'Position: 51.50000, -0.12000');
has('  ...the accuracy', freshText, 'Accuracy: about 4.5 m');
has('  ...when it was captured', freshText, 'Captured:');
has('  ...and which software reported it', freshText, 'Reported by: the phone, via the Even Hub app');
has('  ...and that the run cannot take a new reading', freshText, 'cannot take a new reading');
assert(
  'the result is ASCII only — a G2 renders it back to the wearer',
  /^[\x20-\x7E\n]*$/.test(freshText),
  JSON.stringify(freshText.match(/[^\x20-\x7E\n]/)?.[0] ?? ''),
);
const oldText = runLocationTool(relayTool, {}, coords({ capturedAt: Date.now() - 30 * 60e3 })).text;
has('an old position is announced as old', oldText, 'this position is old');
has('  ...with its age on the line', oldText, '30 minutes');
has('  ...beside the other readable extras', runLocationTool(relayTool, {}, coords({ altitude: 30, speed: 2, heading: 90 })).text, 'Also reported:');
eq('seconds are spelled out', formatAge(5000), '5 seconds');
eq('one second is singular', formatAge(1000), '1 second');
eq('  ...and one hour too', formatAge(3600e3), '1 hour');
eq('minutes are rounded', formatAge(90e3), '2 minutes');
eq('a day count is used for long gaps', formatAge(3 * 86400e3), '3 days');
eq('a missing stamp is not "0 days"', formatAge(0), 'moments');

const schema = locationToolSchema(relayTool);
eq('the tool is a function', schema.type, 'function');
eq('the schema takes the tool name, not a constant', schema.function.name, 'jarvis_location');
eq('a nameless tool still gets a legal name', locationToolSchema({}).function.name, LOCATION_TOOL_NAMES.location);
deepEq('it takes no arguments and forbids extras', schema.function.parameters.properties, {});
deepEq('  ...and requires none', schema.function.parameters.required, []);
eq('  ...because it cannot be told to try harder from here', schema.function.parameters.additionalProperties, false);
eq('the log label is the tool name', locationToolSummary(relayTool), 'jarvis_location');
eq('the model-facing name matches the client’s ToolDef', ui.locationTool().name, LOCATION_TOOL_NAMES.location);
eq('the client’s ToolDef uses the relay’s kind', ui.locationTool().kind, RELAY_LOCATION_KIND);

// ── 6. the relay wiring ─────────────────────────────────────────────────────
console.log('\n§6  the relay wiring (local-sse.mjs)');
const schemaFn = fnSource(relaySrc, 'toolSchemaFor');
assert('the schema builder knows the kind', schemaFn.includes('isLocationTool'));
assert(
  '  ...and answers it BEFORE the generic-REST fallback',
  schemaFn.indexOf('isLocationTool') < schemaFn.indexOf('return httpToolSchema(t)'),
  'a location tool has no url and would be mis-shaped as REST',
);
has('  ...through a schema of its own', schemaFn, 'locationToolSchema(t)');
const dispatchFn = fnSource(relaySrc, 'runToolOnce');
eq('the dispatcher gained exactly one location branch', (dispatchFn.match(/isLocationTool\(/g) ?? []).length, 1);
has('  ...which passes the snapshot through', dispatchFn, 'runLocationTool(tool, args, ctx.location)');
has('  ...from a per-run context, so two runs cannot see each other', dispatchFn, 'ctx = {}');
const pruneFn = fnSource(relaySrc, 'pruneRuns');
has('a finished run drops its snapshot', pruneFn, 'runLocations.delete(id)');
has('  ...and so does an evicted one', pruneFn, 'runLocations.delete(victim.id)');
const runRoute = routeSource(relaySrc, "url.pathname === '/api/agent/run'");
// The route no longer stores the snapshot itself — the run it starts does. The
// subject is unchanged: the position is stored BESIDE the run and never ON it,
// because runSnapshot/broadcastRun serialise every field, so a position field
// would be handed to every client and would outlive the one tool call that needs
// it. Only the OWNER moved, and it moved because there is now exactly one place a
// run comes into existence; the route's job is to hand the spec over.
has('the run route hands the snapshot to the run it starts', runRoute, 'location: body?.location,');
assert('  ...and stores nothing itself', !/runLocations\.set/.test(runRoute));
const runCtorFn = fnSource(relaySrc, 'startAgentRun');
has('the run constructor stores it BESIDE the run', runCtorFn, 'runLocations.set(run.id, spec.location)');
assert(
  '  ...and never ON it (runSnapshot/broadcastRun would serialise it)',
  !/^\s*location:/m.test(runCtorFn),
  'a field here reaches every client, and a child run is given none on purpose',
);
const execFn = fnSource(relaySrc, 'executeRun');
// The snapshot is read BY RUN ID. The assertion is on the LOOKUP, not on the
// whole context literal: that same context also carries the run id and the run's
// intent queue, so matching the closing brace would pin an argument list and
// break the moment a fourth field is added — testing the shape of a call rather
// than the property under test.
has('the executor reads the snapshot by run id', execFn, 'location: runLocations.get(run.id)');
assert(
  '  ...and passes the run id and its intent queue through the same context',
  /location: runLocations\.get\(run\.id\),\s*runId: run\.id,\s*intents: runIntents\.get\(run\.id\),/.test(
    execFn,
  ),
  'one context per call — a module-level lookup would let two runs see each other',
);
const toolRoute = routeSource(relaySrc, "url.pathname === '/api/tool'");
assert(
  'the tool proxy answers a location tool as a location tool',
  toolRoute.includes('isLocationTool(body)'),
);
// The order check runs on COMMENT-STRIPPED source, and that matters. The subject
// is where the location branch sits relative to the https guard, and a branch
// ABOVE it may legitimately quote the guard's message in its own comment to
// explain why it must not fall through (the hub-MCP branch does exactly that,
// on one line). indexOf would find that quotation first and fail an assertion
// whose subject — the branch order — is perfectly correct. A comment is not
// behaviour; the guard is. The earlier location comment escaped this only by
// luck, its quotation wrapping across two lines.
const toolCode = toolRoute.replace(/^[ \t]*\/\/.*$/gm, '');
assert(
  '  ...before the https guard that would describe a tool it is not',
  toolCode.indexOf('isLocationTool(body)') < toolCode.indexOf('tool url must be https://'),
);

// ── 7. the client wiring ────────────────────────────────────────────────────
console.log('\n§7  the client wiring');
const kinds = (/export type ToolKind =([^;]+);/.exec(typesSrc)?.[1] ?? '')
  .match(/'[a-z]+'/g)
  ?.map((s) => s.slice(1, -1));
// Derived from the relay, not typed twice: three kinds come from modules that
// declare them, two from branches written out in local-sse.mjs, and the last two
// ride the generic REST path.
const sourceKinds = [
  /isFilesTool\(t\)/.test(relaySrc) ? 'files' : null,
  /kind === 'jev'/.test(relaySrc) ? 'jev' : null,
].filter(Boolean);
deepEq('the relay branches on files and jev by name', sourceKinds, ['files', 'jev']);
// A third kind is branched on by name as well, but it arrives through a MODULE the
// relay imports — agent-tool.mjs, the way `location` arrives through
// location-tool.mjs — rather than as a literal written inline. Both halves are
// required, and that is the point: a schema branch with no dispatch is a function
// the model can call and nothing can ever answer, and a dispatch with no schema
// branch is code the model can never reach. Either one alone looks like the
// feature is present, which is exactly how a kind gets shipped and then reported
// as "the agent says it ran something".
const agentKind =
  /\bisAgentTool\(t\)\) return agentToolSchema\(t\)/.test(relaySrc) &&
  /\bisAgentTool\(tool\)\) return runAgentTool\(tool, args, ctx\)/.test(relaySrc)
    ? 'agent'
    : null;
assert('the agent kind is both described and executed by the relay', Boolean(agentKind));
const relayKinds = [
  ...HUB_TOOL_KINDS,
  RELAY_LOCATION_KIND,
  ...sourceKinds,
  ...(agentKind ? [agentKind] : []),
  'web',
  'http',
].sort();
// Parity in BOTH directions: a kind the client can author but the relay cannot
// execute is an agent tool that fails at the worst possible moment, and one the
// relay can execute but the client cannot author is dead code.
deepEq('every ToolKind the client can author is one the relay can execute', kinds?.sort(), relayKinds);
assert('the two generic kinds still share one REST path', /return httpToolSchema\(/.test(schemaFn));
assert('the location kind is in that set', kinds?.includes('location'));
eq('the seeded tool id is stable', ui.LOCATION_TOOL_ID, 'tool-location');
eq('the seeded tool needs no token', ui.locationTool().hasToken, false);
has('the tool description warns the position is a snapshot', ui.locationTool().description, 'captured when the run starts');
has('  ...and tells the model to report the age', ui.locationTool().description, 'age');
const empty = ui.emptyAgentsState();
eq('a fresh install is still offered exactly one tool', empty.tools.length, 1);
eq('  ...which is web search, and not location', empty.tools[0].kind, 'web');
has('the run payload carries the snapshot', streamSrc, 'location?: LocationFix');

// Every trigger site must ask. A new `startRun` that forgets is the one failure
// a shared helper cannot prevent on its own — and in a browser it would raise a
// permission prompt for an agent that never asks where anyone is. Anchored on
// `await startRun({` so a doc comment describing the rule cannot pass for one.
const srcFiles = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
};
const srcRoot = here('../src').pathname.replace(/^\/([A-Za-z]:)/, '$1');
const startRunFiles = srcFiles(srcRoot)
  .map((p) => [p, readFileSync(p, 'utf8')])
  .filter(([, text]) => /await startRun\(\{/.test(text));
assert('the three trigger sites exist to check', startRunFiles.length === 3, String(startRunFiles.length));
for (const [p, text] of startRunFiles) {
  const site = text.slice(text.indexOf('await startRun({'));
  assert(
    'a startRun call site sends the snapshot: ' + p.split(/[\\/]/).pop(),
    site.includes('location: await snapshotForRun('),
    site.slice(0, 200).replace(/\s+/g, ' '),
  );
}

// ── 8. the seed, and the opt-in ─────────────────────────────────────────────
console.log('\n§8  the seed (capabilities/agents.ts)');
// Declaration order in the file is not the offer order, so each slice ends at
// the next `const` in the FILE, and the offer order is asserted separately below.
const seeds = {
  web: wordsOf(seedSrc, 'const WEB_SEED', 'const FILES_SEED'),
  files: wordsOf(seedSrc, 'const FILES_SEED', 'const JEV_SEED'),
  jev: wordsOf(seedSrc, 'const JEV_SEED', 'const TODO_SEED'),
  todo: wordsOf(seedSrc, 'const TODO_SEED', 'const DOCS_SEED'),
  docs: wordsOf(seedSrc, 'const DOCS_SEED', 'const NOTES_SEED'),
  notes: wordsOf(seedSrc, 'const NOTES_SEED', 'const LOCATION_SEED'),
  location: wordsOf(seedSrc, 'const LOCATION_SEED', 'const SEED_TOOLS'),
};
for (const [name, re] of Object.entries(seeds)) {
  assert(`the ${name} seed is a real pattern`, re instanceof RegExp, String(re));
}
// "where am I" must create a LOCATION tool and nothing else. A seed that also
// answers to another kind's vocabulary attaches the wrong tool, silently.
for (const phrase of ['where am I', 'where are we', 'what is my location', 'gps', 'my coordinates', 'latitude', 'near me']) {
  const matched = Object.entries(seeds).filter(([, re]) => re.test(phrase)).map(([n]) => n);
  deepEq(`"${phrase}" is a location request`, matched, ['location']);
}
for (const phrase of ['allocated the budget', 'allocation of seats', 'delocalize']) {
  eq(`"${phrase}" is not a location request`, seeds.location.test(phrase), false);
}
const seedList = seedSrc.slice(seedSrc.indexOf('const SEED_TOOLS'));
assert(
  'the seed is offered BEFORE the loose files vocabulary, since findTool takes the FIRST match',
  seedList.indexOf('LOCATION_SEED,') < seedList.indexOf('FILES_SEED,'),
  '"where am I" must not resolve to the document gateway',
);
has('the spoken path threads the snapshot into the run', seedSrc, 'location: await snapshotForRun(tools)');

// ── 9. the permission the host actually checks ──────────────────────────────
console.log('\n§9  the manifest');
const perms = appJson.permissions ?? [];
const location = perms.find((p) => p.name === 'location');
assert('app.json declares the location permission', !!location);
assert(
  '  ...with a description the pack step accepts (1-300 chars)',
  typeof location?.desc === 'string' && location.desc.length >= 1 && location.desc.length <= 300,
  String(location?.desc?.length),
);
// The CLI validates the NAME against a fixed list; a typo fails the pack, so the
// set is asserted here rather than discovered at release time.
const LEGAL = ['g2-microphone', 'phone-microphone', 'album', 'location', 'network', 'camera'];
const illegal = perms.map((p) => p.name).filter((n) => !LEGAL.includes(n));
deepEq('every declared permission is one the CLI will accept', illegal, []);

console.log(`\n${fail === 0 ? `ALL PASS (${total} assertions)` : `${fail} FAILURE(S) of ${total}`}`);
process.exit(fail === 0 ? 0 : 1);
