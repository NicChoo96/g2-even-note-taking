#!/usr/bin/env node
// The `hub-changed` nudge — the relay's rules, driven directly.
//
// WHY THIS EXISTS — reported: "now our web apps are fetched from db, so we do
// not get live updates from backend… so how do we sync from backend db now from
// different devices web?"
//
// Every collection moved into the HUB, and the hub has no push route: a write
// returns the new state to the caller and tells nobody else. Two devices were
// therefore left with no way to learn about each other's writes. The relay is the
// one component both already hold a connection to, so it fans a small frame out
// along the `hub` SSE channel and each client refetches the collection it names.
//
// Three things in that path are easy to get wrong and each has a whole section
// below, because all three are silent when they break:
//
//   §2  WHAT QUALIFIES. A nudge on a GET, or on a FAILED write, sends every other
//       device off to refetch bytes that did not change — a refetch storm that
//       looks exactly like working sync.
//   §3  WHAT THE FRAME MAY CLAIM. `rev` moves only for todo/document/note/
//       file_ref/agent. Inventing one on a session or ledger write announces "the
//       to-do list changed" on a routine write.
//   §4  WHO MUST NOT HEAR IT. A write must not cost its author a repaint — least
//       of all a repaint of the document they are typing into.
//
// §5 proves the relay actually calls these rules with these arguments, since a
// pure function the relay never calls is not a fix. The relay starts a server the
// moment it is imported, so that half is asserted against its SOURCE.
//
// Run: node tools/hub-nudge-sim.mjs   (judged on EXIT CODE)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectionPath,
  hubChangedFrame,
  isOwnEcho,
  revOf,
  shouldNudge,
} from '../../web/server/hub-nudge.mjs';

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

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 1. The collection a client must refetch ==');
// The frame names a first segment, never a row: a device refetches the list.
check('/hub/todos is the todo list', collectionPath('/hub/todos'), '/todos');
check('a row id is not carried forward', collectionPath('/hub/docs/9f3a'), '/docs');
check('the query is stripped (no limit/cursor leaks into a refetch)', collectionPath('/hub/docs/9f3?include=content&limit=50'), '/docs');
check('the bare prefix is the whole snapshot', collectionPath('/hub'), '/');
check('a trailing slash is the same thing', collectionPath('/hub/'), '/');
// These all exist on the hub and all must map to a real collection.
check('notes', collectionPath('/hub/notes'), '/notes');
check('files', collectionPath('/hub/files'), '/files');
check('settings (a relay/app_setting write)', collectionPath('/hub/relay/auth'), '/relay');
// A relay-relative path would also be handed here by a sloppy caller; it must
// still produce something a client can act on rather than an empty string.
check('an already-relative path still yields a segment', collectionPath('/todos'), '/todos');
check('junk cannot throw', collectionPath(undefined), '/');
check('an empty string cannot throw', collectionPath(''), '/');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 2. Only a successful WRITE may nudge ==');
// A pure read changes nothing, so every device refetching would be wasted work.
for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) {
  check(`${m} never nudges`, shouldNudge(m, 200), false);
}
// A failed write changed nothing either. 409 STALE_REV and 412 IF_MATCH_FAILED
// are the common ones — they mean "your copy was old", not "the data moved".
for (const status of [400, 401, 403, 404, 409, 412, 413, 429, 500, 503]) {
  check(`a ${status} write does not nudge`, shouldNudge('PUT', status), false);
}
// 0 is what hub-api.mjs answers for "never reached the hub" — the loudest
// possible false positive, since nothing was written anywhere.
check('an unreachable hub (status 0) does not nudge', shouldNudge('POST', 0), false);
check('a missing status does not nudge', shouldNudge('POST', undefined), false);
for (const [m, status] of [
  ['POST', 200],
  ['POST', 201],
  ['PUT', 200],
  ['PUT', 204],
  ['PATCH', 204],
  ['DELETE', 204],
  ['delete', 204],
]) {
  check(`a ${status} ${m} nudges`, shouldNudge(m, status), true);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 3. The frame claims a path, and only a rev the hub really sent ==');
check(
  'a rev-carrying write produces a full frame',
  hubChangedFrame('/todos', 41, 'c-abc'),
  { type: 'hub-changed', path: '/todos', rev: 41, origin: 'c-abc' },
);
// `rev` advances ONLY for todo/document/note/file_ref/agent (hub spec §4.3).
// Sessions, memory, the ledger, settings and app_setting do NOT move it, so a
// frame that invented one would announce a to-do change on a session write.
check('no rev in the response => no rev in the frame', hubChangedFrame('/sessions', null, 'c-abc'), {
  type: 'hub-changed',
  path: '/sessions',
  origin: 'c-abc',
});
check('a non-numeric rev is dropped rather than coerced', hubChangedFrame('/todos', '41', 'c-a'), {
  type: 'hub-changed',
  path: '/todos',
  origin: 'c-a',
});
check('NaN is dropped', hubChangedFrame('/todos', NaN, 'c-a'), { type: 'hub-changed', path: '/todos', origin: 'c-a' });
check('Infinity is not a rev', hubChangedFrame('/todos', Infinity, 'c-a'), {
  type: 'hub-changed',
  path: '/todos',
  origin: 'c-a',
});
// rev 0 is finite and legitimate — it must survive.
check('rev 0 survives (it is a real value)', hubChangedFrame('/todos', 0, 'c-a'), {
  type: 'hub-changed',
  path: '/todos',
  rev: 0,
  origin: 'c-a',
});
check('an empty origin is omitted, not sent as ""', hubChangedFrame('/todos', 1, ''), {
  type: 'hub-changed',
  path: '/todos',
  rev: 1,
});
check('a missing origin is omitted', hubChangedFrame('/todos', 1, undefined), {
  type: 'hub-changed',
  path: '/todos',
  rev: 1,
});

console.log('\n== 4. The author must not be told about its own write ==');
check('the writer is skipped', isOwnEcho({ origin: 'c-a' }, 'c-a'), true);
check('another client is served', isOwnEcho({ origin: 'c-b' }, 'c-a'), false);
// An ABSENT origin is NOT a match: the relay could not correlate the writer, and
// a client is far better off doing one redundant read than silently missing a
// peer's change. The fallback is always to deliver.
check('an uncorrelated frame is delivered, not dropped', isOwnEcho({}, 'c-a'), false);
check('an empty-string origin is uncorrelated', isOwnEcho({ origin: '' }, 'c-a'), false);
check('a non-string origin is uncorrelated', isOwnEcho({ origin: 7 }, 7), false);
check('a null frame is not a match', isOwnEcho(null, 'c-a'), false);
// A client that did not send an id must never swallow every frame whose writer
// also did not send one.
check('two unknown origins are not the same origin', isOwnEcho({}, ''), false);

console.log('\n== 5. The rev the relay actually lifts out of a response ==');
check('a numeric rev is read', revOf({ ok: true, rev: 12 }), 12);
check('rev 0 is a rev', revOf({ rev: 0 }), 0);
// A 204 DELETE /hub/docs/{id} has NO body at all, and the hub paginates its list
// reads, so most bodies the relay sees here are not the rev-carrying shape.
check('a bodyless response yields no rev', revOf(null), null);
check('a body without a rev yields none', revOf({ ok: true, items: [] }), null);
// `Number(null)` / `Number('')` / `Number([])` are all 0, so a coercion here would
// dress "no rev" up as a real `rev: 0` — a claim about a collection on a route
// that has no rev. Every one of these must stay absent.
check('a string rev is not a rev', revOf({ rev: '12' }), null);
check('an explicit null rev is not a rev', revOf({ rev: null }), null);
check('an empty-string rev is not a rev', revOf({ rev: '' }), null);
check('an array rev is not a rev', revOf({ rev: [] }), null);
check('a boolean rev is not a rev', revOf({ rev: false }), null);
check('a NaN rev yields none', revOf({ rev: NaN }), null);
check('an Infinity rev yields none', revOf({ rev: Infinity }), null);
// …while a real number, including 0, is exactly what the hub sends.
check('a real numeric rev is read', revOf({ rev: 7 }), 7);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 6. The relay wires those rules to the hub passthrough ==');
const relaySrc = readFileSync(resolve(here, '../../web/server/local-sse.mjs'), 'utf8');
const has = (label, needle) => ok(label, relaySrc.includes(needle));

has('the rules are imported from their own module', "from './hub-nudge.mjs'");
has('and the frame builder is the one used', 'hubChangedFrame(path, rev, origin)');
// The nudge must hang off the hub PASSTHROUGH — the only place the relay sees a
// hub write go by — not off a timer, and not off the cached state publish.
ok(
  'the nudge is raised inside the /api/hub passthrough',
  /if \(shouldNudge\(req\.method, upstream\.status\)\)/.test(relaySrc),
);
has('it reads the writer id the client sent', "req.headers['x-client-id']");
has('it lifts the rev out of the response body', 'revOf(parseJsonOrNull(upstream.text))');
has('and it is the collection path that is broadcast', 'nudgeHubChanged(collectionPath(hubPath), rev, origin)');
// The own-echo skip is per-SOCKET and the socket must have been given the id.
has('the stream socket remembers who opened it', 'res.g2Origin = String(url.searchParams.get(');
has('the fan-out skips nothing but the author', 'if (isOwnEcho(frame, client.g2Origin)) continue;');
// CORS: without the header the browser never gets to send the writer id at all,
// and every device — including the author — would be nudged by its own write.
has('the browser is allowed to send X-Client-Id', 'X-Client-Id');
// A nudge with no listeners is a wasted frame; the early return is the guard.
has('an empty channel is not fanned out', 'if (channel.clients.size === 0) return;');

// The frame must NOT carry state. Re-broadcasting the relay's cached snapshot
// would re-serve a copy another device has already superseded — the exact
// stale-frame wipe the hub migration existed to end.
ok(
  'the frame carries a path, never a state payload',
  !/hubChangedFrame[\s\S]{0,200}state:/.test(relaySrc),
);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
