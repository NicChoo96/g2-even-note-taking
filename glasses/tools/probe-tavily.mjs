// One-off: probe the Tavily key with each auth shape Tavily documents.
// Usage: node glasses/tools/probe-tavily.mjs   (reads web/.env.local)
import fs from 'fs';
import path from 'path';

const env = fs.readFileSync(path.join(process.cwd(), 'web', '.env.local'), 'utf8');
const key = (env.match(/^TAVILY_API_KEY=(.*)$/m) || [])[1].trim().replace(/^["']|["']$/g, '');

const out = [];
async function probe(label, init) {
  try {
    const r = await fetch('https://api.tavily.com/search', init);
    const t = await r.text();
    out.push(`${label}\n  status ${r.status}\n  ${t.slice(0, 240).replace(/\s+/g, ' ')}`);
  } catch (e) {
    out.push(`${label}\n  ERR ${e.message}`);
  }
}

// 1) legacy: apiKey in the JSON body
await probe('A) apiKey in body', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey: key, query: 'AI news', search_depth: 'basic' }),
});

// 2) current docs: Authorization: Bearer
await probe('B) Authorization: Bearer', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ query: 'AI news', search_depth: 'basic' }),
});

// 3) snake_case api_key in body
await probe('C) api_key in body', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ api_key: key, query: 'AI news', search_depth: 'basic' }),
});

fs.writeFileSync(path.join(process.cwd(), 'tavily-probe.txt'), out.join('\n\n') + '\n');
