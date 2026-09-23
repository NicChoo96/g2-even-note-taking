// Web search — ONE provider-agnostic interface over Tavily and Brave Search.
//
// WHY THIS MODULE EXISTS
//   The tool used to be `tavily_search` and spoke Tavily's wire format inline in
//   local-sse.mjs. Two things changed together: the name the MODEL sees is now
//   `web_search` (a name that does not lie about the backend), and the backend
//   itself became a SETTING — Tavily or Brave, swappable without a redeploy.
//   Request building and response mapping therefore live here, in a module with
//   no server-boot side effects, so both providers can be driven against a
//   stubbed fetch and asserted precisely. (Same reason wire.mjs was extracted:
//   local-sse.mjs starts an HTTP server on import.)
//
// THE ONE INVARIANT THAT MUST NOT BREAK
//   Both providers produce the SAME output shape: up to MAX_HITS numbered blocks
//   of `N. Title\nURL\ncontent`, each content clipped to `perHit`, the whole
//   string clipped to `total`, and `'No results.'` when a provider returns
//   nothing usable. The model's view of a search hit is therefore identical no
//   matter which provider is live, which is what keeps the budget chain honest —
//   agent.ts MAX_RESULT_CHARS and capabilities/agents.ts TRANSCRIPT_MSG_CHARS are
//   sized against TOOL_RESULT_CHARS, so a second result shape would silently
//   break them.
//
// BRAVE, SPECIFICALLY
//   This targets Brave's *LLM Context* endpoint (/res/v1/llm/context), not the
//   Answers endpoint: it returns grounding chunks sized for a model's context
//   window rather than a written answer, which is exactly what a tool result
//   should be. Auth is `X-Subscription-Token` — NOT `Authorization: Bearer`.
//
//   We deliberately do NOT send `Accept-Encoding`, do NOT pin `Api-Version`, and
//   do NOT set a country/search_lang. Node's fetch already negotiates and
//   transparently decompresses gzip; pinning Api-Version would hold Brave on the
//   PREVIOUS content pipeline (the changelog makes the new one the default, so a
//   pin would be a downgrade); and the regional defaults are the API's calibrated
//   ones, which is a better guess than a hardcoded 'us'.

/** Both spellings are accepted: 'web' is the current kind, 'tavily' is legacy. */
export const WEB_KINDS = new Set(['web', 'tavily']);
export const PROVIDERS = ['tavily', 'brave'];

export const TAVILY_URL = 'https://api.tavily.com/search';
export const BRAVE_URL = 'https://api.search.brave.com/res/v1/llm/context';

/** Both providers are trimmed to this many sources, matching the old 5. */
export const MAX_HITS = 5;
/** A search call should not outlive this, whatever the run's own signal says. */
export const SEARCH_TIMEOUT_MS = 30_000;

export const DEFAULT_PER_HIT_CHARS = 3000;
export const DEFAULT_RESULT_CHARS = 16000;

export const DEFAULT_DEPTH = 'basic';

/** Is this a web-search tool? Accepts the legacy `kind: 'tavily'` too. */
export function isWebTool(t) {
  return Boolean(t) && WEB_KINDS.has(t.kind);
}

/**
 * The depth to use for one call. The model's argument wins over the tool's own
 * setting, which wins over the relay default — and the legacy `search_depth`
 * argument name is still honoured, because a persisted agent transcript or an
 * older client bundle may still send it.
 */
export function resolveDepth(args, tool, fallback) {
  const asked = String(args?.depth ?? args?.search_depth ?? '').toLowerCase();
  if (asked === 'advanced' || asked === 'basic') return asked;
  const own = String(tool?.searchDepth ?? '').toLowerCase();
  if (own === 'advanced' || own === 'basic') return own;
  const base = String(fallback ?? '').toLowerCase();
  return base === 'advanced' ? 'advanced' : DEFAULT_DEPTH;
}

/**
 * Depth → each provider's own tuning.
 *
 * Tavily has exactly one knob (`search_depth`). Brave has none by that name, so
 * a depth is expressed with the counts that actually bound its context: how many
 * URLs, how many tokens, and how many tokens per URL. The numbers are chosen to
 * land near what Tavily returns in practice (basic ≈ 5 hits of ~1.4k chars,
 * advanced ≈ a much larger context), so switching provider does not silently
 * change how much the model gets to read.
 *
 * `context_threshold_mode` is left UNSET for basic — Brave's calibrated default
 * is a better filter than a guess — and set to 'lenient' for advanced, which is
 * the whole point of asking for more.
 */
export function searchPlan(provider, depth) {
  const advanced = depth === 'advanced';
  if (provider === 'brave') {
    return advanced
      ? {
          count: 20,
          maximum_number_of_urls: 20,
          maximum_number_of_tokens: 8192,
          maximum_number_of_tokens_per_url: 3072,
          context_threshold_mode: 'lenient',
        }
      : {
          count: 5,
          maximum_number_of_urls: 5,
          maximum_number_of_tokens: 4096,
          maximum_number_of_tokens_per_url: 1536,
        };
  }
  return { search_depth: advanced ? 'advanced' : 'basic' };
}

const SHORTHAND = new Set(['pd', 'pw', 'pm', 'py']);
const RANGE = /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/;
const SHORTHAND_DAYS = { pd: 1, pw: 7, pm: 30, py: 365 };

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * A recency filter, expressed in each provider's own vocabulary.
 *
 * Brave takes `freshness` verbatim (pd/pw/pm/py or a `YYYY-MM-DDtoYYYY-MM-DD`
 * range). Tavily has no such parameter — it takes absolute `start_date` /
 * `end_date` dates — so the shorthand is resolved against the run's clock. This
 * is why a `now` is threaded in: "the past week" is only meaningful relative to
 * the moment the run happened.
 *
 * An unrecognised filter is DROPPED rather than forwarded. A model that
 * hallucinates `freshness: "yesterday"` should get a broad, correct result — not
 * a 422, and not a silently wrong date window.
 */
export function freshnessPlan(provider, raw, now = new Date()) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return {};
  if (!SHORTHAND.has(v) && !RANGE.test(v)) return {};
  if (provider === 'brave') return { freshness: v };
  if (RANGE.test(v)) {
    const [start, end] = v.split('to');
    return { start_date: start, end_date: end };
  }
  const from = new Date(now.getTime() - (SHORTHAND_DAYS[v] - 1) * 86_400_000);
  return { start_date: ymd(from) };
}

/**
 * Build the HTTP call for one provider. Returns `{ url, init }` so a test can
 * assert the exact URL, headers and body without a network.
 *
 * The two auth schemes are genuinely different and getting them confused is a
 * silent 401: Tavily wants `Authorization: Bearer`, Brave wants
 * `X-Subscription-Token`.
 */
export function buildSearchRequest({ provider, key, query, depth, freshness, now, signal }) {
  const extra = freshnessPlan(provider, freshness, now ?? new Date());
  if (provider === 'brave') {
    const qs = new URLSearchParams({ q: String(query) });
    for (const [k, v] of Object.entries({ ...searchPlan('brave', depth), ...extra })) {
      qs.set(k, String(v));
    }
    return {
      url: `${BRAVE_URL}?${qs.toString()}`,
      init: {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-Subscription-Token': String(key || ''),
        },
        ...(signal ? { signal } : {}),
      },
    };
  }
  return {
    url: TAVILY_URL,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key || ''}`,
      },
      body: JSON.stringify({ query: String(query), ...searchPlan('tavily', depth), ...extra }),
      ...(signal ? { signal } : {}),
    },
  };
}

/** A human message out of either provider's error envelope. */
export function providerError(label, status, body) {
  const err = body?.error;
  const msg =
    body?.detail?.error ||
    (typeof err === 'string' ? err : '') ||
    err?.detail ||
    err?.message ||
    body?.detail ||
    body?.message;
  return typeof msg === 'string' && msg ? msg : `${label} ${status}`;
}

/** Tavily's results → the shared hit shape. */
export function tavilyHits(body) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return {
    answer: body?.answer ? `Answer: ${body.answer}\n\n` : '',
    hits: results.slice(0, MAX_HITS).map((x) => ({
      title: x?.title || '(untitled)',
      url: x?.url || '',
      content: String(x?.content || ''),
      age: '',
    })),
  };
}

/**
 * Brave's grounding → the shared hit shape.
 *
 * A Brave source's `snippets` is an ARRAY of context chunks, so they are joined
 * into the one content blob Tavily would have produced. Brave has no `answer`
 * field on this endpoint (that is the separate Answers API, out of scope), so
 * there is no answer prefix.
 *
 * `sources[url].age` is a 4-position array — full date, YYYY-MM-DD, relative age,
 * ISO timestamp — and is emitted as a trailing `Updated:` line when present.
 * Tavily returns nothing comparable, so this line is Brave-only; it is additive
 * (the first three lines of every block remain identical across providers) and it
 * carries the single most useful fact a search result can for an LLM that has to
 * reason about recency.
 */
export function braveHits(body) {
  const generic = Array.isArray(body?.grounding?.generic) ? body.grounding.generic : [];
  const sources = body?.sources && typeof body.sources === 'object' ? body.sources : {};
  return {
    answer: '',
    hits: generic.slice(0, MAX_HITS).map((g) => {
      const url = String(g?.url || '');
      const src = sources[url] ?? {};
      const snippets = Array.isArray(g?.snippets)
        ? g.snippets.filter((s) => typeof s === 'string')
        : [];
      const age = Array.isArray(src?.age) ? String(src.age[2] ?? '') : '';
      return {
        title: g?.title || src?.title || '(untitled)',
        url,
        content: snippets.join('\n'),
        age,
      };
    }),
  };
}

/**
 * The final tool-result string, in the one shape both providers share.
 *
 * `clip` is injected because the relay owns the single definition of "bound this
 * for the model" (clipText). The local default is a byte-identical stand-in so
 * the module is usable (and assertable) on its own.
 */
export function formatSearchOutput(provider, body, opts = {}) {
  const perHit = Number.isFinite(opts.perHit) ? opts.perHit : DEFAULT_PER_HIT_CHARS;
  const total = Number.isFinite(opts.total) ? opts.total : DEFAULT_RESULT_CHARS;
  const clip = typeof opts.clip === 'function' ? opts.clip : defaultClip;
  const { answer, hits } =
    provider === 'brave' ? braveHits(body) : tavilyHits(body);
  const blocks = hits.map((h, i) => {
    const head = `${i + 1}. ${h.title}\n${h.url}\n${h.content.slice(0, perHit)}`;
    return h.age ? `${head}\nUpdated: ${h.age}` : head;
  });
  return clip(`${answer}${blocks.join('\n\n')}` || 'No results.', total);
}

/** Must stay identical to local-sse.mjs clipText(); the relay passes its own. */
function defaultClip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…[truncated]` : t;
}

/**
 * Run one web search and return the formatted result string.
 *
 * Throws on transport/HTTP failure — the CALLER decides how to report it, which
 * is how the relay keeps its "tool error: …" convention in one place.
 */
export async function searchWeb({
  provider,
  key,
  query,
  depth,
  freshness,
  now,
  signal,
  perHit,
  total,
  clip,
  fetchImpl,
}) {
  const doFetch = fetchImpl || fetch;
  const { url, init } = buildSearchRequest({
    provider,
    key,
    query,
    depth,
    freshness,
    now,
    signal: withTimeout(signal),
  });
  const res = await doFetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      providerError(provider === 'brave' ? 'Brave' : 'Tavily', res.status, body),
    );
  }
  return formatSearchOutput(provider, body, { perHit, total, clip });
}

/**
 * Combine the run's cancellation signal with a hard timeout. Both are worth
 * having: the run signal is "the wearer pressed stop", the timeout is "the search
 * provider has gone quiet" — and a hung provider must not hold a run open.
 */
export function withTimeout(signal) {
  const timeout =
    typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(SEARCH_TIMEOUT_MS) : null;
  if (!timeout) return signal || undefined;
  if (!signal) return timeout;
  if (typeof AbortSignal?.any === 'function') return AbortSignal.any([signal, timeout]);
  return signal;
}
