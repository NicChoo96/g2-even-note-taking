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
    // `@evenrealities/pretext` is bundled for real so pagination is measured
    // with the same LVGL-accurate metrics the glasses use.
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
  'Trigger',
]);
check('agents ids', ids(agents), [
  MENU.DICTATE,
  MENU.BACK,
  MENU.AGENT_SELECT,
  MENU.AGENT_NEW,
  MENU.AGENT_DELETE,
  MENU.AGENT_TRIGGER,
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

// ── Detail-pane pagination ──────────────────────────────────────────────────
// A transcript longer than one screen must page instead of being clipped, and
// the FULL transcript (every turn) must be reachable, matching the web panel's
// Transcript component.
const longAnswer =
  'Here is the full answer. ' +
  Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} explains a detail.`).join(' ');
const transcript = [
  { role: 'user', content: 'What is new in AI this week?', at: 0 },
  { role: 'assistant', content: '', tool: 'tavily_search', at: 1 },
  { role: 'tool', content: 'TOOLRESULT-MARKER '.repeat(30), tool: 'tavily_search', at: 2 },
  { role: 'assistant', content: longAnswer, at: 3 },
];
const paged = agentsMasterDetailView({
  agents: [mkAgent('a1', 'Alpha', ['tool-tavily'])],
  sessions: [
    {
      id: 's1',
      agentId: 'a1',
      title: 's1',
      messages: transcript,
      status: 'done',
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  cursor: 0,
  focus: 'detail',
  sessionCursor: 0,
  detailPage: 0,
  status: '',
});
assert('long transcript pages', paged.detailPages > 1, `pages=${paged.detailPages}`);
assert('page 0 starts at the newest turn', paged.detail.includes('Here is the full answer'));
assert('page 0 footer shows the page counter', paged.detail.includes(`1/${paged.detailPages}`));
assert('detail page is clamped to 0', paged.detailPage === 0);
assert('detail respects the 999-byte cap', Buffer.byteLength(paged.detail, 'utf8') <= 999);

const lastPage = agentsMasterDetailView({
  agents: [mkAgent('a1', 'Alpha', ['tool-tavily'])],
  sessions: [
    {
      id: 's1',
      agentId: 'a1',
      title: 's1',
      messages: transcript,
      status: 'done',
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  cursor: 0,
  focus: 'detail',
  sessionCursor: 0,
  detailPage: 999,
  status: '',
});
assert(
  'last page reaches the OLDEST turn (user prompt)',
  lastPage.detail.includes('What is new in AI this week?'),
  lastPage.detail,
);
assert('detail page clamps past the end', lastPage.detailPage === lastPage.detailPages - 1);

// Every page of the transcript must be reachable, and the union must contain
// both the oldest and newest content — i.e. nothing is dropped.
const session = {
  id: 's1',
  agentId: 'a1',
  title: 's1',
  messages: transcript,
  status: 'done',
  createdAt: 0,
  updatedAt: 0,
};
const seen = [];
for (let p = 0; p < paged.detailPages; p++) {
  const v = agentsMasterDetailView({
    agents: [mkAgent('a1', 'Alpha', ['tool-tavily'])],
    sessions: [session],
    cursor: 0,
    focus: 'detail',
    sessionCursor: 0,
    detailPage: p,
    status: '',
  });
  assert(`page ${p + 1} stays under the OS byte cap`, Buffer.byteLength(v.detail, 'utf8') <= 999);
  seen.push(v.detail);
}
const joined = seen.join('\n');
assert('all pages together contain the tool output', joined.includes('TOOLRESULT-MARKER'));
assert('all pages together contain the user prompt', joined.includes('What is new in AI'));
assert(
  'pages are contiguous (no duplicate bodies)',
  seen.every((t, i) => i === 0 || t !== seen[i - 1]),
);
assert(
  'a single-screen transcript stays at one page',
  agentsMasterDetailView({
    agents: [mkAgent('a1', 'Alpha')],
    sessions: [mkSession('s1', 'a1', 'Short answer')],
    cursor: 0,
    focus: 'detail',
    detailPage: 0,
    status: '',
  }).detailPages === 1,
);

// The firmware font has no emoji: an unsupported code point renders as a tofu
// box and still costs bytes, so the detail pane must stay inside the glyph set
// the design guidelines document as safe (arrows, box drawing, bullets, dashes).
const ALLOWED = new Set([
  ...'─▲△▶▷▼▽◀◁●○■□★☆╭╮╯╰│━█▇▆▅▄▃▂▁·—–…•≤×−→',
]);
const offenders = new Set();
for (const text of seen) {
  for (const ch of text) if (ch.charCodeAt(0) > 126 && !ALLOWED.has(ch)) offenders.add(ch);
}
assert(
  'detail pane uses only firmware-supported glyphs',
  offenders.size === 0,
  [...offenders].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(' '),
);

// Tool entries are labelled `[toolname] ` on the glasses (ASCII, so it always
// draws) and the union of pages must actually contain that label.
assert('tool entries are labelled [name]', joined.includes('[tavily_search]'));

// Emoji arriving from a search result or the model must be stripped, not drawn
// as a tofu box that also burns its UTF-8 bytes.
const emojiSession = {
  id: 's9',
  agentId: 'a9',
  title: 's9',
  status: 'done',
  createdAt: 0,
  updatedAt: 0,
  messages: [
    { role: 'user', content: 'news?', at: 0 },
    { role: 'assistant', content: '🔧 📅 📰 📌 Tools & AI news', at: 1 },
  ],
};
const emojiView = agentsMasterDetailView({
  agents: [mkAgent('a9', 'Emoji')],
  sessions: [emojiSession],
  cursor: 0,
  focus: 'detail',
  detailPage: 0,
  status: '',
}).detail;
assert(
  'emoji from model output is stripped',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(emojiView) && emojiView.includes('Tools & AI news'),
  emojiView,
);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
