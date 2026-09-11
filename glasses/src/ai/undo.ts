// Generic undo for AI actions.
//
// UNDO BY SNAPSHOT, NOT BY INVERSE. Every capability that mutates state goes
// through the same two stores, so capturing them before a batch and restoring
// them afterwards reverts ANY action — including capabilities that did not
// exist when this file was written. An "inverse operation" design would need
// every new capability to hand-write an undo and would silently break the day
// one was forgotten. This is the adaptive choice.
import { getAgents, updateAgents } from '../agents-store';
import { getState, update } from '../store';
import type { AgentsState, HubState } from '../types';

const MAX_BATCHES = 3;

interface AppSnapshot {
  hub: HubState;
  agents: AgentsState;
  label: string;
  at: number;
  hubChanged: boolean;
  agentsChanged: boolean;
}

export interface BatchToken {
  hub: HubState;
  agents: AgentsState;
  label: string;
}

const history: AppSnapshot[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

/** Capture the pre-action state. Call once, before the first tool executes. */
export function beginAiBatch(label: string): BatchToken {
  return { hub: getState(), agents: getAgents(), label };
}

/**
 * Close a batch. Reference comparison is enough because both stores REPLACE
 * their state object on every edit — so an untouched store compares equal and
 * a "run that only answered a question" records nothing to undo.
 */
export function endAiBatch(token: BatchToken): boolean {
  const hubChanged = getState() !== token.hub;
  const agentsChanged = getAgents() !== token.agents;
  if (!hubChanged && !agentsChanged) return false;
  history.push({
    hub: token.hub,
    agents: token.agents,
    label: token.label,
    at: Date.now(),
    hubChanged,
    agentsChanged,
  });
  while (history.length > MAX_BATCHES) history.shift();
  emit();
  return true;
}

export function hasUndo(): boolean {
  return history.length > 0;
}

/** Label of the batch that `undoLastAiBatch()` would revert. */
export function undoLabel(): string {
  return history.length ? history[history.length - 1].label : '';
}

/** Revert the most recent AI batch. Returns its label, or null if none. */
export function undoLastAiBatch(): string | null {
  const last = history.pop();
  if (!last) return null;
  if (last.hubChanged) update(() => last.hub);
  if (last.agentsChanged) updateAgents(() => last.agents);
  emit();
  return last.label;
}

export function clearUndo(): void {
  if (!history.length) return;
  history.length = 0;
  emit();
}

export function subscribeUndo(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
