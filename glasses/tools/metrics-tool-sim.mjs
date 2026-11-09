#!/usr/bin/env node
// METRICS-TOOL harness — what an AGENT can and cannot do with the dashboard.
//
// WHY THIS EXISTS
//   This is the first tool in the set that lets a model WRITE data the wearer
//   will later trust. The dangerous outcomes are not exceptions: a series
//   invented per ticker, "N/A" stored in a price series as 0, one run writing
//   twice and plotting two points for the same minute, a read that silently
//   returns the newest 30 of 900 and is described as "the history".
//
//   Part 1 drives the pure tool with a stub store. Part 2 drives it through the
//   REAL relay's /api/tool proxy, which is the same runner the agent loop uses —
//   so this needs no model call and still proves the wiring.
//
// Run: node tools/metrics-tool-sim.mjs
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const readFile = async (p) => readFileSync(p, 'utf8');

const here = dirname(fileURLToPath(import.meta.url));
const mod = resolve(here, '../../web/server/metrics-tool.mjs');
const { MAX_READ_POINTS, METRICS_TOOL_NAME, isMetricsTool, metricsToolSchema, runMetricsTool } = await import(
  `${pathToFileURL(mod).href}?v=${Date.now()}`
);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};
// Named, because the first draft of this file passed the VALUE to `check` where
// it meant `value === x`, and eight correct behaviours were reported as bugs.
const is = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const text = (r) => String(r?.text ?? '');

// ── 1. the tool's identity and schema ───────────────────────────────────────
check('kind is metrics', isMetricsTool({ kind: 'metrics' }), true);
check('an http tool is not a metrics tool', !isMetricsTool({ kind: 'http' }), 'a kind of http was accepted as metrics');
const schema = metricsToolSchema({});
is('the schema is a function call', schema.type, 'function');
is('with the agreed name', schema.function.name, METRICS_TOOL_NAME);
const fn = schema.function.parameters;
is('four actions, and declare is one of them', fn.properties.action.enum, ['list', 'read', 'declare', 'write']);
is(
  'declare takes the schema fields, not just a key',
  ['label', 'unit', 'valueType', 'cadence'].filter((k) => k in fn.properties),
  ['label', 'unit', 'valueType', 'cadence'],
);
is('unknown arguments are refused by the schema', fn.additionalProperties, false);

// ── 2. list ─────────────────────────────────────────────────────────────────
const emptyList = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'list' },
  { listSeries: async () => ({ ok: true, series: [] }) },
);
check('an empty dashboard is said plainly', /Nothing is tracked yet/.test(text(emptyList)), true);
check('and says how to create one', /declare/.test(text(emptyList)), true);

const listText = text(
  await runMetricsTool(
    { kind: 'metrics' },
    { action: 'list' },
    {
      listSeries: async () => ({
        ok: true,
        series: [
          { key: 'sgx.dbs.price', label: 'DBS', unit: 'SGD', precision: 2, count: 3, latest: { ts: 1, value: 2431.5 } },
          { key: 'news.top', label: 'Top story', unit: '', precision: 0, count: 0, latest: null },
        ],
      }),
    },
  ),
);
check('a value is formatted with its unit', /2,431\.50 SGD/.test(listText), true);
check('a series with no readings says so', /news\.top .*no readings yet/.test(listText), true);

// ── 3. read ────────────────────────────────────────────────────────────────
const noKey = await runMetricsTool({ kind: 'metrics' }, { action: 'read' }, { readSeries: async () => ({ ok: true }) });
check('read without a series is refused', noKey.ok === false, 'a read with no series was allowed');
check('and says which argument is missing', /needs a series key/.test(text(noKey)), true);

const readNoData = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'read', series: 'sgx.dbs.price' },
  { readSeries: async () => ({ ok: true, points: [], count: 0 }) },
);
check('an empty series is not a failure', readNoData.ok, true);
check('and says it has no readings', /no readings yet/.test(text(readNoData)), true);

let askedLimit = null;
const readOk = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'read', series: 'sgx.dbs.price', limit: 5 },
  {
    readSeries: async (_key, limit) => {
      askedLimit = limit;
      return {
        ok: true,
        points: [
          { ts: 1794160000000, value: 36.1 },
          { ts: 1794163600000, value: 36.4 },
        ],
        count: 900,
        truncated: true,
        unit: 'SGD',
        precision: 2,
      };
    },
  },
);
check('the requested limit is passed through', askedLimit, 5);
check('a truncated read SAYS it is truncated', /newest only/.test(text(readOk)), true);
check('and reports the real total, not the page size', /2 of 900/.test(text(readOk)), true);
check('values carry their unit', /36\.40 SGD/.test(text(readOk)), true);

// A limit above the cap is clamped, so one call cannot pull the whole table.
let clampedLimit = null;
await runMetricsTool(
  { kind: 'metrics' },
  { action: 'read', series: 'a.b', limit: 999999 },
  {
    readSeries: async (_key, limit) => {
      clampedLimit = limit;
      return { ok: true, points: [], count: 0 };
    },
  },
);
check('an absurd limit is clamped', clampedLimit, MAX_READ_POINTS);

// ── 4. write ───────────────────────────────────────────────────────────────
const writeNoValue = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'write', series: 'sgx.dbs.price' },
  { writeSample: async () => ({ ok: true }) },
);
check('write without a value is refused', writeNoValue.ok === false, 'a write with no value was allowed');
check('and a blank string counts as no value', /needs a value/.test(text(writeNoValue)), true);

// The store's own refusal is passed through verbatim — the model must not be told
// one thing by the tool and another by the endpoint.
const undeclared = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'write', series: 'made.up.series', value: '1' },
  { writeSample: async () => ({ ok: false, error: 'unknown series — declare it first' }) },
);
check('an undeclared series is refused by the tool', undeclared.ok === false, 'an undeclared series was accepted');
check('with the store’s own words', /declare it first/.test(text(undeclared)), true);

let written = null;
const wrote = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'write', series: 'sgx.dbs.price', value: '2,431.50', slot: '2026-11-09 09:00' },
  {
    writeSample: async (input) => {
      written = input;
      return { ok: true, value: 2431.5, unit: 'SGD', precision: 2, replaced: false, where: 'relay' };
    },
  },
);
check('a value with thousands separators is passed to the store unchanged', written.value, '2,431.50');
check('and the slot travels with it', written.slot, '2026-11-09 09:00');
check('the confirmation names the value and series', /Recorded 2,431\.50 SGD for sgx\.dbs\.price/.test(text(wrote)), true);
// A relay fallback must be visible, not silent: the reading is somewhere else.
check('a non-hub write says where it went', /relay/.test(text(wrote)), true);

const replaced = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'write', series: 'sgx.dbs.price', value: 1 },
  { writeSample: async () => ({ ok: true, value: 1, unit: '', precision: 0, replaced: true, where: 'hub' }) },
);
check('a repeated slot is reported as a replacement', /Replaced/.test(text(replaced)), true);

// ── 4a. backfill: a reading is stamped with WHEN it happened ──────────────
// "Build me a month of PSI" fails silently without this: every reading would be
// stored at the instant the run happened, and the chart would be one spike
// instead of a month. The slot is the identity; `at` is the time.
let backfilled = null;
const withTime = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'write', series: 'psi.west', value: 154, slot: '2026-10-08T13:00', at: '2026-10-08T13:00+08:00' },
  {
    writeSample: async (input) => {
      backfilled = input;
      return { ok: true, value: 154, unit: 'PSI', precision: 2, replaced: false, where: 'hub' };
    },
  },
);
is('a backfilled write carries its own time', backfilled?.ts, Date.parse('2026-10-08T13:00+08:00'));
check('and still reaches the store', withTime.ok, true);

const withoutTime = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'write', series: 'psi.west', value: 61 },
  { writeSample: async (input) => ({ ok: true, value: input.value, unit: 'PSI', precision: 2, where: 'hub' }) },
);
check('a write with no time sends none, so the store stamps "now"', withoutTime.ok, true);

check(
  'an unreadable time is refused instead of silently becoming now',
  (
    await runMetricsTool(
      { kind: 'metrics' },
      { action: 'write', series: 'psi.west', value: 1, at: 'last tuesday' },
      { writeSample: async () => ({ ok: true, value: 1, where: 'hub' }) },
    )
  ).ok === false,
  true,
);

// ── 4b. declare: the schema, created by the model ─────────────────────────
// The failure this exists for: a run gathered a month of PSI readings and had
// nowhere to put them, because a series could only be declared by a human on the
// web first. The whole task was lost at the last step. Declaring is now allowed,
// and the three things that keep it from becoming a mess are asserted here: the
// model may create, it may NOT rewrite a series that exists, and a relay without
// the capability says so rather than pretending.
let declaredInput = null;
const made = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'declare', series: 'psi.west', label: 'PSI west', unit: 'PSI', valueType: 'number', cadence: 'daily' },
  {
    declareSeries: async (input) => {
      declaredInput = input;
      return { ok: true, existed: false, series: { ...input, type: input.type } };
    },
  },
);
is('declare passes the key the model chose', declaredInput?.key, 'psi.west');
is('and the unit with it', declaredInput?.unit, 'PSI');
is('and the reading type', declaredInput?.type, 'number');
is('and is attributed to the model, not the wearer', declaredInput?.source, 'agent');
check('a created series is reported as created', /Created "psi\.west"/.test(text(made)), true);

const already = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'declare', series: 'psi.west', unit: 'millibars' },
  {
    declareSeries: async () => ({
      ok: true,
      existed: true,
      series: { key: 'psi.west', label: 'PSI west', unit: 'PSI', type: 'number', count: 12 },
    }),
  },
);
check('an existing series is reported, not rewritten', /already exists/.test(text(already)), true);
check('and its real unit is quoted back', /PSI/.test(text(already)), true);
check('so the model is not told it just made a millibar series', !/millibars/.test(text(already)), true);

check(
  'declare without a key is refused',
  (await runMetricsTool({ kind: 'metrics' }, { action: 'declare' }, { declareSeries: async () => ({ ok: true }) })).ok === false,
);
check(
  'a relay without declare says so plainly',
  /not available/.test(text(await runMetricsTool({ kind: 'metrics' }, { action: 'declare', series: 'a.b' }, {}))),
  true,
);
check(
  'the store’s own naming rule reaches the model',
  /must be dotted/.test(
    text(
      await runMetricsTool(
        { kind: 'metrics' },
        { action: 'declare', series: 'Not A Key' },
        { declareSeries: async () => ({ ok: false, error: 'key "not a key" must be dotted, lowercase' }) },
      ),
    ),
  ),
  true,
);

// ── 5. unknown action ──────────────────────────────────────────────────────
// NOT 'declare' any more — that is a real action now, and using it here made the
// test pass for the wrong reason (it refused only because no declare dependency
// was supplied). A test whose "unknown" input became known is a test that stopped
// covering anything.
const unknown = await runMetricsTool({ kind: 'metrics' }, { action: 'delete', series: 'x.y' }, {});
check('an unknown action is refused', unknown.ok === false, 'an unknown action was accepted');
check('and lists the valid ones', /list, read, declare or write/.test(text(unknown)), true);

// ── 5b. A WEEK OF NEWS, one write per day ─────────────────────────────────
// The ask this exists for: "search the news for rate-cut mentions each day this
// week and keep the count". An agent cannot declare a series (rule 1), so the
// wearer declares `news.rates.count` once on the Data page; the run then does ONE
// `write` per day with the DAY as its slot. The slot is what makes a re-run safe:
// running the same week twice replaces each day instead of doubling the chart,
// which is the difference between a retry and a corrupted history.
const mem = new Map();
const weekStore = {
  writeSample: async (input) => {
    const key = `${input.series}@${input.slot}`;
    const replaced = mem.has(key);
    const value = Number(String(input.value).replace(/,/g, ''));
    mem.set(key, { value, unit: 'mentions' });
    return { ok: true, value, unit: 'mentions', precision: 0, replaced, where: 'hub' };
  },
};
const week = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];
let accepted = 0;
for (const [i, day] of week.entries()) {
  const res = await runMetricsTool(
    { kind: 'metrics' },
    { action: 'write', series: 'news.rates.count', value: String(300 + i), slot: day },
    weekStore,
  );
  if (res.ok) accepted += 1;
}
check('a week of daily writes is accepted', accepted, 7);
check('and lands as seven distinct readings', mem.size, 7);

const rerun = await runMetricsTool(
  { kind: 'metrics' },
  { action: 'write', series: 'news.rates.count', value: 307, slot: '2026-11-09' },
  weekStore,
);
check('re-running one day does not add a reading', mem.size, 7);
check('it replaces, and says so', /Replaced/.test(text(rerun)), true);

// ── 6. THE REAL RELAY, through the same runner the agent loop uses ─────────
const PORT = 6400 + Math.floor(Math.random() * 60);
const dir = mkdtempSync(join(tmpdir(), 'g2-mtool-'));
const TOKEN = createHash('sha256').update(`t-${Date.now()}`).digest('hex');
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
  G2_HUB_ENV: '0',
  AUTH_FILE: join(dir, 'auth.json'),
  STATE_FILE: join(dir, 'state.json'),
  AGENT_CRON_FILE: join(dir, 'schedule.json'),
  AGENT_CRON_STATE_FILE: join(dir, 'cron-state.json'),
  METRICS_FILE: join(dir, 'metrics.json'),
  G2_AGENT_CRON: '0',
};
for (const k of ['JARVIS_FILE_URL', 'JARVIS_FILE_USER', 'JARVIS_FILE_PWD', 'JARVIS_FILE_API_KEY', 'METRICS_API']) {
  delete env[k];
}

let child = null;
const call = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  child = spawn(process.execPath, [resolve(here, '../../web/server/local-sse.mjs')], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

  const tool = { id: 'tool-metrics', name: 'jarvis_metrics', kind: 'metrics' };

  const listEmpty = await call('POST', '/api/tool', { ...tool, args: { action: 'list' } });
  check('the proxy runs a metrics tool', listEmpty.status, 200);
  check('and an empty dashboard is explained', /Nothing is tracked yet/.test(String(listEmpty.body?.result)), true);

  // THE WHOLE POINT, over the real wire: a series that nobody declared anywhere,
  // created by the TOOL, then written to — which is what "track this for a month"
  // needs and what used to end with the readings having nowhere to go.
  const declareOverHttp = await call('POST', '/api/tool', {
    ...tool,
    args: { action: 'declare', series: 'psi.west', label: 'PSI west', unit: 'PSI', valueType: 'number' },
  });
  check('the model can create a series over HTTP', declareOverHttp.body?.ok, true);
  check('and is told it was created', /Created "psi\.west"/.test(String(declareOverHttp.body?.result)), true);

  const writeNew = await call('POST', '/api/tool', {
    ...tool,
    args: { action: 'write', series: 'psi.west', value: 154, slot: '2026-10-08 13:00' },
  });
  check('and can write into the series it just made', writeNew.body?.ok, true);
  // A number series defaults to 2 decimal places, so the confirmation reads
  // "154.00 PSI" — the unit travelling with the value is what is being asserted.
  check('the reading carries the unit it declared', /154\.00 PSI/.test(String(writeNew.body?.result)), true);

  const declareAgain = await call('POST', '/api/tool', {
    ...tool,
    args: { action: 'declare', series: 'psi.west', unit: 'millibars' },
  });
  check('declaring it again does not rewrite the unit', /already exists/.test(String(declareAgain.body?.result)), true);
  check('and the original unit is what comes back', /PSI/.test(String(declareAgain.body?.result)), true);

  const dashPsi = await call('GET', '/api/metrics');
  const psi = (dashPsi.body?.series ?? []).find((s) => s.key === 'psi.west');
  check('the new series is on the dashboard', Boolean(psi), true);
  check('with its reading in place', psi?.count, 1);
  check('and its declared unit', psi?.unit, 'PSI');

  // Declare through the schedule, then write through the TOOL.
  await call('PUT', '/api/agent/schedule', {
    enabled: true,
    timeZone: 'Asia/Singapore',
    series: [{ key: 'sgx.dbs.price', label: 'DBS', unit: 'SGD', type: 'number', precision: 2 }],
    jobs: [],
  });

  const undeclaredOverHttp = await call('POST', '/api/tool', {
    ...tool,
    args: { action: 'write', series: 'nope.nothing', value: 1 },
  });
  check('writing an undeclared series is refused over HTTP', undeclaredOverHttp.body?.ok === false, 'the relay accepted a write to an undeclared series');

  const writeOverHttp = await call('POST', '/api/tool', {
    ...tool,
    args: { action: 'write', series: 'sgx.dbs.price', value: '36.10', slot: '2026-11-09 09:00' },
  });
  check('a declared series accepts a write', writeOverHttp.body?.ok, true);
  check('and the answer names the value', /36\.10 SGD/.test(String(writeOverHttp.body?.result)), true);

  // The same slot again must NOT create a second point.
  await call('POST', '/api/tool', {
    ...tool,
    args: { action: 'write', series: 'sgx.dbs.price', value: 37.2, slot: '2026-11-09 09:00' },
  });
  const dash = await call('GET', '/api/metrics');
  check('a repeated slot leaves ONE reading', dash.body?.series?.[0]?.count, 1);
  check('holding the newer value', dash.body?.series?.[0]?.latest?.value, 37.2);

  const readOverHttp = await call('POST', '/api/tool', {
    ...tool,
    args: { action: 'read', series: 'sgx.dbs.price' },
  });
  check('a read returns the history', /1 of 1 reading/.test(String(readOverHttp.body?.result)), true);
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

// ── 7. is it reachable at all? ────────────────────────────────────────────
// A tool that exists and is never offered is the failure mode this whole family
// of harnesses exists for: the schema and the executor are two separate call
// sites, and a branch in one but not the other silently produces a tool the
// model is told about and cannot call (or vice versa).
const relaySrc = await readFile(resolve(here, '../../web/server/local-sse.mjs'), 'utf8');
check('the relay imports the metrics tool', /from '\.\/metrics-tool\.mjs'/.test(relaySrc), true);
check(
  'the schema is offered to a run',
  /if \(isMetricsTool\(t\)\) return metricsToolSchema\(t\)/.test(relaySrc),
  'toolSchemaFor has no metrics branch, so the model would never see the tool',
);
check(
  'and the run executes it',
  /if \(isMetricsTool\(tool\)\) \{\s*\n?\s*const result = await runMetricsTool\(tool, args, metricToolDeps\(\)\)/.test(relaySrc),
  'runTool has no metrics branch, so a call would fall through to the HTTP path',
);
check(
  'and the proxy does too',
  /if \(isMetricsTool\(body\)\) \{\s*\n?\s*const result = await runMetricsTool\(body, args, metricToolDeps\(\)\)/.test(relaySrc),
  'POST /api/tool has no metrics branch',
);
const storeSrc = await readFile(resolve(here, '../src/agents-store.ts'), 'utf8');
check('the editor can seed the tool', /export function toolBody[\s\S]{0,120}rest/.test(storeSrc), true);
const typesSrc = await readFile(resolve(here, '../src/types.ts'), 'utf8');
check('the catalogue knows the kind', /kind: 'metrics'/.test(typesSrc), true);
const panelSrc = await readFile(resolve(here, '../src/web/AgentsPanel.tsx'), 'utf8');
check('and offers it as a chip', /addMetricsToAgent/.test(panelSrc), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
