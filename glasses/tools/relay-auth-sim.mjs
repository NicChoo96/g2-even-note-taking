#!/usr/bin/env node
// The relay's auth store, made durable in the hub — the pure parts, driven
// directly.
//
// WHY THIS EXISTS — reported: "the paired device and also our google login auth
// on refresh, seems like its not persist… So we get forced out everytime we
// refresh or the paired devices simply disappear."
//
// Part of that was the client (sessionStorage-only — see session-durability-sim),
// and part of it is here: `.g2-hub-auth.json` sits on the container's EPHEMERAL
// filesystem, so every redeploy wiped every owner session AND every approved
// device, and the app then signed the user out on every call. The blob now also
// lives in the hub, which is durable.
//
// That change introduces two ways to lose exactly what it protects, and both are
// silent:
//
//   §2  KEYING. A database dump must not be a working key ring, so a session is
//       keyed by `sha256(token)`. The file on the live server is keyed by the
//       TOKEN, and a hashed lookup finds nothing in a legacy file — so without
//       the in-place re-key, deploying this change would sign out every user it
//       was written to keep signed in.
//   §3  BOUNDS. Nothing else ever removes a session. Without the TTL sweep and
//       the 50-newest cap the blob grows forever and is pushed on every write.
//
// The point of §5 is that the RELAY uses these rules and not a second copy of
// them. `local-sse.mjs` starts a server on import, so that half is asserted
// against its source.
//
// Run: node tools/relay-auth-sim.mjs   (judged on EXIT CODE)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTH_BLOB_VERSION,
  DIGEST_RE,
  MAX_SESSIONS,
  SESSION_TTL_MS,
  authBlobOf,
  describeAuthBlob,
  digestToken,
  normaliseAuthBlob,
  rekeySessions,
  sweepSessions,
} from '../../web/server/relay-auth.mjs';

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

const T0 = 1_800_000_000_000;
/** A session row of the shape the relay writes. */
const row = (createdAt, email = 'nic@local.dev') => ({ email, createdAt });

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 1. A session key is a digest, never the token ==');
const RAW = 'devownerecb53dde7bf41d07';
const d = digestToken(RAW);
ok('the digest is 64 hex characters', DIGEST_RE.test(d));
ok('…which is the format the store accepts as a key', DIGEST_RE.test(d));
ok('the digest is not the token', d !== RAW);
ok('and the token does not appear inside it', !d.includes(RAW));
check('hashing is deterministic', digestToken(RAW), d);
ok('a different token hashes differently', digestToken(RAW + 'x') !== d);
// A dump of the blob must not be replayable, which is the entire reason for this
// indirection: nothing in it can be presented as a bearer token.
ok('a token of any length is accepted', DIGEST_RE.test(digestToken('t')) && DIGEST_RE.test(digestToken('x'.repeat(500))));
ok('a non-string is not a crash', DIGEST_RE.test(digestToken(undefined)));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 2. A legacy token-keyed file is re-keyed IN PLACE ==');
// This is the upgrade path for the file already sitting on the live server, and
// getting it wrong signs everyone out the moment this ships.
const legacy = { [RAW]: row(T0), [RAW + '2']: row(T0 + 1) };
const re = rekeySessions(legacy);
check('the legacy keys became digests', Object.keys(re.sessions).sort(), [
  digestToken(RAW),
  digestToken(RAW + '2'),
].sort());
check('the legacy token no longer works as a key', re.sessions[RAW], undefined);
check('…but its digest does', re.sessions[digestToken(RAW)], row(T0));
check('the rows themselves are untouched', re.sessions[digestToken(RAW)].email, 'nic@local.dev');
check('re-keying is reported as a change', re.changed, true);

// Already-keyed input must be left exactly alone — and must NOT report a change,
// or every boot would rewrite the file and push the blob for nothing.
const already = { [digestToken(RAW)]: row(T0) };
const re2 = rekeySessions(already);
check('a digest-keyed map is untouched', re2.sessions, already);
check('…and reports no change', re2.changed, false);

// A collision can only happen if the same token is somehow present under both
// spellings. The DIGEST spelling must win, because that is what a lookup
// computes — keeping the raw key would leave the row unreachable.
const both = { [RAW]: row(T0), [digestToken(RAW)]: row(T0 + 5) };
const re3 = rekeySessions(both);
check('on collision the digest spelling wins', re3.sessions[digestToken(RAW)], row(T0 + 5));

check('a missing map is safe', rekeySessions(undefined).sessions, {});
check('an array is not a session map', rekeySessions([]).sessions, {});
check('a null map is safe', rekeySessions(null).sessions, {});

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 3. The blob is bounded before it is stored ==');
const fresh = digestToken('fresh');
const aging = digestToken('aging');
const ancient = digestToken('ancient');
const undated = digestToken('undated');
const swept = sweepSessions(
  {
    [fresh]: row(T0),
    [aging]: row(T0 - SESSION_TTL_MS + 1000), // one second from expiry
    [ancient]: row(T0 - SESSION_TTL_MS - 1), // one millisecond past it
    [undated]: { email: 'x' },
  },
  T0,
);
check('the fresh row survives', Object.keys(swept.sessions), [fresh, aging]);
check('a row inside the TTL survives even at its very edge', swept.sessions[aging], row(T0 - SESSION_TTL_MS + 1000));
check('a row past the TTL is dropped', swept.sessions[ancient], undefined);
check('a row with no timestamp is dropped (it could never expire)', swept.sessions[undated], undefined);
check('the sweep reports what it removed', swept.changed, true);
// The boundary is a real one: exactly at the TTL is still alive.
const edge = sweepSessions({ [aging]: row(T0 - SESSION_TTL_MS) }, T0);
check('exactly at the TTL is still alive', Object.keys(edge.sessions), [aging]);

// The cap. Nothing else ever removes a session, so this is the only thing
// standing between repeated sign-ins and an unbounded push on every write.
const many = {};
for (let i = 0; i < MAX_SESSIONS + 12; i++) many[digestToken(`tok-${i}`)] = row(T0 + i);
const capped = sweepSessions(many, T0);
check(`at most ${MAX_SESSIONS} sessions are kept`, Object.keys(capped.sessions).length, MAX_SESSIONS);
check('the cap dropped something', capped.changed, true);
ok('the NEWEST sessions are the ones kept', capped.sessions[digestToken(`tok-${MAX_SESSIONS + 11}`)] !== undefined);
ok('the oldest are the ones dropped', capped.sessions[digestToken('tok-0')] === undefined);
// Under the cap, order and identity must be preserved exactly.
const under = sweepSessions({ [fresh]: row(T0) }, T0);
check('a small map is returned intact', under.sessions, { [fresh]: row(T0) });
check('…and reports no change', under.changed, false);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 4. Anything can be shaped into a store this process trusts ==');
const legacyFile = { sessions: { [RAW]: row(T0) }, devices: { 'dev-1': { createdAt: T0 } } };
const n = normaliseAuthBlob(legacyFile, T0);
check('the shape is versioned', n.value.v, AUTH_BLOB_VERSION);
check('the legacy session was re-keyed', Object.keys(n.value.sessions), [digestToken(RAW)]);
check('devices pass through untouched', n.value.devices, { 'dev-1': { createdAt: T0 } });
check('the re-key is reported as a change', n.changed, true);

// IDEMPOTENCE — this runs at boot, on every adopted read and before every write.
// If a second pass reported a change, every boot would rewrite the file and push
// the blob on a store that had not moved.
const n2 = normaliseAuthBlob(n.value, T0);
check('a second pass changes nothing', n2.changed, false);
check('…and yields the same store', n2.value, n.value);

// Everything the file could plausibly contain, including a half-written one.
for (const [label, input] of [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'not json'],
  ['an array', []],
  ['a number', 7],
  ['an empty object', {}],
]) {
  const out = normaliseAuthBlob(input, T0);
  check(`${label} becomes an empty, versioned store`, out.value, {
    v: AUTH_BLOB_VERSION,
    sessions: {},
    devices: {},
  });
}
// A corrupt/missing blob must always be REPLACEABLE — never a reason for the
// relay to refuse to start.
ok('a device map of the wrong type is replaced, not trusted', Array.isArray(normaliseAuthBlob({ devices: [] }, T0).value.devices) === false);

console.log('\n== 5. What is actually PUT to the hub is swept and stamped ==');
const dirty = {
  v: 0,
  sessions: { [RAW]: row(T0), [digestToken('dead')]: row(T0 - SESSION_TTL_MS - 1) },
  devices: { 'dev-1': { createdAt: T0 } },
};
const blob = authBlobOf(dirty, T0);
check('the outgoing blob is stamped', blob.v, AUTH_BLOB_VERSION);
check('the live session survives, re-keyed', Object.keys(blob.sessions), [digestToken(RAW)]);
check('the dead session is swept on the way OUT, not only on the way in', Object.keys(blob.sessions).length, 1);
ok('no raw token is in the payload', !JSON.stringify(blob).includes(RAW));

check('the log line counts both halves', describeAuthBlob({ sessions: { a: 1, b: 2 }, devices: { d: 1 } }), '2 session(s), 1 device(s)');
check('an empty blob is described honestly', describeAuthBlob({ sessions: {}, devices: {} }), '0 session(s), 0 device(s)');
check('a missing blob does not throw', describeAuthBlob(undefined), '0 session(s), 0 device(s)');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 6. THE UPGRADE ITSELF: a live session keeps working ==');
// The whole point, end to end: a file written by the version that shipped before
// this change must, after one normalise, still authenticate the very same token
// its owner holds in their browser. Nothing else in this file matters as much.
const beforeUpgrade = { sessions: { [RAW]: row(T0) }, devices: {} };
const afterUpgrade = normaliseAuthBlob(beforeUpgrade, T0).value;
check(
  'the token the user already has still resolves to their session',
  afterUpgrade.sessions[digestToken(RAW)],
  row(T0),
);
check('and to the same person', afterUpgrade.sessions[digestToken(RAW)].email, 'nic@local.dev');
// A token nobody signed in with must NOT resolve — the re-key must not turn the
// digest of one token into a collision with another.
check('an unrelated token resolves to nothing', afterUpgrade.sessions[digestToken('someone-else')], undefined);
// And the round trip the hub performs must be lossless.
const viaHub = JSON.parse(JSON.stringify(authBlobOf(afterUpgrade, T0)));
check('a JSON round trip through the hub is lossless', normaliseAuthBlob(viaHub, T0).value, afterUpgrade);
check('a session adopted from the hub still authenticates', viaHub.sessions[digestToken(RAW)].email, 'nic@local.dev');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 7. The relay uses THESE rules, not a second copy ==');
const relaySrc = readFileSync(resolve(here, '../../web/server/local-sse.mjs'), 'utf8');
const has = (label, needle) => ok(label, relaySrc.includes(needle));

has('the rules are imported from their own module', "from './relay-auth.mjs'");
// The lookup MUST hash. If this regresses to `authStore.sessions[token]`, every
// session silently stops resolving — the exact symptom being fixed.
has('a presented token is hashed before the lookup', 'const key = digestToken(token);');
ok('and the lookup uses that digest', /authStore\.sessions\[key\]/.test(relaySrc));
// Both write paths: sign-in insert, and the logout route's delete.
ok('sign-in stores under the digest', /authStore\.sessions\[digestToken\(sessionToken\)\]\s*=/.test(relaySrc));
ok('logout deletes by digest', /const key = token \? digestToken\(token\) : ''/.test(relaySrc));
// Loading must normalise, or a pre-upgrade file is read as an empty store.
has('the file is normalised on load', 'authStore = normaliseAuthBlob(JSON.parse(readFileSync(AUTH_FILE');
// The TTL is imported now, and must not be shadowed by a stale local copy that
// could drift from the one the sweep uses.
check('SESSION_TTL_MS is not redeclared in the relay', /^const SESSION_TTL_MS/m.test(relaySrc), false);
ok('the expiry branch still uses the shared TTL', /SESSION_TTL_MS/.test(relaySrc));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
