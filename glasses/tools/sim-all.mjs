#!/usr/bin/env node
// Run every `*-sim.mjs` harness and judge each one on its EXIT CODE.
//
// WHY THE EXIT CODE AND NOT THE TEXT:
//   The harnesses do not share a verdict dialect. Some print `ALL PASS`, some
//   `ALL CHECKS PASSED`, some `RESULT: PASS`, and `segment-sim.mjs` is
//   report-only with no verdict line at all. Grepping for a phrase silently
//   turns a failing harness into a passing one the moment its wording changes.
//   Exit codes are the only contract every harness honours.
//
// Usage:
//   node tools/sim-all.mjs            # run everything
//   node tools/sim-all.mjs ledger web # run only harnesses whose name matches

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);

// NOT self-contained harnesses — these need an input we do not have, so running
// them bare would report a crash as a regression. Excluded explicitly, with the
// reason, rather than by a naming convention that would hide a real harness.
const NEEDS_INPUT = {
  'segment-sim.mjs': 'takes a 16k mono s16 WAV path as argv[2] (a hand-run analysis tool)',
};

const harnesses = readdirSync(here)
  .filter((f) => f.endsWith('-sim.mjs'))
  .filter((f) => !(f in NEEDS_INPUT))
  .filter((f) => (filters.length ? filters.some((x) => f.includes(x)) : true))
  .sort();

if (!harnesses.length) {
  console.log('no harnesses matched');
  process.exit(1);
}

const rows = [];
for (const file of harnesses) {
  const run = spawnSync(process.execPath, [resolve(here, file)], {
    cwd: resolve(here, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const status = run.status ?? 1;

  // Each harness has its own phrasing. Match the PASS dialects before the FAIL
  // ones, and never infer a count from a passing line: "57 passed, 0 failed"
  // contains the word `failed` and would otherwise be reported as "(0)".
  let verdict = 'NO VERDICT LINE';
  let detail = '';
  if (/ALL PASS/.test(out)) verdict = 'ALL PASS';
  else if (/ALL CHECKS PASSED/.test(out)) verdict = 'ALL CHECKS PASSED';
  else if (/RESULT: PASS/.test(out)) verdict = 'RESULT: PASS';
  else if (/\d+ passed, \d+ failed/.test(out)) verdict = (out.match(/(\d+) passed, (\d+) failed/) ?? [])[0] ?? 'N passed, M failed';
  else {
    const bad = out.match(/(\d+)\s+(?:assertion\(s\)\s+)?(?:FAILURE\(S\)|CHECK\(S\) FAILED|failed)/i);
    if (bad || /RESULT: FAIL/.test(out)) {
      verdict = 'REPORTED FAILURES';
      detail = bad ? bad[1] : '';
    }
  }

  const tail = out.trimEnd().split('\n').slice(-1)[0] ?? '';
  rows.push({ file, status, verdict, detail, tail });
}

const width = Math.max(...rows.map((r) => r.file.length));
console.log('harness'.padEnd(width), '  exit  verdict');
console.log('-'.repeat(width + 24));
for (const r of rows) {
  console.log(r.file.padEnd(width), `  ${String(r.status).padStart(4)}  ${r.verdict}${r.detail ? ` (${r.detail})` : ''}`);
}

const bad = rows.filter((r) => r.status !== 0);
const suspect = rows.filter((r) => r.status === 0 && r.verdict === 'NO VERDICT LINE');
console.log(`\n${rows.length - bad.length}/${rows.length} passed`);
if (bad.length) {
  console.log('\nfailing:');
  for (const r of bad) console.log(`  ${r.file}  ->  ${r.tail}`);
}
if (suspect.length) {
  console.log(`\nno verdict line (exit 0, so treated as pass — check these are report-only): ${suspect.map((r) => r.file).join(', ')}`);
}
const skipped = Object.keys(NEEDS_INPUT);
if (skipped.length) {
  console.log(`\nskipped (need input): ${skipped.map((f) => `${f} — ${NEEDS_INPUT[f]}`).join('; ')}`);
}
// `process.exit()` here would discard the report: when stdout is a pipe (a
// redirect, or a parent capturing it) `console.log` is asynchronous, so exiting
// immediately races the flush and the whole report vanishes. Set the code and
// let the process drain.
process.exitCode = bad.length ? 1 : 0;
