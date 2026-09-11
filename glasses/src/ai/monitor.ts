// The Jarvis agent-session watch queue.
//
// WHY THIS EXISTS:
//   Jarvis can START an agent run (agents.trigger) but a run executes
//   SERVER-side and finishes seconds or minutes later, long after the spoken
//   turn that started it has ended. Without a queue the wearer has no way to
//   find out that it finished short of walking into the Agents tab and paging
//   through history — and the model, which is the thing the user is actually
//   talking to, has no idea anything was ever started.
//
//   So every run Jarvis starts is ENQUEUED here and watched until it is
//   terminal. A queued run that goes from `running` to `done` raises the
//   `unread` flag, which does two things:
//     1. it is pasted into the next turn's system prompt (see ./context), so
//        Jarvis can answer "is it done?" — and can volunteer it — WITHOUT a
//        tool call; and
//     2. it is drawn at the bottom of the Jarvis HUD, where the ring scrolls
//        through the queue (see aiView).
//
//   This module is deliberately PURE: no SSE, no relay, no app stores. Runs are
//   PUSHED in by the platform layer (main.ts wires it to agent-runs) so the
//   queue can be driven from a node harness with plain objects — the same seam
//   the agent loop uses for its transport.
import type { RunMessage } from '../stream';

export type MonitorStatus = 'running' | 'done' | 'error' | 'stopped';

/** One queued run. A trimmed view of `AgentRun` — this is not a transcript store. */
export interface MonitoredRun {
  runId: string;
  agentId: string;
  agentName: string;
  /** Run title, falling back to the prompt. The session label. */
  title: string;
  status: MonitorStatus;
  startedAt: number;
  updatedAt: number;
  /** Transcript turns seen so far — a running row the user can gauge. */
  turns: number;
  /**
   * Newest assistant/answer line, flattened and clipped — the row's detail.
   * While the run is still going it falls back to the relay's status line
   * ("Searching…"), because a running row with no detail reads as stuck.
   */
  latest: string;
  /**
   * Finished but not looked at yet. Set on the running→terminal transition and
   * cleared by `ackMonitor`. This is the only state that means "tell Jarvis".
   */
  unread: boolean;
}

/**
 * The shape the platform layer feeds in. A structural subset of `AgentRun`, so
 * a real run can be passed straight through and a harness can pass literals.
 */
export interface WatchedRun {
  id: string;
  agentId: string;
  agentName: string;
  title?: string;
  prompt?: string;
  status: MonitorStatus;
  statusText?: string;
  messages?: readonly RunMessage[];
  startedAt?: number;
  updatedAt?: number;
}

/** What the HUD (and the phone panel) renders: one row per queued run. */
export interface MonitorRow {
  runId: string;
  label: string;
  status: MonitorStatus;
  startedAt: number;
  updatedAt: number;
  unread: boolean;
  latest: string;
}

export interface MonitorView {
  /** Newest first — always. `rows[0]` is the run to read. */
  rows: MonitorRow[];
  /**
   * Finished-but-unread count across the whole queue. This — not a per-row
   * cursor — is what "notify Jarvis" means: the HUD's ring now scrolls ONE
   * index across both its transcript and these rows, so keeping a second cursor
   * here would be two sources of truth for the same position.
   */
  unread: number;
  running: number;
}

/** Bound on the queue: the HUD shows one row at a time and the ring wraps. */
const MAX_QUEUE = 8;
/** Longest "latest" line kept. Anything longer is clipped, not wrapped. */
const MAX_LATEST = 180;

let queue: MonitoredRun[] = [];
let view: MonitorView | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  view = null;
  for (const fn of [...listeners]) fn();
}

/** Newest first, then most recently updated. Stable across ingests. */
function sorted(list: readonly MonitoredRun[]): MonitoredRun[] {
  return [...list].sort((a, b) => b.startedAt - a.startedAt || b.updatedAt - a.updatedAt);
}

function flatten(text: string, max = MAX_LATEST): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The newest thing an assistant actually SAID — not a tool call, not the prompt. */
function latestLine(messages: readonly RunMessage[] | undefined): string {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    // A tool-calling turn carries the tool name in `tool` and often has an
    // empty/placeholder body; only prose counts as something to read out.
    if (m.tool && !m.content.trim()) continue;
    const text = flatten(m.content);
    if (text) return text;
  }
  return '';
}

/** Subscribe to queue changes. Returns an unsubscribe function. */
export function subscribeMonitor(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The current queue. The SAME object is returned until something changes, which
 * is what `useSyncExternalStore` needs to avoid re-rendering forever.
 */
export function getMonitorView(): MonitorView {
  if (view) return view;
  const rows = sorted(queue).map<MonitorRow>((r) => ({
    runId: r.runId,
    label: r.agentName,
    status: r.status,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    unread: r.unread,
    latest: r.latest,
  }));
  view = {
    rows,
    unread: rows.filter((r) => r.unread).length,
    running: rows.filter((r) => r.status === 'running').length,
  };
  return view;
}

export function getMonitored(runId: string): MonitoredRun | null {
  return queue.find((r) => r.runId === runId) ?? null;
}

/**
 * Add a freshly started run to the queue. Called the moment a run is accepted
 * by the relay, so the HUD shows `running` even before the first frame arrives.
 * Re-enqueuing an existing run id refreshes it instead of duplicating the row.
 */
export function enqueueMonitoredRun(input: {
  runId: string;
  agentId: string;
  agentName: string;
  title?: string;
  prompt?: string;
  at?: number;
}): MonitoredRun | null {
  if (!input.runId) return null;
  const at = input.at ?? Date.now();
  const existing = queue.find((r) => r.runId === input.runId);
  if (existing) {
    const next: MonitoredRun = {
      ...existing,
      agentName: input.agentName || existing.agentName,
      title: input.title || existing.title,
    };
    queue = sorted(queue.map((r) => (r.runId === existing.runId ? next : r)));
    emit();
    return next;
  }
  const entry: MonitoredRun = {
    runId: input.runId,
    agentId: input.agentId,
    agentName: input.agentName,
    title: input.title || input.prompt || 'Session',
    status: 'running',
    startedAt: at,
    updatedAt: at,
    turns: 0,
    latest: '',
    unread: false,
  };
  queue = sorted([...queue, entry]).slice(0, MAX_QUEUE);
  emit();
  return entry;
}

/**
 * Reconcile the queue against the live run mirror. Returns the runs that just
 * went TERMINAL (the only moment worth notifying anyone about).
 *
 * Runs the queue has never heard of are ignored: an agent triggered by hand from
 * the Agents tab is not something Jarvis was asked to watch, and adopting it
 * would make the "1 new" badge lie about work the user is already looking at.
 */
export function ingestMonitoredRuns(runs: readonly WatchedRun[]): MonitoredRun[] {
  if (!queue.length || !runs.length) return [];
  const byId = new Map(runs.map((r) => [r.id, r]));
  const finished: MonitoredRun[] = [];
  let changed = false;
  const next = queue.map((entry) => {
    const run = byId.get(entry.runId);
    if (!run) return entry;
    const status: MonitorStatus = run.status ?? entry.status;
    const wasRunning = entry.status === 'running';
    const latest =
      latestLine(run.messages) ||
      (status === 'running' ? flatten(run.statusText ?? '') : '') ||
      entry.latest;
    const turns = run.messages?.length ?? entry.turns;
    const updatedAt = run.updatedAt ?? entry.updatedAt;
    if (
      status === entry.status &&
      latest === entry.latest &&
      turns === entry.turns &&
      updatedAt === entry.updatedAt
    ) {
      return entry;
    }
    changed = true;
    // Only a running→terminal EDGE is news. A terminal run that keeps being
    // replayed on reconnect must not re-raise the badge every time.
    const justFinished = wasRunning && status !== 'running';
    const updated: MonitoredRun = {
      ...entry,
      status,
      latest,
      turns,
      updatedAt,
      agentName: run.agentName || entry.agentName,
      title: run.title || entry.title,
      unread: entry.unread || justFinished,
    };
    if (justFinished) finished.push(updated);
    return updated;
  });
  if (!changed) return [];
  queue = sorted(next);
  emit();
  return finished;
}

/**
 * Mark a run as READ, clearing the "notify Jarvis" badge. Called when the ring
 * lands on a finished row — looking at it IS the acknowledgement, and a badge
 * that needed a separate dismiss would be another button on a screen with no
 * room for one. With no explicit id, the newest unread row is the one meant.
 */
export function ackMonitor(runId?: string): boolean {
  const target = runId ?? queue.find((r) => r.unread)?.runId;
  if (!target) return false;
  const entry = queue.find((r) => r.runId === target);
  if (!entry?.unread) return false;
  queue = queue.map((r) => (r.runId === target ? { ...r, unread: false } : r));
  emit();
  return true;
}

/** Drop a run from the queue entirely (a run that failed to start, or teardown). */
export function removeMonitoredRun(runId: string): void {
  const next = queue.filter((r) => r.runId !== runId);
  if (next.length === queue.length) return;
  queue = next;
  emit();
}

/** Test/teardown reset. */
export function resetMonitor(): void {
  queue = [];
  emit();
}

/** How long ago, in the compact form the HUD has room for. */
export function monitorAge(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}
