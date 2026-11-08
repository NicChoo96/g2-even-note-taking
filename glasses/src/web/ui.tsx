// Mounts the companion web UI (same page as the glasses app). Called from
// main.ts — this is what makes ONE URL show the companion UI in any browser
// while the SDK draws to the glasses when loaded inside the Even App.
//
// Security model:
//  - EVERY client signs in with the owner's Google account — a plain browser
//    and the Even App WebView alike. The phone that already drives the glasses
//    over the SDK bridge is not a separate, untrusted device, so it must never
//    sit behind a blocking device-approval screen.
//  - Per-device pairing still exists (same wire protocol) for a device that
//    cannot sign in. It is OPT-IN, lives in Settings → Devices, and the login
//    screen offers it as a fallback inside the Even App only.
//  - No anonymous access either way.
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider, LoginScreen, PairScreen, useAuth } from './auth';
import { initTheme } from './theme';
import { bumpBootCount } from '../durable-docs';
import './styles.css';

function Gate() {
  const { loading, authed, paired, pairing, inEvenApp } = useAuth();
  if (loading) {
    return (
      <div className="app" style={{ textAlign: 'center', padding: 60 }}>
        Loading…
      </div>
    );
  }
  // An owner session, or the approved device it was paired as, opens the app.
  if (authed || paired) return <App />;
  // ── INSIDE THE EVEN APP THERE IS NO SIGN-IN ──────────────────────────────
  // Google cannot work here and never will: the package runs in a WebView whose
  // origin is not on the OAuth client's allowlist, and Google refuses its
  // sign-in inside an embedded WebView outright (`disallowed_useragent`).
  // Showing the button anyway is a dead end the wearer was asked to walk into on
  // every launch, so the package goes straight to pairing — the only door it has.
  if (inEvenApp) return <PackagePairing />;
  // Pairing is only ever shown because the user asked for it.
  return pairing ? <PairScreen /> : <LoginScreen />;
}

/**
 * Pairing for a package, where nobody can press "pair".
 *
 * `PairScreen` only ASKS for a code once `pairing` is true — the request lives in
 * the provider's effect behind that flag. Rendering the screen without starting
 * pairing is therefore a screen that waits for an answer to a question nobody
 * asked: it sat on "Contacting the hub…" forever, which is exactly the bug this
 * component exists to prevent. It starts the request, and keeps it started.
 */
function PackagePairing() {
  const { paired, setPairing } = useAuth();
  useEffect(() => {
    if (!paired) setPairing(true);
  }, [paired, setPairing]);
  return <PairScreen />;
}

export function mountUi(): void {
  const rootEl = document.getElementById('root');
  if (!rootEl || rootEl.dataset.mounted) return;
  // Resolve/persist the palette before the first React paint. index.html has
  // already applied it to avoid a flash; this is the half that also wires the
  // system-preference listener and keeps `color-scheme` correct.
  initTheme();
  // Measure whether this install's DURABLE storage survives a package update —
  // see `bumpBootCount` in ../durable-docs. Fire-and-forget: a counter must
  // never delay a first paint.
  void bumpBootCount();
  rootEl.dataset.mounted = '1';
  createRoot(rootEl).render(
    <React.StrictMode>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </React.StrictMode>,
  );
}
