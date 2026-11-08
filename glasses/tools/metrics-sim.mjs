#!/usr/bin/env node
// METRICS harness — the store's rules, then the real API.
//
// WHY THIS EXISTS
//   This is the layer an LLM will eventually write into, so the failure modes are
//   not crashes — they are quiet: a string landing in a number series and one
//   point vanishing from a chart; the same slot written twice and plotted as two
//   readings; an undeclared series appearing because a prompt said the word
//   "price". None of those throw, and none are visible without looking.
//
//   Part 1 drives the pure rules. Part 2 drives the REAL relay over HTTP: declare
//   a series through the schedule (where declarations live), append samples,
//   read them back. Part 3 fetches one live HTTPS endpoint, and SKIPS rather
//   than fails when the network is unavailable — a sandbox without egress must
//   not be reported as a broken collector.
//
// Run: node tools/metrics-sim.mjs
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const metricsPath = resolve(here, '../../web/server/metrics.mjs');
const relayPath = resolve(here, '../../web/server/local-sse.mjs');

const {
  appendSamples,
  deltaOf,
  dotGet,
  latestOf,
  normaliseSample,
  normaliseSeries,
  trimSamples,
  viewKindFor,
} = await import(`${pathToFileURL(metricsPath).href}?v=${Date.now()}`);

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(
    ok
      ? `PASS  ${label}`
      : `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`,
  );
};
const checkTrue = (label, got) => check(label, got === true, true);

// ── 1. series declarations ──────────────────────────────────────────────────
const good = normaliseSeries({ key: 'sgx.dbs.price', label: 'DBS', unit: 'SGD', type: 'number', precision: 2 });
checkTrue('a dotted key is accepted', good.ok);
check('the key is lowercased', good.series?.key, 'sgx.dbs.price');
check('precision is kept', good.series?.precision, 2);
check('an unknown type is refused', normaliseSeries({ key: 'a.b', type: 'money' }).ok, false);
check('a single segment is refused', normaliseSeries({ key: 'price' }).ok, false);
check('uppercase is normalised, not rejected', normaliseSeries({ key: 'SGX.DBS' }).ok, true);
check('spaces are refused', normaliseSeries({ key: 'sgx dbs.price' }).ok, false);
check('an array is refused', normaliseSeries([]).ok, false);
// A string series is legitimate (a headline), it just cannot be charted as numbers.
check('text series default precision is 0', normaliseSeries({ key: 'news.top', type: 'string' }).series?.precision, 0);

// ── 2. samples: the type gate ───────────────────────────────────────────────
const price = normaliseSeries({ key: 'sgx.dbs.price', type: 'number' }).series;
check('a number is stored', normaliseSample({ value: 36.1 }, price).sample?.value, 36.1);
check('a numeric string is accepted', normaliseSample({ value: '36.10' }, price).sample?.value, 36.1);
// Thousands separators are the single most common shape a quote arrives in.
check('a comma-grouped string is accepted', normaliseSample({ value: '2,431.50' }, price).sample?.value, 2431.5);
check('a non-numeric string is REFUSED', normaliseSample({ value: 'n/a' }, price).ok, false);
check('null is refused', normaliseSample({ value: null }, price).ok, false);
check('NaN is refused', normaliseSample({ value: Number.NaN }, price).ok, false);
// The other direction: text series must not silently swallow a number's shape.
const headline = normaliseSeries({ key: 'news.top', type: 'string' }).series;
check('text accepts prose', normaliseSample({ value: 'Rates held' }, headline).sample?.value, 'Rates held');
check('text coerces a number to text', normaliseSample({ value: 42 }, headline).sample?.value, '42');
// An undeclared series is the cardinality bug: refused, never auto-created.
check('an undeclared series is refused', normaliseSample({ value: 1 }, undefined).error, 'unknown series — declare it first');

// ── 3. slots make a double fire harmless ────────────────────────────────────
const base = { series: 'sgx.dbs.price', source: 'https://x' };
const first = appendSamples([], [{ ...base, ts: 1000, value: 1, slot: '2026-11-09 09:00' }]);
check('a first sample appends', first.samples.length, 1);
const second = appendSamples(first.samples, [{ ...base, ts: 1001, value: 2, slot: '2026-11-09 09:00' }]);
check('the SAME slot replaces, it does not append', second.samples.length, 1);
check('and keeps the newer value', second.samples[0].value, 2);
check('and says it replaced', second.replaced, 1);
const third = appendSamples(second.samples, [{ ...base, ts: 2000, value: 3, slot: '2026-11-09 10:00' }]);
check('a new slot appends', third.samples.length, 2);
const unslotted = appendSamples([], [{ ...base, ts: 5, value: 1 }, { ...base, ts: 5, value: 1 }]);
check('samples without a slot are both kept', unslotted.samples.length, 2);
check('and are sorted by time', appendSamples([], [{ ...base, ts: 9, value: 1 }, { ...base, ts: 1, value: 2 }]).samples.map((s) => s.ts), [1, 9]);

// ── 4. retention and read helpers ───────────────────────────────────────────
const many = Array.from({ length: 10 }, (_, i) => ({ ...base, ts: i, value: i }));
check('retention keeps the newest', trimSamples(many, 3).map((s) => s.value), [7, 8, 9]);
check('under the cap is untouched', trimSamples(many, 50).length, 10);
check('latest is the newest', latestOf(many)?.value, 9);
check('latest of nothing is null', latestOf([]), null);
check('delta compares the last two', deltaOf(many), 1);
// A first reading is not "+0"; there is nothing to compare it with.
check('a single reading has no delta', deltaOf([{ ts: 1, value: 5 }]), null);
check('text series have no delta', deltaOf([{ ts: 1, value: 'a' }, { ts: 2, value: 'b' }]), null);

// ── 5. select paths ─────────────────────────────────────────────────────────
const body = { data: { last: 36.1, items: [{ price: 1 }, { price: 2 }] }, ok: true };
check('a dotted path reads a value', dotGet(body, 'data.last'), 36.1);
check('an array index works', dotGet(body, 'data.items.1.price'), 2);
check('an empty path is the body itself', dotGet(body, ''), body);
check('a missing path is undefined', dotGet(body, 'data.nope'), undefined);
check('a path through a non-object is undefined', dotGet(body, 'ok.deeper'), undefined);
check('an out-of-range index is undefined', dotGet(body, 'data.items.9.price'), undefined);

// ── 6. which renderer ───────────────────────────────────────────────────────
check('one point is a stat', viewKindFor(price, 1), 'stat');
check('three points is a series', viewKindFor(price, 3), 'series');
check('text is a table', viewKindFor(headline, 50), 'table');

// ── 6b. the HUB adapter's four wire traps ──────────────────────────────────
// Each of these was found by probing the live service; each fails silently or at
// the worst possible moment if it is wrong.
const remote = await import(`${pathToFileURL(resolve(here, '../../web/server/metrics-remote.mjs')).href}?v=${Date.now()}`);
check('a space in a slot becomes a T', remote.toWireSlot('2026-11-09 09:00'), '2026-11-09T09:00');
check('and comes back as a space', remote.fromWireSlot('2026-11-09T09:00'), '2026-11-09 09:00');
check('an empty slot stays absent', remote.toWireSlot(''), undefined);
check(
  'a number series crosses the wire as a number',
  remote.toWireSample({ series: 'a.b', value: 36.4, slot: '2026-11-09 09:00' }).value,
  36.4,
);
// The hub refuses "36.10" for a number series, so the adapter must never send it.
check(
  'and a numeric string would go as text, which the hub refuses — so callers coerce first',
  typeof remote.toWireSample({ series: 'a.b', value: '36.10' }).value,
  'string',
);

check(
  'a realistic URL keeps its WHOLE path now that the field holds 500',
  remote.toWireSample({ series: 'a.b', value: 1, source: 'https://api.github.com/repos/nodejs/node' }).source,
  'https://api.github.com/repos/nodejs/node',
);
check(
  'and the 500-char ceiling is the one the hub actually enforces',
  remote.SOURCE_MAX,
  500,
);
// The store keeps the provenance and the transport clips it — when those were two
// numbers (300 vs 500) every reading lost the middle of its URL and nothing
// failed. One constant now, and this is the check that notices if it is copied
// again. The expectation is DERIVED from the input: a hardcoded length only pins
// my arithmetic.
const longUrl = `https://h.test/${'p'.repeat(470)}`;
const longSourceSample = normaliseSample(
  { series: 'a.b', value: 1, source: longUrl },
  normaliseSeries({ key: 'a.b', label: 'A', type: 'number' }).series,
  1,
);
check('the store keeps the whole URL it was given', longSourceSample.sample.source, longUrl);
check('which is past the old 300-char clip', longSourceSample.sample.source.length > 300, true);
check(
  'an absurd URL is still fitted, by dropping the path and keeping the host',
  remote
    .toWireSample({ series: 'a.b', value: 1, source: `https://h.test/${'p'.repeat(600)}` })
    .source.length <= 500,
  true,
);

/** A stub that answers with a fixed status/body, for the mapping rules. */
const stub = (status, body) => async () => ({
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const clientFor = (status, body) =>
  remote.createMetricsRemote({ baseUrl: 'http://stub/hub/metrics', token: 'k', fetchImpl: stub(status, body) });

const allRejected = await clientFor(400, {
  ok: false,
  code: 'VALIDATION_ERROR',
  details: { rejected: [{ index: 0, field: 'samples[0].value', error: 'value must be a number' }] },
}).append([{ series: 'a.b', value: 1 }]);
check('an all-rejected 400 is per-item, not a transport failure', allRejected.allRejected, true);
check('and keeps the per-item reason', allRejected.rejected[0]?.error, 'value must be a number');

const partial = await clientFor(200, {
  ok: true,
  accepted: 1,
  rejected: [{ index: 1, field: 'samples[1].value', error: 'nope' }],
  samples: [{ action: 'replaced' }],
}).append([{ series: 'a.b', value: 1 }, { series: 'a.b', value: 'x' }]);
check('a partial batch counts what landed', partial.accepted, 1);
check('and notes the replacement', partial.replaced, 1);

const locked = await clientFor(409, {
  ok: false,
  code: 'SERIES_SHAPE_LOCKED',
  details: { current: { type: 'number', unit: 'x' } },
}).declare({ key: 'a.b', label: 'A', unit: 'USD', type: 'number' });
check('a locked shape is its own outcome', locked.shapeLocked, true);
check('and reports the current shape', locked.current?.unit, 'x');

const notEmpty = await clientFor(409, {
  ok: false,
  code: 'SERIES_NOT_EMPTY',
  details: { key: 'a.b', count: 7 },
}).remove('a.b');
check('a non-empty delete says how many readings', notEmpty.count, 7);
check('and does not pretend it worked', notEmpty.ok, false);

// ── 6b. the routes the backend added on 2026-11-09 ─────────────────────────
// A stub that records every call, so the ORDER can be asserted: deleting the
// series before its samples is the 409 this whole path exists to avoid.
const recorder = (answer) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url).replace('http://stub/hub/metrics', '')}`);
    const entry = typeof answer === 'function' ? answer(url, init) : answer;
    return { status: entry.status, text: async () => (entry.body === undefined ? '' : JSON.stringify(entry.body)) };
  };
  const client = remote.createMetricsRemote({ baseUrl: 'http://stub/hub/metrics', token: 'k', fetchImpl: impl });
  return { client, calls };
};

const readsOne = recorder({ status: 200, body: { ok: true, item: { key: 'a.b', label: 'A', type: 'number', unit: 'SGD', precision: 2, count: 3 } } });
const one = await readsOne.client.get('a.b');
check('a single declaration can be read', one.series?.unit, 'SGD');
check('and asked for exactly that key', readsOne.calls, ['GET /series/a.b']);

const missing = await recorder({ status: 404, body: { ok: false, code: 'NOT_FOUND', error: 'series not found' } });
const gone = await missing.client.get('a.b');
check('a missing series is a fact, not an error string', gone.notFound, true);

const wipes = recorder({ status: 200, body: { ok: true, series: 'a.b', deleted: 2 } });
const wiped = await wipes.client.removeSamples('a.b');
check('samples can be deleted', wiped.deleted, 2);
check('and the call always names the series', wipes.calls, ['DELETE /samples?series=a.b']);

const older = recorder({ status: 200, body: { ok: true, deleted: 1 } });
await older.client.removeSamples('a.b', 1793620800000);
check('a cutoff travels as epoch ms', older.calls, ['DELETE /samples?series=a.b&before=1793620800000']);

const idempotent = recorder({ status: 200, body: { ok: true, deleted: 0 } });
const twice = await idempotent.client.removeSamples('a.b');
check('a second purge is not a failure', twice, { ok: true, deleted: 0 });

// The purge order is the whole point: series-first is the 409.
const purged = recorder((url, init) =>
  init?.method === 'DELETE' && String(url).includes('/series/')
    ? { status: 204 }
    : { status: 200, body: { ok: true, deleted: 5 } },
);
const purgedResult = await purged.client.remove('a.b', { purge: true });
check('a purge deletes the READINGS first, then the series', purged.calls, [
  'DELETE /samples?series=a.b',
  'DELETE /series/a.b',
]);
check('and reports how many went with it', purgedResult.deleted, 5);

// Without `purge` it must not touch a single reading.
const careful = recorder((url, init) =>
  init?.method === 'DELETE' && String(url).includes('/series/')
    ? { status: 409, body: { ok: false, code: 'SERIES_NOT_EMPTY', details: { count: 5 } } }
    : { status: 200, body: { ok: true, deleted: 5 } },
);
const carefulResult = await careful.client.remove('a.b');
check('a plain delete never destroys readings', careful.calls, ['DELETE /series/a.b']);
check('and asks the question instead', carefulResult.notEmpty, true);

// ── 7. the REAL relay over HTTP ─────────────────────────────────────────────
const PORT = 6200 + Math.floor(Math.random() * 60);
const dir = mkdtempSync(join(tmpdir(), 'g2-metrics-'));
const TOKEN = createHash('sha256').update(`m-${Date.now()}`).digest('hex');
writeFileSync(
  join(dir, 'auth.json'),
  JSON.stringify({
    sessions: { [createHash('sha256').update(TOKEN).digest('hex')]: { email: 'probe@example.test', createdAt: Date.now() } },
    devices: {},
    revoked: {},
  }),
);

const env = {
  ...process.env,
  PORT: String(PORT),
  // No developer secrets, no gateway: this test must never sign in anywhere.
  G2_HUB_ENV: '0',
  AUTH_FILE: join(dir, 'auth.json'),
  STATE_FILE: join(dir, 'state.json'),
  AGENT_CRON_FILE: join(dir, 'schedule.json'),
  AGENT_CRON_STATE_FILE: join(dir, 'cron-state.json'),
  METRICS_FILE: join(dir, 'metrics.json'),
  G2_AGENT_CRON: '0',
};
for (const k of ['JARVIS_FILE_URL', 'JARVIS_FILE_USER', 'JARVIS_FILE_PWD', 'JARVIS_FILE_API_KEY']) delete env[k];

let child = null;
const call = async (method, path, body) => {
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

try {
  child = spawn(process.execPath, [relayPath], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (b) => {
    log += String(b);
  });
  child.stderr.on('data', (b) => {
    log += String(b);
  });
  for (let i = 0; i < 120; i += 1) {
    if (/relay on http/.test(log) && /\[cron\] (idle|on|off)/.test(log)) break;
    await sleep(100);
  }
  checkTrue('the relay boots', /relay on http/.test(log));

  const empty = await call('GET', '/api/metrics');
  check('a fresh relay has no series', empty.status === 200 && empty.body?.series?.length, 0);

  // An undeclared series cannot receive data — the rule, over HTTP.
  const refused = await call('POST', '/api/metrics/samples', { series: 'nope.nothing', value: 1 });
  check('writing to an undeclared series is refused', refused.status, 400);
  check('and names the reason', /unknown series/.test(String(refused.body?.rejected?.[0]?.error)), true);

  // Declarations ride the schedule, which is the durable document.
  const declared = await call('PUT', '/api/agent/schedule', {
    enabled: true,
    timeZone: 'Asia/Singapore',
    series: [{ key: 'sgx.dbs.price', label: 'DBS', unit: 'SGD', type: 'number' }],
    jobs: [
      {
        kind: 'fetch',
        series: 'sgx.dbs.price',
        at: '09:00',
        select: 'data.last',
        request: { url: 'https://example.com/quote', method: 'GET' },
      },
    ],
  });
  check('a declared series is accepted with the schedule', declared.status, 200);
  check('and the collector is reported back', declared.body?.jobs?.[0]?.kind, 'fetch');

  const stored = await call('POST', '/api/metrics/samples', {
    samples: [
      { series: 'sgx.dbs.price', value: '36.10', slot: '2026-11-09 09:00' },
      { series: 'sgx.dbs.price', value: 36.4, slot: '2026-11-09 10:00' },
      { series: 'sgx.dbs.price', value: 'n/a', slot: '2026-11-09 11:00' },
    ],
  });
  check('two of three samples are accepted', stored.body?.accepted?.length, 2);
  check('the bad one is reported, not silently dropped', stored.body?.rejected?.length, 1);
  check('the series now has two points', stored.body?.series?.[0]?.count, 2);
  check('and the newest value is the reading', stored.body?.series?.[0]?.latest?.value, 36.4);

  // The same slot again must replace, so a grace-window double fire cannot plot twice.
  const reslot = await call('POST', '/api/metrics/samples', {
    series: 'sgx.dbs.price',
    value: 37.2,
    slot: '2026-11-09 10:00',
  });
  check('a repeated slot does not grow the series', reslot.body?.series?.[0]?.count, 2);
  check('it replaces the value', reslot.body?.series?.[0]?.latest?.value, 37.2);

  const listed = await call('GET', '/api/metrics');
  check('the collector is listed for the series', listed.body?.collectors?.[0]?.series, 'sgx.dbs.price');
  check('and promises a next firing', typeof listed.body?.collectors?.[0]?.nextAt === 'number', true);
  // The store says out loud that it is not durable — no hopeful silence.
  check('the payload admits the store is not durable yet', listed.body?.store?.durable, false);

  const blocked = await call('DELETE', '/api/metrics/series/sgx.dbs.price');
  check('a series in use cannot be deleted', blocked.status, 409);
  check('and the reason names the collector', /collector/i.test(String(blocked.body?.error)), true);

  // ── 8. one live fetch, skipped when there is no egress ───────────────────
  await call('PUT', '/api/agent/schedule', {
    enabled: true,
    timeZone: 'Asia/Singapore',
    series: [{ key: 'live.check', label: 'Live check', type: 'string' }],
    jobs: [],
  });
  const live = await call('POST', '/api/metrics/collect', {
    series: 'live.check',
    request: { url: 'https://api.github.com/zen', method: 'GET' },
  });
  const liveError = String(live.body?.error ?? '');
  // A sandbox without egress is not a broken collector — but a `502` that is NOT
  // a network failure is our bug, and skipping it is how a missing import
  // survived a run of this file once already.
  const networkOnly = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|timed out|socket/i.test(liveError);
  if (live.status === 200) {
    check('a live HTTPS collector stored a reading', live.body?.sample?.series, 'live.check');
  } else if (networkOnly) {
    console.log(`SKIP  no egress for a live HTTPS collector (${live.status}: ${liveError.slice(0, 80)})`);
  } else {
    check(`a live HTTPS collector runs without faulting (${liveError.slice(0, 120)})`, false, true);
  }
} catch (err) {
  fail += 1;
  console.log(`FAIL  the relay could not be driven — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (child) child.kill('SIGKILL');
  // Windows keeps the child's handles for a moment after SIGKILL, so an
  // immediate rmdir is EPERM. Waiting is cheaper than a retry loop.
  await sleep(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not a test failure.
  }
}

// ── 8. the panel can declare a series WITHOUT a collector ──────────────────
// The tool can only write to a series that already exists, and until now the only
// UI that created one also demanded a URL and a schedule — so "ask Jarvis to track
// this" had no first step. These are source assertions on purpose: the behaviour
// (a series with `jobs: []` accepting a tool write) is already proven above.
const panelSrc = readFileSync(resolve(here, '../src/web/DataPanel.tsx'), 'utf8');
check('one helper puts a series into the schedule', /const putSeries = async/.test(panelSrc), true);
check('the collector form declares through it', /const declareSeries = \(\): Promise<boolean> => putSeries\(draft\)/.test(panelSrc), true);
check('and a standalone form exists', /const declareOnly = async/.test(panelSrc), true);
check('offered in the panel', /onClick=\{\(\) => void declareOnly\(\)\}/.test(panelSrc), true);
check('and it needs no URL', /declareOnly[\s\S]{0,900}?No URL/.test(panelSrc) || /no collector\b/i.test(panelSrc), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
