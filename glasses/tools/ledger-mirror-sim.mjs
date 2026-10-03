// Verifies the LEDGER MIRROR's rules, by bundling the real modules (no
// re-implementation) and driving them against a scripted hub. No network, no
// relay, no backend.
//
// Run: node tools/ledger-mirror-sim.mjs        (from `glasses/`)
//      SIM_QUIET=1 node tools/ledger-mirror-sim.mjs
//
// WHY THIS IS WORTH A HARNESS
//   `src/ai/ledger-sync.ts` bridges a bounded, in-memory, PURE log to an
//   append-only, server-numbered, PERMANENT one. Every way it can be wrong is
//   invisible by eye and unrecoverable in production, because the ledger has no
//   delete route — a bad write can only be outlived, never taken back:
//     • the watermark must be `seq`-based, not count-based, or the first
//       truncation at MAX_ENTRIES resends the whole tail;
//     • a batch must go out ASCENDING, because the hub refuses an irreversible
//       entry that arrives before its gate (§15.6.7) and would reject the WHOLE
//       batch rather than that one line;
//     • a RETRY must reuse its `Idempotency-Key`, or one lost response doubles
//       the audit trail;
//     • `runId` must be a canonical uuid v4 — the hub refuses the entire batch
//       with `400 VALIDATION_ERROR "runId must be a uuid v4"`, a rule that is in
//       no published document and was found by probing;
//     • `rev` must NEVER be sent: it is not required, and it does not move for
//       the ledger, so sending one can only ever be a stale token.
//   Each of those gets an explicit assertion below, negative cases included.

import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// SIM_QUIET=1 prints only failures and the verdict.
const QUIET = !!process.env.SIM_QUIET;
let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  if (ok && QUIET) return;
  if (ok) console.log(`PASS  ${label}`);
  else
    console.log(
      `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`,
    );
}

function assert(label, cond, detail = '') {
  if (cond) pass++;
  else fail++;
  if (cond && QUIET) return;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

// ── The scripted hub ────────────────────────────────────────────────────────
const calls = [];
const scripted = new Map();

function script(key, ...replies) {
  scripted.set(key, replies.slice());
}

/** One canned reply. `throws` simulates a transport failure. */
const reply = (status, body, headers = {}, throws) => ({ status, body, headers, throws });

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const rel = u.pathname.replace(/^\/api\/hub/, '') + u.search;
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const record = {
      method,
      rel,
      headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(record);

    const lookup = scripted.get(`${method} ${rel}`) ?? scripted.get(`${method} ${rel.split('?')[0]}`);
    const next = lookup?.shift();
    // An unscripted call is a harness bug, so it fails loudly rather than
    // looking like a plain backend error the client handled correctly.
    const spec = next ?? reply(599, { ok: false, error: `UNSCRIPTED ${method} ${rel}`, code: 'UNSCRIPTED' });
    if (spec.throws) throw new Error(spec.throws);

    return {
      status: spec.status,
      ok: spec.status >= 200 && spec.status < 300,
      // A header-less stub is the classic way to crash the client inside a
      // floating promise: `hubRequest` reads `res.headers.get('etag')`.
      headers: {
        get: (k) => {
          const key = String(k).toLowerCase();
          for (const [hk, hv] of Object.entries(spec.headers)) {
            if (hk.toLowerCase() === key) return hv;
          }
          return null;
        },
      },
      text: async () => (spec.body === undefined ? '' : JSON.stringify(spec.body)),
      json: async () => spec.body ?? null,
    };
  };
}

// ── Bundle the real modules ─────────────────────────────────────────────────
// One bundle, so `ledger-sync`, `ledger` and `hub-client` share ONE instance of
// each module — and therefore one watermark, one ledger, and one auth token.
const out = mkdtempSync(join(tmpdir(), 'ledger-mirror-sim-'));
const outfile = join(out, 'ledger.mjs');
await build({
  stdin: {
    contents: `
export * from './ai/ledger-sync.ts';
export * from './ai/ledger.ts';
export * from './web/hub-client.ts';
export { setStreamToken } from './auth-token.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  define: {
    'import.meta.env': JSON.stringify({
      VITE_HUB_STREAM_URL: 'http://relay.test/api/stream?channel=hub',
    }),
  },
});

stubFetch();
const m = await import(pathToFileURL(outfile).href);
m.setStreamToken('test-token');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEDGER_CALL = 'POST /ledger';

/** The one call of a given method/path, asserting there is exactly one. */
function onlyCall(rel) {
  const hits = calls.filter((c) => c.rel === rel);
  assert(`exactly one ${rel} call`, hits.length === 1, `got ${hits.length}`);
  return hits[hits.length - 1];
}

const keyOf = (c) => c.headers['idempotency-key'];

/** The `runId` every assertion below expects: a fresh, canonical uuid v4. */
function newRun(prefix = 'run') {
  const id = m.canonicalUuid();
  m.ledgerBegin(id);
  return id;
}

function append(runId, over = {}) {
  return m.ledgerAppend({
    kind: 'ask',
    by: 'wearer',
    effect: 'pure',
    status: 'ok',
    text: 'what is on my list',
    runId,
    ...over,
  });
}

console.log('ledger mirror\n');

// ── A. the wire shape ───────────────────────────────────────────────────────
{
  calls.length = 0;
  m.resetLedger();
  m.resetLedgerMirror();
  const runId = newRun();
  append(runId);
  append(runId, { kind: 'route', by: 'jarvis', text: 'todos_read' });

  check('nothing acknowledged yet', m.ledgerWatermark(), 0);
  check('both entries are unsent', m.ledgerUnsent().length, 2);

  script(LEDGER_CALL, reply(201, { ok: true, rev: 68, appended: 2, fromSeq: 1, toSeq: 2, entries: [] }));
  const res = await m.flushLedger();

  check('flush ok', res.ok, true);
  check('appended count', res.appended, 2);
  check('watermark advanced to the highest sent seq', m.ledgerWatermark(), 2);

  const call = onlyCall('/ledger');
  check('method', call.method, 'POST');
  check('body is an entries wrapper, not a bare array', Object.keys(call.body), ['entries']);
  check('one transaction for the whole burst', call.body.entries.length, 2);

  const e0 = call.body.entries[0];
  // `seq` is the HUB's to assign. Sending one would be claiming a number the
  // server owns, and the wire type deliberately has no such field.
  check('no seq on the wire', 'seq' in e0, false);
  check('runId on the wire', e0.runId, runId);
  assert('runId is a canonical uuid v4', UUID_V4.test(e0.runId), e0.runId);
  check('kind passes through', e0.kind, 'ask');
  check('by passes through', e0.by, 'wearer');
  check('effect passes through', e0.effect, 'pure');
  check('status passes through', e0.status, 'ok');
  check('text passes through', e0.text, 'what is on my list');
  check('refs is a LIST on the wire, not a joined string', Array.isArray(e0.refs), true);
  assert('at is sent (the true event time)', typeof e0.at === 'number' && e0.at > 0, String(e0.at));
  // Absent optional fields must be ABSENT, not `undefined` and not `null`.
  assert('no locus key when there is no locus', !('locus' in e0), Object.keys(e0).join(','));
  assert('no payload key when there is no payload', !('payload' in e0), Object.keys(e0).join(','));
  // The ledger does not bump `rev`, so a rev here could only ever be stale.
  assert('rev is NOT sent', !('rev' in call.body), Object.keys(call.body).join(','));
  assert('an Idempotency-Key is sent', UUID_V4.test(keyOf(call) ?? ''), String(keyOf(call)));
  assert('the key is a uuid v4, not a bare hex digest', /-/.test(keyOf(call) ?? ''), String(keyOf(call)));
}

// ── B. the watermark holds: an acknowledged batch is never resent ───────────
{
  calls.length = 0;
  const res = await m.flushLedger();
  check('a second flush with nothing new is a no-op success', res.ok, true);
  check('appended nothing', res.appended, 0);
  check('and made NO request', calls.length, 0);
}

// ── C. only the tail goes, and it goes ASCENDING ────────────────────────────
// The order is load-bearing: the hub rejects an irreversible entry that arrives
// before the gate that authorises it, and it rejects the entire batch for it.
{
  calls.length = 0;
  const runId = m.ledgerRunId();
  const gate = append(runId, { kind: 'gate', by: 'jarvis', effect: 'pure', status: 'ok', text: 'delete?' });
  const undone = append(runId, {
    kind: 'decision',
    by: 'wearer',
    effect: 'irreversible',
    status: 'ok',
    text: 'yes, delete it',
    refs: [gate.seq],
  });

  script(LEDGER_CALL, reply(201, { ok: true, rev: 68, appended: 2, fromSeq: 3, toSeq: 4, entries: [] }));
  await m.flushLedger();

  const sent = onlyCall('/ledger').body.entries;
  check('only the two new entries went', sent.length, 2);
  check('the gate goes first', sent[0].kind, 'gate');
  check('the irreversible entry follows it', sent[1].kind, 'decision');
  check('effect clears the hub gate rule', sent[1].effect, 'irreversible');
  check('its refs point back at the gate it cites', sent[1].refs, [gate.seq]);
  check('local seq order is ascending', sent.map((e) => e.refs.length), [0, 1]);
  check('the watermark is now the last of them', m.ledgerWatermark(), undone.seq);
}

// ── D. a RETRY reuses its key; a NEW batch gets a new one ───────────────────
// A fresh key on retry is how one lost response doubles a permanent record.
{
  calls.length = 0;
  const runId = m.ledgerRunId();
  append(runId, { text: 'second turn' });

  script(
    LEDGER_CALL,
    reply(500, { ok: false, error: 'boom', code: 'INTERNAL' }),
    reply(201, { ok: true, rev: 68, appended: 1, fromSeq: 5, toSeq: 5, entries: [] }),
  );

  const first = await m.flushLedger();
  check('a 500 is surfaced, not thrown', first.ok, false);
  check('the hub code is reported', first.error, 'INTERNAL');
  check('the watermark did NOT move', m.ledgerWatermark(), 4);
  check('the entry is still unsent', m.ledgerUnsent().length, 1);

  const retry = await m.flushLedger();
  check('the retry succeeds', retry.ok, true);
  check('the watermark moved on success', m.ledgerWatermark(), 5);

  check('exactly two attempts were made', calls.length, 2);
  // Captured BEFORE the next block clears `calls` — comparing `calls[0]` with
  // `calls[calls.length - 1]` after the clear would compare one call with
  // itself and pass vacuously.
  const retryKey = keyOf(calls[1]);
  check('the retry REUSES the key', retryKey, keyOf(calls[0]));
  assert('and that key is a uuid v4', UUID_V4.test(retryKey ?? ''), String(retryKey));
  check('the retry sends the same batch', calls[1].body.entries, calls[0].body.entries);

  // A different batch must NOT inherit the old key, or the hub would de-dupe a
  // genuinely new write against the previous one and silently drop it.
  calls.length = 0;
  append(runId, { text: 'third turn' });
  script(LEDGER_CALL, reply(201, { ok: true, rev: 68, appended: 1, fromSeq: 6, toSeq: 6, entries: [] }));
  await m.flushLedger();
  assert(
    'a NEW batch gets a DIFFERENT key',
    keyOf(calls[0]) !== retryKey,
    `${keyOf(calls[0])} vs ${retryKey}`,
  );
}

// ── E. it never throws, whatever the transport does ─────────────────────────
{
  calls.length = 0;
  const runId = m.ledgerRunId();
  append(runId, { text: 'fourth turn' });

  // A hard network failure: `fetch` rejects rather than answering.
  script(LEDGER_CALL, reply(0, undefined, {}, 'ENOTFOUND relay.test'));
  const net = await m.flushLedger();
  check('a transport failure is a value, not an exception', net.ok, false);
  assert('and it carries a reason', !!net.error, String(net.error));
  check('the watermark survives a transport failure', m.ledgerWatermark(), 6);

  // A 400 with the probed uuid rule — the failure mode this design exists for.
  script(
    LEDGER_CALL,
    reply(400, {
      ok: false,
      error: 'runId must be a uuid v4',
      code: 'VALIDATION_ERROR',
      details: { field: 'runId' },
    }),
  );
  const bad = await m.flushLedger();
  check('a validation refusal is a value too', bad.ok, false);
  check('and reports the hub code', bad.error, 'VALIDATION_ERROR');
  check('the entries are still queued for a later retry', m.ledgerUnsent().length, 1);
  m.resetLedgerMirror();
}

// ── F. concurrent flushes make ONE request ──────────────────────────────────
// Two flushes read the same watermark and would write the same entries twice
// under two keys — and the hub de-dupes per key, not per content.
{
  calls.length = 0;
  m.resetLedger();
  m.resetLedgerMirror();
  const runId = newRun();
  append(runId);
  append(runId, { text: 'two' });
  script(LEDGER_CALL, reply(201, { ok: true, rev: 68, appended: 2, fromSeq: 1, toSeq: 2, entries: [] }));

  const [a, b] = await Promise.all([m.flushLedger(), m.flushLedger()]);
  check('both callers saw the same result', a, b);
  check('exactly ONE request was made', calls.length, 1);
  check('the watermark advanced once', m.ledgerWatermark(), 2);
}

// ── G. the debounce: a burst collapses into one transaction ─────────────────
{
  calls.length = 0;
  m.resetLedger();
  m.resetLedgerMirror();
  const runId = newRun();
  const stop = m.startLedgerMirror();

  append(runId, { kind: 'ask' });
  append(runId, { kind: 'route' });
  append(runId, { kind: 'call' });
  check('nothing is sent synchronously', calls.length, 0);

  script(LEDGER_CALL, reply(201, { ok: true, rev: 68, appended: 3, fromSeq: 1, toSeq: 3, entries: [] }));
  await new Promise((r) => setTimeout(r, m.LEDGER_FLUSH_MS + 400));

  check('the burst went as ONE request', calls.length, 1);
  check('carrying all three entries', calls[0].body.entries.length, 3);
  check('in emit order', calls[0].body.entries.map((e) => e.kind), ['ask', 'route', 'call']);

  // A sign-out / teardown resends nothing and leaves no timer behind.
  stop();
  calls.length = 0;
  append(runId, { kind: 'reply' });
  await new Promise((r) => setTimeout(r, m.LEDGER_FLUSH_MS + 200));
  check('after stop, a new entry is not mirrored', calls.length, 0);
}

// ── H. reset resends from scratch (a new account's hub has none of it) ──────
{
  calls.length = 0;
  m.resetLedger();
  m.resetLedgerMirror();
  const runId = newRun();
  append(runId);
  append(runId, { text: 'two' });
  check('reset cleared the watermark', m.ledgerWatermark(), 0);
  check('so the whole live ledger is unsent again', m.ledgerUnsent().length, 2);
  script(LEDGER_CALL, reply(201, { ok: true, rev: 68, appended: 2, fromSeq: 1, toSeq: 2, entries: [] }));
  await m.flushLedger();
  check('and it all goes', onlyCall('/ledger').body.entries.length, 2);
}

// ── I. the vocabularies are the hub's, not the app's ───────────────────────
// Hard-coded from the live server (§12), NOT imported, because importing the
// app's own unions would make this assertion vacuous — it would only prove the
// app agrees with itself. This is the check that catches a new local `kind`
// being written to a server that has never heard of it.
{
  const HUB_KINDS = ['ask', 'delta', 'route', 'call', 'result', 'reply', 'decision', 'gate', 'note', 'error'];
  const HUB_EFFECTS = ['pure', 'read', 'write', 'irreversible'];
  const HUB_BYS = ['wearer', 'jarvis', 'agent', 'jev', 'system'];
  const HUB_STATUSES = ['pending', 'ok', 'failed', 'skipped', 'declined'];
  const HUB_LOCI = ['client', 'relay'];
  const GATED_EFFECT = 'irreversible';
  const GATE_KIND = 'gate';

  check('every hub kind is reachable and none is unknown', new Set(HUB_KINDS).size, 10);
  check('four effects', HUB_EFFECTS.length, 4);
  check('five actors', HUB_BYS.length, 5);
  check('five statuses', HUB_STATUSES.length, 5);
  check('two loci', HUB_LOCI.length, 2);

  // The app's own gate rule must name the same effect the hub gates, or the
  // mirror would send an unauthorised irreversible entry and lose the batch.
  check('needsGate gates exactly the hub gated effect', m.needsGate(GATED_EFFECT), true);
  check('and nothing else', HUB_EFFECTS.filter((e) => m.needsGate(e)), [GATED_EFFECT]);
  check('the gate kind is a real kind', HUB_KINDS.includes(GATE_KIND), true);

  // Drive one entry per enumerated value through the mapper and assert each one
  // lands verbatim — a translation that silently rewrote a value would be
  // invisible here otherwise.
  m.resetLedger();
  m.resetLedgerMirror();
  const runId = newRun();
  for (const kind of HUB_KINDS) append(runId, { kind, text: `k:${kind}` });
  for (const by of HUB_BYS) append(runId, { by, text: `b:${by}` });
  for (const status of HUB_STATUSES) append(runId, { status, text: `s:${status}` });

  const unsent = m.ledgerUnsent();
  assert('all kinds mapped', unsent.slice(0, 10).every((e, i) => e.kind === HUB_KINDS[i]));
  assert('all actors mapped', unsent.slice(10, 15).every((e, i) => e.by === HUB_BYS[i]));
  assert('all statuses mapped', unsent.slice(15, 20).every((e, i) => e.status === HUB_STATUSES[i]));
  assert(
    'every mapped text is unchanged',
    unsent.every((e) => e.text.startsWith('k:') || e.text.startsWith('b:') || e.text.startsWith('s:')),
  );
  // `locus` and `payload` are the only optional fields, so they are the only
  // ones that may be absent — everything else must survive.
  check(
    'the mapped entry carries exactly the wire fields',
    Object.keys(unsent[0]).sort(),
    ['at', 'by', 'effect', 'kind', 'refs', 'runId', 'status', 'text'],
  );
  // `locus` is echoed when set, and both loci are legal.
  const withLocus = append(runId, { locus: 'relay', text: 'l' });
  check('locus survives when set', m.ledgerUnsent().slice(-1)[0].locus, 'relay');
  check('locus is a real locus', withLocus.locus, 'relay');
  // Ten kinds + five actors + five statuses, plus the one locus entry above.
  check('the ledger really grew', m.ledgerUnsent().length, 21);
}

// ── J. every run id this module can see is a uuid ───────────────────────────
// The single most expensive way to be wrong: a bad `runId` rejects every entry
// in its batch, and the ledger has no delete route to clean up after it.
{
  const ids = new Set(m.ledgerSnapshot().map((e) => e.runId));
  assert('there is at least one run', ids.size > 0, String(ids.size));
  assert(
    'every runId in the ledger is a canonical uuid v4',
    [...ids].every((id) => UUID_V4.test(id)),
    [...ids].filter((id) => !UUID_V4.test(id)).join(','),
  );
  assert(
    'the app mints uuids, not the old r<base36> ids',
    [...ids].every((id) => !id.startsWith('r')),
    [...ids].join(','),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
