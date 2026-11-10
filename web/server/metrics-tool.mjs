// The `metrics` tool as the RELAY sees it: how an AGENT reads and writes numbers.
//
// WHY IT EXISTS: a collector is a dumb HTTPS call — good for a field at a URL,
// useless for a number the model had to compute (a sum, a ratio, "how many of
// these headlines mention rates"). This tool is the other half: the model stores
// what it worked out, under a series that was already declared.
//
// THE RULES THAT KEEP AN LLM FROM MAKING A MESS:
//   1. DECLARE IS ALLOWED NOW, BUT IT IS BOUNDED. This used to have no
//      `declare` at all: series cardinality "never comes back down". That was a
//      real protection and it produced a worse failure — a run that gathered a
//      month of readings and had nowhere to put them lost the whole task, and
//      the wearer had to go declare a schema on the web first. So the tool can
//      create a series, under four limits: the key must obey the same dotted
//      rule a human's does, the type is fixed at creation, a total SERIES_CAP
//      bounds the store, and `source` records that a MODEL made it so the Data
//      page can show it as agent-created rather than something the wearer typed.
//   2. WRITE IS VALIDATED BY THE STORE, not here. A string in a number series, a
//      blank value, an unknown key — each comes back as the store's own sentence,
//      so the model cannot be told one thing by this tool and another by the
//      endpoint.
//   3. READ IS BOUNDED. A model that asks for a million points gets a page and is
//      told it was truncated, never a silent sample of the truth.
//
// Pure with injected dependencies, like location-tool.mjs: a harness drives it
// with a stub store, and nothing in here knows what a socket is.

export const METRICS_KIND = 'metrics';

/** The model-facing name, so dispatch and the schema agree by name. */
export const METRICS_TOOL_NAME = 'jarvis_metrics';

/** How many points a single `read` may return. */
export const MAX_READ_POINTS = 240;

export function isMetricsTool(t) {
  return t?.kind === METRICS_KIND;
}

/** The JSON Schema offered to the model. */
export function metricsToolSchema() {
  return {
    type: 'function',
    function: {
      name: METRICS_TOOL_NAME,
      description:
        'Read, create and record the dashboard series the wearer keeps. `list` shows ' +
        'what exists and its latest value, `read` returns one series\u2019 history, `declare` creates a ' +
        'series so something new can be tracked, and `write` records a value. Declare ONE well-named ' +
        'series per measure (not one per day), because the unit and type are fixed once created and a ' +
        'total cap applies. Values are stored with the scheduled slot, so writing twice for the same ' +
        'slot replaces rather than duplicates.\n\n' +
        'A SERIES HOLDS ONE VALUE PER SLOT. A number series takes numbers; a series declared with ' +
        'valueType "string" takes text (up to 500 characters) and is shown as a table. An ATTRIBUTE ' +
        'that belongs beside a number \u2014 an estate name, a project, a location \u2014 is its own ' +
        'series at the same slot: declare "tengah.bto.4room.project" as a string series and write it ' +
        'for the same slot as the price, then read both and join them by slot. Sending an extra field ' +
        'on a reading is REFUSED, never stored.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'declare', 'write'],
            description:
              'list = what exists; read = one series\u2019 history; declare = create a series; write = store a value.',
          },
          series: {
            type: 'string',
            description: 'The series key, e.g. "psi.west". Required for read, declare and write.',
          },
          label: {
            type: 'string',
            description: 'For declare: the label shown on the dashboard, e.g. "PSI west".',
          },
          unit: {
            type: 'string',
            description: 'For declare: the unit, e.g. "PSI", "SGD", "mentions". Keep it short.',
          },
          valueType: {
            type: 'string',
            enum: ['number', 'string'],
            description:
              'For declare: what one reading IS. Default number. Fixed afterwards. Use "string" for ' +
              'an attribute that sits beside a number (a project, an estate, a location): give it its ' +
              'own key under the same prefix, e.g. tengah.bto.4room.project.',
          },
          cadence: {
            type: 'string',
            description: 'For declare: optional advisory hint such as "daily" or "hourly".',
          },
          limit: {
            type: 'integer',
            description: `How many recent points to read (max ${MAX_READ_POINTS}). Default 30.`,
          },
          value: {
            type: 'string',
            description:
              'For write: the reading. A number for a number series (thousands separators are ' +
              'accepted); for a series declared as a string, the text itself, up to 500 characters. ' +
              'Anything the series type cannot hold is refused \u2014 never send a placeholder like "N/A".',
          },
          slot: {
            type: 'string',
            description:
              'For write: identity of the reading, e.g. the day (2026-10-08). Writing the same slot ' +
              'twice replaces the earlier value — that is what makes a re-run safe.',
          },
          at: {
            type: 'string',
            description:
              'For write: WHEN the reading was taken, as an ISO date/time (2026-10-08T13:00+08:00) or ' +
              'epoch milliseconds. Omit for \u201cnow\u201d. Send it when backfilling history, or every ' +
              'backfilled point lands at the moment of the run.',
          },
        },
        required: ['action'],
      },
    },
  };
}

/**
 * The text series that hang under `key.` — a project name beside a price.
 *
 * A reading carries ONE value (see the tool description), so an attribute is a
 * sibling series written at the same slot: `tengah.bto.4room.project`. Nothing
 * links the two except the slot, and a caller that does not know the sibling
 * exists will never ask for it — so `read` fetches them and joins on the slot.
 *
 * Never fatal: an attribute is a bonus, and a read that fails because a bonus
 * could not be fetched would be a worse answer than one without it.
 */
async function siblingAttributes(key, list, read, limit) {
  if (!list || !read) return [];
  let series = [];
  try {
    const res = await list();
    series = Array.isArray(res?.series) ? res.series : [];
  } catch {
    return [];
  }
  const prefix = `${key}.`;
  const names = series
    .filter((s) => s && typeof s.key === 'string' && s.key.startsWith(prefix) && s.type === 'string')
    .map((s) => s.key)
    .slice(0, 4);
  const out = [];
  for (const name of names) {
    try {
      const res = await read(name, limit);
      if (!res?.ok) continue;
      const bySlot = new Map();
      for (const p of Array.isArray(res.points) ? res.points : []) {
        const text = p?.value === undefined || p?.value === null ? '' : String(p.value).trim();
        if (p?.slot && text) bySlot.set(p.slot, text);
      }
      if (bySlot.size) out.push({ key: name, leaf: name.slice(prefix.length), bySlot });
    } catch {
      /* skip this attribute */
    }
  }
  return out;
}

/** `project=Plantation Dew · estate=Tengah` for one reading, or `''`. */
function attributesAt(attrs, point) {
  if (!point?.slot || !attrs.length) return '';
  const parts = [];
  for (const a of attrs) {
    const value = a.bySlot.get(point.slot);
    if (value) parts.push(`${a.leaf}=${value}`);
  }
  return parts.join(' · ');
}

/**
 * Run one metrics call.
 *
 * `deps` is `{ listSeries, readSeries, writeSample, declareSeries }`, each returning
 * `{ok, ...}` and never throwing. Every failure becomes a SENTENCE the model can
 * act on, because a tool that returns an empty string teaches it that the data
 * was empty.
 */
export async function runMetricsTool(tool, args, deps) {
  const action = String(args?.action ?? 'list').trim().toLowerCase();
  const list = typeof deps?.listSeries === 'function' ? deps.listSeries : null;
  const read = typeof deps?.readSeries === 'function' ? deps.readSeries : null;
  const declare = typeof deps?.declareSeries === 'function' ? deps.declareSeries : null;
  const write = typeof deps?.writeSample === 'function' ? deps.writeSample : null;

  if (action === 'list') {
    if (!list) return { ok: false, text: 'metrics are not available on this relay' };
    const res = await list();
    if (!res?.ok) return { ok: false, text: `could not read the metric series: ${res?.error ?? 'unknown error'}` };
    const series = Array.isArray(res.series) ? res.series : [];
    if (!series.length) {
      return {
        ok: true,
        text:
          'Nothing is tracked yet. Create the series first with action "declare" (key, label, unit), ' +
          'then write readings to it — one series per measure, not one per day.',
      };
    }
    const lines = series.slice(0, 20).map((s) => {
      const latest = s.latest
        ? `${formatNumber(s.latest.value, s.precision)}${s.unit ? ` ${s.unit}` : ''}`
        : 'no readings yet';
      return `- ${s.key} (${s.label}${s.unit ? `, ${s.unit}` : ''}): ${latest} · ${Number(s.count) || 0} point(s)`;
    });
    const more = series.length > 20 ? `\n(+${series.length - 20} more series)` : '';
    return { ok: true, text: `Metric series:\n${lines.join('\n')}${more}` };
  }

  if (action === 'read') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'read needs a series key, e.g. "sgx.dbs.price"' };
    if (!read) return { ok: false, text: 'metrics are not available on this relay' };
    const limitRaw = Number(args?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_READ_POINTS, Math.floor(limitRaw)) : 30;
    const res = await read(key, limit);
    if (!res?.ok) return { ok: false, text: `could not read "${key}": ${res?.error ?? 'unknown error'}` };
    const points = Array.isArray(res.points) ? res.points : [];
    if (!points.length) return { ok: true, text: `"${key}" has no readings yet.` };
    const unit = res.unit ? ` ${res.unit}` : '';
    // ATTRIBUTES THAT SIT BESIDE THE VALUE. A reading holds one value, so a
    // project name kept next to a price lives in its own series at the same
    // slot. Joining them is the entire point of that shape — and it is exactly
    // the step a caller forgets, because it is invisible from here: the answer
    // says "339000" and the estate is in another series nobody asked for. So
    // the join happens here, keyed on the slot, and each row comes back whole.
    const attrs = await siblingAttributes(key, list, read, limit);
    const rows = points.map((p) => {
      const when = `${new Date(p.ts).toISOString().slice(0, 16).replace('T', ' ')}  ${formatNumber(p.value, res.precision)}${unit}`;
      const extra = attributesAt(attrs, p);
      return extra ? `${when} · ${extra}` : when;
    });
    const attrNote = attrs.length
      ? `\n(attributes joined from ${attrs.map((a) => a.key).join(', ')} by slot)`
      : '';
    return {
      ok: true,
      text:
        `"${key}" — ${points.length} of ${res.count ?? points.length} reading(s)` +
        `${res.truncated ? ' (newest only; ask for a smaller range if you need older ones)' : ''}:\n` +
        rows.join('\n') +
        attrNote,
    };
  }

  if (action === 'declare') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'declare needs a series key, e.g. "psi.west"' };
    if (!declare) return { ok: false, text: 'creating series is not available on this relay' };
    const res = await declare({
      key,
      label: String(args?.label ?? '').trim(),
      unit: String(args?.unit ?? '').trim(),
      type: String(args?.valueType ?? args?.type ?? 'number').trim().toLowerCase(),
      cadence: String(args?.cadence ?? '').trim(),
      source: 'agent',
    });
    if (!res?.ok) return { ok: false, text: res?.error ?? `could not create "${key}"` };
    // CREATED vs ALREADY THERE is the difference between "start writing" and
    // "you named something that exists with a different shape", and the model
    // must not confuse the two: writing a PSI reading into a series declared as
    // text would be refused later, far from the decision that caused it.
    if (res.existed) {
      return {
        ok: true,
        text:
          `"${key}" already exists (${res.series?.label ?? key}${res.series?.unit ? `, ${res.series.unit}` : ''}, ` +
          `${res.series?.type ?? 'number'}${res.series?.count ? `, ${res.series.count} reading(s)` : ''}). ` +
          'Use it as it is — the unit and type cannot be changed.',
      };
    }
    return {
      ok: true,
      text:
        `Created "${key}" (${res.series?.label ?? key}${res.series?.unit ? `, ${res.series.unit}` : ''}, ` +
        `${res.series?.type ?? 'number'}). You can write readings to it now.`,
    };
  }

  if (action === 'write') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'write needs a series key' };
    if (args?.value === undefined || args?.value === null || String(args.value).trim() === '') {
      return { ok: false, text: 'write needs a value' };
    }
    if (!write) return { ok: false, text: 'metrics are not available on this relay' };
    // WHEN, if the caller knows it. A backfill that does not say is a month of
    // readings stacked on one timestamp — the chart is a spike, not a trend — so
    // the argument is accepted and passed through rather than defaulted here.
    const tsRaw = args?.at === undefined || args?.at === null ? '' : String(args.at).trim();
    const parsedTs = tsRaw ? Date.parse(tsRaw) : Number.NaN;
    const epoch = Number.isFinite(parsedTs)
      ? parsedTs
      : Number.isFinite(Number(tsRaw)) && tsRaw !== ''
        ? Number(tsRaw)
        : undefined;
    if (tsRaw && !Number.isFinite(epoch)) {
      return { ok: false, text: `at \"${tsRaw}\" is not a time — send an ISO date or epoch milliseconds` };
    }
    const res = await write({
      series: key,
      value: args.value,
      slot: args?.slot ? String(args.slot) : '',
      ...(epoch ? { ts: epoch } : {}),
    });
    if (!res?.ok) {
      // NAME THE KEY. "unknown series" with no key, in a session where `list`
      // just showed six series, is unactionable: it reads as a contradiction
      // rather than a lookup that missed. The key is the one thing the wearer
      // can compare against what they saw.
      const why = String(res?.error ?? `could not write to "${key}"`);
      return { ok: false, text: `${why} (looked up "${key}")` };
    }
    return {
      ok: true,
      text: `${res.replaced ? 'Replaced' : 'Recorded'} ${formatNumber(res.value, res.precision)}${
        res.unit ? ` ${res.unit}` : ''
      } for ${key}${res.where && res.where !== 'hub' ? ` (${res.where})` : ''}.`,
    };
  }

  return { ok: false, text: `unknown metrics action "${action}" — use list, read, declare or write` };
}

/** Group thousands, keep the series' precision. Never a bare float in front of a model. */
function formatNumber(value, precision) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? '—');
  const digits = Number.isFinite(Number(precision)) ? Math.max(0, Math.min(6, Number(precision))) : 2;
  const fixed = n.toFixed(digits);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}
