// Probe the relay's SERVER-SIDE hub-tool executor for the OTHER TWO collections.
//
// probe-tool-todo.mjs proves the to-do path. This one asks the same question of
// documents and notes, and it exists because the defect was never specific to
// to-do lists: the relay's hub-tool branch reduced against its own cached copy
// for EVERY kind, so a document the assistant created and a note it appended
// were exactly as invisible to the hub as an added task was.
//
// Each collection is asserted the same way — the RELAY is asked to make the
// change, and then the HUB ITSELF is read, straight through the passthrough, and
// must show it. Nothing here trusts a status code alone.
//
// Documents exercise the long route on purpose: a create, then a body append
// (which must re-read the ETag immediately before the PUT, or the hub answers
// 412), then a metadata rename (which must NOT touch the body), then a delete.
// Notes exercise the separator rule: `POST /notes/append` adds no newline of its
// own, so a client that forgets one runs two paragraphs together.
//
// Usage:  node tools/probe-tool-hub-writes.mjs [relayBase]
const RELAY = (process.argv[2] || 'http://localhost:5198').replace(/\/+$/, '');
const TOKEN = process.env.PROBE_OWNER_TOKEN || 'devownerecb53dde7bf41d07';

let failed = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failed += 1;
}

async function req(method, path, body) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${RELAY}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: r.status, ok: r.ok, body: parsed, text };
}

/** Run a hub tool the way an agent run does. Returns the hub's own verdict. */
function tool(kind, toolId, args) {
  return req('POST', '/api/tool', { kind, toolId, args });
}

const stamp = Date.now().toString(36).slice(-6);

console.log(`probe: relay ${RELAY}, docs + notes tool paths`);
console.log('');

// ── documents ───────────────────────────────────────────────────────────────
console.log('      — documents —');
const docsBefore = await req('GET', '/api/hub/docs');
const titlesBefore = (docsBefore.body?.items ?? []).map((d) => d.title);
const title = `probe doc ${stamp}`;

const created = await tool('docs', 'jarvis_docs', {
  action: 'create',
  title,
  content: `first line ${stamp}`,
});
const createdOk = created.status === 200 && created.body?.ok !== false;
check(createdOk, `create -> ${created.status}`, createdOk ? '' : JSON.stringify(created.body).slice(0, 220));

const docsAfterCreate = await req('GET', '/api/hub/docs');
const meta = (docsAfterCreate.body?.items ?? []).find((d) => d.title === title);
check(
  Boolean(meta?.id),
  'the document the relay says it created IS IN THE HUB',
  meta?.id ? `id=${meta.id}` : `hub has ${(docsAfterCreate.body?.items ?? []).length} docs, none titled "${title}"`,
);

let docId = meta?.id ?? null;
let bodyOk = false;
let renamedTitle = null;

if (docId) {
  const before = await req('GET', `/api/hub/docs/${docId}`);
  const bodyBefore = before.body?.doc?.content ?? '';

  // A body write MUST carry a fresh If-Match; a stale one is a 412.
  const appended = await tool('docs', 'jarvis_docs', { action: 'append', target: title, content: `second line ${stamp}` });
  const afterAppend = await req('GET', `/api/hub/docs/${docId}`);
  const bodyAfter = afterAppend.body?.doc?.content ?? '';
  bodyOk = appended.status === 200 && bodyAfter.includes(`second line ${stamp}`);
  check(
    bodyOk,
    `append wrote the BODY through -> ${appended.status}`,
    bodyOk
      ? `body grew ${bodyBefore.length} -> ${bodyAfter.length}`
      : `body unchanged (${bodyAfter.length} chars) or refused: ${JSON.stringify(appended.body).slice(0, 200)}`,
  );
  check(
    bodyAfter.includes('\n'),
    'and the appended text is on its OWN line',
    bodyAfter.includes('\n') ? '' : 'the client forgot its separator — the hub adds none',
  );

  // A rename is metadata ONLY: it must move the title and leave the body alone.
  renamedTitle = `${title} r`;
  const renamed = await tool('docs', 'jarvis_docs', { action: 'rename', target: title, title: renamedTitle });
  const afterRename = await req('GET', `/api/hub/docs/${docId}`);
  const titleNow = afterRename.body?.doc?.title ?? '';
  const bodyNow = afterRename.body?.doc?.content ?? '';
  check(
    renamed.status === 200 && titleNow === renamedTitle,
    `rename wrote the TITLE through -> ${renamed.status}`,
    titleNow === renamedTitle ? '' : `hub still calls it "${titleNow}"`,
  );
  check(
    bodyNow === bodyAfter,
    'and the rename did NOT touch the body',
    bodyNow === bodyAfter ? '' : 'a metadata patch overwrote content',
  );

  // A delete is the LAST document action and the one with the narrowest contract:
  // the hub wants the `rev` in the DELETE's BODY and answers a flat
  // `400 REV_REQUIRED` without it. A bodyless DELETE therefore looks fine and
  // removes nothing, which is the same "the UI said it worked" defect in
  // miniature. Asserted through the TOOL, because that is what an agent calls.
  const deleted = await tool('docs', 'jarvis_docs', { action: 'delete', target: renamedTitle });
  check(
    deleted.status === 200 && deleted.body?.ok !== false,
    `delete wrote through -> ${deleted.status}`,
    deleted.body?.ok === false ? String(deleted.body?.result ?? '').slice(0, 200) : '',
  );
  const gone = await req('GET', `/api/hub/docs/${docId}`);
  check(gone.status === 404, 'and the document is really gone from the hub', `GET -> ${gone.status}`);
  // Two writes, not one, and both are necessary: the create left this document
  // OPEN, so removing it would leave the app pointing at a row that no longer
  // exists. The second write is the `PATCH /hub` that clears `activeDocId`.
  check(
    deleted.body?.writes === 2,
    'and it counted the delete plus the dangling-open-id patch',
    `writes=${JSON.stringify(deleted.body?.writes)}`,
  );
  if (gone.status === 404) docId = null; // it is already clean; do not try twice
} else {
  check(false, 'append was not attempted (no id)', 'the create never landed');
  check(false, 'rename was not attempted (no id)', 'the create never landed');
  check(false, 'delete was not attempted (no id)', 'the create never landed');
}

// Clean up so a re-run starts where the hub is. The `rev` is re-read here rather
// than reused from the create: a stale one is a `409 STALE_REV`, which reads as a
// broken hub and is really a stale probe.
if (docId) {
  const fresh = await req('GET', '/api/hub/docs');
  const del = await req('DELETE', `/api/hub/docs/${docId}`, { rev: fresh.body?.rev });
  check(del.status === 204, `cleanup DELETE ${docId} -> ${del.status}`, del.status === 204 ? '' : del.text.slice(0, 200));
  const gone = await req('GET', `/api/hub/docs/${docId}`);
  check(gone.status === 404, 'and the document is really gone', `GET -> ${gone.status}`);
} else {
  const titlesNow = (await req('GET', '/api/hub/docs')).body?.items?.map((d) => d.title) ?? [];
  check(
    titlesNow.length === titlesBefore.length,
    'nothing was left behind',
    `before ${titlesBefore.length}, after ${titlesNow.length}`,
  );
}

// ── notes ───────────────────────────────────────────────────────────────────
console.log('      — notes —');
const notesBefore = await req('GET', '/api/hub/notes');
const contentBefore = notesBefore.body?.content ?? '';
const line = `probe note ${stamp}`;

const appended = await tool('notes', 'jarvis_notes', { action: 'append', text: line });
const notesAfter = await req('GET', '/api/hub/notes');
const contentAfter = notesAfter.body?.content ?? '';
const landed = appended.status === 200 && contentAfter.includes(line);
check(landed, `notes append -> ${appended.status}`, landed ? '' : JSON.stringify(appended.body).slice(0, 200));
check(
  contentAfter !== contentBefore,
  'the note the relay says it appended IS IN THE HUB',
  `hub blob ${contentBefore.length} -> ${contentAfter.length} chars`,
);
check(
  contentAfter.includes(`\n${line}`) || contentBefore === '',
  'and it arrived on its own line, not run into the last one',
  contentAfter.includes(`\n${line}`) ? '' : 'appended with no separator',
);

// Restore the blob exactly, so a re-run is honest.
const restored = await req('PUT', '/api/hub/notes', { content: contentBefore, rev: notesAfter.body?.rev });
check(restored.status === 200, `cleanup PUT /notes -> ${restored.status}`);
const back = await req('GET', '/api/hub/notes');
check(back.body?.content === contentBefore, 'and the blob is byte-identical to before', `${(back.body?.content ?? '').length} chars`);

// ── the assistant's own read-back ───────────────────────────────────────────
// A write the hub accepted but the tool cannot describe would still be a bug the
// wearer sees, so ask the tool to list what it just did.
const listed = await tool('docs', 'jarvis_docs', { action: 'list' });
check(
  listed.status === 200 && typeof listed.body?.result === 'string' && listed.body.result.length > 0,
  `list after the writes -> ${listed.status}`,
  listed.status === 200 ? '' : JSON.stringify(listed.body).slice(0, 200),
);
check(
  !/^tool error:/.test(listed.body?.result ?? ''),
  'and the assistant is not told the store is broken',
  (listed.body?.result ?? '').slice(0, 120),
);

console.log('');
console.log(
  failed === 0
    ? 'RESULT: PASS — docs and notes tool calls write through to the hub'
    : `RESULT: ${failed} FAILURE(S) — the relay and the hub disagree`,
);
process.exit(failed === 0 ? 0 : 1);
