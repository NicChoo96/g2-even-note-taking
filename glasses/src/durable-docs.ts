// Durable persistence (docs library + the Even App session credentials).
//
// The Even App WebView is a Flutter WebView — browser localStorage/IndexedDB
// do NOT reliably survive app restarts there (see the device-features G2 skill:
// "SDK localStorage is the only reliable persistence"). So when the SDK bridge
// is available we mirror data into the host's setLocalStorage. In a normal
// browser, window.localStorage is fine and doubles as the backup.
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { DocEntry } from './types';

const DOCS_KEY = 'hub:docs';
const DEVICE_KEY = 'hub:deviceId';
const OWNER_KEY = 'hub:owner';

let bridge: EvenAppBridge | null = null;

export function setDurableBridge(b: EvenAppBridge | null): void {
  bridge = b;
}

/** The live SDK bridge once it is available (null in a plain browser). */
export function getDurableBridge(): EvenAppBridge | null {
  return bridge;
}

// The Even App glasses MIC (AudioInputSource.Glasses) only works AFTER the
// startup page container has been created (createStartUpPageContainer success —
// see the device-features G2 skill). main.ts flips this once it has drawn. The
// phone mic and browser getUserMedia do NOT need it.
let startupReady = false;
export function setStartupReady(ready = true): void {
  startupReady = ready;
}
export function isStartupReady(): boolean {
  return startupReady;
}

// Dual-write strategy. On the real Even App the host's setLocalStorage is the
// ONLY layer that survives app restarts (browser localStorage is wiped). In the
// simulator the reverse is true — the SDK bridge store is per-process but
// window.localStorage persists. Writing to BOTH covers both environments, and
// reads prefer host storage with a localStorage fallback + migrate-up.
async function durableSet(key: string, value: string): Promise<void> {
  try {
    if (bridge) await bridge.setLocalStorage(key, value);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

async function durableGet(key: string): Promise<string | null> {
  let hostRaw: string | null = null;
  if (bridge) {
    try {
      hostRaw = (await bridge.getLocalStorage(key)) || null;
    } catch {
      /* ignore */
    }
  }
  if (hostRaw) return hostRaw;
  try {
    const localRaw = localStorage.getItem(key);
    // Migrate a localStorage-only value up to host storage so it survives
    // Even App restarts once the bridge is available.
    if (localRaw != null && bridge) {
      try {
        await bridge.setLocalStorage(key, localRaw);
      } catch {
        /* ignore */
      }
    }
    return localRaw; // null when absent (never stored)
  } catch {
    return null;
  }
}

async function durableRemove(key: string): Promise<void> {
  try {
    if (bridge) await bridge.setLocalStorage(key, '');
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Persist the whole docs library to durable storage. */
export async function saveDocsDurable(docs: DocEntry[]): Promise<void> {
  await durableSet(DOCS_KEY, JSON.stringify(docs));
}

/** Read the docs library back from durable storage (null when absent). */
export async function loadDocsDurable(): Promise<DocEntry[] | null> {
  const raw = await durableGet(DOCS_KEY);
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) {
      return (arr as DocEntry[]).filter(
        (d) => d && typeof d.id === 'string' && typeof d.content === 'string',
      );
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Device session — the unguessable per-device ID. This is what survives Even
 * App restarts (where browser localStorage is wiped), so the device stays
 * approved instead of re-pairing every launch.
 */
export async function loadDeviceSession(): Promise<string | null> {
  return durableGet(DEVICE_KEY);
}

export async function saveDeviceSession(deviceId: string): Promise<void> {
  await durableSet(DEVICE_KEY, deviceId);
}

/** Clear the stored device session (e.g. the owner revoked this device). */
export async function clearDeviceSession(): Promise<void> {
  await durableRemove(DEVICE_KEY);
}

/**
 * Owner session — the Google sign-in credential. Every client signs in now,
 * including the Even App WebView, so the token has to outlive the WebView's own
 * (wiped) browser storage or the user re-authenticates on every launch.
 * Only the Even App mirror is stored here; a plain browser keeps its token in
 * sessionStorage exactly as before.
 */
export interface OwnerSession {
  token: string;
  email: string | null;
}

export async function loadOwnerSession(): Promise<OwnerSession | null> {
  const raw = await durableGet(OWNER_KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<OwnerSession>;
    if (o && typeof o.token === 'string' && o.token) {
      return { token: o.token, email: typeof o.email === 'string' ? o.email : null };
    }
  } catch {
    /* corrupt — treat as signed out */
  }
  return null;
}

export async function saveOwnerSession(s: OwnerSession): Promise<void> {
  await durableSet(OWNER_KEY, JSON.stringify(s));
}

export async function clearOwnerSession(): Promise<void> {
  await durableRemove(OWNER_KEY);
}

/**
 * Jarvis conversation memory (see ai/memory.ts). Stored as raw JSON so the
 * memory module owns its own shape and versioning — this layer only knows how
 * to move a string in and out of the two storage backends.
 */
const MEMORY_KEY = 'hub:ai-memory';

export async function saveMemoryRaw(json: string): Promise<void> {
  await durableSet(MEMORY_KEY, json);
}

export async function loadMemoryRaw(): Promise<string | null> {
  return durableGet(MEMORY_KEY);
}

export async function clearMemoryRaw(): Promise<void> {
  await durableRemove(MEMORY_KEY);
}
