#!/usr/bin/env node
// The relay's CORS preflight — every method and header the clients actually send.
//
// WHY THIS EXISTS — reported by the wearer, through Jarvis on the glasses:
//
//   summary: "Failed to fetch"
//   hint:    "The change did NOT reach the hub, so it is not saved…"
//
// Five to-do deletes in one batch, and all five identical. Reads worked and every
// create worked, so the relay was plainly up and the token plainly good — yet a
// DELETE could not complete, on two different days. The cause was one header:
//
//   Access-Control-Allow-Methods: GET, POST, OPTIONS
//
// A preflight names ONE method, and a browser refuses the WHOLE request unless
// that exact name comes back. So `GET, POST` covered reads and creates while
// every delete, rename, rule-off, clear and note-save was blocked before it ever
// left the page — and no client can tell that apart from a dead network, because
// `fetch` rejects with a bare `TypeError: Failed to fetch`.
//
// It only bites cross-origin, which is exactly why it survived two reports. The
// app and the relay share an origin only when the app is opened AT the relay URL,
// and that is where the feature had been checked. The glasses load their bundle
// locally and local dev runs off a Vite dev server, so both talk to the relay
// cross-origin, and both were broken.
//
// So the list below is DERIVED, never restated: §1 reads the verbs out of the
// client sources themselves. Using a new method in the app without advertising it
// is a failing test from now on, instead of another mystifying "Failed to fetch"
// discovered weeks later by a wearer who cannot see a console.
//
// Run: node tools/cors-sim.mjs   (judged on EXIT CODE)

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const srcRoot = resolve(here, '../src');

let fail = 0;
let pass = 0;
const check = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) pass++;
  else fail++;
  console.log(
    `${good ? 'PASS' : 'FAIL'}  ${label}${
      good ? '' : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`
    }`,
  );
};
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `\n        ${detail}` : ''}`);
};

/** The CORS headers one `setCors(res)` really sets, read from its own source. */
function setCorsOf(rel) {
  const src = readFileSync(resolve(root, rel), 'utf8');
  const start = src.indexOf('function setCors(res) {');
  const body = start === -1 ? '' : src.slice(start, src.indexOf('\n}', start));
  const list = (name, caser) => {
    const m = body.match(new RegExp(`'${name}',\\s*'([^']*)'`));
    return m ? m[1].split(',').map((s) => caser(s.trim())).filter(Boolean) : [];
  };
  return {
    src,
    found: start !== -1,
    methods: list('Access-Control-Allow-Methods', (s) => s.toUpperCase()),
    headers: list('Access-Control-Allow-Headers', (s) => s.toLowerCase()),
    exposed: list('Access-Control-Expose-Headers', (s) => s.toLowerCase()),
  };
}

/** Every `.ts`/`.tsx` under glasses/src — the clients that talk to the relay. */
const clientFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(entry.name)) clientFiles.push(p);
  }
})(srcRoot);

const client = clientFiles.map((p) => ({
  rel: relative(root, p).split('\\').join('/'),
  src: readFileSync(p, 'utf8'),
}));

/** Record a name against every file that mentions it, so a failure names them. */
const note = (map, name, rel) => {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(rel);
};

/**
 * The header names a client really puts on a request.
 *
 * Only two places are unambiguous, and both are used: the body of an
 * `authHeaders()` helper, where `h` is the header accumulator by definition, and
 * an inline `headers: {...}` literal in a fetch call.
 *
 * Nothing else may be consulted. `h.timer = ...` is an EventSource handle and
 * `h.status` / `h.activeDocId` are fields of a parsed hub body — the very same
 * `h` by coincidence of habit. Counting those would make this harness report
 * `timer`, `retry` and `status` as missing CORS headers, and a harness that cries
 * wolf is a harness somebody deletes.
 */
function requestHeadersOf(files) {
  const found = new Map();
  for (const { rel, src } of files) {
    for (const fn of src.matchAll(/function authHeaders\(json = false\)[^{]*\{([\s\S]*?)\n\}/g)) {
      for (const m of fn[1].matchAll(/\bh\[['"]([^'"]+)['"]\]\s*=/g)) note(found, m[1].toLowerCase(), rel);
      for (const m of fn[1].matchAll(/\bh\.([A-Za-z][\w-]*)\s*=/g)) note(found, m[1].toLowerCase(), rel);
    }
    // A variable named `headers` is a request header bag wherever it is — that
    // name is never used for anything else here — so this one is read whole-file
    // and needs no scoping. It is what catches the three conditional headers
    // `sendRequest` adds after the fact: the idempotency key, the client id and
    // the If-Match that makes a write revision-checked.
    for (const m of src.matchAll(/\bheaders\[['"]([^'"]+)['"]\]\s*=/g)) note(found, m[1].toLowerCase(), rel);
    for (const m of src.matchAll(/headers:\s*\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/['"]([^'"]+)['"]\s*:|(?<![.\w])([A-Za-z][\w-]*)\s*:/g)) {
        note(found, (k[1] ?? k[2]).toLowerCase(), rel);
      }
    }
  }
  return found;
}

/** The headers the JSON state POST to /api/stream sets — the Vercel copy's job. */
const statePostHeaders = (() => {
  const src = readFileSync(resolve(srcRoot, 'stream.ts'), 'utf8');
  const at = src.indexOf('async function postJson(');
  const fn = src.slice(at, src.indexOf('\n}', at));
  return requestHeadersOf([{ rel: 'glasses/src/stream.ts', src: fn }]);
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('== 1. the relay advertises every method the clients send ==');

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const sentMethods = new Map();

// Three shapes cover every call site in the app. The third is deliberately broad
// and captures whole type unions (`'POST' | 'PATCH' | 'DELETE'`), because the
// guardrail must never UNDER-count: a method named only in a union is still a
// method some call site can send.
const CALL_SHAPES = [
  /hubRequest(?:<[^>]*>)?\(\s*('[A-Z]+')/g,
  /sendJson(?:<[^>]*>)?\(\s*('[A-Z]+')/g,
  /method:\s*((?:'[A-Z]+'\s*(?:\|\s*)?)+)/g,
];
for (const { rel, src } of client) {
  for (const shape of CALL_SHAPES) {
    for (const m of src.matchAll(shape)) {
      for (const v of m[1].matchAll(/'([A-Z]+)'/g)) {
        if (VERBS.includes(v[1])) note(sentMethods, v[1], rel);
      }
    }
  }
}

const relay = setCorsOf('web/server/local-sse.mjs');
ok('the relay has a setCors to read', relay.found);

const sentList = [...sentMethods.keys()].sort();
// A scan that silently found nothing would make every check below pass
// vacuously, so the derived set has to be the full one this app is known to use.
check('the clients were scanned, and between them use every verb', sentList, [...VERBS].sort());

const unadvertised = sentList.filter((v) => !relay.methods.includes(v));
ok(
  'every one of them is in Access-Control-Allow-Methods',
  unadvertised.length === 0,
  unadvertised
    .map((v) => `${v} is sent by ${[...sentMethods.get(v)].sort().join(', ')} but not advertised`)
    .join('\n        '),
);
console.log(`      sent:       ${sentList.join(', ')}`);
console.log(`      advertised: ${relay.methods.join(', ')}`);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 2. the documented contract, and the second copy of setCors ==');

// The project's own REST spec states this header; the code must cover it. Only a
// SUBSET is required, so an added method in the spec does not break the build —
// dropping one from the code does.
const specSrc = readFileSync(resolve(root, 'docs/data-platform/03-rest-api-spec.md'), 'utf8');
const spec = (specSrc.match(/Access-Control-Allow-Methods:\s*([^\n]+)/) ?? [, ''])[1]
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
ok('the spec names the methods', spec.length > 0);
const specMissing = spec.filter((v) => !relay.methods.includes(v));
ok(
  'the relay covers everything the spec promises',
  specMissing.length === 0,
  `the spec promises ${specMissing.join(', ')} but the relay does not advertise it`,
);

const vercel = setCorsOf('web/api/stream.mjs');
ok('the Vercel function has a setCors to read', vercel.found);
// The two copies differ on purpose, so equality is the wrong check. The Vercel
// host serves /api/stream and nothing else — there is no /api/hub there, so a
// Vercel page reaches the hub cross-origin — and its only caller is postJson().
const vercelNeeds = [...statePostHeaders.keys()].sort();
const vercelGaps = vercelNeeds.filter((n) => !vercel.headers.includes(n));
ok(
  'it allows every header the state POST sets',
  vercelNeeds.length > 0 && vercelGaps.length === 0,
  vercelGaps.join(', ') || 'postJson() yielded no headers — the scan looked in the wrong place',
);
ok(
  'it handles that POST, and the preflight that precedes it',
  vercel.methods.includes('POST') && vercel.methods.includes('OPTIONS'),
  `advertises ${vercel.methods.join(', ')}`,
);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 3. the preflight is answered for every path, before routing ==');

// A widened list is worthless if the OPTIONS reply is only reached on some
// routes, or reached after a route has already answered. The whole reason one
// header change fixes the hub passthrough is that this runs FIRST, for every
// path — so that ordering is the thing worth pinning.
const handlerAt = relay.src.indexOf('const server = createServer(async (req, res) => {');
const corsAt = relay.src.indexOf('setCors(res);', handlerAt);
const optAt = relay.src.indexOf("if (req.method === 'OPTIONS')", handlerAt);
const hubAt = relay.src.indexOf("url.pathname.startsWith('/api/hub/')");
ok('the request handler runs setCors first', handlerAt !== -1 && corsAt > handlerAt);
ok('an OPTIONS request is answered inside that handler', optAt > corsAt);
ok(
  '…with a bare 204 and no routing',
  /if \(req\.method === 'OPTIONS'\) \{\s*res\.writeHead\(204\);\s*res\.end\(\);\s*return;/.test(relay.src),
);
ok(
  '…before the /api/hub passthrough is even considered',
  optAt !== -1 && hubAt !== -1 && optAt < hubAt,
);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 4. every request header the clients set is advertised ==');

// The identical bug, one field over: a preflight is refused for an unlisted
// HEADER exactly as it is for an unlisted METHOD. This file's own history already
// contains that failure once — a missing `Authorization` here surfaced as
// "relay refused the run".
const sentHeaders = requestHeadersOf(client);
const sentHeaderList = [...sentHeaders.keys()].filter((n) => /^[a-z][a-z0-9-]+$/.test(n)).sort();
const headerGaps = sentHeaderList.filter((n) => !relay.headers.includes(n));
ok(
  'every request header the clients set is advertised',
  headerGaps.length === 0,
  headerGaps
    .map((n) => `${n} is set by ${[...sentHeaders.get(n)].sort().join(', ')} but not advertised`)
    .join('\n        '),
);
console.log(`      sent:       ${sentHeaderList.join(', ')}`);
console.log(`      advertised: ${relay.headers.join(', ')}`);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 5. every response header the clients read is exposed ==');

// Neither `ETag` nor `Duplicate` is CORS-safelisted, so a cross-origin caller
// reads them as null unless they are named here — and a null `ETag` silently
// turns every later write into a first-attempt stale-rev refusal.
const readHeaders = new Map();
for (const { rel, src } of client) {
  for (const m of src.matchAll(/headers\.get\(\s*['"]([^'"]+)['"]/g)) note(readHeaders, m[1].toLowerCase(), rel);
}
const readList = [...readHeaders.keys()].sort();
const exposeGaps = readList.filter((n) => !relay.exposed.includes(n));
ok(
  'every response header the clients read is exposed',
  exposeGaps.length === 0,
  exposeGaps
    .map((n) => `${n} is read by ${[...readHeaders.get(n)].sort().join(', ')} but not exposed`)
    .join('\n        '),
);
console.log(`      read:       ${readList.join(', ')}`);
console.log(`      exposed:    ${relay.exposed.join(', ')}`);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 6. the failure it produced is still reported honestly ==');

// The other half of the delay: the wearer was told "Failed to fetch", the
// browser's own wording, which reads as flaky signal — the one reading that
// makes you retry rather than investigate. A `status: 0` write must be named in
// the app's own words.
const storeSrc = readFileSync(resolve(srcRoot, 'store.ts'), 'utf8');
const atWhy = storeSrc.indexOf('function whyRefused');
const whyBody = storeSrc.slice(atWhy, storeSrc.indexOf('\n}', atWhy));
const zeroBranch = whyBody.match(/if \(res\.status === 0\) return ([^;]+);/);
ok('whyRefused has a branch for a status of 0', !!zeroBranch);
ok(
  '…and it speaks for itself instead of relaying the browser string',
  !!zeroBranch && !/res\.error/.test(zeroBranch[1]),
  zeroBranch ? `returns ${zeroBranch[1]}` : 'no branch found',
);

// And the branch must stay REACHABLE: `hub-client` reports a rejected fetch as
// `status: 0` rather than throwing, which is what keeps `safeCall` a no-op here.
const hubSrc = readFileSync(resolve(srcRoot, 'web/hub-client.ts'), 'utf8');
ok(
  'a rejected fetch is still reported as status 0 by hub-client',
  /catch \(err\) \{[\s\S]{0,400}?status: 0,/.test(hubSrc),
);

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`} — ${pass} checks`);
process.exitCode = fail === 0 ? 0 : 1;
