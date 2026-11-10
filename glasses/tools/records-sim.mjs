#!/usr/bin/env node
// RECORDS — the rules that make "a schema the AI builds" safe, pinned.
//
// WHY THIS IS A HARNESS AND NOT PART OF metrics-sim
//   The metric store's rules and the record store's rules answer different
//   questions: "is this one number valid" versus "does this ROW fit the table it
//   is being written into". The second is where a soft schema becomes dangerous
//   — an inferred type is permanent, and a write that invents a column can only
//   be caught by the receipt it prints. So each rule below is asserted directly,
//   as a pure function, with no relay and no hub.
//
// WHAT IS PINNED
//   1. the inference table (number/bool/date/text, null, arrays refused),
//   2. the date rules (a month, an impossible day, and "March" is not a date),
//   3. `ts` derivation and the fact that a row with no date is LEGAL,
//   4. type enforcement on a declared column (blank is not zero),
//   5. additive-only schemas (a type change is locked),
//   6. the caps and the key alphabets,
//   7. the local store: purge refusal, surgical delete, merge vs replace,
//      strict refusal, filtering and ordering.
//
// Run: node tools/records-sim.mjs

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = resolve(here, '../../web/server/records.mjs');
const R = await import(`${pathToFileURL(mod).href}?v=${Date.now()}`);

let pass = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
};
const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ── 1. inference: the "schema on the fly" table ─────────────────────────────
eq('a number is a number', R.inferValue(290000), { ok: true, type: 'number', value: 290000 });
eq('a decimal stays a decimal', R.inferValue(12.5).value, 12.5);
eq('true is a BOOL, not a number', R.inferValue(true).type, 'bool');
eq('false too', R.inferValue(false).type, 'bool');
eq('an ISO date is a date', R.inferValue('2023-10-15').type, 'date');
eq('…and is stored normalised', R.inferValue('2023-10-15').value, '2023-10-15');
eq('a date-time normalises its separator', R.inferValue('2023-10-15 08:30').value, '2023-10-15T08:30');
eq('a month is a date', R.inferValue('2026-11').type, 'date');
eq('a plain string is text', R.inferValue('Garden Vale').type, 'text');
eq('a numeric STRING stays text', R.inferValue('290000').type, 'text');
check('a nested object is refused, not flattened', R.inferValue({ a: 1 }).ok === false, true);
check('…and the refusal says a nested value is not a cell', /document, not a cell/.test(R.inferValue({ a: 1 }).error), true);
check('an array is refused too', R.inferValue([1, 2]).ok === false, true);
check('a non-finite number is refused', R.inferValue(Number.POSITIVE_INFINITY).ok === false, true);
check('text over 500 characters is refused', R.inferValue('x'.repeat(501)).ok === false, true);
check('…and 500 is allowed', R.inferValue('x'.repeat(500)).ok === true, true);

// ── 2. dates: the ones a hand-written parser invents ────────────────────────
eq('31 February does not exist', R.dateValue('2023-02-31'), null);
eq('month 13 does not exist', R.dateValue('2023-13-01'), null);
eq('"March" is a label, not a moment', R.dateValue('March'), null);
eq('an empty string is not a date', R.dateValue(''), null);
eq('a date-only value is midnight UTC', new Date(R.dateValue('2023-10-15').ms).toISOString(), '2023-10-15T00:00:00.000Z');
eq('a full ISO instant parses', R.dateValue('2023-10-15T08:30:00Z').ms, Date.UTC(2023, 9, 15, 8, 30));

// ── 3. ts derivation — and the row that has none ────────────────────────────
const schema = [
  { key: 'launch_date', type: 'date' },
  { key: 'price', type: 'number' },
];
eq(
  'a date column sets the instant',
  new Date(R.deriveTs({ launch_date: '2023-10-15', price: 1 }, schema, 'row-1')).toISOString(),
  '2023-10-15T00:00:00.000Z',
);
eq(
  'the record key is the fallback',
  new Date(R.deriveTs({ price: 1 }, [{ key: 'price', type: 'number' }], '2024-02-01')).toISOString(),
  '2024-02-01T00:00:00.000Z',
);
eq('a row with no date has NO instant — and that is legal', R.deriveTs({ phone: '91234567' }, [{ key: 'phone', type: 'text' }], 'ana'), null);
eq(
  'the date column wins over the key, so the answer is deterministic',
  new Date(R.deriveTs({ launch_date: '2023-10-15' }, schema, '2024-02-01')).toISOString(),
  '2023-10-15T00:00:00.000Z',
);

// ── 4. type enforcement on a DECLARED column ────────────────────────────────
eq('a numeric string fits a number column', R.coerceValue('2,431.50', 'number').value, 2431.5);
eq('a number fits a text column', R.coerceValue(42, 'text').value, '42');
check('a blank is NOT zero', R.coerceValue('', 'number').ok === false, true);
check('…and says so as a number problem', /must be a number/.test(R.coerceValue('', 'number').error), true);
check('a word does not fit a number column', R.coerceValue('cheap', 'number').ok === false, true);
eq('"true" fits a bool column', R.coerceValue('true', 'bool').value, true);
eq('"no" fits a bool column', R.coerceValue('no', 'bool').value, false);
check('a bad bool is refused', R.coerceValue('maybe', 'bool').ok === false, true);
check('a bad date is refused', R.coerceValue('31 Feb', 'date').ok === false, true);
eq('a date column normalises', R.coerceValue('2023-10-15 08:30', 'date').value, '2023-10-15T08:30');

// ── 5. additive-only schemas ────────────────────────────────────────────────
const merged = R.mergeFields([{ key: 'price', type: 'number', label: 'Price', unit: 'SGD', precision: 2 }], [
  { key: 'estate', type: 'text', label: 'Estate', unit: '', precision: 0 },
]);
check('a new column is appended', merged.ok && merged.fields.length === 2, true);
const locked = R.mergeFields([{ key: 'price', type: 'number', label: 'Price', unit: 'SGD', precision: 2 }], [
  { key: 'price', type: 'text', label: 'Price', unit: '', precision: 0 },
]);
check('a type change is LOCKED, not applied', locked.ok === false && locked.code === 'FIELD_SHAPE_LOCKED', true);
check('…and the refusal explains why a retry cannot help', /already stored reads as number/.test(locked.error), true);
check('…and carries both descriptors', locked.current.type === 'number' && locked.requested.type === 'text', true);
const relabelled = R.mergeFields([{ key: 'price', type: 'number', label: 'Price', unit: 'SGD', precision: 2 }], [
  { key: 'price', type: 'number', label: 'Asking price', unit: 'SGD', precision: 0 },
]);
eq('a label IS editable — it describes how to render a cell', relabelled.fields[0].label, 'Asking price');

// ── 6. caps and key alphabets ───────────────────────────────────────────────
check('41 fields is past the cap', R.normaliseObject({ key: 'a.b', fields: Array.from({ length: 41 }, (_, i) => ({ key: `f${i}`, type: 'text' })) }).ok === false, true);
check('40 fields is allowed', R.normaliseObject({ key: 'a.b', fields: Array.from({ length: 40 }, (_, i) => ({ key: `f${i}`, type: 'text' })) }).ok === true, true);
check('a field key cannot start with a digit', R.normaliseField({ key: '1price', type: 'number' }).ok === false, true);
check('a field key has no dots — the object key carries the namespace', R.normaliseField({ key: 'a.b', type: 'number' }).ok === false, true);
check('a field must declare its type', R.normaliseField({ key: 'price' }).ok === false, true);
check('…and the refusal lists the types rather than picking one', /must be one of text, number, bool, date/.test(R.normaliseField({ key: 'price' }).error), true);
check('an object key is dotted and lowercase', R.normaliseObject({ key: 'bto.launch' }).ok === true, true);
check('…and a bare word is refused', R.normaliseObject({ key: 'launch' }).ok === false, true);
check('a record key may contain a space', R.RECORD_KEY_RE.test('Garden Vale 4-room'), true);
check('a record key of 65 characters is refused', R.RECORD_KEY_RE.test('x'.repeat(65)) === false, true);
check('33 rows in one write is past the cap', R.parseRecordBatch(Array.from({ length: 33 }, (_, i) => ({ key: `r${i}`, values: { a: 1 } }))).ok === false, true);
const dupes = R.parseRecordBatch([{ key: 'a', values: { x: 1 } }, { key: 'a', values: { x: 2 } }]);
check('two rows cannot claim one identity in a batch', dupes.ok === true && dupes.rejected.length === 1, true);
check('…and the refusal points at the earlier index', /duplicates records\[0\]/.test(dupes.rejected[0]?.error ?? ''), true);

// ── 7. near-duplicates: the only containment a soft schema has ──────────────
eq('"estates" is one slip from "estate"', R.nearDuplicate([{ key: 'estate' }], 'estates'), 'estate');
eq('"proj" is one slip from "project"… no: too far', R.nearDuplicate([{ key: 'project' }], 'proj'), null);
eq('an exact match is not a duplicate warning', R.nearDuplicate([{ key: 'price' }], 'price'), null);
eq('nothing to compare against', R.nearDuplicate([], 'price'), null);

// ── 8. the local store answers like the hub ─────────────────────────────────
const store = R.createLocalRecords();

// A table is created by its first write.
const first = store.write('bto.launch', [
  { key: '2023-10-15', values: { launch_date: '2023-10-15', price: 290000, project: 'Garden Vale' } },
]);
check('the local store can be written to before it is declared', first.ok === true, JSON.stringify(first));
eq('…and reports the fields it inferred', first.addedFields.map((f) => f.key), ['launch_date', 'price', 'project']);
eq('…with their types', first.addedFields.map((f) => f.type), ['date', 'number', 'text']);
eq('…and what it did', first.records, [{ key: '2023-10-15', action: 'inserted' }]);

// A second write MERGES into the row (a partial write corrects one cell).
const mergedRow = store.write('bto.launch', [{ key: '2023-10-15', values: { price: 295000 } }]);
eq('re-writing a row updates it', mergedRow.records, [{ key: '2023-10-15', action: 'updated' }]);
eq('…and leaves the other cells alone', store.state.records['bto.launch']['2023-10-15'].values.project, 'Garden Vale');
eq('…and changes the one it was given', store.state.records['bto.launch']['2023-10-15'].values.price, 295000);
eq('no new column, so no receipt', mergedRow.addedFields, []);

// `replace: true` is the only way to CLEAR a value, because null means nothing.
store.write('bto.launch', [{ key: '2023-10-15', values: { price: 295000 }, replace: true }]);
eq('a replace drops the cells that were not sent', store.state.records['bto.launch']['2023-10-15'].values.project, undefined);

// A rejected row must not leave behind the column only it used.
const bad = store.write('bto.launch', [
  { key: '2024-01-01', values: { price: 'expensive' } },
]);
check('a value that does not fit its column is rejected', bad.ok === false, JSON.stringify(bad));
check('…per item, naming the field', bad.rejected[0].field === 'price', true);
check('…and the schema did not grow', store.state.objects['bto.launch'].fields.length === 3, true);

// Strict tables refuse an unknown column, naming the ones that exist.
store.declare({ key: 'budget.fixed', fields: [{ key: 'item', type: 'text' }], strict: true });
const strict = store.write('budget.fixed', [{ key: 'rent', values: { item: 'Rent', amount: 2000 } }]);
check('a strict table refuses an unknown column', strict.ok === false, true);
check('…naming the columns it has', /allowed: item/.test(strict.rejected[0]?.error ?? ''), true);

// Filtering and ordering read a FIELD, not a column.
store.write('bto.launch', [{ key: '2024-02-01', values: { launch_date: '2024-02-01', price: 400000 } }]);
const byPrice = store.read('bto.launch', { sort: 'price', order: 'desc' });
eq('a sort by field puts the highest first', byPrice.records[0].key, '2024-02-01');
const wanted = store.read('bto.launch', { where: { field: 'price', op: '>=', value: 300000 } });
eq('a where clause filters on a field', wanted.records.map((r) => r.key), ['2024-02-01']);
eq('…and reports the unpaged total', wanted.total, 1);
const unknownSort = R.requireSort('flat_type', store.state.objects['bto.launch'].fields);
check('an unknown sort field is REFUSED, not ignored', unknownSort.ok === false, true);
check('…naming the fields that exist', /launch_date, price/.test(unknownSort.error), true);
const unknownWhere = R.parseWhere('flat_type=4-room', store.state.objects['bto.launch'].fields);
check('an unknown WHERE field is refused too', unknownWhere.ok === false, true);
check('…so a filter cannot silently match nothing', /which this object does not have/.test(unknownWhere.error), true);
const orderedWhere = R.parseWhere('price>=300000', store.state.objects['bto.launch'].fields);
eq('an ordered comparison parses on a numeric field', orderedWhere.where, { field: 'price', op: '>=', value: 300000 });
const textOrdered = R.parseWhere('project>=A', store.state.objects['bto.launch'].fields);
check('an ordered comparison on text is refused', textOrdered.ok === false, true);

// A row that never had a date sorts LAST, not at the epoch.
store.declare({ key: 'contact.friends', fields: [{ key: 'name', type: 'text' }] });
store.write('contact.friends', [{ key: 'ana', values: { name: 'Ana' } }]);
store.write('contact.friends', [{ key: '2024-05-05', values: { name: 'Ben', met: '2024-05-05' } }]);
const unordered = store.read('contact.friends', { sort: 'ts', order: 'desc' });
eq('an unordered row sorts last', unordered.records.map((r) => r.key), ['2024-05-05', 'ana']);
eq('…and still has no instant', unordered.records[1].ts, null);

// Deleting: one object refuses while it holds rows, and says how many.
const refused = store.remove('bto.launch');
check('a non-empty table is not deletable', refused.ok === false && refused.code === 'OBJECT_NOT_EMPTY', true);
eq('…and the count comes back for the confirm', refused.count, 2);
const rowGone = store.removeRecord('bto.launch', '2023-10-15');
eq('one row can be removed on its own', rowGone.deleted, 1);
check('…and the other row survives', Boolean(store.state.records['bto.launch']['2024-02-01']), true);
const rowMissing = store.removeRecord('bto.launch', '2023-10-15');
check('removing it twice is a clean not-found', rowMissing.ok === false && rowMissing.notFound === true, true);
const purged = store.remove('bto.launch', { purge: true });
check('a purge removes the table and reports its rows', purged.ok === true && purged.deletedRecords === 1, true);
check('…and the object is gone', store.state.objects['bto.launch'] === undefined, true);

// Dropping a column rewrites the bodies, and counts what it edited.
store.write('probe.drop', [{ key: 'r1', values: { a: 1, b: 2 } }]);
const patched = store.patch('probe.drop', { dropFields: ['b'] });
check('dropping a column reports how many rows it rewrote', patched.ok === true && patched.rewritten === 1, true);
eq('…and the value is gone from the body', store.state.records['probe.drop'].r1.values, { a: 1 });
const dropMissing = store.patch('probe.drop', { dropFields: ['nope'] });
check('dropping a column that does not exist is refused', dropMissing.ok === false, true);
check('…naming the ones that do', /fields: a/.test(dropMissing.error), true);

console.log(
  failures.length
    ? `\n${failures.length} FAILURE(S) of ${pass + failures.length}\n  ${failures.join('\n  ')}`
    : `\nALL PASS (${pass} assertions)`,
);
process.exit(failures.length ? 1 : 0);
