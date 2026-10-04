#!/usr/bin/env node
// The relay auth store's conversation with the hub — driven against a stub.
//
// WHY THIS EXISTS. `.g2-hub-auth.json` lives on the container's EPHEMERAL
// filesystem, so a redeploy wiped every owner session and every approved device:
// the app got a 401, signed the user out, and Settings → Devices came back empty.
// The blob now also lives in the hub. This harness is the whole of that
// conversation, with a stub standing in for the hub so every branch is reachable
// — including the ones a live server would never show on demand.
//
// The three rules it exists to protect, each of which is SILENT when it breaks:
//
//   §2  RECONCILE BEFORE ANYTHING IS SERVED. On a fresh container the file is
//       empty while the hub holds the real sessions. If the listener answered
//       first, a valid token would 401 for a moment — and the app's
//       `onAuthRejected` path signs the user straight out. The bug this whole
//       change fixes, reintroduced as a startup race.
//   §3  A HUB FAILURE IS NEVER A REQUEST FAILURE. Sign-in must not start
//       depending on the hub being reachable, because it never did before. Every
//       failure here degrades to "the file, alone" — and a permanent refusal
//       (the 403 a stricter backend returns) must stop costing a timeout on every
//       single write.
//   §4  THE SWEEP RUNS BEFORE THE BYTES LEAVE, and pushes are coalesced and
//       serialised, so the stored copy is bounded and the newest blob is the one
//       that lands last.
//
// §5 proves the RELAY does the above — including that `reconcile()` is awaited
// BEFORE `server.listen`, which is the entire first rule.
//
// Run: node tools/relay-auth-sync-sim.mjs   (judged on EXIT CODE)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_BLOB_VERSION, SESSION_TTL_MS, digestToken } from '../../web/server/relay-auth.mjs';
import { AUTH_HUB_PATH, createAuthStoreSync } from '../../web/server/relay-auth-sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const T = 1_800_000_000_000;
const TOKEN = 'devownerecb53dde7bf41d07';
const KEY = digestToken(TOKEN);
const row = (createdAt, email = 'nic@local.dev') => ({ email, createdAt });

/**
 * A stubbed hub: scripted per `METHOD path`, recording every call.
 * An `error` entry throws instead of answering, so "the hub is unreachable" is a
 * real thrown failure and not just a status a live server would rarely produce.
 */
function fakeHub(script = []) {
  const calls = [];
  const pending = [...script];
  return {
    calls,
    puts: () => calls.filter((c) => c.method === 'PUT'),
    gets: () => calls.filter((c) => c.method === 'GET'),
    async call(method, path, opts = {}) {
      calls.push({ method, path, body: opts.body });
      const rule = pending.find((r) => r.method === method && r.path === path);
      if (rule) {
        if (rule.error) throw new Error(rule.error);
        if (rule.pending) await sleep(rule.pending);
        return { status: rule.status, text: rule.text ?? '' };
      }
      // Unscripted = "we do not care, answer 500" so a stray call is visible in
      // `calls` rather than silently tolerated.
      return { status: 500, text: '{"ok":false,"code":"INTERNAL"}' };
    },
  };
}

/** A relay store + file, exactly as `local-sse.mjs` holds them. */
function makeRelay(initial = { sessions: {}, devices: {} }) {
  const state = { store: initial, saves: 0 };
  return {
    state,
    getStore: () => state.store,
    setStore: (next) => {
      state.store = next;
    },
    save: () => {
      state.saves++;
    },
    /** The file on disk, as a deep copy — what a restart would read back. */
    file: () => JSON.parse(JSON.stringify(state.store)),
  };
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 1. The route, and the envelope ==');
check('the blob lives at one fixed path', AUTH_HUB_PATH, '/relay/auth');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 2. Adopt at boot: the hub is the authority ==');
{
  const hub = fakeHub([
    {
      method: 'GET',
      path: AUTH_HUB_PATH,
      status: 200,
      text: JSON.stringify({ ok: true, rev: 9, value: { v: 1, sessions: { [KEY]: row(T) }, devices: { 'dev-1': { createdAt: T } } } }),
    },
  ]);
  const relay = makeRelay({ sessions: {}, devices: {} });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500, debounceMs: 10 });
  const outcome = await sync.reconcile();

  check('an existing blob is ADOPTED', outcome, 'adopted');
  check('the hub session is now this process\'s session', relay.state.store.sessions[KEY], row(T));
  check('…and so are the approved devices', relay.state.store.devices, { 'dev-1': { createdAt: T } });
  check('the file was rewritten from the hub', relay.file().sessions[KEY], row(T));
  check('the store was written BEFORE anything else', relay.state.saves >= 1, true);
  check('and the hub was read exactly once', hub.gets().length, 1);
  check('with no upload (the hub already had it)', hub.puts().length, 0);
  ok('and wrapped into the versioned shape', relay.state.store.v === AUTH_BLOB_VERSION);
}
{
  // The hub wins even when the file holds a session the hub does not know about.
  // Anything else makes the two copies diverge forever.
  const hub = fakeHub([
    { method: 'GET', path: AUTH_HUB_PATH, status: 200, text: JSON.stringify({ value: { v: 1, sessions: {}, devices: {} } }) },
  ]);
  const relay = makeRelay({ sessions: { [digestToken('stale-local')]: row(T) }, devices: {} });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500 });
  check('an empty hub blob still wins', await sync.reconcile(), 'adopted');
  check('the stale local session is gone', Object.keys(relay.state.store.sessions), []);
}
{
  // A blob the OLD relay uploaded is token-keyed. Adopting it verbatim would
  // leave every session unreachable, so the re-key has to happen on the way in.
  const hub = fakeHub([
    { method: 'GET', path: AUTH_HUB_PATH, status: 200, text: JSON.stringify({ value: { sessions: { [TOKEN]: row(T) }, devices: {} } }) },
  ]);
  const relay = makeRelay();
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500 });
  check('a legacy-shaped hub blob is adopted', await sync.reconcile(), 'adopted');
  check('…and re-keyed on the way in', Object.keys(relay.state.store.sessions), [KEY]);
  check('…so the owner\'s token still resolves', relay.state.store.sessions[KEY], row(T));
  check('the re-keyed blob is written back to the file', relay.file().sessions[KEY], row(T));
}
{
  // 200 with nothing usable in it. Treated as "no blob", never as "the user has
  // no sessions" followed by an upload of an empty store.
  const hub = fakeHub([{ method: 'GET', path: AUTH_HUB_PATH, status: 200, text: 'not json' }]);
  const relay = makeRelay({ sessions: { [KEY]: row(T) }, devices: {} });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500 });
  check('an unparseable 200 keeps the local store', await sync.reconcile(), 'local');
  check('the local session is untouched', relay.state.store.sessions[KEY], row(T));
  check('and nothing was uploaded over it', hub.puts().length, 0);
}

console.log('\n== 3. Upload at boot: nothing was ever stored ==');
{
  const hub = fakeHub([
    { method: 'GET', path: AUTH_HUB_PATH, status: 404, text: '{"ok":false,"code":"NOT_FOUND"}' },
    { method: 'PUT', path: AUTH_HUB_PATH, status: 201, text: '{"ok":true,"rev":1}' },
  ]);
  const relay = makeRelay({ sessions: { [KEY]: row(T) }, devices: { 'dev-1': { createdAt: T } } });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500 });
  check('an unknown blob is UPLOADED', await sync.reconcile(), 'uploaded');
  check('the upload went to the right path', hub.puts()[0].path, AUTH_HUB_PATH);
  check('as a PUT', hub.puts()[0].method, 'PUT');
  // THE UPGRADE PATH: a live deployment's sessions and devices carry over into
  // the hub instead of being invalidated by the upgrade.
  check('the local session was carried into the hub', hub.puts()[0].body.value.sessions[KEY], row(T));
  check('…along with the approved devices', hub.puts()[0].body.value.devices, { 'dev-1': { createdAt: T } });
  check('the payload is the Part-1 envelope', Object.keys(hub.puts()[0].body), ['value']);
  check('the file was saved too', relay.state.saves >= 1, true);
}
{
  // The upload fails, but boot must still succeed — from the file.
  const hub = fakeHub([
    { method: 'GET', path: AUTH_HUB_PATH, status: 404, text: '{}' },
    { method: 'PUT', path: AUTH_HUB_PATH, status: 500, text: '{}' },
  ]);
  const relay = makeRelay({ sessions: { [KEY]: row(T) }, devices: {} });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500 });
  check('a failed upload still boots', await sync.reconcile(), 'local');
  check('from the local file', relay.state.store.sessions[KEY], row(T));
  check('and the file was still saved', relay.state.saves >= 1, true);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 4. A hub that is down, slow, or refusing never fails anything ==');
{
  const hub = fakeHub([{ method: 'GET', path: AUTH_HUB_PATH, error: 'ECONNREFUSED' }]);
  const relay = makeRelay({ sessions: { [TOKEN]: row(T) }, devices: {} });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500 });
  check('an unreachable hub boots from the file', await sync.reconcile(), 'local');
  // THE OFFLINE UPGRADE: this is the case where a legacy file meets a dead hub,
  // and the re-key still has to have happened or every session is gone.
  check('a legacy file is STILL re-keyed with the hub down', Object.keys(relay.state.store.sessions), [KEY]);
  check('…so the token still resolves offline', relay.state.store.sessions[KEY], row(T));
  check('nothing was uploaded', hub.puts().length, 0);
}
{
  const hub = fakeHub([{ method: 'GET', path: AUTH_HUB_PATH, status: 503, pending: 600 }]);
  const relay = makeRelay({ sessions: { [KEY]: row(T) }, devices: {} });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 30 });
  const started = Date.now();
  check('a hub that never answers times out to the file', await sync.reconcile(), 'local');
  ok('…within the boot budget, not the hub\'s', Date.now() - started < 1500);
  check('the local session survives', relay.state.store.sessions[KEY], row(T));
}
{
  // 4xx/5xx other than 403 are TRANSIENT — the deployment may recover, and the
  // next write should try again.
  const hub = fakeHub([{ method: 'GET', path: AUTH_HUB_PATH, status: 500, text: '{}' }]);
  const relay = makeRelay({ sessions: { [KEY]: row(T) }, devices: {} });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500 });
  check('a 500 boots from the file', await sync.reconcile(), 'local');
  check('and the hub is still considered usable', sync.hubUsable(), true);
  check('the store is intact', relay.state.store.sessions[KEY], row(T));
}
{
  // 403 is what a backend that still gates the route behind an owner credential
  // answers — it will answer it for THIS credential forever. Treating it as
  // transient would put a timeout in front of every single write.
  const warned = [];
  const hub = fakeHub([
    { method: 'GET', path: AUTH_HUB_PATH, status: 403, text: '{"ok":false,"code":"SCOPE_DENIED"}' },
  ]);
  const relay = makeRelay({ sessions: { [KEY]: row(T) }, devices: {} });
  const sync = createAuthStoreSync({
    ...relay,
    call: hub.call,
    now: () => T,
    timeoutMs: 500,
    debounceMs: 5,
    warn: (m) => warned.push(m),
  });
  check('a refusing hub boots from the file', await sync.reconcile(), 'local');
  check('and is marked permanently unusable', sync.hubUsable(), false);
  ok('the refusal is reported, not swallowed', warned.some((m) => m.includes('403')));
  check('the session is untouched', relay.state.store.sessions[KEY], row(T));

  // From here on the hub must not be called at all — a write still saves the
  // file and still succeeds; it just stops paying for a doomed round trip.
  const before = hub.calls.length;
  relay.state.store.sessions[digestToken('new')] = row(T + 1);
  sync.markChanged();
  await sleep(40);
  check('a write after a refusal makes NO hub call', hub.calls.length, before);
  check('…but still persists the file', relay.state.saves >= 2, true);
  check('a second reconcile does not retry either', await sync.reconcile(), 'local');
  check('…and makes no hub call', hub.calls.length, before);
}
{
  // The refusal can also arrive on the PUT, if the gate is on writes only.
  const hub = fakeHub([
    { method: 'GET', path: AUTH_HUB_PATH, status: 404, text: '{}' },
    { method: 'PUT', path: AUTH_HUB_PATH, status: 403, text: '{"ok":false,"code":"SCOPE_DENIED"}' },
  ]);
  const relay = makeRelay({ sessions: { [KEY]: row(T) }, devices: {} });
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500, debounceMs: 5 });
  check('a refused upload keeps running from the file', await sync.reconcile(), 'local');
  check('and the refusal is remembered', sync.hubUsable(), false);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 5. A write mirrors the whole blob, once, after the fact ==');
{
  const hub = fakeHub([{ method: 'GET', path: AUTH_HUB_PATH, status: 200, text: JSON.stringify({ value: { v: 1, sessions: {}, devices: {} } }) }]);
  const relay = makeRelay();
  const sync = createAuthStoreSync({ ...relay, call: hub.call, now: () => T, timeoutMs: 500, debounceMs: 20 });
  await sync.reconcile();

  const savesBefore = relay.state.saves;
  relay.state.store.sessions[KEY] = row(T);
  sync.markChanged();
  // THE FILE FIRST: a logout, an approval or a restart must never wait on a
  // debounce, and must never wait on the hub.
  check('the file is saved synchronously', relay.state.saves, savesBefore + 1);
  check('…before any hub call has happened', hub.puts().length, 0);
  await sleep(80);
  check('the mirror write follows on the debounce', hub.puts().length, 1);
  check('and it carries the whole, swept blob', hub.puts()[0].body.value.sessions[KEY], row(T));
  check('…stamped with the blob version', hub.puts()[0].body.value.v, AUTH_BLOB_VERSION);

  // Coalescing: approve + revoke land in the same second and must not be two
  // round trips — the LAST blob is the one that matters.
  hub.calls.length = 0;
  relay.state.store.sessions[digestToken('a')] = row(T + 1);
  sync.markChanged();
  relay.state.store.sessions[digestToken('b')] = row(T + 2);
  sync.markChanged();
  relay.state.store.sessions[digestToken('c')] = row(T + 3);
  sync.markChanged();
  await sleep(80);
  check('three writes inside the window make ONE call', hub.puts().length, 1);
  check('…carrying all three sessions', Object.keys(hub.puts()[0].body.value.sessions).length, 4);

  // The sweep runs on the way out: an expired row never leaves the process.
  hub.calls.length = 0;
  relay.state.store.sessions[digestToken('dead')] = row(T - SESSION_TTL_MS - 1);
  sync.markChanged();
  await sleep(80);
  check('an expired session is swept before the upload', hub.puts()[0].body.value.sessions[digestToken('dead')], undefined);

  // And a write whose mirror fails must not fail the write.
  hub.calls.length = 0;
  const dead = fakeHub([{ method: 'PUT', path: AUTH_HUB_PATH, error: 'socket hang up' }]);
  const sync2 = createAuthStoreSync({ ...relay, call: dead.call, now: () => T, timeoutMs: 500, debounceMs: 5 });
  relay.state.store.sessions[digestToken('d')] = row(T + 4);
  ok('a write reports success regardless of the mirror', (sync2.markChanged(), true));
  await sleep(40);
  check('the file still holds the write', relay.state.store.sessions[digestToken('d')], row(T + 4));
}
{
  // Pushes are SERIALISED: a slow first push must not let an older blob land
  // after a newer one, or the hub ends up with stale sessions.
  const order = [];
  let calls = 0;
  const relay = makeRelay();
  const sync = createAuthStoreSync({
    ...relay,
    now: () => T,
    debounceMs: 5,
    timeoutMs: 500,
    call: async (method, path, opts) => {
      if (method !== 'PUT') return { status: 404, text: '{}' };
      calls++;
      const n = calls;
      order.push(`start:${n}`);
      await sleep(n === 1 ? 60 : 0); // the first is slow
      order.push(`end:${n}`);
      return { status: 200, text: '{"ok":true}' };
    },
  });
  relay.state.store.sessions[digestToken('one')] = row(T);
  sync.markChanged();
  await sleep(20);
  relay.state.store.sessions[digestToken('two')] = row(T + 1);
  sync.markChanged();
  await sleep(120);
  check('two separated writes push twice', calls, 2);
  check('and never overlap', order, ['start:1', 'end:1', 'start:2', 'end:2']);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 6. The relay wires it up in the right ORDER ==');
const relaySrc = readFileSync(resolve(here, '../../web/server/local-sse.mjs'), 'utf8');
const has = (label, needle) => ok(label, relaySrc.includes(needle));

const reconcileAt = relaySrc.indexOf('await authSync.reconcile();');
const listenAt = relaySrc.indexOf('server.listen(PORT');
ok('reconcile is awaited at boot', reconcileAt > 0);
// THE FIRST RULE. If the listener wins this race, a fresh container 401s a valid
// token for a moment and the app signs the user out — the reported bug, restored.
ok('…BEFORE the listener accepts anything', reconcileAt > 0 && listenAt > 0 && reconcileAt < listenAt);
ok('…and after the file has been loaded', relaySrc.indexOf('loadAuthStore();') < reconcileAt);

has('the sync is built from its own module', "from './relay-auth-sync.mjs'");
has('the hub caller is the relay\'s own hub client', 'client.call(method, path, opts)');
ok('the store the sync edits is the relay\'s store', /setStore: \(next\) => \{\s*authStore = next;\s*\}/.test(relaySrc));
ok('and the file it saves is the relay\'s file', /save: persistAuthStore/.test(relaySrc));
// Every mutation site must go through the durable path. A single leftover
// `persistAuthStore()` on a mutation would still write the file — and silently
// never mirror it, so a redeploy would lose that change and nothing else.
check(
  'all five auth mutations use markAuthChanged()',
  (relaySrc.match(/markAuthChanged\(\);/g) || []).length,
  5,
);
ok('markAuthChanged delegates to the sync', /function markAuthChanged\(\) \{\s*authSync\.markChanged\(\);/.test(relaySrc));
// Exactly one direct file write may remain: the TTL reaper inside the lookup,
// which is a local sweep and not a mutation. A second one would be a route that
// writes the file and never mirrors it.
check('only the lookup\'s TTL reaper writes the file directly', (relaySrc.match(/^\s*persistAuthStore\(\);/gm) || []).length, 1);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
