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
//   4. `DELETE /series/{key}` refuses while samples exist (`409 SERIES_NOT_EMPTY`)
//      and there is no route to delete samples. A series with data therefore
//      cannot be removed through the API at all; that is reported, never retried.
//
// Zero dependencies.

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

/** The hub's `source` column holds at most 32 characters (probed, not guessed). */
export const SOURCE_MAX = 32;

/**
 * A URL squeezed into the hub's provenance field.
 *
 * Host first, because the host is what identifies the source; the path is the
 * part that has to give when the field runs out. A silent 300-char send is
 * rejected outright (`samples[0].source must be at most 32 characters`), which
 * takes the whole reading down over a cosmetic field.
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
      const qs = new URLSearchParams({ series: String(series), limit: String(limit) });
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
     * Remove a declaration.
     *
     * `notEmpty` carries the count, because the only honest next step is "delete
     * the readings first" — and there is no route that can. Reported, not retried.
     */
    async remove(key) {
      const res = await call('DELETE', `/series/${encodeURIComponent(key)}`);
      if (res.status === 204) return { ok: true };
      if (res.body?.code === 'SERIES_NOT_EMPTY') {
        return { ok: false, notEmpty: true, count: Number(res.body?.details?.count) || 0, error: res.body?.error };
      }
      return { ok: false, error: reasonOf(res), status: res.status };
    },
  };
}

/** One readable sentence out of an error body, for a log line or the page. */
function reasonOf(res) {
  const code = res?.body?.code ? `${res.body.code}: ` : '';
  const message = res?.body?.error ? String(res.body.error) : String(res?.text ?? '').slice(0, 160) || `HTTP ${res?.status}`;
  return `${code}${message}`;
}
