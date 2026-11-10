#!/usr/bin/env node
// PROBE — do the records the hub REALLY stores match what this client expects?
//
// WHY THIS EXISTS
//   The records store was delivered from the backend against a written spec, and
//   the spec is not the contract — the wire is. Every shape asserted below was
//   chosen from `jarviscs/hub/routes/records.py`, and a probe is the only thing
//   that can tell whether the deployed build agrees: a renamed field, a different
//   status code, or an `addedFields` list that arrives empty would all pass a
//   harness built on the same assumption twice.
//
// WHAT IT PROVES
//   A. the hub's own routes (§12 of the spec, one assertion each),
//   B. that the relay DERIVES its records base from METRICS_API — no extra
//      environment variable, no separate mount to get wrong,
//   C. that the TOOL can create a table, read it back, correct one cell and
//      remove one row, against the live hub,
//   D. that the series store is untouched by any of it.
//
// It touches ONLY a throwaway key (`test.probe.records`) and purges it at both
// ends, so a run that dies mid-way cleans up on the next one.
//
// Run: node tools/probe-records.mjs
//      (needs web/.env.local with JARVIS_FILE_API_KEY; not part of sim-all)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

const env = readFileSync(resolve(repo, 'web/.env.local'), 'utf8');
const KEY = /^JARVIS_FILE_API_KEY=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!KEY) {
  console.error('FAIL  no JARVIS_FILE_API_KEY in web/.env.local — cannot reach the hub records store');
  process.exit(2);
}

const METRICS = 'http://167.172.77.136/hub/metrics';
const RECORDS = 'http://167.172.77.136/hub/records';
const PROBE = 'test.probe.records';
const STRICT = 'test.probe.strict';
const PORT = 6300 + Math.floor(Math.random() * 90);
const TOKEN = createHash('sha256').update(`probe-${Date.now()}`).digest('hex');

let pass = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
};

async function hub(method, path, body, base = RECORDS) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const cleanup = async () => {
  for (const key of [PROBE, STRICT]) {
    await hub('DELETE', `/objects/${encodeURIComponent(key)}?purge=1`);
  }
};

let child = null;
try {
  await cleanup(); // a previous run that died mid-way

  // ── A. the hub's own routes, one assertion per contract ────────────────
  const declared = await hub('POST', '/objects', {
    key: PROBE,
    label: 'Records probe',
    fields: [
      { key: 'launch_date', type: 'date', label: 'Launch date' },
      { key: 'price', type: 'number', unit: 'SGD', precision: 0 },
    ],
  });
  check('an object can be declared', declared.status === 201 || declared.json.created === true, `http ${declared.status}`);
  check('…and comes back with its fields', (declared.json.object?.fields ?? []).length === 2, JSON.stringify(declared.json.object?.fields ?? []));
  check('…and says it is soft by default', declared.json.object?.strict === false, String(declared.json.object?.strict));

  const wrote = await hub('POST', `/objects/${PROBE}/records`, {
    records: [{ key: '2023-10-15', values: { launch_date: '2023-10-15', price: 290000, project: 'Garden Vale' } }],
  });
  check('a row can be written', wrote.status === 200 && wrote.json.accepted === 1, `http ${wrote.status} ${JSON.stringify(wrote.json).slice(0, 160)}`);
  const added = (wrote.json.addedFields ?? []).map((f) => `${f.key}:${f.type}`);
  check('an unknown field is INFERRED, and reported', added.includes('project:text'), JSON.stringify(added));

  const read = await hub('GET', `/objects/${PROBE}?limit=10`);
  const row = (read.json.records ?? []).find((r) => r.key === '2023-10-15');
  check('the row reads back whole', row?.values?.project === 'Garden Vale' && row?.values?.price === 290000, JSON.stringify(row?.values));
  check(
    '…and its instant came from the date field',
    new Date(row?.ts ?? 0).toISOString() === '2023-10-15T00:00:00.000Z',
    String(row?.ts),
  );
  check('the object reports its record count', Number(read.json.object?.count) === 1, `count=${read.json.object?.count}`);

  const grew = await hub('POST', `/objects/${PROBE}/records`, {
    records: [{ key: '2024-02-01', values: { launch_date: '2024-02-01', price: 410000, estate: 'Tengah' } }],
  });
  check('a later row can add a column', (grew.json.addedFields ?? []).some((f) => f.key === 'estate'), JSON.stringify(grew.json.addedFields ?? []));

  const ordered = await hub('GET', `/objects/${PROBE}/records?sort=price&order=desc&limit=10`);
  check('a sort by FIELD puts the highest first', ordered.json.records?.[0]?.key === '2024-02-01', String(ordered.json.records?.[0]?.key));
  check('…and `total` is the whole set, not the page', Number(ordered.json.total) === 2, `total=${ordered.json.total}`);

  const badWhere = await hub('GET', `/objects/${PROBE}/records?where=flat_type=4-room`);
  check('a where on a field that does not exist is a 400', badWhere.status === 400, `http ${badWhere.status}`);
  check('…naming the fields that do exist', /launch_date|allowed/i.test(JSON.stringify(badWhere.json)), JSON.stringify(badWhere.json).slice(0, 200));

  const patched = await hub('PATCH', `/objects/${PROBE}/records/2023-10-15`, { values: { price: 295000 } });
  check('one cell can be corrected', patched.status === 200 && patched.json.record?.values?.price === 295000, JSON.stringify(patched.json.record?.values));
  check('…and the other cells are untouched', patched.json.record?.values?.project === 'Garden Vale', JSON.stringify(patched.json.record?.values));

  const badValue = await hub('POST', `/objects/${PROBE}/records`, {
    records: [{ key: '2024-03-01', values: { price: 'expensive' } }],
  });
  check('a string in a number column is refused', badValue.status === 400, `http ${badValue.status}`);
  check('…naming the field and its type', /price/.test(JSON.stringify(badValue.json)), JSON.stringify(badValue.json).slice(0, 200));

  // A strict object is the mode a human cares about: no new columns.
  await hub('POST', '/objects', { key: STRICT, label: 'Strict probe', strict: true, fields: [{ key: 'item', type: 'text' }] });
  const refused = await hub('POST', `/objects/${STRICT}/records`, { records: [{ key: 'rent', values: { item: 'Rent', amount: 2000 } }] });
  check('a strict object refuses an unknown field', refused.status === 400, `http ${refused.status}`);
  // The hub names the FIELD but not the columns it does have — which is why the
  // tool appends them itself (asserted below, where the tool is driven).
  check('…naming the field it does not have', /amount/.test(JSON.stringify(refused.json)), JSON.stringify(refused.json).slice(0, 200));

  const notEmpty = await hub('DELETE', `/objects/${PROBE}`);
  check('a non-empty object is not deletable', notEmpty.status === 409, `http ${notEmpty.status}`);
  check('…and the count comes back', Number(notEmpty.json.details?.count ?? notEmpty.json.count) === 2, JSON.stringify(notEmpty.json).slice(0, 200));

  const rowGone = await hub('DELETE', `/objects/${PROBE}/records/2023-10-15`);
  check('one row can be deleted', rowGone.status === 200 && Number(rowGone.json.deleted) === 1, JSON.stringify(rowGone.json).slice(0, 120));
  const survivor = await hub('GET', `/objects/${PROBE}?limit=10`);
  check('…and the other row survives', (survivor.json.records ?? []).some((r) => r.key === '2024-02-01'), JSON.stringify((survivor.json.records ?? []).map((r) => r.key)));

  // The series store must be untouched by all of the above.
  const seriesBefore = await hub('GET', '/series', undefined, METRICS);
  const countBefore = (seriesBefore.json.items ?? []).length;

  // ── B/C. the relay and the TOOL, in the production shape ───────────────
  const dir = mkdtempSync(join(tmpdir(), 'g2-probe-records-'));
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      sessions: { [createHash('sha256').update(TOKEN).digest('hex')]: { email: 'probe@example.test', createdAt: Date.now() } },
      devices: {},
      revoked: {},
    }),
  );

  child = spawn(process.execPath, [resolve(repo, 'web/server/local-sse.mjs')], {
    cwd: resolve(repo, 'web'),
    env: {
      ...process.env,
      PORT: String(PORT),
      G2_HUB_ENV: '0',
      G2_AGENT_CRON: '0',
      G2_DATA_DIR: dir,
      AUTH_FILE: join(dir, 'auth.json'),
      METRICS_API: METRICS,
      JARVIS_FILE_API_KEY: KEY,
      // NO RECORDS_API on purpose: the whole point is that it is derived.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => (log += String(b)));
  child.stderr.on('data', (b) => (log += String(b)));
  for (let i = 0; i < 150; i += 1) {
    if (/relay on http/.test(log) && /\[records\] hub store/.test(log)) break;
    await sleep(100);
  }
  check(
    'the relay DERIVES the records base from METRICS_API',
    /\[records\] hub store: http:\/\/[^\s]+\/records/.test(log),
    log.split('\n').filter((l) => l.includes('[records]')).join(' | ') || 'no [records] line at all',
  );

  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const tool = (args) => call('POST', '/api/tool', { id: 'tool-metrics', name: 'jarvis_metrics', kind: 'metrics', args });

  const page = await call('GET', '/api/records');
  const live = (page.json.objects ?? []).find((o) => o.key === PROBE);
  check('the Data tab sees the hub\u2019s tables', page.status === 200 && Boolean(live), `http ${page.status}`);
  check(
    '…with their columns, including the one a later row added',
    (live?.fields ?? []).map((f) => f.key).join(',') === 'launch_date,price,project,estate',
    JSON.stringify((live?.fields ?? []).map((f) => f.key)),
  );
  check('…and their rows', (live?.records ?? []).length === 1, `rows=${(live?.records ?? []).length}`);
  check('…and knows it is reading the hub, not a local file', page.json.store?.mode === 'hub', String(page.json.store?.mode));

  // A table the tool invents, which nothing declared first.
  const agentTable = 'test.probe.agent';
  await hub('DELETE', `/objects/${agentTable}?purge=1`);
  const toolWrote = await tool({
    action: 'recordWrite',
    series: agentTable,
    records: [{ key: 'first', values: { label: 'First row', amount: 12.5 } }],
  });
  check('the TOOL creates a table by writing a row', toolWrote.json.ok === true, JSON.stringify(toolWrote.json).slice(0, 200));
  check('…and says which columns it added', /Added/.test(String(toolWrote.json.result)), String(toolWrote.json.result ?? '').slice(0, 120));

  const toolRead = await tool({ action: 'object', series: agentTable });
  check('…and reads it back', /amount=12\.50/.test(String(toolRead.json.result)), String(toolRead.json.result ?? '').slice(0, 160));

  const toolFixed = await tool({
    action: 'recordWrite',
    series: agentTable,
    records: [{ key: 'first', values: { amount: 13 } }],
  });
  check('a partial write corrects ONE cell', toolFixed.json.ok === true && /updated/.test(String(toolFixed.json.result)), String(toolFixed.json.result ?? '').slice(0, 160));
  const afterFix = await tool({ action: 'object', series: agentTable });
  check('…and leaves the other cell alone', /label=First row/.test(String(afterFix.json.result)), String(afterFix.json.result ?? '').slice(0, 160));

  const toolDeleted = await tool({ action: 'recordDelete', series: agentTable, key: 'first' });
  check('the TOOL removes one row', /Deleted row "first"/.test(String(toolDeleted.json.result)), String(toolDeleted.json.result ?? '').slice(0, 120));
  const gone = await tool({ action: 'object', series: agentTable });
  check('…and the table is empty, not gone', gone.json.ok === true && /no rows yet/.test(String(gone.json.result)), String(gone.json.result ?? '').slice(0, 140));

  // A strict table, driven by the TOOL: the refusal must reach the model with
  // the columns that exist, because the hub's own sentence does not carry them.
  const strictTool = await tool({
    action: 'recordWrite',
    series: STRICT,
    records: [{ key: 'extra', values: { item: 'A', amount: 1 } }],
  });
  check('a strict table refuses a new column through the tool', strictTool.json.ok === false, String(strictTool.json.result ?? '').slice(0, 120));
  check(
    '…and the tool lists the columns it DOES have',
    /this table has: item \(text\)/.test(String(strictTool.json.result)),
    String(strictTool.json.result ?? '').slice(0, 220),
  );

  // ── D. the series store is untouched ───────────────────────────────────
  const seriesAfter = await hub('GET', '/series', undefined, METRICS);
  check(
    'the series store is untouched by the records store',
    (seriesAfter.json.items ?? []).length === countBefore,
    `before=${countBefore} after=${(seriesAfter.json.items ?? []).length}`,
  );

  // ── cleanup ────────────────────────────────────────────────────────────
  const purged = await hub('DELETE', `/objects/${PROBE}?purge=1`);
  check('the probe object purges', purged.status === 200, `http ${purged.status}`);
  await hub('DELETE', `/objects/${agentTable}?purge=1`);
  const goneNow = await hub('GET', `/objects/${PROBE}`);
  check('…and is gone afterwards', goneNow.status === 404, `http ${goneNow.status}`);
} catch (err) {
  failures.push('probe crashed');
  console.log(`FAIL  the probe could not finish — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (child) child.kill('SIGKILL');
  await sleep(300);
  await cleanup().catch(() => {});
  console.log(failures.length ? `\n${pass} passed, ${failures.length} FAILED` : `\nALL PASS (${pass} checks)`);
  process.exit(failures.length ? 1 : 0);
}
