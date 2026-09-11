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
import {
  clearDeviceSession,
  clearOwnerSession,
  getDurableBridge,
  loadDeviceSession,
  loadOwnerSession,
  saveDeviceSession,
  saveOwnerSession,
} from '../durable-docs';

const AUTH_KEY = 'hub:auth'; // owner email (sessionStorage)
const SESSION_KEY = 'hub:session'; // owner session token (sessionStorage)

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

async function devicesList(sessionToken: string): Promise<{ devices: PairedDevice[] }> {
  const res = await fetch(`${API_BASE}/api/devices`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const data = (await res.json()) as { ok?: boolean; devices?: PairedDevice[] };
  return { devices: data.devices ?? [] };
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

      // Even App WebView: its browser storage does not survive a restart, so
      // fall back to the host store. main.ts mounts this UI BEFORE the SDK
      // bridge resolves (waitForEvenAppBridge, up to ~4s) — wait for it rather
      // than racing it and wrongly concluding "signed out" on every launch.
      if (!tok && inEvenApp) {
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

  // ONE place decides the stream credential. An owner session always wins — it
  // is strictly stronger (it can also write settings) — and an approved device
  // ID is the fallback for a paired secondary device.
  useEffect(() => {
    if (loading) return;
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
    // The Even App WebView wipes browser storage on restart, so mirror the
    // session into the host store there (a plain browser keeps sessionStorage).
    if (detectEvenApp()) void saveOwnerSession({ token: sessionToken, email: em });
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
    const tok = sessionStorage.getItem(SESSION_KEY);
    if (!tok) return;
    try {
      const { devices: list } = await devicesList(tok);
      setDevices(list);
    } catch {
      /* ignore */
    }
  }, []);

  const pairDevice = useCallback(
    async (code: string): Promise<{ ok: boolean; error?: string }> => {
      const tok = sessionStorage.getItem(SESSION_KEY);
      if (!tok) return { ok: false, error: 'Not signed in.' };
      const r = await pairApprove(code.trim().toUpperCase(), tok);
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
      const tok = sessionStorage.getItem(SESSION_KEY);
      if (!tok) return;
      await deviceRevoke(deviceId, tok);
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
    const g = window.google?.accounts?.id;
    if (!g) {
      setCfgError('Google Sign-In failed to load — check your connection.');
      return;
    }
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
