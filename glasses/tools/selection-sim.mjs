#!/usr/bin/env node
// MULTI-SELECT harness — the arithmetic behind bulk delete.
//
// WHY THIS EXISTS
//   Bulk delete is the first action in this app that can remove many things at
//   once, and every way it goes wrong is invisible until after it has: a
//   selection that survives a filter change deletes a row nobody picked; "All"
//   that unions with a stale selection deletes yesterday's list; a summary that
//   reports only successes hides the two documents that are still there.
//
//   The rules live in src/web/selection.ts as pure functions so they can be
//   pinned here — no React tree, no DOM, no hub.
//
// Run: node tools/selection-sim.mjs

const mod = new URL('../src/web/selection.ts', import.meta.url).href;
const {
  allSelected,
  confirmBulk,
  countLabel,
  describeBulk,
  keepExisting,
  selectAll,
  toggleId,
} = await import(mod);

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(
    ok
      ? `PASS  ${label}`
      : `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`,
  );
};

// ── 1. one id in, one id out ────────────────────────────────────────────────
check('picking adds', toggleId([], 'a'), ['a']);
check('picking again removes', toggleId(['a'], 'a'), []);
check('other picks are untouched', toggleId(['a', 'b'], 'a'), ['b']);
check('and order is preserved', toggleId(['c', 'a'], 'b'), ['c', 'a', 'b']);
// The same id twice is impossible, which is what makes a Set unnecessary.
check('no duplicate can enter', toggleId(toggleId(['a'], 'x'), 'x'), ['a']);

// ── 2. select all is a UNION, not a replace ────────────────────────────────
// This is the rule that keeps a selection made under a filter alive.
check('all adds every visible id', selectAll([], ['a', 'b']), ['a', 'b']);
check('all keeps what is already picked', selectAll(['z'], ['a']), ['z', 'a']);
check('all never duplicates', selectAll(['a'], ['a', 'b']), ['a', 'b']);
check('all of nothing is nothing', selectAll(['a'], []), ['a']);

// ── 3. ids that no longer exist are dropped before acting ─────────────────
check('gone ids are removed', keepExisting(['a', 'gone'], ['a', 'b']), ['a']);
check('and nothing survives an empty list', keepExisting(['a'], []), []);

// ── 4. "is everything selected?" ─────────────────────────────────────────
check('all visible selected', allSelected(['a', 'b'], ['a', 'b']), true);
check('one missing means no', allSelected(['a'], ['a', 'b']), false);
check('extras do not spoil it', allSelected(['a', 'b', 'z'], ['a', 'b']), true);
// An empty list must answer false, or the button offers to "select" nothing.
check('nothing visible is not all selected', allSelected([], []), false);

// ── 5. plurals in one place ──────────────────────────────────────────────
check('one item', countLabel(1, 'doc'), '1 doc');
check('many items', countLabel(3, 'doc'), '3 docs');
check('zero is still plural', countLabel(0, 'task'), '0 tasks');

// ── 6. the summary must not lie about failures ───────────────────────────
check('all succeeded', describeBulk('Deleted', 3, []), 'Deleted 3 items.');
check(
  'one succeeded, one did not is said as two numbers',
  describeBulk('Moved to Deleted', 1, [{ what: 'B', error: 'hub refused' }]),
  'Moved to Deleted 1 of 2; 1 failed (B: hub refused)',
);
check(
  'a total failure does not claim success',
  describeBulk('Deleted', 0, [{ what: 'A' }]),
  'Nothing was changed — all 1 failed',
);
check(
  'a failure with no error message still names the item',
  describeBulk('Deleted', 0, [{ what: 'A' }, { what: 'B' }]),
  'Nothing was changed — all 2 failed',
);

// ── 7. the confirmation puts the count in the question ───────────────────
check('confirm names the count', confirmBulk('task', 4), 'Delete 4 tasks?');
check('confirm can carry a consequence', confirmBulk('doc', 1, 'Every device.'), 'Delete 1 doc? Every device.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
