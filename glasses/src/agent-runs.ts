// Live agent runs — a transient, client-side mirror of the relay's run store.
//
// A run executes SERVER-SIDE (see web/server/local-sse.mjs) so it survives the
// glasses page being backgrounded. This store subscribes to the `run` frames the
// relay broadcasts on the agents channel, keeps the in-flight runs in memory and
// notifies React. Nothing here is persisted or synced as part of AgentsState —
// the finished transcript is saved as a normal session instead, by whichever
// client sees the run complete.
import {
  connectRuns,
  fetchRuns,
  type AgentRun,
  type RunMessage,
} from './stream';

type Listener = () => void;

const listeners = new Set<Listener>();
let runs: AgentRun[] = [];
let started = false;
let stopStream: (() => void) | null = null;

/** Runs sorted newest-first. A new array each change so React re-renders. */
export function getRuns(): AgentRun[] {
  return runs;
}

export function subscribeRuns(fn: Listener): () => void {
  listeners.add(fn);
  ensureStarted();
  return () => {
    listeners.delete(fn);
  };
}

function emit() {
  for (const fn of [...listeners]) fn();
}

/** Newest run that is still executing, or null. */
export function activeRun(): AgentRun | null {
  return runs.find((r) => r.status === 'running') ?? null;
}

export function runById(id: string | null | undefined): AgentRun | null {
  if (!id) return null;
  return runs.find((r) => r.id === id) ?? null;
}

/**
 * Pick the run a pane should paint for ONE agent: a live one if there is any,
 * otherwise the newest remembered, otherwise null.
 *
 * SCOPE IS THE WHOLE POINT, and it is why this takes an agentId instead of
 * returning "the newest run anywhere". The relay runs agents concurrently and a
 * client can have several runs in flight, so a panel that falls back to the
 * newest run it knows about keeps streaming the PREVIOUS agent's transcript
 * after the master list moves the highlight — one agent's words under another
 * agent's name. Resolving strictly by agentId is what makes "scroll the master
 * list to a backgrounded agent and watch its run" work.
 *
 * Pure (hence exported) so the rule can be pinned without an SSE stream; the
 * store-backed `latestRunFor` is a one-liner over it.
 */
export function pickRunForAgent(
  all: readonly AgentRun[],
  agentId: string | null | undefined,
): AgentRun | null {
  if (!agentId) return null;
  const mine = all.filter((r) => r.agentId === agentId);
  // Running wins over newer: a run still executing owns the pane whatever its age.
  return mine.find((r) => r.status === 'running') ?? mine[0] ?? null;
}

/** The run to show for an agent: the live one if any, else the newest remembered. */
export function latestRunFor(agentId: string | null | undefined): AgentRun | null {
  return pickRunForAgent(runs, agentId);
}

/** True while the relay is executing a run for this agent. */
export function isAgentRunning(agentId: string | null | undefined): boolean {
  return !!agentId && runs.some((r) => r.agentId === agentId && r.status === 'running');
}

/** Drop a finished run once its transcript has been saved as a session. */
export function clearRun(id: string) {
  const next = runs.filter((r) => r.id !== id);
  if (next.length === runs.length) return;
  runs = next;
  emit();
}

function upsert(run: AgentRun) {
  const i = runs.findIndex((r) => r.id === run.id);
  const next = i === -1 ? [run, ...runs] : runs.map((r) => (r.id === run.id ? run : r));
  // Keep the list bounded and stable: running first, then newest.
  next.sort((a, b) => b.startedAt - a.startedAt);
  runs = next.slice(0, 12);
  emit();
}

function ensureStarted() {
  if (started) return;
  started = true;
  stopStream = connectRuns({
    onRun: upsert,
    onInit: (live) => {
      for (const r of live) upsert(r);
    },
  });
  // Reconcile anything that started while this client was disconnected.
  void fetchRuns().then((all) => {
    for (const r of all) if (r.status === 'running') upsert(r);
  });
}

/** Stop listening (only used by tests / teardown). */
export function stopRuns() {
  stopStream?.();
  stopStream = null;
  started = false;
}

/** Convert a run transcript into the AgentMessage shape sessions use. */
export function runMessages(run: AgentRun): RunMessage[] {
  return run.messages;
}
