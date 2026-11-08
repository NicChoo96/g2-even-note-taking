#!/usr/bin/env node
// Publish gate, end to end through the REAL document-store client.
//
// WHY THIS EXISTS:
//   publish-gate-sim.mjs proves the gate's logic against hand-built Maps. This
//   proves the half that logic depends on and cannot check on its own: that
//   `client.list()` really returns `{ items: [...] }` with a per-document
//   `version`, that `storeIndex` reads it, and that a publish through
//   `client.create()` shows up as a NEW document in a second snapshot.
//
//   That shape is the whole fix. If `version` were missing, or the envelope were
//   nested differently, every publish would look unconfirmed and the gate would
//   fail runs that actually worked — a worse bug than the one it fixes. So the
//   client is driven against a STATEFUL stub gateway: publish something and the
//   next list contains it, exactly as the real service behaves.
//
// Run: node tools/publish-gate-live-sim.mjs

import {
  LOGIN_PATH,
  MCP_PATH,
  createFilesClient,
} from '../../web/server/jarvis-files.mjs';
import { publishVerdict, storeIndex } from '../../web/server/publish-gate.mjs';

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

// ── A stateful stub gateway ────────────────────────────────────────────────
// Not a queue of canned replies: the LIST reads what the CREATE wrote, because
// the question this harness answers is "does a publish become visible to the
// gate", which a canned reply could fake in either direction.
const BASE = 'http://gateway.test';
const docs = new Map();
let seq = 0;
const seen = [];

function reply(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

const fetchImpl = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  seen.push(path);
  if (path === LOGIN_PATH) {
    return reply(200, {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      token_type: 'bearer',
      expires_in: 3600,
      session_id: 'sess-1',
      subject: 'tester',
      scopes: ['content:read', 'content:write'],
    });
  }
  if (path !== MCP_PATH) return reply(404, {});
  const body = JSON.parse(init.body);
  const name = body?.params?.name;
  const args = body?.params?.arguments ?? {};
  const rpc = (structured) =>
    reply(200, { jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: structured } });

  if (name === 'list_sessions') {
    return rpc({ items: [...docs.values()], total: docs.size });
  }
  if (name === 'create_session') {
    const id = `doc-${++seq}`;
    const record = {
      id,
      title: args.title || 'Untitled',
      agent: args.agent || 'g2-hub',
      tags: [],
      version: 1,
      size: 900,
      updated_at: new Date().toISOString(),
    };
    docs.set(id, record);
    return rpc(record);
  }
  if (name === 'read_session') {
    const record = docs.get(String(args.id));
    if (!record) {
      return reply(200, {
        jsonrpc: '2.0',
        id: body.id,
        result: { isError: true, content: [], structuredContent: { error: { code: 'not_found', message: 'not found' } } },
      });
    }
    return rpc(record);
  }
  return reply(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such tool' } });
};

const client = createFilesClient({
  fetchImpl,
  baseUrl: BASE,
  username: 'tester',
  password: 'pw',
});

// ── The negative case first: an empty store proves nothing was written ─────
const before = storeIndex(await client.list({ limit: 100 }));
check('an empty store indexes to nothing', before.size, 0);

const idleVerdict = publishVerdict({
  text: 'I have published the Singapore Workday Brief.',
  hasStoreTool: true,
  before,
  after: storeIndex(await client.list({ limit: 100 })),
  attemptsLeft: 1,
});
check('a claim with no write anywhere RETRIES', idleVerdict.outcome, 'retry');

// ── The positive case: a real publish, through the real client ─────────────
const created = await client.create({
  html: '<h1>Singapore Workday Brief</h1><p>markets</p>',
  title: 'Singapore Workday Brief',
  agent: 'workday-brief',
});
check('the client returns the new document', typeof created.id === 'string', true);
ok('…with a version the gate can read', created.version === 1, `version=${created.version}`);

const after = storeIndex(await client.list({ limit: 100 }));
check('the store now indexes one document', after.size, 1);
check('…keyed by the id the client returned', [...after.keys()], [created.id]);
check('…carrying the version', after.get(created.id).version, 1);
check('…and the title, for the evidence line', after.get(created.id).title, 'Singapore Workday Brief');

const confirmed = publishVerdict({
  text: 'I have published the Singapore Workday Brief.',
  hasStoreTool: true,
  before,
  after,
  attemptsLeft: 0,
});
check('the gate CONFIRMS a real publish', confirmed.outcome, 'confirmed');
check('…naming the document as evidence', confirmed.evidence.map((d) => d.id), [created.id]);
check('…so the wearer can be told what was stored', confirmed.evidence[0].title, 'Singapore Workday Brief');

// A second snapshot with no further write must NOT confirm.
const stillConfirmed = publishVerdict({
  text: 'I have published the Singapore Workday Brief.',
  hasStoreTool: true,
  before: after,
  after: storeIndex(await client.list({ limit: 100 })),
  attemptsLeft: 0,
});
check('a stale claim after the fact FAILS', stillConfirmed.outcome, 'fail');
ok('…and says the store shows no change', /no new or updated document/.test(stillConfirmed.reason), stillConfirmed.reason);

// ── A version bump is a write too ──────────────────────────────────────────
docs.get(created.id).version = 2;
docs.get(created.id).title = 'Singapore Workday Brief (revised)';
const bumped = publishVerdict({
  text: 'I published the revised brief.',
  hasStoreTool: true,
  before: after,
  after: storeIndex(await client.list({ limit: 100 })),
  attemptsLeft: 0,
});
check('an update is confirmed by the version bump', bumped.outcome, 'confirmed');
check('…and reports the new version', bumped.evidence[0].version, 2);

// ── The reported bug, through the same client ─────────────────────────────
// No store tool on the agent: the gate must fail WITHOUT touching the network.
const beforeCalls = seen.length;
const noTool = publishVerdict({
  text: 'I have published the page to your file system.',
  hasStoreTool: false,
  before: null,
  after: null,
});
check('an agent with no store tool FAILS', noTool.outcome, 'fail');
ok('…and the check needs no gateway call', seen.length === beforeCalls, `${seen.length - beforeCalls} calls`);

// ── Report ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${pass} passed, 0 failed`);
  console.log('ALL CHECKS PASSED');
}
