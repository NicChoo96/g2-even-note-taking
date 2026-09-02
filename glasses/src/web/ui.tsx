// Mounts the companion web UI (same page as the glasses app). Called from
// main.ts — this is what makes ONE URL show the pasteboard in any browser
// while the SDK draws to the glasses when loaded inside the Even App.
//
// Security model:
//  - Browser: gated behind Google Sign-In (owner session token).
//  - Even App WebView: gated behind device pairing — the device shows a code
//    the owner approves from a logged-in browser. No anonymous access either way.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider, LoginScreen, PairScreen, useAuth } from './auth';
import './styles.css';

function Gate() {
  const { loading, inEvenApp, authed, paired } = useAuth();
  if (inEvenApp) {
    // Even App WebView — the glasses device must be approved before anything
    // appears on the stream (and on the glasses).
    if (paired) return <App />;
    return <PairScreen />;
  }
  if (loading) return <div className="app" style={{ textAlign: 'center', padding: 60 }}>Loading…</div>;
  if (!authed) return <LoginScreen />;
  return <App />;
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
