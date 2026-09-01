// Mounts the companion web UI (same page as the glasses app). Called from
// main.ts — this is what makes ONE URL show the pasteboard in any browser
// while the SDK draws to the glasses when loaded inside the Even App.
//
// Google Sign-In gates the web control app in a normal browser. Inside the
// Even App WebView (no OAuth possible), the editor stays usable so glasses
// keep working.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider, LoginScreen, useAuth } from './auth';
import './styles.css';

function Gate() {
  const { loading, authed, inEvenApp } = useAuth();
  if (inEvenApp) return <App />; // Even App WebView — skip the login gate
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
