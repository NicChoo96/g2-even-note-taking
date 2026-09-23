// One-off probe: exercises POST /api/decisions against a RUNNING relay.
//
// WHY THIS EXISTS
//   The route was written and unit-checked before it was ever called over HTTP.
//   A tested spec module proves nothing about the wiring around it — auth, the
//   body limit, the "validate before spending a call" ordering, and the final
//   JSON envelope all live outside the spec's reach.
//
// Never prints a credential: the session token is read from the relay's auth
// store and only ever placed in a header.
//
// Usage: node tools/probe-decisions.mjs [baseUrl]      (default :5198)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = (process.argv[2] || 'http://127.0.0.1:5198').replace(/\/$/, '');
const AUTH = resolve('..', 'web', '.g2-hub-auth.json');

/** The newest unexpired owner session token, or '' — never logged. */
function ownerToken() {
  let store;
  try {
    store = JSON.parse(readFileSync(AUTH, 'utf8'));
  } catch (err) {
    console.log(`  (no auth store: ${err.message})`);
    return '';
  }
  const sessions = store.sessions || {};
  const best = Object.keys(sessions)
    .map((t) => ({ t, at: sessions[t].createdAt || 0 }))
    .sort((a, b) => b.at - a.at)[0];
  if (!best) {
    console.log('  (auth store has no sessions)');
    return '';
  }
  console.log(`  (owner session found, age ${((Date.now() - best.at) / 864e5).toFixed(1)}d)`);
  return best.t;
}

const STATE =
  'Customer email: "Third time I have been charged for the same order. ' +
  'This is unacceptable, I want a refund today."';

const QUESTIONS = {
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
};

async function post(label, body, token, raw = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE}/api/decisions`, {
      method: 'POST',
      headers,
      body: raw ? body : JSON.stringify(body),
    });
  } catch (err) {
    console.log(`\n[${label}] TRANSPORT FAILED: ${err.message}`);
    return null;
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 200);
  }
  console.log(`\n[${label}] HTTP ${res.status}`);
  console.log(JSON.stringify(parsed, null, 2).slice(0, 1400));
  return { status: res.status, body: parsed };
}

const token = ownerToken();

const checks = [];
const expect = (label, got, want) => {
  const ok = got === want;
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${got}, want ${want})`);
};

// 1. no credential → refused, and refused BEFORE anything upstream.
const anon = await post('no token', { state: STATE, questions: QUESTIONS }, '');
expect('an anonymous call is refused', anon?.status, 401);

// 2. a malformed spec → 400 that names the field, and no upstream call.
const bad = await post('bad spec', { state: STATE, questions: { x: { type: 'nope' } } }, token);
expect('a malformed spec is a 400', bad?.status, 400);
expect('the 400 names the offending field', bad?.body?.field, 'questions.x.type');

// 3. not JSON at all → 400 from the body reader.
const junk = await post('not json', '{not json', token, true);
expect('unparseable JSON is a 400', junk?.status, 400);

// 4. an oversized body → 400 from the body limit, before parsing.
const huge = await post('oversized', { state: 'x'.repeat(70 * 1024), questions: QUESTIONS }, token);
expect('an oversized body is a 400', huge?.status, 400);

// 5. the real thing.
const ok = await post('valid spec', { state: STATE, questions: QUESTIONS }, token);
if (ok?.status === 501) {
  console.log('\n  → 501: no OpenRouter key. Add OPENROUTER_API_KEY to web/.env.local.');
} else {
  expect('a valid spec succeeds', ok?.status, 200);
  expect('the envelope is {ok:true}', ok?.body?.ok, true);
  const ans = ok?.body?.answers || {};
  expect('a noul answer carries a probability', typeof ans.is_urgent?.value, 'number');
  expect('a choice answer names a declared label', ans.department?.choice, 'billing');
  // THE TRAP: score is 0-based and continuous, so the label must not be the
  // first step merely because the value is small.
  expect('a score answer names a label', typeof ans.frustration?.label, 'string');
  expect('the score label is not the floor by default', ans.frustration?.label !== 'Calm' || ans.frustration?.score === 0, true);

  // Render it the way the capability does, so the probe also proves an outside
  // caller can import the shared formatter.
  const spec = await import(pathToFileURL(resolve('..', 'web', 'server', 'jev-spec.mjs')).href);
  console.log('\n  ── what the glasses would show (first line is the summary) ──');
  for (const line of spec.describeAnswers(ans).split('\n')) console.log(`  ${line}`);
  console.log(`  ── usage: ${JSON.stringify(ok?.body?.usage || {})} via ${ok?.body?.model}`);
}

console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
