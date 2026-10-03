// Shared HubState store — the single source of truth for BOTH the companion UI
// (React, same page) and the glasses renderer.
//
// THE HUB IS THE AUTHORITY. Every read and every write goes to the backend
// through `web/hub-client.ts`; local state is an optimistic copy plus a cache, so
// a cold load paints instantly instead of flashing an empty list. Nothing here
// may win a conflict against the server: `rev` decides, and this module
// deliberately does NOT keep its own — `hub-client.ts` owns the single
// forward-only counter, so two counters cannot drift apart.
//
// What this replaced: localStorage WAS the source of truth and the relay
// live-synced whole state frames between devices, with a bespoke
// "never move backwards by updatedAt" rule to stop an older frame from wiping a
// newer list. That entire class of bug is gone — a real conflict is now a
// `409 STALE_REV` and the client retries with the server's own rev.
import {
  appendNotes as hubAppendNotes,
  clearDoneTodos as hubClearDone,
  createDoc as hubCreateDoc,
  createTodo as hubCreateTodo,
  deleteDoc as hubDeleteDoc,
  deleteTodo as hubDeleteTodo,
  fetchDoc as hubFetchDoc,
  fetchHub,
  onStaleState,
  patchHub,
  patchTodo as hubPatchTodo,
  putNotes as hubPutNotes,
  putTodos as hubPutTodos,
  renameDoc as hubRenameDoc,
  reorderTodos as hubReorderTodos,
  updateDocContent as hubUpdateDocContent,
  type HubSnapshot,
} from './web/hub-client';
import {
  emptyHubState,
  uid,
  type DocEntry,
  type FileRef,
  type HubState,
  type SectionId,
  type TodoItem,
} from './types';

const LS_KEY = 'hub:state';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'error';

let state: HubState = loadLocal();
const listeners = new Set<() => void>();
// Whether the hub has answered at least once. Until it has, the cached copy is
// all there is to paint; after it has, the hub wins every disagreement.
let hubLoaded = false;

let conn: ConnStatus = 'idle';
const connListeners = new Set<(s: ConnStatus) => void>();

interface RawSections {
  todo?: unknown;
  docs?: unknown;
  files?: unknown;
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
        // `sections` is rebuilt from explicit keys rather than spread, so a key
        // missing HERE is silently discarded on every reload — which for a cache
        // of remote references means the list empties itself after a restart.
        files: Array.isArray(parsed.sections.files)
          ? (parsed.sections.files as FileRef[]).filter(
              (f) => f && typeof f.id === 'string' && f.id.length > 0,
            )
          : [],
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

// ── write status ────────────────────────────────────────────────────────────

/**
 * A plain, honest failure surface.
 *
 * This app is ONLINE-FIRST by decision and keeps no outbox, so a write that never
 * reached the hub is REPORTED rather than queued. Swallowing it is the one thing
 * that would make this strictly worse than the live-sync it replaced: the user
 * would see their edit in the list and believe it had been saved.
 */
let hubError = '';
const errorListeners = new Set<(message: string) => void>();

export function getHubError(): string {
  return hubError;
}

export function subscribeHubError(fn: (message: string) => void): () => void {
  errorListeners.add(fn);
  fn(hubError);
  return () => {
    errorListeners.delete(fn);
  };
}

export function hubReady(): boolean {
  return hubLoaded;
}

function reportError(message: string): void {
  if (message === hubError) return;
  hubError = message;
  for (const l of [...errorListeners]) l(hubError);
}

/** Fold one hub result into the status chip and the error banner. */
function settle(res: { ok: boolean; error?: string; status?: number }, onOk?: () => void): void {
  if (res.ok) {
    reportError('');
    setConnStatus('open');
    onOk?.();
    return;
  }
  // `status 0` means no response at all — offline, or the relay is down. That is
  // a different condition from the hub refusing a request, and it is what the
  // "Offline" chip is for.
  setConnStatus(res.status === 0 ? 'error' : 'open');
  reportError(res.error || 'Could not reach the hub');
}

// One trailing-edge timer per target, so a burst of keystrokes collapses into a
// single write of the FINAL text rather than one request per character.
const writers = new Map<string, number>();
const EDIT_DEBOUNCE_MS = 400;
const CONTROL_DEBOUNCE_MS = 250;

function debounce(key: string, ms: number, run: () => void): void {
  const existing = writers.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  writers.set(
    key,
    window.setTimeout(() => {
      writers.delete(key);
      run();
    }, ms),
  );
}

// Per-document `ETag`. `PUT /hub/docs/{id}` is guarded by `If-Match`, and a write
// without one is refused outright (`412 IF_MATCH_REQUIRED`) — so a body that was
// read but whose etag was never kept could not be saved at all. Seeded by a read
// and refreshed from EVERY write response. The value arrives quoted and the
// quotes are part of it, like an `Idempotency-Key`'s hyphens.
const docEtags = new Map<string, string>();

/** Apply a local edit, cache it and repaint. Never touches the network. */
function commit(fn: (s: HubState) => HubState): void {
  state = { ...fn(state), updatedAt: Date.now() };
  persist(state);
  emit();
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

/**
 * Apply a LOCAL edit and repaint.
 *
 * Kept for the callers that only move the frame the UI is painted from — the
 * file cache, the AI's own focus. It does NOT write to the hub, so anything that
 * must survive a reload has to go through one of the semantic ops below; those
 * are the only places a route is chosen.
 */
export function update(fn: (s: HubState) => HubState): void {
  commit(fn);
}

/**
 * A whole-state frame from the relay's `hub` channel.
 *
 * ⚠ SUBORDINATE, AND SCHEDULED FOR REMOVAL. The hub is the authority now, so a
 * frame is only useful as BOOTSTRAP: it lets a device that has not yet reached
 * the hub paint the last known list instead of nothing. Once `loadHub` has
 * succeeded this is ignored outright — adopting a relay-cached copy over a
 * hub-backed one is precisely the stale-frame wipe this migration exists to end,
 * and no `updatedAt` tie-break can be trusted to tell the two apart.
 */
export function applyRemote(next: HubState): void {
  if (hubLoaded || !next?.sections) return;
  state = { ...next, updatedAt: Number(next.updatedAt) || Date.now() };
  persist(state);
  emit();
}

/**
 * DEPRECATED NO-OP — kept only so the relay's SSE wiring in `main.ts` still
 * compiles while the `hub` channel is retired.
 *
 * These two used to push the local copy to the relay when the server reported an
 * empty snapshot. That is now exactly the wrong thing to do: the hub is the
 * authority, and "my local list is the truth and the server is empty" is how one
 * device overwrites another's data. Seeding is a hub-side import now.
 */
export function seedIfEmpty(): void {
  /* the hub owns seeding */
}

export function noteServerHandshake(_hasSnapshot: boolean): void {
  /* the hub owns seeding */
}

// ── boot ────────────────────────────────────────────────────────────────────

/**
 * Load the whole state from the hub once and adopt it.
 *
 * `GET /hub` is a HEAVY read — it inlines every document's COMPLETE body (63 KB
 * across the 19 documents in this deployment) — so this runs at boot and after a
 * reconnect, never on a poll. It is also the only read that refreshes `rev` for
 * collections this device has not touched.
 */
export async function loadHub(): Promise<boolean> {
  wireStaleRefresh();
  const res = await fetchHub();
  if (!res.ok) {
    settle(res);
    return false;
  }
  hubLoaded = true;
  adopt(res.hub);
  settle(res);
  return true;
}

/** Adopt a server snapshot wholesale. The hub wins by definition. */
function adopt(snap: HubSnapshot): void {
  state = {
    activeSection: snap.activeSection,
    sections: snap.sections,
    activeDocId: snap.activeDocId,
    updatedAt: snap.updatedAt || Date.now(),
  };
  persist(state);
  emit();
}

let staleWired = false;

/**
 * A `409 STALE_REV` is not a dead end: the client already adopted the server's
 * rev and retried, so the user's own edit lands. What may still be missing is
 * another device's changes, so refresh the whole snapshot — but only AFTER the
 * pending writes have flushed, otherwise a read issued mid-edit would repaint
 * the list from under the user's cursor.
 */
function wireStaleRefresh(): void {
  if (staleWired) return;
  staleWired = true;
  onStaleState(() => debounce('stale-refresh', EDIT_DEBOUNCE_MS + 400, () => void loadHub()));
}

// ── todos ───────────────────────────────────────────────────────────────────

/**
 * Add a task.
 *
 * Optimistic: the row appears immediately under a LOCAL id, so the list cannot
 * lag behind a keystroke. The hub mints the real id, so the response swaps it in
 * (see `swapTodoId`). A failed write leaves the row alone — the user asked for it
 * and the failure is surfaced — and the next successful write converges the list.
 */
export function addTask(text: string): void {
  const clean = text.trim();
  if (!clean) return;
  const localId = uid();
  commit((s) => ({
    ...s,
    sections: { ...s.sections, todo: [...s.sections.todo, { id: localId, text: clean, done: false }] },
  }));
  void hubCreateTodo(clean).then((res) =>
    settle(res, () => {
      const item = res.item;
      if (item?.id && item.id !== localId) swapTodoId(localId, item);
    }),
  );
}

/**
 * Point the local row at the id the hub just minted — or RE-ADD it if a refresh
 * took it away.
 *
 * A `409` on any write triggers a debounced `loadHub`, and that read adopts the
 * hub's snapshot wholesale. If it lands between a create being issued and the
 * create's response, the optimistic row is gone by the time the response
 * arrives — so a rename alone would match nothing and the task would exist on
 * the hub while being invisible here until the next boot.
 */
function swapTodoId(localId: string, item: TodoItem): void {
  commit((s) => {
    const rows = s.sections.todo;
    if (rows.some((t) => t.id === localId)) {
      return { ...s, sections: { ...s.sections, todo: rows.map((t) => (t.id === localId ? { ...item } : t)) } };
    }
    if (rows.some((t) => t.id === item.id)) return s;
    return { ...s, sections: { ...s.sections, todo: [...rows, { ...item }] } };
  });
}

function patchTask(id: string, patch: { text?: string; done?: boolean }): void {
  commit((s) => ({
    ...s,
    sections: { ...s.sections, todo: s.sections.todo.map((t) => (t.id === id ? { ...t, ...patch } : t)) },
  }));
}

export function setTaskDone(id: string, done: boolean): void {
  patchTask(id, { done });
  void hubPatchTodo(id, { done }).then((res) => settle(res));
}

/** Debounced: a task title is typed character by character. */
export function setTaskText(id: string, text: string): void {
  patchTask(id, { text });
  debounce(`todo:${id}`, EDIT_DEBOUNCE_MS, () => void hubPatchTodo(id, { text }).then((res) => settle(res)));
}

export function removeTask(id: string): void {
  commit((s) => ({ ...s, sections: { ...s.sections, todo: s.sections.todo.filter((t) => t.id !== id) } }));
  void hubDeleteTodo(id).then((res) => settle(res));
}

/**
 * Replace the whole list in one write.
 *
 * Used by the paste categoriser, which rewrites the entire to-do section at
 * once: replaying that as individual creates would be N round trips and would
 * lose the fact that it is a single intent.
 */
export function setTasks(items: TodoItem[]): void {
  commit((s) => ({ ...s, sections: { ...s.sections, todo: items } }));
  void hubPutTodos(items).then((res) => settle(res, () => adoptTodos(res.items)));
}

/** The list IS the order, so a reorder sends the ids in their new sequence. */
export function reorderTasks(ids: string[]): void {
  void hubReorderTodos(ids).then((res) => settle(res, () => adoptTodos(res.items)));
}

export function clearDoneTasks(): void {
  commit((s) => ({ ...s, sections: { ...s.sections, todo: s.sections.todo.filter((t) => !t.done) } }));
  void hubClearDone().then((res) => settle(res, () => adoptTodos(res.items)));
}

/** Trust the server's list over the optimistic one whenever it is offered. */
function adoptTodos(items: TodoItem[]): void {
  if (!items.length && !getState().sections.todo.length) return;
  commit((s) => ({ ...s, sections: { ...s.sections, todo: items } }));
}

// ── docs ────────────────────────────────────────────────────────────────────

/**
 * Create a document and open it.
 *
 * Returns the OPTIMISTIC id straight away so a synchronous caller — an AI
 * capability building its `data` — has something to name. The hub mints the
 * real id, and `swapDocId` rewrites the row to it once the create lands, so the
 * returned value is only meaningful for the lifetime of that request.
 */
export function addDoc(title = 'Untitled', content = ''): string {
  const localId = uid();
  commit((s) => ({
    ...s,
    activeSection: 'docs',
    activeDocId: localId,
    sections: {
      ...s.sections,
      docs: [...s.sections.docs, { id: localId, title, content, updatedAt: Date.now() }],
    },
  }));
  void hubCreateDoc(title, content).then((res) =>
    settle(res, () => {
      const serverId = res.doc?.id;
      if (!serverId) return;
      if (serverId !== localId) swapDocId(localId, { id: serverId, title: res.doc?.title, content });
      if (res.etag) docEtags.set(serverId, res.etag);
    }),
  );
  return localId;
}

/**
 * Point the local row (and the open doc) at the id the hub just minted.
 *
 * UPSERTS rather than renames, for the same reason `swapTodoId` does — see
 * there. The row is rebuilt from the create's own request when the refresh won
 * the race, so the only thing lost is the hub's ordering, which the hub owns
 * anyway.
 */
function swapDocId(
  localId: string,
  created: { id: string; title?: string; content?: string; updatedAt?: number },
): void {
  const serverId = created.id;
  const etag = docEtags.get(localId);
  if (etag) {
    docEtags.delete(localId);
    docEtags.set(serverId, etag);
  }
  commit((s) => {
    const rows = s.sections.docs;
    const docs = rows.some((d) => d.id === localId)
      ? rows.map((d) => (d.id === localId ? { ...d, id: serverId } : d))
      : rows.some((d) => d.id === serverId)
        ? rows
        : [
            ...rows,
            {
              id: serverId,
              title: created.title ?? 'Untitled',
              content: created.content ?? '',
              updatedAt: created.updatedAt ?? Date.now(),
            },
          ];
    return {
      ...s,
      activeDocId: s.activeDocId === localId ? serverId : s.activeDocId,
      sections: { ...s.sections, docs },
    };
  });
}

/** Rename. METADATA ONLY on the wire, so it cannot clobber a body in flight. */
export function setDocTitle(id: string, title: string): void {
  patchDoc(id, { title, updatedAt: Date.now() });
  void hubRenameDoc(id, title).then((res) =>
    settle(res, () => {
      if (res.etag) docEtags.set(id, res.etag);
    }),
  );
}

function patchDoc(id: string, patch: Partial<DocEntry>): void {
  commit((s) => ({
    ...s,
    sections: {
      ...s.sections,
      docs: s.sections.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    },
  }));
}

/** Debounced: a document body is typed continuously. */
export function setDocContent(id: string, content: string): void {
  patchDoc(id, { content, updatedAt: Date.now() });
  debounce(`doc:${id}`, EDIT_DEBOUNCE_MS, () => {
    const live = getState().sections.docs.find((d) => d.id === id);
    if (live) void pushDocContent(id, live.content);
  });
}

/**
 * Replace a document's body, with the etag it needs.
 *
 * `GET /hub` does NOT carry per-document etags, so the first write after a boot
 * read has none — and the hub refuses it (`412 IF_MATCH_REQUIRED`) rather than
 * guessing. A moved etag means another device wrote. Both are recoverable the
 * same way: read the current etag and write once more. The local text is the
 * user's newest intent, so it wins; only a second refusal is reported.
 */
async function pushDocContent(id: string, content: string, attempt = 0): Promise<void> {
  const res = await hubUpdateDocContent(id, content, { etag: docEtags.get(id) });
  if (res.ok) {
    if (res.etag) docEtags.set(id, res.etag);
    settle(res);
    return;
  }
  if ((res.code === 'IF_MATCH_REQUIRED' || res.code === 'IF_MATCH_FAILED') && attempt < 1) {
    const read = await hubFetchDoc(id);
    if (read.ok && read.etag) {
      docEtags.set(id, read.etag);
      return pushDocContent(id, content, attempt + 1);
    }
  }
  settle(res);
}

/** Read one body and remember its etag, so the first save does not need a 412. */
export async function loadDoc(id: string): Promise<DocEntry | null> {
  const res = await hubFetchDoc(id);
  if (!res.ok || !res.doc) {
    settle(res);
    return null;
  }
  if (res.etag) docEtags.set(id, res.etag);
  const doc = res.doc;
  patchDoc(id, {
    title: doc.title,
    ...(typeof doc.content === 'string' ? { content: doc.content } : {}),
    updatedAt: doc.updatedAt || Date.now(),
  });
  return getState().sections.docs.find((d) => d.id === id) ?? null;
}

/** Append to a body. No hub route for this, so it is a read-modify-write. */
export function appendDoc(id: string, text: string): void {
  const cur = getState().sections.docs.find((d) => d.id === id);
  if (!cur) return;
  setDocContent(id, cur.content ? `${cur.content.replace(/\s+$/, '')}\n${text}` : text);
}

export function removeDoc(id: string): void {
  commit((s) => {
    const remaining = s.sections.docs.filter((d) => d.id !== id);
    return {
      ...s,
      activeDocId: s.activeDocId === id ? remaining[0]?.id ?? null : s.activeDocId,
      sections: { ...s.sections, docs: remaining },
    };
  });
  docEtags.delete(id);
  void hubDeleteDoc(id).then((res) => settle(res));
}

/**
 * Push a whole captured state back to the hub — the revert half of an AI batch
 * undo.
 *
 * The hub has ONE route per collection, so there is no "replace everything"
 * call: this replays the snapshot as the writes that produce it, and only the
 * differences, so an unchanged library costs nothing. A document that the
 * snapshot restores is recreated rather than resurrected — the hub mints ids, so
 * an id that was deleted cannot come back.
 */
export function restoreHub(snapshot: HubState): void {
  const cur = getState();
  const keep = new Set(snapshot.sections.docs.map((d) => d.id));
  for (const d of cur.sections.docs) if (!keep.has(d.id)) removeDoc(d.id);
  for (const d of snapshot.sections.docs) {
    const was = cur.sections.docs.find((x) => x.id === d.id);
    if (!was) addDoc(d.title, d.content);
    else if (was.title !== d.title) setDocTitle(d.id, d.title);
    if (was && was.content !== d.content) setDocContent(d.id, d.content);
  }
  setTasks(snapshot.sections.todo);
  setNotes(snapshot.sections.notes);
  selectSection(snapshot.activeSection);
  selectDoc(snapshot.activeDocId);
}

// ── notes ───────────────────────────────────────────────────────────────────

/** Debounced: the notes pane is typed into continuously. */
export function setNotes(text: string): void {
  commit((s) => ({ ...s, sections: { ...s.sections, notes: text } }));
  debounce('notes', EDIT_DEBOUNCE_MS, () => void hubPutNotes(getState().sections.notes).then((res) => settle(res)));
}

/**
 * Append one line.
 *
 * Preferred over `setNotes` for a dictated or streamed line: the SERVER does the
 * joining, so two devices appending at once cannot each overwrite the other with
 * their own idea of the old text.
 */
export function appendNote(text: string): void {
  commit((s) => ({
    ...s,
    sections: {
      ...s.sections,
      notes: s.sections.notes ? `${s.sections.notes.replace(/\s+$/, '')}\n${text}` : text,
    },
  }));
  void hubAppendNotes(text).then((res) =>
    settle(res, () => {
      const merged = res.content;
      if (typeof merged === 'string') commit((s) => ({ ...s, sections: { ...s.sections, notes: merged } }));
    }),
  );
}

// ── control plane ───────────────────────────────────────────────────────────

/** Which doc is open. Persisted so the glasses reopen where the wearer left off. */
export function selectDoc(id: string | null): void {
  commit((s) => ({ ...s, activeDocId: id }));
  if (id) void loadDoc(id);
  pushControl();
}

export function selectSection(section: SectionId): void {
  commit((s) => ({ ...s, activeSection: section }));
  pushControl();
}

/**
 * `PATCH /hub` takes BOTH control fields and needs a rev. Both are sent from the
 * current state under one shared timer, so a flurry of taps is a single write.
 */
function pushControl(): void {
  debounce('control', CONTROL_DEBOUNCE_MS, () => {
    const s = getState();
    void patchHub({ activeDocId: s.activeDocId, activeSection: s.activeSection }).then((res) =>
      settle(res, () => {
        // Adopt only the two control fields: the response carries a whole
        // snapshot, and repainting sections from it could undo a concurrent
        // local edit that has not been written yet.
        state = {
          ...state,
          activeSection: res.hub.activeSection,
          activeDocId: res.hub.activeDocId,
        };
        persist(state);
        emit();
      }),
    );
  });
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
