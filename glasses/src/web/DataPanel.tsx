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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSchedule, saveSchedule } from './agents-client';
import {
  collectNow,
  declareSeries as declareMetricSeries,
  deleteSeries,
  fetchMetrics,
  formatDelta,
  formatValue,
  sinceLabel,
  type Collector,
  type MetricSeries,
  type MetricsState,
} from './metrics-client';
import { MicButton } from './Dictate';
import {
  CHART_KINDS,
  CHART_LABELS,
  MetricChart,
  defaultKind,
  normaliseWindow,
  numericPoints,
  pointsInWindow,
  windowChoices,
  type AttributeSeries,
  type ChartKind,
  type WindowKind,
} from './metric-chart';

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
  const plotted = numericPoints(windowed);
  const rows = [...windowed].reverse().slice(0, 60);
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

      {series.type === 'number' && view.kind !== 'table' && plotted.length > 0 ? (
        <MetricChart
          points={plotted}
          kind={view.kind}
          unit={series.unit}
          precision={series.precision}
          attributes={shown}
        />
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
   */
  const [helpDismissed, setHelpDismissed] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  /** The standalone "add a series" form: four fields, no collector. */
  const [seriesDraft, setSeriesDraft] = useState<{ key: string; label: string; unit: string; type: 'number' | 'string' }>({
    key: '',
    label: '',
    unit: '',
    type: 'number',
  });

  const [selectedKey, setSelectedKey] = useState<string | null>(() => readStored<string | null>(LS_SELECTED, null));
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
      if (selectedKey) localStorage.setItem(LS_SELECTED, JSON.stringify(selectedKey));
    } catch {
      /* private mode — the choice lasts the session */
    }
  }, [selectedKey]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_VIEWS, JSON.stringify(views));
    } catch {
      /* private mode */
    }
  }, [views]);

  const reload = useCallback(async () => {    const next = await fetchMetrics();
    setMetrics(next);
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

  const toggleDay = (day: number) =>
    setDraft((d) => ({
      ...d,
      days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day].sort((a, b) => a - b),
    }));

  const series = metrics?.series ?? [];
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
  const groups = useMemo(() => groupSeries(filtered), [filtered]);
  /**
   * The open series: the stored choice if it still exists, otherwise the first.
   * Resolved against the FULL list, not the filtered one — typing in the search
   * box must not silently swap the chart you are reading for a different one.
   */
  const selected = series.find((s) => s.key === selectedKey) ?? series[0] ?? null;
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
      };
    }
    // Nothing chosen yet: pick the kind the READINGS ask for. A launch priced
    // once a quarter is a bar, not a line through a slope nobody measured.
    return { kind: s.type === 'string' ? 'table' : defaultKind(s.points), window: 'all' };
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
      {metrics?.store && !metrics.degraded && (
        <p className="dp-store">
          {metrics.store.mode === 'hub'
            ? 'Saved on your hub — survives redeploys.'
            : 'Saved on this relay’s disk — survives a restart, not a redeploy.'}
        </p>
      )}

      {loading && <p className="hint-line">Loading…</p>}
      {!loading && series.length === 0 && (
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
          {series.length > 0 && (
            <div className="mm-search">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search these numbers"
                aria-label="Search the list of numbers"
                autoComplete="off"
                spellCheck={false}
              />
              {query.trim() !== '' && (
                <>
                  <span className="mm-count">
                    {filtered.length} of {series.length}
                  </span>
                  <button className="mm-clear" onClick={() => setQuery('')} aria-label="Clear the search">
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
          <aside className="metric-master" aria-label="Data points" hidden={filtered.length === 0}>
            {groups.map((g) => (
              <div key={g.prefix} className="mm-group">
                <div className="mm-group-head">{g.prefix}</div>
                {g.items.map((s) => (
                  <MasterRow
                    key={s.key}
                    series={s}
                    active={selected?.key === s.key}
                    onPick={() => setSelectedKey(s.key)}
                  />
                ))}
              </div>
            ))}
          </aside>
          {filtered.length === 0 && series.length > 0 && (
            <p className="mm-none">
              No number matches “{query.trim()}”.{' '}
              <button className="mm-clear" onClick={() => setQuery('')}>
                Clear the search
              </button>
            </p>
          )}
        </div>

        <div className="metric-detail-wrap">
          {selected ? (
            <SeriesDetail
              series={selected}
              collector={collectorsBySeries.get(selected.key)}
              now={metrics?.now ?? Date.now()}
              busy={busy}
              view={viewOf(selected)}
              onView={(next) => setViews((v) => ({ ...v, [selected.key]: next }))}
              onDelete={() => void removeSeries(selected.key)}
              attributes={attributesFor(selected)}
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
