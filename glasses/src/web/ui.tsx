// Mounts the companion web UI (same page as the glasses app). Called from
// main.ts — this is what makes ONE URL show the pasteboard in any browser
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
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider, LoginScreen, PairScreen, useAuth } from './auth';
import './styles.css';

function Gate() {
  const { loading, authed, paired, pairing } = useAuth();
  if (loading) {
    return (
      <div className="app" style={{ textAlign: 'center', padding: 60 }}>
        Loading…
      </div>
    );
  }
  // An owner session, or the approved device it was paired as, opens the app.
  if (authed || paired) return <App />;
  // Pairing is only ever shown because the user asked for it.
  return pairing ? <PairScreen /> : <LoginScreen />;
}

export function mountUi(): void {
  const rootEl = document.getElementById('root');
  if (!rootEl || rootEl.dataset.mounted) return;
  rootEl.dataset.mounted = '1';
  createRoot(rootEl).render(
    <React.StrictMode>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </React.StrictMode>,
  );
}
