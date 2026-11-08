#!/usr/bin/env node
// Hub-publish harness — the rev handshake that decides whether a page is listed.
//
// WHY THIS EXISTS:
//   This path has now failed twice in ways that looked like success, so every
//   step of the wire contract is asserted here rather than trusted:
//
//     1. READ the rev first   — a write with no rev is refused `400 REV_REQUIRED`
//                                (which is exactly what shipped, and produced a
//                                "body stored, page not listed" warning)
//     2. SEND it in the BODY  — not a header, not the query
//     3. ONE stale retry      — `STALE_REV` carries the winning rev at
//                                `details.rev`, NOT `details.current.rev`
//     4. NEVER retry a 403 or a refusal with no rev
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

/**
 * A fake hub that keeps a rev, so a stale write can be simulated honestly.
 * Replies are keyed by `${method} ${path-without-query}`.
 */
function fakeHub({ rev = 5, post } = {}) {
  const calls = [];
  let current = rev;
  return {
    calls,
    get rev() {
      return current;
    },
    client: {
      async call(method, path, opts = {}) {
        const body = opts.body ? JSON.parse(JSON.stringify(opts.body)) : undefined;
        calls.push({ method, path, body });
        const route = `${method} ${String(path).split('?')[0]}`;
        if (route === 'GET /files') {
          return { ok: true, status: 200, text: JSON.stringify({ ok: true, rev: current, items: [] }) };
        }
        if (route === 'POST /files' && post) return post(body, current, calls);
        // Default: accept, and move the rev on as the hub would.
        current += 1;
        return {
          ok: true,
          status: 201,
          text: JSON.stringify({ ok: true, rev: current, file: { id: 'doc-1', title: body?.title, version: 1 } }),
        };
      },
    },
  };
}

const body = { html: '<h1>Brief</h1>', title: 'Singapore Workday Brief', agent: 'Singapore Workday Brief' };

// ── The handshake ────────────────────────────────────────────────────────
{
  const hub = fakeHub();
  const res = await publishThroughHub(hub.client, body);
  check('the first call is a READ of the rev', `${hub.calls[0].method} ${hub.calls[0].path}`, 'GET /files?limit=1');
  check('the second call is the write', `${hub.calls[1].method} ${hub.calls[1].path}`, 'POST /files');
  check('the rev is a NUMBER in the body', hub.calls[1].body.rev, 5);
  check('…and the body is intact', hub.calls[1].body.html, '<h1>Brief</h1>');
  check('…and the author survives', hub.calls[1].body.agent, 'Singapore Workday Brief');
  check('the file comes back', res.file?.id, 'doc-1');
  check('no retry was needed', res.retried, false);
}

// ── A lost race: STALE_REV names the winner at details.rev ───────────────
{
  const hub = fakeHub({
    rev: 9,
    post: (sent, current, calls) =>
      calls.filter((c) => c.method === 'POST').length === 1
        ? {
            ok: false,
            status: 409,
            text: JSON.stringify({
              ok: false,
              code: 'STALE_REV',
              // The trap: `current` is the hub STATE and has no rev of its own.
              details: { rev: 11, current: { todos: [], docs: [], rev: null } },
            }),
          }
        : { ok: true, status: 201, text: JSON.stringify({ ok: true, rev: 12, file: { id: 'doc-2' } }) },
  });
  const res = await publishThroughHub(hub.client, body);
  check('a stale write is retried once', hub.calls.filter((c) => c.method === 'POST').length, 2);
  check('…with the rev from details.rev', hub.calls[2].body.rev, 11);
  check('…and succeeds', res.ok, true);
  check('…and reports the retry', res.retried, true);
}

// ── A STALE_REV with no usable rev is NOT retried ────────────────────────
{
  const hub = fakeHub({
    post: () => ({
      ok: false,
      status: 409,
      text: JSON.stringify({ ok: false, code: 'STALE_REV', details: { current: { rev: null } } }),
    }),
  });
  const res = await publishThroughHub(hub.client, body);
  check('a stale refusal with no rev is not retried', hub.calls.filter((c) => c.method === 'POST').length, 1);
  check('…and fails honestly', res.ok, false);
}

// ── The exact refusal that shipped: REV_REQUIRED ─────────────────────────
{
  // The hub ignores our rev and demands one: nothing to retry, report the text.
  const hub = fakeHub({
    post: () => ({
      ok: false,
      status: 400,
      text: JSON.stringify({
        ok: false,
        error: 'this route needs the rev you are writing against',
        code: 'REV_REQUIRED',
        details: { field: 'rev' },
      }),
    }),
  });
  const res = await publishThroughHub(hub.client, body);
  check('REV_REQUIRED is not retried', hub.calls.filter((c) => c.method === 'POST').length, 1);
  check('…and fails', res.ok, false);
  ok('…naming the reason', res.error.includes('400') && /REV_REQUIRED/.test(res.error), res.error);
}

// ── A read that cannot supply a rev never attempts the write ────────────
{
  const stub = {
    calls: [],
    client: {
      async call(method, path) {
        stub.calls.push(`${method} ${path}`);
        return { ok: false, status: 503, text: 'down' };
      },
    },
  };
  const res = await publishThroughHub(stub.client, body);
  check('an unreadable rev means no write at all', stub.calls.length, 1);
  check('…and fails', res.ok, false);
  ok('…naming the read', /could not read the current revision/.test(res.error), res.error);
}

{
  // 200 but no rev in the body — treat exactly like an unreadable rev, because a
  // write with an undefined rev is the bug we are fixing.
  const stub = {
    calls: [],
    client: {
      async call(method, path) {
        stub.calls.push(`${method} ${path}`);
        return { ok: true, status: 200, text: JSON.stringify({ ok: true, items: [] }) };
      },
    },
  };
  const res = await publishThroughHub(stub.client, body);
  check('a read with no rev does not write', stub.calls.length, 1);
  check('…and fails', res.ok, false);
}

// ── Refusals that must not be retried ───────────────────────────────────
{
  const hub = fakeHub({ post: () => ({ ok: false, status: 403, text: '{"code":"SCOPE_DENIED"}' }) });
  const res = await publishThroughHub(hub.client, body);
  check('a 403 is not retried', hub.calls.filter((c) => c.method === 'POST').length, 1);
  check('…and fails', res.ok, false);
}

{
  const res = await publishThroughHub(null, body);
  check('no hub client fails without a call', res.ok, false);
  ok('…naming the hub', /hub is not configured/.test(res.error), res.error);
}

// ── An update takes the same path, with the id ──────────────────────────
{
  const hub = fakeHub();
  const res = await publishThroughHub(hub.client, {
    id: 'doc-3',
    overwrite: true,
    html: '<p>revised</p>',
    title: 'Revised',
  });
  check('an update posts the id', hub.calls[1].body.id, 'doc-3');
  check('…asks to overwrite', hub.calls[1].body.overwrite, true);
  check('…and carries the rev', hub.calls[1].body.rev, 5);
  check('…and returns the record', res.ok, true);
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
