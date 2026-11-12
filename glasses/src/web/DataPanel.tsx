// Data tab: numbers a schedule collected, and the collectors that feed them.
//
// WHAT THIS IS NOT: a chart builder. The relay decides which renderer a series
// deserves (`stat` / `series` / `table`) from its declared type and how many
// points exist, and this file draws those three. That is the whole trick behind
// "Jarvis can make a dashboard": the AI writes a DECLARATION, and the drawing is
// code that cannot hallucinate a y-axis.
//
// COLLECTORS ARE PART OF THE SCHEDULE. A collector is a cron job with
// `kind: 'fetch'`, so it is saved through the same PUT the Schedule tab uses and
// lands in the same durable document. Nothing here invents a second source of
// truth.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSchedule, saveSchedule } from './agents-client';
import {
  collectNow,
  declareSeries as declareMetricSeries,
  deleteRow as deleteTableRow,
  deleteSeries,
  deleteTable,
  fetchMetrics,
  fetchRecords,
  formatDelta,
  formatValue,
  patchRow,
  sinceLabel,
  type Collector,
  type MetricSeries,
  type MetricsState,
  type RecordField,
  type RecordRow,
  type RecordTable,
  type RecordsState,
} from './metrics-client';
import { MicButton } from './Dictate';
import {
  applyFilters,
  applyRange,
  facets,
  fieldTitle,
  filterCount,
  filterLabel,
  filterableFields,
  rangeFromInputs,
  rangeLabel,
  toDateInput,
  type RecordFilters,
  type RecordRange,
} from './record-view';
import {
  CHART_KINDS,
  CHART_LABELS,
  PlotChart,
  defaultKind,
  normaliseWindow,
  pointsInWindow,
  windowChoices,
  type AttributeSeries,
  type ChartKind,
  type WindowKind,
} from './metric-chart';
import {
  alignSeries,
  pickXField,
  plotFields,
  sliceWindow,
  slotCount,
  sortRows,
  tableView,
  type SortSpec,
} from './chart-data';

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * How one series is being LOOKED AT on this device.
 *
 * `table` is the fifth option and is deliberately not a chart: a text series, or
 * a wearer who wants the exact rows, gets rows. Nothing here is stored on the
 * hub — see `useViewState`.
 */
type ViewKind = ChartKind | 'table';

interface ViewSpec {
  kind: ViewKind;
  window: WindowKind;
  /**
   * WHICH dimensions sit beside the value in the chart, by attribute series key.
   *
   * Absent means "whatever this series has" — so a series that gains an
   * attribute later shows it without anyone re-configuring anything, and a
   * choice made once is remembered. Stored with the rest of the view, per series,
   * in localStorage; nothing about it is a property of the store.
   */
  fields?: string[];
  /**
   * For a TABLE: which numeric column is plotted.
   *
   * A row has several numbers and only one can be the y axis, so the choice is
   * the wearer's and is remembered per table with the rest of the view. Absent
   * means "the first numeric column", which is a default rather than a claim
   * about which number matters. Kept beside `yFields` so a view stored before
   * multi-column plotting still opens exactly as it was left.
   */
  field?: string;
  /**
   * For a TABLE: WHICH COLUMNS ARE PLOTTED, in order.
   *
   * The columns are data — a later write can infer a new one — so nothing here
   * names a column: the wearer picks, and every numeric column is offered. Absent
   * means "`field`, or the first numeric column".
   */
  yFields?: string[];
  /**
   * For a TABLE: which column runs along the x axis.
   *
   * Not necessarily time. A table may plot price against flat type, or a count
   * against an estate; a date column only decides that the axis is FORMATTED as
   * time and sorted oldest-first. Absent means "the first date column, else the
   * first column".
   */
  xField?: string;
  /**
   * For a TABLE: which column the rows are ORDERED by, and which way.
   *
   * Absent means automatic — a time axis ascending, a category axis alphabetically,
   * which is the order that needs no explanation. Choosing a field ranks the rows
   * by it, and the chart follows that order (as categories, because a time axis
   * out of order draws a line that jumps backwards and looks like bad data).
   */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  /**
   * For a SERIES: other series plotted with it, by key.
   *
   * Two tickers cannot be compared as one line, so the chart takes a set: every
   * series here shares this one's axis, its own colour and its own legend entry.
   * Remembered with the rest of the view — comparing the same three is a habit,
   * not a one-off.
   */
  compare?: string[];
  /**
   * For a TABLE: which COLUMN VALUES the view is restricted to.
   *
   * Excel's filter row, in the store's own vocabulary — a row survives only if it
   * matches every restricted column. Empty is not a filter, so `{}` and absent
   * mean "everything". Remembered with the rest of the view, per table.
   */
  filters?: RecordFilters;
  /** An explicit span of dates, when the presets are not the question asked. */
  range?: RecordRange;
}

/**
 * What is open in the detail pane.
 *
 * The two stores are separate, so the selection says which one it means — a
 * series and a table may share a key without the page silently swapping one for
 * the other.
 */
interface Selection {
  kind: 'series' | 'object';
  key: string;
}

function daysLabel(days: number[] | null): string {
  if (!days || !days.length || days.length === 7) return 'every day';
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(',') === '1,2,3,4,5') return 'weekdays';
  return sorted.map((d) => DAY_NAMES[d] ?? '?').join(', ');
}

/** A sparkline in a viewBox — no library, no layout cost, scales with the card. */
function Spark({ points, unit }: { points: Array<{ ts: number; value: number | string }>; unit: string }) {
  const nums = points.map((p) => Number(p.value)).filter((n) => Number.isFinite(n));
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const w = 100;
  const h = 28;
  const coords = nums.map((n, i) => {
    const x = (i / (nums.length - 1)) * w;
    const y = h - ((n - min) / span) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const last = nums[nums.length - 1];
  const rising = last >= nums[0];
  return (
    <svg className={rising ? 'spark up' : 'spark down'} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={coords.join(' ')} fill="none" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      {unit ? <title>{`min ${min} · max ${max} ${unit}`}</title> : null}
    </svg>
  );
}

/**
 * One row of the master list: the numbers, at a glance.
 *
 * The list is the index and nothing else — no delete button, no form. A list you
 * are choosing from should not also be a place you can destroy something by
 * mis-aiming a click.
 */
function MasterRow({
  series,
  active,
  onPick,
}: {
  series: MetricSeries;
  active: boolean;
  onPick: () => void;
}) {
  const leaf = series.key.split('.').pop() ?? series.key;
  return (
    <button
      type="button"
      className={active ? 'metric-master-row active' : 'metric-master-row'}
      onClick={onPick}
      aria-pressed={active}
    >
      <span className="mm-top">
        <span className="mm-leaf" title={series.key}>{leaf}</span>
        <span className="mm-count">{series.count}</span>
      </span>
      <span className="mm-value">
        {formatValue(series, series.latest?.value ?? null)}
        {series.unit && <span className="mm-unit">{series.unit}</span>}
      </span>
      {series.type === 'number' && series.points.length > 1 && <Spark points={series.points} unit={series.unit} />}
    </button>
  );
}

/**
 * One row of the master list for a TABLE.
 *
 * A table and a series sit in the same index because they are both "the wearer's
 * data" — but a table says what it has rather than showing a number, because
 * "3 rows · 5 columns" is the only true one-line summary of a table. The columns
 * are named, so a table created by an agent is identifiable without opening it.
 */
function TableMasterRow({
  table,
  active,
  onPick,
}: {
  table: RecordTable;
  active: boolean;
  onPick: () => void;
}) {
  const columns = table.fields.map((f) => f.label || f.key).join(', ');
  return (
    <button
      type="button"
      className={active ? 'metric-master-row active' : 'metric-master-row'}
      onClick={onPick}
      aria-pressed={active}
    >
      <span className="mm-top">
        <span className="mm-leaf" title={table.key}>{table.label || table.key}</span>
        <span className="mm-count">{table.count}</span>
      </span>
      <span className="mm-table-meta">
        {table.fields.length} column{table.fields.length === 1 ? '' : 's'}
        {table.strict ? ' · strict' : ''}
      </span>
      <span className="mm-table-cols" title={columns}>
        {columns || 'no columns yet'}
      </span>
    </button>
  );
}

/**
 * The detail pane: the chart, the switcher, and the actual readings.
 *
 * THE SWITCHER IS THE POINT. A series arrives as a column of numbers, and whether
 * that should be read as a trend, a level, or a list of discrete events is a
 * judgement the WEARER makes — not something the model gets to decide, and not
 * something to lock in at creation. So the chart kind and the window live here,
 * per series, on this device, and change nothing on the hub.
 */
function SeriesDetail({
  series,
  collector,
  now,
  busy,
  view,
  onView,
  onDelete,
  attributes,
  others,
}: {
  series: MetricSeries;
  collector?: Collector;
  now: number;
  busy: boolean;
  view: ViewSpec;
  onView: (next: ViewSpec) => void;
  onDelete: () => void;
  /** Text series that sit beside this one, keyed by slot. See `AttributeSeries`. */
  attributes: AttributeSeries[];
  /** Other numeric series, offered for a shared chart. */
  others: MetricSeries[];
}) {
  /**
   * The look-backs this series offers, computed from the readings themselves.
   *
   * A remembered choice can go stale — the series was backfilled, or the window
   * was set when it held three points and it now holds three hundred — so a
   * stored window that is no longer on offer falls back to "All" rather than
   * leaving no chip lit and the chart showing something the buttons deny.
   */
  const choices = windowChoices(series.points);
  const active = choices.some((c) => c.value === view.window) ? view.window : 'all';
  const windowed = pointsInWindow(series.points, active);
  const rows = [...windowed].reverse().slice(0, 60);
  /**
   * THE CHART IS A SET OF SERIES. Its own line plus whatever the wearer asked to
   * compare it with — two tickers cannot be read as one line, and three charts
   * read by eye is not a comparison. A stored key that no longer exists is
   * dropped silently: a series can be deleted, and a chart must not break over a
   * stale preference.
   */
  const compared = (view.compare ?? []).filter((k) => others.some((s) => s.key === k));
  const sources = [series, ...compared.map((k) => others.find((s) => s.key === k) as MetricSeries)];
  const plot = alignSeries(
    sources.map((s) => ({ key: s.key, label: s.label || s.key, unit: s.unit, precision: s.precision, points: s.points })),
  );
  const shownPlot = sliceWindow(plot.slots, plot.series, active);
  /** Six lines is already a lot on a phone; the seventh colour would repeat. */
  const MAX_COMPARE = 5;
  // Which dimensions are shown: the ones chosen, or all of them when nobody has
  // chosen yet — a series that gains an attribute should reveal it rather than
  // stay silent until someone finds a toggle.
  const chosen = view.fields ?? attributes.map((a) => a.key);
  const shown = attributes.filter((a) => chosen.includes(a.key));
  const alsoAt = (slot?: string) =>
    shown.flatMap((a) => {
      const value = slot ? a.bySlot.get(slot) : undefined;
      return value ? [`${a.label}: ${value}`] : [];
    });

  return (
    <section className="metric-detail">
      <header className="md-head">
        <div>
          <div className="metric-label">{series.label}</div>
          <div className="md-key">{series.key}</div>
        </div>
        <button
          className="dp-delete"
          onClick={onDelete}
          disabled={busy}
          title="Delete this number and its readings"
        >
          Delete
        </button>
      </header>

      <div className="metric-value">
        {formatValue(series, series.latest?.value ?? null)}
        {series.delta !== null && (
          <span className={series.delta > 0 ? 'metric-delta up' : series.delta < 0 ? 'metric-delta down' : 'metric-delta'}>
            {formatDelta(series, series.delta)}
          </span>
        )}
      </div>

      <div className="md-controls">
        <div className="md-group">
          <span className="md-controls-label">Chart</span>
          <div className="md-seg" role="group" aria-label="Chart type">
            {CHART_KINDS.map((kind) => (
              <button
                key={kind}
                className={view.kind === kind ? 'active' : ''}
                onClick={() => onView({ ...view, kind })}
                disabled={series.type !== 'number'}
                aria-pressed={view.kind === kind}
              >
                {CHART_LABELS[kind]}
              </button>
            ))}
            <button
              className={view.kind === 'table' ? 'active' : ''}
              onClick={() => onView({ ...view, kind: 'table' })}
              aria-pressed={view.kind === 'table'}
              title="Read the readings as rows"
            >
              Table
            </button>
          </div>
        </div>
        <div className="md-group">
          <span className="md-controls-label">Window</span>
          <div className="md-seg" role="group" aria-label="Time window">
            {choices.map((c) => (
              <button
                key={String(c.value)}
                className={active === c.value ? 'active' : ''}
                onClick={() => onView({ ...view, window: c.value })}
                aria-pressed={active === c.value}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Which dimensions ride along. This is the "how the view looks" switch for
          multi-dimensional data: the labels come from whatever text series sit
          beside this one, so nothing here is BTO-specific, and the choice is
          remembered with the rest of the view. */}
      {attributes.length > 0 && (
        <div className="md-attrs" role="group" aria-label="Show beside the value">
          <span className="md-attrs-label">Also show</span>
          {attributes.map((a) => {
            const on = chosen.includes(a.key);
            return (
              <button
                key={a.key}
                className={on ? 'md-attr-chip active' : 'md-attr-chip'}
                aria-pressed={on}
                onClick={() =>
                  onView({
                    ...view,
                    fields: on ? chosen.filter((k) => k !== a.key) : [...chosen, a.key],
                  })
                }
                title={on ? `Hide ${a.label} in the chart` : `Show ${a.label} in the chart`}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      {/* COMPARE. Two or more series on ONE axis, which is the only way to read
          them against each other. It was a row of chips, which grew with the
          store — a dozen tickers turned the control into a wall of buttons, and
          most of them are unrelated to what you are looking at. A dropdown costs
          one line however many series exist, and it names what is selected. */}
      {series.type === 'number' && others.length > 0 && (
        <div className="md-attrs">
          <span className="md-attrs-label">Series</span>
          <Menu
            className="md-compare"
            label="Compare"
            value={
              compared.length === 0
                ? 'just this one'
                : compared.length === 1
                  ? others.find((s) => s.key === compared[0])?.label || compared[0]
                  : `${compared.length} series`
            }
            active={compared.length > 0}
            title="Plot other series on the same axis"
          >
            <div className="dp-menu-list" role="group" aria-label="Series to compare">
              {others.map((o) => {
                const on = compared.includes(o.key);
                const full = !on && compared.length >= MAX_COMPARE;
                return (
                  <label key={o.key} className={full ? 'dp-menu-opt disabled' : 'dp-menu-opt'} title={o.key}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={full}
                      onChange={() =>
                        onView({
                          ...view,
                          compare: on ? compared.filter((k) => k !== o.key) : [...compared, o.key],
                        })
                      }
                    />
                    <span>{o.label || o.key}</span>
                    {o.unit ? <em>{o.unit}</em> : null}
                  </label>
                );
              })}
            </div>
            {compared.length >= MAX_COMPARE && (
              <p className="hint-line">Six lines is the limit — untick one first.</p>
            )}
            {compared.length > 0 && (
              <button type="button" className="dp-menu-clear" onClick={() => onView({ ...view, compare: [] })}>
                Clear
              </button>
            )}
          </Menu>
        </div>
      )}

      {series.type === 'number' && view.kind !== 'table' && slotCount(shownPlot.slots) > 0 ? (
        <PlotChart slots={shownPlot.slots} series={shownPlot.series} kind={view.kind} attributes={shown} />
      ) : null}

      {rows.length === 0 ? (
        <p className="hint-line">
          No readings yet. Nothing feeds this one — tell Jarvis a value, or add an API collector.
        </p>
      ) : (
        <>
          <table className="metric-readings">
            <thead>
              <tr>
                <th>When</th>
                <th className="num">Value</th>
                {shown.length > 0 && <th>Also</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={`${p.ts}-${i}`}>
                  <td>{new Date(p.ts).toLocaleString()}</td>
                  <td className="num">{formatValue(series, p.value)}</td>
                  {shown.length > 0 && <td className="metric-also">{alsoAt(p.slot).join(' · ')}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {windowed.length > rows.length && (
            <p className="hint-line">Showing the newest {rows.length} of {windowed.length} readings in this window.</p>
          )}
        </>
      )}

      <footer className="metric-foot">
        <span title={series.provenance}>{sinceLabel(series.latest?.ts ?? null, now)}</span>
        <span>{series.count} reading{series.count === 1 ? '' : 's'}</span>
        {collector ? (
          <span title={collector.url}>
            {collector.at} · {daysLabel(collector.days)}
            {collector.enabled ? '' : ' · paused'}
          </span>
        ) : (
          <span className="warn-inline">no collector</span>
        )}
      </footer>
    </section>
  );
}

/** One cell, rendered with its column's own unit and precision. */
function cellText(field: RecordField, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    const digits = Math.max(0, Math.min(6, field.precision ?? 2));
    const [whole, frac] = n.toFixed(digits).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${frac ? `${grouped}.${frac}` : grouped}${field.unit ? ` ${field.unit}` : ''}`;
  }
  if (field.type === 'bool') return value ? 'yes' : 'no';
  return String(value);
}

/**
 * When the row sits in time — only when the row key does not already say it.
 *
 * A listing keyed by its own date (`2023-10-15`) would otherwise print the same
 * day twice in the first column: once as the identity, once as the instant. The
 * line is kept when the key says nothing about time OR when the instant comes
 * from a different column, because then it is information rather than an echo.
 */
function rowWhen(row: RecordRow): string {
  if (typeof row.ts !== 'number') return '';
  const day = new Date(row.ts).toISOString().slice(0, 10);
  if (row.key.slice(0, 10) === day) return '';
  return new Date(row.ts).toLocaleDateString();
}

/**
 * A dropdown that closes when you tap ANYWHERE else.
 *
 * WHY NOT `<details>`: a disclosure closes only on its own summary. On a phone the
 * panel is pinned to the bottom of the viewport and covers the chip that opened
 * it, so there was no way out except reloading the page — the wearer said exactly
 * that. This is a button plus a panel, with a document-level pointerdown listener
 * that closes it when the tap lands outside, plus Escape for a keyboard.
 *
 * It stays a disclosure in every way that matters: one button, one panel, no focus
 * trap, and the panel is a normal child of the page.
 */
function Menu({
  label,
  value,
  active,
  className,
  title,
  children,
}: {
  label: string;
  value: string;
  /** Highlighted when this menu is doing something (a filter is on, a compare is set). */
  active?: boolean;
  className?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Capture phase: a panel that stops propagation must not trap the tap.
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`dp-menu${open ? ' open' : ''}${active ? ' active' : ''}${className ? ` ${className}` : ''}`} ref={ref}>
      <button
        type="button"
        className="dp-menu-btn"
        aria-expanded={open}
        aria-haspopup="true"
        title={title ?? label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dp-menu-label">{label}</span>
        <span className="dp-menu-value">{value}</span>
      </button>
      {open && <div className="dp-menu-panel">{children}</div>}
    </div>
  );
}

/**
 * One column's filter, as a dropdown with a search box and checkboxes.
 *
 * WHY MULTI-SELECT. "4-room and 5-room" is one question about flat types, not two
 * separate views; single-select would force a detour through "All" between them.
 */
function RecordFilterMenu({
  field,
  rows,
  selected,
  onChange,
}: {
  field: RecordField;
  /** The UNFILTERED rows: the option list must not shrink to what is left. */
  rows: RecordRow[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const options = facets(rows, field);
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.value.toLowerCase().includes(q)) : options;
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  return (
    <Menu
      className="rec-filter"
      label={fieldTitle(field)}
      value={filterLabel({ [field.key]: selected }, field)}
      active={selected.length > 0}
      title={`Filter by ${field.key}`}
    >
      {options.length > 6 && (
        <input
          type="search"
          className="dp-menu-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${fieldTitle(field).toLowerCase()}`}
          aria-label={`Search ${fieldTitle(field)} values`}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      <div className="dp-menu-list" role="group" aria-label={`${fieldTitle(field)} values`}>
        <label className="dp-menu-opt">
          <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
          <span>All</span>
          <em>{rows.length}</em>
        </label>
        {shown.slice(0, 40).map((o) => (
          <label key={o.value} className="dp-menu-opt">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
            <span title={o.value}>{o.value}</span>
            <em>{o.count}</em>
          </label>
        ))}
        {shown.length > 40 && <p className="hint-line">+{shown.length - 40} more — type to narrow</p>}
        {shown.length === 0 && <p className="hint-line">No value matches “{q}”.</p>}
      </div>
    </Menu>
  );
}

/**
 * One TABLE, read closely: its rows as a real table, and any numeric column as a
 * chart.
 *
 * WHY THE CHART AND THE TABLE ARE THE SAME VIEW.
 *   A row is several numbers and one of them can be the y axis, so the axis is a
 *   CHOICE (the chips above the table) rather than a property of the table. The
 *   tooltip then reads the chosen number's row and shows the rest of its cells —
 *   which is the multi-dimensional tooltip this store exists to make honest: it
 *   is the row itself, not four series that happen to share a slot.
 *
 * WHY EDITING IS INLINE.
 *   A row can be wrong in one cell, and a correction should not mean re-typing
 *   the row. The form sends only what it changed, and the store merges it.
 */
function TableDetail({
  table,
  view,
  busy,
  onView,
  onDelete,
  onDeleteRow,
  onSaveRow,
}: {
  table: RecordTable;
  view: ViewSpec;
  busy: boolean;
  onView: (next: ViewSpec) => void;
  onDelete: () => void;
  onDeleteRow: (rowKey: string) => void;
  onSaveRow: (rowKey: string, values: Record<string, unknown>) => Promise<boolean>;
}) {
  /** The row being edited, and its draft text per column. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  /** Every numeric column may be plotted; which ones EXIST is the store's business. */
  const numeric = plotFields(table.fields);
  /**
   * THE AXIS IS A CHOICE, NOT A PROPERTY. The columns are data, so nothing here
   * may name one: a date column makes the axis TIME (formatted, oldest first),
   * and any other column makes it a category of whatever that cell holds. A
   * stored key that no longer exists falls back rather than breaking the view — a
   * column can be renamed by the next schema change.
   */
  const xField =
    view.xField && table.fields.some((f) => f.key === view.xField) ? view.xField : pickXField(table.fields);
  const xInfo = table.fields.find((f) => f.key === xField);
  const chosenY = (view.yFields ?? (view.field ? [view.field] : [])).filter((k) =>
    numeric.some((f) => f.key === k),
  );
  const yFields = chosenY.length ? chosenY : numeric[0] ? [numeric[0].key] : [];
  const filters = view.filters ?? {};
  const range = view.range;
  /**
   * THE ONE ROW SET. Chart, tooltip, table and counts all read from here, so the
   * chart cannot describe rows the list does not show.
   */
  const matching = applyRange(applyFilters(table.records, filters), range);
  /**
   * ONE ORDER, shared by the chart and the table.
   *
   * A wearer who sorts by price expects the rows underneath to be in that order
   * too — a ranked chart above an unsorted list is two answers to one question.
   */
  const sortSpec: SortSpec | undefined =
    view.sortBy && table.fields.some((f) => f.key === view.sortBy)
      ? { by: view.sortBy, dir: view.sortDir ?? 'asc' }
      : undefined;
  const ordered = sortRows(matching, table.fields, sortSpec);
  /**
   * THE ROWS → SLOTS. `tableView` sorts a time axis OLDEST FIRST, which is the
   * fix for a chart that drew 2026 on the left: the store hands rows back
   * newest-first, and a trend read right to left is a trend that is not there.
   * Rows with nothing in the x column are left out and COUNTED, so the chart can
   * say how many it could not place instead of quietly dropping them.
   */
  const points = tableView(ordered, table.fields, xField, yFields, sortSpec);
  const choices = windowChoices(
    points.slots.kind === 'time' ? points.slots.ts.map((ts) => ({ ts, value: 0 })) : [],
  );
  // An explicit range IS the window, so the presets step aside rather than
  // multiplying into "the last 3 months of 2018-2021", which nobody asked for.
  const activeWindow = range ? 'all' : choices.some((c) => c.value === view.window) ? view.window : 'all';
  const shownPlot = sliceWindow(points.slots, points.series, activeWindow);
  /**
   * Two columns on one axis share one scale, so if their magnitudes are far
   * apart the smaller one is a flat line along the bottom and looks like missing
   * data. Nothing here rescales them (a second y axis invents a comparison that
   * was never measured); it says so and lets the wearer plot them one at a time.
   */
  const scales = shownPlot.series
    .map((s) => ({
      label: s.label,
      max: Math.max(0, ...s.values.filter((v): v is number => v !== null).map((v) => Math.abs(v))),
    }))
    .filter((s) => s.max > 0);
  const biggest = scales.reduce((a, b) => (b.max > a.max ? b : a), { label: '', max: 0 });
  const smallest = scales.reduce((a, b) => (b.max < a.max ? b : a), { label: '', max: Infinity });
  const spread = scales.length > 1 && smallest.max > 0 ? biggest.max / smallest.max : 1;
  const scaleGap =
    spread >= 20
      ? `${biggest.label} and ${smallest.label} are about ${Math.round(spread)}x apart, so ${smallest.label} will read as a flat line. Untick one to read it on its own.`
      : '';
  /** The other columns, keyed by ROW KEY — every cell of the row, in the tooltip. */
  const attributes: AttributeSeries[] = table.fields
    .filter((f) => f.type !== 'number' && f.key !== xField)
    .map((f) => {
      const bySlot = new Map<string, string>();
      for (const r of matching) {
        const text = cellText(f, r.values[f.key]);
        if (text) bySlot.set(r.key, text);
      }
      return { key: f.key, label: fieldTitle(f), bySlot };
    })
    .filter((a) => a.bySlot.size > 0);

  /** The columns worth narrowing by: labels, not the numbers being plotted. */
  const menuFields = filterableFields(table.records, table.fields);
  /** True when the view is narrowed — a filter or an explicit range is on. */
  const narrow = filterCount(filters) > 0 || Boolean(range);
  const setFilter = (key: string, values: string[]) => {
    const next: RecordFilters = { ...filters };
    if (values.length) next[key] = values;
    else delete next[key];
    onView({ ...view, filters: next });
  };
  const clearLenses = () => onView({ ...view, filters: {}, range: undefined });

  const startEdit = (row: RecordRow) => {
    const next: Record<string, string> = {};
    for (const f of table.fields) {
      const v = row.values[f.key];
      next[f.key] = v === null || v === undefined ? '' : String(v);
    }
    setDraft(next);
    setEditing(row.key);
  };

  const save = async (row: RecordRow) => {
    const values: Record<string, unknown> = {};
    for (const f of table.fields) {
      const text = draft[f.key] ?? '';
      const was = row.values[f.key];
      const before = was === null || was === undefined ? '' : String(was);
      if (text === before) continue;
      if (f.type === 'number') {
        // Blank is not zero: a cleared number is left alone rather than stored as 0.
        if (text.trim() === '') continue;
        values[f.key] = Number(text.replace(/,/g, '').trim());
      } else if (f.type === 'bool') {
        values[f.key] = /^(true|yes|on|1)$/i.test(text.trim());
      } else {
        values[f.key] = text;
      }
    }
    if (!Object.keys(values).length) {
      setEditing(null);
      return true;
    }
    setSaving(true);
    try {
      const ok = await onSaveRow(row.key, values);
      if (ok) setEditing(null);
      return ok;
    } finally {
      setSaving(false);
    }
  };

  const columns = table.fields;

  return (
    <section className="metric-detail">
      <header className="md-head">
        <div>
          <div className="metric-label">{table.label}</div>
          <div className="md-key">
            {table.key} · table{table.strict ? ' · strict' : ''}
          </div>
        </div>
        <button className="dp-delete" onClick={onDelete} disabled={busy} title="Delete this table and its rows">
          Delete
        </button>
      </header>

      <div className="md-controls">
        {/* THE AXIS PICKER. Every column is offered, because the columns are data:
            a date makes the axis time, anything else makes it a category. */}
        {table.fields.length > 0 && (
          <label className="md-xaxis">
            <span>X</span>
            <select
              value={xField}
              onChange={(e) => onView({ ...view, xField: e.target.value })}
              title="Which column runs along the x axis"
            >
              {table.fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {fieldTitle(f)}
                  {f.type === 'date' ? ' (date)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* SORT. The order used to be implicit — oldest first, or alphabetical —
            with no way to say "by price". This picks the field, and the rows
            below the chart follow the same order. */}
        {table.fields.length > 1 && (
          <Menu
            className="md-sort"
            label="Sort"
            value={
              sortSpec
                ? `${fieldTitle(table.fields.find((f) => f.key === sortSpec.by) as RecordField)} ${sortSpec.dir === 'desc' ? '↓' : '↑'}`
                : xInfo?.type === 'date'
                  ? 'oldest first'
                  : 'A-Z'
            }
            active={Boolean(sortSpec)}
            title="Which column orders the rows"
          >
            <div className="dp-menu-list" role="group" aria-label="Sort by">
              <label className="dp-menu-opt">
                <input
                  type="radio"
                  name="dp-sort"
                  checked={!sortSpec}
                  onChange={() => onView({ ...view, sortBy: undefined, sortDir: undefined })}
                />
                <span>Automatic</span>
                <em>{xInfo?.type === 'date' ? 'oldest first' : 'A-Z'}</em>
              </label>
              {table.fields.map((f) => (
                <label key={f.key} className="dp-menu-opt">
                  <input
                    type="radio"
                    name="dp-sort"
                    checked={view.sortBy === f.key}
                    onChange={() => onView({ ...view, sortBy: f.key, sortDir: view.sortDir ?? 'asc' })}
                  />
                  <span>{fieldTitle(f)}</span>
                </label>
              ))}
            </div>
            <div className="dp-sort-dir" role="group" aria-label="Sort direction">
              <button
                type="button"
                className={sortSpec?.dir === 'asc' ? 'on' : ''}
                disabled={!sortSpec}
                onClick={() => onView({ ...view, sortDir: 'asc' })}
              >
                ↑ Ascending
              </button>
              <button
                type="button"
                className={sortSpec?.dir === 'desc' ? 'on' : ''}
                disabled={!sortSpec}
                onClick={() => onView({ ...view, sortDir: 'desc' })}
              >
                ↓ Descending
              </button>
            </div>
          </Menu>
        )}
        {/* WHICH COLUMNS ARE PLOTTED. Multi-select, because two numbers per row is
            exactly what a table of rows is for; the last one cannot be turned off,
            or there would be a chart type and nothing to draw. */}
        {numeric.length > 0 && (
          <div className="md-group">
            <span className="md-controls-label">Plot</span>
            <div className="md-seg" role="group" aria-label="Which columns to plot">
              {numeric.map((f) => {
                const on = yFields.includes(f.key);
                return (
                  <button
                    key={f.key}
                    className={on ? 'active' : ''}
                    onClick={() => {
                      const next = on ? yFields.filter((k) => k !== f.key) : [...yFields, f.key];
                      const keep = next.length ? next : [f.key];
                      onView({ ...view, yFields: keep, field: keep[0] });
                    }}
                    aria-pressed={on}
                    title={`${on ? 'Stop plotting' : 'Plot'} ${fieldTitle(f)}`}
                  >
                    <span className="md-chip-text">{f.label || f.key}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {numeric.length > 0 && (
          <div className="md-group">
            <span className="md-controls-label">Chart</span>
            <div className="md-seg" role="group" aria-label="Chart type">
              {CHART_KINDS.map((kind) => (
                <button
                  key={kind}
                  className={view.kind === kind ? 'active' : ''}
                  onClick={() => onView({ ...view, kind })}
                  aria-pressed={view.kind === kind}
                >
                  {CHART_LABELS[kind]}
                </button>
              ))}
              <button
                className={view.kind === 'table' ? 'active' : ''}
                onClick={() => onView({ ...view, kind: 'table' })}
                aria-pressed={view.kind === 'table'}
                title="Just the rows"
              >
                Table
              </button>
            </div>
          </div>
        )}
        {numeric.length > 0 && view.kind !== 'table' && choices.length > 1 && (
          <div className="md-group">
            <span className="md-controls-label">Window</span>
            <div className="md-seg" role="group" aria-label="Time window">
              {choices.map((c) => (
                <button
                  key={String(c.value)}
                  className={activeWindow === c.value ? 'active' : ''}
                  onClick={() => onView({ ...view, window: c.value })}
                  aria-pressed={activeWindow === c.value}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* THE FILTER ROW. A table is a list of rows, and the first question about
          a list of rows is always "which ones?" — a flat type, a project, a
          span of dates. Without this the only lever was the y axis, so two
          flat types drawn on one line was the view you got whether you wanted it
          or not. */}
      {(menuFields.length > 0 || table.records.some((r) => typeof r.ts === 'number')) && (
        <div className="rec-filters" role="group" aria-label="Filter the rows">
          {menuFields.map((f) => (
            <RecordFilterMenu
              key={f.key}
              field={f}
              rows={table.records}
              selected={(filters[f.key] ?? []) as string[]}
              onChange={(next) => setFilter(f.key, next)}
            />
          ))}
          <div className="rec-range">
            <label title="Show rows from this day">
              <span>From</span>
              <input
                type="date"
                value={toDateInput(range?.from)}
                onChange={(e) => onView({ ...view, range: rangeFromInputs(e.target.value, toDateInput(range?.to)) })}
              />
            </label>
            <label title="Show rows up to and including this day">
              <span>To</span>
              <input
                type="date"
                value={toDateInput(range?.to)}
                onChange={(e) =>
                  onView({ ...view, range: rangeFromInputs(toDateInput(range?.from), e.target.value) })
                }
              />
            </label>
          </div>
          {(filterCount(filters) > 0 || range) && (
            <button className="mm-clear" onClick={clearLenses} title="Show every row again">
              Clear
            </button>
          )}
          {(filterCount(filters) > 0 || range) && (
            <span className="rec-filter-summary" aria-live="polite">
              {matching.length} of {table.records.length} rows
              {range ? ` · ${rangeLabel(range)}` : ''}
            </span>
          )}
        </div>
      )}

      {numeric.length === 0 && (
        <p className="hint-line">
          No numeric column yet, so there is nothing to chart. The rows are below.
        </p>
      )}
      {numeric.length > 0 && view.kind !== 'table' && slotCount(shownPlot.slots) > 0 ? (
        <PlotChart
          slots={shownPlot.slots}
          series={shownPlot.series}
          kind={view.kind}
          xTitle={xInfo ? fieldTitle(xInfo) : xField}
          rowKeys={points.rowKeys.slice(shownPlot.start)}
          attributes={attributes}
        />
      ) : null}
      {/* ONE AXIS, SO ONE SCALE. Two columns whose magnitudes are orders apart
          cannot both be read — the smaller one flattens onto the axis — and a
          chart that silently does that looks like a bug in the data. */}
      {scaleGap ? <p className="hint-line">{scaleGap}</p> : null}
      {/* WHAT THE CHART COULD NOT PLACE, said out loud. A row with nothing in the x
          column has no position on any axis, and a chart that silently ignores it
          contradicts the table underneath. */}
      {numeric.length > 0 && view.kind !== 'table' && points.droppedX > 0 ? (
        <p className="hint-line">
          {points.droppedX} row{points.droppedX === 1 ? '' : 's'} left out — nothing in{' '}
          {xInfo ? fieldTitle(xInfo) : 'the x column'} to place {points.droppedX === 1 ? 'it' : 'them'} on.
        </p>
      ) : null}
      {points.collapsed > 0 ? (
        <p className="hint-line">
          {points.collapsed} more row{points.collapsed === 1 ? '' : 's'} share a value already on the axis —
          showing the newest of each. Filter or pick another x column to see them apart.
        </p>
      ) : null}
      {numeric.length > 0 && view.kind !== 'table' && slotCount(shownPlot.slots) === 0 ? (
        <p className="hint-line">
          Nothing to plot against {xInfo ? fieldTitle(xInfo) : 'that column'}. The rows are below.
        </p>
      ) : null}

      {table.records.length === 0 ? (
        <p className="hint-line">
          No rows yet. Jarvis or an agent can add them — a new column appears as the values do.
        </p>
      ) : matching.length === 0 ? (
        <p className="hint-line">
          No row matches these filters{' '}
          <button className="mm-clear" onClick={clearLenses}>
            Clear them
          </button>
        </p>
      ) : (
        <>
          <table className="metric-readings record-table">
            <thead>
              <tr>
                <th>Row</th>
                {columns.map((f) => (
                  <th key={f.key} className={f.type === 'number' ? 'num' : ''} title={`${f.key}: ${f.type}`}>
                    {fieldTitle(f)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {ordered.map((row) => (
                <tr key={row.key} className={editing === row.key ? 'editing' : ''}>
                  <td className="rec-key">
                    <span title={row.key}>{row.key}</span>
                    {rowWhen(row) && <span className="rec-when">{rowWhen(row)}</span>}
                  </td>
                  {columns.map((f) => (
                    <td key={f.key} className={f.type === 'number' ? 'num' : ''}>
                      {editing === row.key ? (
                        f.type === 'bool' ? (
                          <select
                            value={draft[f.key] ?? ''}
                            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                            aria-label={fieldTitle(f)}
                          >
                            <option value="true">yes</option>
                            <option value="false">no</option>
                          </select>
                        ) : (
                          <input
                            value={draft[f.key] ?? ''}
                            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                            inputMode={f.type === 'number' ? 'decimal' : undefined}
                            aria-label={fieldTitle(f)}
                          />
                        )
                      ) : (
                        cellText(f, row.values[f.key])
                      )}
                    </td>
                  ))}
                  <td className="rec-actions">
                    {editing === row.key ? (
                      <>
                        <button onClick={() => void save(row)} disabled={saving}>
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setEditing(null)} disabled={saving}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => startEdit(row)} disabled={busy} title="Edit this row">
                          Edit
                        </button>
                        <button onClick={() => onDeleteRow(row.key)} disabled={busy} title="Delete this row">
                          Del
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!narrow && table.total > table.records.length && (
            <p className="hint-line">
              Showing the newest {table.records.length} of {table.total} rows.
            </p>
          )}
        </>
      )}

      <footer className="metric-foot">
        <span>{table.count} row{table.count === 1 ? '' : 's'}</span>
        <span>{table.fields.length} column{table.fields.length === 1 ? '' : 's'}</span>
        <span>{table.strict ? 'refuses new columns' : 'new columns appear as data arrives'}</span>
      </footer>
    </section>
  );
}

interface Draft {
  key: string;
  label: string;
  unit: string;
  type: 'number' | 'string';
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers: string;
  bodyTemplate: string;
  select: string;
  at: string;
  days: number[];
}

const BLANK: Draft = {
  key: '',
  label: '',
  unit: '',
  type: 'number',
  url: '',
  method: 'GET',
  headers: '',
  bodyTemplate: '',
  select: '',
  at: '09:00',
  days: [],
};

/**
 * The example the empty state and the "no URL" form both start from.
 *
 * Chosen so the three fields teach the shape in one glance: a dotted key that
 * reads as a subject (`news`) and a field (`rates.count`), a unit a person would
 * say out loud, and a label the chart can put on an axis.
 */
const EXAMPLE_SERIES = {
  key: 'news.rates.count',
  label: 'Rate-cut mentions',
  unit: 'mentions',
  type: 'number' as const,
};

/**
 * The master list is grouped by key PREFIX, which is what makes a subject with
 * several numbers legible: `news.rates.count` and `news.rates.sentiment` sit
 * under one heading and read as two columns of the same table, which is the
 * closest honest thing to "fields" this store has (a series is one field).
 */
function groupSeries(series: MetricSeries[]): Array<{ prefix: string; items: MetricSeries[] }> {
  const map = new Map<string, MetricSeries[]>();
  for (const s of series) {
    const prefix = s.key.split('.').slice(0, -1).join('.') || 'series';
    const list = map.get(prefix);
    if (list) list.push(s);
    else map.set(prefix, [s]);
  }
  return [...map.entries()].map(([prefix, items]) => ({ prefix, items }));
}

const LS_SELECTED = 'hub:data:selected';
const LS_VIEWS = 'hub:data:views';

/** A stored view choice, or the fallback. Private mode has no localStorage. */
function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** `{"X-Api-Key": "env:MY_KEY"}` is the documented shape; say so when it is not. */
function headersProblem(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'headers must be a JSON object';
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string') return `header "${k}" must be a string (use "env:NAME" for a secret)`;
    }
    return '';
  } catch {
    return 'headers is not valid JSON';
  }
}

export function DataPanel() {
  const [metrics, setMetrics] = useState<MetricsState | null>(null);
  /**
   * The second store: tables whose columns are data.
   *
   * Fetched with the metrics rather than on demand, because the master list shows
   * both at once — a table you cannot see is a table the wearer will not know
   * Jarvis created.
   */
  const [records, setRecords] = useState<RecordsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [warn, setWarn] = useState('');
  /**
   * Which form is open, if any. `none` on load on purpose: two dense forms sat
   * open on a phone between you and your numbers, and the only way to see the
   * page was to scroll past them. Nothing here is needed to READ the dashboard.
   */
  const [addOpen, setAddOpen] = useState<'none' | 'series' | 'collector'>('none');
  /**
   * The three steps stay OPEN until dismissed, and on a dashboard with no
   * readings they are the whole page — that is the case where someone needs to
   * be told what a series is.
   *
   * ONCE THERE IS DATA THEY ARE IN THE WAY, and they were: three paragraphs
   * between the wearer and the chart on every visit, on a phone. The dismissal is
   * remembered, so "How this works" is a thing you can ask for rather than a thing
   * you scroll past.
   */
  const [helpDismissed, setHelpDismissed] = useState(() => readStored('hub:data:helpSeen', false));
  const [draft, setDraft] = useState<Draft>(BLANK);
  /** The standalone "add a series" form: four fields, no collector. */
  const [seriesDraft, setSeriesDraft] = useState<{ key: string; label: string; unit: string; type: 'number' | 'string' }>({
    key: '',
    label: '',
    unit: '',
    type: 'number',
  });

  /**
   * What is open in the detail pane.
   *
   * Stored as `{kind, key}` since tables arrived: the two stores are separate, and
   * a plain string cannot say which one it meant. A string from before this
   * version is read as a series, so nobody's remembered selection is lost.
   */
  const [selection, setSelection] = useState<Selection | null>(() => {
    const raw = readStored<string | { kind?: string; key?: string } | null>(LS_SELECTED, null);
    if (!raw) return null;
    if (typeof raw === 'string') return { kind: 'series', key: raw };
    if (raw && typeof raw.key === 'string' && raw.key) {
      return { kind: raw.kind === 'object' ? 'object' : 'series', key: raw.key };
    }
    return null;
  });
  const [views, setViews] = useState<Record<string, ViewSpec>>(() => readStored<Record<string, ViewSpec>>(LS_VIEWS, {}));
  /**
   * The master list's filter. Client-side on purpose: the list is already in
   * memory, so searching it must not cost a round trip or blow away the chart
   * you are looking at — this narrows the INDEX, it does not re-query the store.
   */
  const [query, setQuery] = useState('');
  /**
   * A refresh in flight. Kept apart from `busy` because `busy` also disables the
   * add/delete controls, and a refresh must not lock the page while it runs.
   */
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    try {
      if (selection) localStorage.setItem(LS_SELECTED, JSON.stringify(selection));
    } catch {
      /* private mode — the choice lasts the session */
    }
  }, [selection]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_VIEWS, JSON.stringify(views));
    } catch {
      /* private mode */
    }
  }, [views]);

  /**
   * The first visit that has data is the last time the steps are in the way. They
   * are still one tap away in the header, and a dashboard with nothing in it keeps
   * them open because that is exactly the case they exist for.
   */
  useEffect(() => {
    if (helpDismissed || loading) return;
    const hasData = (metrics?.series.length ?? 0) > 0 || (records?.objects.length ?? 0) > 0;
    if (!hasData) return;
    setHelpDismissed(true);
    try {
      localStorage.setItem('hub:data:helpSeen', 'true');
    } catch {
      /* private mode — it comes back next launch, which is harmless */
    }
  }, [helpDismissed, loading, metrics, records]);

  const reload = useCallback(async () => {
    // BOTH stores, in one round of round trips: the master list shows numbers and
    // tables together, and a page that drew one before the other would visibly
    // reflow every time it refreshed.
    const [next, recs] = await Promise.all([fetchMetrics(), fetchRecords()]);
    setMetrics(next);
    if (recs) setRecords(recs);
    setLoading(false);
    return next;
  }, []);

  /**
   * Re-read the dashboard on demand.
   *
   * The page learns about new readings from the store, not from the screen, so
   * a reading written by an agent thirty seconds ago was invisible until a full
   * page reload — which on a phone also loses your position and your selection.
   * This re-reads in place and keeps both.
   */
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await reload();
      setWarn('');
    } catch (err) {
      setWarn(err instanceof Error ? err.message : 'could not refresh');
    } finally {
      setRefreshing(false);
    }
  }, [reload, refreshing]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const collectorsBySeries = useMemo(() => {
    const map = new Map<string, Collector>();
    for (const c of metrics?.collectors ?? []) map.set(c.series, c);
    return map;
  }, [metrics]);

  /** Declare the series (durably, via the schedule) and then fetch one reading. */
  const testNow = async () => {
    setWarn('');
    setNote('');
    const hp = headersProblem(draft.headers);
    if (hp) return setWarn(hp);
    if (!draft.key.trim()) return setWarn('Give the series a key first, e.g. sgx.dbs.price');
    if (!/^https:\/\//i.test(draft.url.trim())) return setWarn('The URL must be https://');

    setBusy(true);
    try {
      const declared = await declareSeries();
      if (!declared) return;
      const res = await collectNow({
        series: draft.key.trim().toLowerCase(),
        select: draft.select.trim(),
        request: {
          url: draft.url.trim(),
          method: draft.method,
          headers: draft.headers.trim(),
          bodyTemplate: draft.bodyTemplate.trim(),
        },
      });
      if (!res.ok) {
        setWarn(res.error || 'the collector failed');
        return;
      }
      setMetrics(res);
      setNote('Fetched one reading and stored it. Nothing is scheduled yet.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Add or update a series declaration in the schedule document.
   *
   * Takes the fields rather than reading `draft`, because there are two callers
   * with different inputs: the collector form (which then schedules a fetch) and
   * the standalone form (which only declares). Factoring it here is what makes a
   * series WITHOUT a collector possible — before this, the only way to declare one
   * was to add a collector you might never schedule, which is a strange thing to
   * ask of someone who just wants Jarvis to be able to record a number.
   */
  const putSeries = async (next: { key: string; label: string; unit: string; type: 'number' | 'string' }): Promise<boolean> => {
    const key = next.key.trim().toLowerCase();
    // ONE call, and it cannot touch the schedule: the relay merges the declaration
    // into the document it already holds. Reading the schedule and writing it back
    // here is what made a series declaration capable of deleting every job.
    const res = await declareMetricSeries({
      key,
      label: next.label.trim() || key,
      unit: next.unit.trim(),
      type: next.type,
    });
    if (res.ok === false) {
      setWarn(('error' in res && res.error) || 'the relay refused that series');
      return false;
    }
    setMetrics(res as MetricsState);
    return true;
  };

  /** The collector form's version: declare from its own draft. */
  const declareSeries = (): Promise<boolean> => putSeries(draft);

  /**
   * Declare a series on its own — no URL, no schedule.
   *
   * This is the step that makes an agent-written series possible: the tool can
   * only write to a series that exists, and until now the only UI that created one
   * also demanded an endpoint. The wearer still decides the key and the unit,
   * because a series' `type` and `unit` are locked once created (a change needs a
   * new key), and because cardinality is a human choice.
   */
  const declareOnly = async () => {
    setWarn('');
    setNote('');
    if (!seriesDraft.key.trim()) return setWarn('Give the series a key first, e.g. sgx.dbs.price');
    setBusy(true);
    try {
      const ok = await putSeries(seriesDraft);
      if (!ok) return;
      await reload();
      setNote(
        `Added ${seriesDraft.key.trim().toLowerCase()}. Nothing collects it yet — an agent can write to it, ` +
          'or add a collector below.',
      );
      setSeriesDraft({ key: '', label: '', unit: '', type: 'number' });
    } finally {
      setBusy(false);
    }
  };

  const jobForSave = (j: {
    agent?: string;
    kind?: string;
    series?: string;
    at: string;
    days: number[] | null;
    ask?: string;
    enabled: boolean;
  }) =>
    j.kind === 'fetch'
      ? { kind: 'fetch', series: j.series, at: j.at, days: j.days, enabled: j.enabled }
      : { agent: j.agent, at: j.at, days: j.days, ask: j.ask, enabled: j.enabled };

  /** Declare the series AND put the collector on the schedule. */
  const saveCollector = async () => {
    setWarn('');
    setNote('');
    const hp = headersProblem(draft.headers);
    if (hp) return setWarn(hp);
    if (!draft.key.trim()) return setWarn('Give the series a key first');
    if (!/^https:\/\//i.test(draft.url.trim())) return setWarn('The URL must be https://');

    setBusy(true);
    try {
      const schedule = await fetchSchedule();
      if (!schedule) {
        setWarn('Could not read the schedule — sign in as the owner to configure collectors.');
        return;
      }
      const key = draft.key.trim().toLowerCase();
      const existingSeries = ((schedule as unknown as { series?: Array<{ key?: string }> }).series ?? []).filter(
        (s) => s.key !== key,
      );
      const jobs = schedule.jobs
        .map((j) => jobForSave(j as never))
        .filter((j) => !((j as { kind?: string; series?: string }).kind === 'fetch' && (j as { series?: string }).series === key));
      jobs.push({
        kind: 'fetch',
        series: key,
        at: draft.at,
        days: draft.days.length ? draft.days : null,
        select: draft.select.trim(),
        request: {
          url: draft.url.trim(),
          method: draft.method,
          headers: draft.headers.trim(),
          bodyTemplate: draft.bodyTemplate.trim(),
        },
        enabled: true,
      } as never);

      const saved = await saveSchedule({
        enabled: schedule.enabled,
        timeZone: schedule.timeZone,
        series: [
          ...existingSeries,
          { key, label: draft.label.trim() || key, unit: draft.unit.trim(), type: draft.type },
        ],
        jobs,
      } as never);
      if (!saved.ok) {
        setWarn(saved.error || 'the relay refused that collector');
        return;
      }
      setNote(
        saved.durable === false
          ? `Saved for this relay only — ${saved.durableError ?? 'the hub did not accept it'}.`
          : `Collecting ${key} at ${draft.at} ${daysLabel(draft.days.length ? draft.days : null)}.`,
      );
      setDraft(BLANK);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const removeSeries = async (key: string) => {
    if (!window.confirm(`Delete series "${key}" and its readings? Collectors must be removed first.`)) return;
    setBusy(true);
    setWarn('');
    setNote('');
    try {
      // First attempt does NOT purge. If the series holds readings the relay
      // answers with the count, and only then is the wearer asked the second,
      // narrower question — "delete those too?". Destroying history has to be an
      // answer someone gave, not a side effect of a delete button.
      let res = await deleteSeries(key);
      if (res.ok === false && typeof res.count === 'number') {
        const go = window.confirm(
          `"${key}" still holds ${res.count} reading${res.count === 1 ? '' : 's'}. ` +
            'Delete those as well, and the series with them?',
        );
        if (!go) {
          setWarn(`Left "${key}" in place with its ${res.count} reading(s).`);
          return;
        }
        res = await deleteSeries(key, true);
      }
      if (res.ok === false) {
        setWarn(('error' in res && res.error) || 'the relay refused that delete');
        return;
      }
      setMetrics(res as MetricsState);
      const gone = (res as { deleted?: number }).deleted ?? 0;
      setNote(gone ? `Deleted ${key} and ${gone} reading${gone === 1 ? '' : 's'}.` : `Deleted ${key}.`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Delete a table.
   *
   * The same two-step the series delete uses, for the same reason: the store will
   * not drop a table that still holds rows, and the page must ASK rather than
   * assume. The refusal carries the count, which is what the second question is
   * built from — destroying rows has to be an answer someone gave.
   */
  const removeTable = async (key: string) => {
    if (!window.confirm(`Delete table "${key}"? A table with rows is refused until you say otherwise.`)) return;
    setBusy(true);
    setWarn('');
    setNote('');
    try {
      let res = await deleteTable(key);
      if (res.ok === false && typeof res.count === 'number') {
        const go = window.confirm(
          `"${key}" still holds ${res.count} row${res.count === 1 ? '' : 's'}. ` +
            'Delete those as well, and the table with them?',
        );
        if (!go) {
          setWarn(`Left "${key}" in place with its ${res.count} row(s).`);
          return;
        }
        res = await deleteTable(key, true);
      }
      if (res.ok === false) {
        setWarn(res.error || 'the relay refused that delete');
        return;
      }
      setRecords(res as RecordsState);
      if (selection?.kind === 'object' && selection.key === key) setSelection(null);
      const gone = res.deletedRecords ?? 0;
      setNote(gone ? `Deleted ${key} and ${gone} row${gone === 1 ? '' : 's'}.` : `Deleted ${key}.`);
    } finally {
      setBusy(false);
    }
  };

  /** Correct one row's cells. Only what changed is sent; the store merges it. */
  const saveRow = async (tableKey: string, rowKey: string, values: Record<string, unknown>): Promise<boolean> => {
    setWarn('');
    setNote('');
    setBusy(true);
    try {
      const res = await patchRow(tableKey, rowKey, values);
      if (res.ok === false) {
        setWarn(res.error || 'the relay refused that change');
        return false;
      }
      setRecords(res as RecordsState);
      setNote(`Updated "${rowKey}".`);
      return true;
    } finally {
      setBusy(false);
    }
  };

  /** Remove one row. The table and its columns stay. */
  const removeRow = async (tableKey: string, rowKey: string) => {
    if (!window.confirm(`Delete row "${rowKey}" from "${tableKey}"?`)) return;
    setBusy(true);
    setWarn('');
    setNote('');
    try {
      const res = await deleteTableRow(tableKey, rowKey);
      if (res.ok === false) {
        setWarn(res.error || 'the relay refused that delete');
        return;
      }
      setRecords(res as RecordsState);
      setNote(`Deleted row "${rowKey}".`);
    } finally {
      setBusy(false);
    }
  };

  const toggleDay = (day: number) =>
    setDraft((d) => ({
      ...d,
      days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day].sort((a, b) => a - b),
    }));

  const series = metrics?.series ?? [];
  const tables = records?.objects ?? [];
  /**
   * The list the search bar shows. Matching key, label and unit means one box
   * answers all three of the questions someone actually types: "the PSI
   * numbers", "the premium one", "the one measured in SGD".
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return series;
    return series.filter(
      (s) =>
        s.key.toLowerCase().includes(q) ||
        (s.label ?? '').toLowerCase().includes(q) ||
        (s.unit ?? '').toLowerCase().includes(q),
    );
  }, [series, query]);
  /** The same search over tables: key, label, and the columns' names. */
  const filteredTables = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter(
      (t) =>
        t.key.toLowerCase().includes(q) ||
        (t.label ?? '').toLowerCase().includes(q) ||
        t.fields.some((f) => f.key.includes(q) || (f.label ?? '').toLowerCase().includes(q)),
    );
  }, [tables, query]);
  const groups = useMemo(() => groupSeries(filtered), [filtered]);
  /**
   * The open thing: the stored choice if it still exists, otherwise the first
   * series. Resolved against the FULL lists, not the filtered ones — typing in
   * the search box must not silently swap the chart you are reading.
   */
  const selectedSeries = series.find((s) => s.key === selection?.key) ?? null;
  const selectedTable = tables.find((t) => t.key === selection?.key) ?? null;
  const openSeries = selection?.kind === 'object' ? null : (selectedSeries ?? series[0] ?? null);
  const openTable = selection?.kind === 'object' ? selectedTable : null;
  /**
   * How to draw one series. An unvisited series starts as a LINE when it holds
   * numbers and a TABLE when it holds text, which is the only default that cannot
   * be wrong: a text series has no axis to draw.
   */
  const viewOf = (s: MetricSeries): ViewSpec => {
    const stored = views[s.key];
    // `window` may be a number, `'all'`, or one of the four old preset names —
    // `normaliseWindow` is the one place that translation happens.
    if (stored) {
      return {
        kind: stored.kind,
        window: normaliseWindow(stored.window),
        ...(Array.isArray(stored.fields) ? { fields: stored.fields } : {}),
        // Comparing three tickers is a habit, not a one-off, so the set survives a
        // reload with the rest of the view.
        ...(Array.isArray(stored.compare) && stored.compare.length ? { compare: stored.compare } : {}),
      };
    }
    // Nothing chosen yet: pick the kind the READINGS ask for. A launch priced
    // once a quarter is a bar, not a line through a slope nobody measured.
    return { kind: s.type === 'string' ? 'table' : defaultKind(s.points), window: 'all' };
  };

  /**
   * How to draw one TABLE.
   *
   * A table has no type of its own, so the default comes from its rows: the kind
   * its dated rows ask for, and the first numeric column. A table with no dated
   * row has nothing to plot and opens as the table it is.
   */
  const viewOfTable = (t: RecordTable): ViewSpec => {
    const numeric = t.fields.filter((f) => f.type === 'number');
    const dated = t.records.filter((r) => typeof r.ts === 'number');
    const stored = views[t.key];
    if (stored) {
      return {
        kind: stored.kind,
        window: normaliseWindow(stored.window),
        ...(stored.field ? { field: stored.field } : {}),
        // The axis and the plotted columns are part of how this table is being
        // looked at: a schema change must not silently re-pick them.
        ...(stored.xField ? { xField: stored.xField } : {}),
        ...(Array.isArray(stored.yFields) && stored.yFields.length ? { yFields: stored.yFields } : {}),
        // The order is a lens too: "by price, highest first" is a way of reading the
        // rows, not a property of them.
        ...(stored.sortBy ? { sortBy: stored.sortBy } : {}),
        ...(stored.sortDir ? { sortDir: stored.sortDir } : {}),
        // The lenses are part of "how this table is being looked at", so a reload
        // must not silently drop them back to every row.
        ...(stored.filters && Object.keys(stored.filters).length ? { filters: stored.filters } : {}),
        ...(stored.range ? { range: stored.range } : {}),
      };
    }
    const points = numeric.length
      ? dated.map((r) => ({ ts: r.ts as number, value: Number(r.values[numeric[0].key]), slot: r.key }))
      : [];
    return {
      kind: points.length > 1 ? defaultKind(points) : 'table',
      window: 'all',
      ...(numeric[0] ? { field: numeric[0].key } : {}),
    };
  };

  /**
   * The text series that sit BESIDE this one: `tengah.bto.4room` + its
   * `…​.project` / `.estate`. Discovered by prefix rather than configured, so the
   * chart works for whatever a series has now — and for whatever it gains later
   * — instead of knowing about BTO launches specifically.
   */
  const attributesFor = (target: MetricSeries): AttributeSeries[] => {
    const prefix = `${target.key}.`;
    return series
      .filter((s) => s.type === 'string' && s.key.startsWith(prefix))
      .map((s) => {
        const bySlot = new Map<string, string>();
        for (const p of s.points) {
          const text = p.value === null || p.value === undefined ? '' : String(p.value).trim();
          if (p.slot && text) bySlot.set(p.slot, text);
        }
        return { key: s.key, label: s.label || s.key.slice(prefix.length), bySlot };
      })
      .filter((a) => a.bySlot.size > 0);
  };

  return (
    <div className="data-panel">
      <div className="dp-head">
        <h2 className="dp-title">Data</h2>
        <button
          className="dp-refresh"
          onClick={() => void refresh()}
          disabled={refreshing || loading}
          aria-label="Refresh the numbers from the store"
          title="Refresh"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          className="dp-help-btn"
          onClick={() => setHelpDismissed((v) => !v)}
          aria-expanded={!helpDismissed}
        >
          {helpDismissed ? 'How this works' : 'Hide help'}
        </button>
      </div>

      {!helpDismissed && (
        <ol className="dp-steps">
          <li>
            <strong>Name one number.</strong> A key like <code>news.rates.count</code> — one reading is one value of
            that number.
          </li>
          <li>
            <strong>Say where it comes from.</strong> An API fetched on a schedule, an agent doing a web search,
            Jarvis, or your own script.
          </li>
          <li>
            <strong>Pick it below and look.</strong> Line, area, bar or table — switching never changes the data.
          </li>
        </ol>
      )}

      {note && <p className="ok-line">{note}</p>}
      {warn && <p className="warn-line">⚠️ {warn}</p>}
      {metrics?.degraded && (
        <p className="warn-line">⚠️ {metrics.error ?? 'the hub metric store is unreachable'}</p>
      )}
      {/* One cause must not read as two faults: both stores refuse for the same
          reason on a paired device, so the second line is suppressed when it is
          the same sentence. */}
      {records?.degraded && records.error !== metrics?.error && (
        <p className="warn-line">⚠️ {records.error ?? 'the hub table store is unreachable'}</p>
      )}
      {metrics?.store && !metrics.degraded && (
        <p className="dp-store">
          {metrics.store.mode === 'hub'
            ? 'Saved on your hub — survives redeploys.'
            : 'Saved on this relay’s disk — survives a restart, not a redeploy.'}
        </p>
      )}

      {loading && <p className="hint-line">Loading…</p>}
      {/* A REFUSED read is not an empty dashboard. Offering "Start from the
          example" over a 401 invites the wearer to build something the relay has
          already said it will not store. */}
      {!loading && !metrics?.degraded && series.length === 0 && tables.length === 0 && (
        <div className="dp-empty">
          <p>No numbers yet — and you do not need an API to start.</p>
          <button
            className="primary"
            onClick={() => {
              setSeriesDraft(EXAMPLE_SERIES);
              setAddOpen('series');
            }}
          >
            Start from the example
          </button>
        </div>
      )}

      {/* ── Master · detail ──────────────────────────────────────────────── */}
      {/* The list is the index; the pane is one series read closely. Before
          this, every series was a card of equal size, so the only way to see a
          history was to scroll past everything else — and a series with 200
          readings looked exactly like one with 2. */}
      <div className="data-split">
        <div className="metric-master-wrap">
          {(series.length > 0 || tables.length > 0) && (
            <div className="mm-search">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search these numbers and tables"
                aria-label="Search the list of numbers and tables"
                autoComplete="off"
                spellCheck={false}
              />
              {query.trim() !== '' && (
                <>
                  <span className="mm-count">
                    {filtered.length + filteredTables.length} of {series.length + tables.length}
                  </span>
                  <button className="mm-clear" onClick={() => setQuery('')} aria-label="Clear the search">
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
          <aside
            className="metric-master"
            aria-label="Data points"
            hidden={filtered.length === 0 && filteredTables.length === 0}
          >
            {groups.map((g) => (
              <div key={g.prefix} className="mm-group">
                <div className="mm-group-head">{g.prefix}</div>
                {g.items.map((s) => (
                  <MasterRow
                    key={s.key}
                    series={s}
                    active={openSeries?.key === s.key}
                    onPick={() => setSelection({ kind: 'series', key: s.key })}
                  />
                ))}
              </div>
            ))}
            {filteredTables.length > 0 && (
              <div className="mm-group">
                {/* Its own heading, not mixed with the series: the two stores
                    answer different questions, and the heading is what tells the
                    wearer which kind of thing they are looking at. */}
                <div className="mm-group-head">tables</div>
                {filteredTables.map((t) => (
                  <TableMasterRow
                    key={t.key}
                    table={t}
                    active={openTable?.key === t.key}
                    onPick={() => setSelection({ kind: 'object', key: t.key })}
                  />
                ))}
              </div>
            )}
          </aside>
          {filtered.length === 0 && filteredTables.length === 0 && (series.length > 0 || tables.length > 0) && (
            <p className="mm-none">
              Nothing matches “{query.trim()}”.{' '}
              <button className="mm-clear" onClick={() => setQuery('')}>
                Clear the search
              </button>
            </p>
          )}
        </div>

        <div className="metric-detail-wrap">
          {openTable ? (
            <TableDetail
              table={openTable}
              busy={busy}
              view={viewOfTable(openTable)}
              onView={(next) => setViews((v) => ({ ...v, [openTable.key]: next }))}
              onDelete={() => void removeTable(openTable.key)}
              onDeleteRow={(rowKey) => void removeRow(openTable.key, rowKey)}
              onSaveRow={(rowKey, values) => saveRow(openTable.key, rowKey, values)}
            />
          ) : openSeries ? (
            <SeriesDetail
              series={openSeries}
              collector={collectorsBySeries.get(openSeries.key)}
              now={metrics?.now ?? Date.now()}
              busy={busy}
              view={viewOf(openSeries)}
              onView={(next) => setViews((v) => ({ ...v, [openSeries.key]: next }))}
              onDelete={() => void removeSeries(openSeries.key)}
              attributes={attributesFor(openSeries)}
              others={series.filter((s) => s.key !== openSeries.key && s.type === 'number' && s.points.length > 0)}
            />
          ) : (
            <p className="hint-line">Nothing to show yet.</p>
          )}
        </div>
      </div>

      {/* ── Add something ──────────────────────────────────────────────── */}
      {/* ONE button, then a choice. The two forms used to sit open at the bottom
          of the page whether or not you were adding anything, which on a phone
          is the first thing you scroll past to reach your own numbers. */}
      <div className="dp-add-bar">
        <button
          className="primary"
          onClick={() => setAddOpen((v) => (v === 'none' ? 'series' : 'none'))}
          aria-expanded={addOpen !== 'none'}
        >
          {addOpen === 'none' ? '+ Add a number' : 'Cancel'}
        </button>
        <span className="hint-line">Nothing fetches it? An agent or Jarvis can write to it.</span>
      </div>

      {addOpen !== 'none' && (
        <div className="md-seg dp-mode" role="tablist" aria-label="Where the numbers come from">
          <button
            className={addOpen === 'series' ? 'active' : ''}
            onClick={() => setAddOpen('series')}
            role="tab"
            aria-selected={addOpen === 'series'}
          >
            Agent or Jarvis writes it
          </button>
          <button
            className={addOpen === 'collector' ? 'active' : ''}
            onClick={() => setAddOpen('collector')}
            role="tab"
            aria-selected={addOpen === 'collector'}
          >
            Fetch from an API
          </button>
        </div>
      )}

      {/* The no-collector path comes FIRST: it is the smaller decision and the
          one every other path needs, because an agent can only write to a series
          that already exists. */}
      {addOpen === 'series' && (
        <section className="collector-form">
          <div className="panel-label">One number, no URL</div>
          <p className="hint-line">
            Name the number once. After this, Jarvis, an agent or your own script can record readings against it — and
            you can also write one by hand below. <strong>Unit and type are fixed afterwards</strong>, so pick the unit
            you want to see.
          </p>
        <div className="form-row">
          <label>
            Series key
            <input
              value={seriesDraft.key}
              onChange={(e) => setSeriesDraft((d) => ({ ...d, key: e.target.value }))}
              placeholder="news.rate.mentions"
            />
          </label>
          <label>
            Label
            <input
              value={seriesDraft.label}
              onChange={(e) => setSeriesDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="Rate mentions"
            />
          </label>
          <label>
            Unit
            <input
              value={seriesDraft.unit}
              onChange={(e) => setSeriesDraft((d) => ({ ...d, unit: e.target.value }))}
              placeholder="count"
            />
          </label>
          <label>
            Type
            <select
              value={seriesDraft.type}
              onChange={(e) => setSeriesDraft((d) => ({ ...d, type: e.target.value as 'number' | 'string' }))}
            >
              <option value="number">number</option>
              <option value="string">text</option>
            </select>
          </label>
        </div>
        <button
          className="primary"
          onClick={() => void declareOnly()}
          disabled={busy || !seriesDraft.key.trim()}
          title="Add the number so an agent or a collector can write to it"
        >
          {busy ? 'Working…' : 'Add it'}
        </button>
        </section>
      )}

      {addOpen === 'collector' && (
        <section className="collector-form">
          <div className="panel-label">Fetch one number from an API</div>
          <p className="hint-line">
            Point it at a JSON URL and tell it where the number lives. The relay does the fetching — your API key
            stays on the server, never in this page.
          </p>

          <div className="dp-example-row">
            <button
              onClick={() => {
                setDraft({
                  ...BLANK,
                  key: 'fx.sgd.usd',
                  label: 'SGD to USD',
                  unit: 'USD',
                  url: 'https://api.frankfurter.app/latest?from=SGD&to=USD',
                  select: 'rates.USD',
                });
                setNote('Filled in a real endpoint — press Test now to fetch one reading.');
              }}
            >
              Try a working example
            </button>
            <span className="hint-line">Frankfurter (free, no key): asks for the SGD→USD rate.</span>
          </div>

        <div className="form-row">
          <label>
            Series key
            <input
              value={draft.key}
              onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
              placeholder="sgx.dbs.price"
            />
          </label>
          <label>
            Label
            <input
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="DBS share price"
            />
          </label>
          <label>
            Unit
            <input
              value={draft.unit}
              onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
              placeholder="SGD"
            />
          </label>
          <label>
            Type
            <select
              value={draft.type}
              onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as 'number' | 'string' }))}
            >
              <option value="number">number</option>
              <option value="string">text</option>
            </select>
          </label>
        </div>

        <div className="form-row">
          <label className="grow">
            URL
            <input
              value={draft.url}
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              placeholder="https://api.example.com/quote"
            />
          </label>
          <label>
            Method
            <select
              value={draft.method}
              onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value as Draft['method'] }))}
            >
              <option>GET</option>
              <option>POST</option>
              <option>PUT</option>
            </select>
          </label>
          <label>
            Where is the number?
            <input
              value={draft.select}
              onChange={(e) => setDraft((d) => ({ ...d, select: e.target.value }))}
              placeholder="data.last"
            />
          </label>
        </div>
        <p className="dp-field-help">
          Dotted path into the JSON, e.g. <code>data.last</code> or <code>rates.USD</code>. Leave it empty when the
          response <em>is</em> the number.
        </p>

        <details className="dp-advanced">
          <summary>Advanced — API key, request body</summary>
          <div className="form-row">
            <label className="grow">
              Headers (only if the API needs a key)
              <textarea
                rows={2}
                value={draft.headers}
                onChange={(e) => setDraft((d) => ({ ...d, headers: e.target.value }))}
                placeholder={'{"X-Api-Key": "env:MY_API_KEY"}'}
              />
            </label>
          </div>
          <div className="form-row">
            <label className="grow">
              {draft.method === 'GET' ? 'Extra query values' : 'Request body'}
              <textarea
                rows={2}
                value={draft.bodyTemplate}
                onChange={(e) => setDraft((d) => ({ ...d, bodyTemplate: e.target.value }))}
                placeholder={'{"symbol": "D05"}'}
              />
            </label>
          </div>
        </details>

        <div className="form-row">
          <label>
            Time
            <input
              type="time"
              value={draft.at}
              onChange={(e) => setDraft((d) => ({ ...d, at: e.target.value }))}
            />
          </label>
          <div className="day-picks">
            {DAY_INITIALS.map((initial, day) => (
              <button
                key={day}
                className={draft.days.includes(day) ? 'primary' : ''}
                onClick={() => toggleDay(day)}
                aria-label={DAY_NAMES[day]}
                aria-pressed={draft.days.includes(day)}
              >
                {initial}
              </button>
            ))}
            <span className="hint-line">{daysLabel(draft.days.length ? draft.days : null)}</span>
          </div>
        </div>

        <div className="form-actions">
          <button onClick={() => void testNow()} disabled={busy || !draft.key || !draft.url}>
            {busy ? 'Working…' : 'Test now'}
          </button>
          <button className="primary" onClick={() => void saveCollector()} disabled={busy || !draft.key || !draft.url}>
            Save + schedule
          </button>
          <MicButton compact onText={(t) => setDraft((d) => ({ ...d, label: d.label || t }))} title="Dictate a label" />
        </div>
        </section>
      )}
    </div>
  );
}
