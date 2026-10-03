// THE LEDGER MIRROR — the local run ledger, copied to the hub.
//
// `ledger.ts` stays PURE. It is the app's causal record and the thing every
// harness can bundle, and that purity is load-bearing rather than stylistic.
// This module is the other half — the half with a network — and it is separate
// for exactly that reason. Same split as `memory.ts`: the local value stays
// readable, and the hub is mirrored to rather than read from.
//
// WHY MIRROR AT ALL: the ledger is transient, in-memory state, so every run's
// record died with the tab. `POST /hub/ledger` is append-only, numbered by the
// server, and `rev` does not move for it — so a mirror can only ever ADD. It
// cannot fight the control plane and it can never be refused `STALE_REV`, which
// makes it the cheapest thing in the app to publish and the safest to retry.
//
// Five things this module has to get right, each of which is a way to be wrong:
//
//   1. WATERMARK BY `seq`, NOT BY COUNT. The local ledger is bounded at 400
//      entries and drops the OLDEST on overflow, so a count-based watermark
//      would resend the entire tail the first time it wrapped. `seq` is
//      monotonic and never reused, so `seq > watermark` is stable across
//      truncation. (Truncation CAN outrun a slow flush and lose the oldest
//      unsent entries. That is accepted: the alternative is unbounded memory
//      for a diagnostic log, and the cap is the headline feature of the type.)
//   2. ONE BATCH PER FLUSH. The hub validates a batch atomically — one bad
//      entry rejects all of it — so a partial write cannot happen and the
//      watermark only moves when the whole batch is acknowledged.
//   3. A RETRY REUSES ITS KEY. The `Idempotency-Key` is derived from the
//      batch's seq range, so retrying an identical batch reuses the key and the
//      hub de-duplicates it. A fresh key per attempt would turn one lost
//      response into a doubled audit trail — the worst possible failure for a
//      record whose whole purpose is to be trustworthy.
//   4. IT NEVER THROWS. A mirror failure costs a log line, never the run. Same
//      contract as `runFilesTool` on the relay: "a tool failure that took the
//      run down would throw away the rest of the agent's work."
//   5. IT NEVER REORDERS. Entries go out in ascending `seq`, because a causal
//      reader has to see a parent before its child, and because the hub's own
//      gate invariant depends on an `ok` gate arriving before the irreversible
//      entry that cites it.
import { ledgerSnapshot, subscribeLedger, type Entry } from './ledger';
import { appendLedger, canonicalUuid, type LedgerAppendInput } from '../web/hub-client';

/**
 * How long the ledger goes quiet before a flush.
 *
 * A run emits a burst — ask, route, call, result, reply — and pushing each one
 * as it lands would be one request per step against a 120/minute budget, for a
 * log nobody is watching in real time. A short trailing debounce collapses the
 * burst into one transaction, which is also the unit the hub validates.
 */
export const LEDGER_FLUSH_MS = 1_500;

/** Highest LOCAL `seq` acknowledged by the hub. 0 means "nothing sent yet". */
let watermark = 0;
/** The key last used, and the batch it was used for. See note 3. */
let lastKey = '';
let lastKeyFor = '';
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<LedgerFlush> | null = null;

export interface LedgerFlush {
  ok: boolean;
  appended: number;
  /** The hub's reason, when it refused. Present only on failure. */
  error?: string;
}

/**
 * The entries the hub has not acknowledged, oldest first.
 *
 * Pure — it reads the ledger snapshot and the watermark and nothing else — so a
 * harness can assert the batching rule without a network, and so the flush path
 * has exactly one source of truth for what is unsent.
 */
export function ledgerUnsent(entries: Entry[] = ledgerSnapshot()): LedgerAppendInput[] {
  return unsentEntries(entries).map(toWire);
}

/** The unsent tail, oldest first. One rule, one implementation, two readers. */
function unsentEntries(entries: Entry[]): Entry[] {
  return entries.filter((e) => e.seq > watermark).sort((a, b) => a.seq - b.seq);
}

function toWire(e: Entry): LedgerAppendInput {
  return {
    runId: e.runId,
    kind: e.kind,
    by: e.by,
    effect: e.effect,
    status: e.status,
    text: e.text,
    // Verbatim, in the app's own seq space. The hub stores these as an opaque
    // list and never resolves them, so they keep meaning "the local entries
    // this one was built from" — see the note on `LedgerEntryWire.refs`.
    refs: e.refs,
    // `at` is the TRUE event time and the app knows it better than the server
    // does, so it is sent. A server that prefers its own clock overrides it and
    // nothing is lost; omitting it would leave every line stamped by arrival.
    at: e.at,
    ...(e.locus !== undefined ? { locus: e.locus } : {}),
    ...(e.payload !== undefined ? { payload: e.payload } : {}),
  };
}

/** The highest local `seq` the hub has acknowledged. */
export function ledgerWatermark(): number {
  return watermark;
}

/** The key a batch of this seq range will use. Stable across identical retries. */
function keyFor(first: number, last: number): string {
  const range = `${first}:${last}`;
  if (range === lastKeyFor && lastKey) return lastKey;
  lastKeyFor = range;
  lastKey = canonicalUuid();
  return lastKey;
}

/**
 * Push every unsent entry in ONE batch. Never throws.
 *
 * Concurrent callers share the in-flight request rather than racing it: two
 * flushes would read the same watermark, send the same batch under two keys,
 * and — because the hub de-duplicates per key, not per content — write the
 * audit trail TWICE.
 */
export function flushLedger(): Promise<LedgerFlush> {
  if (inFlight) return inFlight;
  const entries = ledgerSnapshot();
  const unsent = unsentEntries(entries);
  if (!unsent.length) return Promise.resolve({ ok: true, appended: 0 });

  // The watermark advances to the highest seq actually SENT. Taking it from the
  // source entries rather than from the wire copies keeps it in `seq` space —
  // the wire type has no `seq` at all, deliberately.
  const first = unsent[0].seq;
  const highest = unsent[unsent.length - 1].seq;

  inFlight = appendLedger(unsent.map(toWire), { key: keyFor(first, highest) })
    .then((r) => {
      // `message` is not a field of `HubError` — the envelope's human text is
      // `error`, and its machine code is `code`. Prefer the code, because that
      // is what a retry decision can actually be made on.
      if (!r.ok) {
        return { ok: false, appended: 0, error: r.code || r.error || 'ledger append failed' };
      }
      watermark = highest;
      // The batch is acknowledged, so its key must not be reused by a LATER,
      // different batch that happens to start at the same seq.
      lastKeyFor = '';
      lastKey = '';
      return { ok: true, appended: r.appended };
    })
    .catch((err: unknown) => ({
      ok: false,
      appended: 0,
      error: err instanceof Error ? err.message : String(err),
    }))
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Cancel a debounce without flushing. Used by the harness and by `stop`. */
function cancel(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/**
 * Start mirroring. Returns the stop function.
 *
 * Subscribing to the ledger rather than hooking each `ledgerAppend` call site is
 * deliberate: the ledger is the one place that already knows an entry exists,
 * including entries appended by modules that know nothing about the hub. A
 * per-call-site mirror would be a list to keep up to date, and it would silently
 * miss the next capability someone adds.
 *
 * The flush is also wired to `pagehide` — on the glasses WebView that is the
 * last reliable moment before the tab is destroyed, and a pending debounce
 * would otherwise be lost with the run's record intact in memory.
 */
export function startLedgerMirror(): () => void {
  const unsubscribe = subscribeLedger(() => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      void flushLedger();
    }, LEDGER_FLUSH_MS);
  });

  const onHide = (): void => {
    cancel();
    void flushLedger();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onHide);
  }

  return () => {
    unsubscribe();
    cancel();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onHide);
    }
  };
}

/**
 * Forget what was sent. For tests and for a hard sign-out.
 *
 * Clearing the watermark makes the next flush resend the live ledger, which is
 * correct: a new account's hub has none of it.
 */
export function resetLedgerMirror(): void {
  cancel();
  watermark = 0;
  lastKey = '';
  lastKeyFor = '';
  inFlight = null;
}
