// Authentication for the G2 Even Reality Hub.
//
// ONE credential model for every client: Google Sign-In. The ID token is
// verified server-side against the ALLOWED_EMAILS whitelist and the relay
// issues a per-session token that the browser — and the Even App WebView —
// uses for the live stream, agent runs and settings.
//
// The Even App WebView used to be gated behind a blocking "Pair this device"
// screen, which made the app unusable on the phone that is already talking to
// the glasses over the SDK bridge. It now signs in like any other client. The
// per-device approval flow still exists, unchanged on the wire (self-register →
// code → owner approves → device ID is the credential), but it is OPT-IN: the
// owner turns it on from Settings for a secondary device that cannot do Google
// sign-in, or from the login screen as a fallback.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { API_BASE } from '../stream';
import { onAuthRejected, setStreamToken } from '../auth-token';
// Aliased: this component already has a `setPairCode` — the React state setter for
// the pair code it fetched. Importing the publisher under the same name would be
// shadowed by it and silently do nothing but re-set state to its own value.
import { setPairCode as publishPairCode } from '../pair-code';
import {
  clearDeviceSession,
  clearOwnerSession,
  getDurableBridge,
  loadDeviceSession,
  loadOwnerSession,
  saveDeviceSession,
  saveOwnerSession,
} from '../durable-docs';

// The owner session's FAST PATH — a synchronous read for event handlers, effects
// and render. The durable copy in `durable-docs` is the record of truth in every
// environment; these two are only the cache in front of it (§2.3).
const AUTH_KEY = 'hub:auth'; // owner email
const SESSION_KEY = 'hub:session'; // owner session token

export interface PairedDevice {
  deviceId: string;
  email: string;
  approvedAt: number | null;
}

interface AuthCtx {
  loading: boolean;
  inEvenApp: boolean;
  // Owner (Google SSO) — the primary credential on EVERY surface
  authed: boolean;
  email: string | null;
  error: string | null;
  // Opt-in device pairing (secondary device with no Google sign-in)
  pairing: boolean;
  paired: boolean;
  pairCode: string | null;
  pairStatus: 'pending' | 'approved' | null;
  pairError: string | null;
  thisDeviceId: string | null;
  devices: PairedDevice[] | null;
  signOut: () => void;
  setAuthed: (email: string, sessionToken: string) => void;
  setError: (e: string | null) => void;
  setPairing: (on: boolean) => void;
  unpair: () => void;
  pairDevice: (code: string) => Promise<{ ok: boolean; error?: string }>;
  revokeDevice: (deviceId: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  loading: true,
  inEvenApp: false,
  authed: false,
  email: null,
  error: null,
  pairing: false,
  paired: false,
  pairCode: null,
  pairStatus: null,
  pairError: null,
  thisDeviceId: null,
  devices: null,
  signOut: () => {},
  setAuthed: () => {},
  setError: () => {},
  setPairing: () => {},
  unpair: () => {},
  pairDevice: async () => ({ ok: false }),
  revokeDevice: async () => {},
  refreshDevices: async () => {},
});

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: unknown) => void;
          renderButton: (el: HTMLElement, opts: unknown) => void;
          disableAutoSelect: () => void;
        };
      };
    };
    flutter_inappwebview?: unknown;
  }
}

/** Best-effort detection of the Even App WebView (Flutter WebView). */
function detectEvenApp(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(
    w.flutter_inappwebview ||
      w.flutterWebview ||
      w.FlutterWebView ||
      w.evenapp ||
      /EvenApp|Even Hub|Flutter/i.test(navigator.userAgent),
  );
}

async function getClientId(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/config`);
  const cfg = (await res.json()) as { googleClientId?: string };
  return cfg?.googleClientId || '';
}

async function verify(idToken: string): Promise<{
  ok: boolean;
  email?: string;
  sessionToken?: string;
  error?: string;
}> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    return (await res.json()) as {
      ok: boolean;
      email?: string;
      sessionToken?: string;
      error?: string;
    };
  } catch {
    return { ok: false, error: 'network error' };
  }
}

/**
 * The owner session token, from whichever store has it (§2.3).
 *
 * WHAT WAS WRONG: the token lived ONLY in `sessionStorage` — tab-scoped, and
 * gone when the tab or the browser closes — with the durable copy written
 * exclusively inside the Even App WebView. So in a plain browser every new tab
 * and every restart was signed out with no warning, and a reload took the paired
 * device list with it. Durable storage is the record of truth in EVERY
 * environment now; `sessionStorage` survives only as the synchronous fast path,
 * because this is reached from event handlers that cannot await.
 *
 * Reading TOPS UP the fast path, so the first async read in a fresh tab makes
 * every later synchronous read cheap. Exported for `tools/hub-session-sim.mjs`,
 * which is the only thing that can prove the fallback is real.
 */
export async function anyOwnerToken(): Promise<{ token: string; email: string | null } | null> {
  const tok = sessionStorage.getItem(SESSION_KEY);
  if (tok) return { token: tok, email: sessionStorage.getItem(AUTH_KEY) };
  const saved = await loadOwnerSession();
  if (!saved?.token) return null;
  sessionStorage.setItem(SESSION_KEY, saved.token);
  if (saved.email) sessionStorage.setItem(AUTH_KEY, saved.email);
  return saved;
}

/** Is this stored owner session token still accepted by the relay? */
async function me(sessionToken: string): Promise<{ ok: boolean; email?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { ok?: boolean; email?: string };
    return { ok: !!j.ok, email: j.email };
  } catch {
    // Network issue — keep the session rather than logging the user out.
    return { ok: true };
  }
}

function makeDeviceId(): string {
  return (
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`) + ''
  );
}

async function pairRequest(deviceId: string): Promise<{
  ok: boolean;
  status?: string;
  pairCode?: string;
}> {
  try {
    const res = await fetch(`${API_BASE}/api/pair/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    return (await res.json()) as { ok: boolean; status?: string; pairCode?: string };
  } catch {
    return { ok: false };
  }
}

/** Read-only approval check — used by the approved-device watchdog. */
async function checkPairStatus(deviceId: string): Promise<{ ok: boolean; status?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/pair/status?deviceId=${encodeURIComponent(deviceId)}`);
    return (await res.json()) as { ok: boolean; status?: string };
  } catch {
    return { ok: false };
  }
}

async function pairApprove(pairCode: string, sessionToken: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/pair/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ pairCode }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: 'network error' };
  }
}

/**
 * The paired-device list, WITH the outcome.
 *
 * The `ok` flag has to come back. This used to answer `{devices: []}` for a 401
 * or a dead relay exactly as it did for "nothing is paired" — the flag was read
 * off the response and thrown away — so a failed read rendered as a perfectly
 * valid empty list and looked like every pairing had disappeared.
 * Exported for `tools/hub-session-sim.mjs`: the flag is the whole fix, and a
 * harness that re-implemented this read could not see the difference.
 */
export async function devicesList(
  sessionToken: string,
): Promise<{ ok: boolean; devices: PairedDevice[]; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/devices`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const data = (await res.json()) as { ok?: boolean; devices?: PairedDevice[]; error?: string };
    if (!res.ok || !data.ok) return { ok: false, devices: [], error: data.error };
    return { ok: true, devices: data.devices ?? [] };
  } catch {
    return { ok: false, devices: [], error: 'network error' };
  }
}

async function deviceRevoke(deviceId: string, sessionToken: string): Promise<void> {
  await fetch(`${API_BASE}/api/pair/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ deviceId }),
  });
}

async function logout(sessionToken: string): Promise<void> {
  await fetch(`${API_BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const inEvenApp = useMemo(detectEvenApp, []);

  // Owner (Google SSO) — the primary credential on EVERY surface.
  const [authed, setAuthedState] = useState<boolean>(() => !!sessionStorage.getItem(AUTH_KEY));
  const [email, setEmail] = useState<string | null>(() => sessionStorage.getItem(AUTH_KEY));
  const [error, setError] = useState<string | null>(null);

  // Opt-in device pairing (a secondary device that cannot do Google sign-in).
  const [pairing, setPairingState] = useState(false);
  const [paired, setPairedState] = useState(false);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairStatus, setPairStatus] = useState<'pending' | 'approved' | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);

  // Boot: restore the owner session — but ASK THE RELAY whether the stored token
  // is still valid first. If the auth store was reset (e.g. a Railway redeploy
  // without a persistent volume) the old token 401s everywhere and we'd
  // otherwise sit "signed in" showing a misleading Offline state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let tok = sessionStorage.getItem(SESSION_KEY);
      let em = sessionStorage.getItem(AUTH_KEY);

      // Durable fallback in EVERY environment (§2.3), not just the Even App.
      // This used to be gated on `inEvenApp`, so a plain browser was refused its
      // own saved session and signed out on every new tab and every restart.
      //
      // The Even App WebView's bridge can take up to ~4s to resolve (main.ts
      // mounts this UI BEFORE `waitForEvenAppBridge`), and until it does an
      // empty answer is not yet definitive — so retry briefly, but ONLY while
      // the bridge is genuinely pending. Where there is no bridge to wait for,
      // the first answer is final and the loop would just be four wasted
      // seconds in front of the login screen.
      if (!tok) {
        for (let i = 0; i < 8 && !cancelled; i++) {
          const saved = await loadOwnerSession();
          if (saved) {
            tok = saved.token;
            em = saved.email;
            sessionStorage.setItem(SESSION_KEY, saved.token);
            if (saved.email) sessionStorage.setItem(AUTH_KEY, saved.email);
            break;
          }
          // No bridge yet => the host store was not readable. Once the bridge is
          // up an empty answer is definitive, so stop waiting.
          if (getDurableBridge()) break;
          if (!inEvenApp) break; // nothing to wait for — the answer is final
          await new Promise((r) => window.setTimeout(r, 500));
        }
      }

      if (!tok) {
        // No owner session. An approved device credential from a previous launch
        // still counts, so an already-paired device keeps syncing exactly as it
        // did before — no re-pair, no code screen. Keep the pairing poll alive
        // afterwards so an owner-initiated revoke still drops the credential.
        const devId = await loadDeviceSession();
        if (devId) {
          setThisDeviceId(devId);
          const st = await checkPairStatus(devId);
          if (cancelled) return;
          if (st.status === 'approved') {
            setPairedState(true);
            setPairStatus('approved');
            setPairingState(true);
          } else if (st.ok) {
            // Relay answered and it is NOT approved (revoked / store reset).
            // A network failure must NOT wipe a still-valid credential.
            await clearDeviceSession();
          }
        }
        if (!cancelled) setLoading(false);
        return;
      }

      const m = await me(tok);
      if (cancelled) return;
      if (m.ok) {
        setAuthedState(true);
        setEmail(em || m.email || null);
      } else {
        // The relay did not recognise it. Drop the durable copy too: leaving it
        // behind would let the NEXT page load restore the same dead token and
        // sign the user out again, one full boot later, for no visible reason.
        sessionStorage.removeItem(AUTH_KEY);
        sessionStorage.removeItem(SESSION_KEY);
        void clearOwnerSession();
        setAuthedState(false);
        setEmail(null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [inEvenApp]);

  // Opt-in device pairing. Unchanged on the wire: self-register a per-device ID,
  // show the code, poll until an owner approves it, then keep polling so a
  // revoked device drops its credential instead of streaming forever.
  useEffect(() => {
    if (!pairing) return;
    let cancelled = false;
    let timer: number | undefined;
    let approvedOnce = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        let id = await loadDeviceSession();
        if (!id) {
          id = makeDeviceId();
          await saveDeviceSession(id);
        }
        setThisDeviceId(id);

        if (approvedOnce) {
          // Already approved — watchdog for an owner-initiated revoke.
          const r = await checkPairStatus(id);
          if (cancelled) return;
          if (r.status === 'approved') {
            setPairedState(true);
            setPairStatus('approved');
          } else {
            // Revoked / reset — drop the stale credential, back to the code.
            console.log('[auth] device no longer approved — clearing session');
            await clearDeviceSession();
            approvedOnce = false;
            setPairedState(false);
            setPairStatus('pending');
            setPairCode(null);
          }
          if (!cancelled) timer = window.setTimeout(tick, 15000);
          return;
        }

        // Not approved yet — register (creates/refreshes the pair code).
        const r = await pairRequest(id);
        if (cancelled) return;
        if (r.status === 'approved') {
          approvedOnce = true;
          setPairedState(true);
          setPairStatus('approved');
          setPairCode(null);
        } else {
          setPairedState(false);
          setPairStatus('pending');
          setPairCode(r.pairCode ?? null);
        }
        if (!cancelled) timer = window.setTimeout(tick, 3000);
      } catch {
        // Transient — retry.
        if (!cancelled) timer = window.setTimeout(tick, 3000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [pairing]);

  // The pending code belongs on the LENS as much as on this screen — that is where
  // it gets read from when the phone is in a pocket and the browser doing the
  // approving is on a desk. Publishing it is all this side has to do; the glasses
  // renderer subscribes to `pair-code`.
  useEffect(() => {
    publishPairCode(pairCode);
  }, [pairCode]);

  // NOTE — pairing is deliberately NOT started automatically here, even though a
  // code on the lens would then be up before the wearer looks at the glasses.
  // Pairing is OPT-IN by design (see the header): gating the Even App behind the
  // pair screen is the thing that used to make the app unusable on the phone. An
  // unconditional start would also mint a pending device row on every launch, and
  // the relay has no TTL and hides pending rows from Settings — so that row would
  // be valid and invisible forever. The code reaches the lens the moment the
  // wearer actually opts in, from Settings or from the login screen's fallback
  // link, which is what puts it in front of them.

  // ONE place decides the stream credential. An owner session always wins — it
  // is strictly stronger (it can also write settings) — and an approved device
  // ID is the fallback for a paired secondary device.
  useEffect(() => {
    if (loading) return;
    // Safe to read synchronously: `authed` only ever becomes true once the boot
    // effect or `setAuthed` has put the token in `sessionStorage`, including when
    // the boot effect restored it from durable storage.
    const owner = authed ? sessionStorage.getItem(SESSION_KEY) : null;
    setStreamToken(owner ?? (paired ? thisDeviceId : null));
  }, [loading, authed, paired, thisDeviceId]);

  // Any owner call (stream publish, dictation, SSE reconnect) that comes back
  // 401 means this session died server-side → drop it and show the login screen.
  // An approved DEVICE token is not an owner session, so those 401s are left to
  // the pairing watchdog above (revoked → back to the code screen).
  useEffect(() => {
    if (!authed) return;
    return onAuthRejected(() => {
      const tok = sessionStorage.getItem(SESSION_KEY);
      if (tok) void logout(tok);
      sessionStorage.removeItem(AUTH_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      void clearOwnerSession();
      setAuthedState(false);
      setEmail(null);
      window.google?.accounts?.id?.disableAutoSelect?.();
    });
  }, [authed]);

  const setAuthed = useCallback((em: string, sessionToken: string) => {
    sessionStorage.setItem(AUTH_KEY, em);
    sessionStorage.setItem(SESSION_KEY, sessionToken);
    setAuthedState(true);
    setEmail(em);
    setError(null);
    // An owner session supersedes the device flow — stop the pairing poll.
    setPairingState(false);
    setPairCode(null);
    setPairError(null);
    // Mirror the session into DURABLE storage in every environment (§2.3). The
    // Even App WebView wipes browser storage on restart and a plain browser loses
    // `sessionStorage` when the tab closes, so this is what makes "stay signed
    // in" true on both. BOTH are written: `sessionStorage` is the synchronous
    // fast path, durable storage is the record that survives the restart.
    void saveOwnerSession({ token: sessionToken, email: em });
  }, []);

  const signOut = useCallback(() => {
    const tok = sessionStorage.getItem(SESSION_KEY);
    if (tok) void logout(tok);
    sessionStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    void clearOwnerSession();
    setAuthedState(false);
    setEmail(null);
    setPairingState(false);
    window.google?.accounts?.id?.disableAutoSelect?.();
  }, []);

  const setPairing = useCallback((on: boolean) => {
    setPairError(null);
    setPairingState(on);
    if (!on) {
      setPairCode(null);
      setPairStatus(null);
    }
  }, []);

  /** Forget THIS device's pairing credential (the owner side is "revoke"). */
  const unpair = useCallback(() => {
    void clearDeviceSession();
    setPairingState(false);
    setPairedState(false);
    setPairCode(null);
    setPairStatus(null);
    setThisDeviceId(null);
  }, []);

  const refreshDevices = useCallback(async () => {
    // The DURABLE token, not just the tab's copy: this is the read that renders
    // Settings → Devices, and it is most often called from a freshly opened tab
    // where `sessionStorage` has nothing yet but a saved session exists (§2.3).
    const tok = await anyOwnerToken();
    if (!tok) return;
    const { ok, devices: list, error: why } = await devicesList(tok.token);
    // A FAILED READ MUST NOT RENDER AS "NOTHING PAIRED" (§2.4). Keep the list we
    // already have and say what went wrong; replacing it with `[]` is precisely
    // the "my paired devices disappeared" report.
    if (!ok) {
      setError(why ?? 'Could not load paired devices.');
      return;
    }
    setError(null);
    setDevices(list);
  }, []);

  // Settings → Devices is a RELAY read, so it gets no `hub-changed` nudge the way
  // hub collections do. Returning to the tab is the moment it is most likely to
  // have changed underneath us (a pairing approved on another surface, or a
  // relay that restarted), so re-read it then.
  useEffect(() => {
    if (loading || !authed) return;
    const onBack = (): void => {
      if (document.visibilityState !== 'hidden') void refreshDevices();
    };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [loading, authed, refreshDevices]);

  const pairDevice = useCallback(
    async (code: string): Promise<{ ok: boolean; error?: string }> => {
      const tok = await anyOwnerToken();
      if (!tok) return { ok: false, error: 'Not signed in.' };
      const r = await pairApprove(code.trim().toUpperCase(), tok.token);
      if (r.ok) {
        setPairError(null);
        void refreshDevices();
        return { ok: true };
      }
      setPairError(r.error === 'code not found' ? 'That code was not found.' : 'Approval failed.');
      return { ok: false, error: r.error };
    },
    [refreshDevices],
  );

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      const tok = await anyOwnerToken();
      if (!tok) return;
      await deviceRevoke(deviceId, tok.token);
      void refreshDevices();
    },
    [refreshDevices],
  );

  return (
    <Ctx.Provider
      value={{
        loading,
        inEvenApp,
        authed,
        email,
        error,
        pairing,
        paired,
        pairCode,
        pairStatus,
        pairError,
        thisDeviceId,
        devices,
        signOut,
        setAuthed,
        setError,
        setPairing,
        unpair,
        pairDevice,
        revokeDevice,
        refreshDevices,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  return useContext(Ctx);
}

/** The sign-in screen. Every client uses it, including the Even App WebView. */
export function LoginScreen() {
  const { error, setError, setAuthed, inEvenApp, setPairing } = useAuth();
  const [clientId, setClientId] = useState<string | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const btnRef = useRef<HTMLDivElement>(null);

  // Load the Google Client ID from the relay, then render the Sign-In button.
  useEffect(() => {
    let mounted = true;
    getClientId()
      .then((id) => {
        if (!mounted) return;
        if (id) setClientId(id);
        else setCfgError('Auth is not configured yet — set GOOGLE_CLIENT_ID on the server.');
      })
      .catch(() => mounted && setCfgError('Could not load auth configuration.'));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!clientId || !btnRef.current) return;
    let cancelled = false;

    const renderButton = (g: NonNullable<Window['google']>['accounts']['id']) => {
      if (cancelled || !btnRef.current) return;
      g.initialize({
        client_id: clientId,
        ux_mode: 'popup',
        callback: async (resp: { credential?: string }) => {
          if (!resp?.credential) {
            setError('Sign-in was cancelled.');
            return;
          }
          const v = await verify(resp.credential);
          if (v.ok && v.email && v.sessionToken) {
            setAuthed(v.email, v.sessionToken);
          } else {
            setError(
              v.error === 'not whitelisted'
                ? 'This Google account is not whitelisted. Only the owner can use this app.'
                : 'Sign-in failed. Please try again.',
            );
          }
        },
      });
      g.renderButton(btnRef.current, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'signin_with',
      });
      setCfgError(null);
    };

    // The GSI script (accounts.google.com/gsi/client) is loaded async/defer, so
    // it can still be in flight when the client ID arrives first (the config is
    // a network fetch). Wait for it instead of hard-failing on first sight: poll
    // briefly and only show the "failed to load" error after a real timeout.
    const existing = window.google?.accounts?.id;
    if (existing) {
      renderButton(existing);
      return () => {
        cancelled = true;
      };
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const g = window.google?.accounts?.id;
      if (g) {
        window.clearInterval(timer);
        renderButton(g);
      } else if (Date.now() - startedAt > 15000) {
        window.clearInterval(timer);
        if (!cancelled) setCfgError('Google Sign-In failed to load — check your connection.');
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [clientId, setError, setAuthed]);

  return (
    <div className="app" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 80 }}>
      <div>
        <h1>🥽 G2 Even Reality Hub</h1>
        <p className="tagline">Private — sign in with the owner's Google account to edit.</p>
      </div>
      <div className="card" style={{ minWidth: 300 }}>
        <div ref={btnRef} />
        {cfgError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{cfgError}</p>}
        {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
        <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 14 }}>
          Only whitelisted accounts can access the web control app. Extra glasses
          devices are paired from Settings after you sign in.
        </p>
        {inEvenApp || cfgError ? (
          <p style={{ marginTop: 14 }}>
            <button className="link-btn" onClick={() => setPairing(true)}>
              Can't sign in here? Pair this device instead
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * OPTIONAL per-device approval. No longer a gate for the Even App — it is only
 * reached from Settings, or from the login screen's fallback link when a device
 * cannot complete Google sign-in. The wire protocol is unchanged.
 */
export function PairScreen() {
  const { pairCode, pairStatus, pairError, paired, setPairing } = useAuth();
  return (
    <div className="app" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 60 }}>
      <div>
        <h1>🥽 Pair this device</h1>
        <p className="tagline">
          A device code is an alternative to signing in on this device.
        </p>
      </div>
      <div className="card" style={{ minWidth: 300 }}>
        {pairStatus === 'approved' ? (
          <p style={{ color: 'var(--good)', fontSize: 14 }}>✓ Device approved — starting…</p>
        ) : pairCode ? (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Enter this code on the web app:</p>
            <div className="pair-code">{pairCode}</div>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 12 }}>
              Open the hub URL in a browser, sign in with the owner Google account,
              then approve this code in Settings → Devices. Waiting…
            </p>
          </>
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Contacting the hub…</p>
        )}
        {pairError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{pairError}</p>}
        {!paired && (
          <p style={{ marginTop: 14 }}>
            <button className="link-btn" onClick={() => setPairing(false)}>
              ← Back to sign in
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
