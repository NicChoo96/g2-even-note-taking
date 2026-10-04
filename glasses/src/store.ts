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
  fetchDocs,
  fetchHub,
  fetchNotes,
  fetchTodos,
  onStaleState,
  patchHub,
  patchTodo as hubPatchTodo,
  putNotes as hubPutNotes,
  putTodos as hubPutTodos,
  renameDoc as hubRenameDoc,
  reorderTodos as hubReorderTodos,
  updateDocContent as hubUpdateDocContent,
  type DocMeta,
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

// ── confirmed writes ────────────────────────────────────────────────────────

/**
 * What a write REALLY did — the return value a caller needs in order to be
 * honest with the wearer.
 *
 * `ok` is only ever set from a RE-READ (see `confirmWrite`), never from the
 * hub's own acknowledgement. The two are different claims: the hub answers
 * about the request it received, and the wearer's question is about the list
 * they are looking at.
 */
export interface WriteOutcome {
  ok: boolean;
  /** The hub took the write, and the list still does not show it. */
  unconfirmed?: boolean;
  error?: string;
}

/** The failure fields every hub result carries (`HubError` in hub-client.ts). */
interface WriteResult {
  ok: boolean;
  error?: string;
  code?: string;
  status?: number;
  item?: TodoItem;
}

/**
 * Name the failure the wearer can act on.
 *
 * A `401` is not a network problem and must not be allowed to read like one. It
 * means the relay does not recognise this device's token: the pairing was reset,
 * or the token was never re-supplied after a reload (`auth-token.ts` holds it in
 * memory only). "Could not reach the hub" sent the wearer looking at their signal
 * for what is really a sign-in problem — and a whole session of writes can be
 * lost that way while every one of them looks like it worked.
 */
function whyRefused(res: WriteResult): string {
  if (res.status === 401) return 'this device is not signed in to the hub, so nothing was saved';
  if (res.code === 'STALE_REV') return 'another device changed the list first, so nothing was saved';
  return res.error || 'the hub refused the write';
}

/** Run a hub call, turning a thrown transport error into `null` instead of a rejection. */
async function safeCall<T extends WriteResult>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Write, then READ BACK, and only then call it done.
 *
 * `settle` above states the policy this app runs on — a write that never reached
 * the hub is REPORTED rather than queued — but reporting a failure is not the
 * same as refusing to claim success, and the claim is the thing the wearer acts
 * on. Two halves had to be true at once for a lost write to be invisible:
 *
 *   1. Every `todo.*` capability returned `ok: true` before the hub had answered
 *      at all, so Jarvis said the task was saved either way.
 *   2. The store kept the optimistic row when the answer was a refusal, and
 *      `persist()` mirrored it, so the row survived a reload too.
 *
 * A confirmed write closes both: it sends the change AND re-reads the list,
 * checks the change is really in it (`holds`), and adopts the hub's list either
 * way. A write that did not land therefore cannot stay on screen looking as
 * though it had — and the caller is told, in time to say so.
 *
 * The re-read is not redundant with the acknowledgement. A `PATCH` can be
 * accepted and leave the row untouched (it named a task another device had
 * already deleted), and a stale-token `401` is indistinguishable from success
 * without a read that disagrees.
 */
async function confirmWrite(
  send: () => Promise<WriteResult>,
  holds: (res: WriteResult, items: TodoItem[]) => boolean,
): Promise<WriteOutcome> {
  const res = await safeCall(send);
  if (!res) return { ok: false, error: 'could not reach the hub, so nothing was saved' };
  settle(res);
  if (!res.ok) return { ok: false, error: whyRefused(res) };

  const read = await safeCall(fetchTodos);
  if (!read) return { ok: false, error: 'the write was sent but the list could not be read back' };
  settle(read);
  if (!read.ok) return { ok: false, error: `the write was sent but ${whyRefused(read)}` };

  adoptTodos(read.items);
  if (!holds(res, read.items)) {
    return { ok: false, unconfirmed: true, error: 'the hub accepted it and the list still does not show it' };
  }
  return { ok: true };
}

/** Whether two lists hold exactly the same tasks, by id. */
function sameIds(a: TodoItem[], b: TodoItem[]): boolean {
  if (a.length !== b.length) return false;
  const want = new Set(b.map((t) => t.id));
  return a.every((t) => want.has(t.id));
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

/**
 * Drop a pending debounced write because a newer one has been sent.
 *
 * Without this a one-shot rename would be followed `EDIT_DEBOUNCE_MS` later by
 * the timer a keystroke had already armed, writing the text it was about to
 * supersede — and with confirmation on both sides, two answers for one row.
 */
function cancelDebounce(key: string): void {
  const existing = writers.get(key);
  if (existing === undefined) return;
  window.clearTimeout(existing);
  writers.delete(key);
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

// ── live sync ───────────────────────────────────────────────────────────────

/**
 * Refetch ONE collection because a PEER device changed it (§2.4).
 *
 * WHY NOT JUST `loadHub()`: that read inlines every document body (63 KB across
 * the 19 documents in this deployment) and replaces `activeSection` and
 * `activeDocId` with the server's — so a peer ticking one to-do would repaint
 * the entire app and could pull the wearer out of the document they are reading.
 * Only the collection the nudge named is read.
 *
 * `/files` and `/` really do fall back to the snapshot, and for one reason each:
 * a file appears in HubState as a `FileRef` and this store has no read that
 * returns `FileRef[]` on its own, and `/` IS the state document, so the snapshot
 * read is the only read that names it.
 *
 * EVERYTHING ELSE IS DROPPED ON PURPOSE — `/sessions`, `/memory`, `/ledger`,
 * `/settings`, `/relay`. Those collections never move `rev`, are not part of
 * HubState, and their screens read them on demand; turning such a frame into a
 * snapshot read would cost 63 KB to learn nothing.
 *
 * DEBOUNCED PER COLLECTION: a peer typing in a document produces a nudge per
 * write, and eight reads where one will do is just load. The delay also lets the
 * peer's own writer settle, mirroring `wireStaleRefresh` above.
 */
export function refreshSection(path: string): void {
  const one = `/${String(path).split('/').filter(Boolean)[0] ?? ''}`;
  if (one === '/') {
    void loadHub();
    return;
  }
  if (one === '/files') {
    debounce('peer-files', EDIT_DEBOUNCE_MS, () => void loadHub());
    return;
  }
  if (one === '/todos') {
    debounce('peer-todos', EDIT_DEBOUNCE_MS, () => {
      void fetchTodos().then((res) => settle(res, () => adoptTodos(res.items)));
    });
    return;
  }
  if (one === '/notes') {
    debounce('peer-notes', EDIT_DEBOUNCE_MS, () => {
      void fetchNotes().then((res) => {
        settle(res, () => {
          // Only when it really differs. This frame is usually the echo of an
          // append this very tab made a moment ago (the relay skips only the
          // socket it can identify), and committing identical text would emit a
          // state change and repaint every surface for nothing.
          if (res.content !== getState().sections.notes) {
            commit((s) => ({ ...s, sections: { ...s.sections, notes: res.content } }));
          }
        });
      });
    });
    return;
  }
  if (one === '/docs') {
    debounce('peer-docs', EDIT_DEBOUNCE_MS, () => {
      void fetchDocs().then((res) => settle(res, () => adoptDocs(res.items)));
    });
  }
}

/**
 * Merge the server's document LIST into the local one.
 *
 * The list read does not include bodies — that is opt-in because a body is
 * unbounded — so replacing `sections.docs` outright would set every `content` to
 * `undefined` and blank the document the wearer has open. The server owns WHICH
 * documents exist and what they are called; a body already held locally is kept.
 *
 * A document the server no longer lists is dropped, and if it was the open one
 * the view falls back rather than pointing at nothing.
 */
function adoptDocs(metas: DocMeta[]): void {
  if (!metas.length && !getState().sections.docs.length) return;
  const have = new Map(getState().sections.docs.map((d) => [d.id, d]));
  const docs: DocEntry[] = metas.map((m) => ({
    id: m.id,
    title: m.title,
    content: typeof m.content === 'string' ? m.content : (have.get(m.id)?.content ?? ''),
    updatedAt: m.updatedAt,
  }));
  const open = getState().activeDocId;
  commit((s) => ({
    ...s,
    sections: { ...s.sections, docs },
    activeDocId: open && docs.some((d) => d.id === open) ? open : null,
  }));
}

let liveWired = false;

/**
 * Catch up after the tab was away (§2.4).
 *
 * A NUDGE ONLY ARRIVES IF THE SOCKET WAS OPEN. A backgrounded phone, a closed
 * lid or a sleeping laptop drops the stream, and the relay replays nothing a
 * client missed — so a device that comes back after an hour would otherwise be
 * showing an hour-old list with no sign anything is wrong. Re-reading on return
 * is what closes that gap. It is ONE read on one event, never a poll.
 *
 * Debounced because a single app switch can fire `focus`, `visibilitychange` and
 * a resize in quick succession, and there is no reason to read three times.
 *
 * Only AFTER the first successful load: the boot path owns the first read, and
 * racing it would fire a request before the credential is even attached.
 */
export function startHubLiveSync(): void {
  if (liveWired) return;
  liveWired = true;
  const back = (): void => {
    if (!hubLoaded) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    debounce('foreground-refresh', CONTROL_DEBOUNCE_MS + 150, () => void loadHub());
  };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
}

// ── todos ───────────────────────────────────────────────────────────────────

/**
 * Add a task.
 *
 * Optimistic: the row appears immediately under a LOCAL id, so the list cannot
 * lag behind a keystroke. The hub mints the real id, and the confirmation's
 * re-read REPLACES the whole list with the hub's own — so the local id only ever
 * lives for the length of that one request.
 *
 * That read-back is also what retired `swapTodoId`. It could only rewrite the
 * local row while the row was still there, so a refresh landing between a create
 * and its response left a `uid()` row the hub had never heard of: a visible
 * duplicate, and a `404` on the next rename of it. Adopting the hub's list needs
 * nothing to match.
 */
export async function addTask(text: string): Promise<WriteOutcome> {
  const clean = text.trim();
  if (!clean) return { ok: false, error: 'no task text given' };
  const localId = uid();
  commit((s) => ({
    ...s,
    sections: { ...s.sections, todo: [...s.sections.todo, { id: localId, text: clean, done: false }] },
  }));
  // Confirmed against the id THE HUB MINTS, not against the text: a task with
  // this text may already be on the list, and a text match would then report a
  // create that never happened as a success.
  return confirmWrite(
    () => hubCreateTodo(clean),
    (res, items) => !!res.item?.id && items.some((t) => t.id === res.item?.id),
  );
}

function patchTask(id: string, patch: { text?: string; done?: boolean }): void {
  commit((s) => ({
    ...s,
    sections: { ...s.sections, todo: s.sections.todo.map((t) => (t.id === id ? { ...t, ...patch } : t)) },
  }));
}

export async function setTaskDone(id: string, done: boolean): Promise<WriteOutcome> {
  patchTask(id, { done });
  return confirmWrite(
    () => hubPatchTodo(id, { done }),
    (_res, items) => items.some((t) => t.id === id && t.done === done),
  );
}

/**
 * Debounced: a task title is typed character by character.
 *
 * Deliberately NOT the confirmed form. This one runs on every keystroke of a
 * human edit, and the confirmation adopts the hub's list — which would discard
 * unsent text in any OTHER row the moment this row's timer fired. The banner is
 * this path's failure surface, as the policy above promises. A caller with no
 * next keystroke to flush the timer wants `setTaskTextNow`.
 */
export function setTaskText(id: string, text: string): void {
  patchTask(id, { text });
  debounce(`todo:${id}`, EDIT_DEBOUNCE_MS, () => void hubPatchTodo(id, { text }).then((res) => settle(res)));
}

/**
 * The one-shot rename — what a delegated action uses.
 *
 * `setTaskText` arms a 400 ms timer, so awaiting it would answer from inside the
 * debounce window, before the hub had heard anything: a rename reported as done
 * that had not been sent yet. This sends immediately, cancels any timer already
 * armed for the row, and waits for the re-read before answering.
 */
export async function setTaskTextNow(id: string, text: string): Promise<WriteOutcome> {
  patchTask(id, { text });
  cancelDebounce(`todo:${id}`);
  return confirmWrite(
    () => hubPatchTodo(id, { text }),
    (_res, items) => items.some((t) => t.id === id && t.text === text),
  );
}

export async function removeTask(id: string): Promise<WriteOutcome> {
  commit((s) => ({ ...s, sections: { ...s.sections, todo: s.sections.todo.filter((t) => t.id !== id) } }));
  // A rename armed for this row would now write to a task that no longer exists.
  cancelDebounce(`todo:${id}`);
  return confirmWrite(
    () => hubDeleteTodo(id),
    (_res, items) => !items.some((t) => t.id === id),
  );
}

/**
 * Replace the whole list in one write.
 *
 * Used by the paste categoriser, which rewrites the entire to-do section at
 * once: replaying that as individual creates would be N round trips and would
 * lose the fact that it is a single intent. It is also the only sane way to
 * empty the list, so `todo.clear_all` comes through here too.
 */
export async function setTasks(items: TodoItem[]): Promise<WriteOutcome> {
  commit((s) => ({ ...s, sections: { ...s.sections, todo: items } }));
  return confirmWrite(
    () => hubPutTodos(items),
    (_res, list) => sameIds(list, items),
  );
}

/** The list IS the order, so a reorder sends the ids in their new sequence. */
export function reorderTasks(ids: string[]): void {
  void hubReorderTodos(ids).then((res) => settle(res, () => adoptTodos(res.items)));
}

export async function clearDoneTasks(): Promise<WriteOutcome> {
  commit((s) => ({ ...s, sections: { ...s.sections, todo: s.sections.todo.filter((t) => !t.done) } }));
  return confirmWrite(
    () => hubClearDone(),
    (_res, items) => !items.some((t) => t.done),
  );
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
