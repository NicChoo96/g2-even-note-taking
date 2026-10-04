// Hub write-through — apply an agent's hub tool call to the HUB.
//
// THE BUG THIS EXISTS TO KILL.
//   `runToolOnce` used to serve a hub tool from the relay channel's `lastState`:
//   it ran the pure reducer over that snapshot, wrote the result back with
//   `publishHubState()` and never spoke to the hub at all. So an agent's "add
//   milk" landed in a copy of the list that lives on the RELAY's disk — a file
//   that is git-ignored locally and, in the container, sits on an ephemeral
//   filesystem with no volume. The wearer saw the frame arrive and the row
//   appear, the tool reported success, and the hub never heard about it: no
//   other device could see it, and a redeploy erased it.
//
//   The relay read it correctly from the wearer's own client path, which is why
//   only the ASSISTANT path lost writes. `GET /api/hub/todos` was always fine.
//
// WHY A DIFF AND NOT A PUT.
//   The reducer is a pure function of a whole `HubState` and returns a whole
//   `HubState`, so the tempting shortcut is `PUT /hub` with what it produced.
//   That is wrong twice over: it needs a `rev` the caller never held, and it
//   overwrites everything the read did not cover — another device's edit landing
//   between the read and the write is silently destroyed. Worse, `PUT /hub/todos`
//   does NOT keep the ids it is given (probed: supplied ids are discarded and the
//   hub mints uuids), so a wholesale write would churn every task's identity and
//   make the app's optimistic updates re-adopt the whole list.
//
//   So this module READS the hub, runs the SAME pure reducer over what it read,
//   and then issues only the hub calls the difference requires — the same routes,
//   in the same shape, that the app itself uses when a wearer taps. `hub-tools.mjs`
//   stays pure and unchanged; only the way its output reaches the store changes.
//
// WHAT IT NEVER DOES.
//   - A read (`list`, `read`) returns no `state`, so it issues ZERO writes. The
//     "only a change carries a `state`" rule in hub-tools.mjs is what makes that
//     true, and this module leans on it rather than re-deriving it.
//   - It never invents a hub. A hub it could not read is a refusal, not an empty
//     list — the reducer would happily add a task to `normalizeHub(null)` and a
//     write based on that would look like a success.
//   - It never publishes a state the relay did not receive from a client. The
//     caller nudges instead; see the call site.

import { randomUUID } from 'node:crypto';
import { HUB_TOOL_KINDS, normalizeHub, runHubTool } from './hub-tools.mjs';

/** How many times one write is re-sent after losing a `rev` race. */
export const HUB_WRITE_ATTEMPTS = 3;

/** The codes that mean "your `rev`/etag is stale, re-read and try again". */
const STALE_CODES = new Set(['STALE_REV', 'IF_MATCH_FAILED', 'IF_MATCH_REQUIRED']);

/**
 * The cheapest read that can seed each kind's reducer, and how to turn its
 * answer into a `HubState`.
 *
 * `docs` reads `GET /hub` rather than `GET /docs?include=content` — probed at
 * 74 KB with 20 documents, so the size argument does not separate them — because
 * the document actions are the only ones that touch `activeDocId` and
 * `activeSection`, and the state bundle is the one route that carries those
 * alongside the bodies. Without `activeDocId`, "delete the document I have open"
 * would remove the document from the hub and leave the app pointing at a row
 * that is gone.
 *
 * Both doc reads were verified COMPLETE and flagged `truncated: false` against
 * every document's own route, which is what makes diffing on a body safe: a
 * partial body here would read as an edit and rewrite the wearer's document with
 * a shorter one.
 */
const READ = {
  todo: { path: '/todos', from: (d) => ({ sections: { todo: d?.items } }) },
  notes: { path: '/notes', from: (d) => ({ sections: { notes: d?.content } }) },
  docs: { path: '/', from: (d) => d?.hub },
};

/**
 * What a client should refetch after each kind changes.
 *
 * The caller fans this out as a `hub-changed` nudge. It is the COLLECTION and
 * not the read path above: a nudge naming `/` would send every device after the
 * whole state document — correct, costly, and impossible to notice.
 */
export const HUB_TOOL_COLLECTION = { todo: '/todos', docs: '/docs', notes: '/notes' };

/** `JSON.parse` out of a raw hub reply, without ever throwing. */
function describe(res) {
  const status = Number(res?.status);
  let data = null;
  if (typeof res?.text === 'string' && res.text) {
    try {
      data = JSON.parse(res.text);
    } catch {
      data = null;
    }
  }
  const numeric = Number.isFinite(status);
  return {
    status: numeric ? status : 0,
    // Prefer the status when there is one: a `204` carries no body at all, so
    // `data` is null on every successful delete and cannot be the success signal.
    ok: numeric ? status >= 200 && status < 300 : Boolean(res?.ok),
    code: typeof data?.code === 'string' ? data.code : null,
    data,
    rev: typeof data?.rev === 'number' ? data.rev : null,
    etag: etagOf(res),
  };
}

/**
 * The `ETag` a response carried, from either shape this module can be handed.
 *
 * The relay's hub client asks the session for `raw: true` (so a `204`'s empty
 * body survives), which means it hands back the upstream `Headers` INSTANCE —
 * where the value lives behind `.get()`. A plain object is what a stub returns.
 *
 * Reading only `.etag` looked right, and it was right against every stub. Against
 * the live hub it silently produced `null`, so the `PUT` went out with no
 * `If-Match` and the hub answered `412 IF_MATCH_REQUIRED`: the assistant could
 * never write a document body. This is the second half of the reported bug, and
 * it survived the first fix because a stub that returns a different shape than
 * the real client tests the stub, not the client.
 */
function etagOf(res) {
  const h = res?.headers;
  if (!h) return null;
  // `Headers.get` is case-insensitive, so one call covers every spelling.
  if (typeof h.get === 'function') return h.get('etag') || null;
  return h.etag || h.ETag || null;
}

/** `409 STALE_REV`, or `HTTP 0` for a hub that said nothing at all. */
function statusLine(out) {
  const base = out.status ? `HTTP ${out.status}` : 'no answer';
  return out.code ? `${base} ${out.code}` : base;
}

/** A refusal the model can read and route around — see the `tool error:` rule. */
function refused(why) {
  return { ok: false, text: `tool error: ${why}`, writes: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diffs — pure, so a harness can pin them without a socket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What changed in a to-do list, by id so an edit is one PATCH and not a rewrite.
 *
 * Ids are the reducer's own (`hub-…` for anything it minted), which is why the
 * applier has to translate a created id to the one the hub returns.
 */
export function todoDiff(before = [], after = []) {
  const prev = new Map((before || []).map((t) => [t?.id, t]));
  const kept = new Set((after || []).map((t) => t?.id));
  const create = (after || []).filter((t) => !prev.has(t.id));
  const remove = (before || []).filter((t) => !kept.has(t.id)).map((t) => t.id);
  const update = [];
  for (const item of after || []) {
    const was = prev.get(item.id);
    if (!was) continue;
    const patch = {};
    if (was.text !== item.text) patch.text = item.text;
    if (Boolean(was.done) !== Boolean(item.done)) patch.done = Boolean(item.done);
    if (Object.keys(patch).length) update.push({ id: item.id, patch });
  }
  return { create, update, remove };
}

/**
 * Whether the SURVIVING tasks are still in the order the reducer produced.
 *
 * The reducer appends, filters and edits but never reorders, so this is a guard
 * rather than a path: if it ever gains a move, the hub has to be told or the
 * model's idea of "task 3" silently stops matching the wearer's screen.
 */
export function orderChanged(before = [], after = []) {
  const inBefore = new Set((before || []).map((t) => t?.id));
  const inAfter = new Set((after || []).map((t) => t?.id));
  // Only ids in BOTH lists may speak about order. A task that was just created,
  // or just deleted, has no previous position to compare against — and seeding
  // the set from `after` alone made every ADD look like a reorder, which cost a
  // second write per task and could only ever do nothing.
  const shared = (t) => inBefore.has(t?.id) && inAfter.has(t?.id);
  const ids = (list) => (list || []).filter(shared).map((t) => t.id);
  return ids(before).join('\u0000') !== ids(after).join('\u0000');
}

/** What changed in the document library: new, gone, retitled, re-bodied. */
export function docDiff(before = [], after = []) {
  const prev = new Map((before || []).map((d) => [d?.id, d]));
  const kept = new Set((after || []).map((d) => d?.id));
  const create = (after || []).filter((d) => !prev.has(d.id));
  const remove = (before || []).filter((d) => !kept.has(d.id)).map((d) => d.id);
  const rename = [];
  const body = [];
  for (const doc of after || []) {
    const was = prev.get(doc.id);
    if (!was) continue;
    if ((was.title || '') !== (doc.title || '')) rename.push({ id: doc.id, title: doc.title || '' });
    if ((was.content ?? '') !== (doc.content ?? '')) {
      body.push({ id: doc.id, content: doc.content ?? '' });
    }
  }
  return { create, remove, rename, body };
}

/**
 * How to store a new notes blob — or null when it did not change.
 *
 * An append is the only notes mutation that EXTENDS the blob, so a previous
 * value that is a strict prefix of the new one IS an append. Sending just the
 * tail through `/notes/append` rather than a whole-blob `PUT` keeps the hub's
 * own append semantics in play and means two devices appending at once merge
 * instead of one clobbering the other. A previous value of `''` is deliberately
 * NOT treated as a prefix: the first write is a replace, not an append to
 * nothing.
 */
export function notesWrite(before = '', after = '') {
  if (before === after) return null;
  if (before && after.startsWith(before) && after.length > before.length) {
    return { mode: 'append', text: after.slice(before.length) };
  }
  return { mode: 'replace', content: after };
}

// ─────────────────────────────────────────────────────────────────────────────
// The hub writer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tiny writer that owns the one thing every hub mutation needs and no diff
 * function should have to think about: a `rev` that is current.
 *
 * `rev` is the hub's forward-only counter over the whole state document, so the
 * value from the seeding read is correct for the FIRST write and every response
 * thereafter carries the next one. A write that loses the race gets a `STALE_REV`,
 * and the retry re-reads the counter and re-sends the SAME body under the SAME
 * `Idempotency-Key` — so a retry the hub already accepted is a no-op instead of a
 * second task.
 */
function createWriter({ call, signal, revPath, rev: seed }) {
  let rev = typeof seed === 'number' ? seed : null;
  let writes = 0;

  async function refreshRev() {
    const out = describe(await call('GET', revPath, { signal }));
    if (out.rev != null) rev = out.rev;
    return out.rev;
  }

  async function send({ method, path, body, key = randomUUID() }) {
    let out = null;
    for (let attempt = 1; attempt <= HUB_WRITE_ATTEMPTS; attempt += 1) {
      // The `rev` rides in the BODY, and that includes a `DELETE`.
      //
      // A DELETE has no fields of its own, so the obvious thing is to send no
      // body at all — and `DELETE /hub/docs/{id}` answers `400 REV_REQUIRED` for
      // exactly that. Probing the live hub settled it: a bodyless DELETE is a
      // flat 400, the SAME delete with a stale `rev` is a 409, and with a fresh
      // `rev` it is a 204. It never wanted an `If-Match`; that is the `PUT` of a
      // document body and nothing else. So a bodyless write is still an envelope
      // with one field in it, and "delete the document I have open" — a thing the
      // wearer can plainly ask for — stopped being a permanent no-op.
      const payload = rev == null ? (body ?? {}) : { ...(body ?? {}), rev };
      out = describe(
        await call(method, path, { body: payload, headers: { 'Idempotency-Key': key }, signal }),
      );
      if (out.rev != null) rev = out.rev;
      if (out.ok) {
        writes += 1;
        return out;
      }
      if (!STALE_CODES.has(out.code)) return out;
      if ((await refreshRev()) == null) return out;
    }
    return out;
  }

  /**
   * `PUT /hub/docs/{id}` is the ONE route that takes an `If-Match` instead of a
   * `rev`, so its etag has to be re-read on every attempt: a rename or another
   * device's edit moves it, and replaying a stale etag is a `412` that would spin
   * until the attempt budget ran out. Taking it fresh each time turns the second
   * attempt into a real write instead of a guaranteed failure — and a genuine
   * conflict still surfaces as a `412` rather than destroying someone's page.
   */
  async function sendBody(path, body) {
    const key = randomUUID();
    let out = null;
    for (let attempt = 1; attempt <= HUB_WRITE_ATTEMPTS; attempt += 1) {
      const head = describe(await call('GET', path, { signal }));
      if (head.rev != null) rev = head.rev;
      if (!head.ok) return head;
      const headers = { 'Idempotency-Key': key };
      if (head.etag) headers['If-Match'] = head.etag;
      out = describe(await call('PUT', path, { body, headers, signal }));
      if (out.rev != null) rev = out.rev;
      if (out.ok) {
        writes += 1;
        return out;
      }
      if (!STALE_CODES.has(out.code)) return out;
    }
    return out;
  }

  return {
    send,
    sendBody,
    get writes() {
      return writes;
    },
    get rev() {
      return rev;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The appliers, one per kind
// ─────────────────────────────────────────────────────────────────────────────

async function writeTodos(before, after, writer) {
  const { create, update, remove } = todoDiff(before.sections.todo, after.sections.todo);

  for (const { id, patch } of update) {
    const out = await writer.send({ method: 'PATCH', path: `/todos/${encodeURIComponent(id)}`, body: patch });
    if (!out.ok) return { ok: false, why: `the hub refused a task edit (${statusLine(out)}), so nothing was saved` };
  }

  // Created ids are the reducer's; the hub mints its own and the response is the
  // only place they meet. Kept so the reorder guard below can name real tasks.
  const minted = new Map();
  for (const item of create) {
    const out = await writer.send({
      method: 'POST',
      path: '/todos',
      body: { text: item.text, done: Boolean(item.done) },
    });
    if (!out.ok) return { ok: false, why: `the hub refused a new task (${statusLine(out)}), so nothing was saved` };
    const id = out.data?.item?.id;
    if (typeof id === 'string' && id) minted.set(item.id, id);
  }

  for (const id of remove) {
    const out = await writer.send({ method: 'DELETE', path: `/todos/${encodeURIComponent(id)}` });
    // A `204` has no body, so this is the one place a route's success cannot be
    // read from the payload — `describe` uses the status.
    if (!out.ok) return { ok: false, why: `the hub refused to delete a task (${statusLine(out)}), so nothing was saved` };
  }

  if (orderChanged(before.sections.todo, after.sections.todo)) {
    const known = new Set(before.sections.todo.map((t) => t.id));
    const ids = after.sections.todo.map((t) => minted.get(t.id) ?? t.id);
    const resolvable = after.sections.todo.every((t) => minted.has(t.id) || known.has(t.id));
    if (resolvable) {
      const out = await writer.send({ method: 'POST', path: '/todos/reorder', body: { ids } });
      if (!out.ok) return { ok: false, why: `the hub refused the new order (${statusLine(out)}), so nothing was saved` };
    }
  }

  return { ok: true };
}

async function writeNotes(before, after, writer) {
  const next = notesWrite(before.sections.notes, after.sections.notes);
  if (!next) return { ok: true };
  const out =
    next.mode === 'append'
      ? await writer.send({ method: 'POST', path: '/notes/append', body: { text: next.text } })
      : await writer.send({ method: 'PUT', path: '/notes', body: { content: next.content } });
  if (!out.ok) return { ok: false, why: `the hub refused the notes write (${statusLine(out)}), so nothing was saved` };
  return { ok: true };
}

async function writeDocs(before, after, writer) {
  const { create, remove, rename, body } = docDiff(before.sections.docs, after.sections.docs);

  const minted = new Map();
  for (const doc of create) {
    const out = await writer.send({
      method: 'POST',
      path: '/docs',
      body: { title: doc.title || 'Untitled', content: doc.content ?? '' },
    });
    if (!out.ok) return { ok: false, why: `the hub refused a new document (${statusLine(out)}), so nothing was saved` };
    const id = out.data?.doc?.id;
    if (typeof id === 'string' && id) minted.set(doc.id, id);
  }

  // A doc that changed both its title and its body takes ONE `PUT` that carries
  // both, rather than a rename followed by a body write. Two calls would need a
  // fresh etag between them for no benefit, and the second would be the one that
  // 412s if anything else touched the document in between.
  const rebody = new Map(body.map((b) => [b.id, b]));
  for (const r of rename) {
    if (rebody.has(r.id)) continue;
    const out = await writer.send({ method: 'PATCH', path: `/docs/${encodeURIComponent(r.id)}`, body: { title: r.title } });
    if (!out.ok) return { ok: false, why: `the hub refused a document rename (${statusLine(out)}), so nothing was saved` };
  }

  for (const doc of body) {
    const patch = { content: doc.content };
    const titled = rename.find((r) => r.id === doc.id);
    if (titled) patch.title = titled.title;
    const out = await writer.sendBody(`/docs/${encodeURIComponent(doc.id)}`, patch);
    if (!out.ok) return { ok: false, why: `the hub refused the document body (${statusLine(out)}), so nothing was saved` };
  }

  for (const id of remove) {
    const out = await writer.send({ method: 'DELETE', path: `/docs/${encodeURIComponent(id)}` });
    if (!out.ok) return { ok: false, why: `the hub refused to delete a document (${statusLine(out)}), so nothing was saved` };
  }

  // Which document is open is state, not a document. `create` and `open` point at
  // a reducer id that the hub has never seen, so it is translated here — writing
  // the raw `hub-…` id would leave the app opening a document that does not
  // exist. An id that CANNOT be translated is left alone rather than guessed at.
  const hubIds = new Set([...before.sections.docs.map((d) => d.id), ...minted.values()]);
  const wanted = minted.get(after.activeDocId) ?? (hubIds.has(after.activeDocId) ? after.activeDocId : undefined);
  const appPatch = {};
  if (wanted !== undefined && wanted !== before.activeDocId) appPatch.activeDocId = wanted;
  if (after.activeSection !== before.activeSection) appPatch.activeSection = after.activeSection;
  if (Object.keys(appPatch).length) {
    const out = await writer.send({ method: 'PATCH', path: '/', body: appPatch });
    if (!out.ok) return { ok: false, why: `the hub refused the view change (${statusLine(out)}), so nothing was saved` };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one hub tool call and make it TRUE on the hub.
 *
 * Returns `{ ok, text, writes, rev? }`. `text` is the reducer's own sentence
 * when the write landed, and a `tool error:` line when it did not — so a caller
 * that renders this to the wearer can no longer show a success for a change that
 * was thrown away.
 *
 * `io.call` is the relay's hub client (`{call(method, path, {body, headers,
 * signal})}`), passed in rather than imported so a harness can drive this with a
 * fixture and no network at all.
 */
export async function applyHubTool(tool, args, io = {}) {
  const { call, signal } = io;
  const kind = tool?.kind;
  if (!HUB_TOOL_KINDS.has(kind)) return refused(`not a hub tool: ${String(kind ?? 'unknown')}`);
  if (typeof call !== 'function') {
    return refused('this relay has no hub client configured, so nothing was saved');
  }

  const spec = READ[kind];
  let read = null;
  try {
    read = describe(await call('GET', spec.path, { signal }));
  } catch {
    read = { ok: false, status: 0, code: null };
  }
  if (!read.ok) {
    return refused(
      read.status === 0
        ? 'the hub did not answer, so nothing was saved. Try again in a moment'
        : `the hub could not be read (${statusLine(read)}), so nothing was saved`,
    );
  }

  const before = normalizeHub(spec.from(read.data));
  const result = runHubTool(tool, args, before);
  // A read, a refusal, or a no-op carries no `state` — so it is also the
  // statement that there is nothing to write, and this returns without touching
  // the hub. `list` and `read` are therefore provably write-free.
  if (!result.state) return { ok: result.ok, text: result.text, writes: 0 };

  const after = normalizeHub(result.state);
  const writer = createWriter({ call, signal, revPath: spec.path, rev: read.rev });

  let applied;
  try {
    if (kind === 'todo') applied = await writeTodos(before, after, writer);
    else if (kind === 'notes') applied = await writeNotes(before, after, writer);
    else applied = await writeDocs(before, after, writer);
  } catch {
    applied = { ok: false, why: 'the hub did not answer, so nothing was saved. Try again in a moment' };
  }
  if (!applied.ok) return refused(applied.why);

  return { ok: true, text: result.text, writes: writer.writes, rev: writer.rev };
}
