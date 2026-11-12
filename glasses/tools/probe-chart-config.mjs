#!/usr/bin/env node
// PROBE — is the Data tab's chart area actually usable, on a phone and on a
// desktop, against the real component and the real stylesheet?
//
// WHY THIS EXISTS
//   The store's columns are data, so the chart is configured rather than coded —
//   an x column, a set of y columns, an optional set of compared series, a zoom and
//   a filter row. Every one of those is a geometry question as much as a logic
//   question: a 640x200 viewBox squeezed into a phone is a 110px chart with 5px
//   text, a dropdown that cannot be dismissed traps the page, a chip row that never
//   wraps scrolls the layout sideways, and a category axis that prints two of four
//   labels hides its own subject. None of that is visible to a unit test on the
//   pure helpers, which is why `chart-plot-sim.mjs` covers the rules and this
//   covers the pixels and the taps.
//
// WHAT IT MEASURES
//   1. the chart opens with the numeric columns plotted, and a legend names them;
//   2. COMPARE is a dropdown: it opens, it selects, and it closes on an outside tap;
//   3. ticking a second column adds a legend entry, and a mixed-scale pair is called
//      out rather than silently flattened;
//   4. changing the x select to a text column turns the axis into categories — and
//      EVERY category is labelled when there are few;
//   5. a date axis is ASCENDING (the first slot's tooltip is the oldest row);
//   6. the FILTER dropdowns close on an outside tap too;
//   7. zoom steps the drawing in, reports its window, and resets;
//   8. at 390px the page does not overflow sideways and the plot is TALL (a scaled
//      down desktop chart was the "small chart" complaint), and at 1440px it reads.
//
// WHAT IT IS NOT
//   The real DataPanel with a stubbed fetch, not a signed-in app. The data is a
//   fixture; the component, the reducers and the CSS are shipped code.
//
// Run: node tools/probe-chart-config.mjs   (after `npm run build:deploy`)

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

const req = createRequire(resolve(repo, 'scripts/package.json'));
const { chromium } = req('playwright');

let pass = 0;
const failures = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : failures.push(label);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`,
  );
};
const checkTrue = (label, got) => check(label, got === true, true);

function builtCss() {
  const dir = resolve(here, '../dist/assets');
  if (!existsSync(dir)) throw new Error('no glasses/dist — run `npm run build:deploy` first');
  const file = readdirSync(dir).filter((f) => f.endsWith('.css')).sort().pop();
  return readFileSync(join(dir, file), 'utf8');
}

function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const found = [];
  for (const base of [`${process.env.LOCALAPPDATA}/ms-playwright`, `${process.env.HOME}/.cache/ms-playwright`].filter(Boolean)) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      if (!entry.startsWith('chromium-')) continue;
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
        const p = resolve(base, entry, rel);
        if (existsSync(p)) found.push({ p, rev: Number(entry.split('-')[1]) || 0 });
      }
    }
  }
  found.sort((a, b) => b.rev - a.rev);
  return found.length ? found[0].p : undefined;
}

const outDir = resolve(here, '.tmp-chart-config');
mkdirSync(outDir, { recursive: true });
const bundlePath = join(outDir, 'panel.js');

await build({
  stdin: {
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DataPanel } from './web/DataPanel.tsx';

const ts = (iso) => Date.parse(iso + 'T00:00:00Z');

// THE FIXTURE: two tickers (so compare has something to compare) and a table whose
// columns are data — a date, a label, TWO numbers, and FOUR distinct flat types
// with two repeats, which is what the category axis has to label honestly.
const metrics = {
  ok: true,
  series: [
    { key: 'nvda.price', label: 'NVDA price', type: 'number', unit: 'USD', precision: 2, cadence: 'daily',
      source: 'agent', retention: 2000, count: 3, latest: { ts: ts('2026-11-03'), value: 126 }, delta: 6,
      view: 'series', provenance: 'fixture',
      points: [{ ts: ts('2026-11-01'), value: 120 }, { ts: ts('2026-11-02'), value: 123 }, { ts: ts('2026-11-03'), value: 126 }] },
    { key: 'amd.price', label: 'AMD price', type: 'number', unit: 'USD', precision: 2, cadence: 'daily',
      source: 'agent', retention: 2000, count: 2, latest: { ts: ts('2026-11-03'), value: 145 }, delta: 5,
      view: 'series', provenance: 'fixture',
      points: [{ ts: ts('2026-11-02'), value: 140 }, { ts: ts('2026-11-03'), value: 145 }] },
  ],
  collectors: [],
  updatedAt: Date.now(),
  now: Date.now(),
  store: { mode: 'hub', durable: true },
};

// NEWEST FIRST, exactly as the store hands them back — the order that used to
// draw the axis backwards.
const row = (key, iso, flat, price, psf) => ({
  key, ts: ts(iso),
  values: { launch_date: iso, flat_type: flat, price, psf },
  createdAt: 0, updatedAt: 0,
});
const records = {
  ok: true,
  objects: [{
    key: 'tengah.bto',
    label: 'Tengah BTO',
    strict: false,
    fields: [
      { key: 'launch_date', label: 'Launch date', type: 'date', unit: '', precision: 0 },
      { key: 'flat_type', label: 'Flat type', type: 'text', unit: '', precision: 0 },
      { key: 'price', label: 'Price', type: 'number', unit: 'SGD', precision: 0 },
      { key: 'psf', label: 'PSF', type: 'number', unit: 'SGD', precision: 2 },
    ],
    count: 6,
    latestTs: ts('2026-11-09'),
    records: [
      row('r-2026', '2026-11-09', '4-room', 339000, 1120.5),
      row('r-2025', '2025-06-01', '5-room', 460000, 1080),
      row('r-2023', '2023-10-15', '5-room', 440000, 1050),
      row('r-2022', '2022-02-15', '3-room', 228000, 940),
      row('r-2019', '2019-05-10', '2-room', 130000, 700),
      row('r-2018', '2018-11-01', '4-room', 290000, 880),
    ],
    total: 6,
  }, {
    // THE REPORTED CARD: nine columns with long names, which used to set the card's
    // width and stretch the strip into a sideways scroll.
    key: 'coe.exercise',
    label: 'coe.exercise',
    strict: false,
    fields: [
      { key: 'exercise_date', label: 'exercise_date', type: 'date', unit: '', precision: 0 },
      { key: 'exercise_category', label: 'exercise_category', type: 'text', unit: '', precision: 0 },
      { key: 'quota_premium_sgd', label: 'quota_premium_sgd', type: 'number', unit: 'SGD', precision: 0 },
      { key: 'previous_premium_sgd', label: 'previous_premium_sgd', type: 'number', unit: 'SGD', precision: 0 },
      { key: 'change_sgd', label: 'change_sgd', type: 'number', unit: 'SGD', precision: 0 },
      { key: 'quota_bids_required', label: 'quota_bids_required', type: 'number', unit: '', precision: 0 },
      { key: 'bids_received', label: 'bids_received', type: 'number', unit: '', precision: 0 },
      { key: 'quota_available', label: 'quota_available', type: 'number', unit: '', precision: 0 },
      { key: 'source_note', label: 'source_note', type: 'text', unit: '', precision: 0 },
    ],
    count: 5,
    latestTs: ts('2026-11-09'),
    records: [{
      key: 'coe-1',
      ts: ts('2026-11-09'),
      values: { exercise_date: '2026-11-09', exercise_category: 'Cat A', quota_premium_sgd: 98000 },
      createdAt: 0,
      updatedAt: 0,
    }],
    total: 5,
  }],
  now: Date.now(),
  store: { mode: 'hub', durable: true },
};

// The two reads the Data tab makes, and nothing else.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path.includes('/api/metrics')) return new Response(JSON.stringify(metrics), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path.includes('/api/records')) return new Response(JSON.stringify(records), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return realFetch(url, init);
};

createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'app app-wide app-data' },
    React.createElement('main', { className: 'content card' }, React.createElement(DataPanel))),
);
`,
    resolveDir: resolve(here, '../src'),
    loader: 'tsx',
    sourcefile: 'panel-mount.tsx',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  outfile: bundlePath,
  logLevel: 'silent',
});

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${builtCss()}</style>
<style>body{margin:0;background:#12141a;padding:20px}</style></head>
<body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`;

const shot = resolve(repo, '.tmp-e2e/chart-config');
mkdirSync(shot, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForSelector('.metric-chart');

  // The legend's text is the series name followed by its unit in a <span>; compare
  // the NAMES, not the concatenation.
  const legend = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.chart-legend li')].map((li) =>
        [...li.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join('')
          .trim(),
      ),
    );
  // SVG nodes have no innerText; `textContent` is what a chart label has.
  const xTicks = async () =>
    page.evaluate(() => [...document.querySelectorAll('.chart-x-tick')].map((t) => (t.textContent ?? '').trim()));
  const tooltip = () => page.evaluate(() => document.querySelector('.chart-tip')?.textContent ?? '');
  const panels = () => page.locator('.dp-menu-panel').count();
  /** A tap in the page margin — outside every panel. */
  const tapOutside = async () => {
    await page.mouse.click(4, 4);
    await page.waitForTimeout(80);
  };

  // ── 1. the series view: one line ─────────────────────────────────────────
  check('a series opens as one plotted line', await legend(), ['NVDA price']);

  // ── 2. COMPARE is a dropdown, and it dismisses ───────────────────────────
  await page.locator('.md-compare .dp-menu-btn').click();
  checkTrue('the compare control opens a dropdown', (await panels()) === 1);
  await tapOutside();
  check('…and a tap outside closes it', await panels(), 0);

  await page.locator('.md-compare .dp-menu-btn').click();
  await page.locator('.dp-menu-opt:has-text("AMD price") input').check();
  check('comparing adds a second line to the same axis', await legend(), ['NVDA price', 'AMD price']);
  await tapOutside();
  checkTrue(
    'each line has its own colour class',
    (await page.evaluate(
      () =>
        new Set(
          [...document.querySelectorAll('.chart-line')].map((l) => [...l.classList].find((c) => c.startsWith('chart-series-'))),
        ).size,
    )) === 2,
  );
  await page.screenshot({ path: join(shot, 'desktop-compare.png') });

  // ── 3/4. the table: columns, axis, categories ───────────────────────────
  await page.locator('.metric-master-row:has-text("Tengah BTO")').first().click();
  await page.waitForFunction(() => /Price/.test(document.querySelector('.chart-legend')?.textContent ?? ''));
  check('the table plots its first numeric column', await legend(), ['Price']);

  const options = await page.locator('.md-xaxis select option').allInnerTexts();
  checkTrue('the x picker offers every column', options.length === 4 && options.some((o) => /Launch date/.test(o)));

  // A DATE axis, ascending: the FIRST slot must be the OLDEST row. The axis text
  // cannot prove that (`11/1` is any year), so the tooltip answers it.
  await page.locator('.chart-hit').first().click();
  const firstTip = await tooltip();
  console.log(`        first slot: ${firstTip}`);
  checkTrue('a date axis is ASCENDING — the first slot is the OLDEST row', /2018-11-01/.test(firstTip));
  checkTrue('…and the first slot holds that row’s value', /290,000/.test(firstTip));

  // Tick the second numeric column: two series, one shared legend.
  await page.locator('.md-seg[aria-label="Which columns to plot"] button:has-text("PSF")').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.chart-legend li').length === 2);
  check('ticking a column adds it to the same chart', await legend(), ['Price', 'PSF']);
  checkTrue(
    'a mixed-scale pair is called out rather than silently flattened',
    /apart, so PSF will read as a flat line/.test(await page.locator('.data-panel').innerText()),
  );
  await page.screenshot({ path: join(shot, 'desktop-two-columns.png') });

  // The x axis becomes CATEGORIES when the chosen column is text.
  await page.locator('.md-xaxis select').selectOption('flat_type');
  await page.waitForFunction(() => document.querySelectorAll('.chart-x-tick').length > 2);
  const catTicks = await xTicks();
  console.log(`        category axis: ${catTicks.join('  ') || '(none)'}`);
  check('every category is labelled when there are few', [...catTicks].sort(), ['2-room', '3-room', '4-room', '5-room']);
  checkTrue('…and says which column it is', /Flat type/.test(await page.locator('.chart-x-title').innerText()));
  await page.screenshot({ path: join(shot, 'desktop-categories.png') });

  // ── 4b. SORT: a field, a direction, and the rows follow ──────────────────
  await page.locator('.md-sort .dp-menu-btn').click();
  const panelBg = await page.evaluate(() => {
    const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
    return { panel: bg('.dp-menu-panel'), card: bg('.metric-detail') };
  });
  console.log(`        dropdown surface: ${panelBg.panel} over card ${panelBg.card}`);
  checkTrue('the dropdown surface is a LAYER, not the card colour', panelBg.panel !== panelBg.card);

  // The option under the pointer must react, or a list of values has no affordance.
  // Measured on an UNSELECTED row: a checked one is already highlighted, so a
  // hover on it proves nothing.
  const plainOpt = page.locator('.md-sort .dp-menu-opt:has-text("PSF")');
  const beforeHover = await plainOpt.evaluate((el) => getComputedStyle(el).backgroundColor);
  await plainOpt.hover();
  await page.waitForTimeout(80);
  const afterHover = await plainOpt.evaluate((el) => getComputedStyle(el).backgroundColor);
  checkTrue('an option highlights on hover', beforeHover !== afterHover);
  await page.screenshot({ path: join(shot, 'desktop-dropdown.png') });

  await page.locator('.md-sort .dp-menu-opt:has-text("Price") input').check();
  await page.locator('.dp-sort-dir button:has-text("Descending")').click();
  await tapOutside();
  checkTrue(
    'the sort control names the field and the direction',
    /Price/.test(await page.locator('.md-sort .dp-menu-value').innerText()) &&
      /↓/.test(await page.locator('.md-sort .dp-menu-value').innerText()),
  );
  await page.waitForTimeout(120);
  const sortedTicks = await xTicks();
  console.log(`        sorted axis: ${sortedTicks.join('  ')}`);
  check('sorting by price DESC reorders the axis (5-room first)', sortedTicks.slice(0, 2), ['5-room', '4-room']);
  checkTrue(
    '…and the table follows the same order',
    /460,000/.test((await page.locator('.record-table tbody tr').first().innerText()) ?? ''),
  );
  await page.screenshot({ path: join(shot, 'desktop-sorted.png') });

  // Back to automatic, and to a date axis: the labels must carry the YEAR, or an
  // ascending axis of 11/15, 8/15, 2/15 reads as broken.
  await page.locator('.md-sort .dp-menu-btn').click();
  await page.locator('.md-sort .dp-menu-opt:has-text("Automatic") input').check();
  await tapOutside();
  await page.locator('.md-xaxis select').selectOption('launch_date');
  await page.waitForTimeout(120);
  const yearTicks = await xTicks();
  console.log(`        date axis: ${yearTicks.join('  ')}`);
  checkTrue('a multi-year date axis prints the year', yearTicks.some((t) => /\/\d{2}$/.test(t)));
  const yearOrder = yearTicks.map((t) => Number(/(\d{2})$/.exec(t)?.[1] ?? 0));
  checkTrue('…so the axis reads oldest to newest', yearOrder.every((y, i) => i === 0 || y >= yearOrder[i - 1]));

  // ── 5. the FILTER dropdowns dismiss too ─────────────────────────────────
  const filterBtn = page.locator('.rec-filters .dp-menu-btn').first();
  if ((await filterBtn.count()) > 0) {
    await filterBtn.click();
    checkTrue('a filter opens a dropdown', (await panels()) === 1);
    await tapOutside();
    check('…and a tap outside closes it', await panels(), 0);
  }

  // ── 6. zoom ─────────────────────────────────────────────────────────────
  const zoomIn = page.locator('.chart-zoom button[aria-label="Zoom in"]');
  const countText = () => page.locator('.chart-toolbar-count').innerText();
  const before = await countText();
  // The total is whatever this axis holds — four categories here, not six rows.
  const total = Number(/(\d+)/.exec(before)?.[1] ?? 0);
  await zoomIn.click();
  await page.waitForTimeout(100);
  const zoomed = await countText();
  console.log(`        zoom: ${before} -> ${zoomed}`);
  checkTrue(`zooming in reports a window of the ${total} readings`, new RegExp(`of ${total}$`).test(zoomed) && zoomed !== before);
  checkTrue('…and the axis label count shrinks with it', (await xTicks()).length <= catTicks.length);
  await page.screenshot({ path: join(shot, 'desktop-zoom.png') });
  await page.locator('.chart-zoom-reset').click();
  await page.waitForTimeout(100);
  check('Reset returns to the whole chart', await countText(), `${total} points`);

  // ── 7. the phone ────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('nothing overflows sideways at 390px', overflow <= 0, true);
  const svgBox = await page.locator('svg.metric-chart').boundingBox();
  const widths = await page.evaluate(() => {
    const w = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? 0);
    return { viewport: window.innerWidth, pane: w('.metric-detail'), wrap: w('.chart-wrap'), svg: w('svg.metric-chart') };
  });
  console.log(`        phone widths: ${JSON.stringify(widths)}`);
  console.log(`        phone plot: ${Math.round(svgBox.width)}x${Math.round(svgBox.height)}`);
  checkTrue('the plot is TALL on a phone, not a scaled-down desktop chart', svgBox.height >= 200);
  const selectBox = await page.locator('.md-xaxis select').boundingBox();
  check('the x picker is on screen and usable at 390px', Boolean(selectBox && selectBox.width > 40), true);
  check('the legend still names both series at 390px', (await legend()).length, 2);
  const yTicks = await page.evaluate(() =>
    [...document.querySelectorAll('svg.metric-chart text.chart-tick')]
      .map((t) => (t.textContent ?? '').trim())
      .filter((t) => /^[-\d.,]+[km]?$/.test(t)),
  );
  console.log(`        phone y labels: ${yTicks.join(' / ')}`);
  checkTrue('the y axis is compacted on a phone, not 460,000.00', yTicks.some((t) => /k$|m$/.test(t)));

  // ── 8. the master strip: ONE width per card, truncated detail ────────────
  const cards = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.metric-master-row')];
    const coe = rows.find((r) => /coe\.exercise/.test(r.textContent ?? ''));
    const cols = coe?.querySelector('.mm-table-cols');
    return {
      widths: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().width)))],
      colsTruncated: cols ? cols.scrollWidth > cols.clientWidth + 1 : false,
    };
  });
  console.log(`        card widths: ${JSON.stringify(cards)}`);
  check('every card in the strip is the same width', cards.widths.length, 1);
  checkTrue('a nine-column table truncates its column list instead of widening its card', cards.colsTruncated);
  await page.screenshot({ path: join(shot, 'phone-categories.png'), fullPage: true });
} finally {
  await browser.close();
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('ALL CHECKS PASSED  (screenshots: .tmp-e2e/chart-config/)');
}
