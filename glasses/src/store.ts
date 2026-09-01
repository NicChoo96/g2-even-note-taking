// Shared HubState store — the single source of truth for BOTH the companion UI
// (React, same page) and the glasses renderer. Persists to localStorage,
// publishes edits to the relay, and applies remote frames (ignoring our own
// echoes). This is what makes ONE app at ONE URL drive the web UI AND the
// glasses at the same time.
import { publishState } from './stream';
import { emptyHubState, type HubState } from './types';

const LS_KEY = 'hub:state';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'error';

let state: HubState = loadLocal();
const listeners = new Set<() => void>();
let lastPublishedAt = 0;
let pubTimer: number | null = null;

let conn: ConnStatus = 'idle';
const connListeners = new Set<(s: ConnStatus) => void>();

function loadLocal(): HubState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptyHubState();
    const parsed = JSON.parse(raw) as Partial<HubState>;
    if (parsed?.sections) return { ...emptyHubState(), ...parsed };
  } catch {
    /* ignore */
  }
  return emptyHubState();
}

function persist(s: HubState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function emit(): void {
  for (const l of [...listeners]) l();
}

function schedulePublish(): void {
  if (pubTimer !== null) window.clearTimeout(pubTimer);
  pubTimer = window.setTimeout(() => {
    pubTimer = null;
    lastPublishedAt = state.updatedAt;
    void publishState(state);
  }, 250);
}

export function getState(): HubState {
  return state;
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Apply a local edit (from the companion UI) and broadcast it to all devices. */
export function update(fn: (s: HubState) => HubState): void {
  state = { ...fn(state), updatedAt: Date.now() };
  persist(state);
  schedulePublish();
  emit();
}

/** Apply a state frame received from the relay (another device or our echo). */
export function applyRemote(next: HubState): void {
  if (!next?.sections) return;
  if (next.updatedAt === lastPublishedAt) return; // our own echo — already applied
  state = { ...next, updatedAt: next.updatedAt ?? Date.now() };
  persist(state);
  emit();
}

/** Seed the relay from local storage if the server has no state yet. */
export function seedIfEmpty(): void {
  const local = getState();
  const hasData =
    local.sections.todo.length > 0 || !!local.sections.docs || !!local.sections.notes;
  if (hasData) {
    lastPublishedAt = Date.now();
    void publishState({ ...local, updatedAt: lastPublishedAt });
  }
}

export function getConnStatus(): ConnStatus {
  return conn;
}

export function setConnStatus(s: ConnStatus): void {
  conn = s;
  for (const l of [...connListeners]) l(s);
}

export function subscribeConn(fn: (s: ConnStatus) => void): () => void {
  connListeners.add(fn);
  fn(conn);
  return () => {
    connListeners.delete(fn);
  };
}
