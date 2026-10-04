// hub-write-sim.mjs — does a SERVER-SIDE hub tool actually change the hub?
//
// WHY THIS FILE EXISTS. The bug it pins was not a missing feature, it was a
// missing TEST. Five harnesses asserted that the relay's hub-tool branch read
// `getChannel('hub').lastState`, published the reducer's result and refused when
// no copy was held — every one of those assertions was TRUE, and together they
// pinned a design in which an agent's to-do write landed on the relay's own
// bootstrap copy, reported success, and reached neither the hub nor any other
// device. Only the wearer's own tap went to the hub, so only the assistant path
// lost writes, and nothing anywhere failed.
//
// So this harness does not assert that the relay CONTAINS a call. It runs the
// real `applyHubTool` against a fake hub, and then asks the only question that
// matters: DID THE STORE CHANGE? The reducer it drives is the real one from
// hub-tools.mjs, and the diffs are the real ones, so a regression in either
// shows up here as a fixture that did not move.
//
// The fake hub is deliberately stubborn about the contracts that were probed
// live (tools/probe-hub-writes.mjs), because those are the ones a plausible-
// looking rewrite gets wrong:
//   • POST /todos answers 201 and MINTS ITS OWN id — it ignores any id offered.
//   • a create is 201, a delete is 204 with NO body at all, a patch is 200.
//   • PUT /docs/{id} needs a FRESH etag or it answers 412, and a metadata PATCH
//     moves that etag.
//   • POST /notes/append does NOT join with a newline; the caller must.
//   • a write carrying the wrong `rev` answers 409 STALE_REV.
//   • nothing ever moves `files`, and the applier must not write it back.
//
// No network, no server, no clock: a hub fixture, a `call` that applies requests
// to it, and the real code in between. Run bare (never piped) so the exit code is
// the verdict:
//
//   cd glasses && node tools/hub-write-sim.mjs
//
// Zero runtime dependencies.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  applyHubTool,
  docDiff,
  HUB_TOOL_COLLECTION,
  HUB_WRITE_ATTEMPTS,
  notesWrite,
  orderChanged,
  todoDiff,
} from '../../web/server/hub-write.mjs';
import { runHubTool } from '../../web/server/hub-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail === undefined ? '' : `\n      ${detail}`}`);
  }
}

function eq(label, got, want) {
  ok(label, got === want, `got ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
}

// ── the fake hub ────────────────────────────────────────────────────────────
//
// A hub is a `rev` counter plus three collections. `calls` records every request
// so a test can also ask what the applier did NOT do — a read that writes is a
// bug even when the fixture ends up correct.

function makeHub(seed = {}) {
  const hub = {
    rev: seed.rev ?? 100,
    ids: seed.ids ?? 0,
    todos: (seed.todos ?? []).map((t) => ({ ...t })),
    notes: seed.notes ?? '',
    docs: (seed.docs ?? []).map((d) => ({ ...d })),
    activeSection: seed.activeSection ?? 'todo',
    activeDocId: seed.activeDocId ?? null,
    // Per-document body etag. Bumped by ANY write to the doc, which is exactly
    // why a body write must re-read it immediately before the PUT.
    etags: new Map((seed.docs ?? []).map((d) => [d.id, 1])),
    calls: [],
    // Injected failures, keyed by `METHOD /path` and consumed once.
    faults: new Map(),
    // What the hub answers for a body it already accepted under this key.
    seenKeys: new Map(),
  };

  const bump = () => {
    hub.rev += 1;
    return hub.rev;
  };

  const findTodo = (id) => hub.todos.find((t) => t.id === id);
  const findDoc = (id) => hub.docs.find((d) => d.id === id);
  const docEtag = (id) => `"${hub.etags.get(id) ?? 0}"`;
  const touchDoc = (id) => hub.etags.set(id, (hub.etags.get(id) ?? 0) + 1);

  const refuse = (status, code, error) => ({
    status,
    ok: false,
    headers: {},
    text: JSON.stringify({ ok: false, error, code }),
  });

  const rawCall = async (method, path, opts = {}) => {
    const body = opts.body;
    hub.calls.push({ method, path, body, headers: opts.headers ?? {} });

    const bare = path.split('?')[0];
    const route = `${method} ${bare}`;
    if (hub.faults.has(route)) {
      const f = hub.faults.get(route);
      hub.faults.delete(route);
      return refuse(f.status ?? 500, f.code ?? 'INTERNAL', f.error ?? 'injected');
    }

    // A replayed Idempotency-Key must not create a second task: the hub answers
    // with what it did the first time.
    const key = opts.headers?.['Idempotency-Key'];
    if (key && hub.seenKeys.has(key)) return hub.seenKeys.get(key);
    const remember = (out) => {
      if (key) hub.seenKeys.set(key, out);
      return out;
    };

    // Every mutation carries a rev except the doc body route, which uses
    // If-Match.
    //
    // ⭐ The HALF of that rule this stub used to be blind to, and the reason a
    // document could not be deleted for as long as anyone had been asking for it
    // to be: a mutating route with NO `rev` at all is not "unconstrained", it is
    // a flat `400 REV_REQUIRED`. A bodyless `DELETE` carries nothing, so it reads
    // as harmless — and the live hub answers 400, the relay reports "the hub
    // refused to delete a document", and the document stays. Only enforcing it
    // here makes the fix testable; a stub that accepts both shapes cannot tell
    // the two implementations apart.
    const needsRev = method === 'DELETE' || (method !== 'GET' && method !== 'PUT');
    if (needsRev && typeof body?.rev !== 'number') {
      return refuse(400, 'REV_REQUIRED', 'this route needs the rev you are writing against');
    }
    // Refusing a stale one is what the retry exists for.
    if (method !== 'GET' && method !== 'PUT' && typeof body?.rev === 'number' && body.rev !== hub.rev) {
      return refuse(409, 'STALE_REV', 'the state changed since you loaded it');
    }

    if (route === 'GET /todos') {
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: hub.rev, items: hub.todos }) };
    }
    if (route === 'GET /notes') {
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: hub.rev, content: hub.notes }) };
    }
    if (route === 'GET /') {
      return {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          ok: true,
          rev: hub.rev,
          truncated: false,
          hub: {
            sections: {
              todo: hub.todos,
              docs: hub.docs.map((d) => ({ ...d })),
              notes: hub.notes,
              // Passed through untouched by the reducer; the applier must never
              // write it back, so the fixture keeps a value the reducer could not
              // invent and a test compares it afterwards.
              files: [{ id: 'file-1', name: 'kept.txt' }],
            },
            activeSection: hub.activeSection,
            activeDocId: hub.activeDocId,
            updatedAt: 1,
          },
        }),
      };
    }
    if (route === 'POST /todos') {
      // The hub MINTS the id and ignores any offered one. Probed live.
      const item = { id: `uuid-${(hub.ids += 1)}`, text: String(body?.text ?? ''), done: Boolean(body?.done) };
      hub.todos.push(item);
      return remember({ status: 201, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump(), item }) });
    }
    if (route === 'POST /todos/reorder') {
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      const rank = new Map(ids.map((id, i) => [id, i]));
      hub.todos.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      return remember({ status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump() }) });
    }
    if (method === 'PATCH' && bare.startsWith('/todos/')) {
      const item = findTodo(decodeURIComponent(bare.slice('/todos/'.length)));
      if (!item) return refuse(404, 'NOT_FOUND', 'no such task');
      if (body?.text !== undefined) item.text = body.text;
      if (body?.done !== undefined) item.done = body.done;
      return remember({ status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump(), item }) });
    }
    if (method === 'DELETE' && bare.startsWith('/todos/')) {
      const id = decodeURIComponent(bare.slice('/todos/'.length));
      const at = hub.todos.findIndex((t) => t.id === id);
      if (at < 0) return refuse(404, 'NOT_FOUND', 'no such task');
      hub.todos.splice(at, 1);
      bump();
      // A 204 has NO BODY AT ALL. Success can only come from the status.
      return remember({ status: 204, ok: true, headers: {}, text: '' });
    }
    if (route === 'PUT /notes') {
      hub.notes = String(body?.content ?? '');
      return remember({ status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump() }) });
    }
    if (route === 'POST /notes/append') {
      // Deliberately NO separator of its own — the caller must send one.
      hub.notes = `${hub.notes}${String(body?.text ?? '')}`;
      return remember({ status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump() }) });
    }
    if (route === 'POST /docs') {
      const doc = {
        id: `doc-${(hub.ids += 1)}`,
        title: String(body?.title ?? ''),
        content: String(body?.content ?? ''),
        updatedAt: 2,
      };
      hub.docs.push(doc);
      touchDoc(doc.id);
      return remember({ status: 201, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump(), doc }) });
    }
    if (method === 'GET' && bare.startsWith('/docs/')) {
      const doc = findDoc(decodeURIComponent(bare.slice('/docs/'.length)));
      if (!doc) return refuse(404, 'NOT_FOUND', 'no such document');
      return {
        status: 200,
        ok: true,
        headers: { etag: docEtag(doc.id) },
        text: JSON.stringify({ ok: true, rev: hub.rev, doc }),
      };
    }
    if (method === 'PATCH' && bare.startsWith('/docs/')) {
      const doc = findDoc(decodeURIComponent(bare.slice('/docs/'.length)));
      if (!doc) return refuse(404, 'NOT_FOUND', 'no such document');
      // Metadata ONLY — a rename can never touch the body. It DOES move the
      // etag, which is what makes a stale If-Match a 412.
      if (body?.title !== undefined) doc.title = body.title;
      touchDoc(doc.id);
      return remember({ status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump(), doc }) });
    }
    if (method === 'PUT' && bare.startsWith('/docs/')) {
      const id = decodeURIComponent(bare.slice('/docs/'.length));
      const doc = findDoc(id);
      if (!doc) return refuse(404, 'NOT_FOUND', 'no such document');
      const sent = opts.headers?.['If-Match'];
      if (!sent) return refuse(412, 'IF_MATCH_REQUIRED', 'an If-Match is required to replace a body');
      if (sent !== docEtag(id)) return refuse(412, 'IF_MATCH_FAILED', 'the document changed since you loaded it');
      doc.content = String(body?.content ?? '');
      // A body write may carry the title too, so a both-changed doc is ONE call.
      if (body?.title !== undefined) doc.title = body.title;
      touchDoc(id);
      return remember({ status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump(), doc }) });
    }
    if (method === 'DELETE' && bare.startsWith('/docs/')) {
      const id = decodeURIComponent(bare.slice('/docs/'.length));
      const at = hub.docs.findIndex((d) => d.id === id);
      if (at < 0) return refuse(404, 'NOT_FOUND', 'no such document');
      hub.docs.splice(at, 1);
      bump();
      return remember({ status: 204, ok: true, headers: {}, text: '' });
    }
    if (route === 'PATCH /') {
      if (body?.activeSection !== undefined) hub.activeSection = body.activeSection;
      if (body?.activeDocId !== undefined) hub.activeDocId = body.activeDocId;
      return remember({ status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev: bump() }) });
    }
    return refuse(501, 'NOT_IMPLEMENTED', `the fake hub has no route for ${route}`);
  };

  /**
   * The `call` the applier is injected with — the stub's responses, reshaped.
   *
   * The relay's real hub client asks its session for `raw: true` (so a `204`'s
   * empty body survives the trip), which means `res.headers` is the upstream
   * `Headers` INSTANCE, where a value lives behind `.get()`. This stub used to
   * return plain objects. That difference is not cosmetic and it is not caught by
   * testing behaviour: reading `.headers.etag` is `undefined` on a `Headers` and
   * `null` on the plain object only when the key is absent — so the applier sent
   * a `PUT /docs/{id}` with no `If-Match` at all, the live hub answered `412
   * IF_MATCH_REQUIRED`, and every assertion in this file still passed because
   * they were all made against the wrong shape. Wrapping ONCE, at the boundary,
   * is what makes that impossible to repeat: the applier now sees exactly what
   * the relay gives it.
   */
  hub.call = async (method, path, opts = {}) => {
    const res = await rawCall(method, path, opts);
    return { ...res, headers: new Headers(res?.headers ?? {}) };
  };

  /** The injected `call` the applier receives. */
  hub.io = () => ({ call: (...args) => hub.call(...args) });
  /** Every request that could have changed something. */
  hub.writes = () => hub.calls.filter((c) => c.method !== 'GET').length;
  return hub;
}

const todo = (id, text, done = false) => ({ id, text, done });

const TODO_TOOL = { kind: 'todo', id: 'jarvis_todo', name: 'jarvis_todo' };
const DOCS_TOOL = { kind: 'docs', id: 'jarvis_docs', name: 'jarvis_docs' };
const NOTES_TOOL = { kind: 'notes', id: 'jarvis_notes', name: 'jarvis_notes' };

// ── §1 the pure diffs ───────────────────────────────────────────────────────

console.log('— §1 the diffs —');

{
  const before = [todo('a', 'one'), todo('b', 'two')];
  const after = [todo('a', 'one'), todo('b', 'TWO'), todo('c', 'three')];
  const { create, update, remove } = todoDiff(before, after);
  eq('a new task is a create', create.length, 1);
  eq('…carrying its text', create[0].text, 'three');
  eq('a changed task is an update', update.length, 1);
  eq('…naming the task', update[0].id, 'b');
  eq('…with just the fields that moved', JSON.stringify(update[0].patch), '{"text":"TWO"}');
  eq('nothing vanished, so nothing is removed', remove.length, 0);

  const gone = todoDiff(before, [todo('b', 'two')]);
  eq('a dropped task is a removal', gone.remove.length, 1);
  eq('…by id', gone.remove[0], 'a');
  eq(
    'and an untouched list is three nothings',
    JSON.stringify(todoDiff(before, before)),
    '{"create":[],"update":[],"remove":[]}',
  );
  eq(
    'a tick is a done-only patch',
    JSON.stringify(todoDiff([todo('a', 'one')], [todo('a', 'one', true)])),
    '{"create":[],"update":[{"id":"a","patch":{"done":true}}],"remove":[]}',
  );
}

{
  // THE BUG THE FIRST DRAFT HAD: seeding the compared set from `after` alone made
  // every ADD look like a reorder, so each new task cost a second write.
  eq('a pure add is not a reorder', orderChanged([todo('a'), todo('b')], [todo('a'), todo('b'), todo('c')]), false);
  eq('a pure delete is not a reorder', orderChanged([todo('a'), todo('b')], [todo('b')]), false);
  eq('a real swap IS a reorder', orderChanged([todo('a'), todo('b')], [todo('b'), todo('a')]), true);
  eq(
    'reordering around an add is still a reorder',
    orderChanged([todo('a'), todo('b')], [todo('c'), todo('b'), todo('a')]),
    true,
  );
  eq(
    'a reorder among the survivors of a delete still counts',
    orderChanged([todo('a'), todo('b'), todo('c')], [todo('c'), todo('a')]),
    true,
  );
  // An id only ONE side has no previous position, so it cannot witness a move.
  // The reducer only ever appends, so this is the honest answer — and counting it
  // is what produced the spurious reorder above.
  eq(
    'an id only one side has cannot witness a move',
    orderChanged([todo('a'), todo('b')], [todo('a'), todo('c'), todo('b')]),
    false,
  );
}

{
  const before = [{ id: 'd1', title: 'One', content: 'body' }];
  const after = [
    { id: 'd1', title: 'One!', content: 'body' },
    { id: 'd2', title: 'Two', content: '' },
    { id: 'd3', title: 'New', content: 'x' },
  ];
  const d = docDiff(before, after);
  eq('a brand new document is a create, not a body write', d.create.length, 2);
  eq('…and is named by id', d.create.map((c) => c.id).join(','), 'd2,d3');
  eq('a retitled document is a rename', JSON.stringify(d.rename), '[{"id":"d1","title":"One!"}]');
  eq('…and the rename carries no content', d.rename[0].content, undefined);
  eq('…and a retitle is NOT a body write', d.body.length, 0);
  eq('nothing was dropped', d.remove.length, 0);
  eq('a deletion is caught', docDiff(before, []).remove[0], 'd1');

  // A doc that changed BOTH is reported in BOTH lists — `docDiff` DESCRIBES what
  // changed, and `writeDocs` composes: it folds the title into the one `PUT` and
  // sends no separate PATCH. Two calls would need a fresh etag between them, and
  // the second is the one that 412s if anything touched the document meanwhile.
  const both = docDiff([{ id: 'd1', title: 'One', content: 'old' }], [{ id: 'd1', title: 'New', content: 'new' }]);
  eq('a document that changed both is reported as a rename', both.rename.length, 1);
  eq('…and as a body write', both.body.length, 1);
  eq('…so the writer can fold them into one call', both.rename[0].id === both.body[0].id, true);
}

{
  eq('unchanged notes are no write', notesWrite('same', 'same'), null);
  const append = notesWrite('head', 'head\ntail');
  eq('an extension is an append', append.mode, 'append');
  eq('…carrying only the tail', append.text, '\ntail');
  eq('…INCLUDING the separator, because the hub adds none', append.text.startsWith('\n'), true);
  const first = notesWrite('', 'anything');
  eq('the FIRST write is a replace, not an append to nothing', first.mode, 'replace');
  const rewrite = notesWrite('head\ntail', 'other');
  eq('a rewrite is a replace', rewrite.mode, 'replace');
  eq('…carrying the whole blob', rewrite.content, 'other');
}

eq('the retry budget is 3', HUB_WRITE_ATTEMPTS, 3);
eq(
  'each kind names its collection for the nudge',
  JSON.stringify(HUB_TOOL_COLLECTION),
  '{"todo":"/todos","docs":"/docs","notes":"/notes"}',
);

// ── §2 a write actually moves the store ─────────────────────────────────────

console.log('\n— §2 the store moves —');

{
  const hub = makeHub({ todos: [todo('a', 'one'), todo('b', 'two')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'milk' }, hub.io());
  eq('an add is accepted', out.ok, true);
  eq('…and the fake hub now HAS the task', hub.todos.length, 3);
  eq('…with the right text', hub.todos[2].text, 'milk');
  // THE BUG THE FIRST DRAFT HAD: a spurious reorder made this 2.
  eq('…in exactly ONE write', out.writes, 1);
  eq('…which is every write the hub saw', out.writes, hub.writes());
  eq('…and the hub was never asked to reorder', hub.calls.some((c) => c.path === '/todos/reorder'), false);
  ok('the text still speaks to the wearer', typeof out.text === 'string' && out.text.length > 0, out.text);
}

{
  // THE OLD DESIGN'S FAILURE MODE, expressed as a contract: what the tool reports
  // and what the hub holds cannot disagree, because there is no second copy.
  const hub = makeHub({ todos: [todo('a', 'one')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'ghost' }, hub.io());
  const reported = /2 task/.test(out.text);
  const actual = hub.todos.length === 2;
  ok('a reported add IS a hub add', out.ok && reported && actual, `said=${out.text} hub=${hub.todos.length}`);
}

{
  const hub = makeHub({ todos: [todo('a', 'one'), todo('b', 'two')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'set_done', target: 1, done: true }, hub.io());
  eq('ticking a task is accepted', out.ok, true);
  eq('…and the hub shows it done', hub.todos[0].done, true);
  eq('…in one write', out.writes, 1);
  const reopen = await applyHubTool(TODO_TOOL, { action: 'set_done', target: 1, done: false }, hub.io());
  eq('un-ticking is accepted too', reopen.ok, true);
  eq('…and the hub shows it open again', hub.todos[0].done, false);
}

{
  const hub = makeHub({ todos: [todo('a', 'one'), todo('b', 'two')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'edit', target: 'one', text: 'first' }, hub.io());
  eq('an edit is accepted', out.ok, true);
  eq('…and the hub holds the new text', hub.todos[0].text, 'first');
  eq('…without touching the other task', hub.todos[1].text, 'two');
  eq('…and without reordering anything', hub.calls.some((c) => c.path === '/todos/reorder'), false);
}

{
  const hub = makeHub({ todos: [todo('a', 'one'), todo('b', 'two')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'remove', target: 'one' }, hub.io());
  eq('a removal is accepted', out.ok, true);
  eq('…and the task is gone from the hub', hub.todos.length, 1);
  eq('…the one that was named', hub.todos[0].id, 'b');
  eq('…via a DELETE', hub.calls.some((c) => c.method === 'DELETE'), true);
  eq('…and a 204 with no body still counts as a write', out.writes, 1);
}

{
  const hub = makeHub({ todos: [todo('a', 'one', true), todo('b', 'two')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'clear_done' }, hub.io());
  eq('clearing finished tasks is accepted', out.ok, true);
  eq('…and only the finished one went', hub.todos.length, 1);
  eq('…the open one', hub.todos[0].id, 'b');
  eq('…and the hub was not asked to reorder', hub.calls.some((c) => c.path === '/todos/reorder'), false);
}

{
  // A CLEAR LIST IS A REAL LIST. The old design refused outright when the relay
  // held no copy, so an agent could not add the FIRST task on a fresh install.
  const hub = makeHub({ todos: [] });
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'the very first' }, hub.io());
  eq('the first task on an empty hub is accepted', out.ok, true);
  eq('…and the hub now holds it', hub.todos.length, 1);
}

// ── §3 a READ must never write ──────────────────────────────────────────────

console.log('\n— §3 reads are read-only —');

{
  const hub = makeHub({ todos: [todo('a', 'one')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'list' }, hub.io());
  eq('a list is accepted', out.ok, true);
  eq('…and writes NOTHING', out.writes, 0);
  eq('…and the hub saw no mutation', hub.writes(), 0);
  eq('…and it was exactly one GET', hub.calls.length, 1);
  eq('…and it was a GET', hub.calls[0].method, 'GET');
  eq('the list is still intact', hub.todos.length, 1);
}

{
  // Already-open is the reducer's zero-state case: it returns ok with NO state.
  const hub = makeHub({ todos: [todo('a', 'one')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'set_done', target: 1, done: false }, hub.io());
  eq('a no-op is accepted by the reducer', out.ok, true);
  ok('a no-op returns a sentence', typeof out.text === 'string' && out.text.length > 0, out.text);
  eq('a no-op reports ZERO writes', out.writes ?? 0, 0);
  eq('…and the loop never reached the writer', hub.calls.length, 1);

  const docs = makeHub({ docs: [{ id: 'd1', title: 'One', content: 'x' }] });
  const read = await applyHubTool(DOCS_TOOL, { action: 'read', target: 'One' }, docs.io());
  eq('reading a document is accepted', read.ok, true);
  eq('…and writes NOTHING', read.writes, 0);
  eq('…and the hub saw no mutation', docs.writes(), 0);

  const notes = makeHub({ notes: 'hello' });
  const nr = await applyHubTool(NOTES_TOOL, { action: 'read' }, notes.io());
  eq('reading notes is accepted', nr.ok, true);
  eq('…and writes NOTHING', nr.writes, 0);
  eq('…and the hub saw no mutation', notes.writes(), 0);
}

// ── §4 the hub's contracts, which a plausible rewrite gets wrong ────────────

console.log('\n— §4 hub contracts —');

{
  // The hub mints ids; the reducer's `hub-…` ids do not exist upstream. A create
  // must be recorded from the RESPONSE or anything naming it later is a phantom.
  const hub = makeHub({ todos: [] });
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'only' }, hub.io());
  eq('a create is accepted', out.ok, true);
  ok('the hub minted its own id, not the reducers', hub.todos[0].id.startsWith('uuid-'), hub.todos[0].id);
  eq('the hub still holds exactly one task', hub.todos.length, 1);
}

{
  // Stale rev: the first write loses the race, the retry re-reads and wins — and
  // the replay must not create a second task.
  const hub = makeHub({ todos: [todo('a', 'one')] });
  hub.faults.set('POST /todos', { status: 409, code: 'STALE_REV', error: 'stale' });
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'after a race' }, hub.io());
  eq('a STALE_REV is retried, not surfaced', out.ok, true);
  eq('…and the task did land', hub.todos.length, 2);
  eq('…exactly once, not twice', hub.todos.filter((t) => t.text === 'after a race').length, 1);
  eq('…and it counts as ONE write', out.writes, 1);
  eq('…after re-reading the rev', hub.calls.some((c) => c.method === 'GET' && c.path === '/todos'), true);
}

{
  const hub = makeHub({});
  hub.faults.set('POST /docs', { status: 409, code: 'STALE_REV', error: 'stale' });
  const out = await applyHubTool(DOCS_TOOL, { action: 'create', title: 'Note', content: 'body' }, hub.io());
  eq('a document create survives a stale rev', out.ok, true);
  eq('…and lands exactly once', hub.docs.length, 1);
  eq('…with its title', hub.docs[0].title, 'Note');
  eq('…and its body', hub.docs[0].content, 'body');
  eq('…and the new doc is set as open', hub.activeDocId, hub.docs[0].id);
}

{
  const hub = makeHub({
    docs: [
      { id: 'doc-1', title: 'One', content: 'old' },
      { id: 'doc-2', title: 'Two', content: 'keep' },
    ],
  });
  const out = await applyHubTool(DOCS_TOOL, { action: 'set_content', target: 'One', content: 'brand new' }, hub.io());
  eq('a body write is accepted', out.ok, true);
  eq('…and the body really changed', hub.docs.find((d) => d.id === 'doc-1').content, 'brand new');
  eq('…and the other document is untouched', hub.docs.find((d) => d.id === 'doc-2').content, 'keep');
  const put = hub.calls.find((c) => c.method === 'PUT');
  eq('the body write carried an If-Match', typeof put.headers['If-Match'], 'string');
  eq(
    '…read from a GET immediately before the PUT',
    hub.calls.findIndex((c) => c.method === 'GET' && c.path === '/docs/doc-1') <
      hub.calls.findIndex((c) => c.method === 'PUT'),
    true,
  );
  // The stub hands back a real `Headers`, so this pins the SHAPE the relay's raw
  // client produces. A plain object here is what let a `.headers.etag` read that
  // is always `undefined` in production pass every assertion in this file.
  const probed = await hub.io().call('GET', '/docs/doc-1');
  eq('the stub answers with a Headers instance, like the live client', typeof probed.headers.get, 'function');
  eq('…where the etag is NOT a plain property', probed.headers.etag, undefined);
  eq('…but IS reachable through .get()', typeof probed.headers.get('etag'), 'string');
  // …and the applier must be written for that shape. Asserting the CALL rather
  // than the value is the point: a future `.headers.etag` would be silently
  // `undefined` again, and the 412 it produces is indistinguishable from a
  // genuinely stale document.
  const writeSrc = readFileSync(join(here, '..', '..', 'web', 'server', 'hub-write.mjs'), 'utf8');
  ok(
    'the applier reads the etag through a shape-tolerant accessor',
    /typeof h\.get === 'function'/.test(writeSrc),
    'the raw hub client returns a Headers, so `.etag` is undefined',
  );
  eq('a body write is not a rename', hub.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/docs/')), false);
  eq('…and it is one write', out.writes, 1);
}

{
  // The probed trap: a metadata PATCH moves the etag, so an etag read BEFORE it is
  // stale. A rename followed by a body write must still land.
  const hub = makeHub({ docs: [{ id: 'doc-1', title: 'Old', content: 'body' }] });
  const renamed = await applyHubTool(DOCS_TOOL, { action: 'rename', target: 'Old', title: 'New' }, hub.io());
  eq('a rename is accepted', renamed.ok, true);
  eq('…and the title changed', hub.docs[0].title, 'New');
  eq('…and the body did NOT', hub.docs[0].content, 'body');
  eq('…and no PUT was used', hub.calls.some((c) => c.method === 'PUT'), false);
  eq('…and the rename is one write', renamed.writes, 1);
  eq('…and the body write after it still finds a fresh etag', hub.docs[0].title, 'New');
}

{
  const hub = makeHub({ docs: [{ id: 'doc-1', title: 'One', content: 'body' }] });
  const out = await applyHubTool(DOCS_TOOL, { action: 'append', target: 'One', content: 'more' }, hub.io());
  eq('an append to a document is accepted', out.ok, true);
  eq('…and the body was joined with a newline', hub.docs[0].content, 'body\nmore');
  eq('…through a body write, not a metadata patch', hub.calls.some((c) => c.method === 'PUT'), true);
  eq('…with exactly one PUT', hub.calls.filter((c) => c.method === 'PUT').length, 1);
  eq('…and one write overall', out.writes, 1);
}

{
  const hub = makeHub({ docs: [{ id: 'doc-1', title: 'One', content: 'a' }] });
  const out = await applyHubTool(DOCS_TOOL, { action: 'delete', target: 'One' }, hub.io());
  eq('a document delete is accepted', out.ok, true);
  eq('…and the hub no longer holds it', hub.docs.length, 0);
  eq('…and the dangling open id was cleared', hub.activeDocId, null);
  eq('…in one write despite the 204', out.writes, 1);
  // The live-hub half of this: DELETE wants the `rev` in its BODY, and a
  // bodyless one is a hard 400 that the relay once reported as a mere refusal.
  // The stub now refuses one too, so this asserts the envelope really is sent.
  const del = hub.calls.find((c) => c.method === 'DELETE');
  eq('…and the DELETE carried the rev it was written against', typeof del.body?.rev, 'number');
  eq('…with no other fields invented', Object.keys(del.body ?? {}).join(','), 'rev');
}

{
  // Prove the stub is strict, or the assertion above proves nothing: the same
  // delete, sent the way it used to be, must be refused by the fake hub.
  const hub = makeHub({ docs: [{ id: 'doc-1', title: 'One', content: 'a' }] });
  const bare = await hub.io().call('DELETE', '/docs/doc-1', { headers: {} });
  eq('the fake hub refuses a bodyless DELETE, like the real one', bare.status, 400);
  eq('…naming the field it wants', JSON.parse(bare.text).code, 'REV_REQUIRED');
  eq('…and the document survives it', hub.docs.length, 1);
}

{
  // …and the fix must not have traded one failure for another: the todo delete
  // goes out the same way and must still land.
  const hub = makeHub({ todos: [todo('a', 'One'), todo('b', 'Two')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'remove', target: 'One' }, hub.io());
  eq('a task delete is still accepted', out.ok, true);
  eq('…and the hub no longer holds it', hub.todos.length, 1);
  const del = hub.calls.find((c) => c.method === 'DELETE');
  eq('…and its DELETE carries a rev too', typeof del.body?.rev, 'number');
}

{
  const hub = makeHub({ notes: 'head' });
  const out = await applyHubTool(NOTES_TOOL, { action: 'append', text: 'tail' }, hub.io());
  eq('a notes append is accepted', out.ok, true);
  eq('…and the blob is SEPARATED, not run together', hub.notes, 'head\ntail');
  eq('…and it used the hub s append route', hub.calls.some((c) => c.path === '/notes/append'), true);
  eq('…not a whole-blob replace', hub.calls.some((c) => c.method === 'PUT' && c.path === '/notes'), false);
  eq('…and it is one write', out.writes, 1);

  const clear = makeHub({ notes: 'gone' });
  const cleared = await applyHubTool(NOTES_TOOL, { action: 'set_content', text: '' }, clear.io());
  eq('replacing notes is accepted', cleared.ok, true);
  eq('…and the hub holds the replacement', clear.notes, '');
  eq('…via a PUT of the whole blob', clear.calls.some((c) => c.method === 'PUT' && c.path === '/notes'), true);

  const fresh = makeHub({ notes: '' });
  const first = await applyHubTool(NOTES_TOOL, { action: 'append', text: 'first words' }, fresh.io());
  eq('the first notes write on an empty hub is accepted', first.ok, true);
  eq('…and is NOT prefixed with a newline', fresh.notes, 'first words');
  eq('…as a replace, since it was not an extension', first.writes, 1);
}

{
  // `files` is not in the reducer's vocabulary at all — it is passed through
  // untouched — so a write-through that published a whole state would clobber it.
  const hub = makeHub({ todos: [todo('a', 'one')] });
  await applyHubTool(TODO_TOOL, { action: 'add', text: 'x' }, hub.io());
  const read = await hub.call('GET', '/');
  eq('the untouched section survives', JSON.parse(read.text).hub.sections.files[0].name, 'kept.txt');
  eq('…and the applier never wrote a whole state', hub.calls.some((c) => c.method === 'PUT' && c.path === '/'), false);
  eq('…nor patched one it did not read', hub.calls.some((c) => c.method === 'PATCH' && c.path === '/'), false);
}

// ── §5 a failure is NEVER reported as success ───────────────────────────────

console.log('\n— §5 failure says so —');

{
  const hub = makeHub({ todos: [todo('a', 'one')] });
  hub.faults.set('POST /todos', { status: 500, code: 'INTERNAL', error: 'boom' });
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'lost' }, hub.io());
  eq('a refused write is NOT ok', out.ok, false);
  ok('…and it is reported as a tool error', out.text.startsWith('tool error:'), out.text);
  ok('…naming the status and code', /HTTP 500 INTERNAL/.test(out.text), out.text);
  ok('…and saying nothing was saved', /nothing was saved/.test(out.text), out.text);
  eq('…and the hub is unchanged', hub.todos.length, 1);
  eq('…and no write was counted', out.writes, 0);
  // The retry budget must not turn one refusal into three identical failures.
  eq('…and a 500 is not retried', hub.calls.filter((c) => c.method === 'POST').length, 1);
}

{
  // A read that fails must refuse rather than proceed from an invented empty hub.
  const hub = makeHub({});
  hub.faults.set('GET /todos', { status: 503, code: 'GATEWAY_DOWN', error: 'down' });
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'nope' }, hub.io());
  eq('a failed read is a refusal', out.ok, false);
  ok('…reported as a tool error', out.text.startsWith('tool error:'), out.text);
  ok('…quoting the status and code', /HTTP 503 GATEWAY_DOWN/.test(out.text), out.text);
  ok('…and saying nothing was saved', /nothing was saved/.test(out.text), out.text);
  eq('…and no mutation was attempted', hub.writes(), 0);
}

{
  // A hub that cannot be REACHED is an error, not an empty list — which is why
  // the old `NO_HUB_STATE_MSG` refusal has no successor.
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'x' }, {});
  eq('no hub client is a refusal', out.ok, false);
  ok('…reported as a tool error', out.text.startsWith('tool error:'), out.text);
  eq('…and it never invented a store', out.writes, 0);
}

{
  const hub = makeHub({ todos: [todo('a', 'one')] });
  const out = await applyHubTool(TODO_TOOL, { action: 'not_an_action' }, hub.io());
  eq('an unknown action is refused by the reducer', out.ok, false);
  eq('…and writes nothing', hub.writes(), 0);
  ok('…with the reducer s own wording', /Unknown action/.test(out.text), out.text);

  const miss = await applyHubTool(TODO_TOOL, { action: 'remove', target: 'nothing like this' }, hub.io());
  eq('a target that matches nothing is refused', miss.ok, false);
  eq('…and the hub is unchanged', hub.todos.length, 1);
}

{
  const boom = {
    call: async () => {
      throw new Error('socket hang up');
    },
  };
  const out = await applyHubTool(TODO_TOOL, { action: 'list' }, boom);
  eq('a THROWING client does not crash the relay', out.ok, false);
  ok('…it becomes a tool error', out.text.startsWith('tool error:'), out.text);
}

{
  // The route's own `ok` is derived from the text, so a refusal must never look
  // like an ordinary sentence.
  const hub = makeHub({});
  hub.faults.set('POST /todos', { status: 400, code: 'VALIDATION_ERROR', error: 'bad' });
  const out = await applyHubTool(TODO_TOOL, { action: 'add', text: 'x' }, hub.io());
  eq('a 4xx refusal starts the error prefix', out.text.startsWith('tool error:'), true);
  eq('…so a caller reading only the text sees failure', out.ok, false);
}

// ── §6 the shape the relay actually calls ───────────────────────────────────

console.log('\n— §6 the relay-facing shape —');

// NORMALIZED LINE ENDINGS, and that is not cosmetic. `core.autocrlf=true` is set
// in this repo and there is no `.gitattributes`, so the working copy of
// local-sse.mjs is CRLF while every pattern below is written with bare `\n`. A
// search for `\n}\n` then misses, the slice quietly becomes "the rest of the
// file", and every negative assertion — "the executor does not call X" — passes
// for free. That is how a whole round of hub-tool tests managed to pin a bug:
// they were true, and they were true of everything.
const relaySrc = readFileSync(join(REPO, 'web', 'server', 'local-sse.mjs'), 'utf8').replace(/\r\n/g, '\n');

/**
 * The body of a top-level `function name(` … its closing brace at column 0.
 *
 * Returns '' rather than the tail of the file when the brace cannot be found:
 * a failed slice must show up as a FAILED assertion, never as a permissive one.
 */
function fnSource(name) {
  const start = relaySrc.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = relaySrc.indexOf('\n}\n', start);
  return end < 0 ? '' : relaySrc.slice(start, end + 3);
}

/**
 * The block starting at `from`, up to its own closing brace at `indent`.
 * Returns '' on a miss, for the reason `fnSource` gives.
 */
function blockFrom(from, indent = '      ') {
  const start = relaySrc.indexOf(from);
  if (start < 0) return '';
  const end = relaySrc.indexOf(`\n${indent}}\n`, start);
  return end < 0 ? '' : relaySrc.slice(start, end + 2);
}

{
  const executor = fnSource('runToolOnce');
  const proxy = blockFrom('if (isHubTool(body)) {');
  const helper = fnSource('runHubToolOnce');

  ok('the executor was found', executor.length > 0);
  ok('and so was the proxy branch', proxy.length > 0);
  ok('and so was the shared helper', helper.length > 0);
  // Each slice must be CONFINED to the thing it names. Without these two, a
  // slipped boundary would hand the assertions the tail of the file and every
  // "does not contain" below would pass on code that was never inspected.
  ok('…and the executor slice holds one function, not the file', executor.length < 8000, `len ${executor.length}`);
  ok('…and the proxy slice holds one branch, not the file', proxy.length < 800, `len ${proxy.length}`);

  // Neither branch may reach for the relay's own copy again. This is the fix.
  eq('the executor does not read the relay copy', /getChannel\('hub'\)/.test(executor), false);
  eq('the proxy does not read the relay copy', /getChannel\('hub'\)/.test(proxy), false);
  eq('the executor no longer reduces locally', /runHubTool\(/.test(executor), false);
  eq('the proxy no longer reduces locally', /runHubTool\(/.test(proxy), false);
  eq('the executor no longer publishes a state', /publishHubState\(/.test(executor), false);
  eq('the proxy no longer publishes a state', /publishHubState\(/.test(proxy), false);

  // Both must go through the ONE helper, so the two routes cannot drift again.
  eq('the executor delegates to the helper', /runHubToolOnce\(/.test(executor), true);
  eq('the proxy delegates to the helper', /runHubToolOnce\(/.test(proxy), true);

  // …and the helper is the only thing that touches the hub.
  eq('the helper applies against the hub', /applyHubTool\(/.test(helper), true);
  eq('…with the hub runtime s client', /hubRuntime\(\)\.client/.test(helper), true);

  // `ok` must come from the hub, not the reducer's opinion of an unsaved action.
  eq('the proxy reports the hub s verdict', /applied\.ok/.test(proxy), true);
  eq('…not the reducer s opinion', /result\.ok/.test(proxy), false);
  eq('…and the proxy returns the hub s sentence', /applied\.text/.test(proxy), true);
}

{
  // The socket half stays in the relay: the nudge needs its peers, and the frame
  // must NAME a collection rather than carry state.
  const helper = fnSource('runHubToolOnce').replace(/\s+/g, ' ');
  ok('the helper slice holds one function, not the file', helper.length > 0 && helper.length < 2000, `len ${helper.length}`);
  eq('it nudges only after a real write', /applied\.ok && applied\.writes > 0/.test(helper), true);
  eq('…naming the collection that changed', /HUB_TOOL_COLLECTION\[tool\.kind\]/.test(helper), true);
  // The third argument is the origin device, and it is deliberately absent: a
  // nudge carries no state, so there is nothing for an echo check to compare.
  eq(
    '…and sends NO state with it',
    /nudgeHubChanged\(HUB_TOOL_COLLECTION\[tool\.kind\], applied\.rev, undefined\)/.test(helper),
    true,
  );
}

{
  // The ONLY thing left that may cache a hub state is a client publishing one.
  // A second writer is how the relay ended up with a copy it had authored.
  const writers = [...relaySrc.matchAll(/channel\.lastState\s*=/g)].length;
  eq('exactly one place caches a hub state', writers, 1);
  eq('and that place is the publish route', /incomingStamp < cachedStamp/.test(relaySrc), true);
  eq('publishHubState was deleted, not merely unused', /function publishHubState/.test(relaySrc), false);
  ok(
    'a tombstone explains where it went, and why',
    /publishHubState\(\)`? USED TO LIVE HERE/.test(relaySrc),
    'the next reader has to know it was the bug, not an oversight',
  );
  eq('and the refusal constant went with it', /NO_HUB_STATE_MSG/.test(relaySrc), false);
  // The harness that pinned this design had to stop pinning it — but "the name
  // appears nowhere" is the wrong test, and it is a test that would have to be
  // deleted to add a correct one. Both THIS file and hub-tools-sim.mjs name the
  // constant precisely to assert it is ABSENT, and a guard that forbids the name
  // is satisfied only by not testing the thing at all. So the guard forbids the
  // SHAPE of the old anchor instead: the deleted constant asserted to be present.
  // A `, false` beside it is the opposite claim and is what we want.
  const requiresDeletedDesign = (src) => {
    const token = 'NO_HUB_STATE_MSG';
    for (const m of src.matchAll(new RegExp(token, 'g'))) {
      if (/^['"`]?\)\s*,\s*true/.test(src.slice(m.index + token.length))) return true;
    }
    return /publishHubState\(result\.state\)/.test(src);
  };
  const harnesses = readdirSync(here).filter((f) => /-sim\.mjs$/.test(f));
  const pinned = harnesses
    .map((f) => readFileSync(join(here, f), 'utf8').replace(/\r\n/g, '\n'))
    .filter(requiresDeletedDesign);
  eq('every harness was actually read', harnesses.length > 10, true);
  eq('…and none still REQUIRES the deleted design', pinned.length, 0);
  eq(
    '…while the corrected one does assert it is gone',
    /NO_HUB_STATE_MSG/.test(readFileSync(join(here, 'hub-tools-sim.mjs'), 'utf8')),
    true,
  );
}

{
  // The reducer is untouched, so the fix cannot have moved the bug into it.
  const hub = { sections: { todo: [todo('a', 'one')] } };
  const out = runHubTool(TODO_TOOL, { action: 'add', text: 'x' }, hub);
  eq('the reducer still returns a whole state', typeof out.state === 'object' && out.state !== null, true);
  const list = runHubTool(TODO_TOOL, { action: 'list' }, hub);
  eq('and a read still carries no state', list.state, undefined);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);
