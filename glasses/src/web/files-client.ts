// Browser-side client for the Jarvis document store (agent-authored HTML).
//
// WHY EVERY CALL GOES THROUGH THE RELAY
//   The store is a separate service (see `web/server/jarvis-files.mjs`) and the
//   browser must never talk to it directly, for three independent reasons:
//     1. Its CORS allow-list is empty, so a direct call cannot even preflight.
//     2. The credential is a server secret — it must not exist in the bundle.
//     3. It sends `X-Frame-Options: SAMEORIGIN`, so its own HTML URL cannot be
//        framed from this origin. The relay re-serves the body through this
//        origin under a sandbox policy, which is the only arrangement that both
//        displays the document AND keeps the document unable to reach this app.
//
// WHERE THE DATA COMES FROM NOW
//   The LIST, the METADATA, the TOTALS, the PUBLISH, the DELETE, the RESTORE
//   and the revision LIST come from the HUB — `GET/POST /hub/files*` — reached
//   through the relay's `/api/hub/*` proxy, the same way every other section of
//   this app does. The hub is the authority for which references exist, so a
//   page published by anything else (the `jarvis_files` MCP tool included) shows
//   up here without a second copy to keep in step.
//
//   Four things CANNOT move, and each is a real derivation rather than a
//   pass-through, so they stay on the relay's `/api/files/*`:
//     • `/text` runs `htmlToText` + `bodyWindow`. The hub's own `/text` answers
//       the RAW body and ignores `limit`/`offset` (probed), so moving this would
//       hand Jarvis a page of HTML where it used to get readable prose.
//     • `/media` runs `extractMedia`, which rebuilds every player URL from a
//       validated id so agent-authored HTML cannot put a `javascript:` URL in an
//       iframe. The hub returns raw, unresolved refs.
//     • `/html` and `/ticket` exist because the gateway refuses to be framed
//       from another origin (`X-Frame-Options: SAMEORIGIN`) — the relay re-serves
//       the body through this origin under a sandbox policy, and mints the
//       short-lived frame ticket. Neither has a hub equivalent.
//     • `/revisions/:n` and its `/restore` have NO hub route at all: the hub
//       exposes the revision LIST and nothing finer. `/status` is the relay's own
//       config introspection and is a relay question by definition.
//
// So this module is a typed wrapper over BOTH: the hub for the registry, the
// relay for anything that has to look INSIDE a body. It holds NO document
// bodies — the list carries references, and the body is fetched by the browser
// straight into a frame (see `fileBodyUrl`), never through JS state.
import { getStreamToken } from '../auth-token';
import { API_BASE } from '../stream';
import {
  createHubFile,
  deleteHubFile,
  fetchHubFile,
  fetchHubFileRevisions,
  fetchHubFileStats,
  fetchHubFiles,
  restoreHubFile,
  type HubFile,
  type HubFileRevision,
} from './hub-client';
import type { FileRef } from '../types';

/** One stored document as the relay reports it (`compactDoc` on the server). */
export interface StoredDoc {
  id: string;
  title: string;
  agent: string;
  slug: string;
  tags: string[];
  version: number;
  size: number;
  /** Canonical address at the gateway — a REFERENCE, never loadable directly. */
  url: string;
  updatedAt: number;
  deleted: boolean;
  /** When it was soft-deleted (ms epoch), or null while it is live. */
  deletedAt?: number | null;
  /** What removed it, e.g. `deleted by mcp client`. Empty while it is live. */
  deletedReason?: string;
}

/**
 * A hub `file_ref` as this app's `StoredDoc`.
 *
 * THE ONE FIELD THAT NEEDS DERIVING IS `deleted`. A live `file_ref` has no
 * `deletedAt` key at all — it is absent, not null — so the flag the panel splits
 * on is `deletedAt !== undefined`. Reading a `deleted` off the wire would give
 * `undefined` for every row and file a deleted document as live.
 */
function toStoredDoc(f: HubFile): StoredDoc {
  return {
    id: f.id,
    title: f.title,
    agent: f.agent,
    slug: f.slug ?? '',
    tags: f.tags,
    version: f.version ?? 1,
    size: f.size,
    url: f.url,
    updatedAt: f.updatedAt,
    deleted: f.deletedAt !== undefined,
    deletedAt: f.deletedAt ?? null,
    deletedReason: f.deletedReason,
  };
}

export interface FilesStatus {
  ok: boolean;
  /** True when the relay holds a credential. Not a probe: never means "up". */
  configured?: boolean;
  mode?: 'api_key' | 'password' | string;
  url?: string;
  /**
   * A second origin for stored documents, or '' when the deployment has none.
   *
   * Its presence is the ONE thing that decides whether a document is framed
   * from another host — and therefore whether that frame still needs a sandbox.
   * See web/server/doc-origin.mjs.
   */
  docOrigin?: string;
  /** What to set when `configured` is false, naming the env vars. */
  hint?: string;
  error?: string;
}

export interface ListResult {
  ok: boolean;
  items: StoredDoc[];
  total: number;
  hasMore: boolean;
  error?: string;
}

export interface PublishInput {
  html: string;
  title?: string;
  agent?: string;
  tags?: string[];
  /** 32-hex id: re-sending the same id makes publishing idempotent. */
  id?: string;
  slug?: string;
  overwrite?: boolean;
  /** Only needed to force prose through as `text/plain`. */
  contentType?: string;
}

/** Whose name a document is filed under when this app publishes one. */
export const SELF_AGENT = 'g2-hub';

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const token = getStreamToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** Read the relay's error shape, which always carries `error` + `code`. */
async function failure(res: Response): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  return j?.error || j?.code || `HTTP ${res.status}`;
}

async function getJson<T>(path: string): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
    // No throw on failure: every caller wanted a value to render, not an
    // exception to catch, so the shape is "ok OR an error to show".
    if (!res.ok) return { ok: false, error: await failure(res) } as unknown as T;
    return (await res.json()) as T;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as unknown as T;
  }
}

async function sendJson<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: authHeaders(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: await failure(res) } as unknown as T;
    return (await res.json()) as T;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as unknown as T;
  }
}

/**
 * Is the document store wired up on the relay? Cheap, credential-only — it says
 * whether a credential EXISTS, never whether the gateway is reachable, so a
 * brief outage cannot make the page claim the feature is unconfigured.
 */
export function fetchFilesStatus(): Promise<FilesStatus> {
  return getJson<FilesStatus>('/api/files/status');
}

/** One document's metadata, or an error to render. */
export interface ReadResult {
  ok: boolean;
  document?: StoredDoc;
  error?: string;
}

/**
 * The result of a delete, or an error to render.
 *
 * `deleted` is a BOOLEAN and the relay is obliged to keep it one: this type used
 * to promise a boolean while the relay nested the whole document under that key,
 * so `res.deleted === true` was false for a delete that had actually succeeded.
 */
export interface DeleteResult {
  ok: boolean;
  id?: string;
  /** True when the stored bytes were purged rather than flagged. */
  hard?: boolean;
  deleted?: boolean;
  error?: string;
}

/** The result of a restore, or an error to render. */
export interface RestoreResult {
  ok: boolean;
  document?: StoredDoc;
  error?: string;
}

/**
 * The stored documents, newest first by default (the gateway's own order).
 *
 * `includeDeleted` is what a restore list is built from. Without it the hub's
 * list carries only live references, so a soft-deleted one is unreachable from
 * this app entirely — not in the list, a 404 to a direct read — even though its
 * bytes are still on the gateway.
 *
 * TWO SHAPE DIFFERENCES FROM THE OLD RELAY LIST, both absorbed here:
 *   • The hub pages with `more`/`next` and reports NO total for a filtered list.
 *     `total` is therefore the page length, which is what every caller in this
 *     app actually wanted (a mode label), and `hasMore` is the hub's `more`.
 *   • `includeDeleted` becomes the hub's `includeDeleted`. The relay's spelling
 *     was snake_case; sending the wrong one is not an error, it just returns the
 *     live list — the Deleted tab would look empty with no hint why.
 */
export async function listFiles(opts: {
  limit?: number;
  offset?: number;
  q?: string;
  agent?: string;
  tag?: string;
  includeDeleted?: boolean;
} = {}): Promise<ListResult> {
  const res = await fetchHubFiles(opts);
  if (!res.ok) return { ok: false, items: [], total: 0, hasMore: false, error: res.error };
  const items = res.items.map(toStoredDoc);
  return { ok: true, items, total: items.length, hasMore: res.more };
}

/** One document's metadata. Never the body — that is what the frame is for. */
export async function readFile(id: string): Promise<ReadResult> {
  const res = await fetchHubFile(id);
  if (!res.ok) return { ok: false, error: res.error };
  if (!res.file) return { ok: false, error: 'the hub returned no file record' };
  return { ok: true, document: toStoredDoc(res.file) };
}

/**
 * One window of a document's readable TEXT, or an error to render.
 *
 * `total` is the length of the whole readable text (the HTML stripped, so NOT
 * the document's byte size), and `next` is the offset that continues it — null
 * when the window reached the end. Both are computed by the relay, so this app
 * and the relay's own agent loop cannot disagree about where a split read
 * resumes.
 */
export interface TextResult {
  ok: boolean;
  text?: string;
  offset?: number;
  total?: number;
  next?: number | null;
  more?: boolean;
  error?: string;
}

/**
 * The document body as TEXT.
 *
 * The raw HTML is deliberately not reachable through here — that is `/html`,
 * which a sandboxed frame fetches and renders. This is the readable view, the
 * only form of a body a model is ever given, and it is windowed by the relay
 * for that reason.
 *
 * STAYS ON THE RELAY, and the window is why. The hub's `/files/{id}/text`
 * answers the RAW body and IGNORES `limit`/`offset` (probed: a request for 7
 * characters at offset 5 came back with `limit` equal to the whole length). Its
 * route is the bytes; this route is the readable, resumable view of them.
 */
export function readFileText(id: string, opts: { offset?: number; limit?: number } = {}): Promise<TextResult> {
  const q = new URLSearchParams();
  if (opts.offset) q.set('offset', String(opts.offset));
  if (opts.limit) q.set('limit', String(opts.limit));
  const suffix = q.toString() ? `?${q}` : '';
  return getJson<TextResult>(`/api/files/${encodeURIComponent(id)}/text${suffix}`);
}

/**
 * Publish (or, with `overwrite`, replace) a document.
 *
 * `POST /hub/files` publishes the body to the gateway AND records the reference,
 * so one call still does both jobs — the split is server-side. The record comes
 * back under `file`, which is what turns this into the id the caller selects.
 *
 * `contentType` has no hub column and is dropped: it only ever existed to force
 * prose through as `text/plain`, and every caller in this app publishes HTML.
 */
export async function publishFile(input: PublishInput): Promise<ReadResult> {
  const { contentType: _contentType, ...rest } = input;
  const res = await createHubFile({ agent: SELF_AGENT, ...rest });
  if (!res.ok) return { ok: false, error: res.error };
  if (!res.file) return { ok: false, error: 'published, but the hub returned no record' };
  return { ok: true, document: toStoredDoc(res.file) };
}

/**
 * Delete a document. SOFT by default — the gateway keeps the bytes, and the
 * Files page lists it under "Deleted" with a Restore button, so the deletion is
 * genuinely reversible. Pass `hard: true` to purge the stored bytes, which is
 * the only version of this that cannot be undone.
 *
 * The hub answers `204`, so there is NO body to read and no rev to take. The
 * flat shape below is built here rather than parsed: `deleted` answers "is it
 * gone from the live list?", not "did the request work?" (that is `ok`).
 */
export async function deleteFile(id: string, hard = false): Promise<DeleteResult> {
  const res = await deleteHubFile(id, hard);
  if (!res.ok) return { ok: false, id, hard, deleted: false, error: res.error };
  return { ok: true, id, hard, deleted: true };
}

/**
 * Undo a SOFT delete.
 *
 * The hub owns this: a soft delete is a flag on the REFERENCE, so undoing it is
 * a hub write and not a gateway one. The hub answers `200` — not `201`, because
 * nothing was created. Restoring a document that is still live is harmless, so
 * this can be called without knowing the current state.
 */
export async function restoreFile(id: string): Promise<RestoreResult> {
  const res = await restoreHubFile(id);
  if (!res.ok) return { ok: false, error: res.error };
  // The hub answers `200`, and whether it echoes the record back is not
  // documented. A restore that WORKED must not be reported as a failure, so an
  // absent record is filled by reading it — which now succeeds, because the row
  // is live again.
  if (res.file) return { ok: true, document: toStoredDoc(res.file) };
  const back = await fetchHubFile(id);
  return { ok: true, document: back.file ? toStoredDoc(back.file) : undefined };
}

/**
 * What an in-place edit may change. Every field is optional because the gateway
 * treats "edit" as a patch, not a replacement: sending only `title` leaves the
 * stored bytes exactly as they were and still mints a new version.
 */
export interface UpdateInput {
  html?: string;
  title?: string;
  tags?: string[];
  agent?: string;
  contentType?: string;
  /**
   * Refuse the edit if the document has moved past this version.
   *
   * Worth setting whenever the version is known, because the gateway's
   * answer when it is stale is a real `conflict` rather than a silent
   * overwrite — and the wearer re-reads instead of losing someone's work.
   */
  ifVersion?: number;
}

/**
 * Edit a document in place.
 *
 * Distinct from `publishFile`, and the distinction is the gateway's own: publish
 * mints a version from a REPLACEMENT body, while this can change the title or
 * the tags alone and leave the stored document untouched. Sending an empty
 * `html` is refused upstream rather than stored, because an edit that blanks a
 * document is always a mistake — deleting is the operation that means that.
 *
 * STAYS ON THE RELAY: the hub has no `PATCH /hub/files/{id}`. Its nine file
 * routes are list, publish, stats, read, delete, media, restore, revisions and
 * text — there is no way to change a title or a tag in place, so this keeps
 * going to the gateway. Publishing over the same id with `overwrite` is the hub
 * route that comes closest, and it rewrites the body, which is not a patch.
 */
export function updateFile(id: string, input: UpdateInput): Promise<ReadResult> {
  return sendJson<ReadResult>('PATCH', `/api/files/${encodeURIComponent(id)}`, input);
}

/**
 * One entry in a document's change log.
 *
 * `revision` and `version` are NOT the same number and the difference matters:
 * `revision` is the position in the history (1, 2, 3, … — every change gets
 * one), while `version` is the document version that entry produced. A metadata
 * edit appends a revision without moving the version.
 */
export interface RevisionRef {
  id: string;
  revision: number;
  version: number;
  /** `create` | `replace` | `update` | `delete` | `restore` | `purge` | `revert`. */
  change: string;
  title: string;
  agent: string;
  size: number;
  contentType?: string;
  /** False when the entry only touched metadata — a rename, or a tag change. */
  contentChanged: boolean;
  createdAt: number;
  tags: string[];
  /** Who caused it, e.g. `mcp`. Absent when nobody was recorded. */
  subject?: string;
}

/**
 * A hub revision entry as this app's `RevisionRef`.
 *
 * TWO DIFFERENCES, both absorbed here:
 *   • `created_at` arrives as an ISO STRING, where every other timestamp in this
 *     API is a ms epoch. It is parsed, so `createdAt` stays the number the rest
 *     of this app and its `new Date(...)` callers already expect.
 *   • The entry has no `id` of its own — its `id` is the FILE id — so the id is
 *     passed in rather than read off the record.
 */
function toRevisionRef(h: HubFileRevision, id: string): RevisionRef {
  return {
    id,
    revision: h.revision,
    version: h.version ?? 1,
    change: h.change,
    title: h.title ?? '',
    agent: h.agent ?? '',
    size: h.size ?? 0,
    contentChanged: h.contentChanged === true,
    createdAt: h.createdAt ? Date.parse(h.createdAt) || 0 : 0,
    tags: h.tags ?? [],
    subject: h.subject,
  };
}

export interface RevisionListResult {
  ok: boolean;
  items: RevisionRef[];
  total: number;
  hasMore: boolean;
  error?: string;
}

export interface RevisionResult {
  ok: boolean;
  revision?: RevisionRef;
  error?: string;
}

/**
 * A document's change log, newest first.
 *
 * `change` filters by kind, which is what makes "what has anything deleted?"
 * one call.
 *
 * THE HUB KEEPS THE HISTORY; THE RELAY STILL KEEPS THE PAGING. `GET /hub/files/
 * {id}/revisions` answers the whole list and accepts no filters at all, while
 * the gateway answered one page and honoured `change`, `subject`, `order`,
 * `limit` and `offset`. The filters are applied HERE instead, over the list the
 * hub returns — the right call for a per-document history, which is a handful of
 * entries, and the only one that keeps this signature working for its callers.
 * A `limit`/`offset` is therefore a slice of a list already in memory.
 */
export async function listRevisions(
  id: string,
  opts: { change?: string; subject?: string; order?: string; limit?: number; offset?: number } = {},
): Promise<RevisionListResult> {
  const res = await fetchHubFileRevisions(id);
  if (!res.ok) return { ok: false, items: [], total: 0, hasMore: false, error: res.error };
  let items = res.items.map((h) => toRevisionRef(h, id));
  if (opts.change) items = items.filter((r) => r.change === opts.change);
  if (opts.subject) items = items.filter((r) => r.subject === opts.subject);
  if (opts.order === 'revision_asc') items = items.slice().reverse();
  const offset = opts.offset || 0;
  const window = opts.limit ? items.slice(offset, offset + opts.limit) : items.slice(offset);
  return {
    ok: true,
    items: window,
    total: items.length,
    hasMore: offset + window.length < items.length,
  };
}

/**
 * One past revision's metadata. Never its body — same rule as `readFile`.
 *
 * STAYS ON THE RELAY. The hub publishes the revision LIST and nothing finer:
 * there is no `/hub/files/{id}/revisions/{n}` and no restore-this-revision
 * route, which §14.1 confirms by pointing a client at the gateway's
 * `/sessions/{id}/revisions/...` family for exactly this. So the read and the
 * revert below still go to the gateway, through the relay.
 */
export function readRevision(id: string, revision: number): Promise<RevisionResult> {
  return getJson<RevisionResult>(
    `/api/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(revision))}`,
  );
}

/**
 * Make a past revision current again.
 *
 * NOT the inverse of `deleteFile` — that is `restoreFile`. This is the gateway's
 * `restore_revision`, and it works by APPENDING a `revert` entry rather than
 * rewinding: the versions it replaced stay in the history, so a revert is itself
 * undoable and nothing needs confirming twice.
 */
export function restoreRevision(
  id: string,
  revision: number,
  opts: { restoreMetadata?: boolean; ifVersion?: number } = {},
): Promise<RestoreResult> {
  return sendJson<RestoreResult>(
    'POST',
    `/api/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(revision))}/restore`,
    { restoreMetadata: opts.restoreMetadata !== false, ...(opts.ifVersion ? { ifVersion: opts.ifVersion } : {}) },
  );
}

/**
 * Library totals — the archive's own answer to "how much is stored here?"
 *
 * Every field is optional, and now for a second reason: the hub reports FIVE
 * numbers and no more (`total`, `bytes`, `deleted` and a per-agent split), so
 * the fields the old relay filled from the gateway's MCP stats tools — `tags`,
 * `revisions`, `content_changes`, `database_bytes` — are left undefined rather
 * than invented. Render what is present.
 */
export interface FileStats {
  ok: boolean;
  error?: string;
  /** `session_stats` only. */
  sessions?: number;
  live_sessions?: number;
  deleted_sessions?: number;
  agents?: number;
  tags?: number;
  bytes?: number;
  database_bytes?: number;
  storage_bytes?: number;
  oldest_created_at?: number | null;
  newest_created_at?: number | null;
  /** Both tools report revision counts; archive-wide unless an id was given. */
  revisions?: number;
  content_changes?: number;
  revision_bytes?: number;
}

/**
 * The archive's totals, or one document's revision count when `id` is given.
 *
 * The hub answers the archive question in one call. It has no per-document
 * totals at all, so when an id is named this asks that document's REVISIONS
 * route and reports how many there are — the same number the gateway's
 * `revision_stats` tool was being used for.
 *
 * `sessions` keeps its old meaning (live + deleted) because a caller reads it as
 * "how many documents are there", and `agents` is the count of agents that own
 * at least one reference — which is exactly what the hub's `byAgent` map is.
 */
export async function fetchFileStats(id?: string): Promise<FileStats> {
  if (id) {
    const revs = await fetchHubFileRevisions(id);
    if (!revs.ok) return { ok: false, error: revs.error };
    return { ok: true, sessions: 1, live_sessions: 1, revisions: revs.count };
  }
  const res = await fetchHubFileStats();
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    sessions: res.total,
    live_sessions: res.total - res.deleted,
    deleted_sessions: res.deleted,
    agents: Object.keys(res.byAgent).length,
    bytes: res.bytes,
  };
}

/**
 * The URL to put in an `<iframe src>` for a document body.
 *
 * Three things make this what it is:
 *   • It points at the RELAY, not the gateway — the gateway refuses to be framed
 *     from another origin (`X-Frame-Options: SAMEORIGIN`).
 *   • The token is a QUERY parameter. A frame cannot send an `Authorization`
 *     header, so this is the only way to authenticate it; the relay's own token
 *     reader already accepts `?token=`, which is what the SSE channel uses for
 *     the same reason.
 *   • It returns a URL, not a body: the browser streams the document into the
 *     frame, so no HTML ever enters this app's state or storage.
 *
 * The response is served under `Content-Security-Policy: sandbox allow-scripts`,
 * i.e. an opaque origin — the frame is a renderer, not a script host.
 *
 * THAT SANDBOX IS ALSO WHY A DOCUMENT CANNOT PLAY ITS OWN VIDEOS, so this is now
 * the FALLBACK rather than the only option. When the deployment has a document
 * origin (`status.docOrigin`), prefer `fetchDocTicket`: the document is then
 * framed from a host that is not this app's, which needs no sandbox at all and
 * lets its own embeds work. This URL remains the answer where there is none.
 */
export function fileBodyUrl(id: string): string {
  const token = getStreamToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${API_BASE}/api/files/${encodeURIComponent(id)}/html${q}`;
}

/**
 * A short-lived ticket that lets ONE document be framed cross-origin.
 *
 * The RELAY mints it, because this app's session token must never appear in a
 * frame URL: the framed document can read `location`, and it is agent-authored
 * code. The ticket is bound to one document id and lives about two minutes, so
 * it is not a credential worth stealing — it is permission to render one page.
 *
 * `ok: false` is an ordinary outcome, not a failure to surface. It means the
 * deployment has no document origin, and the caller falls back to the sandboxed
 * `fileBodyUrl` above — which is exactly what every deployment did before.
 */
export interface TicketResult {
  ok: boolean;
  /** The absolute frame URL, ticket included. */
  url?: string;
  ttlMs?: number;
  error?: string;
}

export function fetchDocTicket(id: string): Promise<TicketResult> {
  return sendJson<TicketResult>('POST', `/api/files/${encodeURIComponent(id)}/ticket`, {});
}

/**
 * One video a stored document points at, already resolved to safe URLs.
 *
 * Every field is built by the RELAY from an id that matched a strict pattern,
 * so nothing a document wrote reaches these strings — see `extractMedia` in
 * `web/server/jarvis-files.mjs`. That matters because the document is untrusted
 * code: if its own text were passed through, a body could put a `javascript:`
 * URL in `embed` and the panel would hand it to an iframe.
 */
export interface MediaRef {
  provider: string;
  /** Human-facing provider name, e.g. `YouTube`. */
  label: string;
  id: string;
  /** Poster frame. */
  thumb: string;
  /** What an `<iframe>` in this app's OWN DOM points at. */
  embed: string;
  /** Where to send a reader who wants the provider's page. */
  watch: string;
}

export interface MediaResult {
  ok: boolean;
  media: MediaRef[];
  error?: string;
}

/**
 * The videos in a document, or an empty list.
 *
 * WHY THIS IS A REQUEST AND NOT SOMETHING READ FROM THE FRAME
 *   The document's own `<iframe>` embeds cannot work, and that is not a bug to
 *   be fixed where they sit. The relay serves a body under
 *   `Content-Security-Policy: sandbox allow-scripts`, which has no `frame-src`
 *   (so a nested YouTube frame falls back to `default-src 'none'` and is
 *   refused) and, deliberately, no `allow-same-origin` (so the nested document
 *   gets an opaque origin, and YouTube's player needs a real one). Both were
 *   measured live. Granting `allow-same-origin` would make agent-authored HTML
 *   same-origin with this app — the exact thing the sandbox exists to prevent —
 *   so instead the videos are played out here, in this app's own DOM, where a
 *   plain cross-origin iframe is unremarkable.
 *
 * A document with no videos answers `{ ok: true, media: [] }`, which is not an
 * error: most documents have none, and the panel renders nothing extra.
 */
export function fetchFileMedia(id: string): Promise<MediaResult> {
  return getJson<MediaResult>(`/api/files/${encodeURIComponent(id)}/media`);
}

/** Reduce a stored document to the small ref the glasses list keeps. */
export function toFileRef(doc: StoredDoc): FileRef {
  return {
    id: doc.id,
    title: doc.title || 'Untitled',
    agent: doc.agent || '',
    url: doc.url || '',
    size: Number(doc.size) || 0,
    updatedAt: Number(doc.updatedAt) || Date.now(),
  };
}
