// The Docs list's order and its filter, as pure functions.
//
// WHY THESE ARE NOT INLINE IN App.tsx
//   "Newest at the top" and "filter by title or text" are the two things that
//   make a library of twenty long, similar titles usable — and both are silent
//   when they break. A wrong comparator does not throw; it puts an old doc first
//   and the wearer reads the wrong page. Importing App.tsx to test it is not an
//   option (it pulls the whole store and a React tree), so the rules live here,
//   where a harness can drive them with plain objects.
//
// The store keeps INSERTION order and must keep it: the glasses index into
// `sections.docs` by position for their picker and their swipe cursor, so
// reordering the store would change what "next document" means on the lens.
// Ordering is therefore a property of this list, applied at render time.

import type { DocEntry } from '../types';

/**
 * Newest first, by the timestamp every doc already carries.
 *
 * `updatedAt` is stamped on create, on rename and on every body edit, so this is
 * "most recently touched" rather than "most recently made" — which is the order
 * a working library wants: the thing you were just writing is the thing you are
 * most likely to reopen.
 *
 * A row with no usable stamp sorts LAST rather than first. A missing value would
 * otherwise read as 0 (`-Infinity` in the subtraction) and sink to the bottom by
 * luck, or read as `NaN` and scramble the whole list.
 */
export function orderDocs(docs: readonly DocEntry[]): DocEntry[] {
  return [...docs].sort((a, b) => stamp(b) - stamp(a));
}

function stamp(doc: DocEntry): number {
  const at = Number(doc?.updatedAt);
  return Number.isFinite(at) && at > 0 ? at : -1;
}

/**
 * Filter by title OR body.
 *
 * Both, because the reason this list was hard to search is that the titles are
 * long and similar while the distinguishing words are inside the page. The
 * string is trimmed and lower-cased, so a trailing space or a capital does not
 * turn an obvious match into "no results".
 */
export function filterDocs(docs: readonly DocEntry[], query: string): DocEntry[] {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [...docs];
  return docs.filter(
    (d) =>
      String(d.title ?? '').toLowerCase().includes(needle) ||
      String(d.content ?? '').toLowerCase().includes(needle),
  );
}

/**
 * A doc row's "when", kept short enough for a narrow column.
 *
 * Relative inside a week and a date outside it, because "3h ago" is what the
 * wearer needs while working and a date is what they need when hunting for
 * something older.
 */
export function whenLabel(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return 'unknown';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(at).toLocaleDateString();
}

/** Words in a doc body, for the row's size hint. */
export function docWords(doc: DocEntry): number {
  const text = String(doc?.content ?? '').trim();
  return text ? text.split(/\s+/).length : 0;
}
