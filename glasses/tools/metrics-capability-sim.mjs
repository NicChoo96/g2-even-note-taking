#!/usr/bin/env node
// METRICS-CAPABILITY harness — Jarvis's own way into the dashboard.
//
// WHY THIS EXISTS
//   The relay can execute a `metrics` tool and an AGENT can be given one, but
//   Jarvis answers "what is DBS at" with no way to look. This pins the
//   capability that closes that: one tool, three actions, and the argument
//   forwarding that decides what the relay is actually asked.
//
//   The forwarding is the interesting part and the reason this file exists. An
//   action that leaks a stale `value` into a `read` is a write nobody asked for;
//   an action that drops `slot` is a reading that silently appends instead of
//   replacing; an unknown action that still calls the relay is a refusal the
//   model never sees. None of those throw, and none of them are visible in a
//   browser.
//
// Run: node tools/metrics-capability-sim.mjs
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
};
const checkTrue = (label, got) => check(label, got === true, true);

// ── bundle the REAL module, with the relay boundary stubbed ─────────────────
// The stub is the point: `runTool` is a POST to /api/tool, and what this
// harness is about is EXACTLY what that POST would carry.
const out = mkdtempSync(join(tmpdir(), 'metrics-capability-sim-'));
const outfile = join(out, 'metrics.mjs');
const stub = join(out, 'agents-client-stub.mjs');
let calls = [];
let reply = { ok: true, result: '' };
await import('node:fs').then(({ writeFileSync }) =>
  writeFileSync(
    stub,
    `export const __calls = [];
export function __reset(next) { __calls.length = 0; if (next) globalThis.__reply = next; }
globalThis.__reply = { ok: true, result: '' };
export async function runTool(args) { __calls.push(args); return globalThis.__reply ?? { ok: true, result: '' }; }
export function __setReply(next) { globalThis.__reply = next; }
`,
  ),
);

await build({
  stdin: {
    contents: `
export { metricsCapabilities, METRICS_TEXT_CHARS } from './ai/capabilities/metrics.ts';
export { __calls, __setReply } from './web/agents-client.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  plugins: [
    {
      name: 'stub-relay',
      setup(b) {
        // Only the capability's own import is redirected; the entry's re-export
        // names the same module, so redirect it too and pass the stub through.
        b.onResolve({ filter: /web\/agents-client(\.ts)?$/ }, () => ({ path: stub }));
      },
    },
  ],
});
const { metricsCapabilities, METRICS_TEXT_CHARS, __calls, __setReply } = await import(pathToFileURL(outfile).href);

// ── 1. three capabilities: act freely, declare and forget behind a tap ──
// They are deliberately separate: the confirmation gate is per-capability, so
// folding `declare` into `act` would either strip the tap from creating a series
// or add one to every read. `forget` is gated for the opposite reason — it is the
// only one that DESTROYS a reading, and nothing can bring one back.
check('three capabilities', metricsCapabilities.length, 3);
const cap = metricsCapabilities.find((c) => c.name === 'metrics.act');
const declareCap = metricsCapabilities.find((c) => c.name === 'metrics.declare');
checkTrue('act exists', Boolean(cap));
checkTrue('declare exists', Boolean(declareCap));
check('named for the subject', cap.name, 'metrics.act');
check('it is app-wide', cap.page, 'global');
// It can WRITE numbers the wearer keeps, so calling it a read would be a lie to
// the ledger. Not irreversible: a reading is visible, replaceable, never destroys.
check('classified as a write', cap.effect, 'write');
check('and not gated behind a tap', cap.confirm, undefined);

// Creating a schema IS gated: unit and type are permanent and the readings are
// kept for months, so the wearer taps to accept what the model proposes.
check('declare is app-wide too', declareCap.page, 'global');
check('declare is a write', declareCap.effect, 'write');
check('and it IS gated behind a tap', declareCap.confirm, true);

// ── 1b. forget: the one capability that destroys a reading ─────────────────
// A deleted reading cannot be recovered, so it takes a slot the wearer has to
// confirm — and it deliberately cannot reach the whole series.
const forgetCap = metricsCapabilities.find((c) => c.name === 'metrics.forget');
checkTrue('forget exists', Boolean(forgetCap));
check('forget is app-wide', forgetCap.page, 'global');
check('forget is gated behind a tap', forgetCap.confirm, true);
check('forget takes the series and the slot', forgetCap.params.filter((p) => p.required).map((p) => p.name), ['series', 'slot']);
check('and says nothing can bring a reading back', /recover/i.test(forgetCap.description), true);

__setReply({ ok: true, result: 'Deleted reading "2023-10-15" from "tengah.bto.4room"; 1 reading(s) removed.' });
await forgetCap.run({ series: 'tengah.bto.4room', slot: '2023-10-15' });
const forgetCall = __calls[__calls.length - 1];
check('forget asks the relay to delete', forgetCall.args.action, 'delete');
check('…naming one reading', forgetCall.args.slot, '2023-10-15');
check('…and never a cutoff', 'before' in forgetCall.args, false);

__setReply({ ok: false, error: 'a delete needs a slot', result: '' });
const forgetFailed = await forgetCap.run({ series: 'tengah.bto.4room', slot: '' });
check('a refused forget is not a success', forgetFailed.ok, false);
check('…and repeats the relay sentence', /needs a slot/.test(String(forgetFailed.summary)), true);
check(
  'declare asks for the schema, not just a key',
  declareCap.params.map((p) => p.name),
  ['series', 'label', 'unit', 'valueType', 'cadence'],
);
checkTrue('the key is required', declareCap.params.find((p) => p.name === 'series').required);
checkTrue(
  'and the description says the unit is permanent',
  /permanent/i.test(declareCap.description),
);

// ── 2. the arguments the model is offered ──────────────────────────────────
const byName = new Map(cap.params.map((p) => [p.name, p]));
check('the actions are exactly the relay', byName.get('action').values, ['list', 'read', 'write']);
checkTrue('action is required', byName.get('action').required);
check('series, limit, value, slot and at exist', [...byName.keys()], ['action', 'series', 'limit', 'value', 'slot', 'at']);
// `at` is what makes a backfill possible: without it a month of readings would
// all be stamped with the moment the run happened.
checkTrue('and at explains the cost of leaving it out', /backfill/i.test(byName.get('at').description));
check('limit defaults to 30', byName.get('limit').fallback, 30);
// A model told nothing about placeholders writes "N/A" into a price series.
checkTrue('the value description refuses placeholders', /N\/A/.test(byName.get('value').description));

// ── 3. forwarding: what the relay is actually asked ────────────────────────
const call = async (args, answer = { ok: true, result: 'ok' }) => {
  __calls.length = 0;
  __setReply(answer);
  const res = await cap.run(args);
  return { res, sent: __calls[0], count: __calls.length };
};

{
  const { sent } = await call({ action: 'list', series: 'x.y', value: 9, slot: 'zzz' });
  check('list asks the relay for the metrics tool', sent, { kind: 'metrics', toolId: 'tool-metrics', args: { action: 'list' } });
}
{
  const { sent } = await call({ action: 'read', series: 'sgx.dbs.price', value: '99' });
  check('read carries the series and a default limit', sent.args, { action: 'read', series: 'sgx.dbs.price', limit: 30 });
  check('and NEVER a value, so a read cannot become a write', 'value' in sent.args, false);
}
{
  const { sent } = await call({ action: 'read', series: 'a.b', limit: 5 });
  check('a requested limit is passed through', sent.args.limit, 5);
}
{
  const { sent } = await call({ action: 'write', series: 'sgx.dbs.price', value: 36.4, slot: '2026-11-09' });
  check('write carries value and slot', sent.args, { action: 'write', series: 'sgx.dbs.price', value: 36.4, slot: '2026-11-09' });
}
{
  const { sent } = await call({ action: 'write', series: 'a.b', value: 1, slot: '   ' });
  check('a blank slot is omitted, not sent as spaces', 'slot' in sent.args, false);
}
{
  const { sent } = await call({ action: 'write', series: 'a.b' });
  // Blank is the store's rule to enforce, not ours to pre-empt with 0 — but the
  // key must be present so the relay refuses it as a blank value.
  check('a missing value is still sent as blank, so the store refuses it', sent.args.value, '');
}
{
  const { res, count } = await call({ action: 'declare', series: 'a.b' });
  check('an unknown action is refused', res.ok, false);
  check('and the relay is never called for it', count, 0);
  checkTrue('the refusal lists the real actions', /list.*read.*write/.test(res.hint));
}

// ── 4. what comes back ─────────────────────────────────────────────────────
{
  const { res } = await call({ action: 'write', series: 'sgx.dbs.price', value: 36.4 }, {
    ok: true,
    result: 'Recorded 36.40 SGD for sgx.dbs.price.\n',
  });
  check('the summary is the relay’s first line', res.summary, 'Recorded 36.40 SGD for sgx.dbs.price.');
  check('the full text reaches the model', res.data.text.includes('sgx.dbs.price'), true);
}
{
  const long = 'x'.repeat(200);
  const { res } = await call({ action: 'list' }, { ok: true, result: `${long}\nsecond line` });
  checkTrue('an over-long summary is clipped to 96', res.summary.length <= 96);
  // The glasses render the summary verbatim, so a newline would push the rest of
  // the HUD off the canvas.
  check('and never contains a newline', /\n/.test(res.summary), false);
}
{
  const { res } = await call({ action: 'list' }, { ok: true, result: `${'y'.repeat(METRICS_TEXT_CHARS + 50)}` });
  checkTrue('an over-long answer is clipped for the model too', res.data.text.endsWith('[...clipped]'));
  checkTrue('and the clipping is stated, not silent', /clipped/.test(res.hint));
}
{
  const { res } = await call({ action: 'read', series: 'nope.none' }, {
    ok: false,
    result: 'unknown series — declare it first',
    error: 'unknown series',
  });
  check('a refusal is not a success', res.ok, false);
  check('the relay’s own sentence is passed through', res.data.text, 'unknown series — declare it first');
  checkTrue('and the hint forbids inventing one', /[Dd]o not invent/.test(res.hint));
}
{
  const { res } = await call({ action: 'list' }, { ok: false, result: '', error: 'metrics are not available on this relay' });
  checkTrue('a blank refusal still names the reason', /metrics are not available/.test(res.hint));
}
{
  // THE PRODUCTION SHAPE: the relay put the reason in `result` and left `error`
  // empty. The old code summarised that as "numbers unavailable" with an empty
  // error, so the glasses showed a box that said nothing. The summary must be
  // the reason, and data.error must not be blank.
  const { res } = await call(
    { action: 'write', series: 'psi.central', value: 60 },
    { ok: false, result: 'unknown series — declare it first (looked up "psi.central")' },
  );
  check('a refusal with no error field still reports', res.ok, false);
  checkTrue('the summary IS the reason, not "Unavailable"', /unknown series/.test(res.summary));
  checkTrue('and it is not the old placeholder', !/numbers unavailable/.test(res.summary));
  checkTrue('data.error is populated from the text', /unknown series/.test(res.data.error));
  checkTrue('and the hint repeats it', /unknown series/.test(res.hint));
}

// ── 5. is it actually reachable? (source invariants) ───────────────────────
const pages = readFileSync(resolve(here, '../src/ai/pages.ts'), 'utf8');
const agentSrc = readFileSync(resolve(here, '../src/ai/agent.ts'), 'utf8');
checkTrue('the registry imports it', /import \{ metricsCapabilities \} from '\.\/capabilities\/metrics'/.test(pages));
checkTrue('and registers it', /\.\.\.metricsCapabilities/.test(pages));
// The catalog advertises every global on EVERY turn, so an advertised global that
// the budget can drop is a turn where the model is told about a tool it lacks.
checkTrue('and the loop is told to keep it', /ALWAYS_AVAILABLE = \[[^\]]*'metrics\.act'/.test(agentSrc));

// every capability must be registered, or it is dead code with a schema
const registered = [...pages.matchAll(/\.\.\.(\w+Capabilities)/g)].map((m) => m[1]);
checkTrue('the metrics module is in that list', registered.includes('metricsCapabilities'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
