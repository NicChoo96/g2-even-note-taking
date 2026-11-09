#!/usr/bin/env node
// PACKAGE FIRST-RUN harness — the `.ehpk` must be able to reach a hub and ask for
// a code the instant it opens.
//
// WHY THIS EXISTS:
//   The shipped 0.3.63 package opened to a card reading "Contacting the hub…" and
//   sat there for ever. Two independent faults stacked:
//
//     1. `PairScreen` only ASKS for a code while `pairing` is true — the request
//        lives in the provider's effect behind that flag. Removing Google sign-in
//        made the package render `PairScreen` directly, which is a screen waiting
//        for the answer to a question nobody asked.
//     2. `API_BASE` inside the package was the package itself. `stream.ts` falls
//        back to same-origin `/api/stream?channel=hub`, and inside a package the
//        page IS the origin, so `/api/pair/request` reached an asset host. Even
//        with the request started, there was nothing to answer it.
//
//   Neither fault is visible in a browser, where same-origin is the relay and
//   pairing is opt-in. Both are fatal in the package, which is the only place the
//   wearer ever sees. So this harness boots the REAL modules under a fake package
//   host and asserts the two things that must hold for a fresh install:
//
//     A. A package with no stored relay resolves to the LIVE relay, and a stored
//        relay still wins.
//     B. A browser is untouched: same-origin stays same-origin.
//     C. The pair screen starts itself, keeps the hub address fixable, and says
//        so out loud when the hub will not answer instead of spinning silently.
//
// Run: node tools/package-pairing-sim.mjs
//      SIM_QUIET=1 node tools/package-pairing-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const QUIET = !!process.env.SIM_QUIET;
let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (ok && QUIET) return;
  if (ok) console.log(`PASS  ${label}`);
  else
    console.log(
      `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`,
    );
}

function checkTrue(label, got) {
  const ok = got === true;
  ok ? pass++ : fail++;
  if (ok && QUIET) return;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label} (got ${JSON.stringify(got)})`);
}

// ── Bundle the REAL modules ────────────────────────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'package-pairing-sim-'));
const stub = join(out, 'sdk-stub.mjs');
writeFileSync(
  stub,
  `export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }
export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }
export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }
export const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
`,
);

const outfile = join(out, 'pkg.mjs');
await build({
  stdin: {
    contents: `
export { DEFAULT_RELAY, inPackageWebview } from './env.ts';
export { STREAM_URL, API_BASE } from './stream.ts';
export { normalizeRelay, setStoredRelay, storedRelay } from './web/access.ts';
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

// ── A fake HOST, chosen per scenario ───────────────────────────────────────
// `API_BASE` is a module constant resolved at import, so every scenario needs a
// FRESH evaluation of the bundle. A distinct query string is a distinct module
// instance to Node, which is exactly the "cold boot" being simulated.
let seq = 0;

function host({ protocol = 'https:', userAgent = 'Mozilla/5.0 (X11; Linux)', relay = null, bridge = false }) {
  const mem = new Map();
  if (relay) mem.set('hub:relay', relay);
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
  globalThis.sessionStorage = { ...globalThis.localStorage };
  globalThis.location = { protocol, origin: `${protocol}//pkg`, href: `${protocol}//pkg/` };
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent },
    configurable: true,
    writable: true,
  });
  globalThis.window = globalThis;
  if (bridge) globalThis.flutter_inappwebview = {};
  else delete globalThis.flutter_inappwebview;
}

const boot = () => import(`${pathToFileURL(outfile).href}?boot=${++seq}`);

// ── A. the package resolves to a relay it can actually reach ───────────────
{
  host({ protocol: 'file:', relay: null });
  const m = await boot();
  check('a package is recognised as a package', m.inPackageWebview(), true);
  check('and a fresh install points at the live relay', m.API_BASE, m.DEFAULT_RELAY);
  checkTrue(
    'which is an https origin, not a relative path',
    /^https:\/\/[^/]+$/.test(m.API_BASE),
  );
  check(
    'the stream follows the same origin',
    m.STREAM_URL,
    `${m.DEFAULT_RELAY}/api/stream?channel=hub`,
  );
  check('and it is the host whitelisted in app.json', m.DEFAULT_RELAY.includes('railway.app'), true);
}

{
  host({ protocol: 'https:', userAgent: 'EvenApp/2.2.9 CFNetwork', relay: null });
  const m = await boot();
  check('the Even App user agent is a package too', m.inPackageWebview(), true);
  check('and also gets the live relay', m.API_BASE, m.DEFAULT_RELAY);
}

{
  host({ protocol: 'https:', relay: null, bridge: true });
  const m = await boot();
  check('an injected Flutter bridge is a package too', m.inPackageWebview(), true);
  check('and also gets the live relay', m.API_BASE, m.DEFAULT_RELAY);
}

// ── B. a stored relay wins, and a browser is untouched ─────────────────────
{
  host({ protocol: 'file:', relay: 'https://my-relay.example' });
  const m = await boot();
  check('a relay chosen by the wearer wins over the default', m.API_BASE, 'https://my-relay.example');
  check(
    'and the stream follows it, not the default',
    m.STREAM_URL,
    'https://my-relay.example/api/stream?channel=hub',
  );
}

{
  host({ protocol: 'https:', userAgent: 'Mozilla/5.0 (Macintosh)', relay: null });
  const m = await boot();
  check('a plain browser is NOT a package', m.inPackageWebview(), false);
  check('so it keeps same-origin', m.STREAM_URL, '/api/stream?channel=hub');
  check('which is what the deployed relay serves', m.API_BASE, '');
}

{
  // The dev server proxies /api itself, so this must stay relative as well.
  host({ protocol: 'http:', userAgent: 'Mozilla/5.0 (Windows NT 10.0)', relay: null });
  const m = await boot();
  check('http dev is not a package', m.inPackageWebview(), false);
  check('and stays same-origin for the proxy', m.API_BASE, '');
}

// ── Written addresses are normalised, and a bad one stores nothing ─────────
{
  host({ protocol: 'https:', relay: null });
  const m = await boot();
  check('a pasted app URL is reduced to its origin', m.normalizeRelay('https://h.example/?tab=docs'), 'https://h.example');
  check('a bare host gets https', m.normalizeRelay('h.example'), 'https://h.example');
  check('and nonsense is refused', m.normalizeRelay('not a url at all'), '');
  check('storing nonsense leaves the old value alone', m.setStoredRelay(''), '');
  check('so nothing is stored', m.storedRelay(), '');
}

// ── C. the pair screen wires itself up ─────────────────────────────────────
// These are SOURCE assertions: the components are React trees needing a DOM, and
// what went wrong was the wiring, not the rendering. Reading the shipped source
// is what makes the removed `return <PairScreen />` a regression this harness
// fails on, rather than a discovery the wearer makes on their glasses.
const uiSrc = readFileSync(resolve(here, '../src/web/ui.tsx'), 'utf8');
const authSrc = readFileSync(resolve(here, '../src/web/auth.tsx'), 'utf8');

checkTrue(
  'the package gate routes to the self-starting pair screen',
  /if \(inEvenApp\) return <PackagePairing \/>;/.test(uiSrc),
);
check(
  'and NOT to a pair screen that waits for a start nobody gives',
  /if \(inEvenApp\) return <PairScreen \/>;/.test(uiSrc),
  false,
);
checkTrue(
  'the pair screen starts pairing itself',
  /function PackagePairing\(\)[\s\S]{0,400}setPairing\(true\)/.test(uiSrc),
);
checkTrue(
  'pairing is what actually sends the request',
  /if \(!pairing\) return;/.test(authSrc),
);
checkTrue(
  'and the request carries a human label so approval is not a uuid',
  /label: detectEvenApp\(\) \? 'Glasses app' : 'Browser'/.test(authSrc),
);
checkTrue(
  'the hub address is fixable from the pair screen itself',
  /setStoredRelay\(relay\)/.test(authSrc),
);
checkTrue(
  'a saved address takes effect on a reload, because API_BASE is a constant',
  /location\.reload\(\)/.test(authSrc),
);
checkTrue(
  'and an unreachable hub is said out loud, not spun on for ever',
  /is not answering/.test(authSrc),
);
check(
  'the dead "back to sign in" link is gone from the package',
  /\{!paired && !inEvenApp && \(/.test(authSrc),
  true,
);

// ── the approve route, end to end ─────────────────────────────────────────
// THE BUG THIS GUARDS: the route matched by device id through `wantedId`, and
// nothing ever declared it. Every approval threw `ReferenceError: wantedId is
// not defined` before it could match ANYTHING, so the panel answered "Approval
// failed" for a code that was sitting in its own list, on every device. Nothing
// else could catch it: a .mjs file has no typechecker, and no harness POSTed
// here. Verified live afterwards — request -> approve returned 200 and the
// device polled back `approved`.
const relaySrc = readFileSync(resolve(here, '../../web/server/local-sse.mjs'), 'utf8');
const declAt = relaySrc.indexOf("const wantedId = String(parsed.deviceId");
const useAt = relaySrc.indexOf('wantedId ? deviceById(wantedId)');
checkTrue('the approve route reads the device id the panel taps', declAt > -1);
checkTrue('and declares it BEFORE the line that uses it', declAt > -1 && useAt > declAt);
checkTrue(
  'the panel sends both a code and an id, so either one can match',
  /pairCode: value\.toUpperCase\(\), deviceId: value/.test(authSrc),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
