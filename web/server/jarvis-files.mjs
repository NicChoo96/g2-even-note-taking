// Jarvis Content Gateway — the ONE place that speaks to the HTML store.
//
// WHY THIS MODULE EXISTS
//   Agents and Jarvis need to publish HTML SOMEWHERE and then have it shown
//   back to the wearer. That "somewhere" is an external service (the Jarvis
//   Content Gateway), and three things must be true or the feature is unsafe:
//
//     1. the credentials never reach a browser, a WebView or the glasses,
//     2. stored documents are UNTRUSTED CODE and must never be framed, or
//        executed, with our origin's authority, and
//     3. a rotating refresh token must not be replayed — doing so revokes the
//        whole session family, so exactly ONE renewal may be in flight.
//
//   All three are decided here, in a module with NO server-boot side effects, so
//   the whole client can be driven against a stubbed fetch and asserted
//   precisely. (Same reason web-search.mjs and wire.mjs were extracted:
//   local-sse.mjs starts an HTTP server on import.)
//
// TRANSPORT: MCP over HTTP, not REST
//   The gateway exposes the same eleven operations over REST and over JSON-RPC
//   MCP (`POST /mcp`), and its own docs say "this is an interface choice, not a
//   capability one". MCP wins here for one concrete reason: EVERY operation then
//   has ONE call shape and ONE failure model. The REST surface would need a
//   per-endpoint request builder, a per-endpoint error reader and a per-endpoint
//   response mapper — three places to get the nested `error` envelope wrong.
//   Over MCP there is a single `tools/call`, and the two failure LEVELS are
//   cleanly separated:
//
//     • the call succeeded, the operation did not  ->  HTTP 200,
//       `result.isError === true`, `result.structuredContent.error` is the
//       `{ code, message, detail }` object the REST API would have returned.
//     • the request never reached a tool (bad JSON, unknown tool, missing
//       scope) -> a JSON-RPC `error` object and NO `result`.
//
//   `isError` is checked on every call; the HTTP status is NOT the outcome.
//
// THE TOKEN MODEL, AND THE ONE THING THAT WILL BITE
//   Password login (`POST /auth/login`) returns a short-lived access token plus
//   an OPAQUE refresh token that is **single-use and rotates on every renewal**.
//   Replaying a consumed refresh token is answered with `refresh_token_reuse`
//   401 AND REVOKES THE ENTIRE SESSION FAMILY — so:
//
//     • the rotated pair is adopted ATOMICALLY, before anything else can read it,
//     • renewals are single-flight (one shared promise), and
//     • a renewal is proactive (before expiry, by RENEW_SKEW_MS), so the common
//       path never spends a request discovering it is stale.
//
//   An API KEY (`jvk_…`) short-circuits all of it: no login, no refresh, no
//   rotation, nothing to replay. Prefer one for a server-side caller; the
//   username/password pair is supported because that is what the env carries.
//
// VERIFIED LIVE against the gateway (not taken from its docs, which are wrong
// on two points): the login response has `expires_in`/`expires_at`, NOT
// `access_token_ttl`; and an MCP record's `html_url` is RELATIVE and must be
// prefixed with the base URL.

export const DEFAULT_BASE_URL = 'http://167.172.77.136';

export const LOGIN_PATH = '/auth/login';
export const REFRESH_PATH = '/auth/refresh';
export const MCP_PATH = '/mcp';

/** The gateway's own hard limit on a stored document (it answers 422 above it). */
export const MAX_HTML_BYTES = 4 * 1024 * 1024;
/** Our own ceiling for a tool result, so one list cannot spend the byte budget. */
export const RESULT_CHARS = 4000;
/**
 * The MOST document TEXT one read hands a model, in characters.
 *
 * A read returns the WHOLE body by default — see `windowSize`, where "no limit"
 * means "all of it", so a caller that names no size is asking to read the page
 * rather than to be shown a sample of it. A page has to come back whole for the
 * reader to quote it or to CHANGE it, which is what this ceiling exists to bound
 * and not to prevent. A document longer than it is still readable in full across
 * a few calls, each carrying the offset that continues it.
 *
 * WHY 60 000 AND NOT MORE — MEASURED, NOT CHOSEN
 *   The in-app agent clips a tool result at 120 000 characters
 *   (MAX_RESULT_CHARS, src/ai/agent.ts), and clips it by shortening the longest
 *   STRING LEAF — which is this text — appending "…(clipped)". An over-long
 *   read would therefore lose the truncation marker that says how to continue
 *   and leave the model holding a cut page it cannot finish. JSON escaping
 *   decides the real ceiling, measured on three bodies: prose 1.00x,
 *   blank-line-heavy 1.35x, and a body that is nothing but quotes 2.01x. At
 *   60 000 characters even that worst case serialises to 110 335 — inside the
 *   budget with room for the envelope around it — while 80 000 serialises to
 *   130 335 and IS clipped.
 */
export const BODY_MAX_CHARS = 60_000;
/** Renew this long before the access token actually expires. */
export const RENEW_SKEW_MS = 120_000;
/** A gateway call should not outlive this, whatever the run's own signal says. */
export const TIMEOUT_MS = 30_000;

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 200;
/** Stop paging after this many pages even if the gateway keeps saying has_more. */
export const LIST_MAX_PAGES = 10;

/** Tool plumbing — the kind the relay dispatches on and the model-facing name. */
export const FILES_KIND = 'files';
export const FILES_TOOL_ID = 'tool-files';
export const FILES_TOOL_NAME = 'jarvis_files';
/** The authoring agent recorded on a document when the model does not say. */
export const DEFAULT_AGENT = 'g2-hub';

/**
 * Is this a Jarvis-files tool? Mirrors `isWebTool` in web-search.mjs so the
 * relay's dispatching stays one line per kind.
 */
export function isFilesTool(t) {
  return Boolean(t) && t.kind === FILES_KIND;
}

/**
 * Strip a trailing slash so `${base}${path}` never produces a double slash.
 * Also refuses anything that is not http(s): a typo'd scheme would otherwise
 * fail deep inside fetch with an error that names neither the setting nor us.
 */
export function normalizeBaseUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : '';
}

/**
 * The credentials the client should use, resolved ONE FIELD AT A TIME.
 *
 * Same rule as llmConfig() in the relay: a value the owner saved on the Settings
 * page wins over the environment, so a host can supply keys with no page visit
 * while a field the page HAS set is the one that runs. An API key, when present,
 * beats the username/password pair outright — it has no session to expire.
 */
export function filesConfig(env = {}, saved = {}) {
  const pick = (slot, name) => String(saved?.[slot] || env?.[name] || '').trim();
  const url = normalizeBaseUrl(
    saved?.filesUrl || env?.JARVIS_FILE_URL || env?.JARVIS_URL || DEFAULT_BASE_URL,
  );
  const apiKey = pick('filesKey', 'JARVIS_FILE_API_KEY') || pick('filesKey', 'JARVIS_API_KEY');
  const username = pick('filesUser', 'JARVIS_FILE_USER') || pick('filesUser', 'JARVIS_USERNAME');
  const password = pick('filesPwd', 'JARVIS_FILE_PWD') || pick('filesPwd', 'JARVIS_PASSWORD');
  const source = {
    url: saved?.filesUrl ? 'settings' : env?.JARVIS_FILE_URL || env?.JARVIS_URL ? 'env' : 'default',
    key: saved?.filesKey ? 'settings' : env?.JARVIS_FILE_API_KEY || env?.JARVIS_API_KEY ? 'env' : 'none',
    user: saved?.filesUser ? 'settings' : env?.JARVIS_FILE_USER || env?.JARVIS_USERNAME ? 'env' : 'none',
    password: saved?.filesPwd ? 'settings' : env?.JARVIS_FILE_PWD || env?.JARVIS_PASSWORD ? 'env' : 'none',
  };
  return {
    url,
    apiKey,
    username,
    password,
    source,
    /** True when we can actually authenticate at all. */
    configured: Boolean(apiKey || (username && password)),
    /** The string a setup hint should name when nothing is configured. */
    hintVar: 'JARVIS_FILE_USER / JARVIS_FILE_PWD (or JARVIS_FILE_API_KEY)',
  };
}

/**
 * One error type for every failure, so callers read `code` and not a string.
 *
 * TWO statuses, deliberately, because conflating them was a real bug:
 *
 *   `transportStatus` is what the gateway's HTTP response actually was. It is the
 *   honest fact, and it stays here because the gateway sends `200 OK` for a
 *   JSON-RPC error — including "no such document".
 *
 *   `status` is what THIS relay should answer with. Only this one reaches the
 *   app: the relay maps it straight onto the response code. So it defaults to
 *   the transport status, and is raised to 404 only where a 200 would be a lie
 *   the app acts on (a document that is missing, or soft-deleted, is not a
 *   "502 bad gateway" — nothing is broken, the document is gone).
 */
export class FilesError extends Error {
  constructor(code, message, { status = 0, transportStatus = status, detail = null } = {}) {
    super(message || code);
    this.name = 'FilesError';
    this.code = code || 'error';
    this.status = status;
    this.transportStatus = transportStatus;
    this.detail = detail;
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────
// The ONE compact reference this app ever stores. There is deliberately NO
// `html` field: the body lives on the gateway and is streamed on demand, so a
// document can never be persisted into HubState, localStorage or an SSE frame.

/**
 * A stored document, reduced to what a list needs.
 *
 * `url` is ABSOLUTE. The gateway hands back a root-relative `html_url`, which is
 * useless to a browser on a different origin — and the browser must never call
 * the gateway directly anyway (its CORS list is empty), so in practice this is
 * the path the relay proxies. It is kept absolute so a link is self-describing
 * in a transcript or a log.
 */
export function compactDoc(record, baseUrl = '') {
  if (!record || typeof record !== 'object') return null;
  const id = String(record.id ?? '');
  if (!id) return null;
  const rel = String(record.html_url || `/sessions/${id}/html`);
  const base = normalizeBaseUrl(baseUrl);
  return {
    id,
    title: String(record.title ?? '').trim() || 'Untitled',
    agent: String(record.agent ?? ''),
    slug: String(record.slug ?? ''),
    tags: Array.isArray(record.tags) ? record.tags.map((t) => String(t)).slice(0, 12) : [],
    version: Number(record.version) || 0,
    size: Number(record.size) || 0,
    updatedAt: Date.parse(String(record.updated_at ?? '')) || Date.now(),
    /**
     * The document's CANONICAL address at the gateway.
     *
     * Stored and echoed as a reference — the same way a doc row keeps its name —
     * so a transcript, a log line or a stored ref can always be traced back to
     * the one document it names.
     *
     * It is deliberately NOT what a browser fetches. The gateway's CORS list is
     * empty and it sends `X-Frame-Options: SAMEORIGIN`, so neither `fetch` nor an
     * `<iframe src>` can use this URL from the app's origin. The only address a
     * client may load is the relay's own proxy path, `/api/files/{id}/html`.
     */
    url: base && rel.startsWith('/') ? `${base}${rel}` : rel,
    deleted: Boolean(record.deleted),
    /**
     * When and why the document was soft-deleted, or null when it is live.
     *
     * This is what makes a restore list INFORMATIVE rather than a bare list of
     * greyed-out titles: `deletedAt` lets the page say WHEN, and
     * `deletedReason` says WHAT removed it (the gateway records `deleted by mcp
     * client` for a tool-driven delete), which is the difference between "a row I
     * can undo" and "a row whose origin I can actually judge".
     */
    deletedAt: record.deleted ? Date.parse(String(record.deleted_at ?? '')) || null : null,
    deletedReason: record.deleted ? String(record.deleted_reason ?? '') : '',
  };
}

/** Page envelope -> compact refs. */
export function compactList(page, baseUrl = '') {
  const items = Array.isArray(page?.items) ? page.items : [];
  return {
    items: items.map((r) => compactDoc(r, baseUrl)).filter(Boolean),
    total: Number(page?.total ?? page?.count ?? items.length) || 0,
    hasMore: Boolean(page?.has_more),
    nextOffset: page?.next_offset == null ? null : Number(page.next_offset),
  };
}

/**
 * One revision row -> the compact shape both the relay and the app read.
 *
 * `revision` and `version` are DIFFERENT numbers and conflating them is the easy
 * mistake here: the revision number is a position in the history log (it never
 * repeats), while the version is the document version that row produced. A
 * restore moves the document to a new version but appends a row, so history
 * grows monotonically while versions jump.
 *
 * Returns null for a row with no usable revision number rather than inventing
 * one, so a caller can tell "this was not a revision" from "revision 0".
 */
export function compactRevision(record) {
  if (!record || typeof record !== 'object') return null;
  const revision = Number(record.revision);
  if (!Number.isFinite(revision)) return null;
  return {
    id: String(record.session_id ?? record.id ?? ''),
    revision,
    /** The DOCUMENT version this revision produced — not the revision number. */
    version: Number(record.version) || 0,
    /** create | update | replace | delete | restore | purge | revert */
    change: String(record.change ?? ''),
    title: String(record.title ?? ''),
    agent: String(record.agent ?? ''),
    size: Number(record.size) || 0,
    contentType: String(record.content_type ?? ''),
    /** False for a row that only moved metadata, so a listing can mark it. */
    contentChanged: Boolean(record.content_changed),
    /** When the change was made (ms), or null when the gateway did not say. */
    createdAt: Date.parse(String(record.created_at ?? '')) || null,
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
  };
}

/**
 * The revision page envelope. Like compactList, but the gateway wraps a
 * single-document query in `{ session_id, document, items }` and an ARCHIVE-wide
 * one in `{ items }` — this normalises both to the items, so the caller does not
 * have to know which shape it asked for.
 */
export function compactRevisions(page) {
  const items = Array.isArray(page?.items) ? page.items : [];
  return {
    items: items.map(compactRevision).filter(Boolean),
    total: Number(page?.total ?? page?.count ?? items.length) || 0,
    hasMore: Boolean(page?.has_more),
    nextOffset: page?.next_offset == null ? null : Number(page.next_offset),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const bytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} kB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
};

const clip = (s, n = RESULT_CHARS) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The gateway's change verbs as past-tense prose, for a human-readable log. */
const CHANGE_LABEL = {
  create: 'created',
  replace: 'replaced',
  update: 'updated',
  delete: 'deleted',
  restore: 'undeleted',
  purge: 'purged',
  revert: 'reverted',
};

const dayOf = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'unknown date');

/**
 * The text a MODEL reads back.
 *
 * The invariant both transports must not break: a result is ALWAYS plain text
 * and NEVER markup. A 4 MiB HTML page inside a tool message would blow the run's
 * byte budget and tells the model nothing it can act on — from a metadata call it
 * needs the ID and the title, and the wearer gets the pixels.
 *
 * THE ONE EXCEPTION, AND ITS BOUNDS. `read_session` and `read_revision` with
 * `include_html` DO put a body in a tool message, through renderToolBody — as
 * TEXT (htmlToText), WHOLE unless the page is longer than BODY_MAX_CHARS.
 * That is the whole point of this pair of functions: "read that report and tell
 * me what it says" was unanswerable while every read stopped at the metadata,
 * and a model asked to CHANGE a page needs its entire body rather than a sample
 * of it. What stays true is the part that matters, and it is asserted: no HTML,
 * and never more than one ceiling's worth of text.
 */
export function renderToolResult(action, data) {
  const run = String(action || '');

  // The change log. Checked BEFORE the items branch below, because a revision
  // page carries `items` too and would otherwise be reported to the model as a
  // list of documents — the same field name, a different thing entirely.
  if (run === 'list_revisions' && data && Array.isArray(data.items)) {
    const { items, total, hasMore } = data;
    if (!items.length) return 'No changes recorded yet.';
    const lines = items.map(
      (r, i) =>
        `${i + 1}. ${CHANGE_LABEL[r.change] || r.change || 'changed'} v${r.version} ` +
        `(revision ${r.revision}) "${r.title || 'untitled'}" [${r.agent || 'unknown'}] ` +
        `${dayOf(r.createdAt)} · ${r.id}`,
    );
    return clip(
      `Change history, newest first (${items.length} of ${total}${hasMore ? ', more available' : ''}):\n`
        + lines.join('\n'),
    );
  }

  if (data && Array.isArray(data.items)) {
    const { items, total, hasMore } = data;
    // A search answers with the same envelope as a list, so the heading is the
    // only thing telling the model it asked a narrower question.
    const heading = run === 'search_sessions' ? 'Matching documents' : 'Stored documents';
    if (!items.length) {
      return run === 'search_sessions' ? 'No document matches that search.' : 'No documents stored yet.';
    }
    const lines = items.map(
      (d, i) =>
        `${i + 1}. ${d.title} [${d.agent || 'unknown'}] ${bytes(d.size)} · ${d.id}` +
        (d.tags.length ? ` #${d.tags.join(' #')}` : ''),
    );
    return clip(
      `${heading} (${items.length} of ${total}${hasMore ? ', more available' : ''}):\n` + lines.join('\n'),
    );
  }

  // One history entry read on its own.
  if (run === 'read_revision' && data && Number.isFinite(Number(data.revision))) {
    const r = data;
    return clip(
      `Revision ${r.revision} of ${r.id} — ${CHANGE_LABEL[r.change] || r.change || 'changed'} on `
        + `${dayOf(r.createdAt)}${r.contentChanged ? '' : ', metadata only'}. `
        + `It produced version ${r.version}. Revert to it with action "revert".`,
    );
  }

  // Library totals. These answer with no document of their own, so without a
  // branch here they would fall through to the bare "done." line and tell the
  // model nothing about the question it just asked.
  if (run === 'session_stats' && data && Number.isFinite(Number(data.sessions))) {
    const bits = [
      `${Number(data.live_sessions) || 0} live documents`,
      `${Number(data.deleted_sessions) || 0} soft-deleted`,
      `${bytes(data.storage_bytes)} stored`,
      `${Number(data.agents) || 0} authors`,
      `${Number(data.tags) || 0} tags`,
    ];
    return clip(
      `Library: ${bits.join(', ')}. `
        + 'Soft-deleted documents are still recoverable from the Files page.',
    );
  }
  if (run === 'revision_stats' && data && Number.isFinite(Number(data.revisions))) {
    return clip(
      `History: ${Number(data.revisions) || 0} revisions, `
        + `${Number(data.content_changes) || 0} of them content changes, `
        + `${bytes(data.revision_bytes)} of stored snapshots.`,
    );
  }

  const d = data && data.id ? data : null;
  if (!d) return clip(`jarvis_files ${run}: done.`);
  const head = `${d.title} [${d.agent || 'unknown'}] ${bytes(d.size)} · v${d.version}`;
  if (run === 'create_session') {
    return clip(
      `Published ${d.id} — "${d.title}" (${bytes(d.size)}). ` +
        'It is listed on the Files page; the wearer reads the body there.',
    );
  }
  if (run === 'delete_session') {
    // The words a MODEL reads back, so they must describe what actually
    // happened. A soft delete really is recoverable — the wearer restores it
    // from the Files page — and a hard delete really is not, so neither branch
    // may promise something the other one does.
    return d.hard
      ? `Permanently deleted ${d.id} — the stored bytes are gone and it cannot be restored.`
      : `Deleted ${d.id}. It is recoverable: the wearer can restore it from the Files page.`;
  }
  if (run === 'update_session') {
    return clip(`Updated ${d.id} — ${head}.`);
  }
  if (run === 'restore_revision') {
    // Measured live: a revert appends a row rather than rewriting history, so
    // saying so is accurate and it is the fact the model needs to reassure the
    // wearer with.
    return clip(
      `Reverted ${d.id} — ${head}. Nothing was discarded: every version is still in the `
        + 'history and the one just replaced can be reverted to in the same way.',
    );
  }
  return clip(head);
}

/**
 * A document body rendered for a MODEL: the TEXT of the page, whole, and the
 * offset to continue from only when it did not all fit.
 *
 * The only place a body is allowed into a tool message, and the shape is the one
 * docs.read already proved with a local document: the reader gets the words, the
 * exact character range it was given, and — when there is more — a marker naming
 * the offset to ask for next. A model that reads to the end of such a document
 * sees a read with NO marker, which is how it knows it has the whole thing.
 *
 * WHOLE BY DEFAULT, BECAUSE READING IS NOT SAMPLING. A caller that names no size
 * is asking to read the page — summarise it, quote it, or rewrite it — and a
 * page it cannot see the end of is a page it cannot edit. So the only things
 * that produce a marker are a document genuinely longer than BODY_MAX_CHARS and
 * a caller that asked for a narrower window on purpose.
 *
 * The two cases that would otherwise look like an answer are named in words
 * instead of being returned as an empty body: a document whose text is empty
 * (markup only), and an offset past the end. Both are the difference between "the
 * page is blank" and "you asked for the wrong slice", and only one of those is
 * true.
 */
export function renderToolBody(data, { offset = 0, limit } = {}) {
  const d = data && data.id ? data : null;
  if (!d) return clip('jarvis_files read: done.');
  const head = `${d.title} [${d.agent || 'unknown'}] ${bytes(d.size)} · v${d.version}`;
  // Defensive: a caller that forgets to fetch the body must be told so, rather
  // than be handed "no readable text", which is a different and wrong claim.
  if (d.html === undefined || d.html === null) {
    return clip(`${head} (the body was not fetched — read it again with include_html true).`);
  }
  const w = bodyWindow(htmlToText(d.html), { offset, limit });
  if (!w.total) {
    return `${head}\n(no readable text: this document is markup only — a chart, an image or a script.)`;
  }
  if (!w.text) {
    return `${head}\n(offset ${w.offset} is past the end: the readable text is ${w.total} characters.)`;
  }
  const more = w.more
    ? `\n…(truncated at ${w.next} of ${w.total} chars — read again with the same id and offset ${w.next})`
    : '';
  return `${head}\n${w.text}${more}`;
}

/**
 * The headers the relay MUST send when it proxies a stored document's body.
 *
 * WHY THIS IS A CONSTANT AND NOT AN INLINE STRING
 *   Everything the gateway stores is code written by a model, and the relay
 *   serves it from OUR origin. `sandbox` with NO `allow-same-origin` is what
 *   stops that code from being same-origin with the app: the document gets an
 *   opaque origin, so it cannot read the SPA's DOM, its localStorage, or its
 *   session token, and `connect-src 'none'` stops it calling our API or
 *   exfiltrating what it can see. `allow-scripts` is kept because a generated
 *   report may chart with inline script — losing it makes most of them inert.
 *
 *   The gateway's own response already carries this policy, but the relay is
 *   NOT the gateway: it re-serialises a body it fetched itself, so it has to
 *   restate the terms or it would be serving untrusted HTML bare.
 */
export const SANDBOX_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function htmlResponseHeaders() {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': SANDBOX_CSP,
    // Belt and braces with the CSP above: only OUR origin may frame it, so the
    // relay cannot become a clickjacking surface for a third-party site.
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  };
}

const HTML_RE = /<!doctype\s+html|<html[\s>]|<body[\s>]|<(?:div|p|h[1-6]|table|ul|ol|section|article|svg|canvas|script|style)\b/i;

/**
 * Does this text look like a document the gateway will accept?
 *
 * The gateway enforces this itself (a plain "hello" is a 422 `validation_error`),
 * so this exists only to fail EARLY with a sentence the model can act on — and
 * to steer it to `content_type: 'text/plain'` when it really did mean prose.
 */
export function isHtmlish(text) {
  return HTML_RE.test(String(text ?? ''));
}

// ── A document body, as TEXT ─────────────────────────────────────────────────
//
// WHY STRIPPING TAGS IS NOT ENOUGH
//   A body is the one input in this module that is both fully untrusted and
//   large (up to MAX_HTML_BYTES). So:
//
//     • the parts that exist to be EXECUTED go first — <script>, <style>,
//       <noscript>, <template>, <svg>, <canvas> and comment blocks. A stylesheet
//       is not prose, and 40 kB of inline CSS would spend the whole window while
//       telling the model nothing about the page;
//     • block-level tags become a NEWLINE, never nothing. `<p>a</p><p>b</p>` must
//       read as two paragraphs, and `<td>x</td><td>y</td>` must not weld into
//       "xy" — a table silently run together as one word is worse than no table;
//     • every other tag is deleted outright, so `<b>bold</b>` reads as `bold`.
//
//   Entities are decoded AFTER the tags are gone, so `&lt;script&gt;` written in
//   the text stays text and can never be resurrected as markup on the way
//   through. Decoding first is the version of this function that has a hole in
//   it, and it is the obvious way to write it.
//
// WHAT IT DELIBERATELY LOSES
//   Images, video, charts, layout and emphasis. A model reading this gets the
//   WORDS of a document, not the document. Nothing about the frame the wearer
//   reads is changed by any of it: this is a second, narrower view of the same
//   bytes.

/** Blocks removed with their contents, because nothing inside is prose. */
const NON_TEXT_BLOCKS = /<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENTS = /<!--[\s\S]*?-->/g;
/**
 * Tags that separate text, replaced by a newline rather than dropped.
 *
 * `code` is deliberately NOT here: it is inline most of the time, and treating
 * it as a block would break a sentence across two lines mid-clause.
 */
const BLOCK_TAGS =
  /<\/?(?:p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot|th|td|blockquote|pre|figure|figcaption|form|fieldset|hr|br|address|details|summary)\b[^>]*>/gi;
const ANY_TAG = /<[^>]*>/g;
/**
 * `&#39;`, `&#x27;` and `&amp;` — bounded, so a stray ampersand in prose is left
 * alone instead of swallowing the rest of the sentence as a "reference".
 */
const ENTITY_REF = /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi;
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  dagger: '†',
  deg: '°',
  times: '×',
  divide: '÷',
  frac12: '½',
  sup2: '²',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  copy: '©',
  reg: '®',
  trade: '™',
  prime: '′',
  check: '✓',
  cross: '✗',
  larr: '←',
  rarr: '→',
};

/**
 * One entity, decoded — or left VERBATIM when it is not one.
 *
 * `&unknown;` in a document is text the author typed, so returning it unchanged
 * is the only answer that cannot lose something the wearer wrote. Numeric
 * references are range-checked for the same reason, plus one more: a lone
 * surrogate or a C0 control character decodes into a string that is invalid or
 * hostile in a tool message, so both are replaced by a space instead.
 */
const decodeEntity = (whole, body) => {
  const named = NAMED_ENTITIES[body.toLowerCase()];
  if (named !== undefined) return named;
  if (body[0] !== '#') return whole;
  const hex = body[1] === 'x' || body[1] === 'X';
  const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
  if (code < 0x20 && code !== 0x09 && code !== 0x0a) return ' ';
  if ((code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) return ' ';
  return String.fromCodePoint(code);
};

/**
 * A stored document's body as plain text, for a model to read.
 *
 * Pure and total: any input, including '' and undefined, comes back as a string,
 * so no caller has to guard it. The HTML is never echoed — see the header above
 * for what is dropped and why.
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(NON_TEXT_BLOCKS, '\n')
    .replace(HTML_COMMENTS, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(ANY_TAG, '')
    .replace(/\r\n?/g, '\n')
    .replace(ENTITY_REF, decodeEntity)
    // Whitespace LAST, so markup that became newlines and entities that became
    // spaces are normalised together: runs of blanks collapse, a line never
    // keeps trailing space, and no paragraph is separated by more than one
    // empty line (which is the most a tool message should spend on air).
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * How many characters a window may hold: 1 … BODY_MAX_CHARS.
 *
 * NO LIMIT MEANS ALL OF IT, and that is the point of this default. A caller that
 * does not name a size is asking to read the document, not to be shown a sample
 * of it, so "no size given" resolves to the ceiling rather than to something
 * smaller. Every UNUSABLE value — `undefined`, `null`, `''`, 0, a negative,
 * `NaN`, a word, an object — lands on that same answer, because a caller that
 * asked badly did not ask for less.
 */
const windowSize = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return BODY_MAX_CHARS;
  return Math.min(Math.floor(n), BODY_MAX_CHARS);
};

/**
 * One window of document TEXT, plus where the next one starts.
 *
 * WITH NO `limit` THE WINDOW IS THE WHOLE TEXT, up to BODY_MAX_CHARS. So the
 * ordinary read — the one that mentions no size — comes back complete and
 * reports `more: false`; windowing is for the documents too long for one tool
 * message, not the default way to read a page.
 *
 * The offset is clamped the same way docs.read clamps it, and for the same two
 * measured reasons: `slice(-1)` is one character from the END of the string (so
 * a negative offset would report a document as its own last character), and any
 * offset at or past the end slices to '' — which reads to a model as "the page is
 * blank", the one wrong answer that is indistinguishable from a successful read.
 * The empty case is therefore REPORTED by renderToolBody rather than passed on as
 * a body it must interpret.
 */
export function bodyWindow(text, { offset = 0, limit } = {}) {
  const whole = String(text ?? '');
  const total = whole.length;
  const n = Number(offset);
  const from = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), total) : 0;
  const to = Math.min(total, from + windowSize(limit));
  return {
    text: whole.slice(from, to),
    offset: from,
    total,
    next: to < total ? to : null,
    more: to < total,
  };
}

// ── Videos inside a document ─────────────────────────────────────────────────
//
// WHY THIS EXISTS AT ALL, GIVEN A DOCUMENT IS ALREADY SHOWN IN A FRAME
//   A model-published document can embed videos — a watch-later list is exactly
//   that. Those embeds CANNOT work in the frame the relay serves them in:
//
//     • the frame's policy carries no `frame-src`, so a nested
//       `<iframe src="https://www.youtube.com/embed/…">` falls back to
//       `default-src 'none'` and is refused before it ever loads, and
//     • even with `frame-src` relaxed, `sandbox allow-scripts` (deliberately
//       with NO `allow-same-origin`) forces the nested document into an opaque
//       origin, and YouTube's player needs a real one — it reaches for cookies,
//       storage and postMessage.
//
//   BOTH ARE MEASURED, NOT ASSUMED. Four frames holding one video were rendered
//   side by side: with the sandbox as it stands the player is blank, and the
//   identical video in a frame carrying `allow-same-origin` plays. The URL was
//   never the problem — every configuration LOADED youtube.com; only the player
//   refused to draw, which is why this cannot be caught by checking the URL.
//
//   `allow-same-origin` is the one flag this app must not grant: it is precisely
//   what would let an agent-authored document be same-origin with the SPA, and
//   read its DOM, its storage and its session token. So the embed cannot be
//   repaired where it sits — but it does not need to be. The RELAY can read the
//   body (it already holds the credential), find the videos and hand the client
//   a small, validated list; the client then plays them in its OWN DOM, outside
//   the sandbox. That frame is a plain cross-origin iframe on YouTube's origin,
//   which is a privilege the DOCUMENT never gains — it never sees this list, and
//   its own frame is served under exactly the terms it was before.
//
// THE RULE THAT MAKES THIS SAFE: NO URL FROM THE BODY IS EVER PASSED THROUGH
//   The body is untrusted code written by a model. So nothing in it is echoed to
//   the client: every field below is REBUILT from an id that matched a strict
//   pattern. A document therefore cannot smuggle a `javascript:` URL, a
//   different host or a crafted query into the player, because no part of its
//   text survives — only eleven characters from a fixed alphabet.

/** How many videos one document may contribute, so a hostile body cannot flood the panel. */
export const MEDIA_MAX = 50;

/** YouTube ids are exactly this, always. Checked BEFORE any URL is built. */
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The id of the YouTube video a URL names, or ''.
 *
 * Accepts the shapes a model actually writes: `/embed/`, `/watch?v=`,
 * `/shorts/`, `/live/`, `/v/`, and the `youtu.be` short form, on
 * youtube.com, youtube-nocookie.com and their m/my/music subdomains.
 */
function youTubeId(u) {
  const host = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '').split('/')[0];
    return YT_ID.test(id) ? id : '';
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return '';
  const path = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(u.pathname);
  if (path) return path[1];
  if (/^\/(?:watch|embed)\/?$/.test(u.pathname)) {
    const v = u.searchParams.get('v') ?? '';
    return YT_ID.test(v) ? v : '';
  }
  return '';
}

/**
 * The providers this app can play, as a TABLE rather than a hardcoded branch.
 *
 * Adding Vimeo, or a bare `https://…/clip.mp4`, is a new entry here and nothing
 * else: extraction, the cap, de-duplication, the relay route, the panel and the
 * harness all work off `{ provider, id }` and never name YouTube.
 */
export const MEDIA_PROVIDERS = [
  {
    id: 'youtube',
    label: 'YouTube',
    parse: youTubeId,
    /** Always present — unlike maxresdefault, which 404s on older uploads. */
    thumb: (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    /** The no-cookie host: the same player, minus the tracking cookie until play. */
    embed: (id) => `https://www.youtube-nocookie.com/embed/${id}?rel=0`,
    watch: (id) => `https://www.youtube.com/watch?v=${id}`,
  },
];

/** Parse an absolute http(s) URL, or null. Refuses `javascript:`, `data:` and relatives. */
function absoluteUrl(raw) {
  const s = raw.startsWith('//') ? `https:${raw}` : raw;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * The videos a stored document points at, in document order, de-duplicated.
 *
 * Reads `src` and `href` attributes only — the two places a document names a
 * video — and refuses relative or non-http(s) values. The attribute pattern is
 * bounded and its character class excludes the quote, so it cannot backtrack on
 * a hostile body.
 */
export function extractMedia(html) {
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  // Built per call rather than shared: a module-level /g regex carries
  // `lastIndex` between calls, which is a bug waiting for the first nested
  // caller and a silent skip of the first match for the second.
  const attr = /(?:src|href)\s*=\s*(?:"([^"]{1,2048})"|'([^']{1,2048})')/gi;
  let m;
  while ((m = attr.exec(text)) !== null) {
    // A document may escape the separator — `?v=ab&amp;t=2` is what a model
    // writes when it hand-builds the tag — so undo entities before parsing, or
    // the id is read as `ab` and the video silently disappears.
    const raw = (m[1] ?? m[2])
      .replace(/&amp;/gi, '&')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .trim();
    const url = absoluteUrl(raw);
    if (!url) continue;
    for (const p of MEDIA_PROVIDERS) {
      const id = p.parse(url);
      if (!id) continue;
      const key = `${p.id}:${id}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        provider: p.id,
        label: p.label,
        id,
        thumb: p.thumb(id),
        embed: p.embed(id),
        watch: p.watch(id),
      });
      break;
    }
    if (out.length >= MEDIA_MAX) break;
  }
  return out;
}

// ── The client ───────────────────────────────────────────────────────────────

/**
 * One client, one session.
 *
 * Deliberately IN-MEMORY ONLY. The refresh token rotates on every renewal, so
 * persisting it to disk would mean two processes (a dev relay and a deployed
 * one, or a restart overlapping a live one) could hold the same token — and
 * replaying a consumed token revokes the ENTIRE session family, taking the
 * integration down until someone logs in again. Re-logging in on boot costs one
 * request and is bounded by the gateway's 20-logins-per-minute limit.
 */
export function createFilesClient(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const apiKey = String(opts.apiKey || '').trim();
  const username = String(opts.username || '').trim();
  const password = String(opts.password || '');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : TIMEOUT_MS;
  const now = opts.now || (() => Date.now());

  let accessToken = apiKey;
  let refreshToken = '';
  let expiresAt = 0; // ms epoch; 0 = unknown (API key, or not yet logged in)
  let subject = '';
  let scopes = [];
  /** The single in-flight renewal. Sharing it is what keeps one session alive. */
  let renewing = null;
  /** The single in-flight login — see `signIn`. */
  let signingIn = null;
  let idSeq = 1;

  const hasCreds = Boolean(apiKey || (username && password));

  async function request(path, { method = 'GET', body, token, signal, raw = false, headers: extraHeaders } = {}) {
    if (!baseUrl) throw new FilesError('bad_base_url', 'JARVIS_FILE_URL is not a valid http(s) URL');
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    // Caller-supplied headers, merged LAST so nothing here can be relied on to
    // be unforgeable. The hub needs two this client never sets on its own:
    //   Idempotency-Key — one UUID per user ACTION, replayed on retry so a
    //                     dropped response cannot double-apply a write.
    //   If-Match        — the agents/docs optimistic-concurrency guard; omitting
    //                     it is a 412 IF_MATCH_REQUIRED, not a silent overwrite.
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        // Skip empties rather than sending `Idempotency-Key: undefined`, which
        // the hub would reject as a malformed key instead of simply absent.
        if (v !== undefined && v !== null && v !== '') headers[k] = String(v);
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const r = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (raw) return { status: r.status, ok: r.ok, headers: r.headers, text };
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: r.status, ok: r.ok, headers: r.headers, body: parsed, text };
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new FilesError(signal?.aborted ? 'aborted' : 'timeout', `gateway did not answer within ${timeoutMs}ms`);
      }
      throw new FilesError('network', err?.message || 'network error');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** Read the nested REST error envelope, tolerating a non-JSON body. */
  function errorOf(payload, status, fallback) {
    const e = payload?.error && typeof payload.error === 'object' ? payload.error : null;
    const code = String(e?.code || fallback || `http_${status}`);
    const message = String(e?.message || payload?.message || code);
    return new FilesError(code, message, { status, detail: e?.detail ?? null });
  }

  /**
   * Adopt a token pair ATOMICALLY. The rotated refresh token is written here,
   * synchronously, in the same tick its response is parsed — there is no await
   * between reading the response and keeping it, so nothing can observe a half
   * updated session and no second request can race in with the old token.
   */
  function adopt(body) {
    if (!body || typeof body !== 'object') return;
    if (typeof body.access_token === 'string' && body.access_token) accessToken = body.access_token;
    if (typeof body.refresh_token === 'string' && body.refresh_token) refreshToken = body.refresh_token;
    if (typeof body.subject === 'string') subject = body.subject;
    if (Array.isArray(body.scopes)) scopes = body.scopes.map((s) => String(s));
    // The gateway sends `expires_in` + `expires_at` (NOT the `access_token_ttl`
    // its own docs name). Prefer the absolute instant, since it is immune to a
    // slow response; fall back to the relative one.
    const abs = Number(body.expires_at);
    if (Number.isFinite(abs) && abs > 0) expiresAt = abs > 1e12 ? abs : abs * 1000;
    else {
      const rel = Number(body.expires_in);
      expiresAt = Number.isFinite(rel) && rel > 0 ? now() + rel * 1000 : 0;
    }
  }

  function forget() {
    accessToken = apiKey;
    refreshToken = '';
    expiresAt = 0;
  }

  async function login(signal) {
    if (!hasCreds) {
      throw new FilesError('not_configured', 'set JARVIS_FILE_USER / JARVIS_FILE_PWD (or JARVIS_FILE_API_KEY)');
    }
    const r = await request(LOGIN_PATH, {
      method: 'POST',
      body: { username, password },
      signal,
    });
    if (!r.ok) throw errorOf(r.body, r.status, 'invalid_credentials');
    adopt(r.body);
    if (!accessToken) throw new FilesError('invalid_credentials', 'login returned no access token', { status: r.status });
    return accessToken;
  }

  /**
   * Log in ONCE, with every caller sharing the one attempt.
   *
   * `login()` on its own is not enough: two tool calls that arrive together on
   * a cold client would both see `accessToken` empty, both log in, and the
   * second response would overwrite the first pair — leaving an orphaned
   * refresh token whose next use is a `refresh_token_reuse` 401. Sharing the
   * promise means N cold callers cost exactly one login, which is also what
   * keeps us clear of the gateway's 20-logins-per-minute limit.
   */
  function signIn(signal) {
    if (signingIn) return signingIn;
    signingIn = login(signal).finally(() => {
      signingIn = null;
    });
    return signingIn;
  }

  /**
   * Renew, ONCE, with every caller sharing the one attempt.
   *
   * `refresh_token_reuse` is the trap this exists for: the gateway answers it
   * with a 401 AND revokes the family, so it must never be retried in a loop.
   * It is reported as its own code and the session is dropped, which makes the
   * next call take the re-login path instead of replaying a dead token.
   */
  function renew(signal) {
    if (renewing) return renewing;
    renewing = (async () => {
      if (apiKey || !refreshToken) return signIn(signal);
      const r = await request(REFRESH_PATH, {
        method: 'POST',
        body: { refresh_token: refreshToken },
        signal,
      });
      if (r.ok) {
        adopt(r.body);
        return accessToken;
      }
      // 401 with no body we recognise is a dead session, not a busy gateway.
      forget();
      if (r.status === 401) return signIn(signal);
      throw errorOf(r.body, r.status, 'refresh_failed');
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  }

  /** A token good enough to send right now, renewing proactively if close. */
  async function ensureToken(signal) {
    if (apiKey) return accessToken;
    if (!accessToken) return signIn(signal);
    if (expiresAt && now() >= expiresAt - RENEW_SKEW_MS) return renew(signal);
    return accessToken;
  }

  /**
   * One MCP call.
   *
   * Retries EXACTLY ONCE, and only when the failure is an authentication one
   * that a fresh token could plausibly fix: a transport 401, or the JSON-RPC
   * `-32001` "authentication required" the gateway returns when a `tools/call`
   * arrives with no usable credential. Everything else — `-32601` (no such
   * tool, which is a NAME problem and never a token one), `-32602` (bad params)
   * and `-32002` (a real scope denial) — is raised immediately, because
   * retrying consumes a refresh-token rotation and buys nothing.
   */
  async function call(name, args, { signal, retried = false } = {}) {
    const token = await ensureToken(signal);
    const r = await request(MCP_PATH, {
      method: 'POST',
      token,
      signal,
      body: {
        jsonrpc: '2.0',
        id: idSeq++,
        method: 'tools/call',
        params: { name, arguments: args || {} },
      },
    });
    const authFailure =
      r.status === 401 ||
      (r.ok && r.body?.error && Number(r.body.error.code) === -32001);
    if (authFailure && !retried && !apiKey) {
      forget();
      return call(name, args, { signal, retried: true });
    }
    if (!r.ok) throw errorOf(r.body, r.status, 'gateway_error');
    if (r.body?.error) {
      const code = Number(r.body.error.code);
      const detail = r.body.error.data ?? null;
      // -32601 is a marketing problem, not an auth one: the tool name is wrong.
      throw new FilesError(
        code === -32002 ? 'insufficient_scope' : code === -32601 ? 'unknown_tool' : `jsonrpc_${code}`,
        String(r.body.error.message || 'gateway rejected the request'),
        { status: r.status, detail },
      );
    }
    const result = r.body?.result;
    if (!result) throw new FilesError('empty_result', 'gateway returned no result', { status: r.status });
    if (result.isError) {
      const e = result.structuredContent?.error;
      const code = String(e?.code || 'tool_error');
      throw new FilesError(
        code,
        String(e?.message || result.content?.[0]?.text || 'the operation failed'),
        // See the FilesError doc comment: `transportStatus` keeps the truth (the
        // gateway answered 200) while `status` tells the relay what to send back.
        { status: code === 'not_found' ? 404 : r.status, transportStatus: r.status, detail: e?.detail ?? null },
      );
    }
    return result.structuredContent ?? {};
  }

  /**
   * The server's OWN tool catalogue — `tools/list`, signed in the same way.
   *
   * This exists because the model-facing schema was a hand-written COPY of the
   * server's, and copies drift with nothing to notice. Measured against the live
   * gateway, the copy in filesToolSchema() had already silently lost `hard` and
   * `reason` from delete_session — so the model could not hard-delete — and
   * `include_html` from read_session, so it could never read a body. Seven of the
   * server's eleven tools were not represented at all. Nothing in this file could
   * detect any of that, because nothing ever asked.
   *
   * Deliberately mirrors `call` rather than reusing it: `call` hard-codes the
   * `tools/call` method, and this must not become a SECOND auth path — so it
   * shares `ensureToken`, the one auth retry, and the same error mapping.
   *
   * Returns the raw `result.tools` array, unwrapped on purpose: normalising it is
   * mcp-tools.mjs's job, and doing it here would put a second interpretation of
   * the MCP envelope in the codebase.
   */
  async function catalogue({ signal, retried = false } = {}) {
    const token = await ensureToken(signal);
    const r = await request(MCP_PATH, {
      method: 'POST',
      token,
      signal,
      body: { jsonrpc: '2.0', id: idSeq++, method: 'tools/list', params: {} },
    });
    const authFailure =
      r.status === 401 ||
      (r.ok && r.body?.error && Number(r.body.error.code) === -32001);
    if (authFailure && !retried && !apiKey) {
      forget();
      return catalogue({ signal, retried: true });
    }
    if (!r.ok) throw errorOf(r.body, r.status, 'gateway_error');
    if (r.body?.error) {
      const code = Number(r.body.error.code);
      // -32601 here means the server does not implement discovery at all, which
      // is a different fact from `call`'s -32601 (a wrong tool name).
      throw new FilesError(
        code === -32002
          ? 'insufficient_scope'
          : code === -32601
            ? 'unsupported_method'
            : `jsonrpc_${code}`,
        String(r.body.error.message || 'gateway rejected tools/list'),
        { status: r.status, detail: r.body.error.data ?? null },
      );
    }
    const result = r.body?.result;
    if (!result) throw new FilesError('empty_result', 'tools/list returned no result', { status: r.status });
    return Array.isArray(result.tools) ? result.tools : [];
  }

  // ── Operations ─────────────────────────────────────────────────────────────

  /** List documents, newest first by default. One page — see `listAll`. */
  async function list({ limit = LIST_DEFAULT_LIMIT, offset = 0, agent, tag, q, order, includeDeleted, signal } = {}) {
    const args = { limit: Math.min(LIST_MAX_LIMIT, Math.max(1, Number(limit) || LIST_DEFAULT_LIMIT)), offset: Math.max(0, Number(offset) || 0) };
    if (agent) args.agent = String(agent);
    if (tag) args.tag = String(tag);
    if (q) args.q = String(q);
    if (order) args.order = String(order);
    if (includeDeleted) args.include_deleted = true;
    const page = await call('list_sessions', args, { signal });
    return { ...compactList(page, baseUrl), raw: page };
  }

  /**
   * Every page, up to a bound. `has_more`/`next_offset` is the documented cursor
   * loop; the page cap and a matching-offset guard stop a gateway that keeps
   * reporting `has_more` from spinning forever.
   */
  async function listAll(opts = {}) {
    const out = [];
    let offset = 0;
    let total = 0;
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const r = await list({ ...opts, offset });
      out.push(...r.items);
      total = r.total;
      if (!r.hasMore || r.nextOffset == null || r.nextOffset === offset) break;
      offset = r.nextOffset;
    }
    return { items: out, total: total || out.length, hasMore: false, nextOffset: null };
  }

  async function read(id, { includeHtml = false, signal } = {}) {
    const args = { id: String(id), include_html: Boolean(includeHtml) };
    const rec = await call('read_session', args, { signal });
    const doc = compactDoc(rec, baseUrl);
    if (!doc) throw new FilesError('not_found', 'document not found', { status: 404 });
    return includeHtml ? { ...doc, html: String(rec.html ?? '') } : doc;
  }

  /**
   * Publish a document.
   *
   * `id` + `overwrite` is the ONLY safe way to retry: an id makes the write
   * idempotent, and re-sending the same id without `overwrite` is answered with
   * a 409 `conflict` rather than a duplicate. `content_type` is set explicitly
   * when the caller is publishing prose, because the gateway validates that the
   * body "looks like HTML" and a plain sentence trips that check.
   */
  async function create({ html, title, agent = DEFAULT_AGENT, tags, id, overwrite, slug, contentType, signal }) {
    const body = String(html ?? '');
    if (!body.trim()) throw new FilesError('validation_error', 'html is required');
    if (Buffer.byteLength(body, 'utf8') > MAX_HTML_BYTES) {
      throw new FilesError('payload_too_large', `document exceeds ${bytes(MAX_HTML_BYTES)}`);
    }
    const args = { html: body, agent: String(agent || DEFAULT_AGENT) };
    if (title) args.title = String(title).slice(0, 300);
    if (Array.isArray(tags) && tags.length) args.tags = tags.map((t) => String(t)).slice(0, 12);
    if (id) args.id = String(id);
    if (overwrite) args.overwrite = true;
    if (slug) args.slug = String(slug).slice(0, 200);
    if (contentType) args.content_type = String(contentType);
    else if (!isHtmlish(body)) args.content_type = 'text/plain';
    const rec = await call('create_session', args, { signal });
    const doc = compactDoc(rec, baseUrl);
    if (!doc) throw new FilesError('empty_result', 'the gateway did not return the new document');
    return doc;
  }

  /** Soft-delete by default (restorable); `hard` purges the stored bytes. */
  async function remove(id, { hard = false, reason, signal } = {}) {
    const args = { id: String(id) };
    if (hard) args.hard = true;
    if (reason) args.reason = String(reason).slice(0, 200);
    const r = await call('delete_session', args, { signal });
    return { id: String(r?.id ?? id), hard: Boolean(r?.hard), deleted: r?.deleted !== false };
  }

  /**
   * Undo a SOFT delete.
   *
   * THIS IS A REST CALL, NOT AN MCP TOOL — and that is not a stylistic choice.
   * The gateway's MCP transport exposes eleven tools and a restore is not among
   * them: `restore_session` answers `-32601` (no such tool), and
   * `restore_revision` makes an old REVISION current rather than undeleteing a
   * session — pointed at a deleted id it returns `not_found`. Verified live:
   * the ONLY way back is `POST /sessions/{id}/restore`, which answers 200 with
   * the full document record and `deleted: false`.
   *
   * Restoring a document that is NOT deleted is harmless upstream (it answers
   * 200 with the record), so this needs no pre-flight read — the caller does not
   * have to know the current state to ask for the state it wants.
   */
  async function restore(id, { signal } = {}) {
    const token = await ensureToken(signal);
    const r = await request(`/sessions/${encodeURIComponent(String(id))}/restore`, {
      method: 'POST',
      token,
      signal,
    });
    if (!r.ok) throw errorOf(r.body, r.status, 'restore_failed');
    const doc = compactDoc(r.body, baseUrl);
    // A 200 with a body we cannot read is NOT a success we can report: the
    // caller is about to tell the wearer their document is back, so it must be
    // able to name it. Fall back to the id we were given rather than lie.
    return doc ?? { id: String(id), title: '', deleted: false, restored: true };
  }

  /**
   * The library's own totals — `session_stats`. Document and agent counts, tag
   * usage, bytes, and (verified live) the archive-wide revision stats nested
   * under `revisions`, which is why `revisionStats()` below is only needed when
   * the question is scoped to ONE document.
   */
  async function stats({ signal } = {}) {
    return call('session_stats', {}, { signal });
  }

  /**
   * Edit a stored document IN PLACE — `update_session`.
   *
   * A different operation from `create` with `overwrite`, not a synonym: create
   * mints a version from a REPLACEMENT body, while this one can change the
   * metadata alone and leave the stored bytes exactly as they were. Measured
   * live, a title-only edit bumps the version (1 -> 2) and re-derives the slug
   * (`schema-probe` -> `schema-probe-v2`), so it is a real write even with no
   * `html`.
   *
   * `if_version` is optimistic concurrency. Measured live: a stale value is
   * answered `FilesError conflict` — "the document was modified by someone
   * else" — instead of clobbering the other writer. Omitted, the edit always
   * wins, which is right for a wearer editing their own document and wrong for a
   * retry loop, so a caller that retries should pass the version it read.
   */
  async function update(id, { html, title, tags, agent, contentType, ifVersion, signal } = {}) {
    const docId = String(id ?? '').trim();
    if (!docId) throw new FilesError('validation_error', 'id is required');
    const args = { id: docId };
    let touched = false;
    if (html != null) {
      const next = String(html);
      if (!next.trim()) {
        // The gateway accepts an empty string here and stores a document with no
        // body, which is never what "edit this" meant.
        throw new FilesError('validation_error', 'html cannot be emptied — delete the document instead');
      }
      if (Buffer.byteLength(next, 'utf8') > MAX_HTML_BYTES) {
        throw new FilesError('payload_too_large', `document exceeds ${bytes(MAX_HTML_BYTES)}`);
      }
      args.html = next;
      touched = true;
    }
    if (title != null) {
      args.title = String(title).slice(0, 300);
      touched = true;
    }
    if (tags != null) {
      // Accepts the comma-separated string the wearer's tool sends as well as a
      // real array, because `tags` means "the full new set" here — an absent key
      // leaves the old tags alone, and there is no way to clear them but to
      // send an empty set (which the gateway then stores as no tags).
      const list = (Array.isArray(tags) ? tags : String(tags).split(','))
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 12);
      args.tags = list;
      touched = true;
    }
    if (agent) {
      args.agent = String(agent);
      touched = true;
    }
    if (contentType) {
      args.content_type = String(contentType);
      touched = true;
    }
    // An `update_session` with nothing to change still appends a revision and
    // bumps the version, so refusing here keeps a no-op from filling the
    // history with rows that say nothing happened.
    if (!touched) {
      throw new FilesError('validation_error', 'nothing to update — pass html, title, tags, agent or contentType');
    }
    if (Number.isFinite(Number(ifVersion)) && Number(ifVersion) > 0) args.if_version = Number(ifVersion);
    const rec = await call('update_session', args, { signal });
    const doc = compactDoc(rec, baseUrl);
    if (!doc) throw new FilesError('empty_result', 'the gateway did not return the updated document');
    return doc;
  }

  /**
   * A document's change history — `list_revisions`.
   *
   * With NO id this is the WHOLE ARCHIVE's history, newest first. Verified live:
   * a single-document query answers `{ session_id, document, items }` and the
   * archive query answers `{ items }` with no `document` envelope, so this
   * doubles as "what changed lately" without naming a document first.
   *
   * `change` filters by kind (create | replace | update | delete | restore |
   * purge | revert), so "what did an agent DELETE" is one call.
   */
  async function revisions({ id, change, subject, agent, order, limit = LIST_DEFAULT_LIMIT, offset = 0, signal } = {}) {
    const args = {
      limit: Math.min(LIST_MAX_LIMIT, Math.max(1, Number(limit) || LIST_DEFAULT_LIMIT)),
      offset: Math.max(0, Number(offset) || 0),
    };
    const docId = String(id ?? '').trim();
    if (docId) args.id = docId;
    if (change) args.change = String(change);
    if (subject) args.subject = String(subject);
    if (agent) args.agent = String(agent);
    if (order) args.order = String(order);
    const page = await call('list_revisions', args, { signal });
    return { ...compactRevisions(page), raw: page };
  }

  /**
   * ONE revision — `read_revision`.
   *
   * The body comes back only when asked for, for the same reason `read`
   * defaults it off: a past body is still a whole document, and the model has no
   * use for the bytes. A revision that does not exist is a `not_found`, verified
   * live against revision 999.
   */
  async function revision(id, revision, { includeHtml = false, signal } = {}) {
    const docId = String(id ?? '').trim();
    const rev = Number(revision);
    if (!docId) throw new FilesError('validation_error', 'id is required');
    if (!Number.isFinite(rev) || rev < 1) {
      throw new FilesError('validation_error', 'revision must be a positive integer');
    }
    const rec = await call(
      'read_revision',
      { id: docId, revision: rev, include_html: Boolean(includeHtml) },
      { signal },
    );
    const meta = compactRevision(rec);
    if (!meta) throw new FilesError('not_found', 'revision not found', { status: 404 });
    return includeHtml ? { ...meta, html: String(rec.html ?? '') } : meta;
  }

  /**
   * Make an old revision current again — `restore_revision`.
   *
   * Measured live: this does NOT rewrite history. It appends a `revert` row and
   * moves the document to a NEW version whose bytes are the old ones (version
   * 2 -> 3 with revision 1's sha256), so the restore is itself undoable. That is
   * why the app offers it as a normal write rather than an irreversible one.
   *
   * `restore_metadata` (gateway default true) brings the title, tags and agent
   * back along with the body; the live probe showed the slug reverting with the
   * title. Pass false to revert the content while keeping today's metadata.
   */
  async function restoreRevision(id, revision, { restoreMetadata = true, ifVersion, subject, signal } = {}) {
    const docId = String(id ?? '').trim();
    const rev = Number(revision);
    if (!docId) throw new FilesError('validation_error', 'id is required');
    if (!Number.isFinite(rev) || rev < 1) {
      throw new FilesError('validation_error', 'revision must be a positive integer');
    }
    const args = { id: docId, revision: rev, restore_metadata: Boolean(restoreMetadata) };
    if (subject) args.subject = String(subject);
    if (Number.isFinite(Number(ifVersion)) && Number(ifVersion) > 0) args.if_version = Number(ifVersion);
    const rec = await call('restore_revision', args, { signal });
    const doc = compactDoc(rec, baseUrl);
    // The gateway answers with the DOCUMENT record, not a revision row (verified
    // live), so this reports the document that is now current.
    if (!doc) throw new FilesError('empty_result', 'the gateway did not return the restored document');
    return doc;
  }

  /**
   * Substring search over titles and AGENT NAMES — `search_sessions`.
   *
   * Narrower than `list` on purpose: no paging, no filters, and `q` is required,
   * so it is the cheap "find that document" call rather than a query builder.
   */
  async function search({ q, limit = LIST_DEFAULT_LIMIT, signal } = {}) {
    const term = String(q ?? '').trim();
    if (!term) throw new FilesError('validation_error', 'q is required to search');
    const page = await call(
      'search_sessions',
      { q: term, limit: Math.min(LIST_MAX_LIMIT, Math.max(1, Number(limit) || LIST_DEFAULT_LIMIT)) },
      { signal },
    );
    return { ...compactList(page, baseUrl), raw: page };
  }

  /**
   * How much history is kept and how much disk the snapshots occupy —
   * `revision_stats`. Scoped to one document when given an id, archive-wide when
   * not (verified live: `revisions` follows the id while the archive totals, such
   * as `documents_tracked`, stay global either way).
   */
  async function revisionStats(id, { signal } = {}) {
    const docId = String(id ?? '').trim();
    return call('revision_stats', docId ? { id: docId } : {}, { signal });
  }

  /**
   * The document BODY, fetched by the relay to serve it onward.
   *
   * This is the path that exists because the gateway sends
   * `X-Frame-Options: SAMEORIGIN`: a browser on another origin cannot frame
   * `/sessions/{id}/html`, so the relay fetches the bytes with its own
   * credential and re-serves them under htmlResponseHeaders().
   */
  async function body(id, { signal } = {}) {
    const token = await ensureToken(signal);
    const r = await request(`/sessions/${encodeURIComponent(String(id))}/html`, { token, raw: true, signal });
    if (r.status === 404) throw new FilesError('not_found', 'document not found', { status: 404 });
    if (!r.ok) throw new FilesError(`http_${r.status}`, `gateway answered ${r.status}`, { status: r.status });
    return { text: r.text, contentType: r.headers?.get?.('content-type') || 'text/html; charset=utf-8' };
  }

  return {
    baseUrl,
    get configured() {
      return hasCreds;
    },
    /** Introspection for /api/files/status — never a token. */
    get state() {
      return {
        baseUrl,
        mode: apiKey ? 'api_key' : 'password',
        authenticated: Boolean(accessToken),
        subject,
        scopes,
        expiresAt,
        expiresInSeconds: expiresAt ? Math.max(0, Math.round((expiresAt - now()) / 1000)) : null,
      };
    },
    call,
    catalogue,
    /**
     * SHARED session primitives — what the hub client builds on.
     *
     * The hub is the SAME service as the gateway: one origin, one credential,
     * one token family, reached under a different path prefix. So it must ride
     * THIS session rather than opening its own. That is not a tidiness point —
     * refresh tokens are SINGLE-USE and rotate, so two independent sessions on
     * the one account would rotate against each other and the loser's next
     * refresh would be answered `refresh_token_reuse`, revoking the WHOLE family
     * and logging the app out. One session, shared.
     *
     * These are the low-level primitives, deliberately WITHOUT the retry policy:
     * `request` neither renews nor retries, so a caller does
     * `ensureToken()` → `request()` → on 401 `forget()` + ONE retry. That is the
     * same shape `call()` uses, and it must stay the only auth logic.
     */
    request,
    ensureToken,
    forget,
    /** The SHARED sign-in, not the raw one: an outside caller cannot bypass it. */
    login: signIn,
    list,
    listAll,
    search,
    read,
    create,
    update,
    remove,
    restore,
    stats,
    revisions,
    revision,
    restoreRevision,
    revisionStats,
    body,
  };
}

/**
 * The model-facing tool schema, built here so it cannot drift from the client
 * that implements it. Mirrors toolSchemaFor() in local-sse.mjs for the other
 * kinds: one flat object the model can write well, with the actions enumerated.
 *
 * WHY ONE TOOL AND NOT ELEVEN
 *   The gateway exposes eleven tools; this is the ONE the model sees. The reason
 *   is a budget, not taste: the client offers a page at most `MAX_TOOLS` tools in
 *   total, and eleven document tools would evict the page's own navigation to
 *   make room — leaving the model unable to open the page whose tools it was just
 *   given. The `action` switch is what makes eleven capabilities cost one slot.
 *
 * WHY EVERY PARAMETER IS DECLARED HERE
 *   This object is the ONLY description of the parameter layer the model gets, so
 *   a parameter the gateway accepts but this omits is a capability nothing can
 *   reach — which is exactly how `hard`, `reason` and `include_html` were lost.
 *   The set below is therefore the UNION of the eleven tools' parameters, and
 *   checkFilesSchemaDrift() in local-sse.mjs verifies that claim at every boot
 *   against the gateway's own `tools/list`. Because the parameters overlap
 *   (`id`, `html`, `title`, `agent`, `tags` and `content_type` each serve several
 *   actions), each description names the actions it belongs to; a parameter used
 *   by exactly one action says so and is ignored otherwise.
 */
export function filesToolSchema(t) {
  return {
    type: 'function',
    function: {
      name: t?.name || FILES_TOOL_NAME,
      description:
        t?.description ||
        'Store HTML documents in the wearer documents library, and edit, search, delete or ' +
          'version them. Use it to publish a report, briefing, table or chart the wearer can open ' +
          'on the Files page, to change one that is already there, or to look at what changed. ' +
          'A stored page comes back to you as TEXT, IN FULL, only when you ask for it with ' +
          'include_html — read it, change it, then send the result back with update. The wearer ' +
          'reads the rendered page on the Files page.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'publish',
              'list',
              'search',
              'stats',
              'read',
              'update',
              'delete',
              'history',
              'revision',
              'revert',
              'revision_stats',
            ],
            description:
              'publish = create a document; list = what is stored; search = find one by title or ' +
              'author; stats = library totals and disk use; read = one document’s metadata (and, ' +
              'with include_html, its text); ' +
              'update = change a document in place; delete = remove a document; ' +
              'history = the change log (one document, or everything when id is omitted); ' +
              'revision = one entry of that history; revert = make an old revision current again; ' +
              'revision_stats = how much history is kept.',
          },
          id: {
            type: 'string',
            description:
              'The 32-character document id. Required by read/update/delete/revision/revert; ' +
              'optional for history and revision_stats (omit for the whole archive). Publishing ' +
              'WITH an id is idempotent, so a retried publish cannot create two copies.',
          },
          html: {
            type: 'string',
            description:
              'publish: the FULL document. update: the replacement body. Use real HTML (<h1>, ' +
              '<table>, <ul>…). Inline CSS is allowed and is the easiest way to make a chart or ' +
              'a table readable.',
          },
          title: {
            type: 'string',
            description:
              'publish/update: a short human title. Derived from <title>/<h1> when omitted. ' +
              'Changing it on update also re-derives the document slug.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description:
              'publish/update: up to 12 short tags, e.g. ["daily","finance"]. On update this is ' +
              'the FULL new set, so send every tag that should remain.',
          },
          agent: {
            type: 'string',
            description:
              'publish/update: the author name recorded on the document. Also filters list and history.',
          },
          content_type: {
            type: 'string',
            enum: ['text/html', 'text/plain', 'application/xhtml+xml'],
            description:
              'publish/update: the body media type. Set text/plain for prose, because the ' +
              'gateway rejects a body that does not look like HTML.',
          },
          slug: {
            type: 'string',
            description: 'publish only: the URL-ish name used in download filenames.',
          },
          overwrite: {
            type: 'boolean',
            description: 'publish only: with an id, replace that document instead of failing.',
          },
          hard: {
            type: 'boolean',
            description:
              'delete only: true purges the stored bytes and it CANNOT be restored. Default ' +
              'false is a soft delete the wearer can undo from the Files page.',
          },
          reason: {
            type: 'string',
            description: 'delete only: why it was removed, recorded on the document.',
          },
          if_version: {
            type: 'integer',
            description:
              'update/revert: optimistic concurrency guard. The version you read; the call fails ' +
              'with a conflict instead of overwriting somebody else’s newer edit.',
          },
          restore_metadata: {
            type: 'boolean',
            description:
              'revert only: also bring the title, tags and agent back (default true). False ' +
              'reverts the content but keeps today’s metadata.',
          },
          subject: {
            type: 'string',
            description: 'history/revert: filter or record changes made by this subject.',
          },
          revision: {
            type: 'integer',
            description:
              'revision/revert: the history position to read or restore. This is the REVISION ' +
              'number, not the document version — history never reuses a number.',
          },
          change: {
            type: 'string',
            enum: ['create', 'replace', 'update', 'delete', 'restore', 'purge', 'revert'],
            description: 'history only: keep just changes of this kind.',
          },
          include_html: {
            type: 'boolean',
            description:
              'read/revision: also return the document body, as PLAIN TEXT (its HTML stripped), ' +
              'so you can read, summarise, quote or REWRITE the page itself. The WHOLE body comes ' +
              'back, not a sample; only a page longer than 60000 characters arrives in slices, and ' +
              'then the text ends with the offset to continue from, so call read again with the ' +
              'same id and that offset — a read that comes back with no such marker is the end. ' +
              'The markup is never sent, only the words it renders, so this is what to use for ' +
              '"what does that report say".',
          },
          q: {
            type: 'string',
            description: 'list/search: free-text term matched against titles and author names.',
          },
          tag: { type: 'string', description: 'list only: keep only documents carrying this tag.' },
          order: {
            type: 'string',
            description:
              'list: created_desc | created_asc | updated_desc | updated_asc | title_asc | ' +
              'title_desc | title_similarity_desc | agent_asc. history: revision_desc | ' +
              'revision_asc | created_desc | created_asc.',
          },
          include_deleted: {
            type: 'boolean',
            description: 'list only: also return soft-deleted documents, which can be restored.',
          },
          limit: {
            type: 'integer',
            description:
              'list/search/history: how many rows to return (1–200). read/revision: with ' +
              'include_html, how many characters of the body text to return (max 60000). Omit ' +
              'it to read the whole body.',
          },
          offset: {
            type: 'integer',
            description:
              'list/history: rows to skip. read/revision: with include_html, the character to ' +
              'start the body text at — pass the offset a truncated read ended with.',
          },
        },
        required: ['action'],
      },
    },
  };
}
