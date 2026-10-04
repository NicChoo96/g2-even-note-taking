// The relay auth store's conversation with the hub — the whole of it, so it can
// be driven against a stub.
//
// The store itself stays where it was: a file the relay reads and writes. This
// module only MIRRORS it into the hub (backend Part 1: `GET|PUT /hub/relay/auth`),
// which is the durable copy, and ADOPTS it back at boot. Doing it this way — the
// file as the working copy, the hub as the authority — means nothing in the auth
// routes changes shape, and a hub that is down, unconfigured or refusing degrades
// to exactly the behaviour that shipped before: the file, alone.
//
// THE THREE RULES THAT MATTER, and the reason each is here:
//
//  1. RECONCILE BEFORE THE LISTENER ACCEPTS ANYTHING. `loadAuthStore()` reads an
//     EPHEMERAL file, so on a fresh container it is empty while the hub holds the
//     real sessions. If the listener started first, a valid token would 401 for a
//     moment — and the app's `onAuthRejected` path signs the user straight out,
//     reintroducing the very bug being fixed as a startup race. A bounded boot
//     delay is the correct trade.
//  2. A HUB FAILURE IS NEVER A REQUEST FAILURE. Every call here is awaited by
//     nothing that answers a request: `markChanged()` returns immediately and the
//     push rides a debounced, serialised chain. Sign-in must not depend on the
//     hub being reachable, because it did not before.
//  3. THE SWEEP RUNS BEFORE THE BYTES LEAVE. `authBlobOf()` drops expired rows and
//     everything past the newest 50, so the stored copy is bounded no matter how
//     many times anyone signs in.
//
// Zero runtime dependencies (node built-ins only).
import { AUTH_KEY, authBlobOf, describeAuthBlob, normaliseAuthBlob } from './relay-auth.mjs';

/** The blob's path under the hub prefix. Part 1 fixes the key as a path segment. */
export const AUTH_HUB_PATH = `/relay/${AUTH_KEY}`;

/** Statuses that mean "this deployment will never answer here", not "try later". */
const PERMANENT = new Set([403]);

/**
 * @param {object} deps
 * @param {(method:string, path:string, opts?:object) => Promise<{status:number, text?:string}>} deps.call
 *        The hub caller. Injected, so the rules above can be asserted with a stub
 *        and `local-sse.mjs` keeps only the wiring.
 * @param {() => object} deps.getStore   Current auth store (read).
 * @param {(next:object) => void} deps.setStore  Replace it (reconcile adopts a blob).
 * @param {() => void} deps.save         Write the file. Must not throw.
 * @param {number} [deps.timeoutMs]      Boot patience for the read. Default 5000.
 * @param {number} [deps.debounceMs]     Push coalescing window. Default 250.
 */
export function createAuthStoreSync({
  call,
  getStore,
  setStore,
  save,
  timeoutMs = 5000,
  debounceMs = 250,
  now = Date.now,
  log = () => {},
  warn = () => {},
}) {
  // Flipped off only on a status that will not change for this credential, so a
  // deployment whose backend still gates the route never pays the timeout again.
  let usable = true;
  /** Serialises pushes, so two writes can never land out of order and resurrect
   *  an older blob. Each push sends the WHOLE value, so the last one always wins. */
  let chain = Promise.resolve();
  let timer = null;

  /** One read. Never rejects, and reports its failure as a status. */
  async function readBlob() {
    if (!usable) return { status: 0, value: null };
    let res;
    try {
      res = await call('GET', AUTH_HUB_PATH);
    } catch {
      return { status: 0, value: null };
    }
    const status = Number(res?.status);
    if (!Number.isFinite(status) || status === 0) return { status: 0, value: null };
    if (status === 200) {
      let body = null;
      try {
        body = JSON.parse(res.text);
      } catch {
        body = null;
      }
      return { status: 200, value: body?.value ?? null };
    }
    if (PERMANENT.has(status)) {
      usable = false;
      warn(`[g2-hub] hub refuses ${AUTH_HUB_PATH} (${status}) — the local auth file remains the store`);
    }
    return { status, value: null };
  }

  /** One write of the whole blob. Never rejects. */
  async function pushBlob(blob) {
    if (!usable) return false;
    let res;
    try {
      res = await call('PUT', AUTH_HUB_PATH, { body: { value: blob } });
    } catch {
      return false;
    }
    const status = Number(res?.status);
    if (Number.isFinite(status) && status >= 200 && status < 300) return true;
    if (PERMANENT.has(status)) {
      usable = false;
      warn(`[g2-hub] hub refuses ${AUTH_HUB_PATH} (${status}) — the local auth file remains the store`);
    }
    return false;
  }

  function queuePush() {
    chain = chain.then(() => pushBlob(authBlobOf(getStore(), now()))).catch(() => {});
    return chain;
  }

  return {
    /** Persist NOW (the file must be current the moment anything reads it), then
     *  mirror on a debounce. Approve and revoke land in the same second, and each
     *  mutation would otherwise be its own round trip. */
    markChanged() {
      save();
      if (!usable) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void queuePush();
      }, debounceMs);
      // Never hold the process open for a mirror write.
      if (timer && typeof timer.unref === 'function') timer.unref();
    },

    /** Wait for any in-flight mirror. For a shutdown path, not for a request. */
    flush() {
      return chain;
    },

    /** One push of the current store, out of band. */
    pushNow() {
      return pushBlob(authBlobOf(getStore(), now()));
    },

    hubUsable() {
      return usable;
    },

    /**
     * Bring this process's store into agreement with the hub, BEFORE the listener
     * accepts a connection.
     *
     * - `200` → the hub is the authority; adopt its blob and rewrite the file.
     * - `404` → nothing was ever written, so upload what we have. A live
     *   deployment's sessions and approved devices carry over instead of being
     *   invalidated by the upgrade.
     * - anything else → keep running from the file. Reported, not thrown.
     *
     * @returns {'adopted'|'uploaded'|'local'}
     */
    async reconcile() {
      // Normalise what came off disk FIRST. This is the step that re-keys a
      // legacy token-keyed map to digests, and it has to have happened before the
      // listener can serve a lookup.
      setStore(normaliseAuthBlob(getStore(), now()).value);

      const read = await Promise.race([
        readBlob(),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve({ status: 0, value: null }), timeoutMs);
          if (t && typeof t.unref === 'function') t.unref();
        }),
      ]);

      if (read.status === 200 && read.value) {
        const hub = normaliseAuthBlob(read.value, now());
        setStore(hub.value);
        save();
        log(`[g2-hub] auth store adopted from the hub (${describeAuthBlob(hub.value)})`);
        return 'adopted';
      }

      if (read.status === 404) {
        const ok = await pushBlob(authBlobOf(getStore(), now()));
        save();
        log(
          ok
            ? `[g2-hub] auth store uploaded to the hub (${describeAuthBlob(getStore())})`
            : '[g2-hub] auth store upload failed — using the local file',
        );
        return ok ? 'uploaded' : 'local';
      }

      save();
      log(`[g2-hub] auth store kept on disk (hub status ${read.status})`);
      return 'local';
    },
  };
}
