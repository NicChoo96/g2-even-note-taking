// Mounts the companion web UI (same page as the glasses app). Called from
// main.ts — this is what makes ONE URL show the pasteboard in any browser
// while the SDK draws to the glasses when loaded inside the Even App.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

export function mountUi(): void {
  const rootEl = document.getElementById('root');
  if (!rootEl || rootEl.dataset.mounted) return;
  rootEl.dataset.mounted = '1';
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
