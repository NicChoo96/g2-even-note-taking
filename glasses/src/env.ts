// Where am I running from? — answered synchronously, with no imports.
//
// This module exists because of an ORDERING problem. `stream.ts` resolves
// `API_BASE` at IMPORT time, before anything is allowed to await the durable
// (bridge) copy of the relay address, so the only things it can consult are the
// ones already on `window`. The `.ehpk` page is served from the app package, so
// "same origin" inside the package is the package itself, and `/api/…` reaches
// nothing at all. Defaulting to the live relay when we are in a package is what
// makes a FRESH install able to pair at all.

/** The relay a package talks to when the wearer has not chosen one. */
export const DEFAULT_RELAY = 'https://g2-even-note-taking-production.up.railway.app';

/**
 * Best-effort detection of an embedded WebView (the Even App / `.ehpk` host).
 *
 * Deliberately generous: a false positive only means "use the live relay instead
 * of same-origin", which is the right answer for any surface that is not being
 * served BY the relay — and every surface being served by the relay is a real
 * `http(s)` document in a browser, where all of these tests are false.
 */
export function inPackageWebview(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  if (w.flutter_inappwebview || w.flutterWebview || w.FlutterWebView || w.evenapp) {
    return true;
  }
  try {
    if (/EvenApp|Even Hub|Flutter/i.test(navigator.userAgent || '')) return true;
  } catch {
    /* no navigator — fall through */
  }
  // A packaged page is not served over http(s) by the relay, so its own origin
  // cannot answer `/api/…`. `file:`, `capacitor:`, `app:` and friends all land
  // here; browsers never do.
  try {
    const proto = String(location.protocol || '');
    return proto !== '' && proto !== 'http:' && proto !== 'https:';
  } catch {
    return false;
  }
}
