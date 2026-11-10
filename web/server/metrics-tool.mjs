// The `metrics` tool as the RELAY sees it: how an AGENT reads and writes numbers.
//
// WHY IT EXISTS: a collector is a dumb HTTPS call — good for a field at a URL,
// useless for a number the model had to compute (a sum, a ratio, "how many of
// these headlines mention rates"). This tool is the other half: the model stores
// what it worked out, under a series that was already declared.
//
// TWO STORES, AND THE MODEL MUST NOT CONFUSE THEM.
//   A SERIES is one number at one time (`sgx.dbs.price`, 900 readings). It
//   charts, it is cheap, and it holds ONE value per slot.
//   An OBJECT is a table of ROWS (`bto.launch`: date, flat_type, project,
//   estate, price). Its columns are stored as data, so a write can add one.
//   Before 0.3.79 the second shape was faked as four sibling series joined by
//   slot — a convention the writer had to honour and the store could not check.
//   The one thing worse than either store is a caller keeping a row in both, so
//   the description below states the split once, plainly, and every action names
//   the store it belongs to.
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
//   4. A SOFT WRITE REPORTS ITS SCHEMA CHANGE. `recordWrite` may invent a column
//      (that is what makes an improvised table possible); the answer names every
//      field it added, and warns when a new name is one slip away from an
//      existing one. Silent growth is how a typo becomes permanent.
//   5. CREATING AND DESTROYING ARE SYMMETRICAL. A store you can build but not
//      clear is a store that accumulates wreckage: a model that merges three
//      series into a table could leave the three behind for ever. So there is a
//      delete for every shape — one reading, one row, one series, one table —
//      and `purge` is a separate argument because removing a container and
//      destroying its history are different decisions. A WHOLE series or table
//      is only ever deleted from behind the wearer's confirmation (the
//      `metrics.forget` capability), never from a bare tool call.
//
// Pure with injected dependencies, like location-tool.mjs: a harness drives it
// with a stub store, and nothing in here knows what a socket is.

import { nearDuplicate } from './records.mjs';

export const METRICS_KIND = 'metrics';

/** The model-facing name, so dispatch and the schema agree by name. */
export const METRICS_TOOL_NAME = 'jarvis_metrics';

/** How many points a single `read` may return. */
export const MAX_READ_POINTS = 240;

/** How many rows a single `object` read may return. */
export const MAX_READ_ROWS = 120;

/** The five actions that predate records — kept for one error sentence. */
const SERIES_ACTIONS = ['list', 'read', 'declare', 'write', 'delete'];

/** The five that address a table of rows. */
const RECORD_ACTIONS = ['objects', 'object', 'objectDeclare', 'recordWrite', 'recordDelete'];

/**
 * The two that remove a whole container.
 *
 * Apart from the five above on purpose: they are not about a row or a reading,
 * they are about the SHAPE itself, and `purge` decides whether the contents go
 * with it. Reachable only through the confirmation-gated capability.
 */
const DESTROY_ACTIONS = ['seriesDelete', 'tableDelete'];

export const METRICS_ACTIONS = [...SERIES_ACTIONS, ...RECORD_ACTIONS, ...DESTROY_ACTIONS];

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
        'Read and write the wearer\u2019s stored data. There are TWO stores and the choice is not ' +
        'cosmetic:\n' +
        '\u2022 A SERIES is ONE NUMBER OVER TIME (a share price, a PSI reading). Actions: `list`, `read`, ' +
        '`declare`, `write`, `delete`. Use it when the thing you are storing is a single measurement you ' +
        'will chart \u2014 one value per slot, unit and type fixed at declaration.\n' +
        '\u2022 An OBJECT is a TABLE OF ROWS (a launch: date, project, estate, price). Actions: `objects`, ' +
        '`object`, `objectDeclare`, `recordWrite`, `recordDelete`. Use it whenever a fact has MORE THAN ONE ' +
        'ATTRIBUTE, or when the rows are not a time series at all (contacts, inventory, a list of options). ' +
        'Its columns are stored as data: `recordWrite` creates the object on its first write and ADDS a ' +
        'column for any field it has not seen, so you do not have to declare a schema first.\n' +
        'NEVER keep the same row both ways. Four sibling series joined by slot was how this was faked ' +
        'before objects existed; it cannot be filtered, sorted or validated, so a new multi-attribute row ' +
        'belongs in an object, and a single charted number stays a series.\n\n' +
        'Writing the same series slot twice REPLACES the earlier reading, and writing the same record key ' +
        'twice MERGES into that row \u2014 so a partial write corrects one field, and a re-run is safe. ' +
        'A record\u2019s values are merged unless you send `replace`. Deleting is addressed: one reading by ' +
        '`slot`, one row by its `key`, and a WHOLE series or table with `seriesDelete` / `tableDelete`. ' +
        'Those last two refuse while anything is still inside and answer with the COUNT until you send ' +
        '`purge: true` \u2014 tell the wearer that number and get their agreement before you do. A series ' +
        'that has been merged into a table is removed that way, so a merge need not leave it behind.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: METRICS_ACTIONS,
            description:
              'Series: list = what exists; read = one series\u2019 history; declare = create a series; ' +
              'write = store a reading; delete = remove one reading (by slot) or those before a cutoff. ' +
              'Objects: objects = what tables exist; object = one table\u2019s rows; objectDeclare = create ' +
              'or extend a table\u2019s columns; recordWrite = upsert rows; recordDelete = remove one row. ' +
              'Whole shapes: seriesDelete = remove a series; tableDelete = remove a table. Those two ' +
              'need `purge` to take the readings or rows with them.',
          },
          series: {
            type: 'string',
            description:
              'The series key ("psi.west") \u2014 or, for the object actions, the OBJECT key ("bto.launch"). ' +
              'Required for every action except list and objects.',
          },
          label: {
            type: 'string',
            description: 'For declare/objectDeclare: the label shown on the dashboard, e.g. "PSI west".',
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
            description: `How many recent points (\`read\`) or rows (\`object\`) to return. Max ${MAX_READ_POINTS}, default 30.`,
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
              'epoch milliseconds. Omit for \u201cnow\u201d \u2014 unless the slot is itself a date, in which case ' +
              'the slot IS the time. Send it when backfilling history.',
          },
          before: {
            type: 'string',
            description:
              'For delete: remove readings older than this (ISO date/time or epoch milliseconds). ' +
              'Use it only when clearing a range; to remove the series itself call `seriesDelete`.',
          },
          fields: {
            type: 'array',
            description:
              'For objectDeclare: the columns, in the order a table should show them. Only needed to ' +
              'pre-set a type or a unit, or to lock a table down with strict — a plain recordWrite ' +
              'infers columns as it goes. Type is fixed once a field exists.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Column name: lowercase letters, digits, underscores (price, launch_date).' },
                type: { type: 'string', enum: ['text', 'number', 'bool', 'date'] },
                label: { type: 'string', description: 'Column heading. Defaults to the key.' },
                unit: { type: 'string', description: 'Shown after a number, e.g. "SGD".' },
                precision: { type: 'integer', description: 'Decimals to show for a number. Default 2.' },
              },
              required: ['key', 'type'],
            },
          },
          strict: {
            type: 'boolean',
            description:
              'For objectDeclare: when true, writing a column this table does not have is REFUSED instead ' +
              'of added. Leave it off (soft) while gathering data; turn it on for a table whose shape a ' +
              'person cares about.',
          },
          records: {
            type: 'array',
            description:
              'For recordWrite: the rows. `key` is the row\u2019s identity and is what a later correction or ' +
              'delete names (a date, an id, a name \u2014 1-64 chars). `values` holds the cells; a field this ' +
              'table does not have yet becomes a column. Max 32 rows per call.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Row identity, e.g. "2023-10-15". Re-using it updates that row.' },
                values: {
                  type: 'object',
                  description: 'Cells: { price: 290000, project: "Garden Vale" }. A null means "nothing for this", not zero.',
                  additionalProperties: true,
                },
                replace: {
                  type: 'boolean',
                  description: 'Replace the whole row instead of merging into it — the only way to clear a value.',
                },
              },
              required: ['key', 'values'],
            },
          },
          key: {
            type: 'string',
            description:
              'For recordDelete: the row to remove \u2014 exactly the key `object` printed. To remove every ' +
              'row at once send `tableDelete` with `purge: true`, which asks the wearer first.',
          },
          purge: {
            type: 'boolean',
            description:
              'For seriesDelete/tableDelete: true removes the readings or rows inside it as well. ' +
              'Omit it and the call is refused while the container still holds anything, with the ' +
              'count \u2014 which is the honest way to find out how much history is at stake.',
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
  // ACTION NAMES ARE MATCHED LOOSELY, SPELLED CANONICALLY.
  // The action is lowercased here (it always was), which turns `recordWrite`
  // into `recordwrite` — and the first version of these branches compared it to
  // the camelCase spelling, so every table action answered "unknown action".
  // Rather than compare against a lowercased literal (and lose the name the
  // schema advertises), the canonical spelling is recovered: `record_write`,
  // `recordwrite` and `recordWrite` all mean the same thing, because a model
  // that invents a separator is not making a mistake worth failing.
  const rawAction = String(args?.action ?? 'list').trim().toLowerCase();
  const flat = rawAction.replace(/[_-]/g, '');
  const action = METRICS_ACTIONS.find((name) => name.toLowerCase() === flat) ?? rawAction;
  const list = typeof deps?.listSeries === 'function' ? deps.listSeries : null;
  const read = typeof deps?.readSeries === 'function' ? deps.readSeries : null;
  const declare = typeof deps?.declareSeries === 'function' ? deps.declareSeries : null;
  const write = typeof deps?.writeSample === 'function' ? deps.writeSample : null;
  const remove = typeof deps?.deleteSamples === 'function' ? deps.deleteSamples : null;
  const listObjects = typeof deps?.listObjects === 'function' ? deps.listObjects : null;
  const readObject = typeof deps?.readObject === 'function' ? deps.readObject : null;
  const declareObject = typeof deps?.declareObject === 'function' ? deps.declareObject : null;
  const writeRows = typeof deps?.writeRecords === 'function' ? deps.writeRecords : null;
  const dropRow = typeof deps?.deleteRecord === 'function' ? deps.deleteRecord : null;
  const dropSeries = typeof deps?.deleteSeries === 'function' ? deps.deleteSeries : null;
  const dropTable = typeof deps?.deleteTable === 'function' ? deps.deleteTable : null;

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
          'then write readings to it — one series per measure, not one per day. ' +
          'If the thing to store is a ROW with several attributes rather than one number over time, ' +
          'use `recordWrite` instead: it creates the table as it goes.',
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
      const iso = new Date(p.ts).toISOString();
      const when = `${iso.slice(0, 16).replace('T', ' ')}`;
      // THE SLOT IS HOW A ROW IS ADDRESSED. `delete` takes one, so a row that
      // does not print its slot cannot be surgically removed from what the model
      // was shown: it would have to guess an identity it never saw. Printed only
      // when the slot says something the date does not.
      const badge = p.slot && !iso.startsWith(String(p.slot)) ? ` \u00b7 slot ${p.slot}` : '';
      const value = `${formatNumber(p.value, res.precision)}${unit}`;
      const extra = attributesAt(attrs, p);
      return `${when}  ${value}${badge}${extra ? ` \u00b7 ${extra}` : ''}`;
    });
    const attrNote = attrs.length
      ? `\n(attributes joined from ${attrs.map((a) => a.key).join(', ')} by slot — that is the older shape ` +
        'for a second attribute. New data with several attributes per row belongs in a table: `recordWrite`.)'
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

  if (action === 'delete') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'delete needs a series key, e.g. "sgx.dbs.price"' };
    const slot = String(args?.slot ?? '').trim();
    const beforeRaw = args?.before === undefined || args?.before === null ? '' : String(args.before).trim();
    const before = beforeRaw ? Date.parse(beforeRaw) || Number(beforeRaw) : NaN;
    // ONE SCOPE, AND NEVER THE WHOLE SERIES. A reading is named by its slot, so
    // that is what an edit removes; a range delete needs a cutoff. Reaching for
    // "everything" is how a model that mis-read a question destroys a history,
    // and the Data page already has that verb behind an explicit confirmation.
    if (!slot && !Number.isFinite(before)) {
      return {
        ok: false,
        text:
          'delete needs a slot (one reading, e.g. "2023-10-15") or a before date (a cutoff). ' +
          'It will not clear a whole series — read it first and name what should go.',
      };
    }
    if (slot && Number.isFinite(before)) {
      return { ok: false, text: 'send either a slot (one reading) or a before date (a cutoff), not both' };
    }
    if (!remove) return { ok: false, text: 'deleting readings is not available on this relay' };
    const res = await remove(key, { slot, before: Number.isFinite(before) ? Math.floor(before) : null });
    if (!res?.ok) return { ok: false, text: res?.error ?? `could not delete from "${key}"` };
    const what = slot ? `reading "${slot}"` : `readings before ${new Date(before).toISOString().slice(0, 10)}`;
    return {
      ok: true,
      text: res.deleted
        ? `Deleted ${what} from "${key}"; ${res.deleted} reading(s) removed.`
        : `Nothing to delete: "${key}" has no ${what}.`,
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

  // ── Objects: the table of rows ────────────────────────────────────────────
  // Every branch below names the store it is about, and each answer says which
  // store it came from, because the failure to avoid is a model that reports
  // "recorded" after writing to the wrong one.

  if (action === 'objects') {
    if (!listObjects) return { ok: false, text: 'tables are not available on this relay' };
    const res = await listObjects();
    if (!res?.ok) return { ok: false, text: `could not read the tables: ${res?.error ?? 'unknown error'}` };
    const objects = Array.isArray(res.objects) ? res.objects : [];
    if (!objects.length) {
      return {
        ok: true,
        text:
          'No tables yet. `recordWrite` creates one on its first row: send the object key (e.g. ' +
          '"bto.launch") and the rows, and each field in the values becomes a column. Use a table when ' +
          'a fact has more than one attribute; a single charted number is a series (`list`).',
      };
    }
    const lines = objects.slice(0, 20).map((o) => {
      const cols = (Array.isArray(o.fields) ? o.fields : [])
        .map((f) => `${f.key}:${f.type}${f.unit ? `(${f.unit})` : ''}`)
        .join(', ');
      const n = Number(o.count) || 0;
      return (
        `- ${o.key} (${o.label}${o.strict ? ', strict' : ''}): ${n} row${n === 1 ? '' : 's'}` +
        `${cols ? ` · columns: ${cols}` : ' · no columns yet'}`
      );
    });
    const more = objects.length > 20 ? `\n(+${objects.length - 20} more tables)` : '';
    return { ok: true, text: `Tables:\n${lines.join('\n')}${more}` };
  }

  if (action === 'object') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'object needs a table key, e.g. "bto.launch"' };
    if (!readObject) return { ok: false, text: 'tables are not available on this relay' };
    const limitRaw = Number(args?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_READ_ROWS, Math.floor(limitRaw)) : 30;
    const res = await readObject(key, limit);
    if (!res?.ok) {
      return {
        ok: false,
        text: res?.notFound
          ? `there is no table "${key}" yet. \`objects\` lists the ones that exist; \`recordWrite\` would create this one.`
          : `could not read "${key}": ${res?.error ?? 'unknown error'}`,
      };
    }
    const fields = Array.isArray(res.object?.fields) ? res.object.fields : [];
    const rows = Array.isArray(res.records) ? res.records : [];
    const columns = fields.length
      ? fields.map((f) => `${f.key}:${f.type}${f.unit ? `(${f.unit})` : ''}`).join(', ')
      : 'none yet';
    if (!rows.length) {
      return { ok: true, text: `"${key}" (${res.object?.label ?? key}) has no rows yet. Columns: ${columns}.` };
    }
    const body = rows.map((row) => {
      // The row key is printed even when it duplicates the date: it is the
      // identity `recordDelete` and a correction take, and a caller that never
      // saw it would have to guess a string the store compares exactly.
      const when = typeof row.ts === 'number' ? `${new Date(row.ts).toISOString().slice(0, 16).replace('T', ' ')}  ` : '';
      const cells = fields
        .filter((f) => row.values?.[f.key] !== undefined && row.values[f.key] !== null && row.values[f.key] !== '')
        .map((f) => `${f.key}=${formatCell(f, row.values[f.key])}`);
      return `${when}${row.key}${cells.length ? ` · ${cells.join(' · ')}` : ''}`;
    });
    const total = Number(res.total) || rows.length;
    return {
      ok: true,
      text:
        `"${key}" (${res.object?.label ?? key}) — ${rows.length} of ${total} row(s) · columns: ${columns}` +
        `${res.truncated ? ' (newest only; ask for a smaller range if you need older ones)' : ''}:\n` +
        body.join('\n'),
    };
  }

  if (action === 'objectDeclare') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'objectDeclare needs a table key, e.g. "bto.launch"' };
    if (!declareObject) return { ok: false, text: 'tables are not available on this relay' };
    const parsed = normaliseFieldsArg(args?.fields);
    if (!parsed.ok) return { ok: false, text: parsed.error };
    const res = await declareObject({
      key,
      label: String(args?.label ?? '').trim(),
      fields: parsed.fields,
      ...(args?.strict === undefined ? {} : { strict: args.strict === true || args.strict === 'true' }),
    });
    if (!res?.ok) {
      // A type change is the one refusal with a fix that is not a retry: the
      // stored values are what conflict, so the answer must name the new field
      // name rather than invite the caller to try again.
      if (res?.shapeLocked) {
        const stored = res.current ? `${res.current.type}` : 'a different type';
        return {
          ok: false,
          text:
            `${res.error ?? 'that field already has a different type'} — it is stored as ${stored}. ` +
            'Send the value as that type, or write it under a new field name.',
        };
      }
      return { ok: false, text: res?.error ?? `could not declare "${key}"` };
    }
    const fields = Array.isArray(res.object?.fields) ? res.object.fields : [];
    const columns = fields.map((f) => `${f.key}:${f.type}${f.unit ? `(${f.unit})` : ''}`).join(', ') || 'none yet';
    const notes = [];
    if (res.created) {
      const clash = await seriesWithKey(list, key);
      if (clash) notes.push(clashLine(key, clash));
    }
    return {
      ok: true,
      text:
        `${res.created ? 'Created' : 'Extended'} table "${key}" (${res.object?.label ?? key}` +
        `${res.object?.strict ? ', strict' : ', soft'}) \u00b7 columns: ${columns}. ` +
        (res.object?.strict
          ? 'A field that is not listed here will be REFUSED.'
          : 'A field that is not listed here will be added automatically.') +
        (notes.length ? `\n${notes.join('\n')}` : ''),
    };
  }

  if (action === 'recordWrite') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'recordWrite needs a table key, e.g. "bto.launch"' };
    if (!writeRows) return { ok: false, text: 'tables are not available on this relay' };
    const parsed = normaliseRowsArg(args?.records);
    if (!parsed.ok) return { ok: false, text: parsed.error };
    // THE COLUMNS BEFORE THE WRITE. The receipt names what was added, but a name
    // that is one slip from an existing one ("estate" vs "estates") is only
    // visible against the schema as it was, and that warning is the whole
    // containment for a soft write.
    let prior = [];
    let existed = false;
    if (readObject) {
      try {
        const before = await readObject(key, 1);
        if (before?.ok) {
          existed = true;
          prior = Array.isArray(before.object?.fields) ? before.object.fields : [];
        }
      } catch {
        /* the warning is a bonus; the write is the point */
      }
    }
    const res = await writeRows(key, parsed.rows);
    if (!res?.ok) {
      const rejected = Array.isArray(res?.rejected) ? res.rejected : [];
      const why = rejected.length
        ? rejected
            .slice(0, 4)
            .map((r) => `${r.field || `records[${r.index}]`}: ${r.error}`)
            .join('; ')
        : String(res?.error ?? 'the store refused the write');
      // A STRICT TABLE'S REFUSAL DOES NOT CARRY THE COLUMN LIST — the hub says
      // "not part of this object" and stops. That sentence is unactionable on
      // its own, so the columns this tool read a moment ago are appended here:
      // the caller can then fix the name instead of guessing at it.
      const unknownField = rejected.some((r) => r.code === 'UNKNOWN_FIELD');
      const columns = unknownField && prior.length
        ? ` — this table has: ${prior.map((f) => `${f.key} (${f.type})`).join(', ')}. ` +
          'Re-send the row with one of those names, or use objectDeclare to add a column.'
        : '';
      return { ok: false, text: `could not write to "${key}": ${why}${columns}` };
    }
    const added = Array.isArray(res.addedFields) ? res.addedFields : [];
    const inserted = (res.records ?? []).filter((r) => r.action === 'inserted').length;
    const updated = (res.records ?? []).length - inserted;
    const parts = [`Wrote ${res.accepted ?? parsed.rows.length} row(s) to "${key}"`];
    if (inserted) parts.push(`${inserted} new`);
    if (updated) parts.push(`${updated} updated`);
    if (!existed) parts.push('the table and its columns were created by this write');
    const lines = [`${parts.join(' · ')}.`];    // A NEW TABLE UNDER A KEY A SERIES ALREADY USES. It is legal (two stores) and
    // it is the mess a merge leaves behind, so it is said once, here, where the
    // duplicate is born.
    if (!existed) {
      const clash = await seriesWithKey(list, key);
      if (clash) lines.push(clashLine(key, clash));
    }    if (added.length) {
      lines.push(
        `Added ${added.length === 1 ? 'a column' : `${added.length} columns`}: ` +
          added.map((f) => `${f.key} (${f.type})`).join(', ') +
          ' — it was not in the table, so its type came from the value you sent.',
      );
      const slips = added
        .map((f) => [f.key, nearDuplicate(prior, f.key)])
        .filter(([, near]) => near);
      for (const [key2, near] of slips) {
        lines.push(
          `WARNING: "${key2}" is one slip away from the existing column "${near}". If you meant "${near}", ` +
            `re-send the row with that field name and tell the wearer about the extra column "${key2}".`,
        );
      }
    }
    const rejected = Array.isArray(res.rejected) ? res.rejected : [];
    if (rejected.length) {
      lines.push(
        `Refused ${rejected.length} row(s): ` +
          rejected.slice(0, 4).map((r) => `${r.field || `records[${r.index}]`}: ${r.error}`).join('; '),
      );
    }
    return { ok: true, text: lines.join('\n') };
  }

  if (action === 'recordDelete') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    const rec = String(args?.key ?? '').trim();
    if (!key) return { ok: false, text: 'recordDelete needs a table key, e.g. "bto.launch"' };
    // ONE ROW, NAMED. There is deliberately no "clear the table" verb here: a
    // model that can empty a table in one call will eventually do it by accident,
    // and the Data page has that button behind a confirmation.
    if (!rec) {
      return {
        ok: false,
        text:
          'recordDelete needs the row key as `key` — exactly the string `object` printed. ' +
          'It removes ONE row and will not clear a table; read it first and name what should go.',
      };
    }
    if (!dropRow) return { ok: false, text: 'deleting rows is not available on this relay' };
    const res = await dropRow(key, rec);
    if (!res?.ok) {
      return {
        ok: false,
        text: res?.notFound
          ? `"${key}" has no row "${rec}". Read the table with action "object" and use a key it printed — ` +
            'row keys are compared as strings and are not normalised.'
          : res?.error ?? `could not delete that row from "${key}"`,
      };
    }
    return { ok: true, text: `Deleted row "${rec}" from "${key}".` };
  }

  if (action === 'seriesDelete') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'seriesDelete needs a series key, e.g. "tengah.bto.4room"' };
    if (!dropSeries) return { ok: false, text: 'deleting a series is not available on this relay' };
    const purge = args?.purge === true || args?.purge === 'true';
    const res = await dropSeries(key, { purge });
    if (!res?.ok) {
      // A series that still holds readings is a QUESTION, not a failure: the
      // count is what tells the caller how much history the purge decision is
      // about, and it is the number a confirmation prompt should carry.
      if (res?.notEmpty) {
        return {
          ok: false,
          text:
            `"${key}" still holds ${res.count} reading${res.count === 1 ? '' : 's'}. Nothing was deleted. ` +
            'Send purge:true to delete the series AND those readings, but only when the wearer has ' +
            'agreed to lose the history \u2014 tell them the count first.',
        };
      }
      return {
        ok: false,
        text: res?.notFound
          ? `there is no series "${key}" any more. \`list\` shows what exists.`
          : res?.error ?? `could not delete "${key}"`,
      };
    }
    const gone = Number(res.deleted) || 0;
    return {
      ok: true,
      text:
        `Deleted the series "${key}"` +
        (gone ? ` and its ${gone} reading${gone === 1 ? '' : 's'}.` : '. It held no readings.') +
        ' Tables are a separate store and were not touched.',
    };
  }

  if (action === 'tableDelete') {
    const key = String(args?.series ?? '').trim().toLowerCase();
    if (!key) return { ok: false, text: 'tableDelete needs a table key, e.g. "bto.launch"' };
    if (!dropTable) return { ok: false, text: 'deleting a table is not available on this relay' };
    const purge = args?.purge === true || args?.purge === 'true';
    const res = await dropTable(key, { purge });
    if (!res?.ok) {
      if (res?.notEmpty) {
        return {
          ok: false,
          text:
            `"${key}" still holds ${res.count} row${res.count === 1 ? '' : 's'}. Nothing was deleted. ` +
            'Send purge:true to delete the table AND those rows, but only when the wearer has agreed.',
        };
      }
      return {
        ok: false,
        text: res?.notFound
          ? `there is no table "${key}" any more. \`objects\` shows what exists.`
          : res?.error ?? `could not delete "${key}"`,
      };
    }
    const gone = Number(res.deletedRecords) || 0;
    return {
      ok: true,
      text:
        `Deleted the table "${key}"` +
        (gone ? ` and its ${gone} row${gone === 1 ? '' : 's'}.` : '. It held no rows.') +
        ' Series are a separate store and were not touched.',
    };
  }

  return {
    ok: false,
    text:
      `unknown metrics action "${action}" \u2014 series actions are ${SERIES_ACTIONS.join(', ')}; ` +
      `table actions are ${RECORD_ACTIONS.join(', ')}; whole-shape actions are ${DESTROY_ACTIONS.join(', ')}`,
  };
}

/**
 * The `records` argument, however the model spelled it.
 *
 * A tool schema asks for an array of objects, but providers differ: some emit
 * the array, some emit a JSON string. Both mean the same thing, and failing a
 * write over the encoding would teach the model nothing useful — so a string is
 * parsed once here and the error names the shape when it is neither.
 */
function normaliseRowsArg(raw) {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return { ok: false, error: 'recordWrite needs `records`: an array of {key, values} (or an object when writing one row)' };
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: '`records` is a string but not JSON — send an array of {key, values}' };
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) value = [value];
  if (!Array.isArray(value) || !value.length) {
    return { ok: false, error: 'recordWrite needs `records`: a non-empty array of {key, values}' };
  }
  return { ok: true, rows: value };
}

/** The `fields` argument for objectDeclare: array, object, or a JSON string. */
function normaliseFieldsArg(raw) {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return { ok: true, fields: [] };
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: '`fields` is a string but not JSON — send an array of {key, type}' };
    }
  }
  if (value === undefined || value === null) return { ok: true, fields: [] };
  if (value && typeof value === 'object' && !Array.isArray(value)) value = [value];
  if (!Array.isArray(value)) return { ok: false, error: '`fields` must be an array of {key, type}' };
  return { ok: true, fields: value };
}

/** One cell, rendered with the field's own unit and precision. */
function formatCell(field, value) {
  if (value === null || value === undefined) return '';
  if (field.type === 'number') {
    return `${formatNumber(value, field.precision)}${field.unit ? ` ${field.unit}` : ''}`;
  }
  if (field.type === 'bool') return value ? 'yes' : 'no';
  return String(value);
}

/**
 * The SERIES that already answers to this key, or null.
 *
 * The two stores are separate, so one key can name both — and after a merge that
 * is exactly what happens: the table is built from a series that is still there,
 * so `tengah.bto.4room` becomes a series AND a table until one is removed. The
 * caller cannot see that from either read, so creation says it out loud, once,
 * at the moment the duplicate appears.
 */
async function seriesWithKey(listFn, key) {
  if (!listFn) return null;
  try {
    const res = await listFn();
    const series = Array.isArray(res?.series) ? res.series : [];
    return series.find((s) => String(s?.key ?? '').toLowerCase() === key) ?? null;
  } catch {
    return null; // the warning is a bonus; the write already succeeded
  }
}

function clashLine(key, clash) {
  const n = Number(clash?.count) || 0;
  return (
    `WARNING: a SERIES also uses the key "${key}"${n ? ` (${n} reading${n === 1 ? '' : 's'})` : ''}. ` +
    'They are different stores, so that name now answers to two shapes. If this table replaces that ' +
    'series, remove it with seriesDelete (the wearer has to approve it); otherwise pick a different key.'
  );
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
