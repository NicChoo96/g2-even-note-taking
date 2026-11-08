#!/usr/bin/env node
// Hub-publish harness — the rev retry that decides whether a publish lands.
//
// WHY THIS EXISTS:
//   The document tool now publishes through `POST /hub/files`, because that is
//   the only call that records the `file_ref` the Files page lists. The rev is
//   the hub's write token and it travels in the BODY, so:
//     • the FIRST attempt must carry no rev at all (an empty one is a value)
//     • a 412 must be retried EXACTLY once, with the rev the answer names
//     • a 412 whose body names no rev must NOT be retried — guessing a write
//       token is how two writers start overwriting each other
//     • a 403 must not be retried at all
//   Getting any of those wrong turns every publish into a failed one, which is
//   worse than the bug this replaces.
//
// Run: node tools/hub-publish-sim.mjs

import { publishThroughHub } from '../../web/server/hub-publish.mjs';

let pass = 0;
const failures = [];

function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    return;
  }
  failures.push(`${label}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
}

function ok(label, cond, detail = '') {
  if (cond) pass += 1;
  else failures.push(`${label}${detail ? `\n     ${detail}` : ''}`);
}

/** A fake hub client that replays a script and records what it was asked. */
function fakeHub(replies) {
  const calls = [];
  return {
    calls,
    client: {
      async call(method, path, opts = {}) {
        calls.push({ method, path, body: JSON.parse(JSON.stringify(opts.body ?? {})) });
        const next = replies.shift() ?? { ok: true, status: 201, text: '{"file":{}}' };
        return next;
      },
    },
  };
}

const okReply = (file = { id: 'doc-1', title: 'Singapore Workday Brief', version: 1 }) => ({
  ok: true,
  status: 201,
  text: JSON.stringify({ file }),
});

// ── The body actually sent ────────────────────────────────────────────────
{
  const hub = fakeHub([okReply()]);
  const res = await publishThroughHub(hub.client, {
    html: '<h1>Brief</h1>',
    title: 'Singapore Workday Brief',
    agent: 'Singapore Workday Brief',
    tags: ['daily'],
  });
  check('one call is made', hub.calls.length, 1);
  check('…to POST /files', `${hub.calls[0].method} ${hub.calls[0].path}`, 'POST /files');
  check('…carrying the body', hub.calls[0].body.html, '<h1>Brief</h1>');
  check('…and the author', hub.calls[0].body.agent, 'Singapore Workday Brief');
  check('…with NO rev on the first attempt', 'rev' in hub.calls[0].body, false);
  check('the file comes back', res.file?.id, 'doc-1');
  check('no retry was needed', res.retried, false);
}

// ── The 412 → adopt the current rev → retry once ─────────────────────────
{
  const hub = fakeHub([
    { ok: false, status: 412, text: JSON.stringify({ error: 'stale', details: { current: { rev: 'rev-42' } } }) },
    okReply({ id: 'doc-2', version: 1 }),
  ]);
  const res = await publishThroughHub(hub.client, { html: '<p>x</p>', title: 'T' });
  check('a 412 is retried', hub.calls.length, 2);
  check('…with the rev the refusal named', hub.calls[1].body.rev, 'rev-42');
  check('…and the body is intact', hub.calls[1].body.html, '<p>x</p>');
  check('the retry succeeds', res.ok, true);
  check('…and is reported as retried', res.retried, true);
}

// A 409 is the same shape and must be handled identically.
{
  const hub = fakeHub([
    { ok: false, status: 409, text: JSON.stringify({ details: { current: { rev: 'rev-9' } } }) },
    okReply(),
  ]);
  const res = await publishThroughHub(hub.client, { html: '<p>x</p>' });
  check('a 409 is retried with its rev', hub.calls[1]?.body.rev, 'rev-9');
  check('…and succeeds', res.ok, true);
}

// ── Refusals that must NOT be retried ────────────────────────────────────
{
  const hub = fakeHub([{ ok: false, status: 412, text: 'not json at all' }]);
  const res = await publishThroughHub(hub.client, { html: '<p>x</p>' });
  check('a 412 with no readable rev is NOT retried', hub.calls.length, 1);
  check('…and is reported as a failure', res.ok, false);
  ok('…with the refusal text', res.error.startsWith('412'), res.error);
}

{
  const hub = fakeHub([{ ok: false, status: 403, text: '{"error":"scope"}' }]);
  const res = await publishThroughHub(hub.client, { html: '<p>x</p>' });
  check('a 403 is not retried', hub.calls.length, 1);
  check('…and fails', res.ok, false);
}

{
  // A retried 412 that fails AGAIN must stop, not loop.
  const hub = fakeHub([
    { ok: false, status: 412, text: JSON.stringify({ details: { current: { rev: 'r1' } } }) },
    { ok: false, status: 412, text: JSON.stringify({ details: { current: { rev: 'r2' } } }) },
  ]);
  const res = await publishThroughHub(hub.client, { html: '<p>x</p>' });
  check('a second 412 stops after one retry', hub.calls.length, 2);
  check('…and fails honestly', res.ok, false);
}

// ── Success shapes ───────────────────────────────────────────────────────
{
  const hub = fakeHub([{ ok: true, status: 201, text: 'not json' }]);
  const res = await publishThroughHub(hub.client, { html: '<p>x</p>' });
  check('a 201 with an unparsable body is still a success', res.ok, true);
  check('…with no file record', res.file, null);
}

{
  const res = await publishThroughHub(null, { html: '<p>x</p>' });
  check('no hub client fails without a call', res.ok, false);
  ok('…naming the hub', /hub is not configured/.test(res.error), res.error);
}

// ── An update goes down the same path, with the id ───────────────────────
{
  const hub = fakeHub([okReply({ id: 'doc-3', version: 2 })]);
  const res = await publishThroughHub(hub.client, {
    id: 'doc-3',
    overwrite: true,
    html: '<p>revised</p>',
    title: 'Revised',
  });
  check('an update posts the id', hub.calls[0].body.id, 'doc-3');
  check('…and asks to overwrite', hub.calls[0].body.overwrite, true);
  check('…and returns the new version', res.file.version, 2);
}

// ── Report ───────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${pass} passed, 0 failed`);
  console.log('ALL CHECKS PASSED');
}
