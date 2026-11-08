#!/usr/bin/env node
// FLEET-REPAIR harness — which agents get a tool, and what the starters may say.
//
// WHY THIS EXISTS
//   Twelve of the twenty agents on the live hub held no tool that could fetch
//   anything: nine carried only `tool-jev` (a RANKER — it judges text you hand
//   it) and three carried nothing at all. Their prompts say "search the web and
//   report"; with no fetching tool there is no search, and the run reads exactly
//   like an agent with nothing to say. That is the bug this repair undoes.
//
//   The repair is deliberately NARROW, and narrowness is the thing worth pinning:
//     - it only ADDS, so it cannot take a capability away;
//     - it never touches an agent that already has any non-jev tool;
//     - it never picks `jev` as the thing to add.
//   A helpful-looking repair that quietly re-wired working agents would be
//   indistinguishable from damage, and it would be invisible until an answer came
//   back wrong.
//
//   The starters are pinned for a different reason: their text is drawn on the
//   GLASSES, which have no emoji glyphs and a ten-line canvas. An emoji in a
//   starter is not a style problem, it is a row of empty boxes on the wearer's
//   face, and ASCII-only is the only cheap way to prevent it.
//
// Run: node tools/agent-repair-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
};
const checkTrue = (label, got) => check(label, got === true, true);

// ── bundle the REAL modules ─────────────────────────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'agent-repair-sim-'));
const outfile = join(out, 'repair.mjs');
await build({
  stdin: {
    contents: `
export { planToolRepair } from './agent-repair.ts';
export { STARTER_AGENTS, starterKinds } from './agent-starters.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
});
const { planToolRepair, STARTER_AGENTS, starterKinds } = await import(pathToFileURL(outfile).href);

// ── fixtures ────────────────────────────────────────────────────────────────
const tools = [
  { id: 'tool-jev', name: 'jev', kind: 'jev', description: 'rank' },
  { id: 'tool-web', name: 'web', kind: 'web', description: 'search' },
  { id: 'tool-docs', name: 'docs', kind: 'docs', description: 'docs' },
  { id: 'tool-files', name: 'files', kind: 'files', description: 'files' },
];
const agent = (name, toolIds) => ({ id: `id-${name}`, name, systemPrompt: '', prompt: '', toolIds });

// ── the rule ───────────────────────────────────────────────────────────────
const onlyJev = planToolRepair([agent('Weather', ['tool-jev'])], tools);
check('an agent holding only jev is repaired', onlyJev.map((r) => r.name), ['Weather']);
check('and gets web search', onlyJev[0].add, ['tool-web']);
checkTrue('with a reason a human can read', /judge text but not obtain/.test(onlyJev[0].reason));

const nothing = planToolRepair([agent('Gaming', [])], tools);
check('an agent with no tools is repaired', nothing.length, 1);

const hasWeb = planToolRepair([agent('News', ['tool-web'])], tools);
check('an agent that can already fetch is LEFT ALONE', hasWeb, []);

check('docs counts as a way out', planToolRepair([agent('Docsy', ['tool-docs'])], tools), []);
check('files counts as a way out', planToolRepair([agent('Filer', ['tool-files'])], tools), []);
check('jev AND web is left alone', planToolRepair([agent('Both', ['tool-jev', 'tool-web'])], tools), []);

// A tool id with no row is a dangling reference, not a capability. This is the
// case that looks configured on screen and fails at run time.
check(
  'a dangling tool id does not count as a capability',
  planToolRepair([agent('Ghost', ['tool-deleted'])], tools).length,
  1,
);

// The pick is web first, any non-jev second, and never jev.
const noWeb = [tools[0], tools[2]];
check('with no web tool, the first non-jev tool is used', planToolRepair([agent('X', [])], noWeb)[0].add, ['tool-docs']);
check('a catalogue of only jev yields NO plan', planToolRepair([agent('X', [])], [tools[0]]), []);
check('an empty catalogue yields NO plan', planToolRepair([agent('X', [])], []), []);
check('no agents, no plan', planToolRepair([], tools), []);

// The live shape: 20 agents, 9 with only jev, 3 with none -> exactly 12 repaired.
const live = [
  ...Array.from({ length: 8 }, (_, i) => agent(`Web${i}`, ['tool-jev', 'tool-web'])),
  ...Array.from({ length: 9 }, (_, i) => agent(`JevOnly${i}`, ['tool-jev'])),
  ...Array.from({ length: 3 }, (_, i) => agent(`Bare${i}`, [])),
];
check('the live shape repairs exactly the 12 that cannot fetch', planToolRepair(live, tools).length, 12);
check(
  'and never touches the 8 that already can',
  planToolRepair(live, tools).filter((r) => r.name.startsWith('Web')).length,
  0,
);
checkTrue(
  'every repair only ADDS',
  planToolRepair(live, tools).every((r) => r.add.length > 0),
);

// ── the starters ────────────────────────────────────────────────────────────
check('five starters ship', STARTER_AGENTS.length, 5);
const names = STARTER_AGENTS.map((s) => s.name);
check('names are unique, case-insensitively', new Set(names.map((n) => n.toLowerCase())).size, names.length);
check(
  'the expected five are present',
  names.sort(),
  ['Brief Composer', 'Commitment Keeper', 'Decision Journal', 'Fleet Auditor', 'Watchkeeper'],
);

const KINDS = new Set(['web', 'http', 'jev', 'files', 'todo', 'docs', 'notes', 'location', 'tavily']);
for (const s of STARTER_AGENTS) {
  checkTrue(`${s.name}: ASCII only (the glasses have no emoji glyphs)`, /^[\x20-\x7E\s]*$/.test(s.systemPrompt + s.prompt));
  checkTrue(`${s.name}: has a system prompt`, s.systemPrompt.trim().length > 200);
  checkTrue(`${s.name}: has a trigger prompt`, s.prompt.trim().length > 0 && s.prompt.length < 120);
  checkTrue(`${s.name}: attaches at least one tool`, s.kinds.length > 0);
  checkTrue(`${s.name}: attaches only real tool kinds`, s.kinds.every((k) => KINDS.has(k)));
  checkTrue(`${s.name}: says why anyone would want it`, s.why.trim().length > 20);
  checkTrue(`${s.name}: names a cadence`, s.cadence.trim().length > 0);
  // The output cap is a GLASSES constraint, not a token-saving one: ten lines at
  // 27px is the whole canvas, so a prompt with no ceiling produces a run the
  // wearer has to scroll.
  checkTrue(`${s.name}: states an output ceiling`, /\b(word|line)s?\b.*\b(maximum|max|at most|limit)|\b(maximum|max|at most|limit)\b.*\b(word|line)s?\b/i.test(s.systemPrompt));
}

// The three that write a document must carry the docs tool, or they cannot do the
// one thing that makes them different from the twenty research agents.
for (const name of ['Brief Composer', 'Commitment Keeper', 'Decision Journal', 'Fleet Auditor']) {
  const s = STARTER_AGENTS.find((a) => a.name === name);
  checkTrue(`${name}: can write to the wearer's docs`, s.kinds.includes('docs'));
}
checkTrue(
  'every starter uses a faculty that is not research',
  STARTER_AGENTS.every((s) => s.kinds.includes('docs') || s.kinds.includes('jev')),
);

const kinds = starterKinds();
checkTrue('the needed kinds resolve from the catalogue', kinds.includes('docs') && kinds.includes('web'));
check('starterKinds is de-duplicated', kinds.length, new Set(kinds).size);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
