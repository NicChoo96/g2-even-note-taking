// Does the relay see the WHOLE hub, or a truncated view?
//
// The write-through diffs the state it read against the state the reducer
// produced. If the read is truncated — a short `notes` blob, a doc whose body
// came back empty because the bundle hit a size cap — then the diff sees a
// change that is not real and the "fix" rewrites the wearer's document with a
// shorter one. That is a destructive bug in the fix itself, so the read has to
// be measured rather than assumed.
//
// Usage:  node tools/probe-hub-view.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function envOf(file) {
  const out = {};
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...envOf(resolve(here, '../../web/.env.local')), ...process.env };
const BASE = (env.JARVIS_FILE_URL || '').replace(/\/+$/, '');

let failed = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.JARVIS_FILE_USER, password: env.JARVIS_FILE_PWD }),
});
const TOKEN = (await login.json()).access_token;
if (!TOKEN) {
  console.error('probe: login failed');
  process.exit(2);
}

async function get(path, raw = false) {
  const r = await fetch(`${BASE}/hub${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: r.status, body, bytes: text.length, raw };
}

console.log('probe: hub view completeness');
console.log('');

const hub = await get('/');
check(hub.status === 200, `GET /hub -> ${hub.status}`);
check(hub.body?.truncated !== true, 'the hub bundle is NOT flagged truncated', `truncated=${hub.body?.truncated}`);

const sections = hub.body?.hub?.sections ?? {};
const docs = Array.isArray(sections.docs) ? sections.docs : [];
console.log(`      bundle: ${hub.bytes} bytes, ${(sections.todo ?? []).length} todos, ${docs.length} docs, notes=${(sections.notes ?? '').length} chars`);

// Every doc body from the bundle must equal the body from its own route.
let mismatched = [];
let missing = [];
for (const d of docs) {
  const one = await get(`/docs/${encodeURIComponent(d.id)}`);
  const real = one.body?.doc?.content;
  if (typeof real !== 'string') {
    missing.push(d.id);
    continue;
  }
  if ((d.content ?? '') !== real) {
    mismatched.push(`${d.title || d.id}: bundle ${(d.content ?? '').length} vs route ${real.length}`);
  }
}
check(missing.length === 0, 'every doc resolves from its own route', missing.join(', ') || `checked ${docs.length}`);
check(
  mismatched.length === 0,
  'every bundled doc body is COMPLETE — a diff on it is safe',
  mismatched.length ? mismatched.join('\n      ') : `checked ${docs.length} docs, all identical`,
);

const notes = await get('/notes');
check(
  (sections.notes ?? '') === (notes.body?.content ?? ''),
  'the bundled notes equal GET /notes',
  `bundle ${(sections.notes ?? '').length} vs route ${(notes.body?.content ?? '').length}`,
);

const todos = await get('/todos');
const items = Array.isArray(todos.body?.items) ? todos.body.items : [];
check(
  items.length === (sections.todo ?? []).length &&
    items.every((it, i) => it.id === sections.todo[i]?.id && it.done === sections.todo[i]?.done && it.text === sections.todo[i]?.text),
  'the bundled todos equal GET /todos, in the same ORDER',
  `bundle ${(sections.todo ?? []).length} vs route ${items.length}`,
);
check(typeof hub.body?.rev === 'number', `the bundle carries a rev (${hub.body?.rev})`);

console.log('');
console.log(failed === 0 ? 'RESULT: PASS — the relay can see the whole hub, so a diff is safe' : `RESULT: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
