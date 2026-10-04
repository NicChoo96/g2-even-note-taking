// Probe the relay's SERVER-SIDE hub-tool executor — the path an agent run uses.
//
// ── why this probe exists ───────────────────────────────────────────────────
//
// probe-hub-todo.mjs proved the backend persists a write. probe-relay-todo.mjs
// proved the relay carries one. Both cover the CLIENT path (`/api/hub/*`, driven
// by `store.ts`). But the relay ALSO owns a second, independent way to change a
// to-do list: when a tool call of kind `todo` arrives at `/api/tool`, the relay
// runs it itself, server-side.
//
// That branch used to reduce against the relay's OWN cached copy of the app
// state — a bootstrap loaded from a git-ignored file that no client had ever
// published to — write the result back and fan it out as `{type:'state'}`. It
// never called the hub:
//
//   Nothing in that branch touched the hub.
//
// An item added that way appeared on the glasses and in the SSE frame, and the
// database never heard about it. Nothing errored. That is the reported symptom:
// "a write appears to succeed in the UI with no error".
//
// The fix routes every hub tool through `applyHubTool` in hub-write.mjs, which
// diffs before/after and drives the same hub API the app writes through. This
// probe asserts the two paths AGREE by asking the HUB ITSELF — never the relay's
// copy, which is the one thing that could agree with itself.
//
// ── why it covers the WHOLE lifecycle ───────────────────────────────────────
//
// It used to assert an `add` and nothing else, and that is exactly the gap that
// let a second, independent defect live: `DELETE /hub/todos/{id}` (and its
// document twin) wants the `rev` in the request BODY and answers a flat `400
// REV_REQUIRED` without it. `add` never exercises a delete, so the probe stayed
// green while "delete this task" could not work at all. Add, tick, edit and
// delete are four different requests against four different routes; the bug
// report names all four, so all four are asserted, each against the hub.
//
// Usage:  node tools/probe-tool-todo.mjs [relayBase]
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

/** The hub's own list, straight through the passthrough — never the relay's copy. */
async function hubTodos() {
  const r = await req('GET', '/api/hub/todos');
  return { rev: r.body?.rev, items: Array.isArray(r.body?.items) ? r.body.items : [] };
}

/** Run a to-do tool the way an agent run does. Returns the hub's own verdict. */
function tool(args) {
  return req('POST', '/api/tool', { kind: 'todo', toolId: 'jarvis_todo', args });
}

/** A tool call, reported the same way every time. */
async function step(label, args, expect = {}) {
  const out = await tool(args);
  const refused = out.body?.ok === false;
  const said = String(out.body?.result ?? '');
  const ok = out.status === 200 && !refused;
  check(ok, `${label} -> ${out.status}`, ok ? said.slice(0, 110) : said.slice(0, 220));
  if (ok && typeof expect.writes === 'number') {
    check(
      out.body?.writes === expect.writes,
      `…and it reported ${expect.writes} write(s)`,
      `writes=${JSON.stringify(out.body?.writes)}`,
    );
  }
  return { out, said, ok };
}

const stamp = new Date().toISOString().slice(11, 19);
const A = `tool probe ${stamp} alpha`;
const B = `tool probe ${stamp} bravo`;
const B2 = `tool probe ${stamp} bravo (edited)`;

console.log(`probe: relay ${RELAY}, tool path`);
console.log('');

const before = await hubTodos();
console.log(`      hub before: rev=${before.rev} count=${before.items.length}`);

// ── add ─────────────────────────────────────────────────────────────────────
// Two at once, so the later steps can prove they touch ONE task and not both.
await step('add (two tasks in one call)', { action: 'add', text: `${A}\n${B}` }, { writes: 2 });
const afterAdd = await hubTodos();
const gotA = afterAdd.items.find((t) => t.text === A);
const gotB = afterAdd.items.find((t) => t.text === B);
check(
  afterAdd.items.length === before.items.length + 2,
  'the hub list grew by exactly two',
  `${before.items.length} -> ${afterAdd.items.length}`,
);
check(
  Boolean(gotA && gotB),
  'the items the relay says it added ARE IN THE HUB',
  gotA && gotB ? `ids ${gotA.id} / ${gotB.id}` : 'the hub never heard about at least one of them',
);
check(
  Boolean(gotA) && /^[0-9a-f-]{36}$/.test(gotA.id),
  '…under hub-minted ids, not the reducer s own',
  gotA ? `id=${gotA.id}` : 'nothing to check',
);
check(afterAdd.rev > before.rev, '…and the hub advanced its rev', `${before.rev} -> ${afterAdd.rev}`);

// ── tick ────────────────────────────────────────────────────────────────────
await step('tick (set_done)', { action: 'set_done', target: A, done: true }, { writes: 1 });
const afterTick = await hubTodos();
const tickedA = afterTick.items.find((t) => t.text === A);
const untouchedB = afterTick.items.find((t) => t.text === B);
check(tickedA?.done === true, 'the task the relay says it ticked IS TICKED IN THE HUB', `done=${JSON.stringify(tickedA?.done)}`);
check(untouchedB?.done === false, 'and the OTHER task is still open', `done=${JSON.stringify(untouchedB?.done)}`);

// ── edit ────────────────────────────────────────────────────────────────────
await step('edit', { action: 'edit', target: B, text: B2 }, { writes: 1 });
const afterEdit = await hubTodos();
check(
  Boolean(afterEdit.items.find((t) => t.text === B2)),
  'the new text IS IN THE HUB',
  afterEdit.items.find((t) => t.text === B2) ? '' : `no task reads "${B2}"`,
);
check(!afterEdit.items.find((t) => t.text === B), '…and the old text is gone from it');
check(afterEdit.items.find((t) => t.text === A)?.done === true, '…and the ticked task survived the edit');
check(afterEdit.items.length === afterTick.items.length, '…and nothing was duplicated', `${afterTick.items.length} -> ${afterEdit.items.length}`);

// ── remove ──────────────────────────────────────────────────────────────────
// The one the probe used to never reach, and the one that was broken: a DELETE
// with no `rev` in its body is a 400, so this reported a refusal and left the
// task exactly where it was.
await step('remove (delete)', { action: 'remove', target: A }, { writes: 1 });
const afterRemove = await hubTodos();
check(
  !afterRemove.items.find((t) => t.text === A),
  'the task the relay says it deleted IS GONE FROM THE HUB',
  afterRemove.items.find((t) => t.text === A) ? 'the hub still holds it' : '',
);
check(afterRemove.items.length === afterEdit.items.length - 1, '…and exactly one task went', `${afterEdit.items.length} -> ${afterRemove.items.length}`);
check(Boolean(afterRemove.items.find((t) => t.text === B2)), '…and the surviving task is the right one');

// ── clear_done ──────────────────────────────────────────────────────────────
// `clear_done` has no target: it takes EVERY finished task, including ones this
// probe did not create. Against a live hub that is a loaded gun, so it only
// fires when the probe's own task is the only thing that is finished. Anything
// else and the step is skipped rather than reported as a pass it did not earn.
await step('tick the survivor', { action: 'set_done', target: B2, done: true }, { writes: 1 });
const beforeClear = await hubTodos();
const finished = beforeClear.items.filter((t) => t.done).map((t) => t.text);
if (finished.length === 1 && finished[0] === B2) {
  await step('clear_done', { action: 'clear_done' }, { writes: 1 });
  const afterClear = await hubTodos();
  check(
    !afterClear.items.find((t) => t.text === B2),
    'the finished task IS GONE FROM THE HUB',
    afterClear.items.find((t) => t.text === B2) ? 'the hub still holds it' : '',
  );
  check(
    afterClear.items.length === beforeClear.items.length - 1,
    '…and exactly one task went',
    `${beforeClear.items.length} -> ${afterClear.items.length}`,
  );
} else {
  console.log(`SKIP  clear_done — the hub already holds ${finished.length} finished task(s), and clear_done takes every one of them`);
}

// Nothing the probe did not create may be gone, whatever the branch above did.
const survivors = new Set((await hubTodos()).items.map((t) => t.id));
const clobbered = before.items.filter((t) => !survivors.has(t.id)).map((t) => t.text || t.id);
check(
  clobbered.length === 0,
  '…and no task the probe did not create was touched',
  clobbered.length === 0 ? '' : `gone from the hub: ${clobbered.join(' | ')}`,
);

// The read-back must agree with the hub, whichever branch clear_done took.
const listed = await step('list', { action: 'list' });
const alive = (await hubTodos()).items.filter((t) => t.text.startsWith(`tool probe ${stamp}`)).map((t) => t.text);
check(
  alive.every((text) => String(listed.said).includes(text)),
  '…and the list the assistant reads back shows what the hub holds',
  alive.length === 0 ? 'no probe task survived, so there is nothing to read back' : `read back: ${alive.join(' | ')}`,
);

// ── clean up, so a re-run starts where the hub is ───────────────────────────
const leftovers = (await hubTodos()).items.filter((t) => t.text.startsWith(`tool probe ${stamp}`));
for (const item of leftovers) {
  // A fresh rev per delete: every delete moves the counter, so a cached one is a
  // 409 on the second iteration.
  const fresh = await hubTodos();
  const del = await req('DELETE', `/api/hub/todos/${encodeURIComponent(item.id)}`, { rev: fresh.rev });
  console.log(`      cleanup DELETE ${item.id} -> ${del.status}`);
}
const left = (await hubTodos()).items.filter((t) => t.text.startsWith(`tool probe ${stamp}`));
check(
  left.length === 0,
  'and no probe task was left behind',
  left.length === 0 ? `hub back to ${(await hubTodos()).items.length} task(s)` : `${left.length} still in the hub`,
);

console.log('');
console.log(
  failed === 0
    ? 'RESULT: PASS — every server-side hub tool writes through to the hub'
    : `RESULT: ${failed} FAILURE(S) — the two to-do paths disagree`,
);
process.exit(failed === 0 ? 0 : 1);
