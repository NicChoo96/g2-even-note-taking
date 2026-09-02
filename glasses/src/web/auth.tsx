// Authentication for the G2 Even Reality Hub.
//
// Browser: Google Sign-In. The ID token is verified server-side against the
// ALLOWED_EMAILS whitelist, and the relay issues a per-session token that the
// browser uses for the live stream.
//
// Even App WebView (glasses device): there is no OAuth here. The device
// generates an unguessable per-device ID, shows a short pairing code, and the
// owner approves it from a logged-in browser. Once approved, the device ID
// itself is the stream credential. Every glasses device is individually
// approved — there is no shared device login.
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
import { setStreamToken } from '../auth-token';
import { clearDeviceSession, loadDeviceSession, saveDeviceSession } from '../durable-docs';

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
  // Browser (Google SSO)
  authed: boolean;
  email: string | null;
  error: string | null;
  // Even App device pairing
  paired: boolean;
  pairCode: string | null;
  pairStatus: 'pending' | 'approved' | null;
  pairError: string | null;
  devices: PairedDevice[] | null;
  signOut: () => void;
  setAuthed: (email: string, sessionToken: string) => void;
  setError: (e: string | null) => void;
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
  paired: false,
  pairCode: null,
  pairStatus: null,
  pairError: null,
  devices: null,
  signOut: () => {},
  setAuthed: () => {},
  setError: () => {},
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

  // Browser (Google SSO)
  const [authed, setAuthedState] = useState<boolean>(() => !!sessionStorage.getItem(AUTH_KEY));
  const [email, setEmail] = useState<string | null>(() => sessionStorage.getItem(AUTH_KEY));
  const [error, setError] = useState<string | null>(null);

  // Even App device pairing
  const [paired, setPairedState] = useState<boolean>(false);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairStatus, setPairStatus] = useState<'pending' | 'approved' | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);

  // Boot: restore an existing credential, or start the device pairing flow.
  // The device ID lives in the host's reliable storage (bridge.setLocalStorage)
  // so it survives Even App restarts — no re-pairing every launch.
  useEffect(() => {
    if (inEvenApp) {
      let cancelled = false;
      let timer: number | undefined;
      let approvedOnce = false;

      const tick = async () => {
        if (cancelled) return;
        try {
          let deviceId = await loadDeviceSession();
          if (!deviceId) {
            deviceId = makeDeviceId();
            await saveDeviceSession(deviceId);
          }

          if (approvedOnce) {
            // Already approved — watchdog for owner-initiated revoke.
            const r = await checkPairStatus(deviceId);
            if (cancelled) return;
            if (r.status === 'approved') {
              setPairedState(true);
              setPairStatus('approved');
              setStreamToken(deviceId);
            } else {
              // Revoked / reset — drop the stale credential, go back to pairing.
              console.log('[auth] device no longer approved — clearing session');
              await clearDeviceSession();
              setStreamToken(null);
              approvedOnce = false;
              setPairedState(false);
              setPairStatus('pending');
              setPairCode(null);
            }
            if (!cancelled) timer = window.setTimeout(tick, 15000);
            return;
          }

          // Not approved yet — register (creates/refreshes the pair code).
          const r = await pairRequest(deviceId);
          if (cancelled) return;
          if (r.status === 'approved') {
            approvedOnce = true;
            setPairedState(true);
            setPairStatus('approved');
            setPairCode(null);
            setStreamToken(deviceId);
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
      setLoading(false);
      return () => {
        cancelled = true;
        if (timer) window.clearTimeout(timer);
      };
    }

    // Browser: restore the owner session if one exists.
    const tok = sessionStorage.getItem(SESSION_KEY);
    if (tok) setStreamToken(tok);
    setLoading(false);
    return;
  }, [inEvenApp]);

  const setAuthed = useCallback((em: string, sessionToken: string) => {
    sessionStorage.setItem(AUTH_KEY, em);
    sessionStorage.setItem(SESSION_KEY, sessionToken);
    setAuthedState(true);
    setEmail(em);
    setError(null);
    setStreamToken(sessionToken);
  }, []);

  const signOut = useCallback(() => {
    const tok = sessionStorage.getItem(SESSION_KEY);
    if (tok) void logout(tok);
    sessionStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    setAuthedState(false);
    setEmail(null);
    setStreamToken(null);
    window.google?.accounts?.id?.disableAutoSelect?.();
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
        paired,
        pairCode,
        pairStatus,
        pairError,
        devices,
        signOut,
        setAuthed,
        setError,
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

/** The browser login screen (shown until the whitelisted Google account signs in). */
export function LoginScreen() {
  const { error, setError, setAuthed } = useAuth();
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
          Only whitelisted accounts can access the web control app. New glasses
          devices must be approved from here.
        </p>
      </div>
    </div>
  );
}

/** Shown inside the Even App until this glasses device has been approved. */
export function PairScreen() {
  const { pairCode, pairStatus, pairError } = useAuth();
  return (
    <div className="app" style={{ alignItems: 'center', textAlign: 'center', paddingTop: 60 }}>
      <div>
        <h1>🥽 Pair this device</h1>
        <p className="tagline">
          This glasses device needs your approval before it can see the live stream.
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
              and approve this device. Waiting…
            </p>
          </>
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Contacting the hub…</p>
        )}
        {pairError && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{pairError}</p>}
      </div>
    </div>
  );
}
