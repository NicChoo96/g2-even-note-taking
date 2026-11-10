#!/usr/bin/env node
// PROBE — does a TABLE render as a table, on a phone and on a desktop?
//
// WHY THIS EXISTS
//   The Data tab gained a second shape: rows whose columns are declared as data.
//   A harness can prove the store returns the right JSON and the tool prints the
//   right sentence, and neither can prove that five columns fit in the detail
//   pane, that the row-identity column does not push the numbers off the screen,
//   or that the inline editor does not blow the layout apart on a phone. Those
//   are geometry questions, so this measures them in a real engine against the
//   SHIPPED stylesheet.
//
// WHAT IT MEASURES
//   1. every column is a visible <th>, in schema order, with its label,
//   2. the row identity is shown AND the numeric cells are right-aligned,
//   3. the pane does not overflow horizontally at 390px (a table is the one
//      thing that will happily do it),
//   4. the table scrolls inside its own box rather than growing the page,
//   5. the editing row's inputs fit inside their cells,
//   6. the numeric-column chips name the columns and one is active.
//
// WHAT IT IS NOT
//   A fixture, not the signed-in app — the same trade `probe-data-layout.mjs`
//   makes. The class structure copies `DataPanel.tsx`'s TableDetail verbatim and
//   the CSS is the built file, so it answers the layout question, not the React
//   one. Screenshots land in .tmp-e2e/record-view/ to be looked at.
//
// Run: node tools/probe-record-view.mjs   (after `npm run build:deploy`)

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function builtCss() {
  const dir = resolve(here, '../dist/assets');
  if (!existsSync(dir)) throw new Error('no glasses/dist — run `npm run build:deploy` first');
  const file = readdirSync(dir).filter((f) => f.endsWith('.css')).sort().pop();
  return join(dir, file);
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

// ── the fixture: the tables group in the master list + TableDetail's markup ──
const FIELDS = [
  { key: 'launch_date', label: 'Launch date', type: 'date' },
  { key: 'flat_type', label: 'Flat type', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'price', label: 'Price', type: 'number', unit: 'SGD' },
];

// Two kinds of row on purpose: one keyed BY its date (so the instant must not be
// echoed under the identity) and one keyed by something else (so the instant is
// real information and must be shown).
const ROWS = [
  { key: '2023-10-15', when: '', ts: '15/10/2023', values: ['2023-10-15', '4-room', 'Garden Vale', '290,000 SGD'] },
  { key: 'launch-2', when: '1/2/2024', ts: '1/2/2024', values: ['2024-02-01', '5-room', 'Plantation Dew', '410,000 SGD'] },
  { key: '2024-05-20', when: '', ts: '20/5/2024', values: ['2024-05-20', '3-room', 'Tengah Terrace', '228,000 SGD'] },
];

const body = (editing) =>
  ROWS.map((r) => {
    const cells = FIELDS.map((f, i) =>
      editing === r.key
        ? `<td class="${f.type === 'number' ? 'num' : ''}"><input value="${r.values[i]}" aria-label="${f.label}"></td>`
        : `<td class="${f.type === 'number' ? 'num' : ''}">${r.values[i]}</td>`,
    ).join('');
    const actions =
      editing === r.key
        ? '<td class="rec-actions"><button>Save</button><button>Cancel</button></td>'
        : '<td class="rec-actions"><button>Edit</button><button>Del</button></td>';
    const when = r.when ? `<span class="rec-when">${r.when}</span>` : '';
    return `<tr class="${editing === r.key ? 'editing' : ''}"><td class="rec-key"><span>${r.key}</span>${when}</td>${cells}${actions}</tr>`;
  }).join('');

const fixture = (css, editing = null, openPanel = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>record view probe</title><style>${css}</style></head>
<body>
<div class="app app-wide app-data">
  <header class="app-header">
    <div class="brand"><h1>Reality Hub</h1><p class="tagline">Ask Jarvis, or edit any page — it streams live to your glasses.</p></div>
    <div class="header-actions"><div class="sync-chip"><span class="dot"></span>Live</div></div>
  </header>
  <nav class="tabs" role="tablist">
    <button class="tab">Agents</button><button class="tab">Schedule</button><button class="tab active">Data</button>
    <button class="tab">To-Do</button><button class="tab">Docs</button><button class="tab">Files</button>
    <button class="tab">Notes</button><button class="tab">Jarvis</button><button class="tab">Settings</button>
  </nav>
  <main class="content card">
    <div class="data-panel">
      <div class="dp-head"><h2 class="dp-title">Data</h2><button class="dp-refresh">Refresh</button><button class="dp-help-btn">Hide help</button></div>
      <div class="data-split">
        <div class="metric-master-wrap">
          <div class="mm-search"><input type="search" placeholder="Search these numbers and tables" aria-label="Search"></div>
          <aside class="metric-master" aria-label="Data points">
            <div class="mm-group"><div class="mm-group-head">psi</div>
              <button class="metric-master-row"><span class="mm-top"><span class="mm-leaf">west</span><span class="mm-count">3</span></span><span class="mm-value">49.00<span class="mm-unit">PSI</span></span></button>
            </div>
            <div class="mm-group"><div class="mm-group-head">tables</div>
              <button class="metric-master-row active"><span class="mm-top"><span class="mm-leaf">BTO launches</span><span class="mm-count">3</span></span><span class="mm-table-meta">4 columns</span><span class="mm-table-cols">Launch date, Flat type, Project, Price</span></button>
            </div>
          </aside>
        </div>
        <div class="metric-detail-wrap">
          <section class="metric-detail">
            <header class="md-head"><div><div class="metric-label">BTO launches</div><div class="md-key">bto.launch · table</div></div><button class="dp-delete">Delete</button></header>
            <div class="md-controls">
              <div class="md-seg" role="group" aria-label="Which column to chart"><button class="active">Price</button></div>
              <div class="md-seg" role="group" aria-label="Chart type"><button class="active">Line</button><button>Area</button><button>Bar</button><button>Step</button><button>Table</button></div>
            </div>
            <div class="rec-filters" role="group" aria-label="Filter the rows">
              <details class="rec-filter active"${openPanel ? ' open' : ''}>
                <summary><span class="rec-filter-name">Flat type</span><span class="rec-filter-value">4-room</span></summary>
                <div class="rec-filter-panel">
                  <input type="search" placeholder="Search flat type" aria-label="Search Flat type values">
                  <div class="rec-filter-list" role="group" aria-label="Flat type values">
                    <label class="rec-filter-opt"><input type="checkbox"><span>All</span><em>3</em></label>
                    <label class="rec-filter-opt"><input type="checkbox" checked><span>4-room</span><em>2</em></label>
                    <label class="rec-filter-opt"><input type="checkbox"><span>5-room</span><em>1</em></label>
                  </div>
                </div>
              </details>
              <details class="rec-filter">
                <summary><span class="rec-filter-name">Projects</span><span class="rec-filter-value">All</span></summary>
                <div class="rec-filter-panel"><div class="rec-filter-list"><label class="rec-filter-opt"><input type="checkbox"><span>All</span><em>3</em></label></div></div>
              </details>
              <div class="rec-range">
                <label><span>From</span><input type="date" value="2018-11-01"></label>
                <label><span>To</span><input type="date" value="2026-11-09"></label>
              </div>
              <button class="mm-clear">Clear</button>
              <span class="rec-filter-summary">2 of 3 rows · 2018-11-01 to 2026-11-09</span>
            </div>
            <svg class="metric-chart" viewBox="0 0 640 200" role="img" aria-label="line chart">
              <polyline class="chart-line" fill="none" points="52,150 300,90 620,40"></polyline>
            </svg>
            <table class="metric-readings record-table">
              <thead><tr><th>Row</th>${FIELDS.map((f) => `<th class="${f.type === 'number' ? 'num' : ''}">${f.label}</th>`).join('')}<th></th></tr></thead>
              <tbody>${body(editing)}</tbody>
            </table>
            <footer class="metric-foot"><span>3 rows</span><span>4 columns</span><span>new columns appear as data arrives</span></footer>
          </section>
        </div>
      </div>
    </div>
  </main>
  <footer class="app-footer">Same URL drives the web UI and the glasses</footer>
</div>
</body></html>`;

const outDir = resolve(repo, '.tmp-e2e/record-view');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
try {
  const css = readFileSync(builtCss(), 'utf8');

  // ── desktop ────────────────────────────────────────────────────────────
  const wide = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await wide.setContent(fixture(css), { waitUntil: 'load' });
  await wide.screenshot({ path: join(outDir, 'desktop.png'), fullPage: false });

  const desktop = await wide.evaluate(() => {
    const table = document.querySelector('.record-table');
    const ths = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    const firstRow = [...table.querySelectorAll('tbody tr')][0];
    const cells = [...firstRow.querySelectorAll('td')];
    const pane = document.querySelector('.metric-detail-wrap');
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    };
    return {
      ths,
      rowKey: cells[0]?.querySelector('span')?.textContent?.trim(),
      rowWhen: cells[0]?.querySelector('.rec-when')?.textContent?.trim() ?? '',
      secondWhen: [...table.querySelectorAll('tbody tr')][1]?.querySelector('.rec-when')?.textContent?.trim(),
      numericAlign: [...table.querySelectorAll('tbody tr')[0].querySelectorAll('td.num')].map(
        (td) => getComputedStyle(td).textAlign,
      ),
      headerAlign: getComputedStyle(table.querySelector('thead th.num')).textAlign,
      tableOverflow: table.scrollWidth - table.clientWidth,
      paneOverflow: pane.scrollWidth - pane.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      tableBox: box(table),
      paneBox: box(pane),
      chips: [...document.querySelectorAll('.md-seg[aria-label="Which column to chart"] button')].map(
        (b) => `${b.textContent.trim()}${b.classList.contains('active') ? ' (active)' : ''}`,
      ),
      filterChips: [...document.querySelectorAll('.rec-filter > summary')].map((el) =>
        [...el.querySelectorAll('span')].map((sp) => sp.textContent.trim()).join(' '),
      ),
      filterActive: (() => {
        const on = document.querySelector('.rec-filter.active > summary');
        return on ? [...on.querySelectorAll('span')].map((sp) => sp.textContent.trim()).join(' ') : '';
      })(),
      rangeValues: [...document.querySelectorAll('.rec-range input')].map((i) => i.value),
      filterSummary: document.querySelector('.rec-filter-summary')?.textContent?.trim() ?? '',
      filterOverflow: (() => {
        const row = document.querySelector('.rec-filters');
        return row ? row.scrollWidth - row.clientWidth : 0;
      })(),
    };
  });

  check('every column is a header, in schema order', desktop.ths, ['Row', 'Launch date', 'Flat type', 'Project', 'Price', '']);
  check('the row identity is its own column', desktop.rowKey, '2023-10-15');
  check('a date keyed row does NOT echo its date beneath itself', desktop.rowWhen, '');
  check('a row keyed by something else DOES show its instant', desktop.secondWhen, '1/2/2024');
  check('numbers are right-aligned in cells', desktop.numericAlign.includes('right'), true);
  check('…and in the header', desktop.headerAlign, 'right');
  check('the table does not overflow its own box', desktop.tableOverflow <= 1, true);
  check('the detail pane does not overflow', desktop.paneOverflow <= 1, true);
  check('the page never scrolls sideways', desktop.pageOverflow <= 1, true);
  check('there is a chip per numeric column, one active', desktop.chips, ['Price (active)']);
  check('the table is wide enough to be a table', desktop.tableBox.w > 400, true);
  check('a filter chip per filterable column', desktop.filterChips, ['Flat type 4-room', 'Projects All']);
  check('the active one is marked', desktop.filterActive, 'Flat type 4-room');
  check('a custom range reads back as dates', desktop.rangeValues, ['2018-11-01', '2026-11-09']);
  check('the count says how many rows survived', desktop.filterSummary, '2 of 3 rows \u00b7 2018-11-01 to 2026-11-09');
  check('the filter row does not widen the pane', desktop.filterOverflow <= 1, true);

  // ── the inline editor ──────────────────────────────────────────────────
  const editing = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await editing.setContent(fixture(css, 'launch-2'), { waitUntil: 'load' });
  await editing.screenshot({ path: join(outDir, 'desktop-editing.png'), fullPage: false });
  const editState = await editing.evaluate(() => {
    const tr = document.querySelector('tr.editing');
    const inputs = [...tr.querySelectorAll('input')];
    const table = document.querySelector('.record-table');
    return {
      hasEditingRow: Boolean(tr),
      inputCount: inputs.length,
      // An input that overflows its cell makes the whole table wider than its
      // box, which is the failure a fixed-width table hides until you edit.
      overflow: table.scrollWidth - table.clientWidth,
      widest: Math.max(...inputs.map((i) => Math.round(i.getBoundingClientRect().width))),
    };
  });
  check('the editing row is marked', editState.hasEditingRow, true);
  check('every text column has an input', editState.inputCount, 4);
  check('the editor does not widen the table', editState.overflow <= 1, true);

  // ── phone ──────────────────────────────────────────────────────────────
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phone.setContent(fixture(css), { waitUntil: 'load' });
  await phone.screenshot({ path: join(outDir, 'phone.png'), fullPage: false });
  const phoneState = await phone.evaluate(() => {
    const table = document.querySelector('.record-table');
    const pane = document.querySelector('.metric-detail-wrap');
    return {
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      tableScrolls: table.scrollWidth > table.clientWidth,
      paneOverflow: pane.scrollWidth - pane.clientWidth,
      rowCount: table.querySelectorAll('tbody tr').length,
      wide: [...document.querySelectorAll('*')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.right > window.innerWidth + 1)
        .slice(0, 6)
        .map(({ el, r }) => `${el.tagName}.${el.className || ''} right=${Math.round(r.right)} w=${Math.round(r.width)}`),
    };
  });
  if (phoneState.pageOverflow > 1) console.log('        widest:', phoneState.wide.join(' | '));
  check('a phone does not scroll sideways', phoneState.pageOverflow <= 1, true);
  check('the table scrolls inside its own box instead', phoneState.tableScrolls, true);
  check('all rows are rendered', phoneState.rowCount, 3);

  // An open panel anchored to a chip near the right edge is the classic way a
  // phone ends up scrolling sideways, so the open state is measured too — the
  // panel becomes a viewport sheet under 720px for exactly this reason.
  const phoneOpen = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phoneOpen.setContent(fixture(css, null, true), { waitUntil: 'load' });
  await phoneOpen.screenshot({ path: join(outDir, 'phone-filter-open.png'), fullPage: false });
  const openState = await phoneOpen.evaluate(() => {
    const panel = document.querySelector('.rec-filter-panel');
    const box = panel.getBoundingClientRect();
    return {
      visible: box.width > 0 && box.height > 0,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      insideViewport: box.left >= 0 && box.right <= window.innerWidth + 1,
      options: panel.querySelectorAll('.rec-filter-opt').length,
    };
  });
  check('an open filter panel is visible', openState.visible, true);
  check('…with every option', openState.options, 3);
  check('…and it stays inside the viewport', openState.insideViewport, true);
  check('…so the page still does not scroll sideways', openState.pageOverflow <= 1, true);

  console.log(`\nscreenshots: ${outDir}`);
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} FAILURE(S) of ${pass + failures.length}` : `\nALL PASS (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);
