// The metric store's rules, as pure functions.
//
// WHY THIS IS SEPARATE FROM THE RELAY: everything here is a decision that is
// easy to get subtly wrong and impossible to see from the outside — whether a
// series must be declared before it can receive data, whether a slot can be
// written twice, whether a unit change is allowed, what happens to a string in a
// number series. Importing local-sse.mjs starts a server, so any rule that lives
// there can only ever be asserted as text. These can be driven directly.
//
// THE THREE RULES THAT MAKE THIS SAFE TO POINT AN LLM AT:
//   1. DECLARE BEFORE WRITE. An unknown series is rejected, never auto-created.
//      Otherwise "one series per stock ticker I happened to see" is one prompt
//      away, and the cardinality never comes back down.
//   2. APPEND-ONLY, IDEMPOTENT BY SLOT. `(series, slot)` identifies a sample, so
//      a collector that fires twice in a grace window overwrites its own value
//      instead of plotting two points at the same minute.
//   3. ADDITIVE SCHEMA ONLY. A unit or type change is refused. A genuine change
//      means a NEW series (`foo.v2`), which keeps every chart already drawn
//      honest about the data it was drawn from.
//
// Zero dependencies.

/** Series keys are dotted and boring: `sgx.dbs.price`, `weather.temp`. */
export const SERIES_KEY_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){1,5}$/;

/** What a series may hold. `number` is the only thing charts can plot. */
export const SERIES_TYPES = new Set(['number', 'string']);

/** How many samples one series keeps. Bounded, because a file cannot grow forever. */
export const DEFAULT_RETENTION = 2000;
export const MAX_RETENTION = 20000;

/**
 * How much of a URL the store keeps as provenance.
 *
 * The hub's column accepts 500 — measured by sending 500 (stored verbatim) and
 * 1000 (refused, naming the limit). This was 300, a guess made while the hub
 * still capped the field at 32; every reading kept only the front of its URL as a
 * result. One constant, exported so the transport clips at the same limit the
 * store keeps, instead of two numbers that drift.
 */
export const SOURCE_MAX = 500;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a series declaration.
 *
 * Returns a VALUE, never throws — the caller is an HTTP route and a model's
 * output, which is exactly where a throw becomes a 500 instead of a sentence the
 * model can act on.
 */
export function normaliseSeries(input) {
  if (!isPlainObject(input)) return { ok: false, error: 'a series must be an object' };
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!SERIES_KEY_RE.test(key)) {
    return {
      ok: false,
      error: `key "${key}" must be dotted, lowercase and 2–6 segments (e.g. sgx.dbs.price)`,
    };
  }
  const type = String(input.type ?? 'number').trim().toLowerCase();
  if (!SERIES_TYPES.has(type)) return { ok: false, error: `type "${type}" is not number or string` };
  const unit = String(input.unit ?? '').trim().slice(0, 24);
  const label = String(input.label ?? '').trim().slice(0, 80) || key;
  const retentionRaw = Number(input.retention);
  const retention = Number.isFinite(retentionRaw)
    ? Math.max(2, Math.min(MAX_RETENTION, Math.floor(retentionRaw)))
    : DEFAULT_RETENTION;
  return {
    ok: true,
    series: {
      key,
      label,
      type,
      unit,
      precision: normalisePrecision(input.precision, type),
      cadence: String(input.cadence ?? '').trim().slice(0, 24),
      source: String(input.source ?? '').trim().slice(0, SOURCE_MAX),
      retention,
    },
  };
}

/**
 * Find a series DECLARATION by key, across every place declarations live.
 *
 * The bug this exists for: `write` looked the definition up in the relay's local
 * `metricStore` while `list` asked the HUB. With the hub configured, declarations
 * live in the schedule document (`cronConfig.series`, mirrored to the hub) and
 * the local map is EMPTY — so listing showed six `psi.*` series with readings and
 * every write to them answered "unknown series". Same session, same minute,
 * contradictory answers, and no reading could be recorded at all.
 *
 * Sources are tried in the caller's order of authority; the first hit wins. A
 * missing list is skipped rather than throwing, because one of these is a plain
 * object map and the other is an array.
 */
export function seriesDefinition(key, ...sources) {
  const wanted = String(key ?? '').trim().toLowerCase();
  if (!wanted) return null;
  for (const source of sources) {
    if (!source) continue;
    const list = Array.isArray(source) ? source : Object.values(source);
    const hit = list.find((s) => String(s?.key ?? '').toLowerCase() === wanted);
    if (hit) return hit;
  }
  return null;
}

function normalisePrecision(raw, type) {
  if (type !== 'number') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(6, Math.floor(n)));
}

/**
 * Validate one sample against its DECLARED series.
 *
 * The failure this exists to prevent: a prompt asks for a price, the endpoint
 * returns `"last": "2,431.50"` (a string, with a comma) and it lands in a number
 * series as a chart that silently drops a point. Anything not finite is refused
 * with the reason, so the run reports a rejected sample instead of a gap nobody
 * notices.
 */
export function normaliseSample(input, series, now = Date.now()) {
  if (!isPlainObject(input)) return { ok: false, error: 'a sample must be an object' };
  if (!series) return { ok: false, error: 'unknown series — declare it first' };
  const raw = input.value;
  let value;
  if (series.type === 'number') {
    // A numeric STRING is accepted ({@code "2431.5"}), because half the APIs in
    // the world quote numbers. A string that is not numeric is not coerced.
    //
    // ⚠ BLANK IS NOT ZERO. `Number('')` and `Number(null)` are both 0, so the
    // first version of this stored a missing reading as a genuine 0 — a chart
    // that drops to zero because an endpoint renamed a field is the worst kind
    // of wrong: it looks like data.
    const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    const n = typeof raw === 'number' ? raw : blank ? Number.NaN : Number(String(raw).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) {
      return { ok: false, error: `value ${JSON.stringify(raw)} is not a number (series "${series.key}" holds numbers)` };
    }
    value = n;
  } else {
    value = String(raw ?? '').slice(0, 500);
  }
  const tsRaw = Number(input.ts);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : now;
  // The slot is what makes a double fire harmless. Absent, the sample is a point
  // in time, not a slot — both are allowed, but only one can deduplicate.
  const slot = String(input.slot ?? '').trim().slice(0, 40);
  return {
    ok: true,
    sample: {
      series: series.key,
      ts,
      value,
      ...(slot ? { slot } : {}),
      source: String(input.source ?? series.source ?? '').slice(0, SOURCE_MAX),
      runId: String(input.runId ?? '').slice(0, 40),
    },
  };
}

/**
 * Append samples to one series, in place-free fashion (returns the new array).
 *
 * A sample that carries a slot REPLACES the sample with the same slot; one that
 * does not is simply appended. Retention then trims from the oldest end.
 */
export function appendSamples(existing, incoming) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const bySlot = new Map();
  out.forEach((s, i) => {
    if (s?.slot) bySlot.set(s.slot, i);
  });
  let replaced = 0;
  for (const s of incoming) {
    const at = s?.slot ? bySlot.get(s.slot) : undefined;
    if (at !== undefined) {
      out[at] = s;
      replaced += 1;
    } else {
      out.push(s);
      if (s?.slot) bySlot.set(s.slot, out.length - 1);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return { samples: out, replaced };
}

/** Trim to the series' retention, newest kept. */
export function trimSamples(samples, retention = DEFAULT_RETENTION) {
  if (!Array.isArray(samples) || samples.length <= retention) return samples ?? [];
  return samples.slice(samples.length - retention);
}

/** The newest sample, or null. */
export function latestOf(samples) {
  if (!Array.isArray(samples) || !samples.length) return null;
  return samples[samples.length - 1] ?? null;
}

/**
 * Change between the newest and the one before it, for the card's delta.
 * `null` when there is nothing to compare — a first reading is not "+0".
 */
export function deltaOf(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  const prev = samples[samples.length - 2];
  if (typeof latest?.value !== 'number' || typeof prev?.value !== 'number') return null;
  return latest.value - prev.value;
}

/** Which renderer a series deserves. One place, so the UI cannot disagree with itself. */
export function viewKindFor(series, pointCount = 0) {
  if (!series) return 'table';
  if (series.type !== 'number') return 'table';
  if (pointCount >= 3) return 'series';
  return 'stat';
}

/**
 * Read a value out of a JSON body by dotted path: `data.last`, `items.0.price`.
 * Absent path → `undefined` (the caller decides whether that is a rejected sample
 * or a default), and an empty path means "the body itself".
 */
export function dotGet(body, path) {
  const raw = String(path ?? '').trim();
  if (!raw) return body;
  let cursor = body;
  for (const part of raw.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return undefined;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== 'object') return undefined;
    if (!(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** One line naming where the number came from, for the card's provenance line. */
export function describeSample(sample) {
  if (!sample) return 'no readings yet';
  const when = new Date(sample.ts);
  const stamp = Number.isNaN(when.getTime()) ? String(sample.ts) : when.toISOString().replace('T', ' ').slice(0, 16);
  return sample.source ? `${stamp} · ${sample.source}` : stamp;
}
