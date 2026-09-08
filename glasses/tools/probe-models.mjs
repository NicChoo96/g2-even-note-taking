// One-off: which free tool-capable OpenRouter models this account can actually call.
// Usage: node glasses/tools/probe-models.mjs   (reads web/.env.local)
import fs from 'fs';
import path from 'path';

const envPath = path.join(process.cwd(), 'web', '.env.local');
const env = fs.readFileSync(envPath, 'utf8');
const key = (env.match(/^OPENROUTER_API_KEY=(.*)$/m) || [])[1].trim().replace(/^["']|["']$/g, '');
if (!key) {
  console.error('no OPENROUTER_API_KEY in web/.env.local');
  process.exit(1);
}

const models = [
  'inclusionai/ling-3.0-flash-sante:free',
  'inclusionai/ling-3.0-flash-fin:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free',
  'poolside/laguna-s-2.1:free',
  'thinkingmachines/inkling:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

const out = [];
for (const m of models) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 5 }),
    });
    const j = await r.json();
    const ok = r.ok && j.choices;
    out.push((ok ? 'OK   ' : 'FAIL ') + m + (ok ? '' : ' | ' + String((j.error && j.error.message) || '').slice(0, 110)));
  } catch (e) {
    out.push('ERR  ' + m + ' | ' + e.message.slice(0, 90));
  }
}
fs.writeFileSync(path.join(process.cwd(), 'probe-result.txt'), out.join('\n') + '\n');
