#!/usr/bin/env node
/**
 * Deploy the packed `.ehpk` to Even Hub.
 *
 * WHAT THIS DOES
 *   1. login          hub.evenrealities.com/login (two-step: email, then password)
 *   2. project        /hub/<package_id>
 *   3. guard          refuse if this version is already uploaded (that means the
 *                     version was not bumped) and refuse a package older than
 *                     the build it was packed from
 *   4. upload         Upload a build -> attach the .ehpk -> paste the changelog
 *                     from docs/patch-notes.md -> Add build
 *   5. promote        click the new row's status badge -> Beta -> Promote to Beta
 *   6. verify         the "Beta build" section names THIS version
 *
 * WHAT THIS DOES NOT DO — deliberately
 *   - It never bumps the version, packs the `.ehpk`, or writes the patch note.
 *     Those are the `g2-hub-release` skill's job. This script consumes their
 *     output and moves nothing but the deployment itself, so the two can be
 *     reasoned about separately: the skill owns WHAT ships, this owns THAT it
 *     ships.
 *
 * CREDENTIALS
 *   PLAYWRIGHT_LOGIN_USER / PLAYWRIGHT_LOGIN_PWD. Read from the environment
 *   first, and only if absent, from the first `.env.local` that has them. Values
 *   are never printed, logged, or included in an error.
 *
 * USAGE
 *   node scripts/hub-deploy.mjs                  # deploy glasses/app.json's version
 *   node scripts/hub-deploy.mjs --dry-run        # stop before uploading
 *   node scripts/hub-deploy.mjs --headed         # watch it happen
 *   node scripts/hub-deploy.mjs --resume         # row exists, not on Beta yet
 *   node scripts/hub-deploy.mjs --force          # re-upload a version anyway
 *   node scripts/hub-deploy.mjs --no-beta        # upload, leave it Private
 *   node scripts/hub-deploy.mjs --version 0.3.65 --pkg path/to/x.ehpk
 *
 * EXIT CODES
 *   0 deployed (or already deployed and verified)
 *   1 the flow failed — a screenshot of the failing screen is written
 *   2 configuration is wrong (no credentials, missing package, stale package)
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HUB = 'https://hub.evenrealities.com';
const PATTERN_TIME = { timeout: 30000 };

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d = null) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const APP_JSON = resolve(root, 'glasses/app.json');
const DIST_APP_JSON = resolve(root, 'glasses/dist/app.json');
const NOTES = resolve(root, 'docs/patch-notes.md');

const opts = {
  version: val('version'),
  pkg: resolve(root, val('pkg', 'glasses/reality-hub.ehpk')),
  project: val('project'),
  noteFile: resolve(root, val('note-file', 'docs/patch-notes.md')),
  note: val('note'),
  headed: has('headed'),
  dryRun: has('dry-run'),
  resume: has('resume'),
  // A version that is already on the hub is USUALLY a forgotten bump, so it is
  // refused by default. --replace (or --force) is the deliberate "I know, replace
  // it" — the hub's own word for it: "Adding the build will replace the old one."
  replace: has('replace') || has('force'),
  noBeta: has('no-beta'),
  truncate: has('truncate'),
};

const log = (...a) => console.log(...a);
const step = (n, t) => console.log(`\n[${n}] ${t}`);
const warn = (t) => console.log(`  ! ${t}`);
const die = (code, t) => {
  console.error(`\nFAILED: ${t}`);
  process.exit(code);
};

// ── what is being shipped ────────────────────────────────────────────────────
if (!existsSync(APP_JSON)) die(2, `no app.json at ${APP_JSON}`);
const app = JSON.parse(readFileSync(APP_JSON, 'utf8'));
const version = opts.version || app.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) die(2, `version "${version}" is not x.y.z`);
const packageId = app.package_id;
const projectUrl = opts.project || `${HUB}/hub/${packageId}`;

if (!existsSync(opts.pkg)) die(2, `no package at ${opts.pkg} — pack it first (see g2-hub-release)`);
// The packaging checks only matter when a package is going to be uploaded. A
// --resume run promotes what is already on the hub and needs no local artifact.
if (!opts.resume) {
  if (!existsSync(DIST_APP_JSON)) die(2, 'no glasses/dist/app.json — run `npm run build:deploy` first');
  const distVersion = JSON.parse(readFileSync(DIST_APP_JSON, 'utf8')).version;
  if (distVersion !== version) {
    die(2, `dist is ${distVersion} but app.json is ${version} — rebuild before packing`);
  }
  // A package older than the build it should contain is the one failure mode that
  // silently ships the previous version to the glasses.
  const pkgMtime = statSync(opts.pkg).mtimeMs;
  const distMtime = statSync(resolve(root, 'glasses/dist/app.json')).mtimeMs;
  if (pkgMtime < distMtime) {
    die(2, `the package is OLDER than the build (${opts.pkg}) — repack it`);
  }
}

/**
 * The changelog text: the patch-note body for this version, without its `##`
 * heading. That is exactly what the hub's 0/500 counter is counting.
 */
function changelogFor(v) {
  if (opts.note) return opts.note.trim();
  if (!existsSync(opts.noteFile)) return null;
  const md = readFileSync(opts.noteFile, 'utf8').replace(/\r\n/g, '\n');
  // The entry is the body under its `## x.y.z` heading, up to the next heading.
  // NOT `\s*$`: with the m flag that matches an empty line and silently returns
  // an empty changelog, which the hub accepts as a build with no notes.
  const re = new RegExp(`^## ${v.replace(/\./g, '\\.')}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

let changelog = changelogFor(version);
if (!changelog) die(2, `no patch-notes entry for ${version} in ${opts.noteFile}`);
const MAX_NOTE = 500; // the hub's own counter
if (changelog.length > MAX_NOTE) {
  if (!opts.truncate) {
    die(2, `the changelog for ${version} is ${changelog.length} chars, the hub accepts ${MAX_NOTE}`);
  }
  const cut = changelog.slice(0, MAX_NOTE);
  changelog = cut.replace(/\s+\S*$/, '') + '.';
  warn(`changelog truncated to ${changelog.length} chars`);
}

log(`Even Hub deploy`);
log(`  version   ${version}`);
log(`  package   ${opts.pkg}  (${(statSync(opts.pkg).size / 1024).toFixed(1)} KB)`);
log(`  project   ${projectUrl}`);
log(`  changelog ${changelog.length}/${MAX_NOTE} chars`);

// ── credentials ──────────────────────────────────────────────────────────────
function credentials() {
  let user = process.env.PLAYWRIGHT_LOGIN_USER;
  let pass = process.env.PLAYWRIGHT_LOGIN_PWD;
  if (!user || !pass) {
    for (const p of [resolve(root, '.env.local'), resolve(root, 'glasses/.env.local'), resolve(here, '.env.local')]) {
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(PLAYWRIGHT_LOGIN_USER|PLAYWRIGHT_LOGIN_PWD)\s*=\s*(.+?)\s*$/);
        if (!m) continue;
        const v = m[2].replace(/^["']|["']$/g, '');
        if (m[1] === 'PLAYWRIGHT_LOGIN_USER') user = user || v;
        else pass = pass || v;
      }
      if (user && pass) break;
    }
  }
  return { user, pass };
}
const { user, pass } = credentials();
if (!user || !pass) die(2, 'no credentials — set PLAYWRIGHT_LOGIN_USER and PLAYWRIGHT_LOGIN_PWD');

// ── which Chromium ───────────────────────────────────────────────────────────
/**
 * Prefer an explicit CHROME_PATH, then the playwright browser cache, then
 * playwright's own idea of where its pinned build lives. This box has real
 * Chromium builds cached under a DIFFERENT revision than the installed
 * playwright package expects, so using them avoids a ~150 MB download.
 */
function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || null;
  const dirs = [cache, process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/ms-playwright`, process.env.HOME && `${process.env.HOME}/.cache/ms-playwright`].filter(Boolean);
  const found = [];
  for (const base of dirs) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSafe(base)) {
      if (!entry.startsWith('chromium-')) continue;
      for (const rel of [
        'chrome-win64/chrome.exe',
        'chrome-win/chrome.exe',
        'chrome-linux/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = resolve(base, entry, rel);
        if (existsSync(p)) found.push({ p, rev: Number(entry.split('-')[1]) || 0 });
      }
    }
  }
  found.sort((a, b) => b.rev - a.rev);
  return found.length ? found[0].p : undefined;
}
function readdirSafe(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
const exe = chromePath();

// ── the run ──────────────────────────────────────────────────────────────────
const runDir = resolve(root, '.tmp-e2e/hub-deploy', version);
mkdirSync(runDir, { recursive: true });
const shot = (page, name) => page.screenshot({ path: resolve(runDir, `${name}.png`) }).catch(() => {});

const browser = await chromium.launch({ headless: !opts.headed, executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();

/** The whole body text, newlines intact — the hub renders a flat list. */
const bodyText = () => page.locator('body').innerText();

/** The card inside the "Beta build" section, as text. */
async function betaSection() {
  const t = await bodyText();
  // Slice between the two headings rather than one regex over the newlines: the
  // hub renders a flat list whose line structure is not part of any contract.
  const start = t.indexOf('Beta build');
  if (start < 0) return '';
  const end = t.indexOf('Private builds', start);
  return t.slice(start + 'Beta build'.length, end > start ? end : start + 300).trim();
}

/** This version's row in the private-builds list, or null. */
async function findRow() {
  const row = page.locator('div[class*="p-4"][class*="justify-between"]').filter({ hasText: `v${version}` }).first();
  return (await row.count()) ? row : null;
}

const fail = async (message) => {
  await shot(page, 'failed');
  const text = (await bodyText()).slice(0, 800);
  writeFileSync(resolve(runDir, 'failure.txt'), `${message}\n\n${text}`);
  console.error(`\nFAILED: ${message}`);
  console.error(`  screenshot: ${resolve(runDir, 'failed.png')}`);
  await browser.close();
  process.exit(1);
};

try {
  // ── 1. login ───────────────────────────────────────────────────────────────
  step(1, 'signing in');
  await page.goto(`${HUB}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // HYDRATION GUARD: the email field is in the server HTML, so it exists before
  // the page is interactive. Clicking Continue too early submits the raw form and
  // the browser GETs /login?email=…, which leaves you on step 1 for ever.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
  await page.locator('input[name="email"]').fill(user);
  await page.getByRole('button', { name: /continue/i }).click();
  await page.locator('input[name="password"]').waitFor({ timeout: 20000 });
  await page.locator('input[name="password"]').fill(pass);
  await page.getByRole('button', { name: /continue|sign in/i }).click();
  // PROOF of sign-in is the account sidebar, not a URL.
  await page.getByText(/my projects/i).first().waitFor({ timeout: 45000 });
  log('  signed in');

  // ── 2. the project ─────────────────────────────────────────────────────────
  step(2, 'opening the project');
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByRole('button', { name: /upload a build/i }).waitFor(PATTERN_TIME);
  // READINESS: the header renders before the builds list does. Reading the list
  // too early reports "this version is not uploaded yet" for a version that is
  // already there, and the next step would try to upload it again.
  await page
    .locator('div[class*="p-4"][class*="justify-between"]')
    .first()
    .waitFor({ timeout: PATTERN_TIME })
    .catch(() => warn('no build rows rendered — continuing, the list may be empty'));
  await page.waitForTimeout(1000);

  // ── 3. guards ──────────────────────────────────────────────────────────────
  step(3, 'checking what is already there');
  const existing = await findRow();
  const wasOnBeta = (await betaSection()).includes(`v${version}`);
  if (wasOnBeta && !opts.replace) {
    log(`  v${version} is ALREADY the Beta build — nothing to do`);
    await shot(page, 'already-deployed');
    await browser.close();
    process.exit(0);
  }
  if (existing && !opts.replace && !opts.resume) {
    await fail(
      `v${version} is already on the hub. That normally means the version was not ` +
        `bumped: bump glasses/app.json, repack, and run again. (--replace uploads it ` +
        `anyway and lets the hub replace the old build; --resume only promotes ` +
        `the build that is already there.)`,
    );
  }
  log(existing ? `  v${version} is already uploaded` : `  v${version} is not uploaded yet`);

  // ── 4. upload ──────────────────────────────────────────────────────────────
  if (!existing || opts.replace) {
    if (opts.dryRun) {
      step(4, 'dry run — stopping before upload');
      await shot(page, 'dry-run');
      await browser.close();
      process.exit(0);
    }
    step(4, 'uploading the package');
    await page.getByRole('button', { name: /upload a build/i }).click();
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /create build/i }).first();
    await dialog.waitFor(PATTERN_TIME);
    await page.locator('input[type="file"]').setInputFiles(opts.pkg);
    // The changelog box is the signal that the file was accepted: it appears only
    // after the hub has parsed the package and read its version.
    const box = dialog.locator('textarea').first();
    await box.waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    const dialogText = await dialog.innerText();
    const shown = dialogText.match(/v(\d+\.\d+\.\d+)/);
    if (shown && shown[1] !== version) {
      await fail(`the hub read v${shown[1]} from the package, expected v${version}`);
    }
    // This is the "version exists" case the hub warns about. It is not an error:
    // the confirm button becomes "Add and replace" and the old build is replaced.
    // Without --replace we stop HERE, before anything is written.
    const willReplace = /replace the old one/i.test(dialogText);
    if (willReplace && !opts.replace) {
      await fail(
        `the hub says this version already exists and would be REPLACED:\n` +
          `  "${(dialogText.match(/The package version[^\n]*/) ?? [''])[0]}"\n` +
          `  Bump the version, or pass --replace deliberately.`,
      );
    }
    log(`  package accepted${shown ? ` (hub sees v${shown[1]})` : ''}${willReplace ? ' — replacing the existing build' : ''}`);

    await box.fill(changelog);
    const counter = (await dialog.innerText()).match(/(\d+)\s*\/\s*500/);
    if (counter && Number(counter[1]) === 0) {
      await fail('the changelog box stayed at 0/500 — the text did not go in');
    }
    log(`  changelog: ${counter ? `${counter[1]}/500` : `${changelog.length} chars`}`);

    await dialog.getByRole('button', { name: willReplace ? /^add and replace$/i : /^add build$/i }).click();
    // The modal closes on success; an inline error keeps it open.
    await dialog.waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, '01-after-upload');

    const row = await findRow();
    if (!row) await fail(`v${version} did not appear in Private builds after the upload`);
    log(`  v${version} added: ${(await row.innerText()).replace(/\n/g, ' | ')}`);
  }

  // ── 5. promote to Beta ─────────────────────────────────────────────────────
  if (opts.noBeta) {
    step(5, 'skipped the Beta promotion (--no-beta)');
    log(`\nDone — v${version} is uploaded as a Private build.`);
    await browser.close();
    process.exit(0);
  }
  // Re-read: a replacing upload can reset the build's status, so the state seen
  // before the upload says nothing about the state now.
  const onBeta = (await betaSection()).includes(`v${version}`);
  if (onBeta) {
    step(5, 'already on Beta');
  } else {
    step(5, 'promoting to Beta');
    const row = await findRow();
    if (!row) await fail(`no row for v${version} to promote`);
    // The badge on THIS row, not the first Private badge on the page.
    await row.getByText(/^(private|public|beta)$/i).first().click();
    // The menu is a role=dialog holding the three status items, each with a
    // stable class (.tag-public/.tag-beta/.tag-private). Match on that STRUCTURE:
    // `hasText` compares textContent, which here is "PublicBetaPrivate" — a
    // regex expecting spaces between the words never matches, and the whole
    // promote step then times out with the menu visibly open on screen.
    const menu = page.locator('[role="dialog"]').filter({ has: page.locator('div.tag-public') }).last();
    await menu.waitFor({ timeout: PATTERN_TIME });
    await menu.locator('div.tag-beta').first().click();

    const promote = page.locator('[role="dialog"]').filter({ hasText: /promote this build/i }).first();
    await promote.waitFor({ timeout: PATTERN_TIME });
    const promoteText = await promote.innerText();
    if (!promoteText.includes(`v${version}`)) {
      await fail(`the promote dialog names a different build:\n${promoteText.slice(0, 200)}`);
    }
    await promote.getByRole('button', { name: /promote to beta/i }).click();
    await page.waitForTimeout(5000);
    await shot(page, '02-after-promote');
    log('  promoted');
  }

  // ── 6. verify ──────────────────────────────────────────────────────────────
  step(6, 'verifying');
  let section = '';
  for (let i = 0; i < 20; i++) {
    section = await betaSection();
    if (section.includes(`v${version}`)) break;
    await page.waitForTimeout(1500);
  }
  if (!section.includes(`v${version}`)) {
    await fail(`the Beta build section still reads "${section.replace(/\n/g, ' | ')}"`);
  }
  log(`  Beta build = v${version}  (${section.split('\n').slice(1, 3).join(' · ')})`);
  await shot(page, '03-verified');

  console.log(`\nDeployed v${version} to Beta.`);
  console.log(`  screenshots: ${runDir}`);
  await browser.close();
  process.exit(0);
} catch (e) {
  await fail(e.message.split('\n')[0]);
}
