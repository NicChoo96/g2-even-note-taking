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

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

function MetricCard({
  series,
  collector,
  now,
  busy,
  onDelete,
}: {
  series: MetricSeries;
  collector?: Collector;
  now: number;
  busy: boolean;
  onDelete: () => void;
}) {
  const latestTs = series.latest?.ts ?? null;
  return (
    <article className={`metric-card view-${series.view}`}>
      <header className="metric-head">
        <span className="metric-label">{series.label}</span>
        {series.unit && <span className="metric-unit">{series.unit}</span>}
        <button className="metric-x" onClick={onDelete} disabled={busy} title="Delete this series and its samples" aria-label="Delete series">
          ✕
        </button>
      </header>

      <div className="metric-value">
        {formatValue(series, series.latest?.value ?? null)}
        {series.delta !== null && (
          <span className={series.delta > 0 ? 'metric-delta up' : series.delta > 0 ? 'metric-delta' : 'metric-delta down'}>
            {formatDelta(series, series.delta)}
          </span>
        )}
      </div>

      {series.view === 'series' && <Spark points={series.points} unit={series.unit} />}

      <footer className="metric-foot">
        <span title={series.provenance}>{sinceLabel(latestTs, now)}</span>
        <span>{series.count} reading{series.count === 1 ? '' : 's'}</span>
        {collector ? (
          <span title={collector.url}>
            {collector.at} · {daysLabel(collector.days)}
            {collector.enabled ? '' : ' · paused'}
          </span>
        ) : (
          <span className="warn-inline">manual</span>
        )}
      </footer>
    </article>
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
  const [draft, setDraft] = useState<Draft>(BLANK);
  /** The standalone "add a series" form: four fields, no collector. */
  const [seriesDraft, setSeriesDraft] = useState<{ key: string; label: string; unit: string; type: 'number' | 'string' }>({
    key: '',
    label: '',
    unit: '',
    type: 'number',
  });

  const reload = useCallback(async () => {
    const next = await fetchMetrics();
    setMetrics(next);
    setLoading(false);
    return next;
  }, []);

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

  return (
    <div className="data-panel">
      <div className="panel-label">
        Data · numbers collected on a schedule by plain HTTPS · no model involved
      </div>

      {note && <p className="ok-line">{note}</p>}
      {warn && <p className="warn-line">⚠️ {warn}</p>}
      {metrics?.degraded && (
        <p className="warn-line">⚠️ {metrics.error ?? 'the hub metric store is unreachable'}</p>
      )}
      {metrics?.store?.mode === 'hub' && !metrics.degraded && (
        <p className="hint-line">Readings are stored on the hub — they survive a deploy.</p>
      )}
      {metrics?.store?.mode === 'relay' && (
        <p className="hint-line">
          Readings are stored on the relay at {metrics.store.file ?? 'its own disk'} — they survive a restart, not a
          deploy. Series <em>declarations</em> are stored on the hub with the schedule.
        </p>
      )}

      {loading && <p className="hint-line">Loading…</p>}
      {!loading && series.length === 0 && (
        <p className="hint-line">
          No series yet. Add one below: a URL, a JSON path to the number inside the response, and a time.
        </p>
      )}

      <div className="metric-grid">
        {series.map((s) => (
          <MetricCard
            key={s.key}
            series={s}
            collector={collectorsBySeries.get(s.key)}
            now={metrics?.now ?? Date.now()}
            busy={busy}
            onDelete={() => void removeSeries(s.key)}
          />
        ))}
      </div>

      {/* ── A series with no collector ───────────────────────────────────── */}
      {/* This comes FIRST because it is the smaller decision and the one every
          other path needs: a collector declares its own series, and an agent can
          only write to one that already exists. */}
      <section className="collector-form">
        <div className="panel-label">Add a series</div>
        <p className="hint-line">
          For numbers nothing can fetch — something Jarvis worked out, or a figure you read somewhere. An agent can
          then record it with the dashboard tool. <strong>Type and unit are fixed once added</strong> (a change needs
          a new key), so pick the unit carefully.
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
          title="Add the series so an agent or a collector can write to it"
        >
          {busy ? 'Working…' : 'Add series'}
        </button>
      </section>

      {/* ── A new collector ─────────────────────────────────────────────── */}
      <section className="collector-form">
        <div className="panel-label">Add a collector</div>
        <p className="hint-line">
          One series per collector. The response is read as JSON; <code>select</code> picks the number out of it
          (<code>data.last</code>, <code>items.0.price</code>).
        </p>

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
            Select
            <input
              value={draft.select}
              onChange={(e) => setDraft((d) => ({ ...d, select: e.target.value }))}
              placeholder="data.last"
            />
          </label>
        </div>

        <div className="form-row">
          <label className="grow">
            Headers (JSON)
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
            {draft.method === 'GET' ? 'Query defaults (JSON)' : 'Body (JSON)'}
            <textarea
              rows={2}
              value={draft.bodyTemplate}
              onChange={(e) => setDraft((d) => ({ ...d, bodyTemplate: e.target.value }))}
              placeholder={draft.method === 'GET' ? '{"symbol": "D05"}' : '{"symbol": "D05"}'}
            />
          </label>
        </div>

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
    </div>
  );
}
