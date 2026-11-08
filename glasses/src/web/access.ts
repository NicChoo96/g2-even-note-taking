// A key you paste ONCE into the app's own Settings, so the package never needs
// the web app to pair it again.
//
// WHY THIS CAN WORK AT ALL
//   The relay's `principalFromToken` accepts two kinds of bearer: an owner
//   session token, OR an approved deviceId. Both are things the wearer can copy
//   out of the web app and paste here. The server still decides whether the key
//   is valid — which is the part that has to stay server-side, because a
//   credential the client can invent is not a credential.
//
// WHY IT IS NOT AUTOMATIC
//   Google sign-in cannot work inside the package: the WebView origin is not on
//   the OAuth client's allowlist, and Google refuses its sign-in inside an
//   embedded WebView regardless. Pairing is the package's only door, and this
//   module is the lock on it: one paste, stored durably, reused on every launch.
//
// STORAGE
//   The RELAY URL goes to `localStorage` because `API_BASE` is a module constant
//   resolved before anything can await. The KEY goes through `saveOwnerSession`,
//   which is bridge-first — the same durable path the pairing already used.

import { loadOwnerSession, saveOwnerSession, clearOwnerSession } from '../durable-docs';

const RELAY_KEY = 'hub:relay';
const SESSION_KEY = 'hub:session';
const AUTH_KEY = 'hub:auth';

/** The relay origin to talk to, or '' for "same origin". */
export function storedRelay(): string {
  try {
    return String(localStorage.getItem(RELAY_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Normalise what a wearer pastes into an origin.
 *
 * People paste the URL they have in the address bar, which is a full app URL
 * (`https://host/`, `https://host/?tab=docs`). Anything past the origin is not
 * part of the API, so it is dropped rather than concatenated into a broken path.
 */
export function normalizeRelay(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(url.protocol)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** Store the relay origin, or clear it with ''. Returns what was stored. */
export function setStoredRelay(raw: string): string {
  const origin = normalizeRelay(raw);
  try {
    if (origin) localStorage.setItem(RELAY_KEY, origin);
    else localStorage.removeItem(RELAY_KEY);
  } catch {
    /* storage blocked — the caller reports it */
  }
  return origin;
}

export interface SavedKey {
  token: string;
  email: string | null;
}

/**
 * Store a pasted key and prime the FAST path.
 *
 * Both stores are written because the two are read from different places: the
 * durable copy is what a fresh launch restores from, and `sessionStorage` is what
 * the synchronous request path reads without awaiting.
 */
export async function savePastedKey(raw: string): Promise<SavedKey | null> {
  const token = String(raw ?? '').trim();
  if (!token) return null;
  const saved: SavedKey = { token, email: null };
  await saveOwnerSession(saved);
  try {
    sessionStorage.setItem(SESSION_KEY, token);
  } catch {
    /* the durable copy is the one that matters */
  }
  return saved;
}

/** Forget the pasted key, on this device only. */
export async function forgetPastedKey(): Promise<void> {
  await clearOwnerSession();
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(AUTH_KEY);
  } catch {
    /* ignore */
  }
}

/** Is this device holding a key at all? Reads the durable copy. */
export async function hasStoredKey(): Promise<boolean> {
  const saved = await loadOwnerSession();
  return Boolean(saved?.token);
}
