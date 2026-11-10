// metrics.act — the dashboard numbers, for Jarvis himself.
//
// WHY THIS EXISTS
//   The metric store and its collectors gave the wearer a dashboard, and
//   `jarvis_metrics` gave an AGENT a way to read and write it — but Jarvis, the
//   assistant standing in front of the wearer, had no way at all. So "what is
//   DBS at" and "record 36.40 against the bank price" were answerable only by
//   opening the Data tab by hand. The relay could always do it (`POST /api/tool`
//   handles the `metrics` kind); the gap was purely that no capability called
//   it, which is the same gap `web/search.ts` was written to close.
//
// ONE CAPABILITY, THREE ACTIONS, AND THE BUDGET IS THE REASON
//   `metrics.list`, `metrics.read` and `metrics.write` as three entries would
//   spend three of the loop's twenty tool slots on one subject, and the ones they
//   pushed out would be a page's own actions. One entry with an `action` enum
//   costs one slot, mirrors the relay's own shape exactly (`list | read |
//   write`), and keeps the argument names identical on both sides — so a
//   transcript reads the same whoever produced it.
//
// WHY THE TABLE ACTIONS LIVE IN THE SAME THREE ENTRIES (0.3.79)
//   The store gained a second shape: a ROW of attributes, whose columns are
//   stored as data (an object, `bto.launch`). The obvious move — two new
//   app-wide capabilities — is impossible without shrinking what a page can do:
//   `MAX_TOOLS` is 20, the busiest page (agents) declares 8 of its own, and the
//   globals already fill the remaining 12 on that page exactly. A thirteenth
//   global evicts one of agents' own actions. So the record verbs are ACTIONS of
//   the entries that already own this subject:
//     · reads and row-writes → `metrics.act` (effect: 'write', no gate)
//     · shaping a table      → `metrics.declare` (confirm: the gate is about
//                              what a thing IS, and an object's columns are the
//                              same permanent decision a series' type is)
//     · removing a row       → `metrics.forget` (confirm: it destroys a row)
//   That is also the honest split: one subject, "the wearer's stored data", with
//   the same three friction levels it always had.
//
// WHY IT IS effect: 'write'
//   The tool can alter numbers the wearer keeps, so classifying it as a read
//   would be a lie told to the ledger. It is NOT 'irreversible': a reading is
//   visible, replaceable (the same slot overwrites) and never destroys the series
//   itself — and gating every price with a tap would make the capability useless
//   for the one thing it is for. Nothing here is deletable, which is what keeps
//   that classification honest.
//
// A GLOBAL, LIKE location.get AND web.search
//   "What is my number" belongs to the assistant rather than to a tab; routing
//   the wearer to the Data page first would be a visible, pointless page change.
//   See the reserve in ../agent.ts — `pageCatalogText()` advertises every global
//   on EVERY turn, so one that is advertised must also be handed over, which is
//   why this file and that list move together.
//
// IT CANNOT DECLARE A SERIES
//   The relay's `declare` action is reachable only through `metrics.declare`,
//   which is gated: series cardinality is a decision with a tap on it. So an
//   unknown key comes back as the relay's own refusal, and this capability passes
//   that sentence through instead of softening it. A model told "recorded" for a
//   series that does not exist is worse than one told nothing.
import { GLOBAL_PAGE, type Capability } from '../types';
import { runTool } from '../../web/agents-client';

/**
 * How much of the relay's answer reaches the model in one call.
 *
 * A `read` of 240 points is ~6 KB of timestamped rows; this is the client-side
 * bound on top of that, so one dashboard question cannot swallow the run's
 * context. Above it the model is told plainly that the answer was cut and how to
 * ask for less — never silently handed a sample.
 */
export const METRICS_TEXT_CHARS = 6_000;

/** The tool id the relay dispatches on. A label for the transcript: `runTool`
 *  bypasses the catalogue, so there is no row to resolve. */
const METRICS_TOOL_ID = 'tool-metrics';

/**
 * The actions this capability may forward.
 *
 * Six, in two groups, and the grouping is what keeps them from being confused:
 * `list`/`read`/`write` address a SERIES (one number over time),
 * `objects`/`object`/`recordWrite` address an OBJECT (a table of rows).
 */
const ACTIONS = ['list', 'read', 'write', 'objects', 'object', 'recordWrite'] as const;
type MetricsAction = (typeof ACTIONS)[number];

const isAction = (v: unknown): v is MetricsAction =>
  typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);

/**
 * A JSON argument, however the model spelled it.
 *
 * `rows` and `fields` are structurally rich (arrays of objects), and this
 * registry's parameter types are scalars — so the schema says "string" and the
 * model sends JSON. A model that sends the array anyway is right, too; what must
 * not happen is a silent empty write because the string did not parse.
 */
export function jsonArg(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === 'object') return { ok: true, value: raw };
  const text = String(raw).trim();
  if (!text) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'that is not valid JSON' };
  }
}

export const metricsCapabilities: Capability[] = [
  {
    /**
     * Create the SHAPE of something — a series, or a table's columns.
     *
     * Both are the same decision wearing different clothes: what a thing IS,
     * fixed once and permanent afterwards (a series' type and unit, a column's
     * type). So both sit behind one tap, and the `kind` argument picks which.
     *
     * WHY IT IS ITS OWN CAPABILITY AND NOT AN `action` OF `metrics.act`:
     *   the gate that makes this safe is per-capability (`confirm`), so folding
     *   it in would either strip the confirmation from declaring or add one to
     *   every read. Separate entries keep "record a number I already track"
     *   frictionless and make "start tracking a new thing" an explicit,
     *   accepted decision — the same shape as `agents expose`, where the model
     *   proposes and the wearer taps.
     *
     * WHY THE GATE IS RIGHT RATHER THAN PEDANTIC: a series' unit and type are
     * fixed once created, and its readings are kept for months. A model that
     * guessed "psi.west" as text, or one-per-day, would be stuck with it. One
     * tap is nothing against a month of history in the wrong shape.
     */
    name: 'metrics.declare',
    page: GLOBAL_PAGE,
    effect: 'write',
    confirm: true,
    title: 'Track something new',
    description:
      'Create the SHAPE of something to track, before data goes into it. Two kinds, and they are not ' +
      'interchangeable:\n' +
      '\u2022 kind "series" (the default): ONE NUMBER OVER TIME. Send a dotted lowercase key ' +
      '(psi.west, news.rates.count), a short label, the unit, and whether a reading is a number or text. ' +
      'Use it when the thing is a single measurement you will chart. The unit and type are PERMANENT, so ' +
      'choose them for the whole history. After it succeeds, write readings with `metrics act` write.\n' +
      '\u2022 kind "object": A TABLE OF ROWS. Send the table key (bto.launch) and, optionally, the columns ' +
      'as JSON: \'[{"key":"launch_date","type":"date"},{"key":"price","type":"number","unit":"SGD"}]\'. ' +
      'Only needed to PRE-SET a column\u2019s type or unit, or to lock the table with strict so unknown ' +
      'columns are refused \u2014 a plain `metrics act` recordWrite creates the table and its columns as ' +
      'the values arrive. A column\u2019s type is permanent once it exists.\n' +
      'Use the object kind when a row has several attributes (a launch with a date, a project, a price) ' +
      'or when the same table will be read back as a list. Do not declare four sibling series to fake a ' +
      'row \u2014 that is the shape objects replace. Ask once, then write rows; do not re-declare what ' +
      '`metrics act` objects already shows.',
    params: [
      {
        name: 'kind',
        type: 'enum',
        values: ['series', 'object'],
        fallback: 'series',
        description: 'series = one number over time; object = a table of rows. Default series.',
      },
      {
        name: 'series',
        type: 'string',
        required: true,
        description:
          'The key, dotted and lowercase: "psi.west" for a series, "bto.launch" for a table. ' +
          'For a series: one series per measure, never per day.',
      },
      {
        name: 'label',
        type: 'string',
        description: 'Shown on the dashboard: "PSI west", "BTO launches". Defaults to the key.',
      },
      {
        name: 'unit',
        type: 'string',
        description: 'For a series: short unit "PSI", "SGD", "mentions". Cannot be changed later.',
      },
      {
        name: 'valueType',
        type: 'enum',
        values: ['number', 'string'],
        fallback: 'number',
        description: 'For a series: what one reading is. Default number.',
      },
      {
        name: 'cadence',
        type: 'string',
        description: 'For a series: optional hint "daily", "hourly". Advisory only.',
      },
      {
        name: 'fields',
        type: 'string',
        description:
          'For an object: a JSON array of columns, e.g. ' +
          '\'[{"key":"launch_date","type":"date"},{"key":"price","type":"number","unit":"SGD"}]\'. ' +
          'Types: text, number, bool, date. Omit to let the first writes infer them.',
      },
      {
        name: 'strict',
        type: 'boolean',
        description:
          'For an object: true refuses a column the table does not have, instead of adding it. ' +
          'Leave false while gathering data.',
      },
    ],
    run: async (args) => {
      const kind = args.kind === 'object' ? 'object' : 'series';
      const send: Record<string, unknown> =
        kind === 'object'
          ? { action: 'objectDeclare', series: args.series ?? '', label: args.label ?? '' }
          : {
              action: 'declare',
              series: args.series ?? '',
              label: args.label ?? '',
              unit: args.unit ?? '',
              valueType: args.valueType ?? 'number',
            };
      if (kind === 'series' && args.cadence !== undefined && String(args.cadence).trim() !== '') {
        send.cadence = args.cadence;
      }
      if (kind === 'object') {
        // The columns, if any. A malformed list is refused here with the shape to
        // send — the alternative is a table that silently gets its types inferred
        // from whatever the first row happened to contain.
        const fields = jsonArg(args.fields);
        if (!fields.ok) {
          return {
            ok: false,
            summary: 'fields is not JSON',
            hint:
              'Send fields as \'[{"key":"price","type":"number","unit":"SGD"}]\', or omit it and let the ' +
              'first writes infer the columns.',
          };
        }
        if (fields.value !== undefined) {
          send.fields = Array.isArray(fields.value) ? fields.value : [fields.value];
        }
        if (args.strict === true || args.strict === 'true') send.strict = true;
      }

      const reply = await runTool({ kind: 'metrics', toolId: METRICS_TOOL_ID, args: send });
      const text = String(reply.result ?? '');
      if (!reply.ok) {
        return {
          ok: false,
          summary: 'could not create it',
          data: { error: reply.error ?? '', text },
          hint:
            `${text || reply.error || 'the relay refused the call'}. Do not invent a different key and ` +
            'retry in a loop — tell the wearer in one sentence what it said.',
        };
      }
      const firstLine = text.split('\n')[0].trim();
      return {
        ok: true,
        summary: firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine || 'created',
        data: { text },
      };
    },
  },
  {
    name: 'metrics.act',
    page: GLOBAL_PAGE,
    effect: 'write',
    title: 'Dashboard: numbers and tables',
    description:
      'Everything the wearer has stored, in TWO shapes \u2014 pick by what the data IS, never both.\n' +
      '\u2022 A SERIES is ONE NUMBER OVER TIME (a share price, a PSI reading). `list` shows which exist, ' +
      '`read` returns one series\u2019 history, `write` records a value under a series that already exists. ' +
      'A series has a fixed unit and type and one value per slot; writing the same slot twice REPLACES it, ' +
      'so re-recording is safe.\n' +
      '\u2022 An OBJECT is a TABLE OF ROWS (a launch: date, flat type, project, estate, price). `objects` ' +
      'lists the tables, `object` returns one table\u2019s rows and columns, `recordWrite` upserts rows and ' +
      'CREATES the table on its first write \u2014 you do not have to declare anything first, because a field ' +
      'it has not seen becomes a column automatically. The row\u2019s `key` is its identity: re-use it to ' +
      'correct one row, and a partial write merges so a single cell can be fixed.\n' +
      'THE RULE: a fact with more than one attribute (a date AND a project AND a price) is a ROW, so it ' +
      'goes in an object. A single charted measurement is a SERIES. Do not keep the same row both ways \u2014 ' +
      'four sibling series joined by slot is the old shape objects replace. If the rows are not a time ' +
      'series at all (contacts, an inventory), that is still an object; a record with no date is legal.\n' +
      'Use it whenever a question is about tracked data ("how is DBS", "what did I record yesterday", ' +
      '"which launches are still unsold") or when the wearer tells you some to keep.',
    params: [
      {
        name: 'action',
        type: 'enum',
        values: [...ACTIONS],
        required: true,
        description:
          'Series: list = what exists; read = one series history; write = record a value. ' +
          'Tables: objects = which tables exist; object = one table\u2019s rows; recordWrite = upsert rows.',
      },
      {
        name: 'series',
        type: 'string',
        description:
          'The series key ("sgx.dbs.price") \u2014 or, for object/recordWrite, the TABLE key ("bto.launch"). ' +
          'Required for read, write, object and recordWrite.',
      },
      {
        name: 'limit',
        type: 'number',
        fallback: 30,
        description: 'For read or object: how many recent points or rows. Default 30, capped by the relay at 240.',
      },
      {
        name: 'value',
        type: 'string',
        description:
          'For write: the reading. A number for a number series; the text itself for a series ' +
          'declared as text (up to 500 characters). Never send a placeholder such as "N/A".',
      },
      {
        name: 'slot',
        type: 'string',
        description:
          'For write: the reading\u2019s identity, such as its date. The same slot replaces instead of ' +
          'appending, so re-running a day is safe.',
      },
      {
        name: 'at',
        type: 'string',
        description:
          'For write: when the reading was taken (ISO like 2026-10-08T13:00+08:00, or epoch ms). ' +
          'Omit only for a reading taken now. A backfill without it stacks a month of points at one ' +
          'instant, so always send it when recording history.',
      },
      {
        name: 'rows',
        type: 'string',
        description:
          'For recordWrite: a JSON array of rows, e.g. ' +
          '\'[{"key":"2023-10-15","values":{"price":290000,"project":"Garden Vale"}}]\'. ' +
          '`key` is the row\u2019s identity (a date, an id, a name \u2014 1 to 64 characters), and `values` holds ' +
          'the cells. A field the table does not have yet becomes a column, and the answer tells you ' +
          'which ones it added. Max 32 rows per call. A null means "nothing for this", not zero.',
      },
    ],
    run: async (args) => {
      const action = isAction(args.action) ? args.action : null;
      if (!action) {
        return {
          ok: false,
          summary: 'unknown data action',
          hint:
            'Call it with action "list", "read" or "write" for a series, or "objects", "object" or ' +
            '"recordWrite" for a table of rows.',
        };
      }
      // Only the arguments this action can use are forwarded, so a stale `value`
      // on a read cannot be mistaken by the relay for a write.
      const send: Record<string, unknown> = { action };
      if (action === 'read' || action === 'write' || action === 'object') send.series = args.series ?? '';
      if (action === 'read' || action === 'object') send.limit = args.limit ?? 30;
      if (action === 'write') {
        send.value = args.value ?? '';
        if (args.slot !== undefined && args.slot !== null && String(args.slot).trim() !== '') {
          send.slot = args.slot;
        }
        // Backfill: the relay passes this straight to the store.
        if (args.at !== undefined && args.at !== null && String(args.at).trim() !== '') {
          send.at = args.at;
        }
      }
      if (action === 'recordWrite') {
        send.series = args.series ?? '';
        // `rows` is a JSON string in the schema because this registry's parameter
        // types are scalars. A malformed one is refused HERE, with the shape to
        // send, rather than arriving at the relay as an empty write.
        const rows = jsonArg(args.rows);
        if (!rows.ok) {
          return {
            ok: false,
            summary: 'rows is not JSON',
            hint:
              `${String(args.rows ?? '').slice(0, 80)} is not JSON. Send rows as ` +
              '\'[{"key":"2023-10-15","values":{"price":290000,"project":"Garden Vale"}}]\'.',
          };
        }
        if (rows.value === undefined) {
          return {
            ok: false,
            summary: 'no rows to write',
            hint:
              'recordWrite needs `rows`: a JSON array of {"key": ..., "values": {...}}. Two examples: ' +
              '\'[{"key":"2023-10-15","values":{"price":290000}}]\' for one row, or several objects for a batch.',
          };
        }
        send.records = Array.isArray(rows.value) ? rows.value : [rows.value];
      }

      const reply = await runTool({ kind: 'metrics', toolId: METRICS_TOOL_ID, args: send });
      const text = String(reply.result ?? '');

      if (!reply.ok) {
        // THE RELAY'S SENTENCE IS THE SUMMARY, not "numbers unavailable". When
        // the reason only lived in `text`, the glasses rendered a box reading
        // "Unavailable" with an empty error beneath it — technically a failure
        // report and practically no information. One clipped line of the real
        // reason is what the wearer can act on.
        const reason = String(reply.error || text || 'the relay refused the call').trim();
        const clipped = reason.length > 96 ? `${reason.slice(0, 93)}...` : reason;
        return {
          ok: false,
          summary: clipped,
          data: { action, error: reason, text },
          hint:
            `${reason}. Do not invent a different key, a value or a reading — tell the wearer in ` +
            'one sentence what it said.',
        };
      }

      const body =
        text.length > METRICS_TEXT_CHARS ? `${text.slice(0, METRICS_TEXT_CHARS)}\n[...clipped]` : text;
      // ONE short line for the glasses: the first line the relay produced is
      // already a sentence about the numbers ("Recorded 36.40 SGD for …",
      // or the series header), and the detail stays in `data`.
      const firstLine = text.split('\n')[0].trim();
      const summary = firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine || 'done';
      return {
        ok: true,
        summary,
        data: { action, text: body },
        ...(text.length > METRICS_TEXT_CHARS
          ? { hint: 'The answer was clipped. Read a single series, or a smaller limit, to see the rest.' }
          : {}),
      };
    },
  },
  {
    /**
     * Remove something that should not be there — one reading, one row, or a
     * whole series or table.
     *
     * WHY IT NEEDS ITS OWN CAPABILITY. `metrics.act write` can correct a value,
     * because the same slot replaces. It cannot remove data that should not exist
     * at all, and until this existed a single mistyped launch sat in the middle of
     * a history with no verb that could reach it.
     *
     * WHY WHOLE SHAPES ARE HERE TOO. Creating and destroying were not
     * symmetrical: a model could merge three series into a table and then had no
     * way to remove the three, so every merge left the wreckage behind — and a
     * table sharing its key with the series it replaced made that name ambiguous
     * for ever. So `what: series|table` exists, and it exists HERE, where a tap
     * stands between the model and the destruction.
     *
     * WHY `confirm`. Destructive and irreversible: nothing else in this app can
     * bring back a deleted reading, row, series or table. Tap-to-accept costs one
     * gesture on a rare operation.
     *
     * WHY A NON-EMPTY SERIES TAKES TWO CALLS. The first is refused with the COUNT,
     * which is what the wearer has to be told before agreeing to lose the history;
     * the second sends `purge` and raises a second prompt that says so. Two taps
     * for "delete this and its 400 readings" is the right number.
     */
    name: 'metrics.forget',
    page: GLOBAL_PAGE,
    effect: 'write',
    confirm: true,
    title: 'Remove data',
    description:
      'Delete something that should not be there. `what` decides the scale:\n' +
      '\u2022 "reading" (default): one reading from a series — send `slot`, the date or label it was ' +
      'recorded under. `metrics act` read prints it on any row whose slot is not simply its date.\n' +
      '\u2022 "row": one row from a table — send `key`, exactly as `metrics act` object printed it.\n' +
      '\u2022 "series": the WHOLE series, readings included — send only `series`. Called without ' +
      '`purge` it refuses while readings remain and reports the count; tell the wearer that number, ' +
      'then call again with `purge: true`. This is how a series that has been merged into a table is ' +
      'cleaned up, so a merge need not leave the old series behind.\n' +
      '\u2022 "table": the WHOLE table, rows included, by the same two steps.\n' +
      'It cannot CORRECT a value — that is a write to the same slot or row key, which keeps the row. ' +
      'Nothing here can recover what it removes, so name the exact thing: read it first.',
    params: [
      {
        name: 'what',
        type: 'enum',
        values: ['reading', 'row', 'series', 'table'],
        fallback: 'reading',
        description:
          'reading = one reading (needs slot); row = one table row (needs key); series = the whole ' +
          'series; table = the whole table. Default reading.',
      },
      {
        name: 'series',
        type: 'string',
        required: true,
        description: 'The series key ("tengah.bto.4room") or the table key ("bto.launch").',
      },
      {
        name: 'slot',
        type: 'string',
        description: 'For what=reading: which reading — its slot exactly as `read` printed it, e.g. "2023-10-15".',
      },
      {
        name: 'key',
        type: 'string',
        description:
          'For what=row: which row — its key exactly as `object` printed it. Row keys are compared as ' +
          'strings and are not normalised, so do not reformat the date.',
      },
      {
        name: 'purge',
        type: 'boolean',
        description:
          'For what=series|table: true also deletes the readings or rows inside. Omit it first to be ' +
          'refused with the count, so the wearer can be told how much history is at stake.',
      },
    ],
    run: async (args) => {
      const row = String(args.key ?? '').trim();
      const slot = String(args.slot ?? '').trim();
      const series = String(args.series ?? '').trim();
      const purge = args.purge === true || args.purge === 'true';
      // AN ARGUMENT THAT NAMES THE SHAPE DECIDES IT. A caller that sends `key`
      // means a row, and one that sends `slot` means a reading — so `what` only has
      // to be stated when the scale is larger than the identity it carries, or when
      // the caller wants to be explicit. Defaulting to `reading` regardless would
      // refuse a perfectly clear "row 2023-10-15" for want of a word.
      const asked = String(args.what ?? '').trim().toLowerCase();
      const what = asked || (row ? 'row' : 'reading');

      let send: Record<string, unknown>;
      if (what === 'series' || what === 'table') {
        send = { action: what === 'series' ? 'seriesDelete' : 'tableDelete', series, purge };
      } else if (what === 'row') {
        if (!row) {
          return {
            ok: false,
            summary: 'no row named',
            hint: 'what=row needs `key`: the row identity exactly as `metrics act` object printed it.',
          };
        }
        send = { action: 'recordDelete', series, key: row };
      } else {
        if (!slot) {
          return {
            ok: false,
            summary: 'no reading named',
            hint:
              'what=reading needs `slot`. Use what=series to remove the whole series, or read it first ' +
              'so the slot is one it printed.',
          };
        }
        send = { action: 'delete', series, slot };
      }

      const reply = await runTool({ kind: 'metrics', toolId: METRICS_TOOL_ID, args: send });
      const text = String(reply.result ?? '');
      if (!reply.ok) {
        const reason = String(reply.error || text || 'the relay refused the call').trim();
        const clipped = reason.length > 96 ? `${reason.slice(0, 93)}...` : reason;
        // A REFUSAL THAT IS REALLY A QUESTION is passed through with its
        // instruction intact: the relay's sentence carries the count, and the only
        // useful next step is the same call with purge once the wearer agrees.
        const waitForCount = /still holds/i.test(reason);
        return {
          ok: false,
          summary: clipped,
          data: { what, error: reason, text },
          hint: waitForCount
            ? `${reason} Tell the wearer that number, then call this again with purge:true if they agree.`
            : `${reason}. Do not retry with a different identity — read it and name something it printed.`,
        };
      }
      const firstLine = text.split('\n')[0].trim();
      return {
        ok: true,
        summary: firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine || 'removed',
        data: { what, text },
      };
    },
  },
];
