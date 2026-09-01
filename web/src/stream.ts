import type { HubState, StreamFrame } from './types';

const API_BASE: string =
  (import.meta.env.VITE_HUB_API_BASE as string | undefined) ?? '';

/** URL the glasses app subscribes to (SSE). Exposed for docs/debugging. */
export const STREAM_URL = `${API_BASE}/api/stream?channel=hub`;

const STATE_URL = `${API_BASE}/api/stream`;

/**
 * Publish the full HubState snapshot to the hub. The server broadcasts it to
 * every connected SSE client (the glasses + every open web app) — this is the
 * cross-device live-sync push.
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

/**
 * Subscribe to live HubState updates from the hub. The server sends an `init`
 * frame with the latest state the moment we connect, then a `state` frame on
 * every publish — so any device that opens the app boots with the newest data.
 * Returns an unsubscribe function.
 */
export function subscribeState(onFrame: (frame: StreamFrame) => void): () => void {
  const es = new EventSource(STREAM_URL);
  es.onmessage = (ev) => {
    try {
      const frame = JSON.parse(ev.data) as StreamFrame;
      onFrame(frame);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => es.close();
}
