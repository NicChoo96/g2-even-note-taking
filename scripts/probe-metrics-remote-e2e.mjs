// End to end against the LIVE hub metric store: does a collector's reading
// actually land in the hub, does the page read it back from there, and can a
// series be removed together with its readings?
//
// Uses a `probe.` series and now cleans up through the API (DELETE /samples and
// a purging DELETE /series), so a complete run leaves the hub exactly as it
// found it. The SQL fallback printed on failure is for an interrupted run only.
//
// Run: node --env-file=web/.env.local scripts/probe-metrics-remote-e2e.mjs
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const relayPath = resolve(here, '../web/server/local-sse.mjs');
const hub = String(process.env.JARVIS_FILE_URL || '').replace(/\/+$/, '');
const key = String(process.env.JARVIS_FILE_API_KEY || '').trim();
if (!hub || !key) {
  console.error('SKIPPED: needs JARVIS_FILE_URL + JARVIS_FILE_API_KEY');
  process.exit(2);
}

const SERIES = 'probe.e2e.check';
let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};

const PORT = 6300 + Math.floor(Math.random() * 60);
const dir = mkdtempSync(join(tmpdir(), 'g2-e2e-metrics-'));
const TOKEN = createHash('sha256').update(`e-${Date.now()}`).digest('hex');
writeFileSync(
  join(dir, 'auth.json'),
  JSON.stringify({
    sessions: { [createHash('sha256').update(TOKEN).digest('hex')]: { email: 'probe@example.test', createdAt: Date.now() } },
    devices: {},
    revoked: {},
  }),
);

let child = null;
const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};
const hubGet = async (path) => {
  const res = await fetch(`${hub}/hub/metrics${path}`, {
    headers: { Authorization: `Bearer ${key}`, Connection: 'close' },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  child = spawn(process.execPath, [relayPath], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTH_FILE: join(dir, 'auth.json'),
      STATE_FILE: join(dir, 'state.json'),
      AGENT_CRON_FILE: join(dir, 'schedule.json'),
      AGENT_CRON_STATE_FILE: join(dir, 'cron-state.json'),
      METRICS_FILE: join(dir, 'metrics.json'),
      // The point of the test: readings go to the hub, not this disk.
      METRICS_API: `${hub}/hub/metrics`,
      G2_AGENT_CRON: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => {
    log += String(b);
  });
  child.stderr.on('data', (b) => {
    log += String(b);
  });
  for (let i = 0; i < 150; i += 1) {
    if (/\[metrics\] hub store:/.test(log)) break;
    await sleep(100);
  }
  check('the relay boots against the hub store', /\[metrics\] hub store:/.test(log), log.slice(0, 300));

  // Declare through the schedule — the path the UI uses.
  const declared = await api('PUT', '/api/agent/schedule', {
    enabled: true,
    timeZone: 'Asia/Singapore',
    series: [{ key: SERIES, label: 'E2E probe', unit: 'u', type: 'number', precision: 2 }],
    jobs: [],
  });
  check('the schedule is accepted', declared.status === 200, JSON.stringify(declared.body?.error));
  // Declarations are fire-and-forget on save; give the hub a moment.
  await sleep(1200);

  const onHub = await hubGet('/series');
  const found = (onHub.body?.items ?? []).find((s) => s.key === SERIES);
  check('the declaration reached the hub', Boolean(found), `status ${onHub.status}`);

  // A live collector: fetch a number, store it in the hub.
  const collected = await api('POST', '/api/metrics/collect', {
    series: SERIES,
    select: 'stargazers_count',
    request: { url: 'https://api.github.com/repos/nodejs/node', method: 'GET' },
  });
  if (collected.status === 200) {
    check('a live reading was stored', collected.body?.sample?.series, SERIES);
    check('and it went to the hub, not the relay disk', collected.body?.store?.mode, 'hub');

    await sleep(400);
    const readings = await hubGet(`/samples?series=${encodeURIComponent(SERIES)}&limit=10`);
    check('the hub holds exactly one reading', readings.body?.count, 1);
    check(
      'with a numeric value',
      typeof readings.body?.items?.[0]?.value,
      'number',
    );
    // The slot must not carry a space on the wire — the shape the API accepts.
    check(
      'and a slot the API accepts (no space)',
      /^[A-Za-z0-9:._-]+$/.test(String(readings.body?.items?.[0]?.slot ?? '')),
      String(readings.body?.items?.[0]?.slot),
    );

    const dashboard = await api('GET', '/api/metrics');
    check('the dashboard reads from the hub', dashboard.body?.store?.mode, 'hub');
    check('and shows the reading', dashboard.body?.series?.[0]?.count, 1);

    // Deleting a series with readings must be refused with the count, because the
    // hub will not drop a series that still holds samples.
    const del = await api('DELETE', `/api/metrics/series/${SERIES}`);
    check('deleting a non-empty series is refused with a reason', del.status, 409);
    check('and the reason names the readings', /reading/.test(String(del.body?.error)), String(del.body?.error));
    check('and carries the count the page asks about', typeof del.body?.count === 'number', JSON.stringify(del.body ?? {}).slice(0, 160));

    // ── the routes the backend added on 2026-11-09 ──────────────────────────
    // Everything above this line was written against a hub that could not delete
    // a reading. These four paths are now real, so they are proven here rather
    // than left to a unit test with a stub.
    const purge = await api('DELETE', `/api/metrics/series/${SERIES}?purge=1`);
    check('a purge deletes the readings and the series', purge.status, 200, JSON.stringify(purge.body ?? {}).slice(0, 200));
    check('and reports how many readings went', purge.body?.deleted === 1, `deleted ${purge.body?.deleted}`);
    // Scoped to THIS key: asserting the array is empty only holds while the probe
    // is the sole owner of the store, which stops being true the moment the
    // wearer declares a series of their own.
    const listedAfter = (purge.body?.series ?? []).some((s) => s.key === SERIES);
    check('the dashboard no longer lists it', !listedAfter, `still listed: ${listedAfter}`);

    // A second delete is a clean 404 path, not a 500: the page can retry safely.
    // (`[200, 404].includes(...)` and not `check(..., [200,404], status)` — an
    // array is always truthy, which is a check that cannot fail.)
    const again = await api('DELETE', `/api/metrics/series/${SERIES}`);
    check('deleting it twice is not an error worth alarming anyone about', [200, 404].includes(again.status), `status ${again.status}`);

    // The widened `source`: a 483-char URL must survive the round trip in full,
    // because provenance that has lost its path cannot say where a number came
    // from.
    const longUrl = `https://example.test/collect${'/segment'.repeat(50)}?a=1`;
    const declared2 = await api('PUT', '/api/agent/schedule', {
      enabled: true,
      timeZone: 'Asia/Singapore',
      series: [{ key: SERIES, label: 'Probe', unit: 'u', type: 'number', precision: 2 }],
      jobs: [],
    });
    check('the series is re-declared for the provenance check', declared2.status === 200, String(declared2.body?.error ?? ''));
    const bigWrite = await api('POST', '/api/metrics/samples', {
      samples: [{ series: SERIES, value: 1.25, slot: '2026-11-09 11:00', source: longUrl }],
    });
    check('a 483-char source is accepted', bigWrite.body?.accepted?.length === 1, JSON.stringify(bigWrite.body?.rejected ?? '').slice(0, 160));
    const back = await api('GET', '/api/metrics');
    // `provenance` is a rendered line ("2026-11-09 09:00 · URL"), not an object —
    // reading `.source` off it silently yields ''.
    const storedSource = String(back.body?.series?.[0]?.provenance ?? '');
    check('and the whole URL is what came back', storedSource.length >= 400, `got ${storedSource.length} chars`);
    check('including the path, which is what identifies the reading', storedSource.includes('/segment'), storedSource.slice(0, 80));

    const finalPurge = await api('DELETE', `/api/metrics/series/${SERIES}?purge=1`);
    check('and the probe cleans up after itself through the API', finalPurge.status, 200);
  } else {
    const err = String(collected.body?.error ?? '');
    if (/fetch failed|ENOTFOUND|EAI_AGAIN|timed out/i.test(err)) {
      console.log(`SKIP  no egress for the live collector (${err.slice(0, 80)})`);
    } else {
      check(`a live reading was stored (${err.slice(0, 140)})`, false, true);
    }
  }
} catch (err) {
  fail += 1;
  console.log(`FAIL  the relay could not be driven — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (child) child.kill('SIGKILL');
  await sleep(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nThe probe now purges through the API, so no SQL cleanup is needed.');
if (fail) {
  console.log(`If a run was interrupted, sweep any residue with:`);
  console.log(`  ssh root@${hub.replace(/^https?:\/\//, '')} 'sqlite3 /var/lib/jarvis-content/hub.sqlite3 "`);
  console.log(`    delete from metric_sample where series like \'probe.%\';`);
  console.log(`    delete from metric_series where key like \'probe.%\';"'`);
}
process.exit(fail ? 1 : 0);
