// The relay's conversation with the hub's RECORD store (`/hub/records`).
//
// WHY IT IS NOT PART OF metrics-remote.mjs.
//   The metric client speaks about series and samples on `/hub/metrics`; this
//   one speaks about objects and rows on `/hub/records`. They are two routers
//   with two vocabularies, and the shapes they return have nothing in common
//   except the envelope. Folding them together would give every caller a
//   half-relevant method list and two meanings for `read`.
//
// THE BASE URL IS DERIVED, NOT CONFIGURED.
//   `METRICS_API` is `http://host/hub/metrics`, so the records router is the
//   same host and prefix with the last segment swapped. A second environment
//   variable would be one more thing to get wrong on a deploy, and getting it
//   wrong fails silently (records would look empty, not broken). `RECORDS_API`
//   still overrides, for a gateway that mounts the two elsewhere.
//
// WHAT THIS NORMALISES, and why every one of these matters:
//   1. `addedFields` is the SOFT-MODE RECEIPT. An object may widen its schema on
//      a write; a caller that did not expect a new column has to be told, or a
//      typo becomes a permanent field nobody notices.
//   2. `rejected` is PER ITEM. A `400` from the batch route means "nothing was
//      accepted", which is the same information as a `200` with every index
//      refused — not a transport failure.
//   3. `404` is a fact ("this object is gone"), never an error string to be
//      pattern-matched, because the delete flow has to tell those apart.
//
// Zero dependencies.

/**
 * `http://host/hub/metrics` → `http://host/hub/records`.
 *
 * Falls back to appending when the base does not end in `metrics`, so a
 * hand-written value still produces a sane URL rather than a silent miss.
 */
export function recordsBaseFrom(metricsBase) {
  const base = String(metricsBase ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/metrics$/.test(base)) return base.replace(/\/metrics$/, '/records');
  return `${base}/records`;
}

/** The hub's object row → ours. `count`/`latestTs` are always present on the wire. */
export function fromWireObject(item) {
  const fields = Array.isArray(item?.fields) ? item.fields : [];
  return {
    key: String(item?.key ?? ''),
    label: String(item?.label ?? item?.key ?? ''),
    strict: item?.strict === true,
    fields: fields.map((f) => ({
      key: String(f?.key ?? ''),
      label: String(f?.label ?? f?.key ?? ''),
      type: String(f?.type ?? 'text'),
      unit: String(f?.unit ?? ''),
      precision: Number(f?.precision) || 0,
    })),
    count: Number(item?.count) || 0,
    latestTs: typeof item?.latestTs === 'number' ? item.latestTs : null,
    createdAt: Number(item?.createdAt) || 0,
    updatedAt: Number(item?.updatedAt) || 0,
  };
}

/** The hub's record row → ours. `ts` may be null, and that is a fact, not a gap. */
export function fromWireRecord(item) {
  return {
    key: String(item?.key ?? ''),
    values: item?.values && typeof item.values === 'object' ? item.values : {},
    ts: typeof item?.ts === 'number' ? item.ts : null,
    createdAt: Number(item?.createdAt) || 0,
    updatedAt: Number(item?.updatedAt) || 0,
  };
}

/**
 * Build the client.
 *
 * `baseUrl` is the RECORDS base, e.g. `http://host/hub/records` — see
 * `recordsBaseFrom` for how that is derived from `METRICS_API`.
 */
export function createRecordsRemote({ baseUrl, token, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const auth = String(token ?? '');
  if (!base) throw new Error('records remote needs a base URL');
  if (!auth) throw new Error('records remote needs a token');

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

  const enc = (v) => encodeURIComponent(String(v));

  /** Per-item refusals, wherever the hub put them. */
  function rejectionsOf(res) {
    const list = Array.isArray(res.body?.rejected)
      ? res.body.rejected
      : Array.isArray(res.body?.details?.rejected)
        ? res.body.details.rejected
        : [];
    return list.map((r) => ({
      index: Number(r?.index),
      field: String(r?.field ?? ''),
      error: String(r?.error ?? 'rejected'),
      code: String(r?.code ?? ''),
    }));
  }

  return {
    baseUrl: base,

    /** Every object with its field list, record count and newest instant. */
    async objects() {
      const res = await call('GET', '/objects');
      if (res.status !== 200) return { ok: false, error: reasonOf(res), status: res.status };
      const items = Array.isArray(res.body?.objects) ? res.body.objects : [];
      return { ok: true, objects: items.map(fromWireObject) };
    },

    /** One object with its newest rows — the schema and the shape in one call. */
    async object(key, limit = 50) {
      const res = await call('GET', `/objects/${enc(key)}?limit=${Number(limit) || 50}`);
      if (res.status === 200) {
        return {
          ok: true,
          object: fromWireObject(res.body?.object),
          records: (Array.isArray(res.body?.records) ? res.body.records : []).map(fromWireRecord),
          total: Number(res.body?.total) || 0,
        };
      }
      if (res.status === 404) return { ok: false, notFound: true, error: reasonOf(res) };
      return { ok: false, error: reasonOf(res), status: res.status };
    },

    /**
     * Declare or extend an object. Merging only ADDS fields, and a type change
     * is `shapeLocked` — a distinct outcome, not a failure, because the caller
     * keeps the stored schema and picks a new field name.
     */
    async declare(input) {
      const res = await call('POST', '/objects', {
        key: input.key,
        ...(input.label === undefined ? {} : { label: String(input.label) }),
        ...(input.strict === undefined ? {} : { strict: input.strict === true }),
        ...(Array.isArray(input.fields) ? { fields: input.fields } : {}),
      });
      if (res.status === 200 || res.status === 201) {
        return { ok: true, created: res.status === 201 || res.body?.created === true, object: fromWireObject(res.body?.object) };
      }
      if (res.status === 409 && res.body?.code === 'FIELD_SHAPE_LOCKED') {
        return { ok: false, shapeLocked: true, error: res.body?.error, current: res.body?.details?.current };
      }
      return { ok: false, error: reasonOf(res), status: res.status };
    },

    /**
     * Rename, re-flag or reshape. `dropFields` edits stored rows, so it travels
     * with the flag the hub insists on rather than being retried after a 400.
     */
    async patch(key, change) {
      const drop = Array.isArray(change?.dropFields) ? change.dropFields : [];
      const res = await call('PATCH', `/objects/${enc(key)}${drop.length ? '?purge=1' : ''}`, {
        ...(change?.label === undefined ? {} : { label: String(change.label) }),
        ...(change?.strict === undefined ? {} : { strict: change.strict === true }),
        ...(Array.isArray(change?.addFields) ? { addFields: change.addFields } : {}),
        ...(drop.length ? { dropFields: drop } : {}),
      });
      if (res.status === 200) {
        return { ok: true, object: fromWireObject(res.body?.object), rewritten: Number(res.body?.rewritten) || 0 };
      }
      if (res.status === 404) return { ok: false, notFound: true, error: reasonOf(res) };
      return { ok: false, error: reasonOf(res), status: res.status };
    },

    /** Forget an object. Refuses while it holds rows unless `purge`. */
    async remove(key, { purge = false } = {}) {
      const res = await call('DELETE', `/objects/${enc(key)}${purge ? '?purge=1' : ''}`);
      if (res.status === 200) return { ok: true, deletedRecords: Number(res.body?.deletedRecords) || 0 };
      if (res.body?.code === 'OBJECT_NOT_EMPTY') {
        return {
          ok: false,
          notEmpty: true,
          count: Number(res.body?.details?.count) || 0,
          error: res.body?.error,
        };
      }
      if (res.status === 404) return { ok: false, notFound: true, error: reasonOf(res) };
      return { ok: false, error: reasonOf(res), status: res.status };
    },

    /**
     * A page of rows, sorted or filtered BY FIELD through `json_extract`.
     *
     * `from`-style defaults are not needed here: an object has no time window,
     * and its rows may have no time at all. Sorting unordered rows last is the
     * store's job, not something to work around.
     */
    async readRecords(key, { limit = 50, offset = 0, sort = '', where = '', order = '' } = {}) {
      const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (sort) qs.set('sort', String(sort));
      if (where) qs.set('where', String(where));
      if (order) qs.set('order', String(order));
      const res = await call('GET', `/objects/${enc(key)}/records?${qs.toString()}`);
      if (res.status === 200) {
        return {
          ok: true,
          records: (Array.isArray(res.body?.records) ? res.body.records : []).map(fromWireRecord),
          total: Number(res.body?.total) || 0,
        };
      }
      if (res.status === 404) return { ok: false, notFound: true, error: reasonOf(res) };
      return { ok: false, error: reasonOf(res), status: res.status };
    },

    /**
     * Upsert rows. Always resolves to per-item results, plus the receipt for any
     * field the write added to the schema.
     */
    async writeRecords(key, records) {
      const res = await call('POST', `/objects/${enc(key)}/records`, { records });
      const rejected = rejectionsOf(res);
      const addedFields = Array.isArray(res.body?.addedFields)
        ? res.body.addedFields.map((f) => ({
            key: String(f?.key ?? ''),
            label: String(f?.label ?? f?.key ?? ''),
            type: String(f?.type ?? 'text'),
            unit: String(f?.unit ?? ''),
            inferred: f?.inferred === true,
          }))
        : [];
      const allRejected = res.status === 400 && rejected.length > 0;
      if (res.status === 200 || res.status === 201 || allRejected) {
        return {
          ok: !allRejected,
          allRejected,
          accepted: Number(res.body?.accepted) || 0,
          records: (Array.isArray(res.body?.records) ? res.body.records : []).map((r) => ({
            key: String(r?.key ?? ''),
            action: String(r?.action ?? ''),
          })),
          addedFields,
          rejected,
          error: allRejected ? rejectionsOf(res)[0]?.error ?? 'no record was accepted' : undefined,
        };
      }
      return { ok: false, accepted: 0, records: [], addedFields: [], rejected, error: reasonOf(res), status: res.status };
    },

    /** Merge into ONE row, or a clean `404` if it is gone. */
    async patchRecord(key, rec, values) {
      const res = await call('PATCH', `/objects/${enc(key)}/records/${enc(rec)}`, { values });
      if (res.status === 200) {
        return {
          ok: true,
          record: fromWireRecord(res.body?.record),
          addedFields: Array.isArray(res.body?.addedFields) ? res.body.addedFields : [],
          rejected: rejectionsOf(res),
        };
      }
      if (res.status === 404) return { ok: false, notFound: true, error: reasonOf(res) };
      return { ok: false, error: reasonOf(res), status: res.status, rejected: rejectionsOf(res) };
    },

    /** Delete one row. */
    async removeRecord(key, rec) {
      const res = await call('DELETE', `/objects/${enc(key)}/records/${enc(rec)}`);
      if (res.status === 200) return { ok: true, deleted: Number(res.body?.deleted) || 0 };
      if (res.status === 404) return { ok: false, notFound: true, deleted: 0, error: reasonOf(res) };
      return { ok: false, deleted: 0, error: reasonOf(res), status: res.status };
    },
  };
}

/** One readable sentence out of an error body. */
function reasonOf(res) {
  const code = res?.body?.code ? `${res.body.code}: ` : '';
  const message = res?.body?.error
    ? String(res.body.error)
    : String(res?.text ?? '').slice(0, 160) || `HTTP ${res?.status}`;
  return `${code}${message}`;
}
