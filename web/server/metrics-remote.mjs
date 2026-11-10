// The relay's conversation with the hub's metric store.
//
// WHY THIS IS ITS OWN MODULE: every quirk below was discovered by probing the
// live service, and each one is the kind that fails silently or fails loudly at
// the wrong moment. Injected `fetch` so a harness can pin them without a server.
//
// WHAT THE LIVE SERVICE ACTUALLY REQUIRES (probed 2026-11-09):
//   1. `slot` must match [A-Za-z0-9:._-]{1,32} — a SPACE IS REFUSED. The relay's
//      own slot format is `YYYY-MM-DD HH:MM`, so it crosses the wire as
//      `YYYY-MM-DDTHH:MM` and is translated back on the way in. Without this,
//      every sample is rejected with a message about a field name, not a format.
//   2. `value` for a number series must be a JSON NUMBER. `"36.10"` is refused,
//      so this module never forwards a string for a numeric series — the relay
//      has already coerced it.
//   3. A batch where NOTHING was accepted answers `400` with `details.rejected`,
//      not `200` with per-item results. That is not a transport failure and must
//      be read as per-item outcomes, or one bad row looks like an outage.
//   4. `source` holds at most 500 characters — measured by sending 200/500/1000/
//      2000 and reading the per-item reason, which said so by name at 1000. It
//      was 32 when this module was written, and the truncation that field forced
//      is now only a guard against an absurd URL rather than the normal case.
//   5. A series with readings needs its samples deleted FIRST: `DELETE /series/`
//      answers `409 SERIES_NOT_EMPTY`. `DELETE /samples?series=` (idempotent, and
//      only ever scoped to a named series) makes that possible, so `remove` can
//      purge when the wearer asked for it — and must not purge when they did not.
//
// Zero dependencies.

// ONE cap, owned by the store: a transport with its own copy is how 300 and 500
// came to disagree in the first place. Re-exported so a caller (and the harness)
// can ask this module what the wire limit is.
import { SOURCE_MAX } from './metrics.mjs';

export { SOURCE_MAX };

/** `2026-11-09 09:00` → `2026-11-09T09:00`. The wire forbids the space. */
export function toWireSlot(slot) {
  const text = String(slot ?? '').trim();
  if (!text) return undefined;
  return text.replace(' ', 'T');
}

/** `2026-11-09T09:00` → `2026-11-09 09:00`, so the app keeps one format. */
export function fromWireSlot(slot) {
  const text = String(slot ?? '').trim();
  if (!text) return undefined;
  return text.replace('T', ' ');
}

/**
 * A URL fitted into the hub's provenance field.
 *
 * Host first, because the host is what identifies the source; the path is the
 * part that has to give when the field runs out. An oversized send is rejected
 * outright, which takes the whole reading down over a cosmetic field — so this
 * stays a guard even though 500 characters now fits every real URL.
 */
export function shortSource(source) {
  const text = String(source ?? '').trim();
  if (!text || text.length <= SOURCE_MAX) return text;
  try {
    const u = new URL(text);
    const compact = `${u.host}${u.pathname}`.replace(/\/+$/, '');
    return compact.length <= SOURCE_MAX ? compact : compact.slice(0, SOURCE_MAX);
  } catch {
    return text.slice(0, SOURCE_MAX);
  }
}

/**
 * Our sample → the hub's shape.
 *
 * `ts` is deliberately NOT sent: the hub stamps it, and a clock skew between the
 * relay and the gateway would otherwise file readings at the wrong minute.
 */
export function toWireSample(sample) {
  return {
    series: sample.series,
    // A number series must carry a number; a text series must carry a string.
    value: typeof sample.value === 'number' ? sample.value : String(sample.value ?? ''),
    // WHEN the reading was taken. Omitted means "now" on the hub, which is right
    // for a live collector and wrong for a backfill — one missing field turns a
    // month of readings into a single spike at the moment the run happened.
    ...(Number.isFinite(Number(sample.ts)) && Number(sample.ts) > 0 ? { ts: Number(sample.ts) } : {}),
    ...(sample.slot ? { slot: toWireSlot(sample.slot) } : {}),
    ...(sample.source ? { source: shortSource(sample.source) } : {}),
  };
}

/** The hub's reading → ours, with the slot back in local form. */
export function fromWireSample(item) {
  return {
    series: String(item?.series ?? ''),
    ts: Number(item?.ts) || 0,
    value: item?.value,
    ...(item?.slot ? { slot: fromWireSlot(item.slot) } : {}),
    ...(item?.source ? { source: String(item.source) } : {}),
  };
}

/** The hub's series row → the definition shape the relay stores. */
export function fromWireSeries(item) {
  return {
    key: String(item?.key ?? ''),
    label: String(item?.label ?? item?.key ?? ''),
    type: item?.type === 'string' ? 'string' : 'number',
    unit: String(item?.unit ?? ''),
    precision: Number(item?.precision) || 0,
    cadence: String(item?.cadence ?? ''),
    source: String(item?.source ?? ''),
    retention: Number(item?.retention) || 2000,
    count: Number(item?.count) || 0,
    latest: item?.latest ? fromWireSample(item.latest) : null,
  };
}

/**
 * Build the client.
 *
 * `baseUrl` is the METRICS base, e.g. `http://host/hub/metrics` — the routes are
 * appended to it, so a gateway that moves the prefix needs no code change.
 */
export function createMetricsRemote({ baseUrl, token, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const auth = String(token ?? '');
  if (!base) throw new Error('metrics remote needs a base URL');
  if (!auth) throw new Error('metrics remote needs a token');

  async function call(method, path, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${auth}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Connection: 'close',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = await res.text().catch(() => '');
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed, text };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Delete readings for ONE series.
   *
   * `series` is mandatory on the route — a call without it is refused
   * (`VALIDATION_ERROR`), which is the difference between a delete and a wipe.
   * Idempotent: a second call answers `deleted: 0`, so a retry after a timeout
   * cannot report a failure the wearer would act on.
   *
   * A closure rather than a method on the returned object, because `remove`
   * below calls it: `this.removeSamples(...)` would break the moment a caller
   * destructures the client, and that is exactly the kind of bug that only shows
   * up in the one code path nobody exercises.
   */
  async function removeSamples(series, before, slot) {
    const qs = new URLSearchParams({ series: String(series) });
    // `slot` names ONE reading; `before` cuts the history at a moment. They are
    // mutually exclusive on the hub, because a caller that sent both meant one
    // of them and guessing would make an accidental wipe look like an edit.
    if (typeof slot === 'string' && slot.trim() !== '') {
      qs.set('slot', slot.trim());
    } else if (Number.isFinite(Number(before)) && Number(before) > 0) {
      qs.set('before', String(Math.floor(Number(before))));
    }
    const res = await call('DELETE', `/samples?${qs.toString()}`);
    if (res.status === 200) return { ok: true, deleted: Number(res.body?.deleted) || 0 };
    if (res.status === 404) return { ok: false, notFound: true, deleted: 0, error: reasonOf(res) };
    return { ok: false, deleted: 0, error: reasonOf(res), status: res.status };
  }

  return {
    baseUrl: base,

    /** The hub's own view: declarations with their latest reading. */
    async listSeries() {
      const res = await call('GET', '/series');
      if (res.status !== 200) {
        return { ok: false, error: reasonOf(res), status: res.status };
      }
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      return { ok: true, series: items.map(fromWireSeries) };
    },

    /** Readings for one series, oldest first — what a card plots. */
    async read(series, limit = 240) {
      // `from=0` IS NOT OPTIONAL. The hub windows `/samples` to a recent period
      // by default, so a read asking only for `series` + `limit` returns the last
      // day and calls it the history: a month of backfilled PSI showed as one
      // reading. Asking from the epoch means "the newest `limit` readings this
      // series has", which is what every caller of this means.
      const qs = new URLSearchParams({ series: String(series), limit: String(limit), from: '0' });
      const res = await call('GET', `/samples?${qs.toString()}`);
      if (res.status !== 200) return { ok: false, error: reasonOf(res), status: res.status };
      const items = Array.isArray(res.body?.items) ? res.body.items : [];
      return {
        ok: true,
        samples: items.map(fromWireSample),
        truncated: res.body?.truncated === true,
      };
    },

    /**
     * Declare (or refine) a series.
     *
     * `shapeLocked` is a distinct outcome, not a failure: the series exists with a
     * different type or unit, which is the additive-only rule doing its job. The
     * caller logs it and keeps the existing declaration.
     */
    async declare(series) {
      const res = await call('POST', '/series', {
        key: series.key,
        label: series.label,
        unit: series.unit,
        type: series.type,
        precision: series.precision,
        ...(series.cadence ? { cadence: series.cadence } : {}),
        ...(series.source ? { source: series.source } : {}),
        ...(series.retention ? { retention: series.retention } : {}),
      });
      if (res.status === 200 || res.status === 201) {
        return { ok: true, created: res.body?.created === true, series: fromWireSeries(res.body?.item) };
      }
      if (res.status === 409 && res.body?.code === 'SERIES_SHAPE_LOCKED') {
        return { ok: false, shapeLocked: true, current: res.body?.details?.current, error: res.body?.error };
      }
      return { ok: false, error: reasonOf(res), status: res.status };
    },

    /**
     * Append samples. Always resolves to per-item results.
     *
     * `400` with `details.rejected` means "nothing was accepted" — the same
     * information as a `200` with every index rejected, and the caller must not
     * treat it as a transport failure.
     */
    async append(samples) {
      const wire = samples.map(toWireSample);
      const res = await call('POST', '/samples', { samples: wire });
      const rejected = Array.isArray(res.body?.rejected)
        ? res.body.rejected
        : Array.isArray(res.body?.details?.rejected)
          ? res.body.details.rejected
          : [];
      const acceptedCount = Number(res.body?.accepted);
      const allRejected = res.status === 400 && rejected.length > 0;
      if (res.status === 200 || res.status === 201 || allRejected) {
        return {
          ok: !allRejected,
          accepted: Number.isFinite(acceptedCount) ? acceptedCount : allRejected ? 0 : samples.length - rejected.length,
          rejected: rejected.map((r) => ({
            index: Number(r?.index),
            field: String(r?.field ?? ''),
            error: String(r?.error ?? 'rejected'),
          })),
          replaced: (res.body?.samples ?? []).filter((s) => s?.action === 'replaced').length,
          allRejected,
        };
      }
      return { ok: false, error: reasonOf(res), status: res.status, rejected: [], accepted: 0 };
    },

    /**
     * One declaration, or a clean "not found".
     *
     * Worth its own call now that the route exists: a 404 here is a fact ("this
     * series is gone"), not an error string to be pattern-matched, and the
     * delete flow needs to tell those apart.
     */
    async get(key) {
      const res = await call('GET', `/series/${encodeURIComponent(String(key))}`);
      if (res.status === 200) return { ok: true, series: fromWireSeries(res.body?.item) };
      if (res.status === 404) return { ok: false, notFound: true, error: reasonOf(res) };
      return { ok: false, error: reasonOf(res), status: res.status };
    },

    /**
     * Delete readings for ONE series.
     *
     * `series` is mandatory on the route — a call without it is refused
     * (`VALIDATION_ERROR`), which is the difference between a delete and a wipe.
     * Idempotent: a second call answers `deleted: 0`, so a retry after a timeout
     * cannot report a failure the wearer would act on.
     */
    removeSamples,

    /**
     * Remove a declaration.
     *
     * The hub will not drop a series that still holds readings. `purge` is the
     * wearer's explicit answer to "delete its N readings as well?" — and it is
     * opt-in rather than automatic, because silently destroying history to
     * satisfy a delete is not a favour. Without it, `notEmpty` carries the count
     * so the page can ask.
     */
    async remove(key, { purge = false } = {}) {
      const k = String(key);
      let deleted = 0;
      if (purge) {
        const wiped = await removeSamples(k);
        if (!wiped.ok && !wiped.notFound) {
          return { ok: false, deleted: 0, error: `could not delete the readings first: ${wiped.error}` };
        }
        deleted = wiped.deleted;
      }
      const res = await call('DELETE', `/series/${encodeURIComponent(k)}`);
      if (res.status === 204 || res.status === 200) return { ok: true, deleted };
      if (res.body?.code === 'SERIES_NOT_EMPTY') {
        return { ok: false, notEmpty: true, count: Number(res.body?.details?.count) || 0, error: res.body?.error };
      }
      if (res.status === 404) return { ok: false, notFound: true, deleted, error: reasonOf(res) };
      return { ok: false, error: reasonOf(res), status: res.status, deleted };
    },
  };
}

/** One readable sentence out of an error body, for a log line or the page. */
function reasonOf(res) {
  const code = res?.body?.code ? `${res.body.code}: ` : '';
  const message = res?.body?.error ? String(res.body.error) : String(res?.text ?? '').slice(0, 160) || `HTTP ${res?.status}`;
  return `${code}${message}`;
}
