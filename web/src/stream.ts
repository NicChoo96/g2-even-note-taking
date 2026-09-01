import type { HubState } from './types';

const API_BASE: string =
  (import.meta.env.VITE_HUB_API_BASE as string | undefined) ?? '';

/** URL the glasses app subscribes to (SSE). Exposed for docs/debugging. */
export const STREAM_URL = `${API_BASE}/api/stream?channel=hub`;

const STATE_URL = `${API_BASE}/api/stream`;

/**
 * Publish the full HubState snapshot to the hub. The server broadcasts it to
 * every connected SSE client (the glasses apps) — this is the double-sync push.
 */
export async function publishState(state: HubState): Promise<boolean> {
  try {
    const res = await fetch(STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    return res.ok;
  } catch {
    return false;
  }
}
