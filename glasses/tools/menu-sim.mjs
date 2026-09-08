// Verifies the reusable contextual menu layout (sectionMenu) without glasses.
// Run: node tools/menu-sim.mjs
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'menu-sim-'));
const stub = join(out, 'stub.mjs');
writeFileSync(
  stub,
  `export class MenuItemProperty{constructor(o){Object.assign(this,o)}}
export class MenuContainerProperty{constructor(o){Object.assign(this,o)}}
export const utf8ByteLength=(s)=>Buffer.byteLength(s,'utf8');
export const measureTextWrap=()=>({lineCount:1});\n`,
);

const outfile = join(out, 'sections.mjs');
await build({
  entryPoints: ['src/sections.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: {
    '@evenrealities/even_hub_sdk': stub,
    '@evenrealities/pretext': stub,
  },
});

const { sectionMenu, MENU } = await import(pathToFileURL(outfile).href);
const names = (m) => (m.menuItems ?? []).map((i) => i.itemName);
const ids = (m) => (m.menuItems ?? []).map((i) => i.itemID);

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
};

const docs = sectionMenu({ section: 'docs', hasDocs: true });
check('docs (has docs)', names(docs), ['Dictate', 'Back', 'New Docs', 'Select Docs', 'Delete Docs']);
check('docs ids', ids(docs), [MENU.DICTATE, MENU.BACK, MENU.DOC_NEW, MENU.DOC_SELECT, MENU.DOC_DELETE]);

check('docs (empty)', names(sectionMenu({ section: 'docs', hasDocs: false })), [
  'Dictate',
  'Back',
  'New Docs',
]);

check('todo', names(sectionMenu({ section: 'todo', hasDocs: true })), ['Dictate', 'To-Do', 'Docs', 'Notes']);
check('notes', names(sectionMenu({ section: 'notes', hasDocs: true })), ['Dictate', 'To-Do', 'Docs', 'Notes']);

// Dictate must be first, and item IDs must stay unique, in every section.
for (const s of ['todo', 'docs', 'notes']) {
  const list = ids(sectionMenu({ section: s, hasDocs: true }));
  check(`${s}: Dictate first`, list[0], MENU.DICTATE);
  check(`${s}: unique ids`, new Set(list).size, list.length);
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
