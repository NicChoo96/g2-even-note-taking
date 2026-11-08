#!/usr/bin/env node
// Docs library harness — order and filter of the master list.
//
// WHY THIS EXISTS:
//   The Docs page was a wall of title chips with no order and no search, on a
//   library where the titles are long and similar. The fix is a list sorted
//   newest-first and filtered on title OR body — and both of those fail SILENTLY:
//   a wrong comparator does not throw, it just puts an old document at the top,
//   and the wearer opens the wrong page. So the rules are asserted here rather
//   than eyeballed on a screen.
//
// Run: node tools/doc-list-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Bundled rather than imported: the module is TypeScript, and the other harnesses
// that reach into `src/` bundle it the same way so there is one loader to reason
// about. `./web/doc-list.ts` is pure — no store, no React — so nothing is mocked.
const outfile = join(mkdtempSync(join(tmpdir(), 'doc-list-sim-')), 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './web/doc-list.ts';`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
});

const { orderDocs, filterDocs, whenLabel, docWords } = await import(pathToFileURL(outfile).href);

let pass = 0;
const failures = [];

function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    return;
  }
  failures.push(`${label}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
}

const doc = (id, title, content, updatedAt) => ({ id, title, content, updatedAt });
const titles = (list) => list.map((d) => d.id);

// ── Newest first ───────────────────────────────────────────────────────────
const mixed = [
  doc('old', 'Crime and the R1 ring', 'text', 1_700_000_000_000),
  doc('newest', 'Delta risk', 'text', 1_700_900_000_000),
  doc('middle', 'Trade folder naming', 'text', 1_700_500_000_000),
];
check('newest is first', titles(orderDocs(mixed)), ['newest', 'middle', 'old']);
check('the oldest is last', titles(orderDocs(mixed))[2], 'old');
check('the input array is not mutated', titles(mixed), ['old', 'newest', 'middle']);

// A row with no stamp cannot be allowed to jump the queue.
const unstamped = [
  doc('stamp', 'Has a date', '', 1_700_000_000_000),
  doc('none', 'No date at all', '', undefined),
  doc('zero', 'Zero date', '', 0),
];
check('a missing stamp sorts last, not first', titles(orderDocs(unstamped))[0], 'stamp');
check('missing and zero stamps keep the tail', titles(orderDocs(unstamped)).slice(1).sort(), ['none', 'zero']);

// Equal stamps must not scramble: a stable sort keeps the store's order, which is
// the order the glasses are indexing into at the same moment.
const sameStamp = [doc('a', 'A', '', 500), doc('b', 'B', '', 500), doc('c', 'C', '', 500)];
check('equal stamps keep their order', titles(orderDocs(sameStamp)), ['a', 'b', 'c']);

check('an empty library is empty', orderDocs([]), []);

// ── Filter: title OR body ──────────────────────────────────────────────────
const library = [
  doc('d1', 'Punishment That Does Not Bite', 'company origins and penalties', 1),
  doc('d2', 'Delta Risk', 'spot exposure and PnL', 2),
  doc('d3', 'Japanese Curry', 'minced chicken, rice cooker', 3),
];
check('a title match is found', titles(filterDocs(library, 'delta')), ['d2']);
check('a body match is found', titles(filterDocs(library, 'exposure')), ['d2']);
check('the search is case-insensitive', titles(filterDocs(library, 'PUNISHMENT')), ['d1']);
check('a trailing space still matches', titles(filterDocs(library, '  curry  ')), ['d3']);
check('no match finds nothing', filterDocs(library, 'zzzz'), []);
check('an empty query keeps everything', titles(filterDocs(library, '')), ['d1', 'd2', 'd3']);
check('a whitespace-only query keeps everything', titles(filterDocs(library, '   ')), ['d1', 'd2', 'd3']);
check('filter does not mutate its input', titles(library), ['d1', 'd2', 'd3']);

// The two compose: the order survives filtering, which is what the page renders.
// All three docs contain an "a" somewhere (company / Delta / Japanese), so the
// filtered list is the whole sorted list — the point is that d3 stays first.
const ordered = orderDocs(library);
check('filtering a sorted list keeps it sorted', titles(filterDocs(ordered, 'a')), ['d3', 'd2', 'd1']);
check('a narrower filter keeps the sorted remainder', titles(filterDocs(ordered, 'curry')), ['d3']);

// ── Row hints ──────────────────────────────────────────────────────────────
const NOW = 1_700_000_000_000;
check('a doc written a moment ago', whenLabel(NOW - 5_000, NOW), 'just now');
check('minutes', whenLabel(NOW - 5 * 60_000, NOW), '5m ago');
check('hours', whenLabel(NOW - 3 * 3_600_000, NOW), '3h ago');
check('days', whenLabel(NOW - 2 * 86_400_000, NOW), '2d ago');
check('no stamp reads as unknown', whenLabel(0, NOW), 'unknown');
check('a future stamp does not say "-3m ago"', whenLabel(NOW + 60_000, NOW), 'just now');

check('word count of a body', docWords(doc('x', 'X', 'one two three', 1)), 3);
check('word count of an empty body', docWords(doc('x', 'X', '   ', 1)), 0);
check('word count survives missing content', docWords({ id: 'x', title: 'X', updatedAt: 1 }), 0);

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${pass} passed, 0 failed`);
  console.log('ALL CHECKS PASSED');
}
