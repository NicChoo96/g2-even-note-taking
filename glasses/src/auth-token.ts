// Tiny pub/sub for the stream credential (owner session token in a browser, or
// an approved per-device ID in the Even App). Both the stream client (stream.ts)
// and the React auth/pairing UI feed this, so the glasses renderer and the web
// editor only connect once a credential is present.
let token: string | null = null;
const listeners = new Set<(t: string | null) => void>();

export function setStreamToken(t: string | null): void {
  if (t === token) return; // idempotent — only notify on an actual change
  token = t;
  for (const l of [...listeners]) l(t);
}

export function getStreamToken(): string | null {
  return token;
}

/** Subscribe to token changes; fires immediately with the current value. */
export function onStreamToken(fn: (t: string | null) => void): () => void {
  listeners.add(fn);
  fn(token);
  return () => {
    listeners.delete(fn);
  };
}
