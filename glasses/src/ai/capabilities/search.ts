// web.search — Jarvis's own web search.
//
// WHY THIS EXISTS
//   `web_search` was an AGENT tool and nothing else. An agent got one because a
//   wearer attached one in the builder; Jarvis — the assistant standing in front
//   of the wearer — had no way to search at all, so "what is the news today"
//   was answerable only by routing to the Agents tab and hoping some agent was
//   built for it. The relay could always do the search (`POST /api/tool` has
//   handled a web tool since before this file); the gap was purely that no
//   capability called it.
//
// A GLOBAL action, for the same reason location.get is one
//   Any page can be asked to search, and the answer belongs to the assistant
//   rather than to a tab — routing the wearer to the Agents page first would be
//   a visible, pointless page change. See the reserve in ../agent.ts: a global
//   that must survive the tool budget has to be named there, which is why this
//   file and that list move together.
//
// WHY IT IS NOT effect: 'pure'
//   jev.decide is pure: it reasons over text the caller handed it. This one
//   reaches out to the network, so it is a READ — it changes nothing the wearer
//   can see and must never be gated, but it is not free of the outside world
//   either. ('read' carries no gate: needsGate only gates 'irreversible'.)
//
// NEVER FABRICATES
//   The search text is handed back verbatim for the model to read. There is no
//   summarising step and no fallback prose: an unconfigured key, an empty result
//   set and a provider error all come back as a failure with the REASON, because
//   a plausible-looking answer with no source behind it is worse than no answer —
//   the wearer cannot tell the two apart in their ear. Same rule as jev's
//   "NEVER returns a default, a prior, or a 'probably'" and location.get's
//   "never invents a coordinate".
//
// IT IS THE SAME SEARCH THE AGENTS USE
//   One provider, one output shape, one budget chain — `web/server/web-search.mjs`
//   resolves the provider and both backends emit byte-identical output for an
//   equivalent hit. Anything else here would be a second search path to keep
//   honest, which is exactly what that module was extracted to prevent.
import { GLOBAL_PAGE, type Capability } from '../types';
import { runTool } from '../../web/agents-client';

/**
 * How much of the result text reaches the model in one call.
 *
 * The relay already caps a single result at its own `TOOL_RESULT_CHARS` (16000),
 * so this is the client-side bound on top of it: a search must not be able to
 * swallow the run's context in one step. It is deliberately BELOW the relay's
 * cap — trimming here keeps the tool message small enough that the loop can still
 * afford a follow-up search within the same turn budget.
 */
export const SEARCH_RESULT_CHARS = 12000;

/**
 * The tool id this capability calls through.
 *
 * A NAME rather than a catalogue lookup, and that is not a shortcut: `runTool`
 * does not go through the registry, so there is no tool row to resolve. The
 * relay selects a backend from its own config (`SEARCH_PROVIDER`, or whichever
 * key is present), so the id is a label for the transcript and the provider
 * choice stays server-side — the same arrangement `web_search` already has.
 */
export const SEARCH_TOOL_ID = 'web_search';

/** Depth values the relay understands, as a tuple so the enum and the guard agree. */
const DEPTHS = ['basic', 'advanced'] as const;

function clip(text: string, max = SEARCH_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n[...clipped]` : text;
}

export const searchCapabilities: Capability[] = [
  {
    name: 'web.search',
    page: GLOBAL_PAGE,
    effect: 'read',
    title: 'Search the web',
    description:
      'Search the web and read the results. Use it for anything that is not in the app and not something ' +
      'you already know: news, prices, a score, opening hours, what happened today, anything containing ' +
      '"latest", "current" or a date in the future. It returns source excerpts, NOT an answer — read them ' +
      'and reply in your own words. If it reports that search is not configured, say so; never answer from ' +
      'memory as though the search had succeeded.',
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description:
          'What to search for, written as a search phrase rather than a sentence — keep the names, places ' +
          'and dates in it. "Singapore rain radar", not "can you tell me if it will rain".',
      },
      {
        name: 'depth',
        type: 'enum',
        values: [...DEPTHS],
        fallback: 'basic',
        description:
          'basic (default) is quick and enough for a fact or a headline. advanced reads more of each ' +
          'source, so use it when the answer needs detail or the first search came back thin.',
      },
      {
        name: 'freshness',
        type: 'string',
        description:
          'Optional recency filter in provider syntax: day, week, month or year. Use week or day for news, ' +
          'and omit it for anything that does not go stale.',
      },
    ],
    run: async (args) => {
      const query = String(args.query ?? '').replace(/\s+/g, ' ').trim();
      if (!query) {
        return {
          ok: false,
          summary: 'nothing to search for',
          hint: 'The query argument was empty. Ask the wearer what to search for, or work out the phrase yourself.',
        };
      }
      const depth = DEPTHS.includes(args.depth as (typeof DEPTHS)[number])
        ? String(args.depth)
        : 'basic';
      const freshness = String(args.freshness ?? '').trim();

      // The relay never throws at us and never fabricates: a missing key, a bad
      // request and an empty result set are all distinct `ok:false` reasons, so
      // they are passed through rather than flattened into "search failed".
      const reply = await runTool({
        kind: 'web',
        toolId: SEARCH_TOOL_ID,
        args: { query, depth, ...(freshness ? { freshness } : {}) },
      });

      if (!reply.ok || !reply.result) {
        const reason = reply.error || 'the search returned nothing';
        return {
          ok: false,
          summary: `search unavailable: ${clip(reason, 60)}`,
          data: { query, depth, error: reason },
          hint:
            'The search did NOT run, so nothing is known about this. Tell the wearer in one sentence that ' +
            'search failed and give the reason above. Do not answer the question from memory and do not ' +
            'describe results you did not read.',
        };
      }

      const text = clip(reply.result);
      return {
        ok: true,
        // ONE short ASCII line for the HUD. The results themselves are in `data`
        // and are read by the model, never rendered on the glasses.
        summary: `read ${query.length > 34 ? `${query.slice(0, 33)}\u2026` : query}`,
        data: { query, depth, freshness: freshness || null, chars: text.length, results: text },
        hint:
          'These are source excerpts, not an answer. Reply from what they say, name the source when the ' +
          'wearer needs to trust it, and say plainly if they do not cover the question.',
      };
    },
  },
];
