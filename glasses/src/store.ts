// Shared HubState store — the single source of truth for BOTH the companion UI
// (React, same page) and the glasses renderer. Persists to localStorage,
// publishes edits to the relay, and applies remote frames (ignoring our own
// echoes). This is what makes ONE app at ONE URL drive the web UI AND the
// glasses at the same time.
import { publishState } from './stream';
import { emptyHubState, type DocEntry, type HubState } from './types';

const LS_KEY = 'hub:state';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'error';

let state: HubState = loadLocal();
const listeners = new Set<() => void>();
let lastPublishedAt = 0;
let pubTimer: number | null = null;
// Set once the relay has answered the SSE handshake (or accepted a publish).
// Seeding before this point is how a stale browser copy used to overwrite a
// newer relay snapshot on a cold start — and how a client that could not reach
// the relay at all would clobber it the moment connectivity came back.
let sawServerState = false;
let serverReportedEmpty = false;
let seedArmed = false;
let seeded = false;

let conn: ConnStatus = 'idle';
const connListeners = new Set<(s: ConnStatus) => void>();

interface RawSections {
  todo?: unknown;
  docs?: unknown;
  notes?: unknown;
}
type RawState = Partial<HubState> & { sections?: RawSections };

function loadLocal(): HubState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptyHubState();
    const parsed = JSON.parse(raw) as RawState;
    if (!parsed?.sections) return emptyHubState();
    const base = { ...emptyHubState(), ...(parsed as Partial<HubState>) };
    // Migration: legacy builds stored Docs as a single string.
    let docs: DocEntry[];
    if (typeof parsed.sections.docs === 'string') {
      const legacy = parsed.sections.docs as string;
      docs = legacy
        ? [
            {
              id: legacy.length ? `doc-${Date.now()}` : '',
              title: 'Untitled',
              content: legacy,
              updatedAt: Date.now(),
            },
          ]
        : [];
      if (docs[0] && !docs[0].id) docs = [];
    } else if (Array.isArray(parsed.sections.docs)) {
      docs = (parsed.sections.docs as DocEntry[]).filter((d) => d && d.id && typeof d.content === 'string');
    } else {
      docs = [];
    }
    const state: HubState = {
      ...base,
      sections: {
        todo: Array.isArray(parsed.sections.todo) ? (parsed.sections.todo as HubState['sections']['todo']) : [],
        docs,
        notes: typeof parsed.sections.notes === 'string' ? parsed.sections.notes : '',
      },
      activeDocId:
        typeof parsed.activeDocId === 'string' && docs.some((d) => d.id === parsed.activeDocId)
          ? parsed.activeDocId
          : docs[0]?.id ?? null,
    };
    return state;
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
    void publishState(state).then((ok) => {
      if (ok) sawServerState = true;
    });
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
  sawServerState = true;
  if (next.updatedAt === lastPublishedAt) return; // our own echo — already applied
  state = { ...next, updatedAt: next.updatedAt ?? Date.now() };
  persist(state);
  emit();
}

/**
 * Arm a one-shot seed of the relay from local storage. The seed only actually
 * runs once the relay reports an EMPTY snapshot (`state: null`), so a client
 * that cannot reach the relay — or one that arrives after another device
 * already published — can never clobber newer server data.
 */
export function seedIfEmpty(): void {
  seedArmed = true;
  maybeSeed();
}

function maybeSeed(): void {
  if (!seedArmed || seeded || sawServerState || !serverReportedEmpty) return;
  const local = getState();
  const hasData =
    local.sections.todo.length > 0 ||
    local.sections.docs.length > 0 ||
    (local.sections.notes ?? '').trim().length > 0;
  if (!hasData) return;
  seeded = true;
  lastPublishedAt = Date.now();
  void publishState({ ...local, updatedAt: lastPublishedAt }).then((ok) => {
    if (ok) sawServerState = true;
  });
}

/**
 * Called when the relay's SSE handshake arrives. A snapshot means "don't seed";
 * a null snapshot means "server is empty", which is the only condition under
 * which a client may push its local copy.
 */
export function noteServerHandshake(hasSnapshot: boolean): void {
  if (hasSnapshot) {
    sawServerState = true;
    return;
  }
  serverReportedEmpty = true;
  maybeSeed();
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
