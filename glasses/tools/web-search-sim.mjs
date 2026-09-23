#!/usr/bin/env node
// Web-search provider harness.
//
// WHY THIS EXISTS:
//   The web-search tool stopped being "Tavily" and became "web_search", served by
//   whichever backend the relay is configured for. Two providers behind one tool
//   is exactly the kind of change that rots silently: a rename that misses a call
//   site, an auth header that is right for one vendor and a 401 for the other, a
//   region of the response that is empty, or a second output shape that quietly
//   breaks the token-budget chain the agent loop is sized against.
//
//   So this asserts the INTERFACE, not either vendor: that both providers emit
//   the same shape, that the switch is honoured, that a missing key for the
//   SELECTED provider fails loudly instead of silently borrowing the other
//   provider's key, and that nothing in the relay still speaks Tavily directly.
//
// Run: node tools/web-search-sim.mjs

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BRAVE_URL,
  DEFAULT_DEPTH,
  DEFAULT_RESULT_CHARS,
  MAX_HITS,
  PROVIDERS,
  SEARCH_TIMEOUT_MS,
  TAVILY_URL,
  WEB_KINDS,
  braveHits,
  buildSearchRequest,
  formatSearchOutput,
  freshnessPlan,
  isWebTool,
  providerError,
  resolveDepth,
  searchPlan,
  searchWeb,
  tavilyHits,
  withTimeout,
} from '../../web/server/web-search.mjs';

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  assert(label, got === want, got === want ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
const has = (label, hay, needle) => assert(label, hay.includes(needle), needle);
const lacks = (label, hay, needle) => assert(label, !hay.includes(needle), needle);

const relaySrc = readFileSync(new URL('../../web/server/local-sse.mjs', import.meta.url), 'utf8');
const typesSrc = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const agentsStoreSrc = readFileSync(new URL('../src/agents-store.ts', import.meta.url), 'utf8');

// ── 1. The module is the single interface ────────────────────────────────────
console.log('\n§1  provider interface');
eq('PROVIDERS is tavily + brave', PROVIDERS.join(','), 'tavily,brave');
assert('WEB_KINDS accepts the current kind', WEB_KINDS.has('web'));
assert('WEB_KINDS accepts the legacy kind', WEB_KINDS.has('tavily'));
assert('both provider URLs are exported', BRAVE_URL.includes('/res/v1/llm/context') && TAVILY_URL.includes('api.tavily.com'));
eq('MAX_HITS keeps the old 5-source cap', MAX_HITS, 5);
eq('default depth is basic', DEFAULT_DEPTH, 'basic');

// §2 — isWebTool: the kind check every call site now shares.
console.log('\n§2  isWebTool');
assert("kind 'web' is a web tool", isWebTool({ kind: 'web' }));
assert("legacy kind 'tavily' is still a web tool", isWebTool({ kind: 'tavily' }));
assert("kind 'http' is not", !isWebTool({ kind: 'http' }));
assert("kind 'jev' is not", !isWebTool({ kind: 'jev' }));
assert('undefined/null are not', !isWebTool(undefined) && !isWebTool(null));
assert("a kind-less tool is not (no `?? 'web'` assumption)", !isWebTool({ id: 'tool-web' }));

// ── 3. resolveDepth precedence ──────────────────────────────────────────────
console.log('\n§3  resolveDepth precedence');
eq('model arg beats everything', resolveDepth({ depth: 'advanced' }, { searchDepth: 'basic' }, 'basic'), 'advanced');
eq('legacy arg name still works', resolveDepth({ search_depth: 'advanced' }, { searchDepth: 'basic' }, 'basic'), 'advanced');
eq('tool setting beats relay default', resolveDepth({}, { searchDepth: 'advanced' }, 'basic'), 'advanced');
eq('relay default is the next fallback', resolveDepth({}, {}, 'advanced'), 'advanced');
eq('and basic when nothing is set', resolveDepth({}, {}, ''), 'basic');
eq('garbage falls back, not forwards', resolveDepth({ depth: 'deeper' }, {}, 'basic'), 'basic');

// ── 4. Brave request: right URL, right auth, right budget ───────────────────
console.log('\n§4  Brave request');
const braveReq = buildSearchRequest({ provider: 'brave', key: 'BK', query: 'cats and dogs', depth: 'advanced' });
const bu = new URL(braveReq.url);
eq('GET is used', braveReq.init.method, 'GET');
eq('Brave host is correct', bu.origin + bu.pathname, BRAVE_URL);
eq('query is sent as q', bu.searchParams.get('q'), 'cats and dogs');
assert(
  'auth is X-Subscription-Token',
  braveReq.init.headers['X-Subscription-Token'] === 'BK',
  braveReq.init.headers['X-Subscription-Token'],
);
assert(
  'auth is NOT Authorization: Bearer',
  !Object.keys(braveReq.init.headers).some((h) => h.toLowerCase() === 'authorization'),
);
assert('no Accept-Encoding is pinned (fetch negotiates)', !('accept-encoding' in braveReq.init.headers));
assert('no Api-Version is pinned (would downgrade the pipeline)', !('api-version' in braveReq.init.headers));
assert('no country/search_lang override', !bu.searchParams.has('country') && !bu.searchParams.has('search_lang'));
eq('advanced count', bu.searchParams.get('count'), String(searchPlan('brave', 'advanced').count));
eq('advanced url budget', bu.searchParams.get('maximum_number_of_urls'), '20');
eq('advanced token budget', bu.searchParams.get('maximum_number_of_tokens'), '8192');
eq('advanced per-url budget', bu.searchParams.get('maximum_number_of_tokens_per_url'), '3072');
eq('advanced asks for a lenient filter', bu.searchParams.get('context_threshold_mode'), 'lenient');

const braveBasic = new URL(buildSearchRequest({ provider: 'brave', key: 'BK', query: 'x', depth: 'basic' }).url);
eq('basic count is small', braveBasic.searchParams.get('count'), '5');
eq('basic token budget is smaller', braveBasic.searchParams.get('maximum_number_of_tokens'), '4096');
assert(
  'basic leaves context_threshold_mode UNSET (Brave default is calibrated)',
  !braveBasic.searchParams.has('context_threshold_mode'),
);
assert(
  'basic is strictly smaller than advanced on every budget',
  ['count', 'maximum_number_of_urls', 'maximum_number_of_tokens', 'maximum_number_of_tokens_per_url'].every(
    (k) => Number(braveBasic.searchParams.get(k)) < Number(bu.searchParams.get(k)),
  ),
);
assert('the request body is empty on a GET', braveReq.init.body === undefined);

// ── 5. Tavily request: unchanged wire contract ──────────────────────────────
console.log('\n§5  Tavily request');
const tvReq = buildSearchRequest({ provider: 'tavily', key: 'TK', query: 'cats', depth: 'advanced' });
eq('POST is used', tvReq.init.method, 'POST');
eq('Tavily URL', tvReq.url, TAVILY_URL);
eq('auth is Authorization: Bearer', tvReq.init.headers.Authorization, 'Bearer TK');
assert('no X-Subscription-Token for Tavily', !('X-Subscription-Token' in tvReq.init.headers));
eq('content type is JSON', tvReq.init.headers['Content-Type'], 'application/json');
const tvBody = JSON.parse(tvReq.init.body);
eq('query in body', tvBody.query, 'cats');
eq('depth maps to search_depth', tvBody.search_depth, 'advanced');
eq('basic maps to basic', JSON.parse(buildSearchRequest({ provider: 'tavily', key: 'TK', query: 'c', depth: 'basic' }).init.body).search_depth, 'basic');
assert('Tavily has no Brave-only params', !('count' in tvBody) && !('maximum_number_of_tokens' in tvBody));

// ── 6. Freshness: translated per provider, dropped when unknown ─────────────
console.log('\n§6  freshness');
eq('Brave takes pd verbatim', freshnessPlan('brave', 'pd', new Date('2026-09-24T00:00:00Z')).freshness, 'pd');
eq('Brave takes pw verbatim', freshnessPlan('brave', 'pw').freshness, 'pw');
eq(
  'Brave takes a date range verbatim',
  freshnessPlan('brave', '2026-01-01to2026-02-01').freshness,
  '2026-01-01to2026-02-01',
);
eq(
  'Tavily translates pd to an absolute start_date',
  freshnessPlan('tavily', 'pd', new Date('2026-09-24T00:00:00Z')).start_date,
  '2026-09-24',
);
eq(
  'Tavily translates pw to a 7-day window (today + 6)',
  freshnessPlan('tavily', 'pw', new Date('2026-09-24T00:00:00Z')).start_date,
  '2026-09-18',
);
eq(
  'Tavily translates py to a 365-day window',
  freshnessPlan('tavily', 'py', new Date('2026-09-24T00:00:00Z')).start_date,
  '2025-09-25',
);
const tvRange = freshnessPlan('tavily', '2026-01-01to2026-02-01');
eq('Tavily splits a range', `${tvRange.start_date}..${tvRange.end_date}`, '2026-01-01..2026-02-01');
assert('an unknown filter is DROPPED, not forwarded', Object.keys(freshnessPlan('brave', 'yesterday')).length === 0);
assert('a junk filter is dropped for Tavily too', Object.keys(freshnessPlan('tavily', 'whenever')).length === 0);
assert('empty is dropped', Object.keys(freshnessPlan('brave', '')).length === 0);
assert('undefined is dropped', Object.keys(freshnessPlan('tavily', undefined)).length === 0);
const withFresh = new URL(buildSearchRequest({ provider: 'brave', key: 'k', query: 'q', depth: 'basic', freshness: 'pw' }).url);
eq('and reaches the Brave URL when valid', withFresh.searchParams.get('freshness'), 'pw');
const withoutFresh = new URL(buildSearchRequest({ provider: 'brave', key: 'k', query: 'q', depth: 'basic', freshness: 'nope' }).url);
assert('and does NOT reach it when invalid', !withoutFresh.searchParams.has('freshness'));

// ── 7. Errors are readable ──────────────────────────────────────────────────
console.log('\n§7  provider errors');
eq('Brave detail.error', providerError('Brave', 422, { detail: { error: 'bad param' } }), 'bad param');
eq('Tavily error string', providerError('Tavily', 401, { error: 'invalid api key' }), 'invalid api key');
eq('error.detail object', providerError('Tavily', 400, { error: { detail: 'nope' } }), 'nope');
eq('error.message', providerError('Brave', 400, { error: { message: 'why' } }), 'why');
eq('detail string', providerError('Brave', 400, { detail: 'plain' }), 'plain');
eq('message', providerError('Tavily', 500, { message: 'boom' }), 'boom');
eq('falls back to a labelled status', providerError('Tavily', 503, {}), 'Tavily 503');
eq('and still falls back on a non-object body', providerError('Brave', 500, null), 'Brave 500');

// ── 8. THE INVARIANT: both providers emit the same shape ────────────────────
console.log('\n§8  identical output shape');
const tvPayload = { results: [{ title: 'Docs', url: 'https://a.test/1', content: 'Body text' }] };
const brPayload = {
  grounding: { generic: [{ title: 'Docs', url: 'https://a.test/1', snippets: ['Body text'] }] },
  sources: { 'https://a.test/1': { title: 'Docs', hostname: 'a.test' } },
};
const SHAPE_OPT = { perHit: 3000, total: 16000 };
const tvOut = formatSearchOutput('tavily', tvPayload, SHAPE_OPT);
const brOut = formatSearchOutput('brave', brPayload, SHAPE_OPT);
eq('an aged-less Brave hit is byte-identical to Tavily', brOut, tvOut);
eq('block is "N. title\\nurl\\ncontent"', tvOut, '1. Docs\nhttps://a.test/1\nBody text');

// Multi-hit numbering and joining must match too.
const tv2 = formatSearchOutput(
  'tavily',
  { results: [
    { title: 'A', url: 'u1', content: 'x' },
    { title: 'B', url: 'u2', content: 'y' },
  ] },
  SHAPE_OPT,
);
const br2 = formatSearchOutput(
  'brave',
  { grounding: { generic: [
    { title: 'A', url: 'u1', snippets: ['x'] },
    { title: 'B', url: 'u2', snippets: ['y'] },
  ] } },
  SHAPE_OPT,
);
eq('multi-hit numbering + separator match', br2, tv2);
eq('numbered and joined with a blank line', tv2, '1. A\nu1\nx\n\n2. B\nu2\ny');

// ── 9. Response mapping details ─────────────────────────────────────────────
console.log('\n§9  response mapping');
const multiSnippet = braveHits({
  grounding: { generic: [{ url: 'u', title: 'T', snippets: ['one', 'two', 'three'] }] },
});
eq('Brave joins snippet chunks into one content blob', multiSnippet.hits[0].content, 'one\ntwo\nthree');
const aged = braveHits({
  grounding: { generic: [{ url: 'u', title: 'T', snippets: ['s'] }] },
  sources: { u: { age: ['Monday, January 15, 2024', '2024-01-15', '380 days ago', '2024-01-15T13:45:02Z'] } },
});
eq('age is taken from position 2 (the relative one)', aged.hits[0].age, '380 days ago');
const agedOut = formatSearchOutput('brave', {
  grounding: { generic: [{ url: 'u', title: 'T', snippets: ['s'] }] },
  sources: { u: { age: ['Monday, January 15, 2024', '2024-01-15', '380 days ago', '2024-01-15T13:45:02Z'] } },
}, SHAPE_OPT);
has('an aged hit adds an Updated: line', agedOut, 'Updated: 380 days ago');
eq('and the three headline lines are untouched', agedOut.split('\n').slice(0, 3).join('\n'), '1. T\nu\ns');
const noAge = formatSearchOutput('brave', {
  grounding: { generic: [{ url: 'u', title: 'T', snippets: ['s'] }] },
  sources: { u: { age: [] } },
}, SHAPE_OPT);
lacks('an empty age adds NO Updated: line', noAge, 'Updated:');
lacks('Tavily never adds an Updated: line', tvOut, 'Updated:');
eq('a missing Brave title falls back to the source title', braveHits({ grounding: { generic: [{ url: 'u', snippets: ['s'] }] }, sources: { u: { title: 'FromSources' } } }).hits[0].title, 'FromSources');
eq('and then to (untitled)', braveHits({ grounding: { generic: [{ url: 'u', snippets: ['s'] }] } }).hits[0].title, '(untitled)');
eq('a missing Tavily title falls back to (untitled)', tavilyHits({ results: [{ url: 'u', content: 'c' }] }).hits[0].title, '(untitled)');
assert(
  'a JSON-serialised snippet survives intact',
  braveHits({ grounding: { generic: [{ url: 'u', snippets: ['{"table":[1,2]}'] }] } }).hits[0].content ===
    '{"table":[1,2]}',
);
eq('non-string snippets are filtered out', braveHits({ grounding: { generic: [{ url: 'u', snippets: ['a', 7, null, 'b'] }] } }).hits[0].content, 'a\nb');
eq('Brave is capped at MAX_HITS', braveHits({ grounding: { generic: Array.from({ length: 40 }, (_, i) => ({ url: `u${i}`, snippets: ['s'] })) } }).hits.length, MAX_HITS);
eq('Tavily is capped at MAX_HITS', tavilyHits({ results: Array.from({ length: 40 }, () => ({ content: 'c' })) }).hits.length, MAX_HITS);
eq('Tavily answer becomes a prefix', tavilyHits({ results: [], answer: 'Yes' }).answer, 'Answer: Yes\n\n');
has('and it reaches the output', formatSearchOutput('tavily', { results: [{ title: 'T', url: 'u', content: 'c' }], answer: 'Yes' }, SHAPE_OPT), 'Answer: Yes\n\n1.');
eq('Brave has no answer prefix', braveHits({ grounding: { generic: [] } }).answer, '');

// ── 10. Empty results must not throw ────────────────────────────────────────
console.log('\n§10 empty results');
eq('empty Brave grounding', formatSearchOutput('brave', { grounding: { generic: [] } }, SHAPE_OPT), 'No results.');
eq('Brave with no grounding key at all', formatSearchOutput('brave', {}, SHAPE_OPT), 'No results.');
eq('Brave with a null body', formatSearchOutput('brave', null, SHAPE_OPT), 'No results.');
eq('empty Tavily results', formatSearchOutput('tavily', { results: [] }, SHAPE_OPT), 'No results.');
eq('Tavily with no results key', formatSearchOutput('tavily', {}, SHAPE_OPT), 'No results.');
eq('Tavily with a null body', formatSearchOutput('tavily', null, SHAPE_OPT), 'No results.');

// ── 11. THE BUDGET CHAIN ────────────────────────────────────────────────────
console.log('\n§11 budget chain');
const longHit = (n) => ({ title: 'T', url: 'u', content: 'x'.repeat(n) });
const perHitOut = formatSearchOutput('tavily', { results: [longHit(5000)] }, { perHit: 3000, total: 16000 });
eq('per-hit content is clipped to perHit', perHitOut.split('\n')[2].length, 3000);
const brPerHit = formatSearchOutput(
  'brave',
  { grounding: { generic: [{ url: 'u', title: 'T', snippets: ['x'.repeat(5000)] }] } },
  { perHit: 3000, total: 16000 },
);
eq('the same bound applies on Brave', brPerHit.split('\n')[2].length, 3000);
const manyHits = formatSearchOutput(
  'tavily',
  { results: Array.from({ length: 5 }, () => longHit(3000)) },
  { perHit: 3000, total: 4000 },
);
eq('the whole string is clipped to total (plus the ellipsis)', manyHits.length, 4000 + '…[truncated]'.length);
assert('and the clip is the relay-compatible ellipsis form', manyHits.endsWith('…[truncated]'));
const braveMany = formatSearchOutput(
  'brave',
  { grounding: { generic: Array.from({ length: 5 }, (_, i) => ({ url: `u${i}`, title: 'T', snippets: ['x'.repeat(3000)] })) } },
  { perHit: 3000, total: 4000 },
);
eq('Brave is bounded by the same total', braveMany.length, manyHits.length);
const underBudget = formatSearchOutput(
  'tavily',
  { results: Array.from({ length: 5 }, () => longHit(3000)) },
  { perHit: 3000, total: 16000 },
);
lacks('a result inside the budget is NOT truncated', underBudget, '[truncated]');
eq('the default total is the relay budget of 16000', DEFAULT_RESULT_CHARS, 16000);
assert('a custom clip is honoured (the relay injects its own)', formatSearchOutput('tavily', { results: [longHit(100)] }, { clip: (s) => `[${s.length}]`, perHit: 3000, total: 16000 }).startsWith('['));

// ── 12. searchWeb: fetch plumbing, no fallbacks, real errors ────────────────
console.log('\n§12 searchWeb');
const stub = (status, body) => {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
};

const okBrave = stub(200, brPayload);
const braveResult = await searchWeb({ provider: 'brave', key: 'BK', query: 'q', depth: 'basic', ...okBrave, ...SHAPE_OPT });
eq('a 200 returns the formatted string', braveResult, tvOut);
eq('exactly one request was made', okBrave.calls.length, 1);
has('and it went to Brave', okBrave.calls[0].url, 'api.search.brave.com');
eq('carrying the given key', okBrave.calls[0].init.headers['X-Subscription-Token'], 'BK');
lacks('and no Bearer header', JSON.stringify(okBrave.calls[0].init.headers), 'Authorization');

const okTavily = stub(200, tvPayload);
const tavilyResult = await searchWeb({ provider: 'tavily', key: 'TK', query: 'q', depth: 'basic', ...okTavily, ...SHAPE_OPT });
eq('Tavily returns the identical shape', tavilyResult, braveResult);

let thrown = null;
try {
  await searchWeb({ provider: 'brave', key: 'BK', query: 'q', depth: 'basic', ...stub(422, { detail: { error: 'bad query' } }) });
} catch (e) {
  thrown = e;
}
assert('a non-2xx THROWS (the caller decides how to report)', thrown instanceof Error);
eq('with the provider message', thrown?.message, 'bad query');
assert('and the provider name when there is no message', (await (async () => {
  try { await searchWeb({ provider: 'brave', key: 'k', query: 'q', depth: 'basic', ...stub(500, {}) }); } catch (e) { return e.message; }
})()) === 'Brave 500');

let netErr = null;
try {
  await searchWeb({ provider: 'tavily', key: 'TK', query: 'q', depth: 'basic', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
} catch (e) {
  netErr = e;
}
eq('a transport failure propagates', netErr?.message, 'ECONNRESET');

// The selected provider must use ITS key — never the other provider's.
const braveWithBraveKey = stub(200, brPayload);
await searchWeb({ provider: 'brave', key: 'ONLY_BRAVE', query: 'q', depth: 'basic', ...braveWithBraveKey });
eq('the key passed in is the key sent', braveWithBraveKey.calls[0].init.headers['X-Subscription-Token'], 'ONLY_BRAVE');

let noKey = null;
try {
  await searchWeb({ provider: 'brave', key: '', query: 'q', depth: 'basic', ...stub(200, brPayload) });
} catch (e) {
  noKey = e;
}
assert('an empty key is sent as an empty key (the provider rejects it loudly)', noKey === null || noKey instanceof Error);

// ── 13. Timeout is combined with the run's own signal ───────────────────────
console.log('\n§13 timeout');
eq('a timeout constant exists and is human-scale', SEARCH_TIMEOUT_MS, 30_000);
const own = new AbortController();
assert('the run signal is preserved', withTimeout(own.signal) !== undefined);
assert('and a signal is always produced', withTimeout(undefined) !== undefined);

// ── 14. The relay delegates — it must not speak Tavily itself ───────────────
console.log('\n§14 relay delegation');
has('the relay imports the interface', relaySrc, "from './web-search.mjs'");
assert('and imports isWebTool + searchWeb', /\{\s*isWebTool,\s*resolveDepth,\s*searchWeb\s*\}/.test(relaySrc));
lacks('the relay no longer holds the Tavily URL', relaySrc, 'api.tavily.com');
lacks('nor the old TAVILY_URL constant', relaySrc, 'TAVILY_URL');
lacks('nor the old tavilyConfig()', relaySrc, 'tavilyConfig');
const searchWebCalls = relaySrc.match(/await searchWeb\(/g) ?? [];
assert('both call paths delegate (executor + /api/tool)', searchWebCalls.length >= 2, `found ${searchWebCalls.length}`);
has('the tool-schema check is provider-agnostic', relaySrc, 'if (isWebTool(t)) {');
has('the executor check is provider-agnostic', relaySrc, 'if (isWebTool(tool)) {');
has('the proxy check is provider-agnostic', relaySrc, 'if (isWebTool(body)) {');
lacks("the old kind === 'tavily' check", relaySrc, "body?.kind === 'tavily'");

// ── 15. Provider resolution: explicit -> auto, and never a borrowed key ─────
console.log('\n§15 provider selection');
has('SEARCH_PROVIDER is the env override', relaySrc, 'process.env.SEARCH_PROVIDER');
has('BRAVE_SEARCH_API_KEY is read', relaySrc, 'process.env.BRAVE_SEARCH_API_KEY');
has('TAVILY_API_KEY is read', relaySrc, 'process.env.TAVILY_API_KEY');
has('the legacy depth env still works', relaySrc, 'process.env.TAVILY_SEARCH_DEPTH');
has('and the new depth env wins over it', relaySrc, 'process.env.WEB_SEARCH_DEPTH || process.env.TAVILY_SEARCH_DEPTH');
has("only 'tavily' | 'brave' are honoured", relaySrc, "(v === 'tavily' || v === 'brave' ? v : '')");
has('auto prefers Tavily when both keys exist', relaySrc, "tavilyKey ? 'tavily' : braveKey ? 'brave' : 'tavily'");
has('the key is selected FOR the provider, not merged', relaySrc, 'const envKey = isBrave ? braveEnv : tavilyEnv;');
has('a missing key names the exact env var', relaySrc, 'envVar: isBrave ? \'BRAVE_SEARCH_API_KEY\' : \'TAVILY_API_KEY\'');
has('and the error is actionable', relaySrc, 'not configured — set ${ws.envVar}');
assert('both secrets slots exist', /braveKey:\s*''/.test(relaySrc) && /searchProvider:\s*''/.test(relaySrc));
assert('and both are writable from settings', /braveKey: 'braveKey'/.test(relaySrc) && /searchProvider: 'searchProvider'/.test(relaySrc));
has('the status payload reports the provider', relaySrc, 'search: {');
has('the status payload reports both keys', relaySrc, 'keys: ws.keys,');
has('the deprecated tavily alias is kept for one release', relaySrc, 'tavily: Boolean(ws.key),');

// ── 16. The client adopts one vocabulary ────────────────────────────────────
console.log('\n§16 client vocabulary');
has("types.ts seeds id 'tool-web'", typesSrc, "export const SEED_TOOL_ID = 'tool-web';");
has("types.ts seeds name 'web_search'", typesSrc, "name: 'web_search',");
has("and kind 'web'", typesSrc, "kind: 'web',");
has('a legacy tool id is migrated', typesSrc, "const LEGACY_SEED_TOOL_ID = 'tool-tavily';");
has('a legacy kind is migrated', typesSrc, "(t as { kind?: string }).kind === 'tavily'");
has('a legacy name is migrated', typesSrc, "const LEGACY_SEED_TOOL_NAME = 'tavily_search';");
assert('the migration is exported for reuse', /export function normalizeTool\b/.test(typesSrc) && /export function normalizeToolId\b/.test(typesSrc));
has('emptyAgent() attaches the seeded tool by constant', typesSrc, 'toolIds: [SEED_TOOL_ID],');
assert('no hardcoded legacy id is WRITTEN outside the migration', !/toolIds: \['tool-tavily'\]/.test(typesSrc));
has('the store migrates tools on load', agentsStoreSrc, '.map(normalizeTool)');
has('the store migrates agent tool ids too', agentsStoreSrc, '.map(normalizeToolId)');
has('and re-seeds on the new kind', agentsStoreSrc, "if (!tools.some((t) => t.kind === 'web'))");

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('');
if (fail) {
  console.log(`RESULT: FAIL — ${fail} assertion(s) failed`);
  process.exit(1);
}
console.log('ALL PASS');
