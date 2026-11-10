#!/usr/bin/env node
// PROBE — does the Data tab actually use a desktop window?
//
// WHY THIS EXISTS
//   The Data tab is a master·detail surface: a column of numbers beside the chart
//   of the one you picked. On a phone that fits the viewport (the strip of chips
//   and the pane below it), but on a desktop it stopped at a 460px list and left
//   the bottom half of the window empty — which reads as "unfinished" rather than
//   "nothing more to show". The fix is a flex chain
//   .app → main.content → .data-panel → .data-split plus `app-data`, and a CSS
//   chain is exactly the kind of thing that looks right and measures wrong.
//
// WHAT IT MEASURES, in a real browser engine, against the REAL built stylesheet
//   1. the shell is 1240 wide on the Data tab (and stays 780/1080 elsewhere),
//   2. the split fills the height left over — the page itself does not scroll,
//   3. both panes scroll on their own when the content is tall,
//   4. the master column is 240–340 instead of 180–240,
//   5. the PHONE layout is untouched: chips in a row, no forced height.
//
// WHAT IT IS NOT
//   It renders a fixture, not the signed-in app: the relay needs an owner
//   session, and this box's browser integration is unavailable. The markup
//   copies the class structure of App.tsx + DataPanel.tsx verbatim and the CSS
//   is the shipped file, so it answers the geometry question — not the React
//   one. Screenshots land in .tmp-e2e/data-layout/ so the result can be LOOKED
//   at rather than trusted.
//
// Run: node tools/probe-data-layout.mjs
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/** The newest built stylesheet — the one the relay would serve. */
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

// ── the fixture: App.tsx's shell, DataPanel's split, the shipped class names ──
const row = (leaf, count, value, unit) =>
  `<button class="metric-master-row"><span class="mm-top"><span class="mm-leaf">${leaf}</span><span class="mm-count">${count}</span></span><span class="mm-value">${value}<span class="mm-unit">${unit}</span></span></button>`;

const group = (prefix, rows) => `<div class="mm-group"><div class="mm-group-head">${prefix}</div>${rows}</div>`;

const readings = Array.from({ length: 40 }, (_, i) => `<tr><td>1/1/2026, 12:00 am</td><td class="num">${(1000 + i).toFixed(2)}</td></tr>`).join('');

const fixture = (css) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>data layout probe</title><style>${css}</style></head>
<body>
<div class="app app-wide app-data">
  <header class="app-header">
    <div class="brand"><h1>Reality Hub</h1><p class="tagline">Ask Jarvis, or edit any page — it streams live to your glasses.</p></div>
    <div class="header-actions"><div class="sync-chip"><span class="dot"></span>Live</div></div>
  </header>
  <nav class="tabs" role="tablist">
    <button class="tab">Agents</button><button class="tab">Schedule</button><button class="tab active" aria-selected="true">Data</button>
    <button class="tab">To-Do</button><button class="tab">Docs</button><button class="tab">Files</button>
    <button class="tab">Notes</button><button class="tab">Jarvis</button><button class="tab">Settings</button><button class="tab">Export</button>
  </nav>
  <main class="content card">
    <div class="data-panel">
      <div class="dp-head">
        <h2 class="dp-title">Data</h2>
        <button class="dp-refresh">Refresh</button>
        <button class="dp-help-btn">Hide help</button>
      </div>
      <ol class="dp-steps">
        <li><strong>Name one number.</strong> A key like <code>news.rates.count</code> — one reading is one value of that number.</li>
        <li><strong>Say where it comes from.</strong> An API fetched on a schedule, an agent doing a web search, Jarvis, or your own script.</li>
        <li><strong>Pick it below and look.</strong> Line, area, bar or table — switching never changes the data.</li>
      </ol>
      <p class="dp-store">Saved on your hub — survives redeploys.</p>
      <div class="data-split">
        <div class="metric-master-wrap">
          <div class="mm-search"><input type="search" placeholder="Search these numbers" aria-label="Search the list of numbers"></div>
          <aside class="metric-master" aria-label="Data points">
            ${group('coe', row('cafe', 24, '92,000.00', 'SGD') + row('catc', 18, '12,500.00', 'SGD'))}
            ${group('nvda', row('price', 22, '178.67', 'USD'))}
            ${group('psi', row('east', 3, '54.00', 'PSI') + row('national', 1, '58.00', 'PSI') + row('north', 3, '47.00', 'PSI') + row('south', 3, '51.00', 'PSI') + row('west', 3, '49.00', 'PSI'))}
            ${group('sgx', row('dbs', 9, '36.10', 'SGD') + row('ocbc', 9, '14.20', 'SGD'))}
            ${group('tengah', row('bto.5room', 1, '494,000.00', 'SGD'))}
          </aside>
        </div>
        <div class="metric-detail-wrap">
          <section class="metric-detail">
            <header class="md-head"><div><div class="metric-label">Tengah BTO 5-room from price</div><div class="md-key">tengah.bto.5room</div></div><button class="dp-delete">Delete</button></header>
            <div class="metric-value">494,000.00</div>
            <div class="md-controls">
              <div class="md-seg" role="group" aria-label="Chart type">
                <button class="active">Line</button><button>Area</button><button>Bar</button><button>Step</button><button>Table</button>
              </div>
              <div class="md-seg" role="group" aria-label="Time window"><button>3 months</button><button class="active">1 year</button><button>3 years</button><button>All</button></div>
            </div>
            <svg class="metric-chart" viewBox="0 0 640 200" role="img" aria-label="line chart">
              <polyline class="chart-line" fill="none" points="52,180 200,120 350,140 500,60 620,40"></polyline>
            </svg>
            <table class="metric-readings"><thead><tr><th>When</th><th class="num">Value</th></tr></thead><tbody>${readings}</tbody></table>
          </section>
        </div>
      </div>
      <div class="dp-add-bar"><button class="primary">+ Add a number</button></div>
    </div>
  </main>
  <footer class="app-footer">Same URL drives the web UI and the glasses</footer>
</div>
</body></html>`;

const measure = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), bottom: Math.round(b.bottom) };
    };
    const scroller = (sel) => {
      const el = document.querySelector(sel);
      return el ? { content: el.scrollHeight, visible: el.clientHeight } : null;
    };
    const master = document.querySelector('.metric-master');
    return {
      win: { w: innerWidth, h: innerHeight },
      appMaxWidth: getComputedStyle(document.querySelector('.app')).maxWidth,
      app: box('.app'),
      main: box('main.content'),
      split: box('.data-split'),
      master: box('.metric-master'),
      detail: box('.metric-detail-wrap'),
      footer: box('.app-footer'),
      pageHeight: document.documentElement.scrollHeight,
      masterScroll: scroller('.metric-master'),
      detailScroll: scroller('.metric-detail-wrap'),
      masterDirection: getComputedStyle(master).flexDirection,
      masterColumns: getComputedStyle(document.querySelector('.data-split')).gridTemplateColumns,
    };
  });

const outDir = resolve(repo, '.tmp-e2e/data-layout');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(fixture(readFileSync(builtCss(), 'utf8')), { waitUntil: 'load' });

  // ── desktop ───────────────────────────────────────────────────────────────
  const desk = await measure(page);
  console.log(`desktop ${desk.win.w}x${desk.win.h}: app ${desk.app.w} wide, split ${desk.split.w}x${desk.split.h}, master ${desk.master.w}, page ${desk.pageHeight}`);

  // Where the height goes. A split that fills "the leftover" is only useful if
  // the leftover is worth having, and the fixed siblings above it decide that.
  const parts = await page.evaluate(() => {
    const h = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height) : null;
    };
    return {
      header: h('.app-header'),
      tabs: h('.tabs'),
      main: h('main.content'),
      panel: h('.data-panel'),
      head: h('.dp-head'),
      steps: h('.dp-steps'),
      store: h('.dp-store'),
      split: h('.data-split'),
      addBar: h('.dp-add-bar'),
      footer: h('.app-footer'),
    };
  });
  console.log('  heights:', JSON.stringify(parts));

  check('the Data shell is the wide one (1240)', desk.appMaxWidth, '1240px');
  check('the master column is wider than the old 240', desk.master.w >= 240 && desk.master.w <= 341, true);
  // 800px tall leaves ~271px if the split takes only the leftover, which is
  // SMALLER than the 460px list it replaced — the fix would have been a
  // regression. It claims 55dvh (440 here) and the panel scrolls for the rest.
  check('the split claims a real share of the window', desk.split.h >= 420, true);
  check('the document itself never scrolls', desk.pageHeight <= desk.win.h + 1, true);
  check('…so the footer stays on screen', desk.footer.bottom <= desk.win.h, true);
  check('the master list scrolls on its own', desk.masterScroll.content > desk.masterScroll.visible, true);
  check('the detail pane scrolls on its own', desk.detailScroll.content > desk.detailScroll.visible, true);
  check('the two panes end together', Math.abs(desk.master.bottom - desk.detail.bottom) <= 2, true);

  await page.screenshot({ path: join(outDir, 'desktop-1280x800.png'), fullPage: false });

  // ── a tall window: the split should fill it without asking for a scroll ────
  await page.setViewportSize({ width: 1920, height: 1080 });
  const big = await measure(page);
  const bigParts = await page.evaluate(() => ({
    split: Math.round(document.querySelector('.data-split').getBoundingClientRect().height),
    main: document.querySelector('main.content').scrollHeight - document.querySelector('main.content').clientHeight,
  }));
  console.log(`desktop ${big.win.w}x${big.win.h}: split ${bigParts.split} tall, main overflows by ${bigParts.main}, page ${big.pageHeight}`);
  check('at 1080p the split is bigger than the old 460px list', bigParts.split > 460, true);
  check('…and nothing needs to scroll but the panes', bigParts.main <= 0, true);
  check('…and the document still does not scroll', big.pageHeight <= big.win.h + 1, true);
  await page.screenshot({ path: join(outDir, 'desktop-1920x1080.png'), fullPage: false });

  // ── phone: the layout that already worked must not move ───────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await measure(page);
  console.log(`phone ${phone.win.w}x${phone.win.h}: split ${phone.split.w}x${phone.split.h}, master ${phone.master.w}x${phone.master.h} (${phone.masterDirection})`);

  check('on a phone the list is a horizontal strip again', phone.masterDirection, 'row');
  check('…the full width of the split', Math.abs(phone.master.w - phone.split.w) <= 40, true);
  check('…and not a tall column', phone.master.h < 140, true);
  check('and one column, not two', phone.masterColumns.split(' ').length, 1);

  await page.screenshot({ path: join(outDir, 'phone-390x844.png'), fullPage: false });
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log(`ALL CHECKS PASSED  (screenshots: .tmp-e2e/data-layout/)`);
}
