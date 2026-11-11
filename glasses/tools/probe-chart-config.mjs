#!/usr/bin/env node
// PROBE — can a chart be CONFIGURED, on a phone and on a desktop, against the
// real component and the real stylesheet?
//
// WHY THIS EXISTS
//   The store's columns are data, so the chart is not coded: the wearer picks the
//   x column and which columns to plot, and may compare several series on one
//   axis. Every one of those is a geometry question as much as a logic question —
//   a select that pushes a 390px page sideways, a legend that never appears, an
//   axis that reads newest-to-oldest are all invisible to a unit test on the pure
//   helpers, which is why `chart-plot-sim.mjs` covers the rules and this covers
//   the pixels.
//
// WHAT IT MEASURES
//   1. the chart opens with the numeric columns plotted, and a legend names them;
//   2. ticking a second column ADDS a legend entry (multi-series, one axis);
//   3. changing the x select to a text column turns the axis into categories;
//   4. a date axis is ASCENDING — the leftmost label is the oldest row;
//   5. the compare chips put a second SERIES on the same axis;
//   6. at 390px nothing overflows sideways, and at 1440px it still reads.
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

const day = 86_400_000;
const ts = (iso) => Date.parse(iso + 'T00:00:00Z');

// THE FIXTURE: a series store with two tickers (so compare has something to
// compare), and a table whose columns are data — a date, two labels and TWO
// numbers, which is the shape that needs a column picker.
const metrics = {
  ok: true,
  series: [
    { key: 'nvda.price', label: 'NVDA price', type: 'number', unit: 'USD', precision: 2, cadence: 'daily',
      source: 'agent', retention: 2000, count: 2, latest: { ts: ts('2026-11-03'), value: 126 }, delta: 6,
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
    key: 'tengah.bto.4room',
    label: 'Tengah BTO',
    strict: false,
    fields: [
      { key: 'launch_date', label: 'Launch date', type: 'date', unit: '', precision: 0 },
      { key: 'flat_type', label: 'Flat type', type: 'text', unit: '', precision: 0 },
      { key: 'price', label: 'Price', type: 'number', unit: 'SGD', precision: 0 },
      { key: 'psf', label: 'PSF', type: 'number', unit: 'SGD', precision: 2 },
    ],
    count: 4,
    latestTs: ts('2026-11-09'),
    records: [
      row('r-2026', '2026-11-09', '4-room', 339000, 1120.5),
      row('r-2023', '2023-10-15', '5-room', 460000, 1080),
      row('r-2022', '2022-02-15', '4-room', 291000, 940),
      row('r-2018', '2018-11-01', '4-room', 290000, 880),
    ],
    total: 4,
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
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
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

  // The legend's text is the series name and its unit, which the component puts in
  // two elements — compare the NAMES, not the concatenation.
  const legend = async () =>
    page.evaluate(() =>
      // The label is the li's own TEXT NODE; its first child is the colour swatch
      // and its unit is a <span>, and neither is the series' name.
      [...document.querySelectorAll('.chart-legend li')].map((li) =>
        [...li.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join('')
          .trim(),
      ),
    );
  // SVG nodes have no innerText; `textContent` is what a chart label has.
  const axis = async () =>
    (
      await page.evaluate(() =>
        [...document.querySelectorAll('svg.metric-chart text.chart-tick')].map((t) => t.textContent ?? ''),
      )
    ).slice(-2);

  // ── 1. the series view: one line, and the compare chips exist ────────────
  check('a series opens as one plotted line', (await legend()).length, 1);
  checkTrue('the compare control lists the other series', (await page.locator('button:has-text("AMD price")').count()) > 0);

  // ── 5. compare: a second SERIES on the same axis ─────────────────────────
  await page.locator('button:has-text("AMD price")').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.chart-legend li').length === 2);
  check('comparing adds a second line', await legend(), ['NVDA price', 'AMD price']);
  checkTrue(
    'each line has its own colour class',
    (await page.evaluate(
      () =>
        new Set(
          [...document.querySelectorAll('.chart-line')].map((l) => [...l.classList].find((c) => c.startsWith('chart-series-'))),
        ).size,
    )) === 2,
  );
  await page.screenshot({ path: join(shot, 'desktop-compare.png'), fullPage: false });

  // ── 2/3/4. the table: pick columns, pick the axis ─────────────────────────
  await page.locator('.metric-master-row:has-text("Tengah BTO")').first().click();
  await page.waitForFunction(() => /Price/.test(document.querySelector('.chart-legend')?.textContent ?? ''));
  check('the table plots its first numeric column', await legend(), ['Price']);

  // The X picker is a select over EVERY column, dates included.
  const options = await page.locator('.md-xaxis select option').allInnerTexts();
  checkTrue('the x picker offers every column', options.length === 4 && options.some((o) => /Launch date/.test(o)));

  // A DATE axis, ascending: the FIRST slot must be the OLDEST row. Checking the
  // axis text cannot prove that (an axis label is `11/1` in any year), so the
  // tooltip — which prints the full stamp — is what answers it.
  const dateAxis = await axis();
  console.log(`        date axis: ${dateAxis.join('  ...  ')}`);
  await page.locator('.chart-hit').first().click();
  const firstTip = await page.evaluate(() => document.querySelector('.chart-tip')?.textContent ?? '');
  console.log(`        first slot: ${firstTip}`);
  checkTrue('a date axis is ASCENDING — the first slot is the OLDEST row', /2018-11-01/.test(firstTip));
  checkTrue('…and the first slot holds that row\u2019s value', /290,000/.test(firstTip));

  // Tick the second numeric column: two series, one shared legend.
  await page.locator('.md-seg[aria-label="Which columns to plot"] button:has-text("PSF")').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.chart-legend li').length === 2);
  check('ticking a column adds it to the same chart', await legend(), ['Price', 'PSF']);
  // Price is ~460,000 and PSF ~1,120: one axis cannot show both, and a chart that
  // silently flattens one looks like missing data.
  checkTrue(
    'a mixed-scale pair is called out rather than silently flattened',
    /apart, so PSF will read as a flat line/.test(await page.locator('.data-panel').innerText()),
  );
  await page.screenshot({ path: join(shot, 'desktop-two-columns.png') });

  // The x axis becomes CATEGORIES when the chosen column is text.
  await page.locator('.md-xaxis select').selectOption('flat_type');
  await page.waitForFunction(() => /4-room/.test(document.querySelector('.chart-x-title')?.textContent ?? 'x') || /4-room/.test(document.querySelector('svg.metric-chart')?.textContent ?? ''));
  const catAxis = await axis();
  console.log(`        category axis: ${catAxis.join('  ...  ') || '(labels are the first and last only)'}`);
  checkTrue('a text x column labels the axis with its values', catAxis.some((t) => /room/.test(t)));
  checkTrue('…and says which column it is', /Flat type/.test(await page.locator('.chart-x-title').innerText()));
  await page.screenshot({ path: join(shot, 'desktop-categories.png') });

  // ── 6. the same view on a phone ──────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(120);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('nothing overflows sideways at 390px', overflow <= 0, true);
  const selectBox = await page.locator('.md-xaxis select').boundingBox();
  check('the x picker is on screen and usable at 390px', Boolean(selectBox && selectBox.width > 40), true);
  check('the legend still names both series at 390px', (await legend()).length, 2);
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
