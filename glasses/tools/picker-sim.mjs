#!/usr/bin/env node
// Regression harness for the Doc PICKER, the one overlay that is reachable only
// from the contextual menu — and therefore the one whose safety depended on the
// `Back` row that 0.3.49 removed.
//
// WHY SOURCE-LEVEL ASSERTIONS:
//   `enterPicker` / `onPickerTap` / `switchSection` live inside main.ts's Even SDK
//   callback and need a live hub to run, so the EvenHub simulator cannot reach
//   them without a fake SDK. This harness instead pins the SOURCE invariants that
//   make the flow safe, the same way `dictate-selfstop-sim.mjs` pins the event
//   router: each assertion is a one-line change that would reintroduce a real
//   bug, so it fails loudly and points at the line to read.
//
// BUG 1 (glasses/src/main.ts, enterPicker) — the picker ignored the page.
//   `pickerCursor = 0` made every open start on doc #1 while the detail pane was
//   showing whatever `docCursor` pointed at. Swipe to doc #4, long-press,
//   "Delete Docs", tap: doc #1 was the one deleted. Pre-existing, but 0.3.49 made
//   "Delete Docs" the Docs tab's ONLY action and moved it to the top of the menu,
//   so the wrong-document delete went from a buried oddity to the main path.
//   FIX: seed the cursor from `docCursor` (which IS the document on screen).
//
// BUG 2 (glasses/src/main.ts, onPickerTap) — deleting the last doc froze the
//   picker. An empty picker ignores the ring and ignores a tap, and the menu's
//   "Delete Docs" row is already gone, so with no `Back` the only way off that
//   screen was another tab's switcher. FIX: close the picker when the library
//   empties, and clamp the cursor against the POST-delete length.
//
// The third group is the ordering guarantee the flattening relies on: a switcher
// pressed while an overlay is up must dismiss the overlay, and the menu branch is
// handled before the tap/text branch so it can `return` first.
//
// Run: node tools/picker-sim.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');
const sectionsSrc = readFileSync(join(here, '..', 'src', 'sections.ts'), 'utf8');

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

/** The body of `function <name>(...)` with comments intact, found by brace match. */
function body(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

const enterPicker = body(mainSrc, 'enterPicker');
const onPickerTap = body(mainSrc, 'onPickerTap');
const switchSection = body(mainSrc, 'switchSection');
const docContainers = body(mainSrc, 'docContainers');
const sectionMenu = body(sectionsSrc, 'sectionMenu');
const scrollPicker = body(mainSrc, 'onPickerSwipe');

// ── The functions exist and were found ──────────────────────────────────────
for (const [name, got] of [
  ['enterPicker', enterPicker],
  ['onPickerTap', onPickerTap],
  ['switchSection', switchSection],
  ['docContainers', docContainers],
  ['sectionMenu', sectionMenu],
  ['onPickerSwipe', scrollPicker],
]) {
  assert(`src still defines ${name}()`, typeof got === 'string' && got.length > 0);
}

// ── BUG 1: the picker opens on the document that is ON SCREEN ───────────────
// `docCursor` only means "on screen" because the Docs panes are built from it.
assert(
  'docContainers() renders the list from docCursor',
  typeof docContainers === 'string' && /docsPanelView\([\s\S]*?docCursor/.test(docContainers),
);
assert(
  'docContainers() takes the clamped cursor back',
  typeof docContainers === 'string' && /docCursor = view\.cursor/.test(docContainers),
);
assert(
  'enterPicker() seeds the cursor from docCursor',
  typeof enterPicker === 'string' && /pickerCursor = Math\.min\(docs\.length - 1, Math\.max\(0, docCursor\)\)/.test(enterPicker),
);
assert(
  'enterPicker() does NOT reset the cursor to 0',
  typeof enterPicker === 'string' && !/pickerCursor = 0/.test(enterPicker),
  'a hard 0 here deletes the first document instead of the one on screen',
);
assert(
  'enterPicker() refuses an empty library',
  typeof enterPicker === 'string' && /if \(docs\.length === 0\) return;/.test(enterPicker),
);

// ── BUG 2: deleting the last document cannot strand the picker ──────────────
assert(
  'onPickerTap() closes the picker when the library empties',
  typeof onPickerTap === 'string' &&
    /if \(left\.length === 0\) \{\s*pickerActive = false;/.test(onPickerTap),
);
assert(
  'onPickerTap() clamps against the POST-delete length',
  typeof onPickerTap === 'string' &&
    /pickerCursor = Math\.min\(pickerCursor, left\.length - 1\)/.test(onPickerTap),
  'ds.length - 2 is the pre-delete list and is right only by accident',
);
{
  // The close must be a real branch, not a fall-through: it has to sit BEFORE the
  // clamp, and it has to return, otherwise the emptied picker is re-rendered.
  const closeAt = onPickerTap?.indexOf('left.length === 0') ?? -1;
  const clampAt = onPickerTap?.indexOf('Math.min(pickerCursor, left.length - 1)') ?? -1;
  assert('the empty-library branch is before the clamp', closeAt >= 0 && clampAt > closeAt);
  assert(
    'the empty-library branch returns',
    typeof onPickerTap === 'string' && /pickerActive = false;\s*pickerCursor = 0;\s*void renderGlasses\(\);\s*return;/.test(onPickerTap),
  );
}
assert(
  'an empty picker still cannot be interacted with',
  typeof scrollPicker === 'string' && /if \(!ds\.length\) return;/.test(scrollPicker) &&
    typeof onPickerTap === 'string' && /if \(!ds\.length\) return;/.test(onPickerTap),
  'the close above is what keeps the wearer off that screen',
);

// ── A switcher always dismisses the overlay it is pressed over ──────────────
assert(
  'switchSection() clears the picker',
  typeof switchSection === 'string' && /pickerActive = false;/.test(switchSection),
);
assert(
  'switchSection() still no-ops on the active tab',
  typeof switchSection === 'string' && /activeSection === next\) return;/.test(switchSection),
);
{
  // Event-router ordering: the menu branch must be handled BEFORE the tap/text
  // branch and before the system-event branch, because it `return`s. If text or
  // sys were handled first, a menu press would also be read as a tap and the
  // switcher would fight the dismiss.
  const menuAt = mainSrc.indexOf('if (event.menuItemClickEvent)');
  const textAt = mainSrc.indexOf('if (event.textEvent)');
  const sysAt = mainSrc.indexOf('const sys = event.sysEvent');
  assert('the router still tests the menu first', menuAt > 0 && textAt > menuAt, `menu@${menuAt} text@${textAt}`);
  assert('the router still tests the menu before sysEvent', sysAt > menuAt, `menu@${menuAt} sys@${sysAt}`);
  assert('the menu branch returns', /if \(event\.menuItemClickEvent\) \{[\s\S]*?return;/.test(mainSrc));
}

// ── The folded-away rows are really gone from the menu ──────────────────────
// `menu-sim.mjs` proves this behaviourally; the source check is here so that the
// reason (a thumb cannot be offered a row that no longer exists) is greppable.
for (const [id, why] of [
  ['MENU.BACK', 'the five switchers are on every tab now'],
  ['MENU.DOC_NEW', 'creating a doc belongs to the web app and Jarvis'],
  ['MENU.DOC_SELECT', 'swiping the L1 list already opens a document'],
]) {
  assert(
    `sectionMenu() no longer pushes ${id}`,
    typeof sectionMenu === 'string' && !sectionMenu.includes(id),
    why,
  );
}
assert(
  'sectionMenu() still offers Delete Docs on the Docs tab',
  typeof sectionMenu === 'string' &&
    /section === 'docs'[\s\S]*?MENU\.DOC_DELETE/.test(sectionMenu) &&
    /hasDocs/.test(sectionMenu),
);
assert(
  'sectionMenu() pushes the tab action before the switchers',
  typeof sectionMenu === 'string' &&
    sectionMenu.indexOf('MENU.DOC_DELETE') < sectionMenu.indexOf('for (const s of SECTIONS)'),
);
assert(
  'sectionMenu() keeps Dictate last',
  typeof sectionMenu === 'string' &&
    sectionMenu.lastIndexOf('MENU.DICTATE') > sectionMenu.indexOf('for (const s of SECTIONS)'),
);

// ── A stale installed menu still maps to something sensible ─────────────────
// An installed page keeps its OLD menu until something rebuilds it, and the OS
// never re-renders a label on its own, so a wearer can press a row that no longer
// exists. Every retired id therefore has to keep a handler.
for (const id of ['MENU.DOC_NEW', 'MENU.DOC_SELECT', 'MENU.DOC_DELETE', 'MENU.BACK']) {
  assert(
    `the router still handles ${id}`,
    new RegExp(`itemID === ${id.replace('.', '\\.')}\\)`).test(mainSrc),
    'a retired row must not fall through to nothing',
  );
}
assert(
  'the retired DOC_NEW row still creates a doc',
  /itemID === MENU\.DOC_NEW\) \{[\s\S]{0,120}?newDoc\(\);/.test(mainSrc),
);
assert(
  'the retired DOC_SELECT row still opens the picker',
  /itemID === MENU\.DOC_SELECT\) \{\s*enterPicker\('open'\);/.test(mainSrc),
);
assert(
  'the retired BACK row still moves tabs',
  /itemID === MENU\.BACK\) \{\s*goBack\(\);/.test(mainSrc),
);

// ── The empty library explains where documents come from ────────────────────
{
  const empty = sectionsSrc.match(/\(no docs yet[\s\S]{0,120}?\)/);
  assert('the empty-library copy exists', Boolean(empty));
  assert('it points at the web app', Boolean(empty && /web app/.test(empty[0])));
  assert('it points at Jarvis', Boolean(empty && /Jarvis/.test(empty[0])));
  assert(
    'it does not offer a New doc',
    !/New doc/.test(sectionsSrc),
  );
}

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
