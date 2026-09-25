// MCP tool ROUTER — JEV picks which of a server's tools a turn should be able to call.
//
// WHY THIS MODULE EXISTS
//   Once discovery comes from the server (see mcp-tools.mjs) the catalogue is no
//   longer something we curated, so its size is out of our hands: a server may
//   expose four tools or sixty. Handing sixty function schemas to the model on
//   every turn is wrong in three separate ways — it spends the context budget on
//   descriptions that do not apply, it dilutes the choice so the model picks
//   worse, and it invites a call to a tool nobody wanted.
//
//   So the tools are RANKED against the turn's request and only the shortlist is
//   offered. The ranker is JEV, because ranking is the one thing this app
//   already has a calibrated implementation of.
//
// THE TRICK THAT MAKES THIS CHEAP, AND WHY IT IS SHAPED THIS WAY
//   A `choice` question puts its CANDIDATES in the criteria and its SUBJECT in
//   `state` (jev-spec.mjs says so explicitly under "jev as a RERANKER"). So the
//   tools go in the criteria — one label each, with the tool's own description
//   as that option's explanation — and the wearer's REQUEST goes in as the
//   state. The ranker therefore reasons over what each tool MEANS, which is the
//   only signal that generalises past the names, and it spends almost no state
//   budget doing it.
//
// FOUR HONEST LIMITS, ALL ENFORCED HERE RATHER THAN DISCOVERED IN PRODUCTION
//   • AT MOST 12 CANDIDATES. That is JEV's own `MAX_CRITERIA_COUNT`, so a larger
//     catalogue CANNOT be ranked in one call. The router says so and returns
//     everything rather than silently dropping tools the caller never chose to
//     drop — a truncated catalogue is a capability that vanishes with no error
//     anywhere. Ranking more than 12 needs a two-pass fold, which is a change to
//     make deliberately, not a fallback to invent here.
//   • LABELS ARE AT MOST 60 CHARS, and are returned VERBATIM as the answer, so
//     they are built to be unique and mapped back to the tool name rather than
//     assumed to be one.
//   • THE INSTRUCTIONS AND THE STATE ARE BOUNDED (`MAX_INSTRUCTIONS_CHARS`,
//     `MAX_STATE_CHARS`), because JEV rejects a long one outright.
//   • IT ALWAYS FAILS OPEN. No ranker configured, a ranker that throws, an
//     unusable answer — every one of those returns the FULL catalogue. A turn
//     with too many tools is degraded; a turn with NO tools is broken, and the
//     model will tell the wearer it has no access to something it does have.
//
// ASCII only, no import side effects, and the network call is INJECTED (`respond`)
// so the whole ranking path is assertable against a stub.

import {
  LIMITS,
  buildRequest,
  describeRanking,
  rankAnswers,
  validateQuestions,
} from './jev-spec.mjs';

/** The one question this module asks. Must satisfy JEV's NAME_RE. */
export const ROUTE_NAME = 'use';

/** How many tools a routed turn is offered when the caller does not say. */
export const DEFAULT_TOP = 4;

/** JEV's ceiling on options, so also this router's ceiling on candidates. */
export const MAX_CANDIDATES = LIMITS.MAX_CRITERIA_COUNT;

/**
 * Build the option labels for a catalogue, and the map back to real names.
 *
 * Uniqueness is the point: JEV answers with a label VERBATIM, so two tools that
 * clip to the same 60 characters would be indistinguishable in the answer and
 * the wrong one would be called. A colliding label therefore gets a `~2` suffix
 * rather than being dropped.
 */
export function routeLabels(names) {
  const max = LIMITS.MAX_CRITERIA_LABEL_CHARS;
  const used = new Set();
  const out = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    let label = name.length > max ? name.slice(0, max - 2) + '~' : name;
    if (used.has(label)) {
      let n = 2;
      // Trim the tail so the suffix always fits inside the limit.
      while (used.has(label)) {
        const tag = `~${n}`;
        label = (name.length > max - tag.length ? name.slice(0, max - tag.length) : name) + tag;
        n += 1;
      }
    }
    used.add(label);
    out.push({ label, name });
  }
  return out;
}

/**
 * The instructions JEV is given. Kept short and free of the catalogue itself —
 * the options DO carry the tools, so repeating them here would spend the 400
 * character allowance on a second copy of the same words.
 */
export function routeInstructions(ask) {
  const trimmed = String(ask ?? '').replace(/\s+/g, ' ').trim();
  const head = 'Which ONE option can best carry out the request in the state?';
  const tail = trimmed ? ` The request is: ${trimmed}` : '';
  const text = `${head}${tail}`;
  return text.length > LIMITS.MAX_INSTRUCTIONS_CHARS
    ? text.slice(0, LIMITS.MAX_INSTRUCTIONS_CHARS - 3) + '...'
    : text;
}

/**
 * The validated `choice` question for a catalogue.
 *
 * Each option's EXPLANATION is the tool's own description, which is the whole
 * reason this beats ranking on names: the descriptions are what the server
 * author wrote to say when the tool applies.
 */
export function buildRouteSpec(entries, ask) {
  const criteria = {};
  for (const e of entries) {
    const desc =
      String(e.description ?? '').replace(/\s+/g, ' ').trim() ||
      'No description was given for this tool.';
    criteria[e.label] =
      desc.length > LIMITS.MAX_CRITERIA_DESC_CHARS
        ? desc.slice(0, LIMITS.MAX_CRITERIA_DESC_CHARS - 3) + '...'
        : desc;
  }
  return validateQuestions({
    [ROUTE_NAME]: { type: 'choice', instructions: routeInstructions(ask), criteria },
  });
}

/**
 * Rank a catalogue against one request and return the shortlist.
 *
 * `respond` is the network: it takes a built JEV request and resolves to the
 * answers object. Everything else here is pure, so the failure branches below
 * are all reachable from a harness without a server.
 *
 * @returns {Promise<{
 *   chosen: {name: string, serverName: string}[],
 *   all: {name: string, serverName: string}[],
 *   routed: boolean,
 *   ranking: object|null,
 *   unresolved: boolean,
 *   reason: string|null,
 * }>}
 */
export async function routeTools({
  ask,
  catalogue,
  top = DEFAULT_TOP,
  respond,
  minCandidates = 2,
} = {}) {
  const all = (catalogue ?? []).map((t) => ({
    name: String(t.name ?? ''),
    serverName: String(t.serverName ?? t.name ?? ''),
    description: String(t.description ?? ''),
  }));
  const everything = { chosen: all, all, routed: false, ranking: null, unresolved: false, reason: null };

  // Nothing to rank, or nothing to rank AGAINST: either way, offer it all.
  if (all.length === 0) return { ...everything, reason: 'no tools to route' };
  if (!String(ask ?? '').trim()) return { ...everything, reason: 'no request to route against' };
  if (all.length <= minCandidates) return { ...everything, reason: 'too few tools to rank' };
  // Already small enough to send whole: ranking could only reorder it.
  if (all.length <= top) return { ...everything, reason: 'the catalogue already fits' };
  if (!respond) return { ...everything, reason: 'no ranker configured' };
  if (all.length > MAX_CANDIDATES) {
    // Deliberately NOT truncated. See the header: a silently shortened catalogue
    // is a tool that disappears with no error, which is worse than a fat list.
    return {
      ...everything,
      reason: `the catalogue has ${all.length} tools, above the ${MAX_CANDIDATES} a single ranking can hold`,
    };
  }

  const entries = routeLabels(all.map((t) => t.name)).map((l) => ({
    ...l,
    description: all.find((t) => t.name === l.name)?.description ?? '',
  }));

  const spec = buildRouteSpec(entries, ask);
  if (!spec.ok) return { ...everything, reason: `could not build a ranking: ${spec.error}` };

  const req = buildRequest({ state: String(ask).trim(), questions: spec.value });
  if (!req.ok) return { ...everything, reason: `the ranking request was rejected: ${req.error}` };

  let answers;
  try {
    answers = await respond(req.value);
  } catch (err) {
    // A ranker that is down must not cost the turn its tools.
    return {
      ...everything,
      reason: `the ranker failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ranking = rankAnswers(spec.value, answers)?.[ROUTE_NAME] ?? null;
  if (!ranking || !ranking.ranked?.length) {
    return { ...everything, reason: 'the ranker returned no usable order' };
  }

  // JEV answers an unreadable result with DECLARED order — every `p` null and
  // `top` null — deliberately, so that no caller mistakes it for a ranking.
  // Taking it at face value here would do the opposite of what this module is
  // for: the turn would be narrowed to the first N tools in CATALOG order and
  // reported as a routing decision, which is an arbitrary choice wearing a
  // confident one's clothes. No number anywhere means no basis to order, so the
  // turn keeps everything.
  if (!ranking.ranked.some((r) => typeof r.p === 'number')) {
    return {
      ...everything,
      reason: `the ranker gave no basis to order them: ${ranking.reason ?? 'no distribution'}`,
    };
  }

  const byLabel = new Map(entries.map((e) => [e.label, e.name]));
  const chosen = ranking.ranked
    .slice(0, Math.max(1, top))
    .map((r) => byLabel.get(r.label))
    .filter(Boolean)
    .map((name) => all.find((t) => t.name === name));

  if (!chosen.length) return { ...everything, reason: 'the ranking named no tool we hold' };

  return {
    chosen,
    all,
    routed: true,
    ranking,
    // Reported, never repaired. An unresolved order means the leader is inside
    // JEV's margin of the runner-up: we still hand back the shortlist (a caller
    // asked for several tools, not for a winner), but the caller is told the
    // separation is not trustworthy so it can widen `top` if that matters.
    unresolved: ranking.unresolved === true,
    reason: ranking.unresolved ? ranking.reason : null,
  };
}

/** One line for a log or a transcript: what was chosen, and why if it was not. */
export function describeRoute(result) {
  if (!result) return '';
  if (!result.routed) {
    return `route: all ${result.all.length} tools kept (${result.reason})`;
  }
  const body = describeRanking(result.ranking);
  const kept = result.chosen.map((c) => c.name).join(', ');
  const flag = result.unresolved ? ` (unresolved: ${result.reason})` : '';
  return `route: kept ${kept} of ${result.all.length}${flag} | ${body}`;
}
