// The light/dark switch, as a component so every surface that can be reached
// BEFORE the app shell (the sign-in screen, the pair screen) gets one too.
//
// It reads the same module the shell does, so a toggle pressed on the login
// screen and one pressed inside the app are the same state — not two buttons
// that happen to look alike.
import { useSyncExternalStore } from 'react';
import { getTheme, subscribeTheme, toggleTheme } from './theme';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      onClick={() => toggleTheme()}
      aria-pressed={theme === 'dark'}
      aria-label={label}
      title={label}
    >
      {/* The glyph is decorative: the accessible name above carries the meaning,
          and a screen reader should not read out a sun or a moon. */}
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}
