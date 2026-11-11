#!/usr/bin/env node
// RECORD VIEW harness — the filters and the time lens on a table.
//
// WHY THIS EXISTS
//   A table view has two lenses the wearer controls: which COLUMN VALUES the
//   chart is restricted to, and which span of time. Both are the kind of logic
//   that looks right in a screenshot and is wrong in a way nobody notices: a
//   filter that quietly matches nothing reads as an empty table, a date range
//   that is off by one day drops the row on the boundary, and a chart drawn from
//   unfiltered rows contradicts the list directly beneath it.
//
//   So the rules live in `src/web/record-view.ts` as pure functions and this
//   harness drives them directly. It also reads `DataPanel.tsx` for the wiring
//   that cannot be a unit test — the chart, the table and the counts must all
//   read from ONE filtered row set, or the two views disagree.
//
// WHAT IS PINNED
//   1. facets: the value list per column, commonest first, no blanks;
//   2. filters: multi-select, every column must match, an absent value excludes,
//      and an EMPTY selection means "no filter" rather than "no rows";
//   3. the range: inclusive on both ends, `to` covers its whole day, a row with
//      no date is outside any bounded range;
//   4. the labels: a chip says "All" / "4-room" / "4-room +2", and a range reads
//      back in dates a person can check;
//   5. the wiring in DataPanel: one `matching` row set feeds points, attributes
//      and the table body, and the lenses are remembered with the view.
//
// Run: node tools/record-view-sim.mjs   (SIM_QUIET=1 prints only failures)

import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const QUIET = !!process.env.SIM_QUIET;
let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (ok && QUIET) return;
  console.log(
    ok ? `PASS  ${label}` : `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`,
  );
}
const checkTrue = (label, got) => check(label, got === true, true);

const out = join(mkdtempSync(join(tmpdir(), 'g2-recview-')), 'view.mjs');
await build({
  stdin: {
    contents: `export * from './web/record-view.ts';`,
    resolveDir: resolve(here, '../src'),
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  define: { 'import.meta.env': '{}' },
});
const V = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);

// ── fixtures: the Tengah table shape, trimmed ───────────────────────────────
const FIELDS = [
  { key: 'launch_date', label: 'launch_date', type: 'date', unit: '', precision: 0 },
  { key: 'estate', label: 'estate', type: 'text', unit: '', precision: 0 },
  { key: 'projects', label: 'projects', type: 'text', unit: '', precision: 0 },
  { key: 'flat_type', label: 'flat_type', type: 'text', unit: '', precision: 0 },
  { key: 'price_sgd', label: 'price_sgd', type: 'number', unit: 'SGD', precision: 0 },
];
const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
const row = (key, iso, estate, project, flat, price) => ({
  key,
  ts: iso ? day(iso) : null,
  values: { launch_date: iso, estate, projects: project, flat_type: flat, price_sgd: price },
  createdAt: 0,
  updatedAt: 0,
});
const ROWS = [
  row('2026-11-4', '2026-11-09', 'Tengah', 'Plantation Dew', '4-room', 339000),
  row('2026-11-5', '2026-11-09', 'Tengah', 'Plantation Dew', '5-room', 494000),
  row('2023-10-4', '2023-10-15', 'Tengah', 'Plantation Edge I & II', '4-room', 353000),
  row('2023-10-5', '2023-10-15', 'Tengah', 'Plantation Edge I & II', '5-room', 460000),
  row('2023-02-4', '2023-02-15', 'Tengah', 'Brickland Weave', '4-room', 291000),
  // A row with no date at all: legal in this store, invisible on any axis.
  row('manual-note', null, 'Tengah', 'Brickland Weave', '4-room', 0),
];

const field = (key) => FIELDS.find((f) => f.key === key);

// ── 1. facets ───────────────────────────────────────────────────────────────
check(
  'a column lists its values, commonest first',
  V.facets(ROWS, field('flat_type')).map((o) => `${o.value}:${o.count}`),
  ['4-room:4', '5-room:2'],
);
checkTrue('blank cells are not a value', V.facets(ROWS, field('estate')).length === 1);
const boolField = { key: 'done', label: 'done', type: 'bool', unit: '', precision: 0 };
check(
  'a bool column reads as yes/no',
  // Equal counts tie, and the tie is broken alphabetically so the order is
  // stable between renders.
  V.facets([{ ...ROWS[0], values: { done: true } }, { ...ROWS[1], values: { done: false } }], boolField).map(
    (o) => o.value,
  ),
  ['no', 'yes'],
);
check(
  'a single-value column is not worth a menu',
  V.filterableFields(ROWS, FIELDS).map((f) => f.key),
  ['projects', 'flat_type'],
);
checkTrue('dates are narrowed by the range pair, not by a menu', V.isFilterable(field('launch_date')) === false);
checkTrue('numbers are charted, not filtered', V.isFilterable(field('price_sgd')) === false);

// ── 2. filters ──────────────────────────────────────────────────────────────
check(
  'one value narrows to its rows',
  V.applyFilters(ROWS, { flat_type: ['5-room'] }).map((r) => r.key),
  ['2026-11-5', '2023-10-5'],
);
check(
  'several values are a union inside one column',
  V.applyFilters(ROWS, { flat_type: ['4-room', '5-room'] }).length,
  6,
);
check(
  'two columns must BOTH match',
  V.applyFilters(ROWS, { flat_type: ['4-room'], projects: ['Brickland Weave'] }).map((r) => r.key),
  ['2023-02-4', 'manual-note'],
);
check('an empty selection is not a filter', V.applyFilters(ROWS, { flat_type: [] }).length, 6);
checkTrue('…even when it is the only entry', V.applyFilters(ROWS, { flat_type: [] }).length === ROWS.length);
check('no filters at all keeps everything', V.applyFilters(ROWS, undefined).length, 6);
check(
  'a row with no value for a restricted column is excluded',
  V.applyFilters([{ ...ROWS[0], values: { price_sgd: 1 } }], { flat_type: ['4-room'] }).length,
  0,
);
check('a filter that matches nothing is honestly empty', V.applyFilters(ROWS, { flat_type: ['6-room'] }).length, 0);
check('the empty filter object is dropped from the count', V.filterCount({ flat_type: [], estate: ['Tengah'] }), 1);

// ── 3. the range ────────────────────────────────────────────────────────────
check('both ends are inclusive', V.applyRange(ROWS, { from: day('2023-10-15'), to: day('2023-10-15') }).length, 2);
check(
  'the start of the day is inside',
  V.applyRange(ROWS, { from: day('2026-11-09') }).map((r) => r.key),
  ['2026-11-4', '2026-11-5'],
);
check('an open-ended range from a date keeps everything after it', V.applyRange(ROWS, { from: day('2023-10-16') }).length, 2);
check('…and up to a date keeps everything before it', V.applyRange(ROWS, { to: day('2023-02-15') }).length, 1);
check('a row with no date is outside a bounded range', V.applyRange(ROWS, { from: day('2000-01-01') }).length, 5);
check('an unbounded range keeps it', V.applyRange(ROWS, {}).length, 6);
check('no range keeps everything', V.applyRange(ROWS, undefined).length, 6);

// The `to` input covers its whole DAY — a range ending "today" must include a
// row recorded at 23:59 today, which is the off-by-one everyone ships once.
const endOfDay = V.rangeFromInputs('2026-11-09', '2026-11-09');
checkTrue('a one-day range includes that whole day', endOfDay.from <= day('2026-11-09') && endOfDay.to >= day('2026-11-09') + 86_399_999);
check('…and it selects exactly that day', V.applyRange(ROWS, endOfDay).length, 2);
check('from only', V.rangeFromInputs('2026-11-09', ''), { from: day('2026-11-09') });
check('to only', V.rangeFromInputs('', '2023-02-15'), { to: day('2023-02-15') + 86_399_999 });
check('neither is no range', V.rangeFromInputs('', ''), undefined);
// An impossible date must not silently become 2 March.
check('31 February is refused, not rolled over', V.parseDateInput('2023-02-31'), null);
check('a date input round-trips', V.toDateInput(day('2023-10-15')), '2023-10-15');
check('an unset end renders empty', V.toDateInput(undefined), '');

// ── 4. the labels ───────────────────────────────────────────────────────────
check('an unfiltered column says All', V.filterLabel({}, field('flat_type')), 'All');
check('one value is named', V.filterLabel({ flat_type: ['4-room'] }, field('flat_type')), '4-room');
check('several are counted', V.filterLabel({ flat_type: ['4-room', '5-room'] }, field('flat_type')), '4-room +1');
check('a range reads as dates', V.rangeLabel({ from: day('2023-10-15'), to: day('2026-11-09') }), '2023-10-15 to 2026-11-09');
check('an open start says from', V.rangeLabel({ to: day('2026-11-09') }), 'to 2026-11-09');
check('no range is empty', V.rangeLabel(undefined), '');
check('an inferred column gets a readable heading', V.fieldTitle({ key: 'price_sgd', label: 'price_sgd', type: 'number' }), 'Price sgd');
check("a human's label is left alone", V.fieldTitle({ key: 'price_sgd', label: 'Price', type: 'number' }), 'Price');

// ── 5. the wiring inside the panel ──────────────────────────────────────────
const panel = readFileSync(resolve(here, '../src/web/DataPanel.tsx'), 'utf8');
checkTrue(
  'the chart, the tooltip and the table all read ONE filtered row set',
  /const matching = applyRange\(applyFilters\(table\.records, filters\), range\)/.test(panel) &&
    /const points = tableView\(matching, table\.fields, xField, yFields\)/.test(panel) &&
    /for \(const r of matching\)/.test(panel) &&
    /\{matching\.map\(\(row\) =>/.test(panel),
);
checkTrue('the table body no longer reads the raw rows', !/\{table\.records\.map\(\(row\)/.test(panel));
checkTrue(
  'a filter is a per-column menu fed by the UNFILTERED rows',
  /rows=\{table\.records\}/.test(panel) && /facets\(rows, field\)/.test(panel),
);
checkTrue(
  'the option list is searchable and capped',
  /placeholder=\{`Search \$\{fieldTitle\(field\)\.toLowerCase\(\)\}`\}/.test(panel) && /shown\.slice\(0, 40\)/.test(panel),
);
checkTrue(
  'an explicit range replaces the presets rather than stacking with them',
  /const activeWindow = range \? 'all' :/.test(panel),
);
checkTrue('the lenses are part of the remembered view', /stored\.filters && Object\.keys\(stored\.filters\)\.length/.test(panel) && /stored\.range \? \{ range: stored\.range \}/.test(panel));
checkTrue(
  'an empty result says it is the FILTERS, and offers a way out',
  /No row matches these filters/.test(panel) && /const clearLenses = /.test(panel),
);
checkTrue(
  'the count says how many of the rows survived',
  /\{matching\.length\} of \{table\.records\.length\} rows/.test(panel),
);

console.log(fail ? `\n${fail} FAILURE(S) of ${pass + fail}` : `\nALL PASS (${pass} assertions)`);
process.exit(fail ? 1 : 0);
