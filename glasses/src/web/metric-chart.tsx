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
import type { MetricPoint } from './metrics-client';

/** What the wearer can switch between. `table` is not drawn — the caller renders rows. */
export type ChartKind = 'line' | 'area' | 'bar' | 'step';

export const CHART_KINDS: ChartKind[] = ['line', 'area', 'bar', 'step'];

export const CHART_LABELS: Record<ChartKind, string> = {
  line: 'Line',
  area: 'Area',
  bar: 'Bar',
  step: 'Step',
};

/** How far back the detail view looks. */
export type WindowKind = '24h' | '7d' | '30d' | 'all';

export const WINDOW_KINDS: WindowKind[] = ['24h', '7d', '30d', 'all'];

export const WINDOW_LABELS: Record<WindowKind, string> = {
  '24h': '24h',
  '7d': '7 days',
  '30d': '30 days',
  all: 'All',
};

const WINDOW_MS: Record<Exclude<WindowKind, 'all'>, number> = {
  '24h': 24 * 3600e3,
  '7d': 7 * 24 * 3600e3,
  '30d': 30 * 24 * 3600e3,
};

/**
 * The readings a window actually contains.
 *
 * A window keeps the LAST point before it opens, when there is one, so a line
 * does not start at the left edge with no history: "7 days" of a once-a-day
 * series is otherwise six intervals and an empty seventh.
 */
export function pointsInWindow(points: MetricPoint[], window: WindowKind, now = Date.now()): MetricPoint[] {
  if (window === 'all') return points;
  const from = now - WINDOW_MS[window];
  const inside = points.filter((p) => p.ts >= from);
  if (inside.length === points.length) return points;
  const before = [...points].reverse().find((p) => p.ts < from);
  return before ? [before, ...inside] : inside;
}

/** Only the readings a chart can draw. A string series is a table, full stop. */
export function numericPoints(points: MetricPoint[]): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  for (const p of points) {
    const n = typeof p.value === 'number' ? p.value : Number(String(p.value).replace(/,/g, '').trim());
    if (Number.isFinite(n)) out.push({ ts: p.ts, value: n });
  }
  return out;
}

function tick(n: number, precision: number): string {
  const digits = Math.max(0, Math.min(4, precision));
  const fixed = n.toFixed(digits);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
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

export function MetricChart({
  points,
  kind,
  unit,
  precision,
}: {
  points: Array<{ ts: number; value: number }>;
  kind: ChartKind;
  unit: string;
  precision: number;
}) {
  if (!points.length) {
    return <p className="hint-line chart-empty">No readings in this window.</p>;
  }
  if (points.length === 1) {
    return (
      <p className="hint-line chart-empty">
        One reading — {tick(points[0].value, precision)}
        {unit ? ` ${unit}` : ''}. A chart needs two; this becomes a line as soon as a collector, an agent or Jarvis
        records another.
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

  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  // Bars grow from zero, so the baseline has to include it. A line does not:
  // forcing zero on a share price flattens the only movement there is.
  const min = kind === 'bar' ? Math.min(0, rawMin) : rawMin;
  const max = rawMax === min ? min + 1 : rawMax;
  const span = max - min;

  const xAt = (i: number) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v: number) => padT + plotH - ((v - min) / span) * plotH;

  const line = points.map((p, i) => `${xAt(i).toFixed(2)},${yAt(p.value).toFixed(2)}`);
  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const timeSpan = Math.max(0, t1 - t0);

  // Three gridlines: top, middle, bottom. Enough to read a value off, few enough
  // that a 10-line-tall card is not a wall of text.
  const grid = [0, 0.5, 1].map((f) => {
    const v = max - span * f;
    return { v, y: yAt(v) };
  });

  const barW = Math.max(1.5, (plotW / points.length) * 0.68);

  return (
    <svg className="metric-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${kind} chart of ${points.length} readings`}>
      {grid.map((g) => (
        <g key={g.y}>
          <line className="chart-grid" x1={padL} x2={W - padR} y1={g.y} y2={g.y} />
          <text className="chart-tick" x={padL - 6} y={g.y + 3} textAnchor="end">
            {tick(g.v, precision)}
          </text>
        </g>
      ))}

      {kind === 'bar' &&
        points.map((p, i) => {
          const y = yAt(p.value);
          const zero = yAt(Math.max(min, 0));
          return (
            <rect
              key={`${p.ts}-${i}`}
              className="chart-bar"
              x={xAt(i) - barW / 2}
              y={Math.min(y, zero)}
              width={barW}
              height={Math.max(1, Math.abs(zero - y))}
            />
          );
        })}

      {kind === 'area' && (
        <polygon
          className="chart-area"
          points={`${xAt(0).toFixed(2)},${(padT + plotH).toFixed(2)} ${line.join(' ')} ${xAt(points.length - 1).toFixed(2)},${(padT + plotH).toFixed(2)}`}
        />
      )}

      {kind === 'step' ? (
        <polyline
          className="chart-line"
          fill="none"
          points={points
            .map((p, i) => {
              const x = xAt(i).toFixed(2);
              const y = yAt(p.value).toFixed(2);
              const prevX = i === 0 ? x : xAt(i - 1).toFixed(2);
              return `${prevX},${y} ${x},${y}`;
            })
            .join(' ')}
        />
      ) : (
        kind !== 'bar' && <polyline className="chart-line" fill="none" points={line.join(' ')} />
      )}

      {points.map((p, i) => (
        <circle key={`d-${p.ts}-${i}`} className="chart-dot" cx={xAt(i)} cy={yAt(p.value)} r={points.length > 60 ? 0 : 2}>
          <title>{`${stamp(p.ts, timeSpan)} · ${tick(p.value, precision)}${unit ? ` ${unit}` : ''}`}</title>
        </circle>
      ))}

      <text className="chart-tick" x={padL} y={H - 6} textAnchor="start">
        {stamp(t0, timeSpan)}
      </text>
      <text className="chart-tick" x={W - padR} y={H - 6} textAnchor="end">
        {stamp(t1, timeSpan)}
      </text>
    </svg>
  );
}
