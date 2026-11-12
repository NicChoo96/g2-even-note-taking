#!/usr/bin/env node
// PLOT harness — the two rules a chart cannot get wrong, and the wiring that
// makes them reachable.
//
// WHY THIS EXISTS
//   The store's columns are DATA: a table has whatever a write inferred, so the
//   chart is configured rather than coded — an x column and a set of y columns.
//   Two things follow, and neither is visible in a screenshot:
//
//     1. ORDER. `records.read` hands rows back NEWEST FIRST, so a chart built
//        straight from `table.records` drew 2026 on the left and 2018 on the
//        right. A trend read backwards is a trend that does not exist.
//     2. ALIGNMENT. Comparing three tickers means three different timestamp sets.
//        The only honest chart is the union, ascending, with a GAP where a series
//        has no reading — joining the neighbours invents a value nobody recorded.
//
//   Both live in `src/web/chart-data.ts` as pure functions, so this harness drives
//   them directly and then reads the two components for the wiring that cannot be
//   a unit test.
//
// WHAT IS PINNED
//   A. a time axis is ascending, oldest first, whichever order the rows arrive in;
//   B. a category axis is one slot per distinct value, ordered, newest row wins;
//   C. rows that cannot be placed are COUNTED, never silently dropped;
//   D. multiple y columns are plotted together, blanks are nulls, not zeroes;
//   E. several series align on the union of their slots;
//   F. the wiring: one row set feeds the plot, the legend names every series, and
//      the break-on-null is in the renderer.
//
// Run: node tools/chart-plot-sim.mjs   (SIM_QUIET=1 prints only failures)

import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
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

const out = join(mkdtempSync(join(tmpdir(), 'g2-chartplot-')), 'plot.mjs');
await build({
  stdin: {
    contents: `export * from './web/chart-data.ts';`,
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
const P = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);

// ── fixtures: a table whose columns are whatever a write inferred ────────────
const FIELDS = [
  { key: 'launch_date', label: 'Launched', type: 'date', unit: '', precision: 0 },
  { key: 'estate', label: 'Estate', type: 'text', unit: '', precision: 0 },
  { key: 'flat_type', label: 'Flat', type: 'text', unit: '', precision: 0 },
  { key: 'price', label: 'Price', type: 'number', unit: 'SGD', precision: 0 },
  { key: 'psf', label: 'PSF', type: 'number', unit: 'SGD', precision: 2 },
];
const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
const row = (key, iso, estate, flat, price, psf) => ({
  key,
  ts: iso ? day(iso) : null,
  values: { launch_date: iso, estate, flat_type: flat, price, psf },
  createdAt: 0,
  updatedAt: 0,
});
// NEWEST FIRST, exactly as the store returns them.
const ROWS = [
  row('r-2026', '2026-11-09', 'Tengah', '4-room', 339000, 1120.5),
  row('r-2023b', '2023-10-15', 'Tengah', '5-room', 460000, 1080),
  row('r-2023a', '2023-10-15', 'Tengah', '4-room', 353000, 1040),
  row('r-2018', '2018-11-01', 'Tengah', '4-room', 290000, null),
  row('r-note', null, 'Tengah', '4-room', 0, 0),
];

// ── A. a time axis is ascending, whichever order the rows arrive in ──────────
const time = P.tableView(ROWS, FIELDS, 'launch_date', ['price']);
check('a dated table plots on a time axis', time.slots.kind, 'time');
check('the axis is ASCENDING, oldest first', time.slots.ts, [day('2018-11-01'), day('2023-10-15'), day('2023-10-15'), day('2026-11-09')]);
checkTrue('so the first slot is the OLDEST row', new Date(time.slots.ts[0]).getUTCFullYear() === 2018);
checkTrue('…and the last is the newest', new Date(time.slots.ts[3]).getUTCFullYear() === 2026);
check('the oldest row is the first value', time.series[0].values[0], 290000);
// Same-day rows are equal on the axis, so the sort is STABLE and they keep the
// order the store gave them: two launches on one day stay two bars, in a
// predictable order, rather than swapping places between renders.
check('the row behind each slot travels with it', time.rowKeys, ['r-2018', 'r-2023b', 'r-2023a', 'r-2026']);
check('same-day rows stay DISTINCT (two launches, two bars)', time.slots.ts.filter((t) => t === day('2023-10-15')).length, 2);
check('a row with no date cannot be placed, and is counted', time.droppedX, 1);

// ── B. a category axis is one slot per distinct value ───────────────────────
const cat = P.tableView(ROWS, FIELDS, 'flat_type', ['price']);
check('a text x column plots as categories', cat.slots.kind, 'category');
check('the categories are distinct and ordered', cat.slots.labels, ['4-room', '5-room']);
check('the NEWEST row wins for a repeated category', cat.series[0].values, [339000, 460000]);
// Five labelled rows, two distinct values: three were folded in.
check('the rows folded into a category are counted', cat.collapsed, 3);
check('…and nothing is dropped for having no date', cat.droppedX, 0);

// ── C. something unplaceable is always counted, never silently lost ────────
const blankX = P.tableView([{ ...ROWS[0], values: { ...ROWS[0].values, flat_type: '' } }], FIELDS, 'flat_type', ['price']);
check('a row with a blank x is counted, not plotted', [blankX.droppedX, blankX.slots.labels.length], [1, 0]);

// ── D. several y columns, blanks as null ───────────────────────────────────
check('two numeric columns both plot', time.series.length, 1);
const both = P.tableView(ROWS, FIELDS, 'launch_date', ['price', 'psf']);
check('choosing two columns plots two series', both.series.map((s) => s.key), ['price', 'psf']);
check('each keeps its own unit and precision', both.series.map((s) => `${s.unit}:${s.precision}`), ['SGD:0', 'SGD:2']);
check('a blank cell is NULL, not zero', both.series[1].values, [null, 1080, 1040, 1120.5]);
check('a text column cannot be plotted', P.tableView(ROWS, FIELDS, 'launch_date', ['estate']).series.length, 0);

// ── E. several series align on the union of their slots ────────────────────
const nvda = { key: 'nvda', label: 'NVDA', unit: 'USD', precision: 2, points: [
  { ts: day('2026-11-01'), value: 120 },
  { ts: day('2026-11-03'), value: 126 },
] };
const amd = { key: 'amd', label: 'AMD', unit: 'USD', precision: 2, points: [
  { ts: day('2026-11-02'), value: 140 },
  { ts: day('2026-11-03'), value: 145 },
] };
const aligned = P.alignSeries([nvda, amd]);
check('the union of the stamps is the axis', aligned.slots.ts, [day('2026-11-01'), day('2026-11-02'), day('2026-11-03')]);
check('…ascending', aligned.slots.ts[0] < aligned.slots.ts[2], true);
check('each series keeps its own name', aligned.series.map((s) => s.label), ['NVDA', 'AMD']);
check('a series with no reading there is NULL, not interpolated', aligned.series[0].values, [120, null, 126]);
check('…and the other one lines up on its own days', aligned.series[1].values, [null, 140, 145]);
check('a text series contributes nothing to a numeric plot', P.alignSeries([{ ...nvda, points: [{ ts: 1, value: 'n/a' }] }]).series[0].values, [null]);

// ── F. the window keeps one slot of context ───────────────────────────────
const wide = P.alignSeries([
  { key: 's', label: 's', unit: '', precision: 0, points: [1, 2, 3, 4, 5].map((d) => ({ ts: day(`2026-01-0${d}`), value: d })) },
]);
const cut = P.sliceWindow(wide.slots, wide.series, 2 * 86400e3);
// Two days of window, PLUS the slot before it as context: the line starts with a
// measured step instead of at a bare left edge.
check('a short window keeps the slot before it', cut.slots.ts.length, 4);
check('…so the line has a start, not a bare edge', cut.series[0].values, [2, 3, 4, 5]);
check('…and says where it started', cut.start, 1);
check('All is untouched', P.sliceWindow(wide.slots, wide.series, 'all').slots.ts.length, 5);

// ── G. sorting: one field, one order, shared by chart and table ─────────────
const byPriceDesc = P.sortRows(ROWS, FIELDS, { by: 'price', dir: 'desc' });
check('a numeric sort ranks the rows', byPriceDesc.map((r) => r.values.price), [460000, 353000, 339000, 290000, 0]);
const byPriceAsc = P.sortRows(ROWS, FIELDS, { by: 'price', dir: 'asc' });
check('…and reverses', byPriceAsc.map((r) => r.values.price), [0, 290000, 339000, 353000, 460000]);
const byDateDesc = P.sortRows(ROWS, FIELDS, { by: 'launch_date', dir: 'desc' });
check('a date sort uses the instant', byDateDesc[0].key, 'r-2026');
check('no sort leaves the rows exactly as they came', P.sortRows(ROWS, FIELDS, undefined), ROWS);
check(
  'a text sort is natural, not byte order',
  P.sortRows(
    [{ key: 'b', values: { flat_type: '10-room' } }, { key: 'a', values: { flat_type: '9-room' } }],
    FIELDS,
    { by: 'flat_type', dir: 'asc' },
  ).map((r) => r.key),
  ['a', 'b'],
);
const blank = P.sortRows(
  [{ key: 'blank', values: { price: null } }, { key: 'low', values: { price: 1 } }, { key: 'high', values: { price: 9 } }],
  FIELDS,
  { by: 'price', dir: 'desc' },
);
check('a blank sorts LAST, in either direction', blank.map((r) => r.key), ['high', 'low', 'blank']);

// Sorted by something other than x: the axis becomes categories in that order.
const ranked = P.tableView(byPriceDesc, FIELDS, 'flat_type', ['price'], { by: 'price', dir: 'desc' });
check('sorting by another field makes a CATEGORY axis (a time axis would zigzag)', ranked.slots.kind, 'category');
check('…and the labels are in the sorted order', ranked.slots.labels, ['5-room', '4-room']);
check('…carrying the top-ranked row of each', ranked.series[0].values, [460000, 353000]);
const timeDesc = P.tableView(P.sortRows(ROWS, FIELDS, { by: 'launch_date', dir: 'desc' }), FIELDS, 'launch_date', ['price'], { by: 'launch_date', dir: 'desc' });
check('sorting BY the x column keeps it a time axis', timeDesc.slots.kind, 'time');
check('…newest first when asked', timeDesc.series[0].values[0], 339000);

// ── H. the small rules ─────────────────────────────────────────────────────
check('the x column defaults to the first DATE column', P.pickXField(FIELDS), 'launch_date');
check('…or the first column when nothing is a date', P.pickXField(FIELDS.slice(1)), 'estate');
check('only numeric columns are offered to plot', P.plotFields(FIELDS).map((f) => f.key), ['price', 'psf']);
check('thousands separators are a number', P.numberOrNull('1,234.5'), 1234.5);
check('a blank is not zero', P.numberOrNull('  '), null);
check('a bare date is an instant', P.instantOf('2026-11-09'), day('2026-11-09'));

// ── H. the WIRING, which cannot be a unit test ──────────────────────────────
const panel = readFileSync(resolve(here, '../src/web/DataPanel.tsx'), 'utf8');
checkTrue(
  'the table plot is built from the ONE filtered row set',
  /const points = tableView\(ordered, table\.fields, xField, yFields, sortSpec\)/.test(panel) &&
    /const ordered = sortRows\(matching, table\.fields, sortSpec\)/.test(panel),
);
checkTrue(
  'the SORT is one field, chosen from a dropdown, and the table follows it',
  /className="md-sort"/.test(panel) && /aria-label="Sort by"/.test(panel) && /↓ Descending/.test(panel),
);
checkTrue('the x axis is a control, over every column', /title="Which column runs along the x axis"/.test(panel) && /table\.fields\.map\(\(f\) => \(\s*<option/.test(panel));
checkTrue('the plotted columns are multi-select', /aria-label="Which columns to plot"/.test(panel));
checkTrue('the chart is handed slots + series, not one column', /<PlotChart[\s\S]{0,200}slots=\{shownPlot\.slots\}[\s\S]{0,80}series=\{shownPlot\.series\}/.test(panel));
checkTrue('…and the x column is named under it', /xTitle=\{xInfo \? fieldTitle\(xInfo\) : xField\}/.test(panel));
checkTrue('two series can share the axis', /label="Compare"/.test(panel) && /view\.compare/.test(panel));
checkTrue(
  '…chosen from a dropdown, not a row of chips that grows with the store',
  /className="md-compare"/.test(panel) && /aria-label="Series to compare"/.test(panel),
);
checkTrue(
  'every dropdown closes on an outside tap and on Escape',
  /document\.addEventListener\('pointerdown', onDown, true\)/.test(panel) &&
    /e\.key === 'Escape'/.test(panel) &&
    /!el\.contains\(e\.target\)/.test(panel),
);
checkTrue(
  'a chip wraps, then truncates, instead of scrolling the row sideways',
  /md-chip-text/.test(panel) && /max-width: 150px/.test(readFileSync(resolve(here, '../src/web/styles.css'), 'utf8')),
);
checkTrue('the control groups are labelled', /md-controls-label/.test(panel) && />Plot</.test(panel) && />Window</.test(panel));
checkTrue('the picked columns and axis are remembered', /stored\.xField/.test(panel) && /stored\.yFields/.test(panel) && /stored\.compare/.test(panel));
checkTrue('what could not be placed is reported', /left out — nothing in/.test(panel) && /share a value already on the axis/.test(panel));
checkTrue(
  'columns orders apart are called out, not silently flattened',
  /const spread = scales\.length > 1/.test(panel) && /will read as a flat line/.test(panel),
);

const chart = readFileSync(resolve(here, '../src/web/metric-chart.tsx'), 'utf8');
checkTrue('the legend names every plotted series', /className="chart-legend"/.test(chart) && /s\.label/.test(chart));
checkTrue('each series gets its own colour class', /chart-series-\$\{si % 6\}/.test(chart));
checkTrue('a null BREAKS the line rather than joining it', /if \(v === null\) \{[\s\S]{0,80}run = \[\];[\s\S]{0,40}return;/.test(chart));
checkTrue('bars are grouped when several series share a slot', /band \* 0\.8[\s\S]{0,60}\/ viewSeries\.length/.test(chart));
checkTrue('the tooltip names every series at the touched slot', /viewSeries\.map\(\(s\) => \{[\s\S]{0,160}no reading/.test(chart));
checkTrue('a category axis labels itself from the cell text', /viewSlots\.kind === 'time' \? stamp\(viewSlots\.ts\[i\], timeSpan\) : clipLabel/.test(chart));
checkTrue(
  'a small category axis labels EVERY slot, not just its ends',
  /if \(viewSlots\.kind === 'category'\) \{[\s\S]{0,120}n <= 14\) return Array\.from/.test(chart),
);
checkTrue('a crowded axis thins to evenly-spaced ticks', /return evenlySpaced\(n, want\)/.test(chart));
checkTrue(
  'an axis spanning years prints the YEAR, so an ascending axis cannot look reversed',
  /span >= 300 \* 24 \* 3600e3\) return `\$\{d\.getMonth\(\) \+ 1\}\/\$\{d\.getDate\(\)\}\/\$\{year\}`/.test(chart),
);
checkTrue(
  'the chart measures its own box and is TALLER when narrow',
  /useChartBox\(\)/.test(chart) && /w < 520 \? 260 : 200/.test(chart),
);
checkTrue('the drawing can zoom and step without touching the data', /chart-zoom/.test(chart) && /setZoom/.test(chart) && /setOffset/.test(chart));

console.log(fail ? `\n${fail} FAILURE(S) of ${pass + fail}` : `\nALL PASS (${pass} assertions)`);
process.exit(fail ? 1 : 0);
