#!/usr/bin/env node
// Session-retention harness.
//
// WHY THIS EXISTS — reported: "One more issue, from my agents, when it finishes
// generation, why is my session history cleared out … that doesn't make any
// sense, see whats causing this delete action after the agent finishes the
// trigger."
//
// There is no delete. Two defects conspired, and both are in this file's scope:
//
//   1. The 5-session cap was GLOBAL, not per agent. Finishing a run for agent B
//      inserted a session and evicted the globally-oldest one — routinely the
//      last surviving session of agent A, the agent the wearer was looking at.
//      Both read paths filter to ONE agent (the panel prints "History · last
//      N/5", the glasses detail pane pages within one agent's list), so A's
//      counter walked to 0 and the panel fell to "No sessions yet." A shared
//      pool drained by a neighbour reads exactly like data loss.
//
//   2. `sessions` is append-only, but it rides the `agents` channel whose
//      payload is whole-state last-write-wins. `applyRemoteAgents` REPLACED the
//      list with the frame's. Both devices settle the same run, and a device
//      that never witnessed the other's runs (backgrounded — the run replay
//      carries only RUNNING runs) publishes a legitimately shorter list, which
//      deleted everything else on every device AND in the relay's cached and
//      persisted copy.
//
// So the fix is a per-agent cap (types.ts pruneSessions) plus an append-only
// merge on every ingress path (types.ts mergeSessions), with explicit clears
// carried as tombstones (sessionsClearedAt) so "delete" still deletes.
//
// §1-§5 exercise the real pure functions. §3 is the reported bug verbatim, over
// a faithful two-device + relay round trip. §6 greps the store and the panel to
// prove the paths that matter actually call the merge — a pure function is only
// a fix if nothing writes around it.
//
// Run: node tools/sessions-sync-sim.mjs   (judged on EXIT CODE)

import { readFileSync } from 'node:fs';
import {
  MAX_SESSIONS,
  MAX_SESSIONS_TOTAL,
  mergeClearedAt,
  mergeSessions,
  pruneSessions,
} from '../src/types.ts';

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  assert(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const has = (label, hay, needle) => assert(label, hay.includes(needle), needle.replace(/\s+/g, ' ').slice(0, 72));
const lacks = (label, hay, needle) => assert(label, !hay.includes(needle), needle.replace(/\s+/g, ' ').slice(0, 72));

/**
 * Monotonic clock. Real `Date.now()` collides inside a test, and the store's
 * own-echo guard is exact equality on `updatedAt`, so collisions would silently
 * drop frames and make this harness lie.
 */
let clock = 1_800_000_000_000;
const now = () => (clock += 1000);

const sess = (id, agentId, at, msgs = 1) => ({
  id,
  agentId,
  title: id,
  status: 'done',
  messages: Array.from({ length: msgs }, (_, i) => ({ role: 'user', content: `${id}#${i}` })),
  createdAt: at,
  updatedAt: at,
});

const idsOf = (list, agentId) => list.filter((s) => s.agentId === agentId).map((s) => s.id);

// ─────────────────────────────────────────────────────────────────────────────
// §1  The cap is PER AGENT (defect 1). A neighbour's run must not evict you.
// ─────────────────────────────────────────────────────────────────────────────
{
  const many = [];
  let at = 0;
  for (let a = 1; a <= 5; a++) for (let k = 1; k <= 6; k++) many.push(sess(`s${a}-${k}`, `a${a}`, ++at));
  const pruned = pruneSessions(many);
  eq('cap: 5 agents x 6 sessions keeps 5 each', pruned.length, MAX_SESSIONS * 5);
  for (let a = 1; a <= 5; a++) {
    eq(`cap: agent a${a} keeps its NEWEST ${MAX_SESSIONS}`, idsOf(pruned, `a${a}`), [
      `s${a}-6`, `s${a}-5`, `s${a}-4`, `s${a}-3`, `s${a}-2`,
    ]);
  }
  eq('cap: still most-recent-first overall', pruned.map((s) => s.updatedAt), [...pruned].sort((x, y) => y.updatedAt - x.updatedAt).map((s) => s.updatedAt));

  // A sixth agent's history is NOT bought by evicting the others.
  const six = pruneSessions([...many, sess('x-1', 'a6', 999)]);
  eq('cap: a new agent does not evict existing agents', idsOf(six, 'a1').length, MAX_SESSIONS);

  // The payload guard: this list is published in full on every edit.
  const flood = [];
  let t = 0;
  for (let a = 1; a <= 12; a++) for (let k = 1; k <= 5; k++) flood.push(sess(`f${a}-${k}`, `a${a}`, ++t));
  const bounded = pruneSessions(flood);
  eq('cap: total ceiling holds', bounded.length, MAX_SESSIONS_TOTAL);
  assert('cap: ceiling keeps the NEWEST', bounded[0].id === 'f12-5', bounded[0].id);
  assert('cap: ceiling keeps 6 full agents', new Set(bounded.map((s) => s.agentId)).size === 6, String(new Set(bounded.map((s) => s.agentId)).size));
}

// ─────────────────────────────────────────────────────────────────────────────
// §2  The merge is a union, not a replace (defect 2) — plus id collisions.
// ─────────────────────────────────────────────────────────────────────────────
{
  const a1 = [sess('p1', 'a1', 10), sess('p2', 'a1', 20)];
  const b1 = [sess('q1', 'b1', 30)];
  eq('merge: union of two disjoint lists', pruneSessions(mergeSessions(a1, b1)).map((s) => s.id), ['q1', 'p2', 'p1']);
  eq('merge: an EMPTY incoming frame cannot shrink history', mergeSessions(a1, []).map((s) => s.id), ['p2', 'p1']);
  eq('merge: a SHORTER incoming frame cannot shrink history', mergeSessions(a1, [b1[0]]).map((s) => s.id), ['q1', 'p2', 'p1']);

  // Same run id settled on two devices: the run id IS the session id.
  const short = sess('dup', 'a1', 100_000, 1);
  const long = sess('dup', 'a1', 100_000, 9);
  eq('merge: same id — richer transcript wins (incoming longer)', mergeSessions([short], [long])[0].messages.length, 9);
  eq('merge: same id — richer transcript wins (incoming shorter)', mergeSessions([long], [short])[0].messages.length, 9);
  eq('merge: same id, equal length — the incoming rewrite wins', mergeSessions([short], [{ ...short, title: 'newer' }])[0].title, 'newer');
  // A rewrite that moves a session BACKWARDS in time is still a rewrite. An
  // "only accept a fresher stamp" tie-break silently swallowed it and reordered
  // the live monitor list — see the ordering block below.
  eq('merge: same id — an older incoming stamp still applies', mergeSessions([short], [{ ...short, updatedAt: short.updatedAt - 5000 }])[0].updatedAt, short.updatedAt - 5000);
  eq('merge: no tombstone means no filtering', mergeSessions([sess('zero', 'a1', 0)], []).map((s) => s.id), ['zero']);
  eq('merge: junk entries are dropped, not thrown', mergeSessions(a1, [null, { nope: 1 }]).length, 2);

  // Ordering has to survive ties (two sessions recorded in the same millisecond)
  // and has to reflect a later rewrite.
  eq('order: a tie keeps the caller order', pruneSessions([sess('t1', 'a1', 500), sess('t2', 'a1', 500)]).map((s) => s.id), ['t1', 't2']);
  eq('order: a backdated rewrite sorts later', pruneSessions([{ ...sess('t1', 'a1', 500), updatedAt: 100 }, sess('t2', 'a1', 500)]).map((s) => s.id), ['t2', 't1']);
  eq('order: the merge does not undo a backdated rewrite', mergeSessions([sess('t1', 'a1', 500)], [{ ...sess('t1', 'a1', 500), updatedAt: 100 }])[0].updatedAt, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// §3  THE REPORTED BUG: a finished run must not clear a history you are reading.
//     Two devices, one relay, the store's real mutation semantics.
// ─────────────────────────────────────────────────────────────────────────────
const dev = (name) => ({
  name,
  agents: [],
  tools: [],
  llm: {},
  sessions: [],
  sessionsClearedAt: {},
  updatedAt: 0,
  lastPublishedAt: 0,
});

const frameOf = (d) =>
  JSON.parse(
    JSON.stringify({
      agents: d.agents,
      tools: d.tools,
      llm: d.llm,
      sessions: d.sessions,
      sessionsClearedAt: d.sessionsClearedAt,
      updatedAt: d.updatedAt,
    }),
  );

// Fake relay: POST /api/stream caches + persists the frame, then broadcasts it.
// Deliberately dumb — it stores whatever the last publisher sent, which is
// exactly why the merge has to live on the client ingress path.
const hub = { lastState: null, published: [], subs: [] };

function publish(d) {
  d.lastPublishedAt = d.updatedAt;
  const frame = frameOf(d);
  hub.lastState = frame;
  hub.published.push(frame);
  for (const peer of hub.subs) deliver(peer, frame);
}

/** Mirrors agents-store.updateAgents. */
function edit(d, fn) {
  const next = fn({
    agents: d.agents,
    tools: d.tools,
    llm: d.llm,
    sessions: d.sessions,
    sessionsClearedAt: d.sessionsClearedAt,
    updatedAt: d.updatedAt,
  });
  const sessionsClearedAt = mergeClearedAt(d.sessionsClearedAt, next.sessionsClearedAt);
  Object.assign(d, {
    ...next,
    sessions: mergeSessions(d.sessions, next.sessions, sessionsClearedAt),
    sessionsClearedAt,
    updatedAt: now(),
  });
  publish(d);
}

/** Mirrors agents-store.recordSession (the run id is the session id). */
const recordSession = (d, id, agentId) =>
  edit(d, (s) => ({ ...s, sessions: mergeSessions(s.sessions, [sess(id, agentId, now())], s.sessionsClearedAt) }));

/** Mirrors agents-store.clearSessionsFor. */
const clearFor = (d, agentId) =>
  edit(d, (s) => ({
    ...s,
    sessions: s.sessions.filter((x) => x.agentId !== agentId),
    sessionsClearedAt: { ...s.sessionsClearedAt, [agentId]: now() },
  }));

/** Mirrors agents-store.applyRemoteAgents (incl. the own-echo guard). */
function deliver(d, frame) {
  if (!frame || !Array.isArray(frame.agents)) return;
  if (frame.updatedAt === d.lastPublishedAt) return; // our own echo — already applied
  const sessionsClearedAt = mergeClearedAt(d.sessionsClearedAt, frame.sessionsClearedAt);
  Object.assign(d, {
    agents: frame.agents,
    tools: frame.tools?.length ? frame.tools : d.tools,
    llm: { ...d.llm, ...(frame.llm ?? {}) },
    sessions: mergeSessions(d.sessions, frame.sessions ?? [], sessionsClearedAt),
    sessionsClearedAt,
    updatedAt: frame.updatedAt ?? now(),
  });
}

{
  hub.lastState = null;
  hub.published = [];
  const A = dev('A');
  const B = dev('B');
  hub.subs = [A, B];

  // The relay already holds agent a1 with a full 5/5 history (plus an empty b1).
  const seed = { agents: [{ id: 'a1' }, { id: 'b1' }], tools: [], llm: {}, sessions: [], sessionsClearedAt: {}, updatedAt: now() };
  for (let k = 1; k <= 5; k++) seed.sessions.push(sess(`a1-${k}`, 'a1', now()));
  hub.lastState = seed;
  deliver(A, seed);
  deliver(B, seed);

  eq('two devices start from the relay with a1 at 5/5', [idsOf(A.sessions, 'a1').length, idsOf(B.sessions, 'a1').length], [5, 5]);

  // The wearer is looking at a1. A run for b1 finishes on B.
  recordSession(B, 'run-b1', 'b1');
  eq('THE BUG: a run on B must not shrink a1', idsOf(A.sessions, 'a1').length, MAX_SESSIONS);
  eq('THE BUG: the panel still reads History 5/5', `${idsOf(A.sessions, 'a1').length}/5`, `${MAX_SESSIONS}/5`);
  eq('THE BUG: a1 ids unchanged', idsOf(A.sessions, 'a1'), ['a1-5', 'a1-4', 'a1-3', 'a1-2', 'a1-1']);
  eq('the new session lands on BOTH devices', [idsOf(A.sessions, 'b1'), idsOf(B.sessions, 'b1')], [['run-b1'], ['run-b1']]);

  // A third device that was backgrounded during that run, then comes back and
  // edits something unrelated. Its frame never contained b1 — with a
  // replace-not-merge ingress this single edit wiped run-b1 everywhere.
  const C = dev('C');
  hub.subs.push(C);
  deliver(C, seed);
  edit(C, (s) => ({ ...s, llm: { ...s.llm, model: 'touched-by-C' } }));
  eq('a stale device editing an UNRELATED field cannot evict history', idsOf(A.sessions, 'b1'), ['run-b1']);
  eq('…and a1 is still whole on A', idsOf(A.sessions, 'a1').length, MAX_SESSIONS);
  eq('…and B still holds both', [idsOf(B.sessions, 'a1').length, idsOf(B.sessions, 'b1').length], [MAX_SESSIONS, 1]);
  assert('relay keeps a JSON-serializable frame', typeof JSON.stringify(hub.lastState) === 'string');

  // ── An explicit delete must still delete, on every device, and stay deleted.
  clearFor(A, 'a1');
  eq('clear: gone locally', idsOf(A.sessions, 'a1'), []);
  eq('clear: the other agent is untouched', idsOf(A.sessions, 'b1'), ['run-b1']);
  eq('clear: a tombstone was written', typeof A.sessionsClearedAt.a1, 'number');
  eq('clear: propagated to B', idsOf(B.sessions, 'a1'), []);

  // B keeps editing. A frame from B still carries no a1 stamp — the tombstone
  // must survive that, or the clear would be undone by the next round trip.
  edit(B, (s) => ({ ...s, llm: { ...s.llm, model: 'touched-by-B' } }));
  eq('clear: a later frame cannot resurrect cleared history', idsOf(A.sessions, 'a1'), []);

  // …but a session recorded AFTER the clear is a live session, not a ghost.
  recordSession(B, 'run-a1-later', 'a1');
  eq('clear: a NEW a1 session afterwards is kept', idsOf(A.sessions, 'a1'), ['run-a1-later']);

  // Retention across a restart: the durable bridge round-trips the tombstone.
  const cold = dev('cold');
  deliver(cold, hub.lastState);
  assert('restart: a fresh device still sees b1', idsOf(cold.sessions, 'b1').includes('run-b1'));
}

// ─────────────────────────────────────────────────────────────────────────────
// §4  Tombstone ordering: a cleared stamp filters BEFORE the per-agent cap, or
//     a deleted session would still consume a slot.
// ─────────────────────────────────────────────────────────────────────────────
{
  const dead = [sess('old-1', 'a1', 10), sess('old-2', 'a1', 20)];
  const merged = mergeSessions(dead, [], { a1: 25 });
  eq('tombstone: sessions at or before the stamp are dropped', merged, []);
  const kept = mergeSessions(dead, [], { a1: 15 });
  eq('tombstone: newer sessions survive it', kept.map((s) => s.id), ['old-2']);
  eq('mergeClearedAt: newest stamp wins', mergeClearedAt({ a1: 5, a2: 9 }, { a1: 7 }).a1, 7);
  eq('mergeClearedAt: an older stamp cannot go backwards', mergeClearedAt({ a1: 5 }, { a1: 2 }).a1, 5);
  eq('mergeClearedAt: undefined-safe', mergeClearedAt(undefined, undefined), {});
}

// ─────────────────────────────────────────────────────────────────────────────
// §5  Read paths still agree with the cap (the panel's own promise).
// ─────────────────────────────────────────────────────────────────────────────
{
  const panel = readFileSync(new URL('../src/web/AgentsPanel.tsx', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  has('panel counts per agent', panel, "state.sessions.filter((s) => s.agentId === agent.id)");
  has('panel label is per selected agent', panel, 'History · last {sessions.length}/5');
  has('glasses detail pane counts per agent', main, 'getAgents().sessions.filter((s) => s.agentId === agent.id)');
}

// ─────────────────────────────────────────────────────────────────────────────
// §6  Static wiring: the merge must be on EVERY write path, or the pure
//     function is decorative.
// ─────────────────────────────────────────────────────────────────────────────
{
  const store = readFileSync(new URL('../src/agents-store.ts', import.meta.url), 'utf8');
  const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
  const durable = readFileSync(new URL('../src/durable-agents.ts', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/web/AgentsPanel.tsx', import.meta.url), 'utf8');

  // Slice a function body up to the next TOP-LEVEL declaration or block comment.
  // A plain `\n}` search is not enough: a multi-line parameter list closes at
  // column 0 before the body even starts (`}): string {` in recordSession).
  const body = (src, name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) return '';
    const rest = src.slice(i + 1);
    const end = rest.search(/\n(?:export )?(?:async )?(?:function|const|type|interface) |\n\/\*\*|\n\/\/ ─/);
    return src.slice(i, end < 0 ? src.length : i + 1 + end);
  };

  has('types: prune groups per agent', body(types, 'pruneSessions'), 'perAgent');
  has('types: merge drops tombstoned sessions', body(types, 'mergeSessions'), 'clearedAt[s.agentId]');
  has('types: total ceiling exists', types, 'MAX_SESSIONS_TOTAL');

  has('store: remote frames MERGE sessions', body(store, 'applyRemoteAgents'), 'mergeSessions(state.sessions, next.sessions');
  has('store: local edits merge too', body(store, 'updateAgents'), 'mergeSessions(state.sessions, next.sessions');
  has('store: durable hydrate merges', body(store, 'hydrateAgentsDurable'), 'mergeSessions(state.sessions, sessions');
  has('store: recordSession merges (run id = session id)', body(store, 'recordSession'), 'mergeSessions(s.sessions, [session]');
  has('store: clearSessionsFor leaves a stamp', body(store, 'clearSessionsFor'), 'sessionsClearedAt');
  lacks('store: no path replaces sessions with a bare prune', store, 'sessions: pruneSessions(next.sessions)');
  lacks('store: no path replaces sessions from a frame', store, 'sessions: pruneSessions(next.sessions ?? [])');

  has('panel: Clear history goes through the tombstone', panel, 'clearSessionsFor(agent.id)');
  has('panel: deleting an agent tombstones its history', panel, 'clearSessionsFor(id)');
  lacks('panel: no raw session filter on delete', panel, 'sessions: s.sessions.filter(');

  has('durable: the tombstone survives a WebView teardown', durable, 'JSON.stringify({ agents, tools, llm, sessionsClearedAt })');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
