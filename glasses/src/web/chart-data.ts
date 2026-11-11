// WHATEVER SHAPE THE STORE HOLDS, REDUCED TO WHAT A CHART NEEDS.
//
// WHY THIS IS PURE AND SEPARATE
//   The columns of a table are data, not schema: `tengah.bto.4room` has a date, an
//   estate, a project, a flat type and a price today, and whatever a later write
//   infers tomorrow. So the chart cannot know a column by name — it is CONFIGURED:
//   the wearer picks which column runs along the x axis and which columns are
//   plotted. That leaves two rules that are easy to get subtly wrong and invisible
//   in a screenshot:
//
//     1. ORDER. A time axis reads left to right, oldest to newest. The store hands
//        back the NEWEST row first (records.read defaults to `order: 'desc'`), so a
//        chart built straight from `table.records` drew 2026 on the left and 2018
//        on the right — a trend read backwards is a trend that does not exist.
//     2. ALIGNMENT. Two series almost never share slot sets. Comparing NVDA, AMD
//        and TSMC means three different timestamps, and the only honest chart is
//        the union of them, ascending, with a GAP where one has no reading.
//
//   Both live here so a harness can drive them rather than a screenshot.
//
// Zero imports beyond the client's types and the table helpers.

import type { MetricPoint, RecordField, RecordRow } from './metrics-client';
import { cellValue } from './record-view';

/**
 * The x axis of a plot.
 *
 * `time` is one slot per row (or per reading), sorted ascending. Equal instants
 * are LEGAL and stay distinct — two flat types launched on the same day are two
 * rows, not one, and merging them would invent an average nobody computed.
 * `category` is one slot per distinct value, because "4-room" repeated twelve
 * times is not an axis, it is a list.
 */
export type PlotSlots = { kind: 'time'; ts: number[] } | { kind: 'category'; labels: string[] };

/** One drawn line or bar group. `values` is aligned with the slots. */
export interface PlotSeries {
  /** Stable identity for React keys and for the colour class. */
  key: string;
  /** What the legend says. */
  label: string;
  unit: string;
  precision: number;
  /** null means "no reading here" — drawn as a gap, never as zero. */
  values: Array<number | null>;
}

export interface TablePlot {
  slots: PlotSlots;
  series: PlotSeries[];
  /** The row behind each slot, so a tooltip can read that row's other cells. */
  rowKeys: Array<string | undefined>;
  /** Rows left out because the x column held nothing. */
  droppedX: number;
  /** Rows folded into an existing category (the newest one wins). */
  collapsed: number;
}

/** A number, or null. Thousands separators are accepted, blanks are not zero. */
export function numberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = String(raw).replace(/,/g, '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** The instant a date cell names, or null. A bare date is midnight UTC. */
export function instantOf(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = String(raw).trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** The columns a chart may plot: numbers only. */
export function plotFields(fields: RecordField[]): RecordField[] {
  return fields.filter((f) => f.type === 'number');
}

/**
 * The column that runs along the x axis, unless the wearer chose one.
 *
 * A date if the table has one — that is what a row's place in time means — and
 * otherwise the first column, because a table of labels still plots.
 */
export function pickXField(fields: RecordField[]): string {
  const date = fields.find((f) => f.type === 'date');
  return (date ?? fields[0])?.key ?? '';
}

/**
 * Reduce a row set to slots and plot columns.
 *
 * `rows` arrive newest-first from the store; nothing downstream may depend on
 * that, so the sort happens here (rule 1 above).
 */
export function tableView(
  rows: RecordRow[],
  fields: RecordField[],
  xField: string,
  yFields: string[],
): TablePlot {
  const x = fields.find((f) => f.key === xField);
  const ys = fields.filter((f) => f.type === 'number' && yFields.includes(f.key));
  const series: PlotSeries[] = ys.map((f) => ({
    key: f.key,
    label: f.label || f.key,
    unit: f.unit || '',
    precision: f.precision ?? 0,
    values: [],
  }));
  const empty = { slots: { kind: 'category' as const, labels: [] }, series, rowKeys: [], droppedX: 0, collapsed: 0 };
  if (!x) return empty;

  if (x.type === 'date') {
    const dated: Array<{ ts: number; row: RecordRow }> = [];
    let droppedX = 0;
    for (const row of rows) {
      const ts = instantOf(row.values?.[x.key]);
      if (ts === null) droppedX += 1;
      else dated.push({ ts, row });
    }
    // ASCENDING, oldest first. A stable sort keeps same-day rows in store order.
    dated.sort((a, b) => a.ts - b.ts);
    return {
      slots: { kind: 'time', ts: dated.map((d) => d.ts) },
      series: series.map((s, i) => ({
        ...s,
        values: buildValues(dated.map((d) => d.row), ys[i]),
      })),
      rowKeys: dated.map((d) => d.row.key),
      droppedX,
      collapsed: 0,
    };
  }

  // A CATEGORY axis: one slot per distinct label, ordered so the axis is stable
  // between renders. The FIRST row for a label wins, which — given the store's
  // newest-first order — is the most recent row for that label.
  const order: string[] = [];
  const rowsByLabel = new Map<string, RecordRow>();
  const byLabel = new Map<string, RecordRow[]>();
  let droppedX = 0;
  let collapsed = 0;
  for (const row of rows) {
    const label = cellValue(row, x).trim();
    if (!label) {
      droppedX += 1;
      continue;
    }
    const seen = byLabel.get(label);
    if (!seen) {
      byLabel.set(label, [row]);
      rowsByLabel.set(label, row);
      order.push(label);
    } else {
      seen.push(row);
      collapsed += 1;
    }
  }
  order.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const picked = order.map((label) => rowsByLabel.get(label) as RecordRow);
  return {
    slots: { kind: 'category', labels: order },
    series: series.map((s, i) => ({ ...s, values: buildValues(picked, ys[i]) })),
    rowKeys: picked.map((r) => r.key),
    droppedX,
    collapsed,
  };
}

function buildValues(rows: RecordRow[], field: RecordField | undefined): Array<number | null> {
  if (!field) return rows.map(() => null);
  return rows.map((r) => numberOrNull(r.values?.[field.key]));
}

/** A series as the plot needs it, before alignment. */
export interface PlotSource {
  key: string;
  label: string;
  unit: string;
  precision: number;
  points: MetricPoint[];
}

/**
 * Several series over the union of their slots, ascending (rule 2 above).
 *
 * A series with no reading at a slot contributes `null`, which the chart draws as
 * a gap: joining the neighbours would invent a value for a day that has none.
 */
export function alignSeries(sources: PlotSource[]): {
  slots: { kind: 'time'; ts: number[] };
  series: PlotSeries[];
  /** Slot → what each source called it, for a tooltip. */
  bySlot: Map<number, Array<{ label: string; text: string }>>;
} {
  const stamps = new Set<number>();
  for (const s of sources) for (const p of s.points) if (Number.isFinite(p.ts)) stamps.add(p.ts);
  const ts = [...stamps].sort((a, b) => a - b);
  const series: PlotSeries[] = sources.map((s) => {
    const own = new Map<number, number>();
    for (const p of s.points) {
      const n = numberOrNull(p.value);
      if (Number.isFinite(p.ts) && n !== null) own.set(p.ts, n);
    }
    return {
      key: s.key,
      label: s.label || s.key,
      unit: s.unit || '',
      precision: s.precision ?? 0,
      values: ts.map((t) => own.get(t) ?? null),
    };
  });
  return { slots: { kind: 'time', ts }, series, bySlot: new Map() };
}

/**
 * Narrow a time plot to the last `window` ms, measured from the LAST slot.
 *
 * The slot just before the window is kept, so a line does not start at the left
 * edge with no history — the same rule `pointsInWindow` applies to one series.
 */
export function sliceWindow<T extends PlotSeries>(
  slots: PlotSlots,
  series: T[],
  window: number | 'all',
): { slots: PlotSlots; series: T[]; start: number } {
  if (window === 'all' || slots.kind !== 'time' || slots.ts.length === 0) return { slots, series, start: 0 };
  const span = Number(window);
  if (!Number.isFinite(span) || span <= 0) return { slots, series, start: 0 };
  const last = slots.ts[slots.ts.length - 1];
  const from = last - span;
  let start = slots.ts.findIndex((t) => t >= from);
  if (start < 0) return { slots, series, start: 0 };
  // Keep ONE slot of context on the left when there is one.
  if (start > 0) start -= 1;
  return {
    slots: { kind: 'time', ts: slots.ts.slice(start) },
    series: series.map((s) => ({ ...s, values: s.values.slice(start) })),
    start,
  };
}

/** How many slots a plot has, whichever axis it uses. */
export function slotCount(slots: PlotSlots): number {
  return slots.kind === 'time' ? slots.ts.length : slots.labels.length;
}
