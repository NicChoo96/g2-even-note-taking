#!/usr/bin/env node
// LIVE SYNC, CLIENT SIDE — what a `hub-changed` nudge is allowed to cost.
//
// WHY THIS EXISTS. Collections moved into the hub, and the hub has no push route,
// so a second device had no way to learn that the first one had written anything.
// The relay now nudges on every successful write (§2.2). The nudge itself is
// cheap; the READ it triggers is not. `GET /hub` inlines every document's
// complete body — 63 KB across the 19 documents in this deployment — and it
// replaces `activeSection` and `activeDocId` with the server's copy, i.e. it can
// pull the wearer out of the document they are reading.
//
// So the whole point of `refreshSection` is that a peer ticking ONE to-do reads
// ONE collection. If it ever silently widens to the snapshot, nothing breaks
// loudly: the app still syncs, the harnesses still pass, and every peer write
// quietly starts costing 63 KB and a lost cursor. That is the failure this file
// exists to catch. Specifically:
//
//   1. A nudge for a collection HubState owns reads THAT collection and NOT the
//      snapshot. Nothing may touch `/hub` except the two documented cases.
//   2. `/sessions`, `/memory`, `/ledger`, `/settings`, `/relay` are DROPPED.
//      They never move `rev`, are not part of HubState, and their screens read
//      them on demand — turning one into a snapshot read costs 63 KB to learn
//      nothing.
//   3. A burst collapses: a peer typing produces one nudge per write, and eight
//      63 KB-ish reads where one will do is just load.
//   4. An adopted document KEEPS its body. The list read omits bodies (a body is
//      unbounded), so merging it naively would set every `content` to `undefined`
//      and blank the document the wearer has open.
//   5. OUR OWN ECHO IS DROPPED — and a frame with NO origin is NOT treated as our
//      own, because dropping a peer's real edit is worse than one wasted read.
//
// The module is the REAL `store.ts` and the REAL `client-id.ts`, bundled together
// and driven against a stubbed `fetch`, so the URL each read produces is the URL
// the app ships. `main.ts` cannot be imported — it runs `main()` on load — so the
// two lines of glue that route a frame are asserted against its SOURCE in §7,
// alongside the predicate they call, which IS executed here.
//
// Run: node tools/hub-live-sync-sim.mjs   (judged on EXIT CODE)

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ── The fake host: localStorage, timers, an event target, and fetch ──────────
// Installed BEFORE any module loads, because `store.ts` reads `localStorage` at
// module scope and publishes through `window.setTimeout`.
const mem = new Map();
const listeners = { focus: [], visibilitychange: [] };
let visibility = 'visible';

globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
};
globalThis.document = {
  get visibilityState() {
    return visibility;
  },
  addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
};
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
if (!globalThis.crypto) globalThis.crypto = { getRandomValues: (b) => b.fill(1) };

/**
 * A stubbed hub. Every request is RECORDED with its path, and answered from a
 * mutable route table so a test can change what the next read returns.
 */
const seen = [];
const routes = new Map();
const route = (path, reply) => routes.set(path, reply);
const json = (body, status = 200) => ({ status, body });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  seen.push({ path, method: init.method ?? 'GET', body: init.body });
  const hit = routes.get(path);
  const reply = typeof hit === 'function' ? hit() : hit;
  if (!reply) return { ok: false, status: 500, headers: { get: () => null }, text: async () => '{}' };
  const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    headers: { get: (n) => (n.toLowerCase() === 'etag' ? reply.etag ?? null : null) },
    text: async () => text,
  };
};

const reads = (path) => seen.filter((s) => s.method === 'GET' && s.path === path);
const snapshots = () => reads('/api/hub');
const reset = () => (seen.length = 0);

// ── Seed the cache the way a browser would have it, BEFORE the module loads ──
const seed = {
  activeSection: 'docs',
  sections: {
    todo: [{ id: 't-old', text: 'from cache', done: false }],
    docs: [
      { id: 'd1', title: 'Old title', content: 'KEEP ME', updatedAt: 1 },
      { id: 'd2', title: 'Will vanish', content: 'GONE', updatedAt: 2 },
    ],
    files: [],
    notes: 'HELLO',
  },
  activeDocId: 'd2',
  updatedAt: 1,
};
mem.set('hub:state', JSON.stringify(seed));

// ── Bundle the REAL modules ─────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'hub-live-sync-'));
const stub = join(dir, 'sdk-stub.mjs');
writeFileSync(
  stub,
  `export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }
export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }
export const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
export default {};
`,
);
const outfile = join(dir, 'live-sync.mjs');
await build({
  stdin: {
    contents: `
export { refreshSection, startHubLiveSync, loadHub, getState, subscribe, update } from './store.ts';
export { clientId, isOwnEcho } from './client-id.ts';
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

const store = await import(pathToFileURL(outfile).href);
const { refreshSection, startHubLiveSync, getState, subscribe, clientId, isOwnEcho } = store;

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 1. The cache paints first, and the hub owns nothing yet ==');
check('the cached list survived the reload', getState().sections.todo.map((t) => t.id), ['t-old']);
check('the cached document body is there', getState().sections.docs[0].content, 'KEEP ME');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 2. A nudge reads ONE collection, never the snapshot ==');
{
  route('/api/hub/todos', () => json({ ok: true, rev: 41, items: [{ id: 't-new', text: 'from peer', done: false }] }));
  reset();
  refreshSection('/todos');
  check('nothing is read synchronously', seen.length, 0);
  await sleep(600);
  check('exactly one read', seen.length, 1);
  check('of the to-do collection', seen[0].path, '/api/hub/todos');
  // THE HEADLINE ASSERTION. `/hub` inlines every document body and overwrites
  // the open section; a peer ticking one to-do must not cost that.
  check('and ZERO snapshot reads', snapshots().length, 0);
  check('the peer\'s list was adopted', getState().sections.todo.map((t) => t.id), ['t-new']);
  check('the open section was left alone', getState().activeSection, 'docs');
}
{
  route('/api/hub/docs', () =>
    json({
      ok: true,
      rev: 42,
      items: [
        { id: 'd1', title: 'Renamed by peer', updatedAt: 9 },
        { id: 'd3', title: 'New doc', updatedAt: 10 },
      ],
    }),
  );
  reset();
  // A per-document path must be normalised to its collection.
  refreshSection('/docs/d1');
  await sleep(600);
  check('a document nudge reads the document list', seen.map((s) => s.path), ['/api/hub/docs']);

  // THE BODY SURVIVES. The list read omits bodies, so a naive replace would set
  // `content` to undefined and blank the document the wearer is reading.
  const docs = getState().sections.docs;
  check('the open document kept its body', docs.find((d) => d.id === 'd1').content, 'KEEP ME');
  check('…and took the peer\'s title', docs.find((d) => d.id === 'd1').title, 'Renamed by peer');
  check('a document the server no longer lists is dropped', docs.some((d) => d.id === 'd2'), false);
  check('a new document appears with an empty body', docs.find((d) => d.id === 'd3').content, '');
  // The open id pointed at a document that just vanished: fall back rather than
  // keep pointing at nothing.
  check('an open document that vanished falls back', getState().activeDocId, null);
}
{
  route('/api/hub/notes', () => json({ ok: true, rev: 43, content: 'HELLO' }));
  let painted = 0;
  const off = subscribe(() => {
    painted++;
  });
  reset();
  refreshSection('/notes');
  await sleep(600);
  check('a notes nudge reads the notes', seen.map((s) => s.path), ['/api/hub/notes']);
  // THE ECHO CASE: this frame is usually the echo of an append this very tab
  // made, and committing identical text would repaint every surface for nothing.
  check('identical notes do not repaint', painted, 0);
  off();

  route('/api/hub/notes', () => json({ ok: true, rev: 44, content: 'CHANGED BY PEER' }));
  reset();
  refreshSection('/notes');
  await sleep(600);
  check('…while a real change does land', getState().sections.notes, 'CHANGED BY PEER');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 3. Collections HubState does not own are dropped ==');
reset();
for (const path of ['/sessions', '/memory', '/ledger', '/settings', '/relay', '/relay/auth', '/mcp', '/agents']) {
  refreshSection(path);
}
await sleep(600);
// `/agents` is included on purpose: it lives in `agents-store.ts`, and `main.ts`
// routes it there BEFORE calling `refreshSection`, so a nudge must not also drag
// the whole hub state in behind it.
check('no read at all', seen.length, 0);
check('and certainly no snapshot read', snapshots().length, 0);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 4. A burst collapses into one read ==');
{
  route('/api/hub/todos', () => json({ ok: true, rev: 45, items: [] }));
  reset();
  for (let i = 0; i < 8; i++) refreshSection('/todos');
  await sleep(600);
  check('eight nudges, one read', reads('/api/hub/todos').length, 1);
  // A `docs` nudge must not be swallowed by a pending `todo` one: the debounce is
  // per collection, not global.
  route('/api/hub/docs', () => json({ ok: true, rev: 46, items: [] }));
  reset();
  refreshSection('/todos');
  refreshSection('/docs');
  await sleep(600);
  check('two collections ticked together read once each', seen.map((s) => s.path).sort(), [
    '/api/hub/docs',
    '/api/hub/todos',
  ]);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 5. The two documented snapshot reads, and why they are the only ones ==');
{
  // `/` IS the state document, so the snapshot read is the only read that names
  // it. `/files` appears in HubState as a `FileRef` and the store has no read
  // that returns `FileRef[]` on its own.
  route('/api/hub', () =>
    json({
      ok: true,
      rev: 47,
      hub: { ...seed, sections: { ...seed.sections, notes: 'from snapshot' } },
    }),
  );
  reset();
  refreshSection('/');
  await sleep(100);
  check('/ reads the snapshot', snapshots().length, 1);
  check('and adopts it', getState().sections.notes, 'from snapshot');

  // `/files` and `/` are the only two, and an empty path is `/`.
  reset();
  refreshSection('');
  await sleep(100);
  check('an empty path is the state document', snapshots().length, 1);

  reset();
  refreshSection('/files');
  await sleep(600);
  check('/files reads the snapshot too', snapshots().length, 1);

  // An unrecognised collection must also be a no-op, not a fallback to the
  // snapshot — an unknown path is not permission to read 63 KB.
  reset();
  refreshSection('/whatever');
  await sleep(600);
  check('an unknown collection reads nothing', seen.length, 0);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 6. Coming back to the foreground catches up ==');
{
  // Started once per page load, and idempotent: `main.ts` calls it beside the
  // other wiring, and a second call must not double every listener.
  startHubLiveSync();
  startHubLiveSync();
  check('one focus listener, however many calls', listeners.focus.length, 1);
  check('one visibility listener', listeners.visibilitychange.length, 1);

  reset();
  for (const fn of listeners.focus) fn();
  await sleep(500);
  check('a focus read the snapshot...', snapshots().length, 1);
  check('...exactly once, however many events fire', seen.length, 1);
  const before = seen.length;
  visibility = 'hidden';
  for (const fn of listeners.visibilitychange) fn();
  await sleep(500);
  // A hidden tab is not coming back to anything, and the phone spends most of its
  // life backgrounded — a read per blur would be pure battery.
  check('a hidden tab reads nothing', seen.length, before);
  visibility = 'visible';
}

console.log('\n== 7. A tab with no credential yet does not read on focus ==');
// The listener is wired before the first load can have finished, so the guard
// inside it is what stops a request from firing with no credential attached.
{
  const storeSrc = readFileSync(resolve(here, '../src/store.ts'), 'utf8');
  ok('the foreground catch-up is gated on a first successful load', /if \(!hubLoaded\) return;/.test(storeSrc));
  ok('and on the tab actually being visible', /document\.visibilityState === 'hidden'/.test(storeSrc));
}

console.log('\n== 8. The glue that decides, and the predicate it calls ==');
{
  // EXECUTED, because `main.ts` runs `main()` on import and cannot be loaded.
  const mine = clientId();
  ok('this page\'s own id is well formed', /^c-[0-9a-f]{16}$/.test(mine));
  check('our own echo is recognised', isOwnEcho(mine), true);
  check('a peer\'s frame is not', isOwnEcho('c-00000000000000ff'), false);
  // THE ASYMMETRY THAT MATTERS: no origin means "we cannot tell", and the safe
  // default is to deliver the refresh rather than miss a peer's edit.
  check('an absent origin is NOT our own', isOwnEcho(undefined), false);
  check('nor is an empty one', isOwnEcho(''), false);
  check('nor is a non-string', isOwnEcho(null), false);
  ok('and the id is stable for the life of the page', clientId() === mine);

  const mainSrc = readFileSync(resolve(here, '../src/main.ts'), 'utf8');
  const has = (label, needle) => ok(label, mainSrc.includes(needle));
  has('a peer frame goes through the shared predicate', 'if (isOwnEcho(changed.origin)) return;');
  has('agents are routed to their own store', "if (changed.path === '/agents') {");
  has('everything else goes to the targeted refresh', 'refreshSection(changed.path);');
  has('the stream is wired to it', 'onHubChanged: (changed) => onPeerHubChange(changed),');
  has('and catching up on return is started', 'startHubLiveSync();');

  // The predicate must be the shared one, not a second inline comparison that
  // could drift (an absent origin treated as our own would silently drop peers).
  const clientSrc = readFileSync(resolve(here, '../src/client-id.ts'), 'utf8');
  ok('the predicate lives with the id it compares against', /export function isOwnEcho\(/.test(clientSrc));
  ok(
    'and it refuses to treat a missing origin as our own',
    /typeof origin === 'string' && origin\.length > 0 && origin === clientId\(\)/.test(clientSrc),
  );
  ok('main.ts has no inline copy of the rule', !/changed\.origin ===/.test(mainSrc));
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
