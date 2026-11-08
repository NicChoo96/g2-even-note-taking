// The `metrics` tool as the RELAY sees it: how an AGENT reads and writes numbers.
//
// WHY IT EXISTS: a collector is a dumb HTTPS call — good for a field at a URL,
// useless for a number the model had to compute (a sum, a ratio, "how many of
// these headlines mention rates"). This tool is the other half: the model stores
// what it worked out, under a series that was already declared.
//
// THE THREE RULES THAT KEEP AN LLM FROM MAKING A MESS:
//   1. NO `declare`. A model cannot invent a series, because the cardinality of
//      "one series per ticker I noticed" never comes back down. Declaring is a
//      human action in the Data tab, and the refusal says so by name.
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
        'Read and record NUMBER SERIES the wearer keeps on their dashboard. Use `list` to see ' +
        'which series exist and their latest value, `read` for the history of one series, and ' +
        '`write` to record a value you have computed yourself (the series must already exist — ' +
        'this tool cannot create one). A series has a fixed unit and type; writing text into a ' +
        'number series is refused. Values are stored with the scheduled slot, so writing twice ' +
        'for the same slot replaces rather than duplicates.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'write'],
            description: 'list = what exists; read = one series\u2019 history; write = store a value.',
          },
          series: {
            type: 'string',
            description: 'The series key, e.g. "sgx.dbs.price". Required for read and write.',
          },
          limit: {
            type: 'integer',
            description: `How many recent points to read (max ${MAX_READ_POINTS}). Default 30.`,
          },
          value: {
            type: 'string',
            description:
              'For write: the reading. Send a number for a number series. A value with thousands ' +
              'separators is accepted; anything non-numeric is refused.',
          },
          slot: {
            type: 'string',
            description:
              'For write: optional identity of the reading (e.g. the date or a period label). ' +
              'Writing the same slot twice replaces the earlier value.',
          },
        },
        required: ['action'],
      },
    },
  };
}

/**
 * Run one metrics call.
 *
 * `deps` is `{ listSeries, readSeries, writeSample }`, each returning
 * `{ok, ...}` and never throwing. Every failure becomes a SENTENCE the model can
 * act on, because a tool that returns an empty string teaches it that the data
 * was empty.
 */
export async function runMetricsTool(tool, args, deps) {
  const action = String(args?.action ?? 'list').trim().toLowerCase();
  const list = typeof deps?.listSeries === 'function' ? deps.listSeries : null;
  const read = typeof deps?.readSeries === 'function' ? deps.readSeries : null;
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
          'No metric series exist yet. A series has to be declared on the Data page before an ' +
          'agent can read or write it — this tool cannot create one.',
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
    const rows = points.map((p) => `${new Date(p.ts).toISOString().slice(0, 16).replace('T', ' ')}  ${formatNumber(p.value, res.precision)}${unit}`);
    return {
      ok: true,
      text:
        `"${key}" — ${points.length} of ${res.count ?? points.length} reading(s)` +
        `${res.truncated ? ' (newest only; ask for a smaller range if you need older ones)' : ''}:\n` +
        rows.join('\n'),
    };
  }

  if (action === 'write') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'write needs a series key' };
    if (args?.value === undefined || args?.value === null || String(args.value).trim() === '') {
      return { ok: false, text: 'write needs a value' };
    }
    if (!write) return { ok: false, text: 'metrics are not available on this relay' };
    const res = await write({ series: key, value: args.value, slot: args?.slot ? String(args.slot) : '' });
    if (!res?.ok) return { ok: false, text: res?.error ?? `could not write to "${key}"` };
    return {
      ok: true,
      text: `${res.replaced ? 'Replaced' : 'Recorded'} ${formatNumber(res.value, res.precision)}${
        res.unit ? ` ${res.unit}` : ''
      } for ${key}${res.where && res.where !== 'hub' ? ` (${res.where})` : ''}.`,
    };
  }

  return { ok: false, text: `unknown metrics action "${action}" — use list, read or write` };
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
