// The light/dark choice — ONE owner, one place it is written.
//
// The theme lives in a `data-theme` attribute on <html>, never in React state
// alone: the whole stylesheet is driven by the custom properties on that
// attribute, so a component that re-rendered with a different value while the
// attribute lagged would paint the wrong palette (and a full-page flash on
// reload). `index.html` applies the stored value BEFORE the first paint; this
// module is the runtime half — it reads, writes and notifies.
//
// Precedence, and why:
//   1. an explicit choice the wearer made here (localStorage)
//   2. the operating system's preference, at first run and for as long as the
//      wearer has not chosen
//   3. dark, because this app is a companion to a dark-optimised device
//
// `localStorage` can be wiped by the Even App WebView between launches (see
// `durable-docs.ts` for the full story), so a lost key is a NORMAL state, not an
// error: the wearer simply gets the system preference again.

export type Theme = 'light' | 'dark';

/** Same key the pre-paint script in index.html reads. Keep the two in step. */
export const THEME_KEY = 'hub:theme';

const listeners = new Set<() => void>();

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function storedTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

let current: Theme = 'dark';
let initialised = false;

function paint(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // `color-scheme` is what makes native widgets (scrollbars, date pickers, the
  // select popup) follow the palette instead of staying dark under a light page.
  root.style.colorScheme = theme;
  // On a phone the browser paints its own chrome (address bar, status area)
  // from this tag. Without it a light app keeps a near-black bar above it,
  // which is the one place a theme toggle visibly fails to reach.
  try {
    let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = theme === 'light' ? '#f4f5fa' : '#0e1016';
  } catch {
    /* no <head> to touch — the page still paints correctly */
  }
}

/** The value every subscriber reads. */
export function getTheme(): Theme {
  return current;
}

/** Apply + persist + notify. Idempotent, so a double tap cannot desync. */
export function setTheme(theme: Theme): void {
  const next: Theme = theme === 'light' ? 'light' : 'dark';
  current = next;
  paint(next);
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* a full/denied storage must not break the toggle */
  }
  for (const fn of subscribers()) fn();
}

export function toggleTheme(): Theme {
  setTheme(current === 'dark' ? 'light' : 'dark');
  return current;
}

function subscribers(): Array<() => void> {
  return [...listeners];
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Resolve and apply the theme once, then follow the system preference for as
 * long as the wearer has not overridden it.
 *
 * Safe to call more than once (main.ts runs on every load and the UI can be
 * re-mounted), which is why the listener is only ever registered here.
 */
export function initTheme(): Theme {
  current = storedTheme() ?? systemTheme();
  paint(current);
  if (!initialised) {
    initialised = true;
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      mq.addEventListener('change', () => {
        // Only follow the system while no explicit choice exists. Once the
        // wearer has toggled, their choice outranks the OS everywhere.
        if (storedTheme()) return;
        current = systemTheme();
        paint(current);
        for (const fn of subscribers()) fn();
      });
    } catch {
      /* matchMedia is optional in an ancient WebView */
    }
  }
  return current;
}
