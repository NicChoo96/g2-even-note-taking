#!/usr/bin/env node
// PROBE — can a WRITE find a series that only exists on the HUB?
//
// WHY THIS EXISTS
//   Twice now the same symptom has been "fixed" from the wrong evidence:
//   `metrics.act list` showed six psi.* series (it asks the hub) while `write`
//   answered "unknown series" (it looked at two local maps that are EMPTY in hub
//   mode). A harness that boots a relay WITHOUT a hub can never reproduce that,
//   because in relay mode the declarations really are local.
//
//   So this probe is deliberately the production shape:
//     · a series is created STRAIGHT ON THE HUB (never through the schedule),
//     · a real relay is booted with METRICS_API pointed at that hub,
//     · the tool is driven over /api/tool, the same route the agent loop uses.
//
// WHAT IT ASSERTS
//   1. reading a hub-only series returns its history (resolution works, no write),
//   2. writing to a hub-only series is accepted and lands on the hub,
//   3. a genuine miss returns a NON-EMPTY error naming the key,
//   4. the same slot twice leaves one reading (idempotency),
//   5. backing a reading with `at` keeps its timestamp,
//   6. a reading dated years ago is ACCEPTED (the past is data, not an error),
//   7. and a date the store cannot hold is refused in dates, not epoch ms.
//
// It touches ONLY a throwaway key (`test.probe.write`) and deletes it at the end.
// The wearer's real series are read once and never written.
//
// Run: node tools/probe-metrics-hub-write.mjs
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
  console.error('FAIL  no JARVIS_FILE_API_KEY in web/.env.local — cannot reach the hub store');
  process.exit(2);
}

const HUB = 'http://167.172.77.136/hub/metrics';
const PROBE = 'test.probe.write';
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

async function hub(method, path, body) {
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const cleanup = async () => {
  await hub('DELETE', `/samples?series=${encodeURIComponent(PROBE)}`);
  await hub('DELETE', `/series/${encodeURIComponent(PROBE)}?purge=1`);
};

let child = null;
try {
  await cleanup(); // a previous run that died mid-way
  const created = await hub('POST', '/series', {
    key: PROBE,
    label: 'Write probe',
    unit: 'u',
    type: 'number',
    source: 'probe — safe to delete',
  });
  check('a series can be created straight on the hub', created.status === 201 || created.json.created === true, `http ${created.status}`);

  const dir = mkdtempSync(join(tmpdir(), 'g2-probe-write-'));
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
      METRICS_API: HUB,
      JARVIS_FILE_API_KEY: KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => (log += String(b)));
  child.stderr.on('data', (b) => (log += String(b)));
  for (let i = 0; i < 150; i += 1) {
    if (/relay on http/.test(log) && /\[metrics\] hub store/.test(log)) break;
    await sleep(100);
  }
  check('the relay booted in HUB mode (the production shape)', /\[metrics\] hub store/.test(log), log.includes('no METRICS_API') ? 'relay fell back to the local file' : '');

  const tool = async (args) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/tool`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'tool-metrics', name: 'jarvis_metrics', kind: 'metrics', args }),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  // 1. READING a hub-only series — proves resolution without writing anything.
  const read = await tool({ action: 'read', series: 'psi.central', limit: 5 });
  check('reading a hub-only series works', read.json.ok === true, String(read.json.result ?? '').slice(0, 90));
  check('and returns its readings', /5 of 5 reading/.test(String(read.json.result)), String(read.json.result ?? '').slice(0, 90));

  // 2. WRITING to a hub-only series — the bug.
  const wrote = await tool({ action: 'write', series: PROBE, value: 42, slot: '2026-11-10' });
  check('writing to a hub-only series is ACCEPTED', wrote.json.ok === true, `${JSON.stringify(wrote.json).slice(0, 160)}`);

  const after = await hub('GET', `/series/${encodeURIComponent(PROBE)}`);
  check('and the reading is on the hub', Number(after.json.item?.count) === 1, `count=${after.json.item?.count}`);

  // 3. A genuine miss must carry a REASON and NAME the key.
  const miss = await tool({ action: 'write', series: 'nope.nothing', value: 1, slot: '2026-11-10' });
  check('a real miss is still refused', miss.json.ok === false);
  check('and the refusal names the key', /nope\.nothing/.test(String(miss.json.result)), String(miss.json.result ?? ''));
  check('and the refusal carries a non-empty error', String(miss.json.error ?? '').trim().length > 0, JSON.stringify(miss.json.error));

  // 4. Idempotency: the same slot twice is one reading, replaced.
  await tool({ action: 'write', series: PROBE, value: 43, slot: '2026-11-10' });
  const again = await hub('GET', `/series/${encodeURIComponent(PROBE)}`);
  check('the same slot twice leaves ONE reading', Number(again.json.item?.count) === 1, `count=${again.json.item?.count}`);
  check('holding the newer value', Number(again.json.item?.latest?.value) === 43, `latest=${again.json.item?.latest?.value}`);

  // 5. A backfilled reading keeps its own time.
  const when = Date.parse('2026-10-08T13:00:00+08:00');
  await tool({ action: 'write', series: PROBE, value: 154, slot: '2026-10-08T13:00', at: '2026-10-08T13:00+08:00' });
  const back = await hub('GET', `/samples?series=${encodeURIComponent(PROBE)}&from=0&limit=10`);
  const hit = (back.json.items ?? []).find((s) => Number(s.ts) === when);
  check('a backfilled reading keeps the time it happened', Boolean(hit), `want ts=${when}, got ${JSON.stringify((back.json.items ?? []).map((s) => s.ts))}`);

  // 6. A reading may be dated as far back as the store's floor.
  //    The bound used to be ±365 days around NOW, which refused exactly the
  //    readings a backfill exists to store: the older the sheet, the more
  //    certainly refused. Importing 2018 was impossible and 2013 doubly so.
  const old = await tool({ action: 'write', series: PROBE, value: 1, slot: '2018-11', at: '2018-11-04T10:00+08:00' });
  check('a 2018 reading is accepted', old.json.ok === true, JSON.stringify(old.json).slice(0, 160));
  const oldHit = await hub('GET', `/samples?series=${encodeURIComponent(PROBE)}&from=0&limit=20`);
  check(
    'and stored at its own date',
    (oldHit.json.items ?? []).some((s) => Number(s.ts) === Date.parse('2018-11-04T10:00+08:00')),
    JSON.stringify((oldHit.json.items ?? []).map((s) => s.ts)),
  );

  // 7. The refusal for an impossible date names DATES, not eleven digits.
  const refused = await tool({ action: 'write', series: PROBE, value: 1, slot: '2001-01', at: '2001-01-01T00:00+08:00' });
  const reason = String(refused.json.error ?? '');
  check('a pre-floor date is still refused', refused.json.ok === false);
  check('and the refusal says the allowed dates', /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(reason), reason.slice(0, 200));
  check('instead of two raw millisecond integers', !/must be between \d{12}/.test(reason), reason.slice(0, 200));
} catch (err) {
  failures.push('the probe could not run');
  console.log(`FAIL  the probe could not run — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (child) child.kill('SIGKILL');
  await sleep(200);
  await cleanup();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
}
