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
/**
 * How long a sign-in lasts.
 *
 * A YEAR, not the 30 days this used to be. There is exactly one account, it is
 * the owner's, and the only thing a shorter window buys is a random sign-out in
 * the middle of the day with no event to explain it — which reads as a bug, not
 * as a policy. The store is bounded by MAX_SESSIONS and swept on every write, so a
 * long window cannot grow it without limit.
 */
export const SESSION_TTL_MS = 365 * 24 * 3600e3;
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
  // A REMOVAL has to be storable, or a union of two copies can never agree on
  // one. `revoked` is `{ [digest or deviceId]: removedAt }` — the tombstone that
  // lets a merge keep everything either copy knows about WITHOUT resurrecting a
  // device the owner deliberately removed.
  const revoked = {};
  for (const [key, at] of Object.entries(isPlainObject(src.revoked) ? src.revoked : {})) {
    const when = Number(at);
    if (!Number.isFinite(when)) continue;
    if (now - when > SESSION_TTL_MS) continue;
    revoked[key] = when;
  }
  const changed =
    rekeyed.changed || swept.changed || src.v !== AUTH_BLOB_VERSION || src.devices !== devices;
  return {
    value: { v: AUTH_BLOB_VERSION, sessions: swept.sessions, devices, revoked },
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

/**
 * UNION two blobs: this process's and the hub's.
 *
 * WHY THIS EXISTS — and it is the fix for "signed out after logging in".
 *   `reconcile()` used to ADOPT the hub's blob WHOLESALE at boot. The hub copy is
 *   only as fresh as the last successful push, and a push is DEBOUNCED and
 *   `unref`'d — so a restart within a moment of a sign-in (a deploy, a crash, an
 *   OOM kill, a platform restart) could boot with a hub blob that had never heard
 *   of the session that had just been minted. Adoption then deleted it, every
 *   token on the device 401'd, and the wearer landed back on "Sign in with
 *   Google" with `unauthorized` under the button. The Even App lost its approved
 *   device the same way, which is why both surfaces fell over together.
 *
 *   Losing a session is never correct: both inputs are legitimate, and a session
 *   is only ever ADDITIVE. So the store is the union of the two, with the newer
 *   record winning where they disagree, and an approval beating a pending row.
 *
 * ORDER: `local` first, `hub` second. On an exact tie the LOCAL record wins,
 * because it is the one this process has actually been serving from.
 */
export function mergeAuthBlobs(local, hub, now = Date.now()) {
  const a = normaliseAuthBlob(local, now).value;
  const b = normaliseAuthBlob(hub, now).value;

  const sessions = { ...b.sessions };
  for (const [key, value] of Object.entries(a.sessions)) {
    const other = sessions[key];
    if (!other || Number(value?.createdAt) >= Number(other?.createdAt)) sessions[key] = value;
  }

  const devices = { ...b.devices };
  const rank = (d) => (d?.status === 'approved' ? 2 : d?.status === 'pending' ? 1 : 0);
  for (const [key, value] of Object.entries(a.devices)) {
    const other = devices[key];
    if (!other) {
      devices[key] = value;
      continue;
    }
    if (rank(value) > rank(other)) devices[key] = value;
    else if (rank(value) === rank(other) && Number(value?.createdAt) >= Number(other?.createdAt)) {
      devices[key] = value;
    }
  }

  // A tombstone from EITHER side wins over a record from the other: a removal is
  // an explicit act, a presence may simply be a stale copy.
  const revoked = { ...b.revoked, ...a.revoked };
  for (const key of Object.keys(revoked)) {
    delete sessions[key];
    delete devices[key];
  }

  return normaliseAuthBlob({ v: AUTH_BLOB_VERSION, sessions, devices, revoked }, now).value;
}

/** How much of the blob is real. Used for one honest log line, never for a decision. */
export function describeAuthBlob(blob) {
  const sessions = Object.keys(blob?.sessions ?? {}).length;
  const devices = Object.keys(blob?.devices ?? {}).length;
  return `${sessions} session(s), ${devices} device(s)`;
}
