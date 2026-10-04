#!/usr/bin/env node
// Hub tools harness — the To-Do / Docs / Notes tools an AGENT can call.
//
// WHY THIS EXISTS:
//   Agent runs execute server-side in the relay. Before this, the relay could
//   reach the web, the Jarvis document gateway and jev — but not the one thing it
//   was already HOLDING: `HubState`. So "have my agent add that to my list" had
//   no route at all, while the same request spoken to Jarvis worked, because
//   Jarvis runs in the client where the store lives.
//
//   Three tools close that gap. This asserts the semantics the wearer will
//   actually feel (add, tick, rename, delete, append, read-with-resume), that a
//   read can never rewrite the hub, that a failure can never half-apply, that the
//   reducer does not mutate the state it was handed, and that the relay and the
//   panel are wired to exactly these tools — counted inside the region that owns
//   the behaviour, not with a loose regex over the whole file.
//
// Run: node tools/hub-tools-sim.mjs

import { readFileSync } from 'node:fs';
// The location tool is a relay tool like the hub ones, and this harness owns the
// seed list, so the kind comes from the module that dispatches it rather than
// being spelled 'location' here.
import { LOCATION_KIND } from '../../web/server/location-tool.mjs';
import {
  HUB_TOOL_KINDS,
  HUB_TOOL_NAMES,
  hubToolSchema,
  hubToolSummary,
  isHubTool,
  normalizeHub,
  readFrom,
  resolveIndex,
  runHubTool,
  short,
  splitItems,
} from '../../web/server/hub-tools.mjs';

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  assert(
    label,
    got === want,
    got === want ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
const deepEq = (label, got, want) => eq(label, JSON.stringify(got), JSON.stringify(want));
const has = (label, haystack, needle) => {
  const found = String(haystack).includes(needle);
  return assert(label, found, found ? '' : `\n      missing: ${needle}`);
};

/**
 * The source of ONE top-level function.
 *
 * Slicing matters here: a loose regex over the whole file would also match the
 * comments that DESCRIBE a rule, and the previous harness for this area passed
 * on text that was not the code it claimed to check.
 *
 * `export ` is optional because nearly every function in `src/` is exported —
 * without it the search for the NEXT function matched nothing at all for those
 * files and the "slice" silently ran to the end of the file, which turns every
 * assertion over it into a check against unrelated code.
 */
const fnSource = (src, name) => {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return '';
  const next = src.slice(start + 1).search(/\n(?:export )?(?:async )?function \w+/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
};

/**
 * Pull a `words: /…/i` literal out of a seed block and rebuild the RegExp, so
 * the vocabulary can be TESTED against phrases rather than pattern-matched as
 * source text.
 */
const wordsOf = (src, from, to) => {
  const seg = src.slice(src.indexOf(from), src.indexOf(to));
  const m = /words:\s*(\/[\s\S]*?\/[a-z]*)/.exec(seg);
  if (!m) return null;
  const last = m[1].lastIndexOf('/');
  return new RegExp(m[1].slice(1, last), m[1].slice(last + 1));
};

const relaySrc = readFileSync(new URL('../../web/server/local-sse.mjs', import.meta.url), 'utf8');
const typesSrc = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const panelSrc = readFileSync(new URL('../src/web/AgentsPanel.tsx', import.meta.url), 'utf8');
const capSrc = readFileSync(new URL('../src/ai/capabilities/agents.ts', import.meta.url), 'utf8');

const tool = (kind, name) => ({ id: `tool-${kind}`, name, kind, description: '' });

/** A hub with one of everything, so a miss is distinguishable from an empty hub. */
const seeded = () =>
  normalizeHub({
    activeSection: 'todo',
    sections: {
      todo: [
        { id: 't1', text: 'Buy milk', done: false },
        { id: 't2', text: 'File taxes', done: true },
      ],
      docs: [
        { id: 'd1', title: 'Standup notes', content: 'first', updatedAt: 1 },
        { id: 'd2', title: 'Trip plan', content: 'second', updatedAt: 2 },
      ],
      files: [{ id: 'f1', title: 'Report', agent: 'a', url: 'https://x/y', size: 9, updatedAt: 3 }],
      notes: 'hello',
    },
    activeDocId: 'd2',
    updatedAt: 5,
  });

/** Run and return the result; throws if the reducer blew up, which is a failure. */
const run = (kind, args, hub) => {
  try {
    return runHubTool(tool(kind, kind), args, hub);
  } catch (err) {
    return { ok: false, text: `THREW: ${err instanceof Error ? err.message : String(err)}`, threw: true };
  }
};

// ── 1. normalizeHub is total ────────────────────────────────────────────────
console.log('\n§1  normalizeHub never throws and never invents data');
deepEq('a null hub becomes an empty one', normalizeHub(null).sections.todo, []);
deepEq('a undefined hub becomes an empty one', normalizeHub(undefined).sections.docs, []);
eq('a null hub has empty notes', normalizeHub(null).sections.notes, '');
eq('a null hub opens nothing', normalizeHub(null).activeDocId, null);
deepEq('a partial hub keeps what it has', normalizeHub({ sections: { todo: [{ id: 'a', text: 'x', done: false }] } }).sections.todo.length, 1);
deepEq('a partial hub gets the missing collections', normalizeHub({ sections: { todo: [] } }).sections.docs, []);
deepEq(
  'a junk collection is replaced, not trusted',
  normalizeHub({ sections: { todo: 'nope', docs: 7, notes: 3 } }).sections,
  { todo: [], docs: [], files: [], notes: '' },
);
eq('an unknown section id is preserved as-is', normalizeHub({ activeSection: 'docs' }).activeSection, 'docs');

// ── 2. small helpers ────────────────────────────────────────────────────────
console.log('\n§2  short / splitItems / readFrom');
eq('short clips and ellipsises', short('abcdefghij', 5), 'abcd\u2026');
eq('short collapses whitespace', short('  a \n b  '), 'a b');
deepEq('one line is one task, even with commas', splitItems('Buy milk, eggs and bread'), ['Buy milk, eggs and bread']);
deepEq('newlines split', splitItems('milk\neggs'), ['milk', 'eggs']);
deepEq('a leading bullet is stripped', splitItems('- milk\n* eggs'), ['milk', 'eggs']);
deepEq('blank lines are dropped', splitItems('milk\n\n   \neggs'), ['milk', 'eggs']);
deepEq('nothing in, nothing out', splitItems('   '), []);
eq('offset 0 stays 0', readFrom(0, 100), 0);
eq('a negative offset reads from the start', readFrom(-5, 100), 0);
eq('a NaN offset reads from the start', readFrom('wat', 100), 0);
eq('an offset past the end clamps to the end', readFrom(999, 100), 100);
eq('a fractional offset floors', readFrom(2.9, 100), 2);

// ── 3. resolveIndex is forgiving, in that order ──────────────────────────────
console.log('\n§3  resolveIndex');
const items = [
  { id: 'a', label: 'Buy milk' },
  { id: 'b', label: 'File taxes' },
  { id: 'c', label: 'Buy a new laptop' },
];
eq('a 1-based number', resolveIndex('2', items), 1);
eq('an out-of-range number is NOT an index', resolveIndex('9', items), -1);
eq('an id', resolveIndex('c', items), 2);
eq('an exact title', resolveIndex('File taxes', items), 1);
eq('a substring', resolveIndex('taxes', items), 1);
eq('all the words, in any order', resolveIndex('laptop new', items), 2);
eq('case-insensitive', resolveIndex('FILE TAXES', items), 1);
eq('nothing matches', resolveIndex('zzz', items), -1);
eq('an empty target matches nothing', resolveIndex('   ', items), -1);

// ── 4. To-Do ────────────────────────────────────────────────────────────────
console.log('\n§4  todo');
eq('an empty list says so', run('todo', { action: 'list' }, null).text, 'The to-do list is empty.');
eq('list is numbered and marked', run('todo', { action: 'list' }, seeded()).text.includes('1. [ ] Buy milk'), true);
eq('list counts the open ones', run('todo', { action: 'list' }, seeded()).text.includes('2 task(s), 1 still open'), true);
eq('list reports no state (a read cannot write)', run('todo', { action: 'list' }, seeded()).state, undefined);

const add1 = run('todo', { action: 'add', text: 'Call Sam' }, seeded());
eq('add succeeds', add1.ok, true);
eq('add appends', add1.state.sections.todo.length, 3);
eq('add keeps the existing items', add1.state.sections.todo[0].text, 'Buy milk');
eq('add stamps the new one as open', add1.state.sections.todo[2].done, false);
eq('add mints an id', typeof add1.state.sections.todo[2].id === 'string' && add1.state.sections.todo[2].id.length > 0, true);
eq('add reports the count', add1.text.includes('3 task(s)'), true);

const addMulti = run('todo', { action: 'add', text: 'one\ntwo\nthree' }, null);
eq('multi-add adds all three', addMulti.state.sections.todo.length, 3);
eq('multi-add says how many', addMulti.text.includes('Added 3 tasks'), true);
eq('add with no text fails', run('todo', { action: 'add', text: '  ' }, null).ok, false);
eq('add with no text writes nothing', run('todo', { action: 'add', text: '' }, null).state, undefined);

const tick = run('todo', { action: 'set_done', target: 'milk' }, seeded());
eq('set_done ticks by substring', tick.state.sections.todo[0].done, true);
eq('set_done leaves the other alone', tick.state.sections.todo[1].done, true);
const untick = run('todo', { action: 'set_done', target: '2', done: false }, seeded());
eq('set_done false reopens', untick.state.sections.todo[1].done, false);
eq('set_done true is the default', run('todo', { action: 'set_done', target: '1' }, seeded()).state.sections.todo[0].done, true);
const already = run('todo', { action: 'set_done', target: '2' }, seeded());
eq('an already-done task is a no-op', already.state, undefined);
eq('and it says so', already.text.includes('already done'), true);
eq('a miss is not ok', run('todo', { action: 'set_done', target: 'zzz' }, seeded()).ok, false);
eq('a miss lists what there was', run('todo', { action: 'set_done', target: 'zzz' }, seeded()).text.includes('Buy milk'), true);

const edit = run('todo', { action: 'edit', target: 't1', text: 'Buy oat milk' }, seeded());
eq('edit rewrites the text', edit.state.sections.todo[0].text, 'Buy oat milk');
eq('edit keeps the id', edit.state.sections.todo[0].id, 't1');
eq('edit without text fails', run('todo', { action: 'edit', target: 't1', text: ' ' }, seeded()).ok, false);

const removed = run('todo', { action: 'remove', target: '2' }, seeded());
eq('remove drops one', removed.state.sections.todo.length, 1);
eq('remove drops the right one', removed.state.sections.todo[0].id, 't1');
eq('remove says what it deleted', removed.text.includes('File taxes'), true);

const cleared = run('todo', { action: 'clear_done' }, seeded());
eq('clear_done keeps the open ones', cleared.state.sections.todo.length, 1);
eq('clear_done reports the count', cleared.text.includes('Cleared 1'), true);
eq('clear_done with nothing done is a no-op', run('todo', { action: 'clear_done' }, normalizeHub({ sections: { todo: [{ id: 'a', text: 'x', done: false }] } })).state, undefined);

const badTodo = run('todo', { action: 'explode' }, seeded());
eq('an unknown action fails', badTodo.ok, false);
eq('an unknown action lists the real ones', badTodo.text.includes('clear_done'), true);
eq('a missing action defaults to list', run('todo', {}, seeded()).text.includes('Buy milk'), true);

// ── 5. Docs ─────────────────────────────────────────────────────────────────
console.log('\n§5  docs');
eq('no documents says so', run('docs', { action: 'list' }, null).text, 'There are no saved documents.');
eq('list numbers the documents', run('docs', { action: 'list' }, seeded()).text.includes('1. Standup notes'), true);
eq('list marks the open one', run('docs', { action: 'list' }, seeded()).text.includes('\u2190 open'), true);
eq('read with no target reads the OPEN doc', run('docs', { action: 'read' }, seeded()).text.includes('second'), true);
eq('read by title', run('docs', { action: 'read', target: 'Standup' }, seeded()).text.includes('first'), true);
eq('read reports the size', run('docs', { action: 'read', target: 'Standup' }, seeded()).text.includes('(5 chars)'), true);

const bigDoc = normalizeHub({
  sections: { docs: [{ id: 'd1', title: 'Long', content: 'x'.repeat(20000), updatedAt: 1 }] },
});
const firstHalf = run('docs', { action: 'read', target: 'Long' }, bigDoc);
eq('a long read is bounded', firstHalf.text.includes('[read to 12000 of 20000'), true);
const secondHalf = run('docs', { action: 'read', target: 'Long', offset: 12000 }, bigDoc);
eq(
  'the resume offset returns exactly the remainder',
  secondHalf.text.slice(secondHalf.text.indexOf('\n') + 1).length,
  8000,
);
eq('and does not offer another page', secondHalf.text.includes('Read again'), false);
eq('an empty doc says so', run('docs', { action: 'read', target: 'Long' }, normalizeHub({ sections: { docs: [{ id: 'd1', title: 'Long', content: '', updatedAt: 1 }] } })).text, '"Long" is empty.');

const created = run('docs', { action: 'create', title: 'Ideas', content: 'a b c' }, seeded());
eq('create appends a document', created.state.sections.docs.length, 3);
eq('create opens it', created.state.activeDocId, created.state.sections.docs[2].id);
eq('create uses the given title', created.state.sections.docs[2].title, 'Ideas');
eq('create with no title derives one', run('docs', { action: 'create', content: 'Weekly review' }, null).state.sections.docs[0].title, 'Weekly review');
eq('create with nothing falls back to Untitled', run('docs', { action: 'create' }, null).state.sections.docs[0].title, 'Untitled');

const appended = run('docs', { action: 'append', target: 'Standup', content: 'second line' }, seeded());
eq('append keeps the old text', appended.state.sections.docs[0].content.startsWith('first'), true);
eq('append adds a newline', appended.state.sections.docs[0].content, 'first\nsecond line');
eq('append with no content fails', run('docs', { action: 'append', target: 'Standup', content: '' }, seeded()).ok, false);

const rewrote = run('docs', { action: 'set_content', target: 'd1', content: 'brand new' }, seeded());
eq('set_content replaces', rewrote.state.sections.docs[0].content, 'brand new');
eq('set_content touches only that doc', rewrote.state.sections.docs[1].content, 'second');

const renamed = run('docs', { action: 'rename', target: 'Trip', title: 'Iceland' }, seeded());
eq('rename sets the title', renamed.state.sections.docs[1].title, 'Iceland');
eq('rename without a title fails', run('docs', { action: 'rename', target: 'Trip', title: ' ' }, seeded()).ok, false);

const deleted = run('docs', { action: 'delete', target: 'Trip' }, seeded());
eq('delete drops the doc', deleted.state.sections.docs.length, 1);
eq('deleting the OPEN doc moves the pointer', deleted.state.activeDocId, 'd1');
const deletedOther = run('docs', { action: 'delete', target: 'Standup' }, seeded());
eq('deleting another doc leaves the pointer', deletedOther.state.activeDocId, 'd2');

const opened = run('docs', { action: 'open', target: 'Standup' }, seeded());
eq('open sets activeDocId', opened.state.activeDocId, 'd1');
eq('open switches the section too', opened.state.activeSection, 'docs');
eq('open changes no content', opened.state.sections.docs[0].content, 'first');
eq('a docs miss lists the titles', run('docs', { action: 'read', target: 'zzz' }, seeded()).text.includes('Trip plan'), true);
eq('a docs miss on an empty hub says so', run('docs', { action: 'read', target: 'zzz' }, null).text.includes('no saved documents'), true);
eq('an unknown docs action fails', run('docs', { action: 'explode' }, seeded()).ok, false);

// ── 6. Notes ────────────────────────────────────────────────────────────────
console.log('\n§6  notes');
eq('empty notes says so', run('notes', { action: 'read' }, null).text, 'The notes are empty.');
eq('read returns the blob', run('notes', { action: 'read' }, seeded()).text.includes('hello'), true);
eq('read reports the size', run('notes', { action: 'read' }, seeded()).text.includes('(5 chars)'), true);
const notesAppend = run('notes', { action: 'append', text: 'world' }, seeded());
eq('append adds a line', notesAppend.state.sections.notes, 'hello\nworld');
eq('append into empty notes does not add a leading newline', run('notes', { action: 'append', text: 'x' }, null).state.sections.notes, 'x');
eq('append with nothing fails', run('notes', { action: 'append', text: ' ' }, seeded()).ok, false);
eq('set_content replaces the blob', run('notes', { action: 'set_content', text: 'fresh' }, seeded()).state.sections.notes, 'fresh');
eq('clear empties it', run('notes', { action: 'clear' }, seeded()).state.sections.notes, '');
eq('clearing empty notes is a no-op', run('notes', { action: 'clear' }, null).state, undefined);
eq('an unknown notes action fails', run('notes', { action: 'explode' }, seeded()).ok, false);
eq('a note read is bounded too', run('notes', { action: 'read' }, normalizeHub({ sections: { notes: 'y'.repeat(20000) } })).text.includes('[read to 12000'), true);

// ── 7. Purity and the two-writes rule ───────────────────────────────────────
console.log('\n§7  the state it was handed is not mutated');
const before = seeded();
const snapshot = JSON.stringify(before);
run('todo', { action: 'add', text: 'new' }, before);
run('docs', { action: 'delete', target: 'Trip' }, before);
run('notes', { action: 'clear' }, before);
eq('a reducer call leaves the input untouched', JSON.stringify(before), snapshot);
const changed = run('todo', { action: 'add', text: 'new' }, before);
eq('and the input is still the old object', changed.state === before, false);
eq('the returned state is a fresh top-level object', changed.state.sections === before.sections, false);
deepEq('untouched collections ride through by reference', changed.state.sections.files, before.sections.files);

console.log('\n§8  what a call declares');
eq('a failed call never carries state', run('todo', { action: 'explode' }, seeded()).state, undefined);
eq('a miss never carries state', run('todo', { action: 'remove', target: 'zzz' }, seeded()).state, undefined);
eq('a no-op never carries state', run('todo', { action: 'set_done', target: '2' }, seeded()).state, undefined);
eq('every success text is non-empty', run('todo', { action: 'list' }, seeded()).text.length > 0, true);

// ── 9. The schemas ──────────────────────────────────────────────────────────
console.log('\n§9  hubToolSchema');
eq('todo names itself', hubToolSchema(tool('todo')).function.name, HUB_TOOL_NAMES.todo);
eq('docs names itself', hubToolSchema(tool('docs')).function.name, HUB_TOOL_NAMES.docs);
eq('notes names itself', hubToolSchema(tool('notes')).function.name, HUB_TOOL_NAMES.notes);
eq('a custom name wins', hubToolSchema(tool('todo', 'my_list')).function.name, 'my_list');
eq('only `action` is required', JSON.stringify(hubToolSchema(tool('docs')).function.parameters.required), '["action"]');
deepEq('the todo enum is the todo actions', hubToolSchema(tool('todo')).function.parameters.properties.action.enum, [
  'list',
  'add',
  'set_done',
  'edit',
  'remove',
  'clear_done',
]);
eq('the docs enum has open and delete', hubToolSchema(tool('docs')).function.parameters.properties.action.enum.includes('open'), true);
eq('the notes enum has clear', hubToolSchema(tool('notes')).function.parameters.properties.action.enum.includes('clear'), true);
eq('a tool description wins over the default', hubToolSchema({ kind: 'todo', description: 'mine' }).function.description, 'mine');
eq('a non-hub kind has no schema here', hubToolSchema(tool('http')), null);
eq('so does a missing tool', hubToolSchema(undefined), null);
deepEq('the kinds this module owns', [...HUB_TOOL_KINDS].sort(), ['docs', 'notes', 'todo']);
eq('isHubTool accepts a hub kind', isHubTool(tool('notes')), true);
eq('isHubTool rejects the gateway', isHubTool(tool('files')), false);
eq('isHubTool rejects nothing', isHubTool(null), false);
eq('the transcript summary names the action', hubToolSummary(tool('todo'), { action: 'add' }), 'jarvis_todo.add');

// ── 10. The relay is wired to this module, and only once ────────────────────
console.log('\n§10  relay wiring');
has('the relay imports the module', relaySrc, "from './hub-tools.mjs'");
// The relay takes the SCHEMA and the predicate from this module, and the reducer
// only through `applyHubTool` in hub-write.mjs. It must not import `runHubTool`
// itself: reaching the pure reducer without the write-through beside it is the
// exact mistake that let an agent's write land on a copy nobody read.
has('it imports the schema and the predicate', relaySrc, 'hubToolSchema, isHubTool');
eq('but not the bare reducer', /runHubTool[,}]/.test(relaySrc), false);
has('the write-through is the reducer’s only door', relaySrc, "from './hub-write.mjs'");
const schemaFn = relaySrc.slice(relaySrc.indexOf('function toolSchemaFor'), relaySrc.indexOf('async function llmOnce'));
has('toolSchemaFor delegates to hubToolSchema', schemaFn, 'hubToolSchema(t)');
assert(
  'and only inside an isHubTool guard',
  schemaFn.includes('isHubTool(t)') && schemaFn.indexOf('isHubTool(t)') < schemaFn.indexOf('httpToolSchema(t)'),
  'the hub branch must come BEFORE the REST fallback',
);

// The relay USED to keep a hub copy of its own and publish it from here. That
// copy is loaded once at boot from a git-ignored file, no client ever refreshed
// it, and in Docker it does not survive a restart — so every server-side hub
// tool wrote into a phantom, told the wearer it had worked, and the hub never
// heard about it. Only the wearer's own tap reached the hub, which is why adds,
// edits, ticks and deletes from the assistant were invisible everywhere else
// while the app-to-hub path stayed healthy. `publishHubState` is deleted; what
// replaces it is a write-through to the hub itself (web/server/hub-write.mjs,
// covered by tools/hub-write-sim.mjs). These assertions are the tombstone.
eq('publishHubState is gone, not merely unused', /function publishHubState/.test(relaySrc), false);
eq('and the refusal for want of a local copy went with it', /NO_HUB_STATE_MSG/.test(relaySrc), false);
eq(
  'the only hub state the relay still caches comes from a CLIENT',
  [...relaySrc.matchAll(/channel\.lastState\s*=/g)].length,
  1,
);

const runOnce = fnSource(relaySrc, 'runToolOnce');
// Up to the declared parameters only. The executor gained a fourth (the run
// context that carries the location snapshot), and pinning the whole signature
// made this assertion fail over a change that was not about the slice at all.
// What it checks is that the slice STARTS at the real function.
has(
  'the slice really is the executor',
  runOnce.startsWith('function runToolOnce(tool, rawArgs, signal'),
  true,
);
has('runToolOnce dispatches hub tools', runOnce, 'if (isHubTool(tool))');
// The executor must not touch the relay's copy of the hub at all: that copy is a
// bootstrap for the app, never a store for an agent's write.
eq('it no longer reads the relay copy', /getChannel\('hub'\)/.test(runOnce), false);
eq('it no longer reduces against one', /runHubTool\(/.test(runOnce), false);
eq('and it no longer publishes a state', runOnce.split('publishHubState(').length - 1, 0);
has('it delegates to the ONE write-through helper', runOnce, 'runHubToolOnce(tool, args, signal)');

const proxyAt = relaySrc.indexOf("url.pathname === '/api/tool'");
const proxy = relaySrc.slice(proxyAt, proxyAt + 4000);
has('the tool proxy knows hub tools too', proxy, 'if (isHubTool(body))');
has('and it goes through the SAME helper', proxy, 'runHubToolOnce(body, args, undefined)');
has('…so the two routes cannot drift apart', proxy, 'applied.ok');
// A READ is required (the helper has to fetch the hub before the reducer can
// act); what must never appear is a WRITE. Asserting on the bare substring
// conflated the two and would have forbidden the correct code.
eq('the proxy never WRITES the channel directly', /channel\.lastState\s*=/.test(proxy), false);
eq('and it does not refuse for want of a local copy', /NO_HUB_STATE_MSG/.test(proxy), false);

// ── 11. The client offers them, opt-in ──────────────────────────────────────
console.log('\n§11  client wiring');
has('the ToolKind union has todo', typesSrc, "| 'todo'");
has('the ToolKind union has docs', typesSrc, "| 'docs'");
has('the ToolKind union has notes', typesSrc, "| 'notes'");
has('an id constant per kind', typesSrc, "export const TODO_TOOL_ID = 'tool-todo';");
has('a docs id', typesSrc, "export const DOCS_TOOL_ID = 'tool-docs';");
has('a notes id', typesSrc, "export const NOTES_TOOL_ID = 'tool-notes';");
has('a todo factory', typesSrc, 'export function todoTool(): ToolDef {');
has('a docs factory', typesSrc, 'export function docsTool(): ToolDef {');
has('a notes factory', typesSrc, 'export function notesTool(): ToolDef {');
has('the docs tool warns it is not the gateway', typesSrc, 'to publish a page to a link, use the document-store tool instead');
// The opt-in invariant: a fresh install still holds ONE tool.
const emptyAt = typesSrc.indexOf('export function emptyAgentsState');
has(
  'the default catalogue is still just web search',
  typesSrc.slice(emptyAt, emptyAt + 200),
  'tools: [webSearchTool()]',
);
eq(
  'no hub seed is pre-attached',
  typesSrc.slice(emptyAt, emptyAt + 200).includes('todoTool(') ||
    typesSrc.slice(emptyAt, emptyAt + 200).includes('docsTool(') ||
    typesSrc.slice(emptyAt, emptyAt + 200).includes('notesTool('),
  false,
);

has('the voice path imports the todo seed', capSrc, 'todoTool,');
has('the voice path has a todo seed', capSrc, 'const TODO_SEED: SeedTool = {');
has('the voice path has a docs seed', capSrc, 'const DOCS_SEED: SeedTool = {');
has('the voice path has a notes seed', capSrc, 'const NOTES_SEED: SeedTool = {');
const seedList = capSrc.slice(capSrc.indexOf('const SEED_TOOLS: readonly SeedTool[]'), capSrc.indexOf('/**', capSrc.indexOf('const SEED_TOOLS: readonly SeedTool[]')));
// This check used to be a count with the number spelled out. The
// literal went stale the moment `location` was seeded — and a harness that has to
// be edited before it can notice a missing seed does not notice one. The expected
// set is assembled from the same sources the relay uses: HUB_TOOL_KINDS owns
// docs/notes/todo, and web, files, jev and the location kind are seeds of their
// own. Derived here rather than typed, so the NEXT kind added is caught by this
// assertion instead of requiring it to be updated.
const SEED_KINDS = ['web', ...HUB_TOOL_KINDS, 'files', 'jev', LOCATION_KIND].sort();
const offeredKinds = [
  ...new Set([...seedList.matchAll(/([A-Z]+)_SEED\b/g)].map((m) => m[1].toLowerCase())),
].sort();
deepEq('every kind the relay can execute is offered as a seed', offeredKinds, SEED_KINDS);
eq(
  'the gateway seed is resolved LAST, so "my documents" cannot mean it',
  seedList.indexOf('FILES_SEED') > seedList.indexOf('DOCS_SEED') &&
    seedList.indexOf('DOCS_SEED') > seedList.indexOf('TODO_SEED'),
  true,
);
// The vocabulary is TESTED, not pattern-matched: "the document store" is the
// gateway's phrase and must keep resolving to it, while "my documents" must not.
// Both seeds match "my documents", which is exactly why the docs seed is offered
// first — see the ordering assertion below.
const filesWords = wordsOf(capSrc, 'const FILES_SEED', 'const JEV_SEED');
const todoWords = wordsOf(capSrc, 'const TODO_SEED', 'const DOCS_SEED');
const docsWords = wordsOf(capSrc, 'const DOCS_SEED', 'const NOTES_SEED');
const notesWords = wordsOf(capSrc, 'const NOTES_SEED', 'const SEED_TOOLS');
eq('the files seed has words', filesWords !== null, true);
eq('the docs seed has words', docsWords !== null, true);
eq('the gateway keeps "the document store"', filesWords.test('the document store'), true);
eq('the docs tool does NOT claim "the document store"', docsWords.test('the document store'), false);
eq('the docs tool does claim "my documents"', docsWords.test('my documents'), true);
eq('and the gateway also matches "my documents"', filesWords.test('my documents'), true);
eq('the docs tool claims "docs tab"', docsWords.test('docs tab'), true);
eq('the to-do seed claims "my to-do list"', todoWords.test('my to-do list'), true);
eq('the to-do seed does not claim documents', todoWords.test('the document store'), false);
eq('the notes seed claims "notes"', notesWords.test('notes'), true);
eq('the notes seed does not claim documents', notesWords.test('the document store'), false);

has('the agent editor offers a todo chip', panelSrc, "{ kind: 'todo', label: 'To-do list', add: addTodoToAgent }");
has('the agent editor offers a docs chip', panelSrc, "{ kind: 'docs', label: 'Docs', add: addDocsToAgent }");
has('the agent editor offers a notes chip', panelSrc, "{ kind: 'notes', label: 'Notes', add: addNotesToAgent }");
has('the catalogue can seed a todo tool', panelSrc, "{ kind: 'todo', label: 'To-do list', make: todoTool }");
has('the catalogue can seed the docs tool', panelSrc, "{ kind: 'docs', label: 'Docs', make: docsTool }");
has('the catalogue can seed the notes tool', panelSrc, "{ kind: 'notes', label: 'Notes', make: notesTool }");
eq('the catalogue seeds are matched on KIND, not id', panelSrc.includes('t.kind === s.kind'), true);
has('the kind select can switch to todo', panelSrc, '<option value="todo">');
has('the kind select can switch to docs', panelSrc, '<option value="docs">');
has('the kind select can switch to notes', panelSrc, '<option value="notes">');
// The rules the earlier work established must survive this change.
has('jev is still attachable by name', panelSrc, 'const addJevToAgent = () => attachSeed(JEV_TOOL_ID, jevTool);');
has('jev is still a kind option', panelSrc, '<option value="jev">');
has('the skipped-rather-than-guessed copy is intact', panelSrc, 'reports that it was skipped rather than guessing');
eq(
  'agents-store.ts still never names a hub kind',
  readFileSync(new URL('../src/agents-store.ts', import.meta.url), 'utf8').includes("'todo'"),
  false,
);

// ── 12. Neither end of the sync may roll the list backwards ─────────────────
// This is the "my to-do list wiped itself" bug. A snapshot now arrives from the
// hub itself (`GET /hub`, via `adopt()`), and the rule that stops a wipe is the
// same one expressed differently: `applyRemote` may adopt ONCE, at first load,
// and never again. The old publish-war guard — comparing `updatedAt` against the
// last stamp we pushed to the relay — went with the hub channel it defended.
//
// Every assertion below used to be written against that retired design and had
// rotted into passing vacuously: `slice(-1, -1)` is the empty string, so "a
// refused frame returns" and "the replace is unreachable" were true of a slice
// with no code in it at all. They failed only once the slice was confined, and
// they failed for the right reason: the code they describe no longer exists.
console.log('\n§12  a remote snapshot may never move the list backwards');
const storeSrc = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');
// `fnSource` ends at the NEXT declaration, which here is a 500-character
// deprecation comment — so its idea of "applyRemote" is mostly prose, and a
// negative assertion over prose is as vacuous as one over the empty string.
// This bounds to the closing brace at column 0 instead, and returns '' on a miss
// so a broken slice shows up as a FAILURE rather than as a permissive one.
const fnBody = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = src.indexOf('\n}', start);
  return end < 0 ? '' : src.slice(start, end + 2);
};
const applyRemoteFn = fnBody(storeSrc, 'applyRemote');
assert(
  'the slice really is applyRemote, not the tail of the file',
  applyRemoteFn.startsWith('function applyRemote(next: HubState): void {') && applyRemoteFn.length < 400,
  `len ${applyRemoteFn.length}`,
);
has('it adopts only at first load', applyRemoteFn, 'if (hubLoaded || !next?.sections) return;');
assert(
  'and the guard runs BEFORE the adoption',
  applyRemoteFn.indexOf('if (hubLoaded || !next?.sections) return;') < applyRemoteFn.indexOf('state = { ...next'),
  'adopting a second snapshot is how one device overwrites another',
);
has('an adopted snapshot is stamped defensively', applyRemoteFn, 'Number(next.updatedAt) || Date.now()');
has('it is persisted', applyRemoteFn, 'persist(state);');
has('and it is emitted', applyRemoteFn, 'emit();');
// The one-way push loop is what made a wipe permanent, so its machinery must be
// absent rather than merely unreachable.
eq(
  'the publish-war machinery is gone',
  /lastPublishedAt|sawServerState|schedulePublish/.test(applyRemoteFn),
  false,
);
// Pushing the LOCAL copy at the relay when it reported an empty snapshot is the
// other half of the same bug: "my list is the truth and the server is empty" is
// how one device overwrites another's data. Seeding is a hub-side import now, so
// both entry points the relay's SSE wiring still calls must be inert.
const seedFn = fnBody(storeSrc, 'seedIfEmpty');
const handshakeFn = fnBody(storeSrc, 'noteServerHandshake');
assert(
  'the local-copy pushers still exist for the SSE wiring',
  seedFn.length > 0 && seedFn.length < 400 && handshakeFn.length > 0 && handshakeFn.length < 400,
  `seed ${seedFn.length} handshake ${handshakeFn.length}`,
);
eq(
  'but they push nothing anywhere',
  /\b(fetch|publishState|pushState|send|post)\s*\(/.test(seedFn + handshakeFn),
  false,
);
// A MISSING hub must never be treated as an EMPTY one: the reducer is total, so
// it normalizes null to an empty store, and every mutation stamps `updatedAt:
// Date.now()` — a near-empty state that outranks the real copy on the phone.
// That guarantee used to be a refusal against the relay's local copy, and it is
// now the reason the applier READS the hub first and refuses when the read
// fails. The wipe itself is covered directly by tools/hub-write-sim.mjs §5;
// what belongs here is that no branch of the relay reduces against a hub it
// never fetched.
eq('the executor no longer refuses for want of a local copy', /NO_HUB_STATE_MSG/.test(runOnce), false);
assert(
  'the executor reaches the hub only through the helper',
  runOnce.indexOf('runHubToolOnce(tool, args, signal)') > 0 && runOnce.split('publishHubState(').length - 1 === 0,
  'a second path to the hub is a second way to lose a write',
);
// And the relay must not accept a backwards publish either, or the client-side
// guard just turns a wipe into an endless republish war.
const publishRegion = relaySrc.slice(
  relaySrc.indexOf('Publish a HubState snapshot'),
  relaySrc.indexOf('SSE stream (owner browser'),
);
const guardAt = publishRegion.indexOf('incomingStamp < cachedStamp');
assert('the relay compares the incoming stamp with the cached one', guardAt > 0);
has('the relay guard needs a cached stamp', publishRegion, 'cachedStamp !== null');
has('and an incoming one', publishRegion, 'incomingStamp !== null');
assert(
  'the guard runs BEFORE the cache write',
  guardAt < publishRegion.indexOf('void persistState(channel.name, state)'),
  'persisting an older snapshot is the wipe',
);
has('a refused publish re-broadcasts the CURRENT copy', publishRegion, 'state: channel.lastState');
has('and the caller is told it was stale', publishRegion, 'stale: true');

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);
