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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const metricsPath = resolve(here, '../../web/server/metrics.mjs');
const relayPath = resolve(here, '../../web/server/local-sse.mjs');

const {
  appendSamples,
  deltaOf,
  dotGet,
  humanRejectReason,
  latestOf,
  normaliseSample,
  normaliseSeries,
  seriesDefinition,
  slotInstant,
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
  // Through the DEDICATED declare route: a declaration used to be smuggled inside
  // the whole schedule document, which is why this line previously sent `jobs: []`
  // and would now be refused — correctly — by the wipe guard.
  const declaredLive = await call('POST', '/api/metrics/series', {
    key: 'live.check',
    label: 'Live check',
    type: 'string',
  });
  check('a series can be declared on its own', declaredLive.status === 200, true);
  // The schedule above holds ONE collector job. If declaring a series could still
  // wipe the document, this is the assertion that would catch it.
  check(
    'and declaring one does not disturb the jobs',
    Array.isArray(declaredLive.body?.collectors) && declaredLive.body.collectors.length === 1,
    true,
  );
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

// ── 7b. finding a declaration, in hub mode ───────────────────────────────
// THE PRODUCTION BUG: with the hub configured, declarations live in the
// schedule document and the local `metricStore` is EMPTY. `list` asked the hub
// and saw six series; `write` looked only at the local map, found nothing, and
// refused with "unknown series — declare it first". A whole dashboard that
// could be read and not written to.
const declared = [{ key: 'psi.central', label: 'PSI central', unit: 'PSI', type: 'number' }];
check('the declaration is found in the schedule, with an empty local store', seriesDefinition('psi.central', declared, {})?.unit, 'PSI');
check('and in the local store when that is where it lives', seriesDefinition('psi.west', [], { 'psi.west': { key: 'psi.west', unit: 'PSI' } })?.unit, 'PSI');
check('the schedule wins over the local copy', seriesDefinition('psi.central', declared, { 'psi.central': { key: 'psi.central', unit: 'millibars' } })?.unit, 'PSI');
check('a key is matched case-insensitively', seriesDefinition('PSI.Central', declared, null)?.key, 'psi.central');
check('a missing series is null, not a throw', seriesDefinition('nope.nothing', declared, {}), null);
check('a blank key is null', seriesDefinition('', declared), null);
check('a missing source is skipped', seriesDefinition('psi.central', undefined, declared)?.key, 'psi.central');

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

// ── 9. reading the list: refresh, and a search that narrows it ─────────────
// The dashboard only learned about new readings on a page RELOAD, which on a
// phone also throws away your selection and your scroll position — so a number
// an agent wrote a minute ago looked like it had not been written at all.
check('the panel can re-read without a page reload', /const refresh = useCallback\(async/.test(panelSrc), true);
check('there is a Refresh control in the header', /className="dp-refresh"[\s\S]{0,200}?onClick=\{\(\) => void refresh\(\)\}/.test(panelSrc), true);
check('and it disables itself while running', /disabled=\{refreshing \|\| loading\}/.test(panelSrc), true);
check(
  'a failed refresh says so instead of nothing',
  /catch \(err\)[\s\S]{0,120}?setWarn\(err instanceof Error \? err\.message : 'could not refresh'\)/.test(panelSrc),
  true,
);

// The list is the index; searching it is a filter over what is already in
// memory, so it must not re-query the store and must not move the selection.
// Since tables arrived the box searches BOTH stores, which is why the wording
// is no longer "these numbers" alone.
check('the list has a search box', /placeholder="Search these numbers and tables"/.test(panelSrc), true);
check('it matches the key', /s\.key\.toLowerCase\(\)\.includes\(q\)/.test(panelSrc), true);
check('the label', /\(s\.label \?\? ''\)\.toLowerCase\(\)\.includes\(q\)/.test(panelSrc), true);
check('and the unit', /\(s\.unit \?\? ''\)\.toLowerCase\(\)\.includes\(q\)/.test(panelSrc), true);
// A TABLE is searchable by its own identity and by its COLUMNS — a table an
// agent created is named after its subject, and the columns are what anyone
// would type.
check('and a table by its key, label and columns', /t\.fields\.some\(\(f\) => f\.key\.includes\(q\)/.test(panelSrc), true);
check('an empty result names the search and offers a way out', /Nothing matches/.test(panelSrc) && /Clear the search/.test(panelSrc), true);
check('the search bar sits outside the scrolling strip', /metric-master-wrap[\s\S]{0,900}?mm-search[\s\S]{0,1600}?className="metric-master"/.test(panelSrc), true);
// The selection is resolved against the FULL list on purpose: typing must not
// silently swap the chart you are reading for a different series. Since tables
// arrived it is resolved per KIND as well, so a key shared by both stores cannot
// open the wrong one.
check(
  'the open series is still found after filtering',
  /const selectedSeries = series\.find\(\(s\) => s\.key === selection\?\.key\)/.test(panelSrc),
  true,
);
check('and a table is resolved separately', /const selectedTable = tables\.find\(\(t\) => t\.key === selection\?\.key\)/.test(panelSrc), true);
check('and the groups are built from the filtered list', /groupSeries\(filtered\)/.test(panelSrc), true);

// ── 10. a refusal is written for a person ──────────────────────────────────
// The hub validates a BATCH, so it names the field by its position in it. That
// index describes the array this relay built, not the reading the wearer asked
// to store, and nobody can act on it — so it goes. The dates stay.
check('a hub refusal loses the batch index', humanRejectReason('samples[0].ts 2000-12-31T16:00:00Z is outside the accepted range'), 'ts 2000-12-31T16:00:00Z is outside the accepted range');
check('and keeps the reason after it', humanRejectReason('samples[12].value must be a number'), 'value must be a number');
check('a message with no index is untouched', humanRejectReason('unknown series — declare it first'), 'unknown series — declare it first');
check('and nothing at all is not a crash', humanRejectReason(null), '');

// ── 11. the time filter is derived FROM the readings ───────────────────────
// It used to be four fixed names (24h / 7d / 30d / All) measured back from NOW.
// Two failures followed from that and neither is visible without looking:
//   · an eight-year series could only reach five of its years through "All", and
//   · a backfilled series whose newest reading is 2018 showed an EMPTY chart for
//     every preset, because "the last 7 days" had silently become "of today".
// A filter is a lens on the readings that exist, so both are now impossible.
const chartPath = resolve(here, '../src/web/metric-chart.tsx');
const chartOut = resolve(here, '.tmp-metric-window.mjs');
await build({
  entryPoints: [chartPath],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: chartOut,
  jsx: 'automatic',
  logLevel: 'silent',
});
const chart = await import(`${pathToFileURL(chartOut).href}?v=${Date.now()}`);
rmSync(chartOut, { force: true });

const pt = (ts, value = 1) => ({ ts, value });
const YEAR = 365 * 86_400_000;
const labels = (points) => chart.windowChoices(points).map((c) => c.label);

check(
  'an 8-year series offers look-backs made from its own span',
  labels([pt(Date.UTC(2013, 0, 1)), pt(Date.UTC(2017, 0, 1)), pt(Date.UTC(2021, 0, 1))]),
  ['3 months', '1 year', '3 years', 'All'],
);
check(
  'an 8-hour series gets hour-scale look-backs instead',
  labels([pt(0), pt(4 * 3600e3), pt(8 * 3600e3)]),
  ['15 min', '1 hour', 'All'],
);
check('two readings need no filter', labels([pt(0), pt(YEAR)]), ['All']);
check('one reading needs no filter', labels([pt(0)]), ['All']);
check('no readings at all is still a valid answer', labels([]), ['All']);
// The point of deriving the list: every option is smaller than the data, so no
// option can be "All" wearing a different label.
check(
  'every offered look-back is shorter than the span',
  chart.windowChoices([pt(0), pt(YEAR), pt(2 * YEAR)]).filter((c) => c.value !== 'all').every((c) => c.value < 2 * YEAR),
  true,
);

// The anchor is the LAST READING, which is what makes a backfilled series
// readable. With `now` anchoring, this returned an empty chart on every preset.
const backfilled = [pt(Date.parse('2013-01-01T00:00:00Z')), pt(Date.parse('2017-01-01T00:00:00Z')), pt(Date.parse('2018-11-04T00:00:00Z'))];
check('a window is measured back from the newest reading, not from now', chart.pointsInWindow(backfilled, 7 * 86_400_000).length, 2);
check('…and still contains that newest reading', chart.pointsInWindow(backfilled, 7 * 86_400_000).at(-1).ts, Date.parse('2018-11-04T00:00:00Z'));
// ONE reading before the window opens, not the whole history: enough to start
// the line at the left edge, not so much that "7 days" is really three years.
check('a window keeps the reading just before it opens', chart.pointsInWindow(backfilled, 7 * 86_400_000)[0].ts, Date.parse('2017-01-01T00:00:00Z'));
check('"all" is the whole series', chart.pointsInWindow(backfilled, 'all').length, 3);
check('a window wider than the data keeps everything', chart.pointsInWindow(backfilled, 50 * YEAR).length, 3);

// A stored view from the four-preset version is translated, not discarded.
check('a stored 30-day window keeps its meaning', chart.normaliseWindow('30d'), 30 * 86_400e3);
check('a stored number passes through', chart.normaliseWindow(604_800_000), 604_800_000);
check('"all" stays "all"', chart.normaliseWindow('all'), 'all');
check('a missing choice means all', chart.normaliseWindow(null), 'all');
check('and so does nonsense', chart.normaliseWindow('yesterday'), 'all');
check('zero is not a window', chart.normaliseWindow(0), 'all');
check('nor is a negative one', chart.normaliseWindow(-5), 'all');

// ── 12. the view says what it is showing, and the caveat it needs ─────────
// A line claims "this moved continuously"; a bar claims "this happened, once
// per period". Which is TRUE is a property of the readings: a BTO launch priced
// once a quarter drawn as a line invents a slope between two launches that never
// existed. So the default kind follows the gap between readings.
const DAY = 86_400_000;
check(
  'readings a quarter apart default to bars',
  chart.defaultKind([pt(Date.UTC(2026, 0, 1)), pt(Date.UTC(2026, 3, 1)), pt(Date.UTC(2026, 6, 1))]),
  'bar',
);
check(
  'readings a day apart default to a line',
  chart.defaultKind([pt(0), pt(DAY), pt(2 * DAY), pt(3 * DAY), pt(4 * DAY)]),
  'line',
);
check('two readings are a line, not two bars', chart.defaultKind([pt(0), pt(30 * DAY)]), 'line');
check('one reading is a line', chart.defaultKind([pt(0)]), 'line');

// The slot is the join key, so numericPoints must not drop it on the floor —
// that is the mistake readSeries made, and it made every attribute invisible.
check(
  'a chart point keeps its slot',
  chart.numericPoints([{ ts: 1, value: 339000, slot: '2026-11' }]),
  [{ ts: 1, value: 339000, slot: '2026-11' }],
);
check(
  'a point without a slot has none added',
  chart.numericPoints([{ ts: 1, value: 5 }]),
  [{ ts: 1, value: 5 }],
);
check(
  'a text reading is not a chart point',
  chart.numericPoints([{ ts: 1, value: 'Plantation Dew', slot: '2026-11' }]).length,
  0,
);

// A DATE-SHAPED SLOT IS WHEN IT HAPPENED. The relay stamped `now` before the hub
// ever saw the write, so a sibling label written at `slot: 2023-10-15` landed at
// today 04:00 while its price sat at the launch: two readings describing one
// moment, on two different days on the axis.
const DAY0 = Date.UTC(2023, 9, 15);
check('a date slot reads as a date', slotInstant('2023-10-15'), DAY0);
check('a month slot is the first of that month', slotInstant('2026-11'), Date.UTC(2026, 10, 1));
check('a slot with a time keeps it', slotInstant('2026-11-10T13:30'), Date.UTC(2026, 10, 10, 13, 30));
check('a word is not a date', slotInstant('close-1'), null);
check('nor is a 13th month', slotInstant('2026-13'), null);
check('nor is 31 February', slotInstant('2026-02-31'), null);

const datedSample = normaliseSample({ value: 7, slot: '2023-10-15' }, price, Date.now());
check('a dated slot sets the reading time', datedSample.sample.ts, DAY0);
const timedSample = normaliseSample({ value: 7, slot: 'close-1' }, price, 1_700_000_000_000);
check('an ordinary slot still means now', timedSample.sample.ts, 1_700_000_000_000);
const explicitTs = normaliseSample({ value: 7, slot: '2023-10-15', ts: 1_700_000_000_000 }, price, Date.now());
check('an explicit time beats the slot', explicitTs.sample.ts, 1_700_000_000_000);

const chartSrc = readFileSync(chartPath, 'utf8');
check('the chart has a hit area per reading', /className="chart-hit"/.test(chartSrc), true);
check('a tap opens the tooltip', /onPointerDown=\{\(\) => setActiveIndex\(i\)\}/.test(chartSrc), true);
check('a mouse hover opens it too', /pointerType === 'mouse'/.test(chartSrc), true);
check('the tooltip draws the attributes', /attributes \?\? \[\]\)\.flatMap/.test(chartSrc), true);

// The dimensions are DISCOVERED from sibling text series, never configured for
// a particular dataset — "tengah.bto.4room.project" is not a special case.
check('attributes are found by prefix', /const prefix = `\$\{target\.key\}\.`/.test(panelSrc), true);
check('only text siblings count', /s\.type === 'string' && s\.key\.startsWith\(prefix\)/.test(panelSrc), true);
check('the wearer can choose which ones show', /'md-attr-chip active' : 'md-attr-chip'/.test(panelSrc), true);
check('the choice is part of the stored view', /fields: on \? chosen\.filter/.test(panelSrc), true);
check('the chart is handed the chosen dimensions', /attributes=\{shown\}/.test(panelSrc), true);
check('the readings table shows them too', /metric-also/.test(panelSrc), true);
check('an unchosen view keeps showing everything', /view\.fields \?\? attributes\.map/.test(panelSrc), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
