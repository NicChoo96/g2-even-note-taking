#!/usr/bin/env node
// THE OWNER SESSION, AND THE DEVICE LIST IT FEEDS.
//
// WHY THIS EXISTS. Two reports, one root cause:
//
//   "the paired devices simply disappear ... we get forced out every time we
//    refresh"
//
// The owner session token lived ONLY in `sessionStorage` — tab-scoped, gone when
// the tab or the browser closes — and the durable copy was written exclusively
// inside the Even App WebView. So in a plain browser every new tab and every
// restart was signed out with no warning, and Settings → Devices (which reads
// with that token) came back empty as a result. Separately, `devicesList` read
// the response's `ok` flag and THREW IT AWAY, so a 401 rendered exactly like
// "nothing is paired" — the empty list the user reported, drawn from a failure.
//
// Three rules, and the third is the one that keeps being rewritten by accident:
//
//   1. The durable copy is consulted in EVERY environment, not just the Even App.
//   2. A durable read TOPS UP the `sessionStorage` fast path, so the first async
//      read in a fresh tab makes every later synchronous read cheap.
//   3. A FAILED DEVICE READ IS NOT AN EMPTY LIST. The caller has to be able to
//      tell the two apart or the report comes straight back.
//
// The REAL `auth.tsx` and `durable-docs.ts` are bundled and the real functions
// are CALLED — `anyOwnerToken` and `devicesList` are exported for this file alone,
// because a harness that re-implemented them would agree with itself and prove
// nothing. The host bridge is a Map standing in for the Even App's SDK store.
//
// Run: node tools/hub-session-sim.mjs   (judged on EXIT CODE)

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${
      ok ? '' : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`
    }`,
  );
};
const ok = (label, cond) => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

// ── The fake host, installed BEFORE any module loads ────────────────────────
const localStore = new Map();
const sessionStore = new Map();
const hostStore = new Map();

// `defineProperty`, not assignment: recent Node ships a read-only `navigator`,
// and a plain assignment there is a TypeError before a single check runs.
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

define('localStorage', {
  getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => localStore.set(k, String(v)),
  removeItem: (k) => localStore.delete(k),
  clear: () => localStore.clear(),
});
define('sessionStorage', {
  getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
  setItem: (k, v) => sessionStore.set(k, String(v)),
  removeItem: (k) => sessionStore.delete(k),
  clear: () => sessionStore.clear(),
});
define('window', globalThis);
define('navigator', { userAgent: 'node' });

/**
 * The Even App's SDK store. `setLocalStorage(key, '')` is how the SDK clears a
 * key, and `durableGet` reads an empty string back as absent — so the double has
 * to model that, not `Map.delete` semantics.
 */
const bridge = {
  setLocalStorage: async (k, v) => {
    if (v === '') hostStore.delete(k);
    else hostStore.set(k, String(v));
  },
  getLocalStorage: async (k) => (hostStore.has(k) ? hostStore.get(k) : ''),
};

const requests = [];
let reply = { ok: true, status: 200, body: { ok: true, devices: [] } };
define('fetch', async (url, init = {}) => {
  requests.push({ url: String(url), headers: init.headers ?? {} });
  if (reply.throw) throw new Error('relay is down');
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
    text: async () => JSON.stringify(reply.body ?? {}),
    headers: { get: () => null },
  };
});

// ── Bundle the REAL modules ─────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'hub-session-'));
const stub = join(dir, 'sdk-stub.mjs');
writeFileSync(stub, `export default {};\n`);
const outfile = join(dir, 'session.mjs');
await build({
  stdin: {
    contents: `
export { anyOwnerToken, devicesList } from './web/auth.tsx';
export {
  setDurableBridge, getDurableBridge,
  saveOwnerSession, loadOwnerSession, clearOwnerSession,
} from './durable-docs.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  jsx: 'automatic',
  alias: { '@evenrealities/even_hub_sdk': stub },
  define: { 'import.meta.env': '{}' },
});

const m = await import(pathToFileURL(outfile).href);
const { anyOwnerToken, devicesList, setDurableBridge, saveOwnerSession, loadOwnerSession, clearOwnerSession } = m;

const OWNER_KEY = 'hub:owner';
const SESS_KEY = 'hub:session';
const EMAIL_KEY = 'hub:auth';

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 1. A plain browser: the tab cache is empty and the durable copy answers ==');
{
  check('no bridge in a plain browser', m.getDurableBridge(), null);
  check('no session anywhere yet', await anyOwnerToken(), null);

  await saveOwnerSession({ token: 'T1-owner-token', email: 'nic@local.dev' });
  // THE SAVE MUST NOT DEPEND ON A BRIDGE. `saveOwnerSession` used to be called
  // only inside the Even App, so a browser never wrote the durable copy at all.
  check('a plain browser still writes the durable copy', localStore.has(OWNER_KEY), true);
  check('and reads it back', await loadOwnerSession(), { token: 'T1-owner-token', email: 'nic@local.dev' });
  check('saving does not touch the tab cache', sessionStore.size, 0);

  // THE FIX. This is the call that used to return null in a fresh tab.
  check('the durable token is found with an empty sessionStorage', await anyOwnerToken(), {
    token: 'T1-owner-token',
    email: 'nic@local.dev',
  });
  // …and it TOPS UP the fast path, so the synchronous readers in event handlers
  // and render see it too.
  check('the fast path was topped up', sessionStore.get(SESS_KEY), 'T1-owner-token');
  check('email and all', sessionStore.get(EMAIL_KEY), 'nic@local.dev');
  check('a second read is served the same way', (await anyOwnerToken()).token, 'T1-owner-token');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 2. The report: a new tab, and a restart ==');
{
  // A new tab gets an EMPTY sessionStorage and the same durable storage. This is
  // the exact state that used to render the login screen over a valid session.
  sessionStore.clear();
  check('a new tab is still signed in', (await anyOwnerToken())?.token, 'T1-owner-token');

  // A full restart clears the tab too — same storage, same answer.
  sessionStore.clear();
  localStore.clear();
  // (nothing to read anywhere) — the browser closed and the durable copy is
  // still there in reality, so restore it and read again.
  localStore.set(OWNER_KEY, JSON.stringify({ token: 'T1-owner-token', email: 'nic@local.dev' }));
  check('a restart is still signed in', (await anyOwnerToken())?.token, 'T1-owner-token');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 3. The Even App: browser storage is wiped, the host store is not ==');
{
  setDurableBridge(bridge);
  ok('the bridge is live', !!m.getDurableBridge());
  sessionStore.clear();
  localStore.clear();
  hostStore.clear();

  await saveOwnerSession({ token: 'T2-owner-token', email: null });
  // Dual write: the host store is the ONLY layer that survives a Flutter WebView
  // restart, and localStorage is the fallback in a browser/simulator.
  check('written to the host store', JSON.parse(hostStore.get(OWNER_KEY)).token, 'T2-owner-token');
  check('and to localStorage', JSON.parse(localStore.get(OWNER_KEY)).token, 'T2-owner-token');

  // EXACTLY what a WebView restart looks like: both browser stores wiped.
  localStore.clear();
  sessionStore.clear();
  check('the WebView restart kept the sign-in', (await anyOwnerToken())?.token, 'T2-owner-token');
  check('an email of null stays null', (await anyOwnerToken())?.email, null);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 4. A value that predates the bridge is migrated up ==');
{
  // An install that signed in BEFORE the bridge resolved, or before this release,
  // has its session only in localStorage. Reading it must carry it up, or the
  // next WebView restart loses it.
  hostStore.clear();
  localStore.clear();
  sessionStore.clear();
  localStore.set(OWNER_KEY, JSON.stringify({ token: 'T3-legacy', email: 'legacy@local.dev' }));

  check('the browser-only copy is read', (await loadOwnerSession())?.token, 'T3-legacy');
  check('…and migrated up to the host store', JSON.parse(hostStore.get(OWNER_KEY)).token, 'T3-legacy');

  localStore.clear();
  check('so a wiped browser store still finds it', (await loadOwnerSession())?.token, 'T3-legacy');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 5. A corrupt or empty copy signs out; it does not crash ==');
{
  const cases = [
    ['not json at all', 'not json', null],
    ['an empty object', '{}', null],
    ['a token of the wrong type', '{"token":42}', null],
    ['an empty token', '{"token":""}', null],
  ];
  for (const [label, raw, want] of cases) {
    hostStore.set(OWNER_KEY, raw);
    localStore.clear();
    check(label, await loadOwnerSession(), want);
  }
  // A missing email is not a reason to refuse the session.
  hostStore.set(OWNER_KEY, '{"token":"T4","email":42}');
  check('a bad email field degrades to null', await loadOwnerSession(), { token: 'T4', email: null });

  hostStore.clear();
  localStore.clear();
  check('nothing stored reads as signed out', await loadOwnerSession(), null);
  check('and so does the token lookup', await anyOwnerToken(), null);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 6. Signing out really clears both layers ==');
{
  await saveOwnerSession({ token: 'T5', email: 'nic@local.dev' });
  sessionStore.set(SESS_KEY, 'T5');
  await clearOwnerSession();
  check('the host store is cleared', hostStore.has(OWNER_KEY), false);
  check('the browser copy is cleared', localStore.has(OWNER_KEY), false);
  // The tab cache is the caller's to clear — but it must NOT be able to resurrect
  // the session on its own once the durable copy is gone.
  sessionStore.clear();
  check('nothing comes back', await anyOwnerToken(), null);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 7. Settings → Devices, from a tab with an empty sessionStorage ==');
{
  setDurableBridge(null);
  hostStore.clear();
  localStore.clear();
  sessionStore.clear();
  await saveOwnerSession({ token: 'T6-owner-token', email: 'nic@local.dev' });
  check('the tab cache really is empty', sessionStore.size, 0);

  // The read that renders the list uses the DURABLE token (§2.3), which is the
  // only reason a freshly opened tab can render it at all.
  const tok = await anyOwnerToken();
  check('the durable token is the one used', tok.token, 'T6-owner-token');

  requests.length = 0;
  reply = {
    ok: true,
    status: 200,
    body: { ok: true, devices: [{ deviceId: 'dev-1', email: 'nic@local.dev', approvedAt: 5 }] },
  };
  check('a good read reports success', await devicesList(tok.token), {
    ok: true,
    devices: [{ deviceId: 'dev-1', email: 'nic@local.dev', approvedAt: 5 }],
  });
  check('it asked the relay', requests[0].url, '/api/devices');
  check('with the session as a bearer token', requests[0].headers.Authorization, 'Bearer T6-owner-token');

  // THE SECOND HALF OF THE REPORT. A refusal must be a failure, not an empty
  // list — the difference between "you have no devices" and "we could not ask".
  reply = { ok: false, status: 401, body: { ok: false, error: 'not signed in' } };
  const denied = await devicesList(tok.token);
  check('a 401 is a FAILURE, not an empty list', denied.ok, false);
  check('with the relay\'s reason', denied.error, 'not signed in');

  reply = { ok: true, status: 200, body: { ok: false, error: 'store reset' } };
  const refused = await devicesList(tok.token);
  check('a 200 carrying ok:false is still a failure', refused.ok, false);
  check('…with its reason kept', refused.error, 'store reset');

  reply = { throw: true };
  const down = await devicesList(tok.token);
  check('a dead relay is a failure too', down.ok, false);
  check('named honestly', down.error, 'network error');

  // And a genuinely empty list is still a success — the one case where "nothing
  // paired" is the truth.
  reply = { ok: true, status: 200, body: { ok: true, devices: [] } };
  check('an empty list is a SUCCESS', await devicesList(tok.token), { ok: true, devices: [] });
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 8. The UI reads through those paths, in that order ==');
{
  const src = readFileSync(resolve(here, '../src/web/auth.tsx'), 'utf8');
  const has = (label, needle) => ok(label, src.includes(needle));

  // 1) The durable fallback, reached only when the tab cache is empty.
  const inAny = src.slice(src.indexOf('export async function anyOwnerToken'));
  ok('the fast path is tried first', inAny.indexOf('sessionStorage.getItem(SESSION_KEY)') < inAny.indexOf('loadOwnerSession()'));
  has('and the durable copy is the fallback', 'const saved = await loadOwnerSession();');
  has('which tops up the tab cache', 'sessionStorage.setItem(SESSION_KEY, saved.token);');

  // 2) Boot restores in EVERY environment. The `inEvenApp` gate here was the bug.
  ok('boot restores without an Even App gate', src.includes('if (!tok) {') && !/if \(!tok && inEvenApp\)/.test(src));
  ok('the retry loop is bounded by the bridge, not by the environment', src.includes('if (!inEvenApp) break;'));
  has('a dead token clears the durable copy too', '        void clearOwnerSession();');

  // 3) Signing in always mirrors durably — no `detectEvenApp()` in front of it.
  has('sign-in mirrors the session durably', 'void saveOwnerSession({ token: sessionToken, email: em });');
  ok('and does not gate the mirror on the Even App', !/if \(detectEvenApp\(\)\)\s*void saveOwnerSession/.test(src));

  // 4) The device list goes through the durable token and reports its failures.
  const inRefresh = src.slice(src.indexOf('const refreshDevices = useCallback'), src.indexOf('// Settings → Devices is a RELAY read'));
  ok('the list reads with the durable token', inRefresh.includes('const tok = await anyOwnerToken();'));
  ok('a failure sets the error BEFORE anything replaces the list', inRefresh.indexOf('setError(why') < inRefresh.indexOf('setDevices(list)'));
  ok('and returns instead of blanking it', /if \(!ok\) \{\s*setError\([\s\S]{0,120}return;\s*\}/.test(inRefresh));
  ok('only a good read replaces the list', /setError\(null\);\s*setDevices\(list\);/.test(inRefresh));

  // 5) A relay read gets no `hub-changed` nudge, so returning to the tab re-reads.
  has('returning to the tab re-reads the list', "window.addEventListener('focus', onBack);");
  has('and the cleanup removes it', "window.removeEventListener('focus', onBack);");
  ok('a hidden tab does not re-read', src.includes("document.visibilityState !== 'hidden'"));
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
