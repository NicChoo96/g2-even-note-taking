#!/usr/bin/env node
// PROBE — does the chart tooltip actually show a reading's dimensions?
//
// WHY THIS EXISTS
//   The tooltip is the only place a "row" is legible: the axis can say the month
//   and nothing else, while the project name lives in a DIFFERENT series and only
//   reaches the chart through a slot join. Source assertions can prove the wiring
//   exists; they cannot prove the box fits its text, that a click lands on the
//   reading under the finger, or that the attributes arrive at all.
//
// WHAT IT DOES
//   Bundles the REAL `MetricChart` (esbuild + react-dom), mounts it in Chromium
//   against the SHIPPED stylesheet, clicks a bar and reads the tooltip out of the
//   DOM. Then it hovers a different bar and checks the tooltip follows.
//
// Run: node tools/probe-chart-tooltip.mjs      (needs glasses/dist — build first)
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};

const cssDir = resolve(here, '../dist/assets');
if (!existsSync(cssDir)) {
  console.error('no glasses/dist — run `npm run build:deploy` first');
  process.exit(2);
}
const css = readFileSync(join(cssDir, readdirSync(cssDir).filter((f) => f.endsWith('.css')).sort().pop()), 'utf8');

const outDir = resolve(here, '.tmp-chart');
mkdirSync(outDir, { recursive: true });
const bundlePath = join(outDir, 'chart.js');

// Three launches, priced months apart, each with a project and an estate — the
// shape that started this: one number per launch, and two dimensions beside it.
await build({
  stdin: {
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MetricChart } from './web/metric-chart.tsx';

const day = 86_400_000;
const launch = (month, price) => ({ ts: Date.UTC(2026, month, 1), value: price, slot: '2026-' + String(month + 1).padStart(2, '0') });
const points = [launch(0, 290000), launch(5, 310000), launch(10, 339000)];

const projects = new Map([
  ['2026-01', 'Garden Vale'],
  ['2026-06', 'Garden Vale'],
  ['2026-11', 'Plantation Dew'],
]);
const estates = new Map([['2026-11', 'Tengah']]);

createRoot(document.getElementById('root')).render(
  React.createElement(MetricChart, {
    points,
    kind: 'bar',
    unit: 'SGD',
    precision: 2,
    attributes: [
      { key: 'tengah.bto.4room.project', label: 'project', bySlot: projects },
      { key: 'tengah.bto.4room.estate', label: 'estate', bySlot: estates },
    ],
  }),
);
`,
    resolveDir: resolve(here, '../src'),
    loader: 'tsx',
    sourcefile: 'chart-mount.tsx',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: bundlePath,
  logLevel: 'silent',
});

const js = readFileSync(bundlePath, 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:0;background:#12141a;padding:20px}#root{max-width:860px}</style></head>
<body><div id="root"></div><script>${js}</script></body></html>`;

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

const outPng = resolve(repo, '.tmp-e2e/chart-tooltip');
mkdirSync(outPng, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 360 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForSelector('.chart-hit');

  const bars = await page.locator('.chart-hit').count();
  check('there is one hit area per reading', bars, 3);
  check('no tooltip is showing to begin with', await page.locator('.chart-tip').count(), 0);

  // A CLICK (a tap on a phone) on the third launch.
  const third = await page.locator('.chart-hit').nth(2).boundingBox();
  await page.mouse.click(third.x + third.width / 2, third.y + third.height / 2);
  await page.waitForSelector('.chart-tip');
  // `<g>` is not an HTMLElement, so `innerText` refuses it — `textContent` is
  // what an SVG tooltip has.
  const tipText = () => page.evaluate(() => document.querySelector('.chart-tip')?.textContent ?? '');
  const clicked = await tipText();
  console.log(`        tooltip: ${clicked}`);
  check('a click opens the tooltip', clicked.length > 0, true);
  check('…naming the reading', /339,000\.00 SGD/.test(clicked), true);
  check('…and its project', /project: Plantation Dew/.test(clicked), true);
  check('…and its estate', /estate: Tengah/.test(clicked), true);
  await page.screenshot({ path: join(outPng, 'clicked-third.png') });

  // A HOVER on the first launch: the tooltip follows, and a reading WITHOUT the
  // second dimension simply does not show it.
  const first = await page.locator('.chart-hit').nth(0).boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.waitForFunction(() => /Garden Vale/.test(document.querySelector('.chart-tip')?.textContent ?? ''));
  const hovered = await tipText();
  console.log(`        tooltip: ${hovered}`);
  check('a hover moves the tooltip', /290,000\.00 SGD/.test(hovered), true);
  check('…to that launch\u2019s project', /project: Garden Vale/.test(hovered), true);
  check('…with no estate, because that launch has none', !/estate:/.test(hovered), true);

  // The box must stay inside the plot, even for the leftmost bar.
  const box = await page.evaluate(() => {
    const svg = document.querySelector('svg.metric-chart').getBoundingClientRect();
    const tip = document.querySelector('.chart-tip-box').getBoundingClientRect();
    return { left: Math.round(tip.left - svg.left), right: Math.round(svg.right - tip.right) };
  });
  check('the tooltip is not clipped at the left edge', box.left >= 0, true);
  check('…nor at the right', box.right >= 0, true);
  await page.screenshot({ path: join(outPng, 'hovered-first.png') });
} finally {
  await browser.close();
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('ALL CHECKS PASSED  (screenshots: .tmp-e2e/chart-tooltip/)');
}
