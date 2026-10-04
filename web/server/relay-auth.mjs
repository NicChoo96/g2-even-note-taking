// The relay's auth store, made durable in the HUB — the pure parts.
//
// WHY. `.g2-hub-auth.json` sits on the container's EPHEMERAL filesystem, so every
// redeploy wipes every owner session AND every approved device. The app then gets
// a 401 on every call and signs the user out, and the Settings device list comes
// back empty. The hub is durable, so the blob also lives there (backend Part 1:
// `GET|PUT|DELETE /hub/relay/auth`). The file stays as the working copy and the
// offline fallback, so none of the existing auth logic changes shape.
//
// WHAT IS EASY TO GET WRONG, and therefore lives here where a harness can drive
// it directly (importing `local-sse.mjs` starts a server, so nothing in that file
// can be asserted behaviourally):
//   1. SESSION KEYS ARE DIGESTS. A database dump of this blob must not be a
//      working key ring, so a session is keyed by `sha256(token)` and a lookup
//      hashes the presented token. A LEGACY file is keyed by the token itself,
//      and re-keying it in place is what keeps everyone who is signed in right
//      now signed in across this change.
//   2. THE BLOB MUST NOT GROW WITHOUT BOUND. Nothing else ever removes a
//      session, so expired rows (30-day TTL) and everything past the 50 newest
//      are dropped before every write.
//
// Zero runtime dependencies (node built-ins only).
import { createHash } from 'node:crypto';

/** The one key in use. Backend Part 1 constrains it to `^[a-z0-9][a-z0-9-]{0,31}$`. */
export const AUTH_KEY = 'auth';

/** Bumped only when the blob's SHAPE changes, so a future change is detectable. */
export const AUTH_BLOB_VERSION = 1;

/** Backend spec §2.1 step 4 — the sweep's two limits. */
export const SESSION_TTL_MS = 30 * 24 * 3600e3; // 30 days
export const MAX_SESSIONS = 50;

/** A session key is a sha256 hex digest, and nothing else is accepted as one. */
export const DIGEST_RE = /^[0-9a-f]{64}$/;

/** The key a presented token is stored and looked up under. */
export function digestToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function isDigest(key) {
  return DIGEST_RE.test(key);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Re-key a LEGACY session map to digests, in place.
 *
 * The map used to be keyed by the token itself. A lookup hashes the presented
 * token and finds nothing, so without this step the very change meant to protect
 * a session would silently invalidate every live one — the user would be signed
 * out by the upgrade.
 *
 * Digests are laid down FIRST, in their own pass, and the legacy rows are then
 * re-keyed only into the gaps. A collision (the same session present under both
 * spellings) therefore resolves to the DIGEST row — the one a lookup actually
 * computes — rather than to whichever spelling happened to iterate first.
 */
export function rekeySessions(sessions) {
  const src = isPlainObject(sessions) ? sessions : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (isDigest(key)) out[key] = value;
  }
  let changed = false;
  for (const [key, value] of Object.entries(src)) {
    if (isDigest(key)) continue;
    changed = true;
    const next = digestToken(key);
    if (out[next] === undefined) out[next] = value;
  }
  return { sessions: out, changed };
}

/**
 * Drop what must not be stored: sessions past the TTL, rows with no usable
 * timestamp, and everything past the MAX_SESSIONS newest.
 *
 * Runs before every write, so the blob is bounded no matter how many times anyone
 * signs in.
 */
export function sweepSessions(sessions, now = Date.now()) {
  const live = [];
  let changed = false;
  for (const [key, value] of Object.entries(isPlainObject(sessions) ? sessions : {})) {
    const createdAt = Number(value?.createdAt);
    // An entry with no timestamp can never expire, so it would live forever.
    if (!Number.isFinite(createdAt)) {
      changed = true;
      continue;
    }
    if (now - createdAt > SESSION_TTL_MS) {
      changed = true;
      continue;
    }
    live.push([key, value]);
  }
  if (live.length > MAX_SESSIONS) {
    changed = true;
    live.sort((a, b) => Number(b[1].createdAt) - Number(a[1].createdAt));
    live.length = MAX_SESSIONS;
  }
  return { sessions: Object.fromEntries(live), changed };
}

/**
 * Shape an arbitrary blob — from the hub, from disk, or from a half-written file
 * — into a store this process can trust.
 *
 * `changed` reports whether normalisation altered anything, so a caller that
 * persists knows whether there is something new to write. It is a hint, never a
 * substitute for writing: a write is cheap and a missed one is a lost session.
 */
export function normaliseAuthBlob(raw, now = Date.now()) {
  const src = isPlainObject(raw) ? raw : {};
  const rekeyed = rekeySessions(src.sessions);
  const swept = sweepSessions(rekeyed.sessions, now);
  const devices = isPlainObject(src.devices) ? src.devices : {};
  const changed =
    rekeyed.changed || swept.changed || src.v !== AUTH_BLOB_VERSION || src.devices !== devices;
  return {
    value: { v: AUTH_BLOB_VERSION, sessions: swept.sessions, devices },
    changed,
  };
}

/**
 * The blob the relay PUTs to the hub: swept and version-stamped.
 *
 * Sweeping HERE rather than only on load is the point — it is the last moment
 * before the bytes leave the process.
 */
export function authBlobOf(store, now = Date.now()) {
  return normaliseAuthBlob(store, now).value;
}

/** How much of the blob is real. Used for one honest log line, never for a decision. */
export function describeAuthBlob(blob) {
  const sessions = Object.keys(blob?.sessions ?? {}).length;
  const devices = Object.keys(blob?.devices ?? {}).length;
  return `${sessions} session(s), ${devices} device(s)`;
}
