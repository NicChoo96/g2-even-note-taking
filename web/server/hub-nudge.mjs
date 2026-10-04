// The `hub-changed` nudge — pure rules, in their own module.
//
// WHY THIS EXISTS AT ALL. Every collection now lives in the HUB, and the hub has
// no push route: `POST`/`PUT` to a collection returns the new state to the caller
// and tells nobody else. Two devices therefore had no way to learn that the other
// one had written, which is the "edits never show up on my other device" bug. The
// relay is the one component BOTH devices already hold a connection to, so it
// fans a small frame out along the `hub` SSE channel and each client refetches.
//
// WHY THE FRAME CARRIES NO STATE. The relay's cached copy is a BOOTSTRAP, not the
// authority — see `applyRemote()` in `glasses/src/store.ts`. Re-broadcasting it
// would re-serve a snapshot another device has already superseded, which is the
// stale-frame wipe the hub migration existed to end. So the frame names a
// collection and nothing else. Sessions, memory, the ledger and settings are not
// in the snapshot at all, so no frame could carry them either.
//
// WHY IT LIVES IN ITS OWN FILE. `local-sse.mjs` starts a server the moment it is
// imported, so the relay's rules can only be asserted by reading it as TEXT —
// which proves a string is present and nothing about behaviour. Everything here
// is pure, so `tools/hub-nudge-sim.mjs` can drive the real code with real inputs
// and the relay keeps only the socket work.
//
// Zero runtime dependencies (node built-ins only).

/** The methods that can change a collection. A read must never nudge. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The hub-RELATIVE first path segment — what a client refetches.
 *
 * `/hub/todos` → `/todos`, `/hub/docs/9f3?include=content` → `/docs`, and
 * `/hub` itself → `/`. The query is stripped first: the hub pages with
 * `limit`/`cursor` and a nudge must never carry one of those forward.
 *
 * A leading `hub` segment is dropped when present. `local-sse.mjs` already hands
 * this a prefix-stripped path (`/todos/1`), so today the branch never fires — but
 * a caller that passed the full path would otherwise see EVERY collection collapse
 * to `/hub`, which is a silent whole-snapshot refetch on every write: correct,
 * costly, and impossible to notice. No hub collection is named `hub`.
 */
export function collectionPath(hubPath) {
  const path = String(hubPath ?? '').split('?')[0];
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments[0] === 'hub') segments.shift();
  return segments.length ? `/${segments[0]}` : '/';
}

/**
 * Is this upstream result worth telling the other devices about?
 *
 * A read is not. Neither is a FAILED write: a 4xx/5xx means the collection did
 * not change, so a nudge would send every other device off to refetch identical
 * bytes — the refetch storm the hub's own `rev` rules exist to prevent. Only a
 * 2xx on a mutating method qualifies.
 */
export function shouldNudge(method, status) {
  if (!MUTATING_METHODS.has(String(method || '').toUpperCase())) return false;
  const code = Number(status);
  return Number.isFinite(code) && code >= 200 && code < 300;
}

/**
 * The frame itself.
 *
 * `rev` is added ONLY when the upstream response really contained one. Sessions,
 * memory, the ledger and settings do NOT move `rev` (hub spec §4.3), so a frame
 * that invented one would announce "the to-do list changed" on a routine session
 * write. The nudge NAMES the collection; it never claims a rev.
 *
 * `origin` is the writing client's own id, so its own socket can be skipped: a
 * write must not cost its author a round trip, and — worse — must not repaint a
 * document underneath a cursor that is still typing in it.
 */
export function hubChangedFrame(path, rev, origin) {
  const frame = { type: 'hub-changed', path };
  if (Number.isFinite(rev)) frame.rev = rev;
  if (typeof origin === 'string' && origin.length > 0) frame.origin = origin;
  return frame;
}

/**
 * Does this frame tell `origin` about its OWN write? Then it must be dropped.
 *
 * An ABSENT origin is deliberately not a match: a client is better off doing one
 * redundant read than silently missing a peer's change, so the fallback when the
 * correlation is unknown is to deliver.
 */
export function isOwnEcho(frame, origin) {
  if (!frame || typeof frame !== 'object') return false;
  const from = frame.origin;
  return typeof from === 'string' && from.length > 0 && from === origin;
}

/**
 * A NUMERIC `rev` out of a parsed hub response body, or null when there is none.
 *
 * `typeof` first, deliberately: `Number(null)`, `Number('')` and `Number([])` are
 * all `0`, so a coercion here would turn "the body does not carry a rev" into a
 * perfectly valid-looking `rev: 0` — a claim about the to-do list on a route that
 * has no rev at all. The hub sends a JSON number or no key, and nothing else.
 */
export function revOf(body) {
  const n = body?.rev;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
