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

const { sectionMenu, MENU, SECTIONS, agentsMasterDetailView } = await import(
  pathToFileURL(outfile).href
);
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
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// ── Docs tab ────────────────────────────────────────────────────────────────
const docs = sectionMenu({ section: 'docs', hasDocs: true });
check('docs (has docs)', names(docs), [
  'Dictate',
  'Back',
  'New Docs',
  'Select Docs',
  'Delete Docs',
]);
check('docs ids', ids(docs), [
  MENU.DICTATE,
  MENU.BACK,
  MENU.DOC_NEW,
  MENU.DOC_SELECT,
  MENU.DOC_DELETE,
]);

check('docs (empty)', names(sectionMenu({ section: 'docs', hasDocs: false })), [
  'Dictate',
  'Back',
  'New Docs',
]);

// ── Agents tab ──────────────────────────────────────────────────────────────
const agents = sectionMenu({ section: 'agents', hasDocs: true, hasAgents: true });
check('agents (has agents)', names(agents), [
  'Dictate',
  'Back',
  'Select Agents',
  'New Agents',
  'Delete Agents',
  'Run',
]);
check('agents ids', ids(agents), [
  MENU.DICTATE,
  MENU.BACK,
  MENU.AGENT_SELECT,
  MENU.AGENT_NEW,
  MENU.AGENT_DELETE,
  MENU.AGENT_RUN,
]);
check('agents (empty)', names(sectionMenu({ section: 'agents', hasDocs: true, hasAgents: false })), [
  'Dictate',
  'Back',
  'Select Agents',
  'New Agents',
]);

// ── Plain tabs ──────────────────────────────────────────────────────────────
const switchers = ['Dictate', 'To-Do', 'Docs', 'Notes', 'Agents'];
check('todo', names(sectionMenu({ section: 'todo', hasDocs: true })), switchers);
check('notes', names(sectionMenu({ section: 'notes', hasDocs: true })), switchers);

// ── Global invariants ───────────────────────────────────────────────────────
const allSections = ['todo', 'docs', 'notes', 'agents'];
for (const s of allSections) {
  for (const hasAgents of [false, true]) {
    const list = ids(sectionMenu({ section: s, hasDocs: true, hasAgents }));
    const label = `${s}/hasAgents=${hasAgents}`;
    check(`${label}: Dictate first`, list[0], MENU.DICTATE);
    check(`${label}: unique ids`, new Set(list).size, list.length);
    assert(`${label}: <= 10 items`, list.length <= 10, `(${list.length})`);
  }
}

// Section switcher ids must match SECTIONS and stay unique across the app.
// MENU.TODO/DOCS/NOTES/AGENTS intentionally mirror SECTIONS[].menuId.
const sectionIds = SECTIONS.map((s) => s.menuId);
check('SECTIONS ids', sectionIds, [1, 2, 3, 4]);
check('switcher MENU ids match SECTIONS', [
  MENU.TODO,
  MENU.DOCS,
  MENU.NOTES,
  MENU.AGENTS,
], sectionIds);
const actionIds = Object.entries(MENU)
  .filter(([k]) => !['TODO', 'DOCS', 'NOTES', 'AGENTS'].includes(k))
  .map(([, v]) => v);
check('action ids unique', new Set(actionIds).size, actionIds.length);
check('action ids disjoint from switchers', actionIds.some((v) => sectionIds.includes(v)), false);

// ── Master–detail renderer ──────────────────────────────────────────────────
const mkAgent = (id, name, toolIds = []) => ({ id, name, systemPrompt: '', toolIds, createdAt: 0 });
const mkSession = (id, agentId, content) => ({
  id,
  agentId,
  title: id,
  messages: [{ role: 'assistant', content, at: 0 }],
  status: 'done',
  createdAt: 0,
  updatedAt: 0,
});

const view = agentsMasterDetailView(
  {
    agents: [mkAgent('a1', 'Alpha', ['tool-tavily']), mkAgent('a2', 'Beta')],
    sessions: [mkSession('s1', 'a1', 'Newest answer'), mkSession('s2', 'a1', 'Older answer')],
    cursor: 0,
    focus: 'master',
    sessionCursor: 0,
    status: '',
  },
  (id) => (id === 'tool-tavily' ? 'tavily_search' : id),
);
assert('master lists both agents', view.master.includes('Alpha') && view.master.includes('Beta'));
assert('master marks the cursor', view.master.includes('▶'));
assert('detail shows the newest answer', view.detail.includes('Newest answer'), view.detail);
assert('detail shows the tool name', view.detail.includes('tavily_search'));
assert('cursor clamped', view.cursor === 0 && view.canPrev === false && view.canNext === true);

const browsed = agentsMasterDetailView({
  agents: [mkAgent('a1', 'Alpha')],
  sessions: [mkSession('s1', 'a1', 'Newest answer'), mkSession('s2', 'a1', 'Older answer')],
  cursor: 0,
  focus: 'detail',
  sessionCursor: 1,
  status: '',
});
assert('detail browses older sessions', browsed.detail.includes('Older answer'), browsed.detail);

const emptyView = agentsMasterDetailView({ agents: [], sessions: [], cursor: 5, focus: 'master' });
assert('empty state clamps cursor to 0', emptyView.cursor === 0);
assert('empty state hints', emptyView.master.includes('no agents'), emptyView.master);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
