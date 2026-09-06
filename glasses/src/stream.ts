import type { HubState, StreamFrame } from './types';
import { getStreamToken, notifyAuthRejected } from './auth-token';

// Same-origin by default: the deployed app is served by the relay at the bare
// root, so /api/stream resolves to the live stream next to it. Local dev
// overrides via VITE_HUB_STREAM_URL in .env.local.
export const STREAM_URL: string =
  (import.meta.env.VITE_HUB_STREAM_URL as string | undefined) ?? '/api/stream?channel=hub';

// Base origin of the relay API (auth / config / stream). Same-origin by default.
export const API_BASE: string = STREAM_URL.split('/api/')[0];

/** The SSE/state URL with the current stream credential appended. */
export function streamUrl(): string {
  const token = getStreamToken();
  if (!token) return STREAM_URL;
  const sep = STREAM_URL.includes('?') ? '&' : '?';
  return `${STREAM_URL}${sep}token=${encodeURIComponent(token)}`;
}

export interface StreamHandlers {
  onState(state: HubState): void;
  onStatus?(status: 'connecting' | 'open' | 'error'): void;
}

/** Publish the full HubState snapshot to the relay (broadcast to all devices). */
export async function publishState(state: HubState): Promise<boolean> {
  const token = getStreamToken();
  if (!token) return false; // not authorized yet — nothing to publish to
  try {
    const res = await fetch(streamUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (res.status === 401) notifyAuthRejected(); // credential no longer valid
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Is the current credential still accepted by the relay? Owner sessions are
 * checked against /api/auth/me; Even App device IDs against /api/pair/status.
 * On a network error we optimistically return true (don't sign out on a blip).
 */
async function credentialStillValid(): Promise<boolean> {
  const token = getStreamToken();
  if (!token) return false;
  try {
    const me = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (me.ok) return true;
  } catch {
    return true; // network issue — can't tell, keep trying
  }
  try {
    const st = await fetch(`${API_BASE}/api/pair/status?deviceId=${encodeURIComponent(token)}`);
    if (st.ok) {
      const j = (await st.json()) as { status?: string };
      return j.status === 'approved';
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * SSE client for the G2 Even Reality Hub stream.
 * Auto-reconnects with exponential backoff (EventSource handles most of it,
 * but we manage re-creation to surface status changes).
 */
export function connectStream(handlers: StreamHandlers): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    handlers.onStatus?.('connecting');
    es = new EventSource(streamUrl());

    es.onopen = () => {
      retry = 0;
      handlers.onStatus?.('open');
    };

    es.onerror = () => {
      handlers.onStatus?.('error');
      es?.close();
      if (!closed) {
        const delay = Math.min(1000 * 2 ** retry, 15000);
        retry += 1;
        // After a few failed reconnects, confirm the credential is still valid;
        // a 401 (reset auth store) otherwise shows as a misleading "Offline".
        if (retry === 3) {
          void credentialStillValid().then((ok) => {
            if (!ok) notifyAuthRejected();
          });
        }
        setTimeout(connect, delay);
      }
    };

    es.onmessage = (e) => {
      try {
        const frame = JSON.parse(e.data as string) as StreamFrame;
        if (frame?.state) handlers.onState(frame.state);
      } catch {
        // ignore malformed frames
      }
    };
  };

  connect();

  return () => {
    closed = true;
    es?.close();
    es = null;
  };
}
