// Tiny pub/sub for the PENDING pairing code.
//
// A pairing code exists for exactly one purpose: to be READ OFF THE GLASSES and
// typed into a browser that is already signed in as the owner. The phone it is
// also printed on is, in that moment, the thing in your pocket — so the lens is
// the surface that matters, and it has to be able to see the code the auth UI
// fetched.
//
// Both live in the same page (main.ts mounts the web UI and then draws to the
// lens) but not in the same module, so the value crosses between them here,
// exactly the way the stream credential does in auth-token.ts.
//
// `null` is a real value, not "no news": it means nothing is pending, and the
// sign-in page has to go back to saying so.
let code: string | null = null;
const listeners = new Set<(c: string | null) => void>();

/** Normalise to the relay's own shape: uppercase, alphanumerics only. */
function normalise(next: string | null): string | null {
  const v = String(next ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return v || null;
}

export function setPairCode(next: string | null): void {
  const v = normalise(next);
  if (v === code) return; // idempotent — only notify on an actual change
  code = v;
  for (const l of [...listeners]) l(code);
}

export function getPairCode(): string | null {
  return code;
}

/** Subscribe to changes; fires immediately with the current value. */
export function onPairCode(fn: (c: string | null) => void): () => void {
  listeners.add(fn);
  fn(code);
  return () => {
    listeners.delete(fn);
  };
}
