// This PAGE LOAD's id.
//
// WHY IT EXISTS: when one device writes a hub collection the relay fans a
// `hub-changed` nudge out to every subscriber — including, unavoidably, the
// socket of the client that did the writing. The author already has the new
// state, and for a document it would mean refetching the body underneath a
// cursor that is still typing. So the relay echoes this id back as `origin` and
// the client drops frames that carry its own.
//
// WHY NOT DERIVE IT FROM THE CREDENTIAL: two tabs of the same signed-in user
// share one token. Keying the id on the token would make the second tab ignore
// the first tab's edits — exactly the case live sync exists for. A fresh id per
// page load is both correct and free.

let id: string | null = null;

/** A stable-for-this-page-load client id, e.g. `c-3f9a1b2c4d5e6f70`. */
export function clientId(): string {
  if (id) return id;
  let rand = '';
  try {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    for (const byte of b) rand += byte.toString(16).padStart(2, '0');
  } catch {
    // No WebCrypto (an old WebView, or a test double). The id only has to be
    // unique among the live sockets of one user, so this is more than enough.
    rand = Math.random().toString(16).slice(2, 18).padEnd(16, '0');
  }
  id = `c-${rand}`;
  return id;
}

/**
 * Did THIS page load write the change that this nudge is about?
 *
 * An ABSENT `origin` is NOT a match. It means the relay could not say who wrote —
 * an older relay, or a frame that arrived without one — and delivering a refresh
 * that was not needed is a wasted read, while dropping one that WAS needed leaves
 * a device showing another's edit as stale with no way to find out. The default
 * has to be "not mine".
 */
export function isOwnEcho(origin: string | undefined | null): boolean {
  return typeof origin === 'string' && origin.length > 0 && origin === clientId();
}
