// One-off: is the Jev Decisions endpoint actually reachable with this key?
// Usage: node glasses/tools/probe-jev.mjs   (reads web/.env.local, run from repo root)
//
// The Decisions API is an ALPHA endpoint (~typesafe/jev-latest) and this account
// may not have it provisioned, so the whole integration is gated on this probe.
// Prints the HTTP status and the raw response; never prints the key.
import fs from 'fs';
import path from 'path';

const envPath = path.join(process.cwd(), 'web', '.env.local');
const env = fs.readFileSync(envPath, 'utf8');
const key = (env.match(/^OPENROUTER_API_KEY=(.*)$/m) || [])[1]
  .trim()
  .replace(/^["']|["']$/g, '');
if (!key) {
  console.error('no OPENROUTER_API_KEY in web/.env.local');
  process.exit(1);
}
const referer = (env.match(/^OPENROUTER_REFERER=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || '';
const title = (env.match(/^OPENROUTER_TITLE=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || '';

const body = {
  model: '~typesafe/jev-latest',
  state: 'Help! My payouts have been failing for 3 days.',
  questions: {
    is_urgent: {
      type: 'noul',
      instructions: 'Does this message convey urgency?',
      criteria: { true: 'Explicitly time-sensitive', false: 'No urgency expressed' },
    },
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: {
        billing: 'Payments, invoicing, refunds',
        technical: 'Bugs, outages, integrations',
        sales: 'Pricing, upgrades, new accounts',
      },
    },
    frustration: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      criteria: ['Calm', 'Frustrated', 'Very angry'],
    },
  },
};

const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
if (referer) headers['HTTP-Referer'] = referer;
if (title) headers['X-OpenRouter-Title'] = title;

try {
  const r = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log('STATUS', r.status, r.statusText);
  console.log('--- raw body ---');
  console.log(text.slice(0, 4000));
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (parsed) {
    console.log('--- parsed keys ---');
    console.log(JSON.stringify(Object.keys(parsed)));
    console.log('--- answers ---');
    console.log(JSON.stringify(parsed.answers ?? parsed, null, 2).slice(0, 4000));
  }
} catch (e) {
  console.log('FETCH ERROR', e && e.message);
}

process.exit(0);
