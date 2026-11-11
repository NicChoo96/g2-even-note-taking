// One chart, drawn from a series' own readings.
//
// WHY THERE IS NO CHART LIBRARY
//   The Data tab already draws its sparkline as a hand-written `<svg>` polyline,
//   and the reason generalises: a chart here has to survive a 900-point series, a
//   series with one reading, and a series whose values are text — and every
//   library answers those three cases by throwing or by drawing nothing. This
//   file answers them by saying what it can and cannot draw.
//
// THE RULE THAT MATTERS
//   The MODEL never chooses an axis. It declares a series (key, label, unit,
//   type) and the wearer chooses how to look at it. So the chart type is a LOCAL
//   view choice — it changes nothing on the hub, which is also why it is safe to
//   remember per device.
import { useState } from 'react';
import type { MetricPoint } from './metrics-client';
import { slotCount, type PlotSeries, type PlotSlots } from './chart-data';
/** What the wearer can switch between. `table` is not drawn — the caller renders rows. */
export type ChartKind = 'line' | 'area' | 'bar' | 'step';

export const CHART_KINDS: ChartKind[] = ['line', 'area', 'bar', 'step'];

export const CHART_LABELS: Record<ChartKind, string> = {
  line: 'Line',
  area: 'Area',
  bar: 'Bar',
  step: 'Step',
};

/**
 * How far back the detail view looks: a length in milliseconds, or everything.
 *
 * WHY THIS IS A NUMBER AND NOT FOUR NAMES
 *   This used to be `'24h' | '7d' | '30d' | 'all'` — a property of the UI, not of
 *   the readings. A series spanning eight years got the same four buttons as one
 *   spanning eight hours, so five of its seven years were reachable only through
 *   "All"; and "24h" was measured back from NOW, so on a series whose last
 *   reading is from 2018 every preset except "All" was empty. A filter is a lens
 *   on the readings that exist, so the lens is now derived FROM them —
 *   `windowChoices` — and measured back from the last reading.
 */
export type WindowKind = 'all' | number;

export interface WindowChoice {
  value: WindowKind;
  label: string;
}

/**
 * The rungs a look-back can land on. Each one is a duration a person would say
 * out loud; the list stops at ten years because a span longer than that is a
 * history, and "All" is the honest name for it.
 */
const STEP_MS: Array<{ ms: number; label: string }> = [
  { ms: 5 * 60e3, label: '5 min' },
  { ms: 15 * 60e3, label: '15 min' },
  { ms: 3600e3, label: '1 hour' },
  { ms: 6 * 3600e3, label: '6 hours' },
  { ms: 24 * 3600e3, label: '1 day' },
  { ms: 3 * 24 * 3600e3, label: '3 days' },
  { ms: 7 * 24 * 3600e3, label: '7 days' },
  { ms: 30 * 24 * 3600e3, label: '30 days' },
  { ms: 90 * 24 * 3600e3, label: '3 months' },
  { ms: 365 * 24 * 3600e3, label: '1 year' },
  { ms: 3 * 365 * 24 * 3600e3, label: '3 years' },
  { ms: 10 * 365 * 24 * 3600e3, label: '10 years' },
];

/** The longest rung that is still no longer than `ms`. */
function snapDown(ms: number): { ms: number; label: string } {
  let best = STEP_MS[0];
  for (const step of STEP_MS) if (step.ms <= ms) best = step;
  return best;
}

/**
 * The look-backs THIS series can be read at, derived from its own span.
 *
 * Three depths of the same data — half of it, an eighth, a thirty-second — then
 * "All". Half/a-third-style fractions are how you actually scrub a series: the
 * question is never "what happened in the last 24 hours" but "what happened in
 * the last bit of this", and what "the last bit" means depends on the series. An
 * eight-year series gets 3 months / 1 year / 3 years; an eight-hour one gets
 * 15 min / 1 hour. Same code, no configuration, and every option contains
 * readings.
 */
export function windowChoices(points: MetricPoint[]): WindowChoice[] {
  const all: WindowChoice = { value: 'all', label: 'All' };
  if (points.length < 3) return [all];
  const first = points[0].ts;
  const last = points[points.length - 1].ts;
  const span = Math.max(first, last) - Math.min(first, last);
  if (!(span > 0)) return [all];
  const choices: WindowChoice[] = [];
  for (const depth of [span / 2, span / 8, span / 32]) {
    const step = snapDown(depth);
    // A rung at or past the full span is "All" wearing another label.
    if (step.ms >= span) continue;
    if (choices.some((c) => c.value === step.ms)) continue;
    choices.push({ value: step.ms, label: step.label });
  }
  choices.sort((a, b) => Number(a.value) - Number(b.value));
  return [...choices, all];
}

/**
 * A stored window choice, from this version or from the four-preset one.
 *
 * The view spec is remembered per device in localStorage, so an old `'30d'` is
 * still on people's phones. It is translated rather than discarded: the number
 * it stood for is exactly what the new shape stores.
 */
export function normaliseWindow(raw: unknown): WindowKind {
  const legacy: Record<string, number> = {
    '24h': 24 * 3600e3,
    '7d': 7 * 24 * 3600e3,
    '30d': 30 * 24 * 3600e3,
  };
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return legacy[String(raw)] ?? 'all';
}

/**
 * The readings a window actually contains.
 *
 * **Measured back from the LAST READING, not from `now`.** That is the whole
 * difference between a lens and a trap: a backfilled series whose newest reading
 * is from 2018 asked for "the last 7 days" and got nothing, because the question
 * had been silently changed to "the last 7 days of today". The readings are the
 * subject; the clock is not.
 *
 * A window keeps the LAST point before it opens, when there is one, so a line
 * does not start at the left edge with no history: seven days of a once-a-day
 * series is otherwise six intervals and an empty seventh.
 */
export function pointsInWindow(points: MetricPoint[], window: WindowKind): MetricPoint[] {
  if (window === 'all') return points;
  const span = Number(window);
  if (!Number.isFinite(span) || span <= 0 || points.length === 0) return points;
  const last = points.reduce((a, b) => (b.ts > a.ts ? b : a), points[0]);
  const from = last.ts - span;
  const inside = points.filter((p) => p.ts >= from);
  if (inside.length === points.length) return points;
  const before = [...points].reverse().find((p) => p.ts < from);
  return before ? [before, ...inside] : inside;
}

/** Only the readings a chart can draw. A string series is a table, full stop. */
export interface ChartPoint {
  ts: number;
  value: number;
  /** What an attribute series is joined on. See `AttributeSeries`. */
  slot?: string;
}

/**
 * One dimension that sits BESIDE the value: a project name, an estate, a
 * location. It is its own text series at the same slot — the store holds one
 * value per reading — and it reaches the chart already keyed by slot.
 *
 * Nothing here knows what the dimensions MEAN. `tengah.bto.4room.project` is not
 * a special case; whatever sibling text series a series has get offered, so the
 * same chart shows a BTO project today and anything else tomorrow.
 */
export interface AttributeSeries {
  key: string;
  label: string;
  bySlot: Map<string, string>;
}

export function numericPoints(points: MetricPoint[]): ChartPoint[] {
  const out: ChartPoint[] = [];
  for (const p of points) {
    const n = typeof p.value === 'number' ? p.value : Number(String(p.value).replace(/,/g, '').trim());
    if (Number.isFinite(n)) out.push({ ts: p.ts, value: n, ...(p.slot ? { slot: p.slot } : {}) });
  }
  return out;
}

/**
 * The chart a series ASKS for, before anyone has chosen.
 *
 * A line says "this moved continuously"; a bar says "this happened, once per
 * period". Which one is honest is a property of the READINGS, not of taste: a
 * price quoted every minute is a trace, while a BTO launch priced once a quarter
 * is a set of events, and drawing it as a line invents a slope between two
 * launches that never existed.
 *
 * So the default follows the gap between readings: months apart reads as bars,
 * days apart reads as a line. Anyone can override it — this is only the first
 * guess, and it is stored once they do.
 */
export function defaultKind(points: MetricPoint[]): ChartKind {
  const ts = points.map((p) => p.ts).sort((a, b) => a - b);
  if (ts.length < 3) return 'line';
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i += 1) gaps.push(ts[i] - ts[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median >= 20 * 24 * 3600e3 ? 'bar' : 'line';
}

function tick(n: number, precision: number): string {
  const digits = Math.max(0, Math.min(4, precision));
  const fixed = n.toFixed(digits);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/**
 * The full timestamp, for a tooltip.
 *
 * The axis label says `11/1` because that is all the space there is; a tooltip
 * exists to answer the question the axis could not, so it says the year, the day
 * and the minute.
 */
function fullStamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stamp(ts: number, span: number): string {
  const d = new Date(ts);
  // A chart that spans days is labelled by day; one that spans hours needs the
  // hour or every label reads the same.
  if (span <= 36 * 3600e3) {
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * The chart: one or more series over a shared x axis.
 *
 * WHY IT TAKES A LIST OF SERIES
 *   One series at a time was the previous shape, and it made "compare NVDA, AMD and
 *   TSMC" impossible by construction — three charts, read by eye. Everything here
 *   is aligned by `chart-data.ts` before it arrives, so the component's job is
 *   only geometry: min/max across ALL series, one polyline per series, a shared
 *   legend, and a tooltip that names every series at the touched slot.
 *
 * WHY A NULL IS A GAP
 *   A series with no reading at a slot must not be joined to its neighbour: that
 *   draws a line through a value nobody recorded. `segments()` breaks the polyline
 *   instead, and a bar is simply absent.
 *
 * THE X AXIS IS SLOTS, NOT ALWAYS TIME
 *   `slots.kind` is `time` (formatted from the stamps) or `category` (the cell text
 *   itself) — a table may plot price against flat type and never have a date at
 *   all. The component does not care which; it only decides how to label.
 */
export function PlotChart({
  slots,
  series,
  kind,
  xTitle,
  rowKeys,
  attributes,
}: {
  slots: PlotSlots;
  series: PlotSeries[];
  kind: ChartKind;
  /** The column or series the x axis came from — for the caption below. */
  xTitle?: string;
  /** The ROW behind each slot, so a tooltip can read that row's other cells. */
  rowKeys?: Array<string | undefined>;
  /** Text dimensions keyed by row, shown in the tooltip. */
  attributes?: AttributeSeries[];
}) {
  /**
   * Which slot is being examined, if any. A tap (or a mouse hover) is the only way
   * to ask "which launch is that bar?", so the hit strips below cover a whole
   * column — a thumb cannot aim at a 2px dot.
   */
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const n = slotCount(slots);
  const drawable = series.filter((s) => s.values.some((v) => v !== null));
  if (!n || drawable.length === 0) {
    return <p className="hint-line chart-empty">No readings to plot for this choice.</p>;
  }
  if (n === 1) {
    const solo = drawable
      .map((s) => `${tick(s.values[0] as number, s.precision)}${s.unit ? ` ${s.unit}` : ''}`)
      .join(', ');
    return (
      <p className="hint-line chart-empty">
        One point — {solo}. A chart needs two; this becomes a line as soon as another row or reading arrives.
      </p>
    );
  }

  const W = 640;
  const H = 200;
  const padL = 52;
  const padR = 10;
  const padT = 10;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const values = drawable.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  // Bars grow from zero, so the baseline has to include it. A line does not:
  // forcing zero on a share price flattens the only movement there is.
  const min = kind === 'bar' ? Math.min(0, rawMin) : rawMin;
  const max = rawMax === min ? min + 1 : rawMax;
  const span = max - min;

  /**
   * Where slot `i` sits. A LINE runs edge to edge; a BAR owns a band and sits in
   * the middle of it, or it hangs half outside the plot and collides with its own
   * label.
   */
  const band = plotW / n;
  const xAt = (i: number) => (kind === 'bar' ? padL + band * (i + 0.5) : padL + (i / (n - 1)) * plotW);
  const yAt = (v: number) => padT + plotH - ((v - min) / span) * plotH;

  const timeSpan =
    slots.kind === 'time' ? Math.max(0, slots.ts[slots.ts.length - 1] - slots.ts[0]) : 0;
  const labelAt = (i: number) =>
    slots.kind === 'time' ? stamp(slots.ts[i], timeSpan) : clipLabel(slots.labels[i]);

  // Three gridlines: enough to read a value off, few enough that a phone is not
  // a wall of text.
  const grid = [0, 0.5, 1].map((f) => {
    const v = max - span * f;
    return { v, y: yAt(v) };
  });

  /** Bars are grouped inside a slot's band when several series share the chart. */
  const groupW = band * 0.8;
  const barW = Math.max(1.5, groupW / drawable.length);

  /**
   * One series as polyline runs, broken at every null.
   *
   * A step chart inserts the elbow between two readings — the value holds until
   * the next one, which is what "step" means.
   */
  const segments = (s: PlotSeries): Array<Array<[number, number]>> => {
    const out: Array<Array<[number, number]>> = [];
    let run: Array<[number, number]> = [];
    s.values.forEach((v, i) => {
      if (v === null) {
        if (run.length > 1) out.push(run);
        run = [];
        return;
      }
      const x = xAt(i);
      const y = yAt(v);
      if (kind === 'step' && run.length) {
        const prev = run[run.length - 1];
        if (prev[0] !== x) run.push([x, prev[1]]);
      }
      run.push([x, y]);
    });
    if (run.length > 1) out.push(run);
    return out;
  };

  /**
   * The tooltip, sized to its widest line BEFORE it is drawn — a box that grows
   * after the text is how a tooltip ends up with a line hanging out of the side.
   */
  const active =
    activeIndex !== null && activeIndex < n
      ? (() => {
          const when =
            slots.kind === 'time' ? fullStamp(slots.ts[activeIndex]) : slots.labels[activeIndex];
          const rowKey = rowKeys?.[activeIndex];
          const attrs = (attributes ?? []).flatMap((a) => {
            const value = rowKey ? a.bySlot.get(rowKey) : undefined;
            return value ? [`${a.label}: ${value}`] : [];
          });
          const lines = [
            when,
            ...drawable.map((s) => {
              const v = s.values[activeIndex];
              return `${s.label}: ${v === null ? 'no reading' : `${tick(v, s.precision)}${s.unit ? ` ${s.unit}` : ''}`}`;
            }),
            ...attrs,
          ];
          const boxW = Math.min(W - 8, Math.max(120, Math.ceil(Math.max(...lines.map((l) => l.length)) * 6.4 + 16)));
          const boxH = 12 + lines.length * 14;
          const x = xAt(activeIndex);
          const top = drawable.reduce<number | null>((acc, s) => {
            const v = s.values[activeIndex];
            return v === null ? acc : Math.min(acc ?? Infinity, yAt(v));
          }, null);
          const y = top ?? padT + plotH / 2;
          const boxX = Math.min(Math.max(x - boxW / 2, 4), W - boxW - 4);
          const boxY = y - boxH - 12 >= padT ? y - boxH - 12 : Math.min(y + 12, padT + plotH - boxH);
          return { index: activeIndex, lines, boxW, boxH, boxX, boxY };
        })()
      : null;

  /** The row key behind a slot, for a table's attributes. */

  return (
    <div className="chart-wrap">
      <svg
        className="metric-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${kind} chart of ${drawable.map((s) => s.label).join(', ')} over ${n} points`}
      >
        {grid.map((g) => (
          <g key={g.y}>
            <line className="chart-grid" x1={padL} x2={W - padR} y1={g.y} y2={g.y} />
            <text className="chart-tick" x={padL - 6} y={g.y + 3} textAnchor="end">
              {tick(g.v, 0)}
            </text>
          </g>
        ))}

        {kind === 'bar' &&
          drawable.map((s, si) =>
            s.values.map((v, i) => {
              if (v === null) return null;
              const y = yAt(v);
              const zero = yAt(Math.max(min, 0));
              const x = xAt(i) - groupW / 2 + si * barW;
              return (
                <rect
                  key={`${s.key}-${i}`}
                  className={`chart-bar chart-series-${si % 6}`}
                  x={x}
                  y={Math.min(y, zero)}
                  width={barW}
                  height={Math.max(1, Math.abs(zero - y))}
                />
              );
            }),
          )}

        {kind === 'area' &&
          drawable.length === 1 &&
          segments(drawable[0]).map((seg, si) => (
            <polygon
              key={`area-${si}`}
              className="chart-area chart-series-0"
              points={[[seg[0][0], padT + plotH], ...seg, [seg[seg.length - 1][0], padT + plotH]]
                .map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`)
                .join(' ')}
            />
          ))}

        {kind !== 'bar' &&
          kind !== 'area' &&
          drawable.map((s, si) =>
            segments(s).map((seg, gi) => (
              <polyline
                key={`${s.key}-${gi}`}
                className={`chart-line chart-series-${si % 6}`}
                fill="none"
                points={seg.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')}
              />
            )),
          )}

        {kind === 'area' &&
          drawable.length === 1 &&
          segments(drawable[0]).map((seg, gi) => (
            <polyline
              key={`edge-${gi}`}
              className="chart-line chart-series-0"
              fill="none"
              points={seg.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')}
            />
          ))}

        {/* Dots only while the chart is sparse: at 60 points a dot per reading is
            a solid smear, and the line already says where the readings are. */}
        {n <= 40 &&
          kind !== 'bar' &&
          drawable.map((s, si) =>
            s.values.map((v, i) =>
              v === null ? null : (
                <circle
                  key={`d-${s.key}-${i}`}
                  className={`chart-dot chart-series-${si % 6}`}
                  cx={xAt(i)}
                  cy={yAt(v)}
                  r={2}
                />
              ),
            ),
          )}

        <text className="chart-tick" x={padL} y={H - 6} textAnchor="start">
          {labelAt(0)}
        </text>
        <text className="chart-tick" x={W - padR} y={H - 6} textAnchor="end">
          {labelAt(n - 1)}
        </text>

        {/* A strip per slot, not a hit test on a 2px dot. */}
        {drawable.length >= 1 &&
          Array.from({ length: n }, (_, i) => {
            const hitW = kind === 'bar' ? band : plotW / Math.max(1, n - 1);
            return (
              <rect
                key={`hit-${i}`}
                className="chart-hit"
                x={xAt(i) - hitW / 2}
                y={padT}
                width={Math.max(4, hitW)}
                height={plotH}
                onPointerDown={() => setActiveIndex(i)}
                onPointerEnter={(e) => {
                  // Mouse hovers; a finger does not, and treating its touch-enter
                  // as a hover shows a tooltip the user cannot dismiss.
                  if (e.pointerType === 'mouse') setActiveIndex(i);
                }}
              />
            );
          })}

        {active && (
          <g className="chart-tip" pointerEvents="none">
            <line
              className="chart-guide"
              x1={xAt(active.index)}
              x2={xAt(active.index)}
              y1={padT}
              y2={padT + plotH}
            />
            <rect
              className="chart-tip-box"
              x={active.boxX}
              y={active.boxY}
              width={active.boxW}
              height={active.boxH}
              rx={6}
            />
            {active.lines.map((text, i) => (
              <text
                key={`${text}-${i}`}
                className={i === 0 ? 'chart-tip-when' : 'chart-tip-line'}
                x={active.boxX + 8}
                y={active.boxY + 16 + i * 14}
              >
                {text}
              </text>
            ))}
          </g>
        )}
      </svg>

      {/* THE SHARED LEGEND. One entry per plotted series, named with the colour it
          is drawn in, so two tickers on one chart stay tellable apart. */}
      <ul className="chart-legend">
        {drawable.map((s, i) => (
          <li key={s.key}>
            <i className={`chart-swatch chart-series-${i % 6}`} aria-hidden="true" />
            {s.label}
            {s.unit ? <span className="chart-legend-unit">{s.unit}</span> : null}
          </li>
        ))}
      </ul>
      {xTitle ? <p className="chart-x-title">x: {xTitle}</p> : null}
    </div>
  );
}

/**
 * A category label short enough to sit under an axis.
 *
 * The full value is still in the tooltip and in the table, so nothing is lost —
 * the axis only has room for one word.
 */
function clipLabel(text: string): string {
  const s = String(text ?? '');
  return s.length > 12 ? `${s.slice(0, 11)}…` : s;
}
