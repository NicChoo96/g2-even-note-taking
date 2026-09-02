// Durable docs persistence.
//
// The Even App WebView is a Flutter WebView — browser localStorage/IndexedDB
// do NOT reliably survive app restarts there (see the device-features G2 skill:
// "SDK localStorage is the only reliable persistence"). So when the SDK bridge
// is available we mirror the docs library into the host's setLocalStorage. In a
// normal browser, window.localStorage is fine and doubles as the backup.
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { DocEntry } from './types';

const KEY = 'hub:docs';

let bridge: EvenAppBridge | null = null;

export function setDurableBridge(b: EvenAppBridge | null): void {
  bridge = b;
}

/** Persist the whole docs library to durable storage. */
export async function saveDocsDurable(docs: DocEntry[]): Promise<void> {
  try {
    const value = JSON.stringify(docs);
    if (bridge) await bridge.setLocalStorage(KEY, value);
    else localStorage.setItem(KEY, value);
  } catch {
    /* ignore */
  }
}

/** Read the docs library back from durable storage (null when absent). */
export async function loadDocsDurable(): Promise<DocEntry[] | null> {
  try {
    let raw: string | null;
    if (bridge) raw = await bridge.getLocalStorage(KEY);
    else raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) {
      return (arr as DocEntry[]).filter(
        (d) => d && typeof d.id === 'string' && typeof d.content === 'string',
      );
    }
    return null;
  } catch {
    return null;
  }
}
