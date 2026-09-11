#!/usr/bin/env node
// SSE multiplexer harness for src/stream.ts.
//
// WHY THIS EXISTS:
//   stream.ts used to open ONE EventSource per channel (hub, agents, ai,
//   ai-ctl). A browser allows ~6 simultaneous HTTP/1.1 connections per origin
//   and an SSE response never releases its socket, so four sockets per tab
//   meant a SECOND tab starved every other request on that origin — including
//   the POST /api/llm that drives a Jarvis run. The run froze on its first model
//   turn with no HUD overlay and no error, which read as a hung provider but was
//   really a request that was never sent.
//
//   The fix multiplexes every channel onto ONE socket (`?channels=a,b,c`), with
//   the relay tagging each frame by its origin channel. That introduces logic
//   which a type check cannot protect and which manual testing only proved once:
//     1. COALESCING — four boot subscriptions must produce ONE socket, not four
//        sequential ones. Regress this and the socket cap silently returns.
//     2. URL STABILITY — the reconnect decision IS a URL comparison, so the URL
//        must be de-duplicated and ordered. Two subscribers on the same channel
//        (the agents panel and the live-run transcript both want `agents`) must
//        not change it, or the app reconnects on every panel mount.
//     3. ROUTING — the hub and the agents channel both broadcast the IDENTICAL
//        `{type:'state', state}` shape, so only the channel tag can tell them
//        apart. Getting this wrong cross-wires two stores.
//     4. BACK-COMPAT — a relay that predates multiplexing sends untagged frames.
//        Those may only be claimed when unambiguous, and must be dropped rather
//        than mis-delivered when they are not.
//     5. ISOLATION — channels pointed at DIFFERENT relays must not share a
//        socket, or one relay's frames get routed into another relay's store.
//
//   This bundles the REAL src/stream.ts with a fake EventSource and asserts all
//   of the above. No network, no glasses.
//
// Run: node tools/stream-mux-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Test bookkeeping ────────────────────────────────────────────────────────
const QUIET = !!process.env.SIM_QUIET;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  if (ok && QUIET) return;
  console.log(
    `${ok ? '  ok  ' : ' FAIL '}${label}${
      ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`
    }`,
  );
};
const assert = (label, cond) => {
  if (!cond) fail++;
  if (cond && QUIET) return;
  console.log(`${cond ? '  ok  ' : ' FAIL '}${label}`);
};
const section = (t) => {
  if (!QUIET) console.log(`\n── ${t} ──`);
};
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── Fake EventSource ────────────────────────────────────────────────────────
// Records every construction so "how many sockets did we open" is directly
// observable — that count IS the bug this harness exists to prevent.
class FakeEventSource {
  static all = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  emitOpen() {
    this.onopen?.({});
  }
  emitError() {
    this.onerror?.({});
  }
  emit(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
globalThis.EventSource = FakeEventSource;
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };

const live = () => FakeEventSource.all.filter((e) => !e.closed);
const latest = () => live().at(-1);
const paramsOf = (es) => new URL(es.url, 'http://relay.test').searchParams;
const channelsOf = (es) => paramsOf(es).get('channels');
const tokenOf = (es) => paramsOf(es).get('token');

// ── Bundle the real module ──────────────────────────────────────────────────
// `env` is injected as import.meta.env so the same source can be loaded for a
// single relay (all channels agree) and for a split-relay deployment.
const out = mkdtempSync(join(tmpdir(), 'stream-mux-sim-'));
let buildSeq = 0;
async function loadBundle(env = {}) {
  const outfile = join(out, `stream-${buildSeq++}.mjs`);
  await build({
    stdin: {
      contents: `export * from './stream.ts';\nexport * from './auth-token.ts';\n`,
      resolveDir: 'src',
      loader: 'ts',
      sourcefile: 'harness-entry.ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    define: { 'import.meta.env': JSON.stringify(env) },
  });
  return import(pathToFileURL(outfile).href);
}

// ════════════════════════════════════════════════════════════════════════════
const mod = await loadBundle(); // one relay, same-origin: all channels share a base

// Every subscriber records what it was handed, so routing is asserted by what
// ARRIVED rather than by poking module internals.
const keys = ['hub', 'agents', 'ai', 'ai-ctl'];
const seen = Object.fromEntries(keys.map((k) => [k, []]));
const status = Object.fromEntries(keys.map((k) => [k, []]));
const handshake = Object.fromEntries(keys.map((k) => [k, []]));
const record = (key) => ({
  onState: (s) => seen[key].push(s),
  onStatus: (st) => status[key].push(st),
  onHandshake: (has) => handshake[key].push(has),
});
const clearSeen = () => keys.forEach((k) => seen[k].splice(0));

section('1. Four channels coalesce onto ONE socket');
const offs = [
  mod.connectStream(record('hub')),
  mod.connectAgentsStream(record('agents')),
  mod.connectAiStream(record('ai')),
  mod.connectAiControlStream(record('ai-ctl')),
];
check('nothing connects synchronously (the four are coalesced first)', FakeEventSource.all.length, 0);
await tick();
check('four subscriptions opened exactly ONE socket', FakeEventSource.all.length, 1);
check('the socket names every channel, sorted and de-duplicated', channelsOf(latest()), 'agents,ai,ai-ctl,hub');
check('a pre-auth subscription carries no token', tokenOf(latest()), null);

section('2. A repeat subscriber must not reconnect');
const urlBefore = latest().url;
const offDup = mod.connectAgentsStream(record('agents'));
await tick();
check('a second subscriber on a live channel opens no new socket', FakeEventSource.all.length, 1);
check('and leaves the URL untouched (a URL change IS a reconnect)', latest().url, urlBefore);
check('the socket still serves the same channel set', channelsOf(latest()), 'agents,ai,ai-ctl,hub');

// ════════════════════════════════════════════════════════════════════════════
section('3. Frames route by channel tag, not by shape');
clearSeen();
// hub and agents broadcast the IDENTICAL shape — only the tag distinguishes them.
latest().emit({ channel: 'hub', type: 'state', state: { v: 'hub-payload' } });
latest().emit({ channel: 'agents', type: 'state', state: { v: 'agents-payload' } });
check('the hub payload reached only the hub subscriber', seen.hub, [{ v: 'hub-payload' }]);
// `agents` deliberately has TWO subscribers here (the repeat from section 2), so
// an agents frame must reach both while the other channels still get nothing.
check('the agents payload reached every agents subscriber', seen.agents, [
  { v: 'agents-payload' },
  { v: 'agents-payload' },
]);
check('an identical shape did not leak into the ai channel', seen.ai, []);
check('nor into the control channel', seen['ai-ctl'], []);

clearSeen();
latest().emit({ channel: 'ai', type: 'state', state: { run: 1 } });
latest().emit({ channel: 'ai-ctl', type: 'control', state: { action: 'stop' } });
check('an ai run frame reached the ai subscriber', seen.ai, [{ run: 1 }]);
check('a control frame reached the control subscriber', seen['ai-ctl'], [{ action: 'stop' }]);
check('a control frame never confused the run subscriber', seen.ai, [{ run: 1 }]);

section('4. Each subscriber keeps its own picker');
clearSeen();
latest().emit({ channel: 'ai', type: 'run', run: { id: 'r1' } });
check('a non-state frame is ignored by the run subscriber', seen.ai, []);
latest().emit({ channel: 'hub', type: 'noise' });
check('a frame with no state is ignored', seen.hub, []);
latest().emit({ channel: 'ai', type: 'state', state: { run: 2 } });
check('a state frame is delivered', seen.ai, [{ run: 2 }]);

section('5. Untagged frames are dropped while the socket is ambiguous');
clearSeen();
latest().emit({ type: 'state', state: { v: 'untagged' } });
check(
  'no subscriber claimed an untagged frame on a four-channel socket',
  keys.reduce((n, k) => n + seen[k].length, 0),
  0,
);

section('6. Handshake fires once, for its own channel, with snapshot presence');
clearSeen();
latest().emit({ channel: 'hub', type: 'init', state: { v: 'seed' } });
check('the hub subscriber saw its handshake', handshake.hub, [true]);
check('another channel did not see the hub handshake', handshake.agents, []);
latest().emit({ channel: 'hub', type: 'init', state: null });
check('the handshake fires only once per subscriber', handshake.hub, [true]);
latest().emit({ channel: 'agents', type: 'init', state: null });
// Both agents subscribers get their own handshake — it is per subscription.
check('an empty init reports no snapshot', handshake.agents, [false, false]);
check('an empty init hands over no state', seen.agents, []);

// ════════════════════════════════════════════════════════════════════════════
section('7. A failed socket reconnects, and picks up a late credential');
const dead = latest();
dead.emitError();
check(
  'every subscriber on the socket was told it errored',
  keys.every((k) => status[k].includes('error')),
  true,
);
check('the failed socket was closed', dead.closed, true);
check('no socket is left live while the retry is backed off', live().length, 0);
// Sign in WHILE disconnected. The retry must REBUILD the URL rather than replay
// the tokenless one it captured, or a subscription made before sign-in would
// retry unauthenticated forever and never pick up the credential.
mod.setStreamToken('tok_live');
await new Promise((r) => setTimeout(r, 1250));
const retried = latest();
assert('the backed-off retry opened a fresh socket', !!retried);
check('the retry kept the full channel set', channelsOf(retried), 'agents,ai,ai-ctl,hub');
check('the retry URL carries the credential that arrived while offline', tokenOf(retried), 'tok_live');

// ════════════════════════════════════════════════════════════════════════════
section('8. Back-compat: a single-channel socket accepts untagged frames');
// Drop down to one channel. The channel set changed, so this is a reconnect —
// and it is also exactly what a pre-multiplexing relay looks like to the client.
const superseded = live();
offs[1](); // agents
offs[2](); // ai
offs[3](); // ai-ctl
offDup(); // the repeat agents subscription from section 2
await tick();
check('collapsing to one channel left exactly one socket', live().length, 1);
check('every superseded socket was closed', superseded.every((e) => e.closed), true);
check('the replacement subscribes to just that channel', channelsOf(latest()), 'hub');
clearSeen();
latest().emit({ type: 'init', state: { v: 'legacy' } });
check('an untagged init is accepted by the single subscriber', handshake.hub.includes(true), true);
// The init frame doubles as the first snapshot, so its state IS delivered.
check('an untagged init delivers its seed snapshot', seen.hub, [{ v: 'legacy' }]);
clearSeen();
latest().emit({ type: 'state', state: { v: 'legacy-state' } });
check('an untagged state is accepted by the single subscriber', seen.hub, [{ v: 'legacy-state' }]);
clearSeen();
latest().emit({ channel: 'agents', type: 'state', state: { v: 'foreign' } });
check('a tagged frame for a channel we no longer hold is dropped', seen.hub, []);

section('9. The socket is released with its last subscriber');
offs[0]();
await tick();
check('every socket is closed once nothing subscribes', live().length, 0);

// ════════════════════════════════════════════════════════════════════════════
section('10. Channels on DIFFERENT relays never share a socket');
const socketsBefore = FakeEventSource.all.length;
const split = await loadBundle({
  VITE_HUB_STREAM_URL: 'http://relay-a.test/api/stream?channel=hub',
  VITE_HUB_AGENTS_URL: 'http://relay-b.test/api/stream?channel=agents',
});
const splitSeen = { hub: [], agents: [] };
const offA = split.connectStream({ onState: (s) => splitSeen.hub.push(s) });
const offB = split.connectAgentsStream({ onState: (s) => splitSeen.agents.push(s) });
await tick();
const created = FakeEventSource.all.slice(socketsBefore);
check('two relays get two sockets', created.length, 2);
check(
  'each socket is addressed to its own relay and channel',
  created.map((e) => e.url).sort(),
  ['http://relay-a.test/api/stream?channels=hub', 'http://relay-b.test/api/stream?channels=agents'],
);
created[0].emit({ type: 'state', state: { v: 'from-a' } });
created[1].emit({ type: 'state', state: { v: 'from-b' } });
check('relay A delivered to the hub subscriber', splitSeen.hub, [{ v: 'from-a' }]);
check('relay B delivered to the agents subscriber', splitSeen.agents, [{ v: 'from-b' }]);
offA();
offB();
await tick();
check('both split sockets were released', created.every((e) => e.closed), true);

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);
