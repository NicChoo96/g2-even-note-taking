// Google Sign-In for the web control app (browser only).
//
// The glasses rendering (main.ts) is NOT gated — the Even App WebView can't do
// OAuth. Only the companion editor in a normal browser requires Google Sign-In,
// and the ID token is verified server-side by the relay against the
// ALLOWED_EMAILS whitelist (only your account passes).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../stream';

const AUTH_KEY = 'hub:auth';

interface AuthCtx {
  loading: boolean;
  authed: boolean;
  email: string | null;
  inEvenApp: boolean;
  error: string | null;
  signOut: () => void;
  setAuthed: (email: string) => void;
  setError: (e: string | null) => void;
}

const Ctx = createContext<AuthCtx>({
  loading: true,
  authed: false,
  email: null,
  inEvenApp: false,
  error: null,
  signOut: () => {},
  setAuthed: () => {},
  setError: () => {},
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

async function verify(idToken: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    return (await res.json()) as { ok: boolean; email?: string; error?: string };
  } catch {
    return { ok: false, error: 'network error' };
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authed, setAuthedState] = useState<boolean>(() => !!sessionStorage.getItem(AUTH_KEY));
  const [email, setEmail] = useState<string | null>(() => sessionStorage.getItem(AUTH_KEY));
  const [error, setError] = useState<string | null>(null);
  const inEvenApp = useMemo(detectEvenApp, []);

  const setAuthed = useCallback((em: string) => {
    sessionStorage.setItem(AUTH_KEY, em);
    setAuthedState(true);
    setEmail(em);
    setError(null);
  }, []);

  const signOut = useCallback(() => {
    sessionStorage.removeItem(AUTH_KEY);
    setAuthedState(false);
    setEmail(null);
    window.google?.accounts?.id?.disableAutoSelect?.();
  }, []);

  useEffect(() => {
    setLoading(false);
  }, []);

  return (
    <Ctx.Provider value={{ loading, authed, email, inEvenApp, error, signOut, setAuthed, setError }}>
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
        if (v.ok && v.email) {
          setAuthed(v.email);
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
          Only whitelisted accounts can access the web control app. Glasses display
          continues to work regardless.
        </p>
      </div>
    </div>
  );
}
