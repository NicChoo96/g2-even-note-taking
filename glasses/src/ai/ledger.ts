// THE LEDGER — one append-only, typed record of everything a run did.
//
// Why this exists (the design thesis in one paragraph): the app's features for
// context, chaining, tracing, live injection, human gates and undo are usually
// built as six separate systems. They are not six systems. They are six
// *projections over one log* — "trace the chain" is a read, "share context
// between runs" is a replay, "typed handoff" is the next step reading the
// previous step's entries, "human gate" is an entry that sits `pending` until it
// is approved, and "mid-run injection" is just an append that later readers pick
// up for free. Getting this shape right is what makes those features cheap
// later; building them one at a time without it is what makes them expensive.
//
// Deliberately PURE, like `monitor.ts`: no SSE, no stores, no SDK, no imports.
// That is what lets a harness bundle it and assert every rule below.
//
// Two rules are load-bearing:
//
//   1. APPEND-ONLY. There is no update and no delete. A reversed decision is a
//      NEW entry; the old one stays. A log you can rewrite cannot be audited,
//      and "what actually happened" is the whole point.
//   2. The ledger RECORDS; it does not OWN state. `HubState` stays the single
//      source of truth for the user's data. Nothing here is authoritative for
//      anything except the history of what was attempted.
//
// The second rule matters specifically because 0.3.28 rebuilt `run.messages` to
// fix the truncation bug. The ledger is a SUPERSET generated *from* that
// traffic — it must never become a competing copy of it.

/**
 * How much damage an entry can do, weakest first. This replaces a per-tool
 * `confirm` flag with a classification, so the safety rule can be stated once
 * and apply to tools that do not exist yet.
 *
 *   pure          no observable effect at all
 *   read          reads state, changes nothing
 *   write         changes state, but the change can be undone
 *   irreversible  cannot be undone once done
 */
export type Effect = 'pure' | 'read' | 'write' | 'irreversible';

/** Weakest → strongest. Useful for "is this at least as dangerous as X". */
export const EFFECT_ORDER: readonly Effect[] = ['pure', 'read', 'write', 'irreversible'];

/**
 * THE SAFETY INVARIANT, in one line: an irreversible entry may not succeed
 * without a preceding approved gate in the same run.
 *
 * This is deliberately a property of the LEDGER rather than a flag on each
 * tool. A per-tool flag has a failure mode with a 100% hit rate eventually —
 * the ninth capability is added by someone who did not know about the flag.
 * A property of the record cannot be forgotten, and it is checkable by
 * `ungatedIrreversible()` and asserted by the harness.
 *
 * The converse is what makes this *easier to use*, not harder: `write` entries
 * are NOT gated. Gating an undoable action trains the wearer to approve without
 * reading, which is exactly how a gate that matters gets ignored.
 */
export function needsGate(effect: Effect): boolean {
  return effect === 'irreversible';
}

/** Is `a` at least as dangerous as `b`? */
export function atLeast(a: Effect, b: Effect): boolean {
  return EFFECT_ORDER.indexOf(a) >= EFFECT_ORDER.indexOf(b);
}

/**
 * What a kind of record is:
 *   ask       the wearer's opening sentence
 *   delta     the wearer's on-the-spot instruction (never baked into a card)
 *   route     a routing decision (which page / which action)
 *   call      an action being attempted
 *   result    an action's outcome
 *   reply     the model's answer to the wearer (not an action's outcome)
 *   decision  a typed jev answer (a probability, not prose)
 *   gate      a confirmation prompt or its resolution
 *   note      reasoning or a note to self
 *   error     a failure worth surfacing
 */
export type EntryKind =
  | 'ask'
  | 'delta'
  | 'route'
  | 'call'
  | 'result'
  | 'reply'
  | 'decision'
  | 'gate'
  | 'note'
  | 'error';

/** Who caused it. `wearer` is the only source of a delta. */
export type EntryBy = 'wearer' | 'jarvis' | 'agent' | 'jev' | 'system';

/**
 * `pending` is the interesting one: it means the entry is a PROPOSAL. That is
 * how an agent that is not currently being watched can still ask for a write —
 * it records an intent, and the next client to connect runs it through the
 * normal gate and undo path. No round-trip to a client that may be offline, and
 * no unattended write.
 */
export type EntryStatus = 'pending' | 'ok' | 'failed' | 'skipped' | 'declined';

/** Where the work would happen. Capabilities are client-side; agents are relay. */
export type EntryLocus = 'client' | 'relay';

export interface Entry {
  /** Monotonic, never reused. The causal handle. */
  seq: number;
  runId: string;
  at: number;
  kind: EntryKind;
  by: EntryBy;
  effect: Effect;
  status: EntryStatus;
  /** ONE short ASCII line. Safe to render on the glasses. */
  text: string;
  /**
   * `seq` values this entry consumed — its causal parents. This is what turns a
   * flat list into a traceable chain, and what lets a chain step inherit the
   * exact output it was built on instead of re-reading a summary.
   */
  refs: number[];
  locus?: EntryLocus;
  /** Structured detail. Never rendered on the glasses. */
  payload?: unknown;
}

/** Everything `ledgerAppend` accepts; the rest is filled in. */
export interface EntryInput {
  kind: EntryKind;
  by: EntryBy;
  text: string;
  effect?: Effect;
  status?: EntryStatus;
  refs?: number[];
  locus?: EntryLocus;
  payload?: unknown;
  /** Defaults to the current run. Pass explicitly to record out-of-band. */
  runId?: string;
  at?: number;
}

/**
 * Bounded, because this is mirrored to the other surface on change (the same
 * reason `store.ts` bounds its steps). A log with no ceiling is a memory leak
 * that only shows up in a long conversation.
 */
const MAX_ENTRIES = 400;

/** Per-entry text cap. A ledger line is a label, not a document. */
const MAX_TEXT_CHARS = 120;

/**
 * Printable ASCII only. The G2 firmware font has no emoji glyphs and an
 * unsupported code point costs bytes while rendering as an empty box, so a
 * ledger line is stripped at the source rather than at each render site.
 * (Same doctrine as `stripUnsupported` in sections.ts, kept local so this
 * module stays dependency-free and independently testable.)
 */
function cleanText(text: string): string {
  return String(text ?? '')
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

let entries: Entry[] = [];
let nextSeq = 0;
let currentRun = '';
let snapshot: Entry[] = [];
let listeners: Array<() => void> = [];

/** Cached array identity, invalidated on every write (the MonitorView lesson). */
function emit(): void {
  snapshot = entries.slice();
  for (const fn of listeners) fn();
}

export function subscribeLedger(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

/** Stable reference for `useSyncExternalStore` and memoised render paths. */
export function ledgerSnapshot(): Entry[] {
  return snapshot;
}

/** Everything appended after this point belongs to `runId` by default. */
export function ledgerBegin(runId: string): void {
  currentRun = String(runId || '');
}

export function ledgerRunId(): string {
  return currentRun;
}

export function ledgerAppend(input: EntryInput): Entry {
  const entry: Entry = {
    seq: ++nextSeq,
    runId: input.runId ?? currentRun,
    at: input.at ?? Date.now(),
    kind: input.kind,
    by: input.by,
    effect: input.effect ?? 'pure',
    status: input.status ?? 'ok',
    text: cleanText(input.text),
    refs: Array.isArray(input.refs) ? input.refs.slice() : [],
  };
  if (input.locus) entry.locus = input.locus;
  if (input.payload !== undefined) entry.payload = input.payload;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  emit();
  return entry;
}

/**
 * Resolve a pending entry (a proposal, or a gate's prompt) into an outcome.
 * This is an APPEND, not an edit: the original stays so the trace shows that
 * something was proposed and what happened to it.
 */
export function ledgerResolve(
  seq: number,
  status: Exclude<EntryStatus, 'pending'>,
  text?: string,
): Entry | undefined {
  const original = entries.find((e) => e.seq === seq);
  if (!original) return undefined;
  return ledgerAppend({
    kind: original.kind,
    by: original.by,
    text: text ?? original.text,
    effect: original.effect,
    status,
    refs: [original.seq],
    runId: original.runId,
    ...(original.locus ? { locus: original.locus } : {}),
  });
}

export function ledgerEntries(runId?: string): Entry[] {
  return runId === undefined ? entries.slice() : entries.filter((e) => e.runId === runId);
}

/** The run's entries in order. */
export function ledgerRun(runId: string): Entry[] {
  return entries.filter((e) => e.runId === runId);
}

/** The last `n` entries across all runs, oldest first. */
export function ledgerLast(n: number): Entry[] {
  return entries.slice(Math.max(0, entries.length - n));
}

export function ledgerSize(): number {
  return entries.length;
}

/** Test/reset hook. Not a user-facing action — there is no "delete a record". */
export function resetLedger(): void {
  entries = [];
  nextSeq = 0;
  currentRun = '';
  emit();
}

// ── The safety invariant ────────────────────────────────────────────────────

/** True when an approved gate exists earlier in the same run. */
export function isGated(runId: string, seq: number): boolean {
  return entries.some((e) => e.runId === runId && e.kind === 'gate' && e.seq < seq && e.status === 'ok');
}

/**
 * Every irreversible entry that succeeded without a gate. MUST be empty. This
 * is the assertion, not a warning: an irreversible action that ran unapproved
 * is a data-loss bug that has already happened (`BUG F` in 0.3.14, where a tap
 * approved a mirrored destructive confirm).
 *
 * `kind === 'gate'` is excluded, and that exclusion is load-bearing rather than
 * cosmetic: a gate's own resolved entry inherits `effect: 'irreversible'` from
 * the prompt it answers, and it carries `status: 'ok'` — so without this the
 * approval would report ITSELF as an ungated irreversible success and the
 * invariant would be useless (it would be non-empty on every correct run). An
 * approval is the mechanism, not an action that itself needs approving.
 */
export function ungatedIrreversible(): Entry[] {
  return entries.filter(
    (e) =>
      e.kind !== 'gate' &&
      e.effect === 'irreversible' &&
      e.status === 'ok' &&
      !isGated(e.runId, e.seq),
  );
}

/** Proposals recorded by an agent that no client has picked up yet. */
export function pendingEntries(runId?: string): Entry[] {
  const scoped = runId === undefined ? entries : entries.filter((e) => e.runId === runId);
  return scoped.filter((e) => e.status === 'pending' && e.locus === 'client' && e.effect !== 'read');
}

// ── Projections ─────────────────────────────────────────────────────────────
// The point of the ledger: each of these is a read, not a subsystem.

/** The wearer's per-run instructions. Never merged into a saved card. */
export function ledgerDeltas(runId: string): string[] {
  return ledgerRun(runId)
    .filter((e) => e.kind === 'delta')
    .map((e) => e.text);
}

/** The deltas as one directive block, ready to append to a system message. */
export function deltaBlock(runId: string): string {
  const deltas = ledgerDeltas(runId);
  return deltas.length ? deltas.join('; ') : '';
}

/**
 * Material this run has already established — results and typed decisions.
 * This is the typed handoff: a later step reads THIS instead of being handed a
 * raw prose transcript to re-interpret.
 */
export function ledgerMaterial(runId: string, maxChars = 4000): string {
  const lines: string[] = [];
  for (const e of ledgerRun(runId)) {
    if (e.status !== 'ok') continue;
    if (e.kind === 'result' || e.kind === 'decision') lines.push(`- ${e.text}`);
  }
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/**
 * HUD-safe trace lines, newest last. ASCII marks only — the firmware font has
 * no glyphs for anything prettier, and a missing glyph renders as an empty box.
 */
export function ledgerTrace(runId: string, maxLines = 8): string[] {
  return ledgerRun(runId)
    .slice(-maxLines)
    .map((e) => {
      const mark = e.status === 'failed' ? '!' : e.status === 'declined' ? 'x' : e.status === 'pending' ? '?' : '>';
      return `${mark} ${e.text}`;
    });
}
