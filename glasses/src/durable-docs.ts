// Durable persistence (docs library + the Even App device session).
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

let bridge: EvenAppBridge | null = null;

export function setDurableBridge(b: EvenAppBridge | null): void {
  bridge = b;
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
