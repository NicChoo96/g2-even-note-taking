// The table view's LENSES, as pure functions.
//
// WHY THIS IS A MODULE AND NOT PART OF DataPanel.tsx
//   What the chart shows is decided by two things the wearer chooses — which
//   COLUMN VALUES the chart is restricted to, and which span of time — and both
//   are easy to get subtly wrong: a filter that silently matches nothing looks
//   exactly like an empty table, a range that measures from `now` hides history
//   that exists, and a chart drawn from unfiltered rows contradicts the list
//   underneath it. None of that is visible from a screenshot, so the rules live
//   here where a harness can drive them.
//
// THE ONE INVARIANT
//   Everything on screen is derived from ONE filtered row set: the chart points,
//   the tooltip's cells, the table and the counts. A view whose chart and table
//   disagree is worse than a view with no chart.
//
// Zero imports beyond the client's types.

import type { RecordField, RecordRow } from './metrics-client';

/** Which column values are allowed, by field key. An empty array means "all". */
export type RecordFilters = Record<string, string[]>;

/** A span of time in epoch ms. Both ends are optional; missing means unbounded. */
export interface RecordRange {
  from?: number;
  to?: number;
}

/**
 * A column can be filtered when it describes the row rather than measuring it.
 *
 * Numbers are excluded on purpose: they are what the chart PLOTS, and "price =
 * 290000" is not a filter anyone wants — it is a single row. DATES are excluded
 * for a different reason: they already have a better control, the From/To pair,
 * and a menu listing forty dates is worse at the same job.
 */
export function isFilterable(field: RecordField): boolean {
  return field.type === 'text' || field.type === 'bool';
}

/** The value a filter compares, as text, or `''` when the row has nothing there. */
export function cellValue(row: RecordRow, field: RecordField): string {
  const raw = row.values?.[field.key];
  if (raw === null || raw === undefined) return '';
  if (field.type === 'bool') return raw ? 'yes' : 'no';
  return String(raw);
}

/** The distinct values of one column, commonest first, then alphabetical. */
export function facets(rows: RecordRow[], field: RecordField): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = cellValue(row, field);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Only the fields that have a value to choose, in schema order. */
export function filterableFields(rows: RecordRow[], fields: RecordField[]): RecordField[] {
  return fields.filter((f) => isFilterable(f) && facets(rows, f).length > 1);
}

/** Filters with nothing selected are not filters; drop them so `{}` means "all". */
export function compact(filters: RecordFilters | undefined): RecordFilters {
  const out: RecordFilters = {};
  for (const [key, values] of Object.entries(filters ?? {})) {
    if (Array.isArray(values) && values.length) out[key] = values;
  }
  return out;
}

/** How many columns are restricted — the number on a "Clear" chip. */
export function filterCount(filters: RecordFilters | undefined): number {
  return Object.keys(compact(filters)).length;
}

/** One column's restriction as a chip label: "All", "4-room", "4-room +2". */
export function filterLabel(filters: RecordFilters | undefined, field: RecordField): string {
  const values = compact(filters)[field.key] ?? [];
  if (!values.length) return 'All';
  if (values.length === 1) return values[0];
  return `${values[0]} +${values.length - 1}`;
}

/**
 * Keep the rows that satisfy EVERY restricted column.
 *
 * A row with no value for a restricted column is EXCLUDED — choosing "4-room"
 * asks for 4-room rows, and a row that never said is not one of them. That is the
 * opposite of what an empty filter means (which is "no restriction at all"), and
 * the distinction is why `compact` exists.
 */
export function applyFilters(rows: RecordRow[], filters: RecordFilters | undefined): RecordRow[] {
  const active = Object.entries(compact(filters));
  if (!active.length) return rows;
  return rows.filter((row) =>
    active.every(([key, values]) => {
      const raw = row.values?.[key];
      if (raw === null || raw === undefined) return false;
      const text = typeof raw === 'boolean' ? (raw ? 'yes' : 'no') : String(raw);
      return values.includes(text);
    }),
  );
}

/**
 * Keep the rows inside a span of dates.
 *
 * A row with NO instant is excluded from any bounded range: it has no place on
 * the axis, so it cannot be inside a window drawn on one. With no range set every
 * row survives, which is what keeps an undated table readable.
 */
export function applyRange(rows: RecordRow[], range: RecordRange | undefined): RecordRow[] {
  if (!range || (range.from === undefined && range.to === undefined)) return rows;
  return rows.filter((row) => {
    if (typeof row.ts !== 'number') return false;
    if (range.from !== undefined && row.ts < range.from) return false;
    if (range.to !== undefined && row.ts > range.to) return false;
    return true;
  });
}

/** `yyyy-mm-dd` → midnight UTC, or null. Kept in UTC so a timezone cannot shift a day. */
export function parseDateInput(text: unknown): number | null {
  const value = String(text ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const check = new Date(ms);
  // 31 February rolls over rather than failing, so the day is checked back.
  if (check.getUTCMonth() !== Number(m[2]) - 1 || check.getUTCDate() !== Number(m[3])) return null;
  return ms;
}

/** epoch ms → `yyyy-mm-dd` for a date input, or `''`. */
export function toDateInput(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** A range built from two date inputs: `to` covers its whole day. */
export function rangeFromInputs(fromText: string, toText: string): RecordRange | undefined {
  const from = parseDateInput(fromText);
  const toDay = parseDateInput(toText);
  const to = toDay === null ? null : toDay + 24 * 3600 * 1000 - 1;
  if (from === null && to === null) return undefined;
  return { ...(from !== null ? { from } : {}), ...(to !== null ? { to } : {}) };
}

/** `2018-11-01 → 2026-11-09`, or the one end that is set, or `''`. */
export function rangeLabel(range: RecordRange | undefined): string {
  if (!range || (range.from === undefined && range.to === undefined)) return '';
  const from = toDateInput(range.from);
  const to = toDateInput(range.to);
  if (from && to) return `${from} to ${to}`;
  return from ? `from ${from}` : `to ${to}`;
}

/** A column heading a person can read: `price_sgd` → `Price sgd`. */
export function fieldTitle(field: RecordField): string {
  const label = String(field.label ?? '').trim();
  if (label && label !== field.key) return label;
  const words = String(field.key ?? '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field.key;
}
