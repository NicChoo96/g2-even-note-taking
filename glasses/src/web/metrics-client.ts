// Browser-side helpers for the Data tab.
//
// Same relay, same credential as everything else — the page never talks to a
// collector's endpoint itself. That matters: a collector's headers may carry a
// key, and a key must live in the relay's request, not in a browser bundle.
import { getStreamToken } from '../auth-token';
import { API_BASE } from '../stream';

export interface MetricPoint {
  ts: number;
  value: number | string;
  /**
   * The reading's identity, when it has one.
   *
   * Two series only line up on the slot — a launch's price and the project name
   * recorded for it were written seconds apart, so nothing about their
   * timestamps says they belong to the same row. Absent for a plain point in
   * time, which is why an attribute cannot be attached to those.
   */
  slot?: string;
}

export interface MetricSeries {
  key: string;
  label: string;
  type: 'number' | 'string';
  unit: string;
  precision: number;
  cadence: string;
  source: string;
  retention: number;
  createdAt?: number;
  /** How many samples are stored right now. */
  count: number;
  latest: { ts: number; value: number | string; source?: string; slot?: string } | null;
  /** Difference from the previous reading; null when there is nothing to compare. */
  delta: number | null;
  /** Which renderer this series deserves, decided by the relay. */
  view: 'stat' | 'series' | 'table';
  provenance: string;
  points: MetricPoint[];
}

export interface Collector {
  series: string;
  at: string;
  days: number[] | null;
  enabled: boolean;
  select: string;
  url: string;
  method: string;
  nextAt: number | null;
}

export interface MetricsState {
  ok: boolean;
  series: MetricSeries[];
  collectors: Collector[];
  updatedAt: number | null;
  now: number;
  /**
   * Where the readings live. `hub` means durable; `relay` means this box's disk.
   * `degraded` is set when the hub is configured but unreachable right now — the
   * page is then showing a copy, and says so.
   */
  store: { mode: 'hub' | 'relay'; api?: string; file?: string; durable: boolean };
  degraded?: boolean;
  error?: string;
}

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const token = getStreamToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// ── Tables (records) ─────────────────────────────────────────────────────────
// The second store, beside the series one. A series is one number over time; a
// table is ROWS whose columns are declared as data, so a column can appear
// without a migration. The page draws both, and the only thing they share is the
// relay they are fetched from.

export interface RecordField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'bool' | 'date';
  unit: string;
  precision: number;
}

export interface RecordRow {
  /** The row's identity. Compared as a string by the store, never normalised. */
  key: string;
  values: Record<string, unknown>;
  /** The row's place in time — `null` when the row has no date, which is legal. */
  ts: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecordTable {
  key: string;
  label: string;
  /** Strict tables REFUSE a column they do not have; soft ones infer it. */
  strict: boolean;
  fields: RecordField[];
  count: number;
  latestTs: number | null;
  records: RecordRow[];
  total: number;
  error?: string;
}

export interface RecordsState {
  ok: boolean;
  objects: RecordTable[];
  now: number;
  store: { mode: 'hub' | 'relay'; api?: string; file?: string; durable: boolean };
  degraded?: boolean;
  error?: string;
}

export async function fetchRecords(): Promise<RecordsState | null> {
  try {
    const res = await fetch(`${API_BASE}/api/records`, { headers: authHeaders() });
    if (!res.ok) return failedRecords(res);
    return (await res.json()) as RecordsState;
  } catch (err) {
    return failedRecords(err);
  }
}

/** Same rule as `failedMetrics`: a refusal is reported, never drawn as "no tables". */
function failedRecords(reason: unknown): RecordsState {
  const error =
    reason instanceof Response
      ? `${reason.status} ${reason.statusText || 'refused'}`
      : reason instanceof Error
        ? reason.message
        : String(reason);
  return {
    ok: false,
    objects: [],
    now: Date.now(),
    store: { mode: 'relay', durable: false },
    degraded: true,
    error:
      /\b401\b/.test(error)
        ? PAIRED_NOT_SIGNED_IN
        : `could not read the tables: ${error}`,
  };
}

export type RecordsResult = (Omit<RecordsState, 'ok'> & { ok: true; deletedRecords?: number; deleted?: number }) | { ok: false; error: string; count?: number };

/** Upsert rows. The table is created by its first write — same rule as the tool. */
export function writeRows(
  key: string,
  records: Array<{ key: string; values: Record<string, unknown> }>,
): Promise<RecordsResult> {
  return post<RecordsResult>(`/api/records/objects/${encodeURIComponent(key)}/records`, { records });
}

/** Merge into one row: the surgical edit — one cell, one row. */
export function patchRow(
  key: string,
  rec: string,
  values: Record<string, unknown>,
): Promise<RecordsResult> {
  return send<RecordsResult>('PATCH', `/api/records/objects/${encodeURIComponent(key)}/records/${encodeURIComponent(rec)}`, { values });
}

/** Delete ONE row. The table itself is a separate, purging decision. */
export function deleteRow(key: string, rec: string): Promise<RecordsResult> {
  return send<RecordsResult>('DELETE', `/api/records/objects/${encodeURIComponent(key)}/records/${encodeURIComponent(rec)}`);
}

/**
 * Delete a table.
 *
 * `purge` deletes its ROWS too, and it is a second decision on purpose: the store
 * refuses to drop a table that still holds rows, and the page must ask rather
 * than assume. The refusal comes back as `count`, which is what the confirm
 * message is built from.
 */
export function deleteTable(key: string, purge = false): Promise<RecordsResult> {
  return send<RecordsResult>('DELETE', `/api/records/objects/${encodeURIComponent(key)}${purge ? '?purge=1' : ''}`);
}

/** Declare a table, or add columns to one. Merging only ever ADDS a column. */
export function declareTable(input: {
  key: string;
  label?: string;
  strict?: boolean;
  fields?: Array<Partial<RecordField> & { key: string; type: RecordField['type'] }>;
}): Promise<RecordsResult> {
  return post<RecordsResult>('/api/records/objects', input);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: authHeaders(body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json().catch(() => ({}))) as T & { error?: string; count?: number };
    if (!res.ok) {
      return {
        ...parsed,
        ok: false,
        error: parsed?.error || `HTTP ${res.status}`,
        ...(typeof parsed?.count === 'number' ? { count: parsed.count } : {}),
      } as T;
    }
    return parsed;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T;
  }
}

/**
 * What the wearer is told when the relay refuses because this surface is a paired
 * device rather than a signed-in owner.
 *
 * ONE sentence, deliberately shared by both stores: the panel draws the warning
 * per store, and two wordings for one cause read as two different faults.
 */
export const PAIRED_NOT_SIGNED_IN =
  'this device is paired, not signed in - the relay refused your data (401). ' +
  'Paste the owner key in Settings, or sign in as the owner in a browser.';

/**
 * Read the dashboard.
 *
 * A REFUSAL IS NOT AN EMPTY STORE. This used to `return null` for every non-OK
 * answer, and the page draws `null` as "No numbers yet — and you do not need an
 * API to start". Inside the .ehpk the relay answered 401 (the package holds a
 * paired-device credential, and these reads were owner-only), so the wearer saw
 * an inviting empty dashboard while the same account showed eight series in the
 * browser. A whole afternoon went into looking for a backend that was not
 * missing. The status is now carried through as `degraded` + the relay's own
 * sentence, which the panel already renders as a warning line.
 */
export async function fetchMetrics(): Promise<MetricsState | null> {
  try {
    const res = await fetch(`${API_BASE}/api/metrics`, { headers: authHeaders() });
    if (!res.ok) return failedMetrics(res);
    return (await res.json()) as MetricsState;
  } catch (err) {
    return failedMetrics(err);
  }
}

/** The same shape the panel draws for a store it could not reach, so a 401 says
 *  WHY instead of rendering as an empty dashboard. */
function failedMetrics(reason: unknown): MetricsState {
  const error =
    reason instanceof Response
      ? `${reason.status} ${reason.statusText || 'refused'}`
      : reason instanceof Error
        ? reason.message
        : String(reason);
  return {
    ok: false,
    series: [],
    collectors: [],
    updatedAt: null,
    now: Date.now(),
    store: { mode: 'relay', durable: false },
    degraded: true,
    error:
      /\b401\b/.test(error)
        ? PAIRED_NOT_SIGNED_IN
        : `could not read the dashboard: ${error}`,
  };
}

export interface CollectorDraft {
  series: string;
  label?: string;
  unit?: string;
  type?: 'number' | 'string';
  select?: string;
  request: { url: string; method: string; headers?: string; bodyTemplate?: string };
}

/**
 * Fetch once, store the reading, and come back with the whole dashboard.
 *
 * The series must already be declared, so the page declares it before calling
 * this — which is the same rule a scheduled collector obeys, not a special case
 * for the button.
 */
export function collectNow(
  draft: CollectorDraft,
): Promise<MetricsState & { ok: boolean; error?: string; sample?: unknown }> {
  return post('/api/metrics/collect', draft);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ...parsed, ok: false, error: parsed?.error || `HTTP ${res.status}` } as T;
    return parsed;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T;
  }
}

/** Remove a series and its samples. Refused by the relay while a collector uses it. */
/**
 * Declare or refine one series.
 *
 * Its own route, because a declaration used to travel inside the whole schedule
 * document: every caller had to read the schedule, edit it and write it back, and
 * one that forgot deleted the wearer's jobs (that is not hypothetical — a probe
 * did it, and the hub answered 200). The relay now does the read-modify-write, so
 * jobs cannot be collateral damage from declaring a series.
 */
export async function declareSeries(series: {
  key: string;
  label?: string;
  unit?: string;
  type?: 'number' | 'string';
  precision?: number;
}): Promise<MetricsState | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/metrics/series`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(series),
    });
    const parsed = (await res.json().catch(() => ({}))) as MetricsState & { error?: string };
    if (!res.ok) return { ok: false, error: parsed?.error || `HTTP ${res.status}` };
    return parsed;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete a series.
 *
 * `purge` deletes its READINGS too. That is a separate decision on purpose: the
 * hub refuses to drop a series that still holds samples, and the page must ask
 * rather than assume — a delete button that silently destroys history is worse
 * than one that says what it will do. The refusal comes back as `count`, which
 * is what the confirm message is built from.
 *
 * The success and failure shapes are a discriminated union on `ok` (spelled
 * `true`/`false`, not `boolean`) so the caller can read `count` without an `in`
 * check that TypeScript cannot narrow through.
 */
export type DeleteSeriesResult =
  | (Omit<MetricsState, 'ok'> & { ok: true; deleted?: number })
  | { ok: false; error: string; count?: number };

export async function deleteSeries(key: string, purge = false): Promise<DeleteSeriesResult> {
  try {
    const res = await fetch(
      `${API_BASE}/api/metrics/series/${encodeURIComponent(key)}${purge ? '?purge=1' : ''}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    const parsed = (await res.json().catch(() => ({}))) as MetricsState & { error?: string; count?: number };
    if (!res.ok) {
      return { ok: false, error: parsed?.error || `HTTP ${res.status}`, ...(parsed?.count ? { count: parsed.count } : {}) };
    }
    return { ...parsed, ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `2431.5` → `2,431.50`, using the series' own precision. Never a bare float. */
export function formatValue(series: MetricSeries, value: number | string | undefined | null): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value;
  const fixed = value.toFixed(series.precision ?? 2);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** The delta line, with its sign, so "up" is never implied. */
export function formatDelta(series: MetricSeries, delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return '';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${formatValue(series, delta)}${series.unit ? ` ${series.unit}` : ''}`;
}

/** A relative "3m ago" for the provenance line. */
export function sinceLabel(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const diff = Math.max(0, now - ts);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
