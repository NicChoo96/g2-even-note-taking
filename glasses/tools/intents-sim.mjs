#!/usr/bin/env node
// Harness for the delegated-intent executor — src/ai/intents.ts.
//
// WHY THIS EXISTS. To the ledger and to the wearer, a delegated action must be
// indistinguishable from a spoken one. Three claims carry that, and none is
// visible by reading the module on its own:
//
//   1. THE RULE IS A RULE. `delegable()` is a predicate over the registry — the
//      app's own capability table decides which actions an agent may ask for.
//      Adding a tenth destructive capability must make it delegable with no edit
//      here. A hand-written allow-list would pass every named check in this file,
//      so section A feeds it capabilities that were never registered.
//   2. CLAIMING IS ONCE. A run's transcript is replayed to every client on
//      reconnect, so a claim that is not idempotent re-proposes everything a run
//      ever asked for. Section D replays a transcript and requires silence.
//   3. THE GATE SURVIVES THE HAND-OFF. An irreversible intent must be approved by
//      the wearer AND recorded under the ASKING run, because the ledger's safety
//      invariant (`ungatedIrreversible`) matches the gate on runId. Section E is
//      the assertion that ties the delegated path to that invariant, and it is
//      the check that found the bug this file exists to keep out: gates raised
//      for an agent were being filed under whatever run was current locally.
//
// Anything that goes wrong asynchronously is reported as a failure rather than
// killing the process, because a floating rejection inside the drain would
// otherwise exit 1 after printing every check as passing.
//
// Run: cd glasses && node tools/intents-sim.mjs

import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let fail = 0;
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`PASS  ${label}`);
};
const bad = (label, detail = '') => {
  checks++;
  fail++;
  console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
};
const assert = (label, cond, detail = '') => (cond ? ok(label) : bad(label, detail));
const eq = (label, got, want) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(label)
    : bad(label, `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);

process.on('unhandledRejection', (err) => {
  bad('no unhandled rejection', `${err instanceof Error ? err.message : String(err)}`);
});
process.on('uncaughtException', (err) => {
  bad('no uncaught exception', `${err instanceof Error ? err.message : String(err)}`);
});

// ── Fake host ───────────────────────────────────────────────────────────────
// BEFORE any module loads: these stores read localStorage as they initialise.
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true, writable: true });
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
globalThis.fetch = async (url) => {
  void url;
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' };
};

// ── Bundle the real modules ─────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'intents-sim-'));
const stub = join(dir, 'sdk-stub.mjs');
writeFileSync(
  stub,
  [
    'export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }',
    'export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }',
    'export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }',
    'export const utf8ByteLength = (s) => Buffer.byteLength(s, "utf8");',
    'export const measureTextWrap = () => ({ lineCount: 1 });',
    'export default {};',
  ].join('\n'),
);
const outfile = join(dir, 'bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * from './ai/intents.ts';",
      "export * from './ai/ledger.ts';",
      "export * as pages from './ai/pages.ts';",
      "export * as store from './ai/store.ts';",
      "export { allCapabilities, asksToConfirm, capabilityByName } from './ai/registry.ts';",
      "export { effectOf, GLOBAL_PAGE } from './ai/types.ts';",
    ].join('\n'),
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  alias: { '@evenrealities/even_hub_sdk': stub },
  define: { 'import.meta.env': '{}' },
});

const M = await import(pathToFileURL(outfile).href);
const {
  allCapabilities,
  asksToConfirm,
  claimIntents,
  delegable,
  effectOf,
  GLOBAL_PAGE,
  intentCatalog,
  intentsFromMessages,
  ledgerEntries,
  pages,
  resetIntents,
  resetLedger,
  runPendingIntents,
  store,
  ungatedIrreversible,
} = M;
const { aiAnswerConfirm } = store;

/** A relay tool result exactly as web/server/intents.mjs writes it. */
const proposal = (key, action, args = {}, why = 'because', title = action) =>
  JSON.stringify({ ok: true, summary: `asked the app to ${title}`, data: { intent: { key, action, title, args, why, effect: 'write' } } });
const toolMsg = (content) => ({ role: 'tool', content, tool: 'jarvis_app' });
const RUN = { id: 'run-1', agentId: 'agent-1', agentName: 'Tracker' };

const fresh = () => {
  resetLedger();
  resetIntents();
  aiAnswerConfirm(false); // clear any resolver left by an earlier section
};

// ── Register the app's capabilities ─────────────────────────────────────────
// `pages.ts` does NOT register on import: `registerDefaultCatalog()` is the one
// call that installs the ordering table, and the app makes it at boot. A harness
// that skipped it would find an empty registry and read "nothing is delegable"
// as a pass on every check below.
pages.registerDefaultCatalog();
const byName = (n) => allCapabilities().find((c) => c.name === n);

// ═══════════════════════════════════════════════════════════════════════════
section('A. delegable() is a rule over the registry, not a list');

const REAL = allCapabilities().filter(delegable);

// The registration is asserted rather than assumed.
eq('the one ordering table installed the registry', pages.catalogCapabilities.length, allCapabilities().length);
assert('the registry has capabilities at all', allCapabilities().length > 20, `${allCapabilities().length}`);
assert('the rule excludes something', REAL.length < allCapabilities().length, `${REAL.length} of ${allCapabilities().length}`);
assert('a plain write is delegable', delegable(byName('todo.add')) === true);
assert('an irreversible delete is delegable', delegable(byName('todo.clear_all')) === true);
assert('reading is not', delegable(byName('docs.read')) === false);
assert('nor is listing', delegable(byName('nav.list_pages')) === false);
assert('the globals an agent finishes with are delegable', delegable(byName('say.reply')) && delegable(byName('nav.open_page')));
assert('but NOT every global — undo is the wearer\'s own hand', delegable(byName('undo.last')) === false);
assert('and not the read-only global', delegable(byName('app.status')) === false);
assert('settings are never delegated', realSettings().length > 0 && realSettings().every((c) => !delegable(c)));

function realSettings() {
  return allCapabilities().filter((c) => c.page === 'settings');
}

// ⭐ THE CONTROL. These capabilities are NOT in the registry: if `delegable`
// were a membership list, no such object could be delegable, and every named
// check above would still pass. This is what makes the rule real.
const unregistered = (page, effect) => ({ name: 'made.up', page, effect, title: 't', description: 'd', params: [], run: () => ({ ok: true, summary: '' }) });
assert('CONTROL: an unregistered write is delegable by its own shape', delegable(unregistered('todo', 'write')) === true);
assert('CONTROL: an unregistered irreversible delete is delegable', delegable(unregistered('docs', 'irreversible')) === true);
assert('CONTROL: an unregistered read is not', delegable(unregistered('todo', 'read')) === false);
assert('CONTROL: an unregistered write on a settings page is not', delegable(unregistered('settings', 'write')) === false);
assert('CONTROL: an unregistered pure global is not', delegable(unregistered(GLOBAL_PAGE, 'pure')) === false);

// ⭐ And every delegable action is gated the way the ledger expects: an
// irreversible one MUST ask to confirm, or the intent would run unapproved.
eq(
  'every delegable irreversible action asks the wearer',
  REAL.filter((c) => effectOf(c) === 'irreversible' && !asksToConfirm(c)).map((c) => c.name),
  [],
);

// ═══════════════════════════════════════════════════════════════════════════
section('B. the catalogue is derived, and survives the trip');

const CATALOG = intentCatalog();
eq('one spec per delegable capability', CATALOG.length, REAL.length);
eq(
  'every spec mirrors its capability',
  CATALOG.filter((s) => {
    const c = byName(s.name);
    return !c || s.effect !== effectOf(c) || s.title !== c.title || s.page !== c.page || s.description !== c.description;
  }).map((s) => s.name),
  [],
);
eq('a global action says any page rather than naming one', CATALOG.find((s) => s.name === 'say.reply').pageTitle, 'Any page');
eq('a page-bound action names its page', CATALOG.find((s) => s.name === 'todo.add').page, 'todo');
assert('no settings action is offered', CATALOG.every((s) => s.page !== 'settings'));
assert('undo is not offered', !CATALOG.some((s) => s.name === 'undo.last'));

// ⭐ THE WIRE CONTRACT. The relay normalises this catalogue and drops a name
// without a dot (and any duplicate) — silently, because it cannot tell a
// malformed entry from one it should not have been sent. So a spec that would
// vanish in flight is a gap nobody would see on either end.
const dotted = CATALOG.every((s) => typeof s.name === 'string' && s.name.includes('.'));
assert('every name survives the relay\'s normaliser (page.action)', dotted, CATALOG.filter((s) => !s.name.includes('.')).map((s) => s.name).join(', '));
eq('no name is sent twice', CATALOG.length - new Set(CATALOG.map((s) => s.name)).size, 0);
const round = JSON.parse(JSON.stringify(CATALOG));
eq('the catalogue is plain JSON', round, CATALOG);
assert(
  'every spec has a title, a description and a params array',
  CATALOG.every((s) => s.title && s.description && Array.isArray(s.params)),
);
assert(
  'every param has a name and a type',
  CATALOG.every((s) => s.params.every((p) => typeof p.name === 'string' && p.name && typeof p.type === 'string')),
);
// A read is only ever offered as the globals an agent needs to route and answer:
// `nav.open_page` is classed read, and it HAS to be delegable or an agent could
// not reach the page its next ask belongs to. No page-bound action joins it.
eq('a page action is never a read', CATALOG.filter((s) => s.page !== GLOBAL_PAGE && s.effect === 'read').map((s) => s.name), []);
eq('the only read offered is the one that opens a page', CATALOG.filter((s) => s.effect === 'read').map((s) => s.name), ['nav.open_page']);

// ═══════════════════════════════════════════════════════════════════════════
section('C. reading proposals back out of a transcript');

eq('no transcript is no proposals', intentsFromMessages(undefined), []);
eq('an empty transcript is no proposals', intentsFromMessages([]), []);
eq(
  'only tool results are read',
  intentsFromMessages([{ role: 'assistant', content: proposal('k1', 'todo.add') }]),
  [],
);
eq(
  'a tool result that is not JSON is skipped',
  intentsFromMessages([toolMsg('I have added that to your list.')]),
  [],
);
eq(
  'and neither is JSON that is not a proposal',
  intentsFromMessages([toolMsg(JSON.stringify({ results: 'a search result' })), toolMsg(JSON.stringify({ data: { intent: {} } }))]),
  [],
);
eq(
  'and an array body is not one either',
  intentsFromMessages([toolMsg(JSON.stringify([{ data: { intent: { key: 'k', action: 'todo.add' } } }]))]),
  [],
);

const one = intentsFromMessages([toolMsg(proposal('run-7:1', 'todo.add', { text: 'milk' }, 'the wearer asked for milk', 'Add a to-do'))]);
eq('a proposal is read', one.length, 1);
eq('with its key', one[0].key, 'run-7:1');
eq('its action', one[0].action, 'todo.add');
eq('its arguments', one[0].args, { text: 'milk' });
eq('its reason', one[0].why, 'the wearer asked for milk');
eq('its title', one[0].title, 'Add a to-do');
eq('a missing title falls back to the action', intentsFromMessages([toolMsg(proposal('k', 'todo.add'))])[0].title, 'todo.add');

eq(
  'the same key twice is one proposal',
  intentsFromMessages([toolMsg(proposal('k1', 'todo.add')), toolMsg(proposal('k1', 'todo.add'))]).length,
  1,
);
eq(
  'and a transcript is capped, so a looping model cannot flood the queue',
  intentsFromMessages([1, 2, 3, 4, 5, 6].map((i) => toolMsg(proposal(`run-7:${i}`, 'todo.add', { text: `i${i}` })))).length,
  4,
);

// ═══════════════════════════════════════════════════════════════════════════
section('D. claiming a proposal is idempotent');

fresh();
const msgs = [toolMsg(proposal('run-7:1', 'say.reply', { text: 'milk is on the list' }))];
const claimed = claimIntents(RUN, msgs);
eq('a proposal is claimed once', claimed.length, 1);
eq('the claim is a pending call', [claimed[0].kind, claimed[0].status, claimed[0].by, claimed[0].locus], ['call', 'pending', 'agent', 'client']);
eq('attributed to the asking run, not the local one', claimed[0].runId, 'run-1');
eq('carried into the ledger with its own effect class', claimed[0].effect, effectOf(byName('say.reply')));
assert('and named after the agent that asked', claimed[0].text.startsWith('Tracker: '), claimed[0].text);
eq('the key is namespaced by the run', claimed[0].payload.key, 'run-1:run-7:1');
eq('the source is recorded, so the claim is recognisable later', claimed[0].payload.source, 'agent-run');
eq('and the agent is named in the payload', [claimed[0].payload.agentId, claimed[0].payload.agentName], ['agent-1', 'Tracker']);
eq('the payload names the registry action, not the wire one', claimed[0].payload.intent.action, 'say.reply');
eq('and carries the effect the ledger will classify it by', claimed[0].payload.intent.effect, 'pure');

// A run with no id cannot be attributed, so it is refused rather than guessed at.
eq('a run with no id claims nothing', claimIntents({ id: '' }, msgs), []);
eq('an agent that asked nothing claims nothing', claimIntents(RUN, []), []);

// ⭐ THE REPLAY. The relay hands a run's transcript to every client that
// reconnects, so this is the difference between "one proposal" and "the same
// proposal again every time the glasses wake up".
eq('replaying the transcript claims nothing again', claimIntents(RUN, msgs), []);
eq('a second agent can still claim its own', claimIntents({ id: 'run-2', agentName: 'Mailer' }, msgs).length, 1);

fresh();
const bogus = claimIntents(RUN, [toolMsg(proposal('run-7:9', 'todo.explode', { text: 'x' }))]);
eq('an action this app does not have is not claimed', bogus.length, 0);
const errs = ledgerEntries().filter((e) => e.kind === 'error');
eq('but it is recorded, not dropped silently', errs.length, 1);
assert('and the record names the action', errs[0].text.includes('todo.explode'), errs[0].text);
eq('as a failure', errs[0].status, 'failed');
// Defence in depth: the relay's enum is built from this same catalogue, so a
// READ action arriving here means the payload did not come from this app.
eq('a read action is refused the same way', claimIntents(RUN, [toolMsg(proposal('k', 'docs.read'))]).length, 0);
eq('and a settings action too', claimIntents(RUN, [toolMsg(proposal('k2', 'settings.open'))]).length, 0);

// ═══════════════════════════════════════════════════════════════════════════
section('E. the drain runs it, once, and the ledger sees a spoken-shaped action');

/** Run the queue, answering any gate the way the wearer would. */
async function drain(answer) {
  const work = runPendingIntents();
  await Promise.resolve();
  aiAnswerConfirm(answer);
  // A second answer covers the (impossible today) case of two gates in one drain.
  await Promise.resolve();
  aiAnswerConfirm(answer);
  return work;
}

fresh();
claimIntents(RUN, [toolMsg(proposal('run-7:1', 'say.reply', { text: 'milk is on the list' }))]);
const drained = await drain(true);
eq('the intent ran', drained.length, 1);
eq('and succeeded', [drained[0].ok, drained[0].action], [true, 'say.reply']);
eq('the summary is the capability\'s own', drained[0].summary, 'milk is on the list');
eq('the ledger shows it at the agent\'s run', ledgerEntries('run-1').filter((e) => e.kind === 'call' && e.status === 'ok').length, 1);

// ⭐ THE TERMINATION CASE. `ledgerResolve` appends rather than mutates, so the
// original proposal stays 'pending' forever. A queue built on `pendingEntries`
// alone would run this intent again on every single drain, forever.
const again = await drain(true);
eq('draining again runs nothing', again, []);
eq('and the capability did not run a second time', ledgerEntries('run-1').filter((e) => e.kind === 'call' && e.status === 'ok').length, 1);
const resolved = ledgerEntries('run-1').filter((e) => e.refs.length && e.kind === 'call' && e.status === 'ok');
assert('the outcome cites the proposal it answers', resolved.length === 1 && resolved[0].refs.length === 1);

/**
 * A transport that behaves like the hub's to-do list, for the length of one
 * block.
 *
 * Every to-do write is CONFIRMED now: it re-reads the list and only reports
 * success if the change is in it. Against this harness's default `404` that
 * makes the write FAIL — which is the right answer, and the wrong fixture for a
 * block that asserts what a SUCCESSFUL delegated action leaves in the ledger.
 * So the list is kept here, the write is applied to it, and the read-back is
 * answered out of it.
 */
const todoStub = () => {
  let items = [];
  let rev = 1;
  const answer = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });
  return async (_url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (method === 'GET') return answer({ ok: true, rev, items });
    rev += 1;
    if (method === 'PUT') {
      items = Array.isArray(body.items) ? body.items.map((t) => ({ ...t })) : [];
      return answer({ ok: true, rev, items });
    }
    if (method === 'POST') {
      const item = { id: `todo-${items.length + 1}`, text: String(body.text ?? ''), done: false };
      items.push(item);
      return answer({ ok: true, rev, item });
    }
    return answer({ error: 'not found' });
  };
};

// ⭐ THE SAFETY INVARIANT: an irreversible action that succeeded without a gate
// must be impossible, and that is as true for an agent's ask as for the wearer's.
//
// A WORKING LIST IS INSTALLED FIRST, which is not incidental. `todo.clear_all`
// runs through `setTasks`, and with the default `404` transport that write would
// now be REPORTED as a failure — so the checks below would be asserting the shape
// of a success while driving a failure, and the gate ordering would be read off a
// call that never happened.
const offlineFetch = globalThis.fetch;
globalThis.fetch = todoStub();
fresh();
// The destructive action is only AVAILABLE while there is something to delete,
// and it is seeded through the capability itself — the same call the app makes,
// not a direct poke at the store. It is AWAITED, because the row is not really on
// the list until the hub has confirmed it: the confirmation adopts the hub's own
// list, so a create still in flight can be unpainted by it.
await byName('todo.add').run({ text: 'milk' });
assert('the destructive action is available with something to delete', byName('todo.clear_all').available?.() !== false);
claimIntents(RUN, [toolMsg(proposal('run-7:2', 'todo.clear_all', {}, 'start the week clean', 'Clear the list'))]);
const entries = claimIntents(RUN, [toolMsg(proposal('run-7:2', 'todo.clear_all', {}, 'start the week clean', 'Clear the list'))]);
eq('the destructive ask is claimed once', entries, []);
eq('and its claim is filed against the asking run', ledgerEntries('run-1').filter((e) => e.status === 'pending').length, 1);
assert('the claim itself is irreversible', ledgerEntries('run-1').some((e) => e.status === 'pending' && e.effect === 'irreversible'));

// Declined first: the wearer reads the prompt and says no.
const declined = await drain(false);
eq('a declined ask does not run', declined[0].ok, false);
assert('and the reason says it was declined', declined[0].summary.startsWith('declined'), declined[0].summary);
eq('the invariant still holds', ungatedIrreversible().length, 0);
assert(
  'and the refusal is on the record, because "the model proposed this and it was refused" is the evidence',
  ledgerEntries('run-1').some((e) => e.kind === 'gate' && e.status === 'declined'),
);

// Then approved. The gate has to be filed under the SAME run as the action, or
// the invariant below cannot see the approval and reports the approved action as
// ungated — which is exactly the bug this section was written to catch.
fresh();
claimIntents(RUN, [toolMsg(proposal('run-7:3', 'todo.clear_all', {}, 'start the week clean', 'Clear the list'))]);
const approved = await drain(true);
eq('an approved destructive ask runs', approved.length, 1);
assert('and reports what it did', approved[0].ok === true, approved[0].summary);
const gateEntries = ledgerEntries('run-1').filter((e) => e.kind === 'gate');
assert('the gate was raised against the asking run', gateEntries.length >= 2, `gate entries: ${gateEntries.length}`);
assert('and answered', gateEntries.some((e) => e.status === 'ok'));
// ⭐ THE ORDERING, which is what makes the invariant sharp: a gate is only
// `isGated`'s answer for an action recorded AFTER it. Reverse the two and the
// approved action reads as ungated while still looking approved.
const callSeq = ledgerEntries('run-1').find((e) => e.kind === 'call' && e.status === 'ok')?.seq ?? 0;
const gateSeq = ledgerEntries('run-1').find((e) => e.kind === 'gate' && e.status === 'ok')?.seq ?? 0;
assert('and logged BEFORE the action it gates', gateSeq > 0 && gateSeq < callSeq, `gate seq ${gateSeq}, call seq ${callSeq}`);
eq('so the ledger does NOT show an ungated irreversible success', ungatedIrreversible().length, 0);
globalThis.fetch = offlineFetch;

// ⭐ The chain brake. agent→agent is allowed, but a run an agent started may not
// start another one, or a single ask from the wearer could spend the key
// indefinitely with nothing in the UI to show for it.
fresh();
claimIntents({ id: 'run-A', agentName: 'Planner' }, [toolMsg(proposal('run-7:4', 'agents.trigger', { agent: 'agent-2' }, 'chain please', 'Run an agent'))]);
resetIntents(['run-A']); // as if run-A had itself been started by an intent
const braked = await drain(true);
eq('a chain is refused', braked.length, 1);
eq('and not run', braked[0].ok, false);
assert('for a reason that says so', braked[0].summary.includes('started by an agent'), braked[0].summary);
assert(
  'and it is SKIPPED rather than FAILED — nothing went wrong with the action',
  ledgerEntries('run-A').some((e) => e.kind === 'call' && e.status === 'skipped'),
);
// And the brake is per-run, not a latch: an unrelated run may still delegate.
resetIntents();
claimIntents({ id: 'run-B', agentName: 'Planner' }, [toolMsg(proposal('run-7:5', 'say.reply', { text: 'ok' }))]);
const unbraked = await drain(true);
eq('an unrelated run is not braked', [unbraked.length, unbraked[0]?.ok], [1, true]);

// An ask that is claimed but cannot be PREPARED is settled as failed rather than
// skipped or thrown: the relay validates shape, this device validates values,
// and a bad value from a run nobody is watching must still leave a record.
fresh();
claimIntents(RUN, [toolMsg(proposal('run-7:6', 'todo.add', {}, 'add nothing', 'Add a to-do'))]);
const invalid = await drain(true);
eq('an ask with unuseable arguments is attempted', invalid.length, 1);
eq('and fails rather than running', invalid[0].ok, false);
assert('with the validator\'s own words', invalid[0].summary.includes('text'), invalid[0].summary);
assert('recorded as a failure', ledgerEntries('run-1').some((e) => e.kind === 'call' && e.status === 'failed'));
eq('and it cannot be replayed either', (await drain(true)).length, 0);

// ⭐ Two runs landing together must not run one intent twice. `draining` is the
// guard, and the observable form of it is that the second caller gets the FIRST
// promise rather than a second queue.
fresh();
claimIntents(RUN, [toolMsg(proposal('run-7:7', 'say.reply', { text: 'once' }))]);
const a = runPendingIntents();
const b = runPendingIntents();
assert('a second drain joins the first rather than starting one', a === b);
await Promise.resolve();
aiAnswerConfirm(false);
const [ra, rb] = await Promise.all([a, b]);
eq('and both callers see the same single outcome', [ra.length, rb.length], [1, 1]);
eq('the capability ran exactly once', ledgerEntries('run-1').filter((e) => e.kind === 'call' && e.status === 'ok').length, 1);
// And the guard is released afterwards, or the queue would go deaf for the rest
// of the session.
claimIntents(RUN, [toolMsg(proposal('run-7:8', 'say.reply', { text: 'again' }))]);
const after = await drain(false);
eq('and the queue is not left deaf afterwards', [after.length, after[0].summary], [1, 'again']);

// ═══════════════════════════════════════════════════════════════════════════
section('F. a delegated WRITE is confirmed against the store, not assumed');

// WHY THIS SECTION EXISTS. The report this came from was not a broken publish;
// it was a publish that never happened and a run that said it had. Two things
// made that sentence writable, and neither is visible from the relay alone:
//
//   • `files.publish` carried `confirm: true` on a `write`. The gate is the one
//     step a DELEGATED run cannot pass — `aiAskConfirm` answers false when the
//     phone is in a pocket — so the page was declined by default, and a decline
//     the wearer never sees is indistinguishable from a success.
//   • a publish was reported from the CREATE RESPONSE. A response is the hub
//     answering; the store is what can be listed or opened a moment later.
//     Nothing read the page back, so "published" described a reply.
//
// The checks below drive the REAL capability through the REAL drain over a
// stubbed transport, because what is under test is the pair of statements the
// device makes afterwards, and both are statements about the STORE.

const realFetch = globalThis.fetch;
const HEX = 'a'.repeat(32);
/** Every request the store saw, in order, so a missing read-back is a failure. */
const wire = [];
/**
 * A transport that behaves like the store for exactly one test.
 * `created` answers the POST, `back` answers the read-back GET — `null` on
 * either means that route 404s, which is how the bug's shape is reproduced.
 */
const storeStub = (created, back) => async (url, init) => {
  const method = String(init?.method ?? 'GET').toUpperCase();
  wire.push(`${method} ${String(url)}`);
  const body = method === 'GET' ? back : created;
  return {
    ok: !!body,
    status: body ? 200 : 404,
    headers: { get: () => null },
    text: async () => JSON.stringify(body ?? { error: 'not found' }),
  };
};
/** One `file_ref` as the hub's wire spells it. */
const record = (over = {}) => ({
  rev: 1,
  file: {
    id: HEX,
    title: 'Daily digest',
    agent: 'Tracker',
    slug: 'daily-digest',
    tags: ['digest'],
    version: 1,
    size: 19_200,
    url: `https://hub.test/f/${HEX}`,
    updatedAt: 1_700_000_000_000,
    ...over,
  },
});
const PAGE = { html: '<!DOCTYPE html><html><body><h1>Digest</h1></body></html>', title: 'Daily digest' };
const ask = (key, action, args, title) => toolMsg(proposal(key, action, args, 'because', title));

// ⭐ THE GATE, ASSERTED RATHER THAN ASSUMED. A write an agent performs must not
// ask the wearer, because there is no wearer to ask: a gate here does not add
// friction, it deletes the write. The irreversible half of publishing is
// `files.delete`, which stays gated — and section A's registry-wide invariant
// is what keeps that true for every capability added later.
eq('publish is a write', effectOf(byName('files.publish')), 'write');
eq('and does NOT raise the gate a delegated run cannot pass', asksToConfirm(byName('files.publish')), false);
eq('while destroying a page still does', asksToConfirm(byName('files.delete')), true);

// ⭐ THE LINE IS "CAN THIS BE UNDONE?", NOT "IS THE EFFECT STRING THE SAME?".
// `files.revert` is classed `write` because the gateway APPENDS a revert entry —
// the versions it replaces stay in the history, so it can itself be reverted.
// That is why it needs no gate. The two to-do deletes are ALSO classed `write`
// and KEEP theirs, because they destroy the wearer's text outright with no
// history behind it.
//
// Both halves are asserted. A check that only proved `files.revert` was
// un-gated would let the next person un-gate `todo.remove` for symmetry and
// still see this section pass — and the symmetry is exactly the mistake, since
// these capabilities share an effect string while disagreeing about whether the
// wearer can get their data back.
eq('a revert can itself be reverted, so it needs no gate', asksToConfirm(byName('files.revert')), false);
eq('but deleting a task keeps one — it destroys text with no history', asksToConfirm(byName('todo.remove')), true);
eq('and so does clearing the finished ones', asksToConfirm(byName('todo.clear_done')), true);

// ⭐ THE HAPPY PATH IS THE READ-BACK. The create is answered AND so is the read,
// so the sentence kept is the one about the store.
fresh();
wire.length = 0;
globalThis.fetch = storeStub(record(), record());
claimIntents(RUN, [ask('run-8:1', 'files.publish', PAGE, 'Publish an HTML page')]);
const [pub] = await drain(true);
eq('a page-sized publish runs', [pub?.ok, pub?.action], [true, 'files.publish']);
assert('and the summary says the STORE was read back', pub.summary.includes('read back from the store'), pub.summary);
// 19_200 bytes through `sizeLabel` is `19 KB` — the number and the unit both
// come from the stored record, so this is evidence the read-back happened.
assert('naming the size only the stored record knows', pub.summary.includes('(19 KB)'), pub.summary);
eq('the create was exactly one request', wire.filter((c) => c.startsWith('POST')).length, 1);
assert('and the page was then READ BACK by its id', wire.some((c) => c.startsWith('GET') && c.includes(HEX)), wire.join(' | '));

// ⭐ THE FAILURE THAT MATTERS, and the exact shape of the bug: the hub accepts
// the create and no read can find the page. Before the read-back this was
// reported as "Published"; now that word cannot be said at all.
fresh();
wire.length = 0;
globalThis.fetch = storeStub(record(), null);
claimIntents(RUN, [ask('run-8:2', 'files.publish', PAGE, 'Publish an HTML page')]);
const [ghost] = await drain(true);
eq('a publish no read can find is NOT a success', [ghost.ok, ghost.action], [false, 'files.publish']);
assert('and says so in the word that cannot be mistaken for one', ghost.summary.includes('UNCONFIRMED'), ghost.summary);
assert('naming the page it could not find', ghost.summary.includes('Daily digest'), ghost.summary);
assert('with the read-back proven to have been attempted', wire.some((c) => c.startsWith('GET') && c.includes(HEX)), wire.join(' | '));
assert('and the ledger holds a FAILURE, not a result', ledgerEntries('run-1').some((e) => e.kind === 'call' && e.status === 'failed'));

// A store that answers with the page already marked DELETED is the same answer
// as no answer: `deletedAt` present is how the wire spells it (see toStoredDoc).
fresh();
globalThis.fetch = storeStub(record(), record({ deletedAt: 1_700_000_001_000, deletedReason: 'deleted by mcp client' }));
claimIntents(RUN, [ask('run-8:3', 'files.publish', PAGE, 'Publish an HTML page')]);
const [buried] = await drain(true);
eq('a page the store already holds as deleted is not published', buried.ok, false);
// ⭐ AND IT HAS TO SURVIVE THE LINE. `oneLine` is 80 characters, and the reason
// is what tells the wearer whether to RESTORE this page or publish it again —
// so the check is that the distinguishing word is actually IN the summary, not
// merely that some summary was produced.
assert('and the summary says which of the two it was', buried.summary.includes('marked deleted'), buried.summary);
assert('in full, not truncated past the distinguishing word', !buried.summary.includes('\u2026'), buried.summary);

// ⭐ AND THE SAME RULE FOR A DOCUMENT. `docs.new` mints its own id, so its
// read-back is a list lookup rather than a fetch — but the claim it supports is
// identical, and the char count in the summary can only come from the record
// the list actually holds.
fresh();
claimIntents(RUN, [ask('run-8:4', 'docs.new', { title: 'Standup notes', content: 'today' }, 'Create document')]);
const [madeDoc] = await drain(true);
eq('a new document runs', [madeDoc.ok, madeDoc.action], [true, 'docs.new']);
assert('and its summary says the LIST was read back', madeDoc.summary.includes('read back from the list'), madeDoc.summary);
assert(
  'quoting a length only the stored document knows',
  madeDoc.summary.includes('(5 chars)') && madeDoc.summary.includes('Standup notes'),
  madeDoc.summary,
);

globalThis.fetch = realFetch;

console.log(`\n${fail ? `${fail} FAILURE(S)` : 'ALL CHECKS PASSED'} — ${checks - fail} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
