// List (and with `--purge`, remove) documents a probe run left behind.
//
// Each probe asserts its own cleanup, but a probe that FAILED before its cleanup
// could not run leaves a row behind — and a stale `probe doc …` in the hub makes
// every later run's document count meaningless. Run this before trusting a
// probe's "before N, after N" line, and after a probe run that failed.
//
// Usage:  node tools/probe-leaks.mjs [--purge] [relayBase]
const PURGE = process.argv.includes('--purge');
const RELAY = (process.argv.find((a) => a.startsWith('http')) || 'http://localhost:5198').replace(/\/+$/, '');
const TOKEN = process.env.PROBE_OWNER_TOKEN || 'devownerecb53dde7bf41d07';

async function req(method, path, body) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${TOKEN}`,
    // No keep-alive: with an idle pooled socket still open, a plain `process.exit`
    // below asserts inside libuv on Node 26/Windows. Closing each socket lets the
    // loop drain on its own, so the exit code is the real verdict and not noise.
    Connection: 'close',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${RELAY}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

const listed = await req('GET', '/api/hub/docs');
const items = JSON.parse(listed.text).items ?? [];
const leaks = items.filter((d) => /^probe doc |^del probe /.test(d.title));

console.log(`${items.length} document(s); ${leaks.length} left by a probe run`);
for (const d of leaks) console.log(`  ${d.title}  (${d.id})`);

// Only `--purge` deletes; the scan on its own stops after the listing above.
const toPurge = PURGE ? leaks : [];

// One rev read, then one delete each: every delete moves the rev, so the next
// one has to read it again.
for (const d of toPurge) {
  const fresh = await req('GET', '/api/hub/docs');
  const out = await req('DELETE', `/api/hub/docs/${d.id}`, { rev: JSON.parse(fresh.text).rev });
  console.log(`  DELETE ${d.id} -> ${out.status}`);
}

const after = toPurge.length
  ? JSON.parse((await req('GET', '/api/hub/docs')).text).items ?? []
  : items;
const left = after.filter((d) => /^probe doc |^del probe /.test(d.title));
if (toPurge.length) console.log(`${after.length} document(s) remain; ${left.length} probe leak(s)`);

// `process.exit` here asserts inside libuv while the last response's socket is
// closing, and the crash's exit code (9) would be mistaken for a leak finding.
// The verdict rides on `process.exitCode` and the loop is left to drain.
process.exitCode = left.length === 0 ? 0 : 1;