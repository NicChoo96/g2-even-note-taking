// One-off: probe the web-search keys — which one is live, and does it work?
//
// Usage: node glasses/tools/probe-search.mjs        (reads web/.env.local)
//        node glasses/tools/probe-search.mjs brave  (only Brave)
//        node glasses/tools/probe-search.mjs tavily (only Tavily)
//
// This replaced `probe-tavily.mjs`, which only knew one vendor. Two things are
// worth probing and only one of them is "is the key valid":
//
//   1. WHICH PROVIDER THE RELAY WOULD PICK. That resolution has three inputs
//      (SEARCH_PROVIDER, the saved setting, which keys exist) and a wrong answer
//      looks exactly like a working one until the bill arrives.
//   2. Whether the REQUEST WE ACTUALLY BUILD is accepted. The Tavily auth-shape
//      matrix stays because the wrong header is a silent 401 — and Brave is
//      probed through `buildSearchRequest` so the probe exercises the real path
//      rather than a hand-copied approximation of it.
//
// Writes the report to stdout and to `search-probe.txt`.

import fs from 'fs';
import path from 'path';

const want = (process.argv[2] || '').toLowerCase();
const root = process.cwd();
const out = [];

const readEnv = () => {
  try {
    return fs.readFileSync(path.join(root, 'web', '.env.local'), 'utf8');
  } catch {
    return '';
  }
};
const readSecrets = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'web', '.g2-hub-secrets.json'), 'utf8'));
  } catch {
    return {};
  }
};
const env = readEnv();
const secrets = readSecrets();
// Trailing inline comments and surrounding quotes are both easy to leave behind.
const fromEnv = (name) => {
  const raw = (env.match(new RegExp(`^${name}=(.*)$`, 'm')) || [])[1] || '';
  return raw.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
};
const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)` : '(not set)');

const envTavily = fromEnv('TAVILY_API_KEY');
const envBrave = fromEnv('BRAVE_SEARCH_API_KEY');
const envProvider = fromEnv('SEARCH_PROVIDER').toLowerCase();
const fileTavily = String(secrets.tavilyKey || '');
const fileBrave = String(secrets.braveKey || '');
const fileProvider = String(secrets.searchProvider || '').toLowerCase();

// Mirror the relay's precedence exactly: env -> saved file -> auto (Tavily first).
const tavilyKey = envTavily || fileTavily;
const braveKey = envBrave || fileBrave;
const declared = (envProvider === 'tavily' || envProvider === 'brave' ? envProvider : '') ||
  (fileProvider === 'tavily' || fileProvider === 'brave' ? fileProvider : '');
const provider = declared || (tavilyKey ? 'tavily' : braveKey ? 'brave' : 'tavily');
const key = provider === 'brave' ? braveKey : tavilyKey;

out.push('── keys ──');
out.push(`TAVILY_API_KEY          ${mask(tavilyKey)}${envTavily ? '  [env]' : fileTavily ? '  [saved]' : ''}`);
out.push(`BRAVE_SEARCH_API_KEY    ${mask(braveKey)}${envBrave ? '  [env]' : fileBrave ? '  [saved]' : ''}`);
out.push('');
out.push('── resolution ──');
out.push(`SEARCH_PROVIDER         ${envProvider || '(unset)'}${fileProvider ? `   saved: ${fileProvider}` : ''}`);
out.push(`=> provider             ${provider}${declared ? ' (declared)' : ' (auto)'}`);
out.push(`=> key                  ${mask(key)}`);
if (!key) {
  out.push('');
  out.push(`!! ${provider} is selected but has NO key. The relay will refuse rather than`);
  out.push(`   borrow the other one — set ${provider === 'brave' ? 'BRAVE_SEARCH_API_KEY' : 'TAVILY_API_KEY'} in web/.env.local.`);
}

if (key && (!want || want === 'tavily') && (provider === 'tavily')) {
  out.push('');
  out.push('── Tavily auth shapes (the wrong header is a silent 401) ──');
  const shapes = [
    ['A) apiKey in body (legacy)', { 'Content-Type': 'application/json' }, { apiKey: key, query: 'AI news', search_depth: 'basic' }],
    ['B) Authorization: Bearer (current docs)', { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, { query: 'AI news', search_depth: 'basic' }],
    ['C) api_key in body', { 'Content-Type': 'application/json' }, { api_key: key, query: 'AI news', search_depth: 'basic' }],
  ];
  for (const [label, headers, body] of shapes) {
    try {
      const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers, body: JSON.stringify(body) });
      const t = await r.text();
      out.push(`${label}\n  status ${r.status}\n  ${t.slice(0, 200).replace(/\s+/g, ' ')}`);
    } catch (e) {
      out.push(`${label}\n  ERR ${e.message}`);
    }
  }
}

if (braveKey && (!want || want === 'brave')) {
  out.push('');
  out.push('── Brave, built by the module the relay actually uses ──');
  try {
    const { buildSearchRequest, braveHits, formatSearchOutput, TAVILY_URL, BRAVE_URL } = await import('../../web/server/web-search.mjs');
    const { url, init } = buildSearchRequest({ provider: 'brave', key: braveKey, query: 'AI news', depth: 'basic' });
    out.push(`GET ${url.replace(BRAVE_URL, '')}`);
    out.push(`  headers: ${Object.keys(init.headers).join(', ')}`);
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => null);
    out.push(`  status ${r.status}`);
    if (r.ok && j) {
      const { hits } = braveHits(j);
      out.push(`  hits ${hits.length}`);
      for (const h of hits.slice(0, 3)) out.push(`    - ${h.title}  ${h.url}${h.age ? `  (${h.age})` : ''}`);
      out.push(`  rendered ${formatSearchOutput('brave', j, { perHit: 3000, total: 16000 }).length} chars`);
    } else {
      out.push(`  ${JSON.stringify(j).slice(0, 300)}`);
    }
    out.push(`  (Tavily endpoint for reference: ${TAVILY_URL})`);
  } catch (e) {
    out.push(`  ERR ${e.message}`);
  }
}

const report = out.join('\n') + '\n';
console.log(report);
fs.writeFileSync(path.join(root, 'search-probe.txt'), report);
