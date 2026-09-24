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
// So this module is a thin, typed wrapper over `/api/files/*`. It holds NO
// document bodies: the list carries references, and the body is fetched by the
// browser straight into a frame (see `fileBodyUrl`), never through JS state.
import { getStreamToken } from '../auth-token';
import { API_BASE } from '../stream';
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

export interface FilesStatus {
  ok: boolean;
  /** True when the relay holds a credential. Not a probe: never means "up". */
  configured?: boolean;
  mode?: 'api_key' | 'password' | string;
  url?: string;
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
  method: 'POST' | 'DELETE',
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
 * `includeDeleted` is what a restore list is built from. Without it the relay's
 * list carries only live documents, so a soft-deleted one is unreachable from
 * this app entirely — not in the list, a 404 to a direct read — even though its
 * bytes are still on the gateway.
 */
export async function listFiles(opts: {
  limit?: number;
  offset?: number;
  q?: string;
  agent?: string;
  tag?: string;
  includeDeleted?: boolean;
} = {}): Promise<ListResult> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.offset) q.set('offset', String(opts.offset));
  if (opts.q) q.set('q', opts.q);
  if (opts.agent) q.set('agent', opts.agent);
  if (opts.tag) q.set('tag', opts.tag);
  if (opts.includeDeleted) q.set('include_deleted', 'true');
  const suffix = q.toString() ? `?${q}` : '';
  const res = await getJson<ListResult>(`/api/files${suffix}`);
  return {
    ok: res.ok === true,
    items: Array.isArray(res.items) ? res.items : [],
    total: Number(res.total) || 0,
    hasMore: Boolean(res.hasMore),
    error: res.error,
  };
}

/** One document's metadata. Never the body — that is what the frame is for. */
export function readFile(id: string): Promise<ReadResult> {
  return getJson<ReadResult>(`/api/files/${encodeURIComponent(id)}`);
}

/** Publish (or, with `overwrite`, replace) a document. */
export function publishFile(input: PublishInput): Promise<ReadResult> {
  return sendJson<ReadResult>('POST', '/api/files', { agent: SELF_AGENT, ...input });
}

/**
 * Delete a document. SOFT by default — the gateway keeps the bytes, and the
 * Files page lists it under "Deleted" with a Restore button, so the deletion is
 * genuinely reversible. Pass `hard: true` to purge the stored bytes, which is
 * the only version of this that cannot be undone.
 *
 * The response is the FLAT relay payload `{ ok, id, hard, deleted }`: `deleted`
 * answers "is it gone from the live list?", not "did the request work?" (that is
 * `ok`).
 */
export function deleteFile(id: string, hard = false): Promise<DeleteResult> {
  const suffix = hard ? '?hard=true' : '';
  return sendJson<DeleteResult>('DELETE', `/api/files/${encodeURIComponent(id)}${suffix}`);
}

/**
 * Undo a SOFT delete.
 *
 * The relay reaches the gateway's REST surface for this one, because the gateway
 * exposes no MCP restore tool. Restoring a document that is still live is
 * harmless upstream, so this can be called without knowing the current state.
 */
export function restoreFile(id: string): Promise<RestoreResult> {
  return sendJson<RestoreResult>('POST', `/api/files/${encodeURIComponent(id)}/restore`);
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
 */
export function fileBodyUrl(id: string): string {
  const token = getStreamToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${API_BASE}/api/files/${encodeURIComponent(id)}/html${q}`;
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
