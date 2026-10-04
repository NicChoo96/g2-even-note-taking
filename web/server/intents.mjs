// Delegated intents: the app's own capabilities, offered to a server-side agent
// run as a tool that PROPOSES rather than performs.
//
// THE GAP THIS CLOSES. An agent run executes HERE, in the relay. Everything that
// makes the app *the app* — the to-do list, the document library, the notes
// scratchpad, the agent catalogue — lives on the device, and a run had no way to
// reach any of it: the wearer's spoken words arrived as the pre-run prompt and
// nothing the run did afterwards could touch the app. So "every morning, file a
// briefing" could search the web and produce a document, and then had nowhere to
// put it.
//
// WHY THE TOOL PROPOSES INSTEAD OF DOING. The device is the only party that can
// run a capability, and it is also the only party that can ask the wearer. So the
// tool's whole job is to record a well-formed ASK, and the device then runs it
// through the ordinary path: validation, the effect class, the tap-to-confirm
// gate for anything irreversible, and undo. A relay that executed directly would
// be a second, ungated write path into the wearer's data — and it would be one
// the ledger's safety invariant ("an irreversible entry may not succeed without
// a preceding approved gate") could not even see, because the gate lives in
// `glasses/src/ai/ledger.ts` on the device.
//
// WHY THE KIND IS NOT ONE OF THE NINE. The hub's tool vocabulary is closed —
// `['web','tavily','http','jev','files','todo','docs','notes','location']` — and
// a tool of any other kind is refused with `400 kind: unsupported value`. So this
// kind can never be minted by the hub, and a row arriving from `/hub/tools` can
// never be mistaken for one of these. That is the same trick, and the same
// reason, as `hub_mcp` in ./hub-mcp-tools.mjs: a built-in has to be
// distinguishable from the user's own tools by INSPECTION, not by convention.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT HOLD: the capability catalogue. It
// arrives in the run body, from the device, and is forwarded verbatim — the enum
// below is built from exactly the array `runIntentTool` validates against, so
// this file cannot drift from what it accepts, and it holds no list of the app's
// actions at all. A second capability list here would be a second thing to keep
// in step with `glasses/src/ai/pages.ts`, which is the drift docs/agent-
// architecture.md section 8 refuses by name ("A second capability list for
// agents... Sharing the table is the whole reason D2 is possible").

/**
 * The built-in's kind. Deliberately not one of the hub's nine — see the header.
 */
export const INTENT_TOOL_KIND = 'app_intent';

/** The name the model sees. Matches what the ledger's `by:'agent'` lines refer to. */
export const INTENT_TOOL_NAME = 'jarvis_app';

/**
 * How many intents ONE run may propose. Not a safety limit — a budget, for the
 * same reason MAX_STEPS is one: a model that has discovered it can post work to
 * the device will happily propose twelve changes to a one-line request, and the
 * wearer would then get twelve confirmation prompts they did not ask for. Four
 * is more than any sane single ask needs and few enough that the run's own
 * transcript still reads as an explanation of the run.
 */
export const INTENT_MAX_PER_RUN = 4;

/**
 * How many catalogue entries a run will accept. The device's delegable set is
 * around two dozen; the ceiling is here so a malformed or hostile body cannot
 * make every tool schema in the process enormous. Truncation is SAFE because the
 * schema's enum is built from the truncated list — an action that was cut is not
 * advertised, so the model cannot ask for one the relay would refuse.
 */
export const INTENT_MAX_CATALOG = 48;

/**
 * Bound on an intent's arguments as they cross the wire and land in the ledger.
 *
 * THE NUMBER HAS TO COME FROM THE LARGEST BODY AN ACTION TAKES, not from a guess
 * at what a model usually sends. `files.publish`'s required argument is the
 * COMPLETE HTML document, and `docs.append`'s is a passage, so this ceiling IS
 * the largest page an agent can put in the wearer's store. It was 1200 — which
 * is 1/50th of the app's own read window and 1/3333rd of what the store accepts —
 * and the consequence was not a small page but NO page: an agent asked to build a
 * 19 kB digest was refused with "those arguments are too large to hand the
 * device", and a refusal the model cannot act on is what it answers with a
 * plausible sentence instead. A write path that cannot carry a document is not a
 * slightly narrow write path; it is the absence of one.
 *
 * 200_000 because the floor is the page the WEARER CAN READ BACK in one go
 * (`BODY_MAX_CHARS = 60_000` in ./jarvis-files.mjs), and this sits above three
 * times that, so any page that arrives whole on a read can also be published
 * whole by an agent. It is deliberately NOT the store's own `MAX_HTML_BYTES`
 * (4 MB): an intent is carried in the run's transcript, which is broadcast to
 * every client and replayed on every reconnect, so a megabyte body per intent is
 * a cost the store does not pay. That bound is therefore stated rather than
 * hidden — the web Files tab can publish up to 4 MB, an agent up to this.
 */
export const MAX_ARGS_CHARS = 200_000;
/** Bound on a catalogue entry's description, which is prompt text. */
const MAX_DESC_CHARS = 240;

/**
 * Is this one of ours? Inspects `kind` rather than `name`, so a wearer who has
 * an agent tool named `jarvis_app` still has their own tool.
 */
export function isIntentTool(t) {
  return t?.kind === INTENT_TOOL_KIND;
}

function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Normalise the catalogue the device sent. Shaped here, ONCE, so the schema and
 * the validator read the same array — this is the `hubMcpToolSchema` discipline
 * from ./hub-mcp-tools.mjs, where the action enum and the handled cases sit
 * together precisely so they cannot disagree.
 */
function normalizeCatalog(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name ?? '').trim();
    // A name without a dot is not an app action; a page is required because the
    // device needs it to decide which layer the intent belongs to.
    if (!name.includes('.') || seen.has(name)) continue;
    seen.add(name);
    const params = Array.isArray(entry.params)
      ? entry.params
          .filter((p) => p && typeof p.name === 'string')
          .slice(0, 6)
          .map((p) => ({
            name: String(p.name),
            description: clip(p.description, 120),
            required: p.required === true,
            ...(Array.isArray(p.values) ? { values: p.values.slice(0, 12).map(String) } : {}),
          }))
      : [];
    out.push({
      name,
      title: clip(entry.title, 60),
      page: String(entry.page ?? ''),
      effect: String(entry.effect ?? 'write'),
      description: clip(entry.description, MAX_DESC_CHARS),
      params,
    });
    if (out.length >= INTENT_MAX_CATALOG) break;
  }
  return out;
}

/**
 * The tool for one run, built from the device's catalogue. Returns null when the
 * device offered nothing, which is how a run from an older client keeps exactly
 * the toolset it had before this existed.
 */
export function intentToolFor(rawCatalog) {
  const catalog = normalizeCatalog(rawCatalog);
  if (!catalog.length) return null;
  return {
    id: 'builtin:jarvis_app',
    kind: INTENT_TOOL_KIND,
    name: INTENT_TOOL_NAME,
    toolId: INTENT_TOOL_NAME,
    description: 'Ask the glasses app to do something the wearer can see.',
    catalog,
  };
}

/**
 * The JSON schema for a built-in intent tool. Built FROM the catalog, so the
 * `action` enum and the set `runIntentTool` accepts are the same array — adding
 * a capability to the app grows both at once, and there is no place for the two
 * to disagree.
 */
export function intentToolSchema(tool) {
  const actions = tool.catalog.map((c) => c.name);
  const lines = tool.catalog.map((c) => `${c.name} (${c.effect}) - ${c.title}: ${c.description}`);
  return {
    type: 'function',
    function: {
      name: INTENT_TOOL_NAME,
      // WHAT THE MODEL MUST KNOW, in the order it needs it.
      //
      // It has to know this is how its own work gets SAVED, or it builds a report
      // and has nowhere to put it: an agent asked for a digest page has to be
      // told, in the tool it is holding, that `files.publish` is the way that page
      // reaches the wearer. "Change something of the wearer's" described the tool
      // to a reader who already knew what it was and to nobody else.
      //
      // And it has to know the request is ANSWERED LATER, because that is the
      // fact it cannot recover from being wrong about. A run that calls this and
      // then says "published, 19.2 kB" has recorded a claim the relay is in no
      // position to check and the wearer is in no position to doubt — and if the
      // ask had been refused earlier in the turn, that sentence is simply false.
      // SO THE PROHIBITION IS THE LOAD-BEARING PART: the transcript of a run is
      // read as evidence of what happened, and the only way it stays evidence is
      // if the model is told, here, never to report this as a completed change.
      description:
        'Ask the glasses app to change something of the wearer\'s: their to-do list, ' +
        'their documents, their scratchpad, their published files, or another agent. ' +
        'This is also how you SAVE work of your own — files.publish puts a page you have ' +
        'built into the store the wearer reads, and docs.new starts a document for them. ' +
        'It RECORDS A REQUEST: the device runs it afterwards and will ask the wearer to ' +
        'confirm anything it cannot undo. You will not see the result, so never report the ' +
        'change as done, published, saved or created — say that you asked for it and that ' +
        'it is pending. If the action you need is not in the list below, say so plainly ' +
        'rather than describing the change as made.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: actions,
            description: `The app action. One of:\n${lines.join('\n')}`,
          },
          args: {
            type: 'object',
            description:
              'Arguments for the action, as named in the action\'s description. ' +
              'Omit for an action that takes none.',
          },
          why: {
            type: 'string',
            description:
              'One short sentence, in the wearer\'s words, saying why this change is ' +
              'wanted. It is what the wearer reads on the confirmation prompt.',
          },
        },
        required: ['action', 'why'],
      },
    },
  };
}

/**
 * Arguments as an object, whatever shape the model sent. Providers disagree:
 * some send an object, some send a JSON string, and a model that has decided to
 * be helpful sends a prose sentence. Only the first two are usable, and a
 * refusal here would send the model hunting for a syntax problem it cannot see.
 */
function coerceArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to empty */
    }
  }
  return {};
}

/**
 * Run one intent proposal. Returns TEXT and NEVER throws — the caller puts the
 * return value straight into the transcript, so an exception here would abort a
 * run over a rejected propose rather than telling the model what was wrong.
 *
 * `ctx.list` is the run's own proposal list, owned by the CALLER (local-sse keeps
 * it in a side table beside the run, the way it keeps the location snapshot). The
 * sequence number in the returned `key` is that list's length, which is what makes
 * the key stable: the device dedupes on it, so a run whose transcript is replayed
 * on reconnect cannot propose the same change twice.
 */
export function runIntentTool(tool, rawArgs, ctx = {}) {
  const list = Array.isArray(ctx.list) ? ctx.list : [];
  let args = {};
  try {
    args = typeof rawArgs === 'string' ? coerceArgs(rawArgs) : rawArgs ?? {};
  } catch {
    args = {};
  }
  const action = String(args.action ?? '').trim();
  const why = clip(args.why, 120);
  const caps = tool?.catalog ?? [];
  const found = caps.find((c) => c.name === action);

  if (!found) {
    return JSON.stringify({
      ok: false,
      summary: `no such app action: ${clip(action, 40) || '(none given)'}`,
      hint: `callable actions: ${caps.map((c) => c.name).slice(0, 16).join(', ')}`,
    });
  }

  const payload = coerceArgs(args.args);
  const size = JSON.stringify(payload).length;
  if (size > MAX_ARGS_CHARS) {
    // A REFUSAL HAS TO BE ACTIONABLE, or it is worse than silence: the model
    // holds a request it cannot place and a run it must narrate, and the
    // cheapest sentence available is the one that claims success. So this names
    // the ceiling, the size that was sent, and the only real recovery — asking
    // for less — and it forbids the invented outcome in the same breath.
    return JSON.stringify({
      ok: false,
      summary:
        `those arguments are too large to hand the device: ${size} characters, ` +
        `and the limit is ${MAX_ARGS_CHARS}`,
      hint:
        'send less: publish or write a shorter body, or split it into several documents. ' +
        'Do NOT tell the user the change was made — it was not.',
    });
  }

  // The device is the authority on what it can run, but the relay owns the
  // identifier, so a proposal is addressable even before the device has seen it.
  const key = `${ctx.runId ?? 'run'}:${list.length + 1}`;
  const existing = list.find((i) => i.action === action && JSON.stringify(i.args) === JSON.stringify(payload));
  if (existing) {
    // Same ask twice is the model looping, not an error worth a step: return the
    // FIRST key so the device's dedupe holds, and say so plainly.
    return JSON.stringify({
      ok: true,
      summary: `already proposed: ${found.title}`,
      data: { intent: existing, duplicate: true },
    });
  }

  if (list.length >= INTENT_MAX_PER_RUN) {
    return JSON.stringify({
      ok: false,
      summary: `this run has already asked the app to do ${INTENT_MAX_PER_RUN} things`,
      hint: 'finish this run and start another one',
    });
  }

  const intent = {
    key,
    action: found.name,
    title: found.title,
    effect: found.effect,
    args: payload,
    why,
  };
  list.push(intent);

  return JSON.stringify({
    ok: true,
    summary: `asked the app to ${found.title}${why ? ` (${clip(why, 60)})` : ''}`,
    data: { intent },
    // "pending" is the word that has to be here. The tool result IS the model's
    // last sight of its own ask, and it is read again whenever the transcript is
    // replayed — so a hint that reads as "you are finished" is what licenses the
    // sentence the wearer then believes. This says the opposite, in the two words
    // the model would otherwise reach for: asked, not done.
    hint:
      `the device runs this afterwards and you will not see the result — ` +
      `say you asked for "${found.title}", never that it is done`,
  });
}
