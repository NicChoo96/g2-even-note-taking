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
//   The relay's tool has no `declare` action on purpose: series cardinality is a
//   human decision made on the Data page. So an unknown key comes back as the
//   relay's own refusal, and this capability passes that sentence through
//   instead of softening it. A model told "recorded" for a series that does not
//   exist is worse than one told nothing.
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

const ACTIONS = ['list', 'read', 'write'] as const;
type MetricsAction = (typeof ACTIONS)[number];

const isAction = (v: unknown): v is MetricsAction =>
  typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);

export const metricsCapabilities: Capability[] = [
  {
    /**
     * Create a series — the one action that changes what the dashboard IS.
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
    title: 'Track a new number',
    description:
      'Create a dashboard series so a number can be recorded from now on. Use it when the wearer asks ' +
      'you to track or chart something that `metrics act` list does not already show — including ' +
      '"collect this for a month", where the series must exist before the readings can be stored. ' +
      'Send a dotted lowercase key (psi.west, news.rates.count), a short label, the unit, and whether ' +
      'a reading is a number or text. The unit and type are permanent, so choose them for the whole ' +
      'history, not for today. After it succeeds, write the readings with action "write".',
    params: [
      {
        name: 'series',
        type: 'string',
        required: true,
        description: 'The key, dotted and lowercase: "psi.west". One series per measure, never per day.',
      },
      {
        name: 'label',
        type: 'string',
        description: 'Shown on the dashboard: "PSI west". Defaults to the key.',
      },
      {
        name: 'unit',
        type: 'string',
        description: 'Short unit: "PSI", "SGD", "mentions". Cannot be changed later.',
      },
      {
        name: 'valueType',
        type: 'enum',
        values: ['number', 'string'],
        fallback: 'number',
        description: 'What one reading is. Default number.',
      },
      {
        name: 'cadence',
        type: 'string',
        description: 'Optional hint: "daily", "hourly". Advisory only.',
      },
    ],
    run: async (args) => {
      const send: Record<string, unknown> = {
        action: 'declare',
        series: args.series ?? '',
        label: args.label ?? '',
        unit: args.unit ?? '',
        valueType: args.valueType ?? 'number',
      };
      if (args.cadence !== undefined && String(args.cadence).trim() !== '') send.cadence = args.cadence;

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
    title: 'Dashboard numbers',
    description:
      "The digitised numbers the wearer keeps on their dashboard. `list` shows which series exist with " +
      "their latest value; `read` returns one series' history; `write` records a value under a series " +
      'that already exists. A series has a fixed unit and type and is declared by the wearer on the ' +
      'Data page — this cannot create one, so use `list` first and use the keys it returns exactly as ' +
      'written. Writing the same slot twice REPLACES the earlier reading, so re-recording is safe. ' +
      'Use it whenever a question is about a tracked number ("how is DBS", "what did I record ' +
      'yesterday") or when the wearer tells you one to keep.',
    params: [
      {
        name: 'action',
        type: 'enum',
        values: [...ACTIONS],
        required: true,
        description: 'list = what exists; read = one series history; write = record a value.',
      },
      {
        name: 'series',
        type: 'string',
        description: 'The series key, e.g. "sgx.dbs.price". Required for read and write.',
      },
      {
        name: 'limit',
        type: 'number',
        fallback: 30,
        description: 'For read: how many recent points. Default 30, capped by the relay at 240.',
      },
      {
        name: 'value',
        type: 'string',
        description:
          'For write: the reading. A number for a number series; anything non-numeric is refused by the ' +
          'store. Never send a placeholder such as "N/A".',
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
    ],
    run: async (args) => {
      const action = isAction(args.action) ? args.action : null;
      if (!action) {
        return {
          ok: false,
          summary: 'unknown metrics action',
          hint: `Call it with action "list", "read" or "write".`,
        };
      }
      // Only the arguments this action can use are forwarded, so a stale `value`
      // on a read cannot be mistaken by the relay for a write.
      const send: Record<string, unknown> = { action };
      if (action === 'read' || action === 'write') send.series = args.series ?? '';
      if (action === 'read') send.limit = args.limit ?? 30;
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
];
