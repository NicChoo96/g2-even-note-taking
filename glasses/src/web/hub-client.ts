// Browser-side client for the Jarvis Content Hub — the backend that now owns
// every piece of app data (todos, docs, notes, files, agents, tools, sessions,
// memory, ledger, settings).
//
// WHY EVERY CALL GOES THROUGH THE RELAY
//   The hub is a separate service (`web/server/hub-api.mjs` proxies it) and the
//   browser must never talk to it directly, for the same three reasons the
//   document store goes through the relay:
//     1. Its CORS allow-list is EMPTY — `GET /config` reports `cors_origins: []`,
//        and a preflight comes back `204` with no `Access-Control-Allow-Origin`
//        at all, so a direct call cannot complete. Measured live.
//     2. The credential is a SERVER secret. Locking one shared backend account
//        plus one rotating session is what makes the hub reachable at all; that
//        session must never exist in this bundle.
//     3. It is the same origin as the document store, which sends
//        `X-Frame-Options: SAMEORIGIN`.
//   So the relay is not a convenience here — it is the only path that exists.
//   It signs each call with the shared session, adds the hub prefix, and hands
//   back the upstream status and body VERBATIM.
//
// WHAT THIS MODULE OWNS — all of it deliberately kept OUT of the relay, because
// it is per-user interaction state rather than transport:
//   • the `rev` write token, cached from the freshest response and adopted from
//     a 409 rather than refetched
//   • `Idempotency-Key` — ONE canonical uuid v4 per user ACTION, replayed
//     verbatim across a retry so a lost response cannot double-apply a write
//   • `If-Match` — the etag guard that the routes which do NOT take a `rev` use
//     instead
//   • both error SHAPES, which differ on purpose
//
// ⚠ TWO ERROR SHAPES, AND WHY `"ok" in body` IS CHECKED FIRST
//   The backend is one service with two API families sharing one credential. The
//   HUB answers `{ok:false, error:"message", code:"CODE", details:{}}` where
//   `error` is a STRING; the GATEWAY answers `{error:{code,message,detail}}`
//   where it is an OBJECT. Reading `body.error.code` on a hub reply silently
//   yields `undefined` — a real bug this codebase has already had — so the
//   envelope is identified by `ok` before anything is read out of it.
import { getStreamToken, notifyAuthRejected } from '../auth-token';
import { clientId } from '../client-id';
import { API_BASE } from '../stream';
import type { Effect, EntryBy, EntryKind, EntryLocus, EntryStatus } from '../ai/ledger';
import {
  normalizeTool,
  SECTION_IDS,
  type AgentDef,
  type DocEntry,
  type FileRef,
  type HubState,
  type SectionId,
  type TodoItem,
  type ToolDef,
} from '../types';

/**
 * The hub's own state document — the same shape this app already ships as
 * `HubState`, which is why the migration is a straight swap rather than a
 * translation. `sections.docs` carries a FULL BODY each; see `fetchHub`.
 */
export interface HubSnapshot {
  activeSection: SectionId;
  activeDocId: string | null;
  sections: HubState['sections'];
  updatedAt: number;
}

/**
 * A document as the LIST reports it.
 *
 * Deliberately not `DocEntry`: the list omits `content` unless it was asked for
 * (`GET /hub/docs?include=content`), and typing the body as a required string
 * would make "not requested" indistinguishable from "empty" — so a caller could
 * render a blank document over a full one without any error anywhere.
 */
export interface DocMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** Present only when the request included content. */
  content?: string;
}

/** Fields every failure carries. Mirrors the relay's own `{ok,error,code}`. */
export interface HubError {
  error?: string;
  /** The hub's machine code, e.g. `STALE_REV`. Never read from `error.code`. */
  code?: string;
  status?: number;
  /** The hub's `details` object, verbatim. Only a 409 `current`/`rev` is used. */
  details?: Record<string, unknown>;
}

export interface HubRequestResult<T = unknown> extends HubError {
  ok: boolean;
  status: number;
  /** The parsed body, or `null` — a `204` has none, and calling `.json()` on it
   *  throws even though the write succeeded. */
  data: T | null;
  /** True when a replayed `Idempotency-Key` had already landed. A SUCCESS. */
  duplicate: boolean;
  /** The `ETag` to send back as `If-Match` on the next write of this object. */
  etag?: string;
}

export interface HubConfigResult extends HubError {
  ok: boolean;
  /** The prefix the hub really lives under, read from `GET /config`. */
  hubPrefix: string;
}

export interface HubSnapshotResult extends HubError {
  ok: boolean;
  rev: number;
  hub: HubSnapshot;
}

export interface TodoListResult extends HubError {
  ok: boolean;
  rev: number;
  items: TodoItem[];
}

export interface TodoWriteResult extends HubError {
  ok: boolean;
  rev: number;
  item: TodoItem;
  duplicate: boolean;
}

export interface DocListResult extends HubError {
  ok: boolean;
  rev: number;
  items: DocMeta[];
}

export interface DocWriteResult extends HubError {
  ok: boolean;
  rev: number;
  doc: DocMeta | null;
  duplicate: boolean;
  etag?: string;
}

/**
 * One document read, with the etag that must come back on the next write.
 *
 * The etag is not optional decoration: `PUT /hub/docs/{id}` is guarded by
 * `If-Match`, so a caller that reads a body and cannot present the etag has no
 * way to save it — the hub refuses with `412 IF_MATCH_REQUIRED` and the edit is
 * lost. Returning `DocMeta` alone is what made that trap reachable, which is why
 * this carries the header out of the response.
 *
 * The value arrives QUOTED (`"1790181965349:6fb413f8af3cb497"`, verified live)
 * and must be echoed verbatim — like an `Idempotency-Key`'s hyphens, the quoting
 * is part of the value and stripping it produces an `IF_MATCH_FAILED`.
 */
export interface DocReadResult extends HubError {
  ok: boolean;
  doc: DocMeta | null;
  etag?: string;
}

export interface NotesResult extends HubError {
  ok: boolean;
  rev: number;
  content: string;
}

/**
 * The write token.
 *
 * `rev` guards the collections it changes: todo, docs, notes, files and agents.
 * It does NOT move for sessions, memory, ledger or settings, so a caller must
 * never wait on it to observe a change in one of those.
 *
 * It is cached from the freshest response and never persisted — a stored rev is
 * a stale rev, and the server rejects those on purpose. Only ever moves forward:
 * responses can arrive out of order, and a backwards rev would fail a write that
 * would otherwise have succeeded.
 */
let rev = 0;

export function currentRev(): number {
  return rev;
}

/** Adopt a rev observed anywhere — a response body, or an SSE frame. */
export function noteRev(next: number | undefined | null): void {
  const n = Number(next);
  if (Number.isFinite(n) && n > rev) rev = n;
}

// The state that a 409 hands back, for whoever is holding the local copy. The
// refusal is not a dead end: the hub includes the CURRENT state and the
// authoritative rev, so the caller can merge and move on without a second round
// trip — and without a window for a third writer to slip in between.
const staleListeners = new Set<(snapshot: HubSnapshot) => void>();

export function onStaleState(fn: (snapshot: HubSnapshot) => void): () => void {
  staleListeners.add(fn);
  return () => {
    staleListeners.delete(fn);
  };
}

/**
 * A canonical uuid v4, hyphens included.
 *
 * The hub validates `Idempotency-Key` as a uuid v4 and rejects a bare 32-char
 * hex string with `400 VALIDATION_ERROR "Idempotency-Key must be a uuid v4"`.
 * That rule is in no published document — it was found by probing — so the
 * hyphens are load-bearing and must never be stripped.
 */
export function canonicalUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // A WebView without `randomUUID` still has `getRandomValues`; build the v4
  // shape by hand rather than fall back to something that would be refused.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const token = getStreamToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/**
 * Read an error out of a response body, from EITHER family.
 *
 * See the file header: a hub reply puts a string in `error` and a code beside
 * it, a gateway reply nests an object. Both are handled, and the gateway branch
 * never touches `body.code` — on a gateway reply that key does not exist.
 */
function readError(body: unknown, status: number): HubError {
  const b = body as
    | { ok?: unknown; error?: unknown; code?: unknown; details?: Record<string, unknown> }
    | null;
  if (b && typeof b === 'object') {
    if ('ok' in b) {
      // Hub envelope (and the relay's own errors, which copy this shape).
      const detail = typeof b.details === 'object' && b.details !== null ? b.details : undefined;
      const code = typeof b.code === 'string' ? b.code : undefined;
      return {
        error: typeof b.error === 'string' && b.error ? b.error : `HTTP ${status}`,
        code,
        status,
        details: detail,
      };
    }
    if (b.error && typeof b.error === 'object') {
      // Gateway envelope: `{error:{code,message,detail}}`.
      const e = b.error as { code?: string; message?: string; detail?: string };
      return { error: e.message || e.detail || e.code || `HTTP ${status}`, code: e.code, status };
    }
    if (typeof b.error === 'string' && b.error) {
      return { error: b.error, code: typeof b.code === 'string' ? b.code : undefined, status };
    }
  }
  return { error: `HTTP ${status}`, status };
}

/**
 * Just the failure fields, so every wrapper can spread them onto its own shape
 * without repeating the four keys — and without dropping `details`, which is
 * where a `STALE_REV` carries the state to merge.
 */
function pick(err: HubError): HubError {
  return { error: err.error, code: err.code, status: err.status, details: err.details };
}

export interface HubRequestOptions {
  body?: Record<string, unknown>;
  /**
   * Stamp the current `rev` into the body, and retry while the server says it is
   * stale. Set this on exactly the routes the hub guards with `rev`.
   */
  rev?: boolean;
  /** Reuse a specific key. Normally omitted — one is generated per call. */
  key?: string;
  /** Send `Idempotency-Key`. On by default for every non-GET request. */
  idempotent?: boolean;
  /** `If-Match`, for the routes guarded by an etag instead of a rev. */
  etag?: string;
  signal?: AbortSignal;
}

const HUB_BASE = `${API_BASE}/api/hub`;

/**
 * How many times a stale rev is retried before the write is reported as failed.
 *
 * More than one is required, and the reason is not exotic. `rev` is a single
 * per-user token, so two writes that both carry it are one guaranteed refusal
 * no matter how they are scheduled — and a `DELETE` is worse than that: it
 * answers `204` with no body and NO `ETag` or rev header at all (probed live),
 * so deleting anything leaves this client holding a stale rev with no way to
 * learn the new one. Every write that follows a delete is therefore a certified
 * first-attempt refusal, and one retry would leave a second concurrent write
 * unsaved. A retry is one cheap round trip; a silently dropped edit is not.
 */
const MAX_STALE_RETRIES = 3;

/**
 * One mutating request at a time.
 *
 * Serialising the WRITES is what makes `rev` usable at all: it is a single
 * per-user token, so writes issued in the same tick cannot both be valid, and a
 * burst (an undo replaying a diff, a paste categoriser, an agent batch) would
 * otherwise spray refusals and lose the overflow.
 *
 * An IDLE queue runs the job at once rather than on a microtask, so an ordinary
 * single write is issued in the same tick as the caller — byte for byte the
 * behaviour that predates this guard. Only the second and later writes of a
 * burst wait, and they wait for a rev that is by then already fresh.
 *
 * Reads are deliberately NOT queued, so a read never waits behind a write; and
 * no job waits on the queue itself, because each job is one fetch that the
 * CALLER awaits, so this cannot deadlock.
 */
let writeTail: Promise<unknown> = Promise.resolve();
let writesInFlight = 0;

function writeFinished(): void {
  writesInFlight -= 1;
}

function serialiseWrite<T>(job: () => Promise<T>): Promise<T> {
  if (writesInFlight === 0) {
    writesInFlight = 1;
    const running = job();
    writeTail = running.then(writeFinished, writeFinished);
    return running;
  }
  writesInFlight += 1;
  const next = writeTail.then(job, job);
  writeTail = next.then(writeFinished, writeFinished);
  return next;
}

/** One request, retried on a stale rev. Never throws. */
export function hubRequest<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: HubRequestOptions = {},
): Promise<HubRequestResult<T>> {
  // A GET carries no rev and cannot be refused as stale, so it is never queued:
  // a read must never wait behind an unrelated write.
  if (method === 'GET') return sendRequest<T>(method, path, opts);
  return serialiseWrite(() => sendRequest<T>(method, path, opts));
}

async function sendRequest<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: HubRequestOptions = {},
): Promise<HubRequestResult<T>> {
  // ONE key per user ACTION, not per HTTP attempt: it is generated here and
  // reused across the stale-rev retry below. That is what makes the retry safe
  // when the FIRST attempt actually landed and only its response was lost — the
  // replay comes back `Duplicate: true` instead of adding a second row.
  const key = opts.key ?? canonicalUuid();
  const sendsKey = method !== 'GET' && opts.idempotent !== false;

  for (let attempt = 0; ; attempt += 1) {
    const payload = opts.rev ? { ...(opts.body ?? {}), rev } : opts.body;
    const headers = authHeaders(payload !== undefined);
    if (sendsKey) headers['Idempotency-Key'] = key;
    // WHICH PAGE wrote this. The relay echoes it back as the `origin` of the
    // `hub-changed` nudge, so this tab can ignore the echo of its own write
    // instead of refetching a document someone is still typing in (§2.2). It is
    // addressed to the RELAY, never the hub — the passthrough forwards only
    // `Idempotency-Key` and `If-Match` on purpose — so a deployment that does not
    // know the header behaves exactly as it did before.
    if (method !== 'GET') headers['X-Client-Id'] = clientId();
    if (opts.etag) headers['If-Match'] = opts.etag;

    let res: Response;
    try {
      res = await fetch(`${HUB_BASE}${path}`, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: opts.signal,
      });
    } catch (err) {
      // No response at all: offline, DNS, or the relay is down. Surfaced as a
      // plain failure — this app is online-first by decision, with no outbox to
      // reconcile, so a write that never reached the server is simply reported.
      return {
        ok: false,
        status: 0,
        data: null,
        duplicate: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const etag = res.headers.get('etag') ?? undefined;

    if (res.status === 401) notifyAuthRejected();

    // A `204` (and any 2xx with no body) is a SUCCESS with nothing to parse.
    // Reading `.json()` here throws on a delete that worked perfectly.
    if (res.status === 204 || res.status === 205) {
      return { ok: true, status: res.status, data: null, duplicate: false, etag };
    }

    const text = await res.text().catch(() => '');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null; // e.g. the SPA's index.html from a misrouted request
      }
    }

    const flag =
      (body as { Duplicate?: unknown; duplicate?: unknown } | null)?.Duplicate ??
      (body as { duplicate?: unknown } | null)?.duplicate;
    const duplicate = res.headers.get('duplicate') === 'true' || flag === true;

    // `ok` is the hub's own success flag; the relay's responses carry it too.
    const okFlag = (body as { ok?: unknown } | null)?.ok;
    if (!res.ok || okFlag === false) {
      const failure = readError(body, res.status);
      // The server's rev is authoritative and the retry must use ITS number.
      // NOTE: the integration document claims `details.current` is "a complete
      // GET /hub body"; the server actually returns the hub STATE at
      // `details.current` with the rev as a SIBLING at `details.rev`, so
      // `details.current.rev` is always null. Probed live.
      if (failure.code === 'STALE_REV' && opts.rev && attempt < MAX_STALE_RETRIES) {
        adoptStaleRev(failure.details);
        continue;
      }
      return { ok: false, status: res.status, data: null, duplicate, etag, ...failure };
    }

    const data = (body ?? null) as T | null;
    const nextRev = (data as { rev?: unknown } | null)?.rev;
    noteRev(typeof nextRev === 'number' ? nextRev : undefined);
    return { ok: true, status: res.status, data, duplicate, etag };
  }
}

/** Take the rev (and the state, when present) out of a `STALE_REV` refusal. */
function adoptStaleRev(details: Record<string, unknown> | undefined): void {
  if (!details) return;
  const n = Number(details.rev);
  if (Number.isFinite(n)) rev = n;
  const current = details.current;
  if (!current || typeof current !== 'object') return;
  const snapshot = normaliseSnapshot(current);
  for (const fn of [...staleListeners]) fn(snapshot);
}

function isTodo(v: unknown): v is TodoItem {
  const o = v as Partial<TodoItem> | null;
  return !!o && typeof o.id === 'string' && typeof o.text === 'string' && typeof o.done === 'boolean';
}

function isDocMeta(v: unknown): v is DocMeta {
  const o = v as Partial<DocMeta> | null;
  return !!o && typeof o.id === 'string' && typeof o.title === 'string';
}

/**
 * Shape a `hub` object into something the app can render without further
 * checking. The hub always sends all four sections, but a fresh account sends an
 * empty `hub`, and a malformed frame must not be able to empty the UI silently.
 */
export function normaliseSnapshot(raw: unknown): HubSnapshot {
  const h = (raw ?? {}) as Partial<HubSnapshot>;
  const s = (h.sections ?? {}) as Partial<HubSnapshot['sections']>;
  return {
    activeSection: (SECTION_IDS as string[]).includes(h.activeSection as string)
      ? (h.activeSection as SectionId)
      : 'todo',
    activeDocId: typeof h.activeDocId === 'string' && h.activeDocId ? h.activeDocId : null,
    sections: {
      todo: Array.isArray(s.todo) ? s.todo.filter(isTodo) : [],
      docs: Array.isArray(s.docs)
        ? (s.docs as DocEntry[]).filter((d) => !!d && typeof d.id === 'string')
        : [],
      files: Array.isArray(s.files) ? (s.files as FileRef[]).filter((f) => !!f && !!f.id) : [],
      notes: typeof s.notes === 'string' ? s.notes : '',
    },
    updatedAt: Number(h.updatedAt) || 0,
  };
}

// ── transport status ────────────────────────────────────────────────────────

/**
 * Is the hub wired up on the relay, and under what prefix?
 *
 * Cheap and credential-only, like `/api/files/status`: it says whether the relay
 * HOLDS a session, never whether the backend is reachable, so a brief outage
 * cannot make the page claim the feature is unconfigured.
 */
export async function fetchHubConfig(): Promise<HubConfigResult> {
  try {
    const res = await fetch(`${HUB_BASE}/config`, { headers: authHeaders() });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; hubPrefix?: string; error?: string; code?: string }
      | null;
    if (!res.ok || body?.ok !== true) {
      return { ok: false, hubPrefix: '', ...readError(body, res.status) };
    }
    return { ok: true, hubPrefix: body?.hubPrefix || '/hub' };
  } catch (err) {
    return { ok: false, hubPrefix: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ── control plane ───────────────────────────────────────────────────────────

/**
 * The whole state document, in one read.
 *
 * ⚠ HEAVY AND NOT A POLL — verified live at 64,968 bytes with 19 documents,
 * because `hub.sections.docs` carries every document's COMPLETE body inline.
 * Call it once to seed `rev` and the sections, then keep up through targeted
 * reads and the stream. Never put this result through `JSON.stringify` for a
 * log, either: a single line of it is 63 KB.
 */
export async function fetchHub(): Promise<HubSnapshotResult> {
  const r = await hubRequest<{ rev?: number; hub?: unknown }>('GET', '');
  if (!r.ok) {
    return { ok: false, rev: currentRev(), hub: normaliseSnapshot(null), ...pick(r) };
  }
  noteRev(r.data?.rev);
  return { ok: true, rev: currentRev(), hub: normaliseSnapshot(r.data?.hub) };
}

/**
 * Move the active point (which doc is open, which section is showing).
 *
 * `PATCH /hub` takes only these two fields, and it DOES need a rev.
 */
export async function patchHub(
  patch: { activeDocId?: string | null; activeSection?: SectionId },
): Promise<HubSnapshotResult> {
  const r = await hubRequest<{ rev?: number; hub?: unknown }>('PATCH', '', { body: patch, rev: true });
  if (!r.ok) return { ok: false, rev: currentRev(), hub: normaliseSnapshot(null), ...pick(r) };
  return { ok: true, rev: currentRev(), hub: normaliseSnapshot(r.data?.hub) };
}

/** Replace the whole state document. Used by a seed/import, not by edits. */
export async function putHub(hub: HubSnapshot): Promise<HubSnapshotResult> {
  const r = await hubRequest<{ rev?: number; hub?: unknown }>('PUT', '', { body: { hub }, rev: true });
  if (!r.ok) return { ok: false, rev: currentRev(), hub: normaliseSnapshot(null), ...pick(r) };
  return { ok: true, rev: currentRev(), hub: normaliseSnapshot(r.data?.hub) };
}

// ── todos ───────────────────────────────────────────────────────────────────

export async function fetchTodos(): Promise<TodoListResult> {
  const r = await hubRequest<{ rev?: number; items?: unknown }>('GET', '/todos');
  if (!r.ok) return { ok: false, rev: currentRev(), items: [], ...pick(r) };
  const items = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]).filter(isTodo) : [];
  return { ok: true, rev: currentRev(), items };
}

/** Add one task. Needs a rev, and an idempotency key so a retry cannot double it. */
export async function createTodo(text: string): Promise<TodoWriteResult> {
  const r = await hubRequest<{ rev?: number; item?: unknown }>('POST', '/todos', {
    body: { text },
    rev: true,
  });
  if (!r.ok) return { ok: false, rev: currentRev(), item: emptyTodo(), duplicate: false, ...pick(r) };
  return {
    ok: true,
    rev: currentRev(),
    item: isTodo(r.data?.item) ? r.data.item : emptyTodo(),
    duplicate: r.duplicate,
  };
}

function emptyTodo(): TodoItem {
  return { id: '', text: '', done: false };
}

/** Change one task's text, its done flag, or both. */
export async function patchTodo(
  id: string,
  patch: { text?: string; done?: boolean },
): Promise<TodoWriteResult> {
  const r = await hubRequest<{ rev?: number; item?: unknown }>(
    'PATCH',
    `/todos/${encodeURIComponent(id)}`,
    { body: patch, rev: true },
  );
  if (!r.ok) return { ok: false, rev: currentRev(), item: emptyTodo(), duplicate: false, ...pick(r) };
  return {
    ok: true,
    rev: currentRev(),
    item: isTodo(r.data?.item) ? r.data.item : emptyTodo(),
    duplicate: r.duplicate,
  };
}

/** Remove one task. Answers `204` with no body — `ok` is the whole answer. */
export async function deleteTodo(id: string): Promise<HubRequestResult> {
  return hubRequest('DELETE', `/todos/${encodeURIComponent(id)}`, { rev: true });
}

/** Put the tasks in this exact order. The list IS the order. */
export async function reorderTodos(ids: string[]): Promise<TodoListResult> {
  const r = await hubRequest<{ rev?: number; items?: unknown }>('POST', '/todos/reorder', {
    body: { ids },
    rev: true,
  });
  if (!r.ok) return { ok: false, rev: currentRev(), items: [], ...pick(r) };
  const items = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]).filter(isTodo) : [];
  return { ok: true, rev: currentRev(), items };
}

/** Drop every completed task. Removes many, so it is one write, not N. */
export async function clearDoneTodos(): Promise<TodoListResult> {
  const r = await hubRequest<{ rev?: number; items?: unknown }>('POST', '/todos/clear-done', {
    rev: true,
  });
  if (!r.ok) return { ok: false, rev: currentRev(), items: [], ...pick(r) };
  const items = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]).filter(isTodo) : [];
  return { ok: true, rev: currentRev(), items };
}

/**
 * Replace the whole list.
 *
 * The wholesale write, and the one that makes an optimistic UI honest: when the
 * local list is already the intended result, pushing it converges in one call
 * instead of replaying every individual edit.
 */
export async function putTodos(items: TodoItem[]): Promise<TodoListResult> {
  const r = await hubRequest<{ rev?: number; items?: unknown }>('PUT', '/todos', {
    body: { items },
    rev: true,
  });
  if (!r.ok) return { ok: false, rev: currentRev(), items: [], ...pick(r) };
  const out = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]).filter(isTodo) : [];
  return { ok: true, rev: currentRev(), items: out };
}

// ── notes ───────────────────────────────────────────────────────────────────

/**
 * The notes section.
 *
 * An absent row is an EMPTY note, not a `404` — so `ok:false` here really is a
 * failure, and an empty string is the ordinary "nothing written yet".
 */
export async function fetchNotes(): Promise<NotesResult> {
  const r = await hubRequest<{ rev?: number; content?: unknown }>('GET', '/notes');
  if (!r.ok) return { ok: false, rev: currentRev(), content: '', ...pick(r) };
  return { ok: true, rev: currentRev(), content: typeof r.data?.content === 'string' ? r.data.content : '' };
}

/** Replace the notes. This is the whole body, not an append. */
export async function putNotes(content: string): Promise<NotesResult> {
  const r = await hubRequest<{ rev?: number; content?: unknown }>('PUT', '/notes', {
    body: { content },
    rev: true,
  });
  if (!r.ok) return { ok: false, rev: currentRev(), content: '', ...pick(r) };
  return { ok: true, rev: currentRev(), content: typeof r.data?.content === 'string' ? r.data.content : content };
}

/**
 * Append to the notes.
 *
 * Preferred over `putNotes` for a dictated or streamed line: the server does the
 * joining, so two devices appending at once cannot each overwrite the other with
 * their own idea of the old text.
 */
export async function appendNotes(text: string): Promise<NotesResult> {
  const r = await hubRequest<{ rev?: number; content?: unknown }>('POST', '/notes/append', {
    body: { text },
    rev: true,
  });
  if (!r.ok) return { ok: false, rev: currentRev(), content: '', ...pick(r) };
  return { ok: true, rev: currentRev(), content: typeof r.data?.content === 'string' ? r.data.content : '' };
}

// ── docs ────────────────────────────────────────────────────────────────────

/**
 * The document library.
 *
 * `includeContent` is opt-in because a body is unbounded — the 19 documents in
 * this deployment are 63 KB of text between them. Leave it off for a list, and
 * fetch the one body the wearer actually opened.
 */
export async function fetchDocs(opts: { includeContent?: boolean } = {}): Promise<DocListResult> {
  const suffix = opts.includeContent ? '?include=content' : '';
  const r = await hubRequest<{ rev?: number; items?: unknown }>('GET', `/docs${suffix}`);
  if (!r.ok) return { ok: false, rev: currentRev(), items: [], ...pick(r) };
  const items = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]).filter(isDocMeta) : [];
  return { ok: true, rev: currentRev(), items };
}

/**
 * One document, body included — plus the etag `updateDocContent` will need.
 *
 * The body is unbounded (63 KB across the 19 documents in this deployment), so
 * this is the read for exactly the one document the wearer opened, not a list.
 */
export async function fetchDoc(id: string): Promise<DocReadResult> {
  const r = await hubRequest<{ doc?: unknown }>('GET', `/docs/${encodeURIComponent(id)}`);
  if (!r.ok) return { ok: false, doc: null, ...pick(r) };
  return { ok: true, doc: isDocMeta(r.data?.doc) ? r.data.doc : null, etag: r.etag };
}

/** Create a document. Answers `201` — and needs a rev. */
export async function createDoc(title: string, content = ''): Promise<DocWriteResult> {
  const r = await hubRequest<{ rev?: number; doc?: unknown }>('POST', '/docs', {
    body: { title, content },
    rev: true,
  });
  return docWriteResult(r);
}

function docWriteResult(r: HubRequestResult<{ rev?: number; doc?: unknown }>): DocWriteResult {
  if (!r.ok) {
    return { ok: false, rev: currentRev(), doc: null, duplicate: false, ...pick(r) };
  }
  return {
    ok: true,
    rev: currentRev(),
    doc: isDocMeta(r.data?.doc) ? r.data.doc : null,
    duplicate: r.duplicate,
    etag: r.etag,
  };
}

/**
 * Rename a document. METADATA ONLY — `PATCH /hub/docs/{id}` touches title and
 * ordinal and never the body, so a rename cannot clobber an edit in flight.
 */
export async function renameDoc(id: string, title: string): Promise<DocWriteResult> {
  const r = await hubRequest<{ rev?: number; doc?: unknown }>(
    'PATCH',
    `/docs/${encodeURIComponent(id)}`,
    { body: { title }, rev: true },
  );
  return docWriteResult(r);
}

/**
 * Replace a document's body.
 *
 * This is the ONLY doc route that takes an `If-Match` instead of a rev, so it is
 * also the only one that can lose an edit without saying so: passing the etag
 * from `fetchDoc` (or from the previous write's response) turns a silent
 * overwrite into a real `412`, and the caller re-reads instead of destroying
 * someone's work.
 *
 * The hub answers `412 IF_MATCH_REQUIRED` when it is missing and
 * `412 IF_MATCH_FAILED` when it has moved, and both carry the current object.
 */
export async function updateDocContent(
  id: string,
  content: string,
  opts: { title?: string; etag?: string } = {},
): Promise<DocWriteResult> {
  const body: Record<string, unknown> = { content };
  if (opts.title !== undefined) body.title = opts.title;
  const r = await hubRequest<{ rev?: number; doc?: unknown }>(
    'PUT',
    `/docs/${encodeURIComponent(id)}`,
    { body, etag: opts.etag },
  );
  return docWriteResult(r);
}

/** Remove a document. Soft: the hub keeps a `deleted_at` and the body. */
export async function deleteDoc(id: string): Promise<HubRequestResult> {
  return hubRequest('DELETE', `/docs/${encodeURIComponent(id)}`, { rev: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Agents and tools
// ─────────────────────────────────────────────────────────────────────────────
//
// ONE READ COVERS THE WHOLE CATALOGUE. `GET /hub/agents` answers with `agents`,
// `tools` and `llm` together, so a boot call for the agents page is a single
// round trip rather than three, and — more usefully — the agent/tool ids in that
// frame are guaranteed to agree with each other. Reading them separately is what
// lets a `toolIds` entry point at a tool the second read has not returned yet.
//
// WHAT THE HUB OWNS, AND WHAT IT CANNOT HOLD (all probed live)
//   agents : name, systemPrompt, prompt, toolIds — plus server-minted id,
//            createdAt, updatedAt. 18 live agents, and every one of them matches
//            this app's `AgentDef` field for field.
//   tools  : name, kind, description, url, method, searchDepth, hasToken.
//   DROPPED: a tool's `bodyTemplate` and an agent's `model`.
//            `bodyTemplate` was sent under six different names (`bodyTemplate`,
//            `body_template`, `body`, `template`, `params`, `queryParams`) and
//            every one was silently discarded, so this is not a spelling problem:
//            the column does not exist. Both fields therefore stay LOCAL and are
//            re-attached by id whenever the hub's list is adopted. The cost is
//            real and worth stating plainly — a device that has never seen a REST
//            tool before cannot recover the parameter shape its author wrote, so
//            the model is offered a free-form body instead of the authored keys.
//
// `llm` IS DELIBERATELY NOT SURFACED HERE. The hub reports
// `{provider:"deepseek", model:"deepseek-flash", hasKey:false}` — an unconfigured
// second opinion — while this app's LLM and search settings, and the keys behind
// them, are RELAY-owned and already working. Adopting the hub's copy would
// overwrite a working model choice with a default and blank the key flag, so the
// field is read past on purpose rather than mirrored.
//
// `rev` RULES DIFFER BETWEEN THE TWO. A tool write REQUIRES a rev but does not
// move it (§4: only todo, docs, notes, files and agents advance it), so several
// tool writes can share one rev. An agent write moves it. `PUT /hub/agents/{id}`
// is the exception that takes an `If-Match` instead — the same guard as
// `PUT /hub/docs/{id}`, with the same quoted etag and the same 412 recovery.

/** `GET /hub/agents` — agents and tools in one read, with the rev that guards them. */
export interface AgentsListResult extends HubError {
  ok: boolean;
  rev: number;
  agents: AgentDef[];
  tools: ToolDef[];
}

/**
 * The result of an agent write.
 *
 * The hub answers a `POST` with the ENTIRE catalogue, so `agents`/`tools` are
 * carried when it does and `null` when it answers with just the touched record —
 * absorbing both shapes here is what keeps the caller from having to guess, and
 * from throwing away a whole-list answer it could have adopted.
 */
export interface AgentWriteResult extends HubError {
  ok: boolean;
  rev: number;
  /** The agent this call touched, when the hub echoed one. */
  agent: AgentDef | null;
  /** The full catalogue, when the hub sent it. Null when it did not. */
  agents: AgentDef[] | null;
  tools: ToolDef[] | null;
  duplicate: boolean;
  /** The next `If-Match` for this agent, when the hub sent one. */
  etag?: string;
}

/** One agent, with its tools already resolved and the etag its next write needs. */
export interface AgentReadResult extends HubError {
  ok: boolean;
  agent: AgentDef | null;
  etag?: string;
}

export interface ToolListResult extends HubError {
  ok: boolean;
  rev: number;
  items: ToolDef[];
}

/** The fields a tool may be created or patched with — everything but the id. */
export type ToolWriteBody = Omit<ToolDef, 'id'>;

/**
 * What an agent write answers with.
 *
 * All four are optional because the hub sends different amounts depending on the
 * route: a `POST` returns the whole catalogue, while a `PUT` may answer with just
 * the record it touched. `llm` is absent on purpose — see the note above.
 */
interface AgentEnvelope {
  rev?: number;
  agent?: unknown;
  agents?: unknown;
  tools?: unknown;
}

function isAgent(v: unknown): v is AgentDef {
  const o = v as Partial<AgentDef> | null;
  return !!o && typeof o.id === 'string' && typeof o.name === 'string';
}

function isTool(v: unknown): v is ToolDef {
  const o = v as Partial<ToolDef> | null;
  return !!o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.kind === 'string';
}

/** Every tool off the wire goes through `normalizeTool`, so the kind union holds.
 *  The hub's `TOOL_KINDS` still lists `tavily`, which is not a `ToolKind` here. */
function readTools(raw: unknown): ToolDef[] {
  return Array.isArray(raw) ? (raw as unknown[]).filter(isTool).map(normalizeTool) : [];
}

function readAgents(raw: unknown): AgentDef[] {
  return Array.isArray(raw) ? (raw as unknown[]).filter(isAgent) : [];
}

/** Read the catalogue out of a write response, whichever shape it arrived in. */
function agentWriteResult(r: HubRequestResult<AgentEnvelope>): AgentWriteResult {
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      agent: null,
      agents: null,
      tools: null,
      duplicate: false,
      ...pick(r),
    };
  }
  const single = isAgent(r.data?.agent) ? r.data.agent : null;
  const list = Array.isArray(r.data?.agents) ? readAgents(r.data?.agents) : null;
  return {
    ok: true,
    rev: currentRev(),
    agent: single ?? (list && list.length === 1 ? list[0] : null),
    agents: list,
    tools: Array.isArray(r.data?.tools) ? readTools(r.data?.tools) : null,
    duplicate: r.duplicate,
    etag: r.etag,
  };
}

export async function fetchAgents(): Promise<AgentsListResult> {
  const r = await hubRequest<{ rev?: number; agents?: unknown; tools?: unknown }>('GET', '/agents');
  if (!r.ok) return { ok: false, rev: currentRev(), agents: [], tools: [], ...pick(r) };
  return {
    ok: true,
    rev: currentRev(),
    agents: readAgents(r.data?.agents),
    tools: readTools(r.data?.tools),
  };
}

/** Create an agent. `name` is the only field the hub requires. Answers `201`. */
export async function createAgent(body: {
  name: string;
  systemPrompt?: string;
  prompt?: string;
  toolIds?: string[];
}): Promise<AgentWriteResult> {
  const r = await hubRequest<AgentEnvelope>('POST', '/agents', { body, rev: true });
  return agentWriteResult(r);
}

/** One agent, with its tools resolved and the `ETag` its next write must carry. */
export async function fetchAgent(id: string): Promise<AgentReadResult> {
  const r = await hubRequest<{ agent?: unknown }>('GET', `/agents/${encodeURIComponent(id)}`);
  if (!r.ok) return { ok: false, agent: null, ...pick(r) };
  return { ok: true, agent: isAgent(r.data?.agent) ? r.data.agent : null, etag: r.etag };
}

/**
 * Replace an agent WHOLESALE — last write wins.
 *
 * Guarded by `If-Match`, not by a rev, so the etag from `fetchAgent` is what
 * stands between an edit and a silent overwrite. A missing one is
 * `412 IF_MATCH_REQUIRED` and a moved one is `412 IF_MATCH_FAILED`; both carry
 * the current agent and a fresh QUOTED etag under `details`, which is how a
 * caller recovers without a second read.
 */
export async function putAgent(
  id: string,
  body: {
    name: string;
    systemPrompt?: string;
    prompt?: string;
    toolIds?: string[];
  },
  opts: { etag?: string } = {},
): Promise<AgentWriteResult> {
  const r = await hubRequest<AgentEnvelope>('PUT', `/agents/${encodeURIComponent(id)}`, {
    body,
    etag: opts.etag,
  });
  return agentWriteResult(r);
}

/**
 * Delete an agent. SOFT and IRREVERSIBLE — there is no restore route.
 *
 * Answers with the surviving catalogue like the other agent writes, so a caller
 * can adopt it rather than keep a row the hub no longer has.
 */
export async function deleteAgent(id: string): Promise<AgentWriteResult> {
  const r = await hubRequest<AgentEnvelope>('DELETE', `/agents/${encodeURIComponent(id)}`, {
    rev: true,
  });
  return agentWriteResult(r);
}

/** Copy an agent, its tools and their order. Answers `201` with the catalogue. */
export async function cloneAgent(id: string): Promise<AgentWriteResult> {
  const r = await hubRequest<AgentEnvelope>('POST', `/agents/${encodeURIComponent(id)}/clone`, {
    rev: true,
  });
  return agentWriteResult(r);
}

export async function fetchTools(): Promise<ToolListResult> {
  const r = await hubRequest<{ rev?: number; items?: unknown }>('GET', '/tools');
  if (!r.ok) return { ok: false, rev: currentRev(), items: [], ...pick(r) };
  return { ok: true, rev: currentRev(), items: readTools(r.data?.items) };
}

/**
 * Create a tool. Needs a rev — and does not move it.
 *
 * `url`, `method` and `searchDepth` are stored; `bodyTemplate` is DISCARDED by
 * the hub whatever it is called (probed with six spellings). Sending it anyway is
 * harmless — the hub ignores unknown keys rather than rejecting the write — so a
 * caller can hand over a whole `ToolDef` and let the wire decide what survives.
 */
export async function createTool(body: ToolWriteBody): Promise<ToolListResult> {
  const r = await hubRequest<{ rev?: number; items?: unknown }>('POST', '/tools', {
    body: body as Record<string, unknown>,
    rev: true,
  });
  return toolListResult(r);
}

/**
 * Patch a tool. A field left out is LEFT ALONE.
 *
 * The integration document says a field set to `null` is cleared instead; the
 * server does not do that — `{description: null}` leaves the description
 * untouched (probed live). So this sends the patch verbatim and a caller that
 * means to clear a field sends an empty string, which is what the editors in this
 * app produce anyway.
 */
export async function patchTool(id: string, patch: Partial<ToolWriteBody>): Promise<ToolListResult> {
  const r = await hubRequest<{ rev?: number; items?: unknown }>(
    'PUT',
    `/tools/${encodeURIComponent(id)}`,
    { body: patch as Record<string, unknown>, rev: true },
  );
  return toolListResult(r);
}

/** Delete a tool. HARD — and `agent_tool` cascades, so no agent keeps a stale id. */
export async function deleteTool(id: string): Promise<ToolListResult> {
  const r = await hubRequest<{ rev?: number; items?: unknown }>(
    'DELETE',
    `/tools/${encodeURIComponent(id)}`,
    { rev: true },
  );
  return toolListResult(r);
}

/** Store a tool's token. Write-only and owner-only: it is never echoed back. */
export async function putToolToken(id: string, token: string): Promise<HubRequestResult> {
  return hubRequest('PUT', `/tools/${encodeURIComponent(id)}/token`, { body: { token } });
}

/** Remove a tool's token. `404` when there was none. */
export async function deleteToolToken(id: string): Promise<HubRequestResult> {
  return hubRequest('DELETE', `/tools/${encodeURIComponent(id)}/token`);
}

function toolListResult(
  r: HubRequestResult<{ rev?: number; items?: unknown }>,
): ToolListResult {
  if (!r.ok) return { ok: false, rev: currentRev(), items: [], ...pick(r) };
  return { ok: true, rev: currentRev(), items: readTools(r.data?.items) };
}

/* ------------------------------------------------------------------------- */
/* Files — the hub's `file_ref` registry                                       */
/* ------------------------------------------------------------------------- */
//
// WHAT THE HUB OWNS HERE
//   A `file_ref` is a REFERENCE to a body, never a body (§3.3: the table has no
//   such column). `POST /hub/files` publishes the body to the gateway and then
//   records the reference, so the gateway stays the blob store and the hub
//   becomes the authority for what exists, what it is called and whether it is
//   deleted. That is why `sections.files` moves with `hub_state.rev`.
//
// WHAT IT DOES NOT OWN (probed, and all four change the caller's mind about it)
//   • `GET /hub/files/{id}/text` answers the RAW body and IGNORES `limit`/
//     `offset` (a windowed request came back with `limit == total` and the whole
//     text). The relay's `/api/files/:id/text` is the readable, windowed view —
//     it runs `htmlToText` and `bodyWindow` — so that route stays a relay route.
//   • `GET /hub/files/{id}/media` counts assets; extracting safe player URLs from
//     a document is the relay's `extractMedia`, so that stays too.
//   • There is no single-revision read, no revision restore and no metadata
//     PATCH: only `GET /hub/files/{id}/revisions` (the LIST) exists here, and the
//     gateway's `/sessions/{id}/revisions/...` family is what §14.1 points at.
//   • A file carries NO `ETag`. `GET /hub/files/{id}` answers `{ok, rev, file}`
//     with no etag header and writes take no `If-Match` — unlike docs and agents.
//
// TWO TRAPS
//   • The soft-delete filter is spelled `includeDeleted` (camel case). A
//     snake-cased `include_deleted` is the RELAY's spelling and the hub ignores
//     it, so the Deleted tab is built on the camel-cased flag and nothing else.
//   • A live row has NO `deletedAt` key at all — it is absent, not null — so a
//     caller must test for presence rather than falsiness of a value.

/** One `file_ref`. The body is not here and never is. */
export interface HubFile {
  id: string;
  title: string;
  agent: string;
  /** The gateway's own URL for the body. */
  url: string;
  size: number;
  tags: string[];
  updatedAt: number;
  slug?: string;
  version?: number;
  /** ABSENT on a live row. Present (ms epoch) only when the ref is soft-deleted. */
  deletedAt?: number;
  deletedReason?: string;
}

/**
 * A page of references.
 *
 * The hub pages this itself: `limit` is the page size it actually applied (50
 * unless asked, 500 at most) and `next` is the cursor for the page after it.
 */
export interface HubFileListResult extends HubError {
  ok: boolean;
  rev: number;
  items: HubFile[];
  next: string | null;
  more: boolean;
  limit: number;
}

/** One reference's metadata. Never the body — that is `/text`, on the relay. */
export interface HubFileResult extends HubError {
  ok: boolean;
  rev: number;
  file: HubFile | null;
}

/** A reference write. `POST /hub/files` answers `201` with the record under `file`. */
export interface HubFileWriteResult extends HubError {
  ok: boolean;
  rev: number;
  file: HubFile | null;
  duplicate: boolean;
}

export interface HubFileStatsResult extends HubError {
  ok: boolean;
  rev: number;
  total: number;
  bytes: number;
  /** Soft-deleted references, counted SEPARATELY from `total`. */
  deleted: number;
  byAgent: Record<string, number>;
}

/**
 * One entry in a reference's history.
 *
 * `created_at` is an ISO STRING here, not the ms epoch every other timestamp in
 * this API uses, and `revision` is the position in the history while `version`
 * is the document version that entry produced — a metadata edit appends one
 * without moving the other.
 */
export interface HubFileRevision {
  revision: number;
  version?: number;
  change: string;
  contentChanged?: boolean;
  size?: number;
  sha256?: string;
  previousSha256?: string;
  createdAt?: string;
  agent?: string;
  agentSlug?: string;
  title?: string;
  slug?: string;
  subject?: string;
  tags?: string[];
}

export interface HubFileRevisionsResult extends HubError {
  ok: boolean;
  rev: number;
  id: string;
  count: number;
  items: HubFileRevision[];
}

export interface HubFileMediaResult extends HubError {
  ok: boolean;
  rev: number;
  id: string;
  count: number;
  items: unknown[];
}

export interface HubFileTextResult extends HubError {
  ok: boolean;
  rev: number;
  id: string;
  /** The RAW body. Not readable text — see the note above. */
  text: string;
  total: number;
}

function isFile(v: unknown): v is HubFile {
  const o = v as Partial<HubFile> | null;
  return !!o && typeof o.id === 'string';
}

/**
 * Every reference off the wire, with the shapes the hub leaves implicit filled
 * in. Absent `tags` becomes an empty list and absent timestamps stay undefined,
 * so `deletedAt` being present remains the one true signal of a deleted ref.
 */
function readFileRecord(raw: unknown): HubFile {
  const o = raw as Record<string, unknown>;
  return {
    id: String(o.id),
    title: typeof o.title === 'string' ? o.title : '',
    agent: typeof o.agent === 'string' ? o.agent : '',
    url: typeof o.url === 'string' ? o.url : '',
    size: Number(o.size) || 0,
    tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map(String) : [],
    updatedAt: Number(o.updatedAt) || 0,
    slug: typeof o.slug === 'string' ? o.slug : undefined,
    version: typeof o.version === 'number' ? o.version : undefined,
    deletedAt: typeof o.deletedAt === 'number' ? o.deletedAt : undefined,
    deletedReason: typeof o.deletedReason === 'string' ? o.deletedReason : undefined,
  };
}

function readFiles(raw: unknown): HubFile[] {
  return Array.isArray(raw)
    ? (raw as unknown[]).filter(isFile).map(readFileRecord)
    : [];
}

/**
 * List references, newest first.
 *
 * Every filter the hub documents works — `q`, `agent`, `tag`, `offset`, `limit`.
 * It is `includeDeleted` that reveals a soft-deleted ref, and the hub's own
 * `?deleted=true` spelling does NOT exist: sending it returns the live list and
 * looks like a working filter, which is the worst kind of wrong.
 */
export async function fetchHubFiles(
  opts: {
    limit?: number;
    offset?: number;
    q?: string;
    agent?: string;
    tag?: string;
    includeDeleted?: boolean;
  } = {},
): Promise<HubFileListResult> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.offset) q.set('offset', String(opts.offset));
  if (opts.q) q.set('q', opts.q);
  if (opts.agent) q.set('agent', opts.agent);
  if (opts.tag) q.set('tag', opts.tag);
  if (opts.includeDeleted) q.set('includeDeleted', 'true');
  const suffix = q.toString() ? `?${q}` : '';
  const r = await hubRequest<{
    rev?: number;
    items?: unknown;
    next?: unknown;
    more?: unknown;
    limit?: unknown;
  }>('GET', `/files${suffix}`);
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      items: [],
      next: null,
      more: false,
      limit: 0,
      ...pick(r),
    };
  }
  return {
    ok: true,
    rev: currentRev(),
    items: readFiles(r.data?.items),
    next: typeof r.data?.next === 'string' ? r.data.next : null,
    more: r.data?.more === true,
    limit: Number(r.data?.limit) || 0,
  };
}

/** One reference's metadata. */
export async function fetchHubFile(id: string): Promise<HubFileResult> {
  const r = await hubRequest<{ rev?: number; file?: unknown }>(
    'GET',
    `/files/${encodeURIComponent(id)}`,
  );
  if (!r.ok) return { ok: false, rev: currentRev(), file: null, ...pick(r) };
  return {
    ok: true,
    rev: currentRev(),
    file: isFile(r.data?.file) ? readFileRecord(r.data?.file) : null,
  };
}

/** The RAW body, whole. `limit`/`offset` are accepted by the hub and ignored. */
export async function fetchHubFileText(id: string): Promise<HubFileTextResult> {
  const r = await hubRequest<{ rev?: number; text?: unknown; total?: unknown }>(
    'GET',
    `/files/${encodeURIComponent(id)}/text`,
  );
  if (!r.ok) return { ok: false, rev: currentRev(), id, text: '', total: 0, ...pick(r) };
  const text = typeof r.data?.text === 'string' ? r.data.text : '';
  return {
    ok: true,
    rev: currentRev(),
    id,
    text,
    total: Number(r.data?.total) || text.length,
  };
}

export async function fetchHubFileMedia(id: string): Promise<HubFileMediaResult> {
  const r = await hubRequest<{ rev?: number; count?: unknown; items?: unknown }>(
    'GET',
    `/files/${encodeURIComponent(id)}/media`,
  );
  if (!r.ok) return { ok: false, rev: currentRev(), id, count: 0, items: [], ...pick(r) };
  return {
    ok: true,
    rev: currentRev(),
    id,
    count: Number(r.data?.count) || 0,
    items: Array.isArray(r.data?.items) ? (r.data?.items as unknown[]) : [],
  };
}

/** Archive totals. `deleted` is reported separately from `total`. */
export async function fetchHubFileStats(): Promise<HubFileStatsResult> {
  const r = await hubRequest<{
    rev?: number;
    total?: unknown;
    bytes?: unknown;
    deleted?: unknown;
    byAgent?: unknown;
  }>('GET', '/files/stats');
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      total: 0,
      bytes: 0,
      deleted: 0,
      byAgent: {},
      ...pick(r),
    };
  }
  const by = r.data?.byAgent;
  return {
    ok: true,
    rev: currentRev(),
    total: Number(r.data?.total) || 0,
    bytes: Number(r.data?.bytes) || 0,
    deleted: Number(r.data?.deleted) || 0,
    byAgent:
      by && typeof by === 'object' ? (by as Record<string, number>) : {},
  };
}

function readRevision(raw: unknown): HubFileRevision {
  const o = raw as Record<string, unknown>;
  return {
    revision: Number(o.revision) || 0,
    version: typeof o.version === 'number' ? o.version : undefined,
    change: typeof o.change === 'string' ? o.change : '',
    contentChanged: o.content_changed === true,
    size: typeof o.size === 'number' ? o.size : undefined,
    sha256: typeof o.sha256 === 'string' ? o.sha256 : undefined,
    previousSha256: typeof o.previous_sha256 === 'string' ? o.previous_sha256 : undefined,
    createdAt: typeof o.created_at === 'string' ? o.created_at : undefined,
    agent: typeof o.agent === 'string' ? o.agent : undefined,
    agentSlug: typeof o.agent_slug === 'string' ? o.agent_slug : undefined,
    title: typeof o.title === 'string' ? o.title : undefined,
    slug: typeof o.slug === 'string' ? o.slug : undefined,
    subject: typeof o.subject === 'string' ? o.subject : undefined,
    tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map(String) : undefined,
  };
}

/**
 * A reference's history — the LIST only.
 *
 * There is no matching single-revision read or restore on the hub (§14.1 keeps
 * the doc-revision route deliberately unimplemented and points a client at the
 * gateway's `/sessions/{id}/revisions/...` for the rest), which is why the
 * relay's own `/api/files/:id/revisions/:n` routes still exist.
 */
export async function fetchHubFileRevisions(id: string): Promise<HubFileRevisionsResult> {
  const r = await hubRequest<{ rev?: number; count?: unknown; items?: unknown }>(
    'GET',
    `/files/${encodeURIComponent(id)}/revisions`,
  );
  if (!r.ok) return { ok: false, rev: currentRev(), id, count: 0, items: [], ...pick(r) };
  const items = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]) : [];
  return {
    ok: true,
    rev: currentRev(),
    id,
    count: Number(r.data?.count) || items.length,
    items: items.map(readRevision),
  };
}

/**
 * Publish a body and record the reference. Answers `201`.
 *
 * The record comes back under `file` — not `item`, which is what the todo, doc,
 * agent and tool routes use. Getting that wrong costs the new id, and the id is
 * the only handle on a page that was just published.
 */
export async function createHubFile(body: {
  html?: string;
  file?: string;
  title?: string;
  agent?: string;
  slug?: string;
  tags?: string[];
  id?: string;
  overwrite?: boolean;
}): Promise<HubFileWriteResult> {
  const r = await hubRequest<{ rev?: number; file?: unknown }>('POST', '/files', {
    body: body as Record<string, unknown>,
    rev: true,
  });
  if (!r.ok) return { ok: false, rev: currentRev(), file: null, duplicate: false, ...pick(r) };
  return {
    ok: true,
    rev: currentRev(),
    file: isFile(r.data?.file) ? readFileRecord(r.data?.file) : null,
    duplicate: r.duplicate,
  };
}

/**
 * Delete a reference. SOFT by default; `?hard=true` also drops the body.
 *
 * Both answer `204` — no body, and NO REV. The hub still moved its rev, so this
 * client is provably stale the moment this returns, and the next write will be
 * refused once and retried against `details.rev` (the write queue handles it).
 * That is expected, not a fault: nothing in a `204` can carry the new rev.
 */
export async function deleteHubFile(id: string, hard = false): Promise<HubFileWriteResult> {
  const suffix = hard ? '?hard=true' : '';
  const r = await hubRequest<{ rev?: number }>(
    'DELETE',
    `/files/${encodeURIComponent(id)}${suffix}`,
    { rev: true },
  );
  if (!r.ok) return { ok: false, rev: currentRev(), file: null, duplicate: false, ...pick(r) };
  return { ok: true, rev: currentRev(), file: null, duplicate: false };
}

/** Undo a soft delete. Answers `200` — not `201`, because nothing was created. */
export async function restoreHubFile(id: string): Promise<HubFileWriteResult> {
  const r = await hubRequest<{ rev?: number; file?: unknown }>(
    'POST',
    `/files/${encodeURIComponent(id)}/restore`,
    { rev: true },
  );
  if (!r.ok) return { ok: false, rev: currentRev(), file: null, duplicate: false, ...pick(r) };
  return {
    ok: true,
    rev: currentRev(),
    file: isFile(r.data?.file) ? readFileRecord(r.data?.file) : null,
    duplicate: r.duplicate,
  };
}

/* ------------------------------------------------------------------------- */
/* Sessions — the hub's `session` + `message` tables                           */
/* ------------------------------------------------------------------------- */
//
// ⚠ THREE THINGS THE INTEGRATION DOCUMENT GETS WRONG HERE, ALL PROBED LIVE
//   1. Its captured body for `GET /hub/sessions/{id}` is a COPY-PASTE of the
//      stats shape. The real answer is the `session` entity — plus `ok`, `rev`
//      and, in the BODY, the `etag`. `§4.9` also leaves this route's Guard blank
//      as if it were read-only; it is not, it carries the etag for a `PATCH`.
//   2. `§4.9` prints `-` for both `PATCH` and `DELETE /hub/sessions/{id}`, which
//      reads as "no rev". Both demand a rev IN THE BODY and refuse with
//      `400 REV_REQUIRED` (`details.field = "rev"`) without it. Putting it in the
//      query string is not accepted — the same trap as `DELETE /hub/tools/{id}`.
//   3. "A replay is a success" is about the STATUS, not about deduplication. Two
//      identical appends with no `Idempotency-Key` produced TWO rows (`seq` 3
//      then 4). The same call with a repeated key answered `200` with
//      `Duplicate: true`, kept ONE row, and returned the ORIGINAL `seq` — so
//      every append MUST carry a key, and a retry MUST reuse it.
//
// WHAT THE HUB STAMPS FOR YOU
//   `createdAt`, `updatedAt`, `endedAt` and every message's `at` are the
//   SERVER's clock: a request that sent `at` values a millisecond apart came back
//   with both messages carrying the SAME server timestamp. That is why nothing
//   here sends a client timestamp — a device clock is not allowed to decide when
//   a turn happened, and it cannot put a session behind the tombstone watermark.
//
// THE TOMBSTONE IS A WATERMARK, NOT A FLAG
//   `tombstone.all` is a ms instant ("forget everything at or before this"), and
//   it is RE-STAMPED to now on every session write, so a row created after any
//   write is always inside the watermark and always visible. `byAgent` carries
//   one instant per agent, which is exactly the app's `sessionsClearedAt` — the
//   server already models the deletion stamp this app used to invent locally.
//
// ⚠ `DELETE /hub/sessions/{id}` removes the session and its messages but NOT its
//   `summary` rows: `GET /hub/sessions/stats` reported `summaries: 1` with zero
//   sessions after every delete. A UI must not read that counter as "summaries
//   for the sessions I can see".

/** `SESSION_KINDS`. */
export type HubSessionKind = 'agent' | 'voice' | 'note';
/** `SESSION_STATUSES` — note `stopped`, which the app's own model does not have. */
export type HubSessionStatus = 'running' | 'done' | 'error' | 'stopped';
/** `MESSAGE_ROLES`. `system` is reachable on the wire even though the app never writes it. */
export type HubMessageRole = 'user' | 'assistant' | 'tool' | 'system';

/**
 * The tombstones a collection reports.
 *
 * `all` is a watermark in ms (or `null`); `byAgent` carries one per agent. It is
 * the server's own spelling of the app's `sessionsClearedAt`.
 */
export interface HubTombstone {
  all: number | null;
  byAgent: Record<string, number>;
}

/** One transcript row. `seq` is assigned by the server, one-based. */
export interface HubSessionMessage {
  seq: number;
  role: HubMessageRole;
  content: string;
  /** The SERVER's clock, not the caller's. */
  at: number;
  tool?: string;
  args?: string;
}

/** Session metadata. Never its messages — those are `/messages`. */
export interface HubSession {
  id: string;
  kind: string;
  agentId: string | null;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  wordCount: number;
  summaryVersion: number;
  pinned: boolean;
  runId?: string;
  /** Set by the hub when the status moves to a terminal one. */
  endedAt?: number;
}

export interface HubSessionListResult extends HubError {
  ok: boolean;
  rev: number;
  items: HubSession[];
  next: string | null;
  more: boolean;
  limit: number;
  tombstone: HubTombstone;
}

export interface HubSessionResult extends HubError {
  ok: boolean;
  rev: number;
  session: HubSession | null;
  /** Travels in the BODY here, not as a header. Kept for symmetry: `rev` is the guard. */
  etag?: string;
}

/** A session write. `POST /hub/sessions` answers `201`; a replay answers `200`. */
export interface HubSessionWriteResult extends HubError {
  ok: boolean;
  rev: number;
  sessionId: string;
  applied: boolean;
  /** The highest `seq` the session now holds, or `0` when nothing was written. */
  seq: number;
  duplicate: boolean;
  summary: HubSummary | null;
  summarised: boolean;
  /** Why the hub did NOT summarise — `'no provider'` when it has no LLM key. */
  summariseSkipped: string | null;
}

export interface HubMessagesResult extends HubError {
  ok: boolean;
  rev: number;
  items: HubSessionMessage[];
  next: string | null;
  more: boolean;
  limit: number;
}

/** The answer to an append. `applied` is true on a replay too — it means "stored". */
export interface HubAppendResult extends HubError {
  ok: boolean;
  rev: number;
  applied: boolean;
  seq: number;
  duplicate: boolean;
}

/**
 * One versioned summary.
 *
 * `kind` is the SUMMARY kind (`digest` | `manual` | `rollup`), which is NOT the
 * session kind — `searchSessions` folds both onto one item and disambiguates with
 * `summaryKind`. `sourceSeqFrom`/`sourceSeqTo` are real keys the document's
 * entity table omits.
 */
export interface HubSummary {
  version: number;
  text: string;
  model: string;
  kind: string;
  generatedAt: number;
  concepts: string[];
  entities: string[];
  decisions: string[];
  tasks: string[];
  tokens?: number;
  supersededAt?: number;
  sourceSeqFrom?: number;
  sourceSeqTo?: number;
  /** Present only on a search hit, where the parent session is folded in. */
  sessionId?: string;
  title?: string;
  summaryKind?: string;
  agentId?: string;
  sessionUpdatedAt?: number;
}

export interface HubSummariesResult extends HubError {
  ok: boolean;
  rev: number;
  sessionId: string;
  items: HubSummary[];
  count: number;
}

export interface HubSearchResult extends HubError {
  ok: boolean;
  rev: number;
  items: HubSummary[];
  /** Echoed back. */
  query: string;
  ranked: boolean;
  more: boolean;
  limit: number;
}

export interface HubSessionStatsResult extends HubError {
  ok: boolean;
  rev: number;
  sessions: number;
  turns: number;
  words: number;
  /** ⚠ Outlives its session — see the block note above. */
  summaries: number;
  summarised: number;
  unsummarised: number;
  coverage: number;
  byKind: Record<string, number>;
  tombstone: HubTombstone;
}

function isSession(v: unknown): v is HubSession {
  const o = v as Partial<HubSession> | null;
  return !!o && typeof o.id === 'string';
}

function readTombstone(raw: unknown): HubTombstone {
  const o = (raw ?? {}) as { all?: unknown; byAgent?: unknown };
  const by = o.byAgent;
  const out: Record<string, number> = {};
  if (by && typeof by === 'object') {
    for (const [k, v] of Object.entries(by as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return { all: typeof o.all === 'number' ? o.all : null, byAgent: out };
}

/**
 * One session off the wire.
 *
 * `agentId` is deliberately NULLABLE rather than defaulted to `''`: the hub
 * reports `null` for a session with no agent (a `voice` or `note` kind), and
 * coercing that to an empty string would make "no agent" indistinguishable from
 * "an agent whose id is blank" at every call site.
 */
function readSession(raw: unknown): HubSession {
  const o = raw as Record<string, unknown>;
  return {
    id: String(o.id),
    kind: typeof o.kind === 'string' ? o.kind : '',
    agentId: typeof o.agentId === 'string' ? o.agentId : null,
    title: typeof o.title === 'string' ? o.title : '',
    status: typeof o.status === 'string' ? o.status : '',
    createdAt: Number(o.createdAt) || 0,
    updatedAt: Number(o.updatedAt) || 0,
    turnCount: Number(o.turnCount) || 0,
    wordCount: Number(o.wordCount) || 0,
    summaryVersion: Number(o.summaryVersion) || 0,
    pinned: o.pinned === true,
    runId: typeof o.runId === 'string' ? o.runId : undefined,
    endedAt: typeof o.endedAt === 'number' ? o.endedAt : undefined,
  };
}

export function readSessions(raw: unknown): HubSession[] {
  return Array.isArray(raw) ? (raw as unknown[]).filter(isSession).map(readSession) : [];
}

function readMessage(raw: unknown): HubSessionMessage {
  const o = raw as Record<string, unknown>;
  const role = String(o.role ?? 'user');
  return {
    seq: Number(o.seq) || 0,
    role: (['user', 'assistant', 'tool', 'system'] as string[]).includes(role)
      ? (role as HubMessageRole)
      : 'user',
    content: typeof o.content === 'string' ? o.content : '',
    at: Number(o.at) || 0,
    tool: typeof o.tool === 'string' ? o.tool : undefined,
    args: typeof o.args === 'string' ? o.args : undefined,
  };
}

function readSummary(raw: unknown): HubSummary {
  const o = raw as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map(String) : [];
  return {
    version: Number(o.version) || 0,
    text: typeof o.text === 'string' ? o.text : '',
    model: typeof o.model === 'string' ? o.model : '',
    kind: typeof o.kind === 'string' ? o.kind : '',
    generatedAt: Number(o.generatedAt) || 0,
    concepts: list(o.concepts),
    entities: list(o.entities),
    decisions: list(o.decisions),
    tasks: list(o.tasks),
    tokens: typeof o.tokens === 'number' ? o.tokens : undefined,
    supersededAt: typeof o.supersededAt === 'number' ? o.supersededAt : undefined,
    sourceSeqFrom: typeof o.sourceSeqFrom === 'number' ? o.sourceSeqFrom : undefined,
    sourceSeqTo: typeof o.sourceSeqTo === 'number' ? o.sourceSeqTo : undefined,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
    title: typeof o.title === 'string' ? o.title : undefined,
    summaryKind: typeof o.summaryKind === 'string' ? o.summaryKind : undefined,
    agentId: typeof o.agentId === 'string' ? o.agentId : undefined,
    sessionUpdatedAt:
      typeof o.sessionUpdatedAt === 'number' ? o.sessionUpdatedAt : undefined,
  };
}

/**
 * The body of an ALREADY-APPLIED op, read out of a `409 DUPLICATE_OP`.
 *
 * The hub answers a repeated `Idempotency-Key` in two ways. Same body: `200`
 * with `Duplicate: true` and the original response — already handled upstream.
 * Different body: `409 DUPLICATE_OP`, and its `details.current` holds **the
 * original response**, not the hub state. That is the only way to learn the
 * `sessionId` the first attempt minted, which is why it is read rather than
 * thrown away.
 *
 * `details.current` is checked for the hub envelope (`ok` present) before being
 * trusted, so a `current` that is a state blob — as a `STALE_REV` carries — is
 * not mistaken for an op result.
 */
function duplicateOpBody(r: HubRequestResult<unknown>): Record<string, unknown> | null {
  if (r.code !== 'DUPLICATE_OP') return null;
  const current = r.details?.current;
  if (!current || typeof current !== 'object') return null;
  const o = current as Record<string, unknown>;
  return o.ok === true ? o : null;
}

function sessionWriteResult(
  r: HubRequestResult<{
    rev?: number;
    sessionId?: unknown;
    applied?: unknown;
    seq?: unknown;
    summary?: unknown;
    summarised?: unknown;
    summariseSkipped?: unknown;
  }>,
): HubSessionWriteResult {
  if (!r.ok) {
    // A `409 DUPLICATE_OP` is a SUCCESS wearing a failure's clothes.
    //
    // It means the key already landed with a DIFFERENT body — the op happened,
    // and the hub hands the original answer back under `details.current`. Probed:
    // a second create with the same key and a changed title answered
    // `409 {"code":"DUPLICATE_OP","details":{"current":{"ok":true,"sessionId":"a9589343-…"}}}`.
    // Returning a failure here would make a caller retry a save that already
    // succeeded, or lose the minted `sessionId` and create a duplicate session.
    // The same reading applies to `STALE_REV`, whose `details.current` is also
    // the prior response rather than the hub state the document describes.
    const prior = duplicateOpBody(r);
    if (prior) {
      return {
        ok: true,
        rev: currentRev(),
        sessionId: typeof prior.sessionId === 'string' ? prior.sessionId : '',
        applied: prior.applied === true,
        seq: Number(prior.seq) || 0,
        duplicate: true,
        summary: prior.summary && typeof prior.summary === 'object' ? readSummary(prior.summary) : null,
        summarised: prior.summarised === true,
        summariseSkipped: typeof prior.summariseSkipped === 'string' ? prior.summariseSkipped : null,
      };
    }
    return {
      ok: false,
      rev: currentRev(),
      sessionId: '',
      applied: false,
      seq: 0,
      duplicate: false,
      summary: null,
      summarised: false,
      summariseSkipped: null,
      ...pick(r),
    };
  }
  return {
    ok: true,
    rev: currentRev(),
    sessionId: typeof r.data?.sessionId === 'string' ? r.data.sessionId : '',
    applied: r.data?.applied === true,
    seq: Number(r.data?.seq) || 0,
    duplicate: r.duplicate,
    summary: r.data?.summary && typeof r.data.summary === 'object'
      ? readSummary(r.data.summary)
      : null,
    summarised: r.data?.summarised === true,
    summariseSkipped:
      typeof r.data?.summariseSkipped === 'string' ? r.data.summariseSkipped : null,
  };
}

/**
 * List sessions, newest first.
 *
 * `limit` is clamped by the hub to `MAX_PAGE_LIMIT` (500) — asked for 501, got
 * 500 — so a caller never needs to enforce that itself.
 *
 * `agentId` is sent when given, AND the caller should still filter the result:
 * the hub accepts the parameter, but a server that silently ignored it would
 * return every agent's history rather than none, which is the kind of wrong that
 * looks like working software. `tombstone` comes back so a caller can derive the
 * per-agent cleared watermark the app used to keep in its own state.
 */
export async function fetchSessions(
  opts: { agentId?: string; kind?: HubSessionKind; limit?: number; offset?: number } = {},
): Promise<HubSessionListResult> {
  const q = new URLSearchParams();
  if (opts.agentId) q.set('agentId', opts.agentId);
  if (opts.kind) q.set('kind', opts.kind);
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.offset) q.set('offset', String(opts.offset));
  const suffix = q.toString() ? `?${q}` : '';
  const r = await hubRequest<{
    rev?: number;
    items?: unknown;
    next?: unknown;
    more?: unknown;
    limit?: unknown;
    tombstone?: unknown;
  }>('GET', `/sessions${suffix}`);
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      items: [],
      next: null,
      more: false,
      limit: 0,
      tombstone: { all: null, byAgent: {} },
      ...pick(r),
    };
  }
  return {
    ok: true,
    rev: currentRev(),
    items: readSessions(r.data?.items),
    next: typeof r.data?.next === 'string' ? r.data.next : null,
    more: r.data?.more === true,
    limit: Number(r.data?.limit) || 0,
    tombstone: readTombstone(r.data?.tombstone),
  };
}

/**
 * One session's metadata — and NEVER its messages.
 *
 * The messages live at `/sessions/{id}/messages`, which is a separate page. A
 * caller that renders "the session" from this alone renders an empty transcript
 * with no error, which is exactly the bug the document's duplicated body would
 * hide.
 */
export async function fetchSession(id: string): Promise<HubSessionResult> {
  const r = await hubRequest<{ rev?: number } & Record<string, unknown>>(
    'GET',
    `/sessions/${encodeURIComponent(id)}`,
  );
  if (!r.ok) return { ok: false, rev: currentRev(), session: null, ...pick(r) };
  const etag = typeof r.data?.etag === 'string' ? r.data.etag : undefined;
  return {
    ok: true,
    rev: currentRev(),
    session: isSession(r.data) ? readSession(r.data) : null,
    etag,
  };
}

/**
 * Body for a session write.
 *
 * A `type`, not an `interface`, on purpose: only a type alias gets an implicit
 * index signature, and only that makes it acceptable as `HubRequestOptions.body`
 * without a cast that would hide a genuine mismatch.
 */
export type SessionSaveBody = {
  kind?: HubSessionKind;
  agentId?: string;
  runId?: string;
  title?: string;
  status?: HubSessionStatus;
  messages?: Array<Omit<HubSessionMessage, 'seq'>>;
  summarise?: boolean;
  summary?: string | null;
  respond?: boolean;
};

/**
 * Save a transcript, optionally with its summary, in one request. `201` the
 * first time; a replay of the same `Idempotency-Key` answers `200` with
 * `duplicate: true` and the SAME `sessionId`, so a caller may retry a lost
 * response without creating a second session.
 *
 * ⚠ `agentId` is VALIDATED against the hub's `agent` rows: an id it does not
 *   know is refused with `400 VALIDATION_ERROR` (`details.field = "agentId"`).
 *   A session can therefore only be saved for an agent that exists on the hub —
 *   which is why the local agent id had to become the hub's id first.
 *
 * ⚠ The server stamps `createdAt`, `updatedAt` and every message's `at`.
 */
export async function saveSession(
  body: SessionSaveBody,
  opts: { key?: string } = {},
): Promise<HubSessionWriteResult> {
  const r = await hubRequest<{
    rev?: number;
    sessionId?: unknown;
    applied?: unknown;
    seq?: unknown;
    summary?: unknown;
    summarised?: unknown;
    summariseSkipped?: unknown;
  }>('POST', '/sessions', {
    body,
    rev: true,
    key: opts.key,
  });
  return sessionWriteResult(r);
}

/**
 * Append turns to an existing session. Append-only.
 *
 * ⚠ PASS A KEY, AND REUSE IT ON A RETRY. Without one, sending the same body twice
 *   appends twice — probed: `seq` 3 then 4 from two identical calls. With a
 *   repeated key the second call answers `{applied:true, seq:<original>, Duplicate:true}`
 *   and the transcript keeps ONE row. `applied` means "stored", not "just stored".
 */
export async function appendSessionMessages(
  id: string,
  messages: Array<Omit<HubSessionMessage, 'seq'>>,
  opts: { key?: string } = {},
): Promise<HubAppendResult> {
  const r = await hubRequest<{ rev?: number; applied?: unknown; seq?: unknown }>(
    'POST',
    `/sessions/${encodeURIComponent(id)}/messages`,
    { body: { messages }, rev: true, key: opts.key },
  );
  if (!r.ok) {
    return { ok: false, rev: currentRev(), applied: false, seq: 0, duplicate: false, ...pick(r) };
  }
  return {
    ok: true,
    rev: currentRev(),
    applied: r.data?.applied === true,
    seq: Number(r.data?.seq) || 0,
    duplicate: r.duplicate,
  };
}

/**
 * One page of transcript, ascending by `seq` (one-based).
 *
 * This is the ONLY route that returns messages, and it is a page: `more`/`next`
 * say whether the session continues past it.
 */
export async function fetchSessionMessages(
  id: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<HubMessagesResult> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.offset) q.set('offset', String(opts.offset));
  const suffix = q.toString() ? `?${q}` : '';
  const r = await hubRequest<{
    rev?: number;
    items?: unknown;
    next?: unknown;
    more?: unknown;
    limit?: unknown;
  }>('GET', `/sessions/${encodeURIComponent(id)}/messages${suffix}`);
  if (!r.ok) {
    return { ok: false, rev: currentRev(), items: [], next: null, more: false, limit: 0, ...pick(r) };
  }
  const items = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]) : [];
  return {
    ok: true,
    rev: currentRev(),
    items: items.map(readMessage),
    next: typeof r.data?.next === 'string' ? r.data.next : null,
    more: r.data?.more === true,
    limit: Number(r.data?.limit) || 0,
  };
}

/**
 * Patch a session's metadata.
 *
 * ⚠ THE REV GOES IN THE BODY. `§4.9` prints `-` for this route as though it took
 *   no guard at all; it refuses with `400 REV_REQUIRED` without one, and an
 *   `If-Match` does not satisfy it.
 */
export async function patchSession(
  id: string,
  patch: { title?: string; status?: HubSessionStatus; pinned?: boolean },
): Promise<HubSessionResult> {
  const r = await hubRequest<{ rev?: number } & Record<string, unknown>>(
    'PATCH',
    `/sessions/${encodeURIComponent(id)}`,
    { body: patch, rev: true },
  );
  if (!r.ok) return { ok: false, rev: currentRev(), session: null, ...pick(r) };
  return {
    ok: true,
    rev: currentRev(),
    session: isSession(r.data) ? readSession(r.data) : null,
    etag: typeof r.data?.etag === 'string' ? r.data.etag : undefined,
  };
}

/**
 * Delete a session. Answers `204` with NO body — so no rev, and no session.
 *
 * ⚠ The rev still goes in the body, exactly as for `PATCH`. `?rev=` in the query
 *   is rejected. And the delete does NOT remove the session's summaries.
 */
export async function deleteSession(id: string): Promise<HubSessionResult> {
  const r = await hubRequest<{ rev?: number }>(
    'DELETE',
    `/sessions/${encodeURIComponent(id)}`,
    { rev: true },
  );
  if (!r.ok) return { ok: false, rev: currentRev(), session: null, ...pick(r) };
  return { ok: true, rev: currentRev(), session: null };
}

/**
 * Forget sessions by writing a TOMBSTONE. Rows are never deleted.
 *
 * Omit `agentId` to clear EVERY agent's history. The watermark is re-stamped to
 * "now", and every write re-stamps it, so a row created afterwards is always
 * visible. This is the server's own `sessionsClearedAt`.
 */
export async function clearSessions(
  agentId?: string,
): Promise<HubError & { ok: boolean; rev: number; clearedAt: number; agentId: string | null }> {
  const r = await hubRequest<{ rev?: number; clearedAt?: unknown; agentId?: unknown }>(
    'POST',
    '/sessions/clear',
    { body: agentId ? { agentId } : {}, rev: true },
  );
  if (!r.ok) {
    return { ok: false, rev: currentRev(), clearedAt: 0, agentId: null, ...pick(r) };
  }
  return {
    ok: true,
    rev: currentRev(),
    clearedAt: Number(r.data?.clearedAt) || 0,
    agentId: typeof r.data?.agentId === 'string' ? r.data.agentId : null,
  };
}

/** Every summary version of one session, newest first. */
export async function fetchSessionSummaries(id: string): Promise<HubSummariesResult> {
  const r = await hubRequest<{ rev?: number; sessionId?: unknown; items?: unknown; count?: unknown }>(
    'GET',
    `/sessions/${encodeURIComponent(id)}/summaries`,
  );
  if (!r.ok) return { ok: false, rev: currentRev(), sessionId: id, items: [], count: 0, ...pick(r) };
  const items = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]) : [];
  return {
    ok: true,
    rev: currentRev(),
    sessionId: typeof r.data?.sessionId === 'string' ? r.data.sessionId : id,
    items: items.map(readSummary),
    count: Number(r.data?.count) || items.length,
  };
}

/**
 * Write a NEW summary version. Never an edit of the old one.
 *
 * `respond: false` keeps the hub from also answering in prose. Scope
 * `sessions.summarize` — 10/minute. When the hub has no LLM credential it skips
 * the work and says so: `summariseSkipped: 'no provider'`, `summarised: false`.
 */
export async function summarizeSession(
  id: string,
  input: { summary?: string | null; respond?: boolean } = {},
): Promise<{
  ok: boolean;
  rev: number;
  sessionId: string;
  summary: HubSummary | null;
  summarised: boolean;
  summariseSkipped: string | null;
} & HubError> {
  const r = await hubRequest<{
    rev?: number;
    sessionId?: unknown;
    summary?: unknown;
    summarised?: unknown;
    summariseSkipped?: unknown;
  }>('POST', `/sessions/${encodeURIComponent(id)}/summarize`, {
    body: input,
    rev: true,
  });
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      sessionId: id,
      summary: null,
      summarised: false,
      summariseSkipped: null,
      ...pick(r),
    };
  }
  return {
    ok: true,
    rev: currentRev(),
    sessionId: typeof r.data?.sessionId === 'string' ? r.data.sessionId : id,
    summary: r.data?.summary && typeof r.data.summary === 'object'
      ? readSummary(r.data.summary)
      : null,
    summarised: r.data?.summarised === true,
    summariseSkipped:
      typeof r.data?.summariseSkipped === 'string' ? r.data.summariseSkipped : null,
  };
}

/**
 * Full-text search — over SUMMARIES only, never over transcripts.
 *
 * A session with no summary is invisible here however much was said in it, which
 * is why the per-session transcript read is not interchangeable with this.
 */
export async function searchSessions(
  query: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<HubSearchResult> {
  const q = new URLSearchParams({ q: query });
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.offset) q.set('offset', String(opts.offset));
  const r = await hubRequest<{
    rev?: number;
    items?: unknown;
    query?: unknown;
    ranked?: unknown;
    more?: unknown;
    limit?: unknown;
  }>('GET', `/sessions/search?${q}`);
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      items: [],
      query,
      ranked: false,
      more: false,
      limit: 0,
      ...pick(r),
    };
  }
  const items = Array.isArray(r.data?.items) ? (r.data?.items as unknown[]) : [];
  return {
    ok: true,
    rev: currentRev(),
    items: items.map(readSummary),
    query: typeof r.data?.query === 'string' ? r.data.query : query,
    ranked: r.data?.ranked === true,
    more: r.data?.more === true,
    limit: Number(r.data?.limit) || 0,
  };
}

/**
 * Counts, words and summary coverage.
 *
 * ⚠ `summaries` can exceed what the listed sessions own: deleting a session
 *   leaves its summary rows behind, so `summaries` is a store-wide count.
 */
export async function fetchSessionStats(): Promise<HubSessionStatsResult> {
  const r = await hubRequest<{ rev?: number } & Record<string, unknown>>(
    'GET',
    '/sessions/stats',
  );
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      sessions: 0,
      turns: 0,
      words: 0,
      summaries: 0,
      summarised: 0,
      unsummarised: 0,
      coverage: 0,
      byKind: {},
      tombstone: { all: null, byAgent: {} },
      ...pick(r),
    };
  }
  const by = r.data?.byKind;
  return {
    ok: true,
    rev: currentRev(),
    sessions: Number(r.data?.sessions) || 0,
    turns: Number(r.data?.turns) || 0,
    words: Number(r.data?.words) || 0,
    summaries: Number(r.data?.summaries) || 0,
    summarised: Number(r.data?.summarised) || 0,
    unsummarised: Number(r.data?.unsummarised) || 0,
    coverage: Number(r.data?.coverage) || 0,
    byKind: by && typeof by === 'object' ? (by as Record<string, number>) : {},
    tombstone: readTombstone(r.data?.tombstone),
  };
}

/* ------------------------------------------------------------------------- */
/* Memory and recall — the hub's long-term store                               */
/* ------------------------------------------------------------------------- */
//
// THE APP'S OWN COMPACTION MOVES TO THE SERVER
//   Local memory folded its own log into a digest with an LLM call made from the
//   browser, and capped itself at 100,000 words because a WebView bridge write
//   could fail silently past a few tens of KB. The hub holds the log now and
//   reports its own `capWords` — 4,000, verified live, which is
//   `MEMORY_MAX_WORDS` — together with `digestWords` (400). So the caps are the
//   SERVER's numbers and are read from the response, never assumed. Compaction is
//   `POST /hub/memory/compact`, which does the folding itself; when the hub has no
//   LLM credential it declines and says why.
//
// ⚠ `PUT /hub/memory` DOES NOT REPLACE.
//   The document says "Replace the whole of memory with what the client sent".
//   Probed: sending `{digest: '', turns: []}` against a store holding one turn
//   answered `added: 0` and left `turns: 1`. It ADDS the turns it is given. The
//   only way to empty the store is `DELETE /hub/memory`, which writes a tombstone
//   and takes the turns and the digest together.
//
// ⚠ `POST /hub/memory/turns` TAKES ONE TURN, NOT AN ARRAY.
//   The body is a turn. An array is not a batch — the route is named for the
//   single turn it appends, and the response is the whole projection back.
//
// ⚠ `POST /hub/recall` REJECTS `minScore` AND `includeMessages` WITH `501`.
//   Probed: `{"text":"x","minScore":0.5}` answers `501 NOT_IMPLEMENTED` with
//   `details.field = "minScore"` and the reason "recall does not filter by score;
//   nothing in the pipeline produces one". Do not send either.

/** The `JarvisMemory` projection. `turns` and `words` are COUNTS, not lists. */
export interface HubMemory {
  versions: number;
  digest: string;
  digestAt: number;
  folded: number;
  /** How many turns are held verbatim. A number — the turns themselves never come back. */
  turns: number;
  /** Digest words plus verbatim words. */
  words: number;
  liveWords: number;
  capWords: number;
  digestWords: number;
}

export interface HubMemoryResult extends HubError {
  ok: boolean;
  rev: number;
  memory: HubMemory;
  /** Turns the call actually added. Present on a write. */
  added?: number;
  /** Whether a compaction folded anything. */
  compacted?: boolean;
  /** Why it did not: `'provider down'` when the hub has no working LLM. */
  compactSkipped?: string | null;
  version?: number;
}

/**
 * One turn to append. The hub stamps `at` itself, so it is optional here.
 *
 * A `type` for the same reason `SessionSaveBody` is: the implicit index
 * signature is what lets it be a request body without a cast.
 */
export type MemoryTurnInput = {
  role: 'user' | 'assistant';
  text: string;
  at?: number;
};

export interface HubRecallResult extends HubError {
  ok: boolean;
  rev: number;
  selected: unknown[];
  candidates: number;
  ranked: boolean;
  /** Why nothing was ranked — e.g. `'nothing to rank'` on an empty store. */
  reason: string;
  serverTime: number;
}

/**
 * The hub's memory ceilings, from `§12.1` and confirmed live (`capWords: 4000`,
 * `digestWords: 400`).
 *
 * Used only as a fallback: every real memory response carries both, so these
 * fire for a `204` or an error envelope — the shapes that carry no projection at
 * all — and they exist so a caller never renders a cap of `0` after a clear.
 */
const HUB_MEMORY_CAP_WORDS = 4_000;
const HUB_MEMORY_DIGEST_WORDS = 400;

function readMemory(raw: unknown): HubMemory {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    versions: Number(o.versions) || 0,
    digest: typeof o.digest === 'string' ? o.digest : '',
    digestAt: Number(o.digestAt) || 0,
    folded: Number(o.folded) || 0,
    turns: Number(o.turns) || 0,
    words: Number(o.words) || 0,
    liveWords: Number(o.liveWords) || 0,
    capWords: Number(o.capWords) || HUB_MEMORY_CAP_WORDS,
    digestWords: Number(o.digestWords) || HUB_MEMORY_DIGEST_WORDS,
  };
}

function memoryResult(
  r: HubRequestResult<{ rev?: number } & Record<string, unknown>>,
): HubMemoryResult {
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      memory: readMemory(null),
      ...pick(r),
    };
  }
  return {
    ok: true,
    rev: currentRev(),
    memory: readMemory(r.data),
    added: typeof r.data?.added === 'number' ? r.data.added : undefined,
    compacted: typeof r.data?.compacted === 'boolean' ? r.data.compacted : undefined,
    compactSkipped:
      typeof r.data?.compactSkipped === 'string' ? r.data.compactSkipped : undefined,
    version: typeof r.data?.version === 'number' ? r.data.version : undefined,
  };
}

/**
 * The whole memory projection.
 *
 * Counts and the digest — never the turns, which the hub does not return. An
 * empty store is a valid empty projection, not a `404`.
 */
export async function fetchMemory(): Promise<HubMemoryResult> {
  return memoryResult(
    await hubRequest<{ rev?: number } & Record<string, unknown>>('GET', '/memory'),
  );
}

/** Forget everything. `204`, by tombstone — turns and digest go together. */
export async function clearMemory(): Promise<HubMemoryResult> {
  const r = await hubRequest<{ rev?: number }>('DELETE', '/memory', { rev: true });
  if (!r.ok) return { ok: false, rev: currentRev(), memory: readMemory(null), ...pick(r) };
  return { ok: true, rev: currentRev(), memory: readMemory(null) };
}

/**
 * Append ONE turn. Not an array.
 *
 * The response is the whole projection back, so the caller never needs a second
 * read to learn the new counts.
 */
export async function appendMemoryTurn(
  turn: MemoryTurnInput,
  opts: { key?: string } = {},
): Promise<HubMemoryResult> {
  return memoryResult(
    await hubRequest<{ rev?: number } & Record<string, unknown>>('POST', '/memory/turns', {
      body: turn,
      rev: true,
      key: opts.key,
    }),
  );
}

/**
 * Fold the turns that arrived since the last digest into a NEW version.
 *
 * `respond: false` stops the hub also narrating the result. The hub declines when
 * its provider is down — `compacted: false`, `compactSkipped: 'provider down'` —
 * which is a SUCCESS carrying a reason, not a failure.
 */
export async function compactMemory(
  respond = false,
): Promise<HubMemoryResult> {
  return memoryResult(
    await hubRequest<{ rev?: number } & Record<string, unknown>>('POST', '/memory/compact', {
      body: { respond },
      rev: true,
    }),
  );
}

/**
 * Add the turns given and set the digest. NOT a replace — see the block note.
 *
 * Kept for the import path, which is the one caller that legitimately hands over
 * a whole memory. It cannot remove anything: only `clearMemory` can.
 */
export async function putMemory(body: {
  digest?: string;
  turns?: MemoryTurnInput[];
}): Promise<HubMemoryResult> {
  // Only the keys actually given. `undefined` would be dropped by
  // `JSON.stringify` anyway, but naming them keeps the intent readable.
  const payload: Record<string, unknown> = {};
  if (body.digest !== undefined) payload.digest = body.digest;
  if (body.turns !== undefined) payload.turns = body.turns;
  return memoryResult(
    await hubRequest<{ rev?: number } & Record<string, unknown>>('PUT', '/memory', {
      body: payload,
    }),
  );
}

/**
 * Turn an utterance into the few sessions most likely to answer it.
 *
 * ⚠ NEVER SEND `minScore` OR `includeMessages` — both are `501 NOT_IMPLEMENTED`.
 * `reason` explains an empty result (`'nothing to rank'`); `ranked: false` says
 * the hub did not score anything, which is not the same as "nothing matched".
 */
export async function recall(body: {
  text: string;
  limit?: number;
  top?: number;
}): Promise<HubRecallResult> {
  const r = await hubRequest<{
    rev?: number;
    selected?: unknown;
    candidates?: unknown;
    ranked?: unknown;
    reason?: unknown;
    serverTime?: unknown;
  }>('POST', '/recall', { body });
  if (!r.ok) {
    return {
      ok: false,
      rev: currentRev(),
      selected: [],
      candidates: 0,
      ranked: false,
      reason: '',
      serverTime: 0,
      ...pick(r),
    };
  }
  return {
    ok: true,
    rev: currentRev(),
    selected: Array.isArray(r.data?.selected) ? (r.data?.selected as unknown[]) : [],
    candidates: Number(r.data?.candidates) || 0,
    ranked: r.data?.ranked === true,
    reason: typeof r.data?.reason === 'string' ? r.data.reason : '',
    serverTime: Number(r.data?.serverTime) || 0,
  };
}

// ── ledger ──────────────────────────────────────────────────────────────────
//
// APPEND ONLY, and the app is not the authority on the numbering. Three rules
// from probing shape everything below:
//
//   1. **`runId` MUST be a canonically-hyphenated uuid v4.** A batch carrying
//      anything else is refused with `400 VALIDATION_ERROR "runId must be a uuid
//      v4"`. This is in no published document. It is why `ai/store.ts` mints its
//      run ids with `newRunId()` instead of the short local string it used to.
//   2. **The batch is validated WHOLE, before any of it is written.** One bad
//      entry costs every entry in the burst — so a batch is either entirely in
//      or entirely absent, and a retry cannot half-apply.
//   3. **An `irreversible` effect needs an earlier `ok` `gate` entry in the same
//      run**, in this batch or an earlier one (`§15.6.7`). The hub enforces the
//      same invariant the local ledger does in `needsGate`, so the ordering that
//      satisfies one satisfies the other.
//
// `rev` is NOT required and does NOT move — a ledger write is not a
// control-plane change, so it can never be refused `STALE_REV` and needs no
// serialisation against the rev. It still needs an `Idempotency-Key`: the batch
// is a write, and a lost response would otherwise double the audit trail.

/**
 * One entry as the hub stores and returns it.
 *
 * Deliberately NOT the local `Entry`, even though every field matches: `seq`
 * here is the HUB's number ("numbered by the server"), whereas `Entry.seq` is
 * the app's own causal handle and the thing `refs` actually point at. Two
 * different numbers sharing a name is exactly how a causal chain gets silently
 * misread, so the types stay separate.
 *
 * The unions are imported rather than restated so the compiler holds the app's
 * vocabulary and the hub's `§12` enums together — a divergence becomes a type
 * error instead of a `400` at runtime.
 */
export interface LedgerEntryWire {
  seq: number;
  runId: string;
  at: number;
  kind: EntryKind;
  by: EntryBy;
  effect: Effect;
  status: EntryStatus;
  text: string;
  /**
   * A LIST on the wire, a JSON-array text column in the database. Held in the
   * app's own seq space: the hub stores these verbatim and never resolves them,
   * so they keep meaning "the local entries this one was built from".
   */
  refs: number[];
  locus?: EntryLocus;
  payload?: unknown;
}

/** What `appendLedger` sends. The server stamps `at`; `payload`/`locus` optional. */
export type LedgerAppendInput = Omit<LedgerEntryWire, 'seq' | 'at'> & { at?: number };

export interface LedgerAppendResult extends HubError {
  ok: boolean;
  rev: number;
  /** How many were written. Equals the batch length, or the batch was refused. */
  appended: number;
  /** The server seqs the batch occupies, so a caller can keep its own map. */
  fromSeq: number;
  toSeq: number;
  entries: LedgerEntryWire[];
}

export interface LedgerListResult extends HubError {
  ok: boolean;
  rev: number;
  items: LedgerEntryWire[];
  more: boolean;
  next: string | null;
  limit: number;
}

function readLedgerEntry(raw: unknown): LedgerEntryWire {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    seq: Number(o.seq) || 0,
    runId: typeof o.runId === 'string' ? o.runId : '',
    at: Number(o.at) || 0,
    kind: o.kind as EntryKind,
    by: o.by as EntryBy,
    effect: o.effect as Effect,
    status: o.status as EntryStatus,
    text: typeof o.text === 'string' ? o.text : '',
    refs: Array.isArray(o.refs) ? (o.refs as unknown[]).map(Number) : [],
    // Kept only when present: an absent `locus` and an explicit `undefined` are
    // the same to the hub, and probing showed it echoes back what it was given.
    ...(o.locus !== undefined ? { locus: o.locus as EntryLocus } : {}),
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
  };
}

/**
 * Read entries, ASCENDING by default (`§6.12`) — oldest first, which is the
 * order a causal chain has to be read in.
 *
 * `runId` narrows to one run and `sinceSeq` is a server-seq cursor, so
 * `sinceSeq` is NOT comparable with a local `Entry.seq`. A caller resuming from
 * its own watermark must use `runId` and filter locally, or track the server
 * seqs from `LedgerAppendResult`.
 */
export async function fetchLedger(
  opts: { limit?: number; runId?: string; sinceSeq?: number } = {},
): Promise<LedgerListResult> {
  const q = new URLSearchParams();
  if (opts.limit !== undefined) q.set('limit', String(opts.limit));
  if (opts.runId) q.set('runId', opts.runId);
  if (opts.sinceSeq !== undefined) q.set('sinceSeq', String(opts.sinceSeq));
  const suffix = q.toString() ? `?${q.toString()}` : '';
  const r = await hubRequest<{
    rev?: number;
    items?: unknown;
    more?: unknown;
    next?: unknown;
    limit?: unknown;
  }>('GET', `/ledger${suffix}`);
  if (!r.ok) {
    return { ok: false, rev: currentRev(), items: [], more: false, next: null, limit: 0, ...pick(r) };
  }
  return {
    ok: true,
    rev: currentRev(),
    items: Array.isArray(r.data?.items) ? r.data.items.map(readLedgerEntry) : [],
    more: r.data?.more === true,
    next: typeof r.data?.next === 'string' ? r.data.next : null,
    limit: Number(r.data?.limit) || 0,
  };
}

/**
 * Append a burst in ONE transaction.
 *
 * Returns `appended: 0` rather than throwing when the batch is empty, so a
 * caller can flush unconditionally without a guard.
 */
export async function appendLedger(
  entries: LedgerAppendInput[],
  opts: { key?: string } = {},
): Promise<LedgerAppendResult> {
  const empty: LedgerAppendResult = {
    ok: true,
    rev: currentRev(),
    appended: 0,
    fromSeq: 0,
    toSeq: 0,
    entries: [],
  };
  if (!entries.length) return empty;

  const r = await hubRequest<{
    rev?: number;
    appended?: unknown;
    fromSeq?: unknown;
    toSeq?: unknown;
    entries?: unknown;
  }>('POST', '/ledger', { body: { entries }, key: opts.key });

  if (!r.ok) {
    return { ok: false, rev: currentRev(), appended: 0, fromSeq: 0, toSeq: 0, entries: [], ...pick(r) };
  }
  return {
    ok: true,
    rev: currentRev(),
    appended: Number(r.data?.appended) || 0,
    fromSeq: Number(r.data?.fromSeq) || 0,
    toSeq: Number(r.data?.toSeq) || 0,
    entries: Array.isArray(r.data?.entries) ? r.data.entries.map(readLedgerEntry) : [],
  };
}
