#!/usr/bin/env node
// Live-sync harness — the stream must inform the UI, never type for it.
//
// WHY THIS EXISTS:
//   The complaint was not that sync was missing, it was that sync *moved things*:
//   the tab switched by itself, the selected row flipped between an old and a new
//   value, and a field being typed into lost its letters mid-word. None of those
//   throw, none of them show up in a type check, and all of them come back the
//   moment someone "simplifies" an adopt or an input binding. So the rules are
//   pinned here:
//
//     1. A row being edited keeps its place in a newest-first master list.
//     2. A hub snapshot may set which page a surface shows ONCE. After that the
//        tab and the open document belong to the person looking at the screen.
//     3. Every editor whose value comes from the hub is bound to a local draft,
//        so a refresh cannot overwrite a keystroke.
//
//   (1) is behavioural: the sorters are pure and bundled like the other harnesses
//   reach into `src/`. (2) and (3) are source-shape checks on purpose — the
//   alternative is a React tree, and the failure being guarded is an ABSENT guard,
//   which a render assertion states far more weakly than an explicit one.
//
// Run: node tools/live-view-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let passed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  }
}

// ── loader ────────────────────────────────────────────────────────────────
const outfile = join(mkdtempSync(join(tmpdir(), 'live-view-sim-')), 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './web/doc-list.ts';\nexport { orderedAgents } from './types.ts';`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile,
  logLevel: 'silent',
});
const { orderDocs, orderedAgents } = await import(pathToFileURL(outfile).href);

const src = (p) => readFileSync(p, 'utf8');
const storeSrc = src('src/store.ts');
const appSrc = src('src/web/App.tsx');
const agentsSrc = src('src/web/AgentsPanel.tsx');
const toolsSrc = src('src/web/ToolsPanel.tsx');
const draftSrc = src('src/web/draft.ts');

const doc = (id, updatedAt, title = id) => ({ id, title, content: '', updatedAt });
const agent = (id, updatedAt, name = id) => ({ id, name, updatedAt });

// ── 1. The master lists ───────────────────────────────────────────────────
console.log('\n§1  a row being edited keeps its place');

const lib = [doc('a', 100), doc('b', 300), doc('c', 200)];
check('newest first, with no pin', orderDocs(lib).map((d) => d.id).join('') === 'bca');

const pinned = orderDocs(lib, { id: 'a', at: 100 });
check('a pin changes nothing on its own', pinned.map((d) => d.id).join('') === 'bca');

// The wearer opens `a` and types: every keystroke restamps it to "now".
const edited = lib.map((d) => (d.id === 'a' ? doc('a', 9_999) : d));
check(
  'without a pin the row you are typing in jumps to the top',
  orderDocs(edited)[0].id === 'a',
);
check(
  'with a pin it stays exactly where you left it',
  orderDocs(edited, { id: 'a', at: 100 }).map((d) => d.id).join('') === 'bca',
);
check(
  'the other rows are still live — a peer edit still reorders them',
  orderDocs([doc('a', 9_999), doc('b', 300), doc('c', 50_000)], { id: 'a', at: 100 })
    .map((d) => d.id)
    .join('') === 'cba',
);
check('a pin naming a missing row is inert', orderDocs(lib, { id: 'zz', at: 1 }).map((d) => d.id).join('') === 'bca');
check('no usable stamp still sorts last', orderDocs([doc('x', 0), doc('y', 5)])[1].id === 'x');
check('NaN never scrambles the list', orderDocs([doc('x', NaN), doc('y', 5)])[1].id === 'x');

check('agents obey the same rule', orderedAgents([agent('a', 100), agent('b', 300)]).map((x) => x.id).join('') === 'ba');
check(
  'an edited agent stays put too',
  orderedAgents([agent('a', 9_999), agent('b', 300)], { id: 'a', at: 100 }).map((x) => x.id).join('') === 'ba',
);

// ── 2. A snapshot may seed the view once ──────────────────────────────────
console.log('\n§2  the hub seeds the view once, then leaves it alone');

check(
  'adopt() keeps the local section after the first snapshot',
  /activeSection:\s*seedingView \? snap\.activeSection : state\.activeSection/.test(storeSrc),
);
check(
  'adopt() keeps the locally open document',
  /activeDocId:\s*seedingView \? snap\.activeDocId : keepDoc/.test(storeSrc),
);
check(
  'only the FIRST snapshot seeds (the flag exists and is set)',
  /let adoptedViewOnce = false;/.test(storeSrc) && /adoptedViewOnce = true;/.test(storeSrc),
);
check(
  'the open doc is still dropped when the hub stops listing it',
  /snap\.sections\.docs\.some\(\(d\) => d\.id === state\.activeDocId\) \? state\.activeDocId : null/.test(storeSrc),
);
check(
  'a doc list read keeps a rename that is still in flight',
  /keepLocalTitle/.test(storeSrc) && /Number\(local\.updatedAt \?\? 0\) > Number\(m\.updatedAt \?\? 0\)/.test(storeSrc),
);

// ── 3. Every hub-bound editor is drafted ──────────────────────────────────
console.log('\n§3  no hub-bound field is writable by the network');

check('the draft hook exists and is exported', /export function useRemoteDraft/.test(draftSrc));
check('it adopts remote text only when idle', /if \(editing\) return;/.test(draftSrc));
check('it ignores a value it has already seen', /if \(value === lastRemote\.current\) return;/.test(draftSrc));

check('doc title is drafted', /useRemoteDraft\(active\?\.title \?\? ''/.test(appSrc));
check('doc body is drafted', /useRemoteDraft\(active\?\.content \?\? ''/.test(appSrc));
check('notes are drafted', /useRemoteDraft\(state\.sections\.notes/.test(appSrc));
check('a to-do row is drafted', /function TodoText\(/.test(appSrc) && /useRemoteDraft\(text/.test(appSrc));
check('agent name is drafted', /useRemoteDraft\(agent\.name/.test(agentsSrc));
check('agent system prompt is drafted', /useRemoteDraft\(agent\.systemPrompt/.test(agentsSrc));
check('agent trigger prompt is drafted', /useRemoteDraft\(agent\.prompt/.test(agentsSrc));
check('agent model override is drafted', /useRemoteDraft\(agent\.model \?\? ''/.test(agentsSrc));
check('tool name is drafted', /useRemoteDraft\(tool\.name/.test(toolsSrc));
check('tool description is drafted', /useRemoteDraft\(tool\.description/.test(toolsSrc));
check('REST url is drafted', /useRemoteDraft\(tool\.url \?\? ''/.test(toolsSrc));
check('REST headers are drafted', /useRemoteDraft\(tool\.headers \?\? ''/.test(toolsSrc));
check('REST body template is drafted', /useRemoteDraft\(tool\.bodyTemplate \?\? ''/.test(toolsSrc));

// A field bound straight to the hub record is the bug: it can be repainted from
// under the caret. These bindings must not come back.
console.log('\n§4  the old direct bindings are gone');
for (const [label, pattern, text] of [
  ['doc title', /value=\{active\.title\}/, appSrc],
  ['doc body', /value=\{active\.content\}/, appSrc],
  ['notes', /value=\{state\.sections\.notes\}/, appSrc],
  ['todo text', /value=\{t\.text\}/, appSrc],
  ['agent name', /value=\{agent\.name\}/, agentsSrc],
  ['agent system prompt', /value=\{agent\.systemPrompt\}/, agentsSrc],
  ['tool name', /value=\{tool\.name\}/, toolsSrc],
  ['rest url', /value=\{tool\.url \?\? ''\}/, toolsSrc],
]) {
  check(`${label} is not bound straight to hub state`, !pattern.test(text));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
