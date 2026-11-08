// Multi-select, as arithmetic.
//
// WHY THIS IS ITS OWN MODULE: three panels need the same four answers — what is
// selected, is everything selected, what does the summary say, and what happens
// when a bulk operation half-fails. Written inline three times, those answers
// drift; written once and pure, a harness can pin them without a React tree.
//
// A selection is a plain `string[]` of ids. Order is irrelevant and duplicates
// are impossible by construction (`toggleId` never pushes twice), so nothing here
// needs a Set — and an array survives a `JSON.stringify` if a caller ever wants
// to remember a selection across a re-render.

/** Flip one id in or out. The only way an id ever enters a selection. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** Add every visible id. Union, so a selection made under a filter survives. */
export function selectAll(ids: string[], visible: string[]): string[] {
  const out = [...ids];
  for (const id of visible) if (!out.includes(id)) out.push(id);
  return out;
}

/** Drop ids that are no longer on screen (deleted, filtered out, gone). */
export function keepExisting(ids: string[], existing: string[]): string[] {
  return ids.filter((id) => existing.includes(id));
}

/** Is every visible row already selected? `false` when there are none. */
export function allSelected(ids: string[], visible: string[]): boolean {
  if (visible.length === 0) return false;
  return visible.every((id) => ids.includes(id));
}

/** `"Delete 3 tasks"` — one place that decides plural. */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The line shown after a bulk operation.
 *
 * A bulk delete that reports only its successes is a lie the wearer will discover
 * later, item by item. So failures are ALWAYS named, with the first error when
 * there is one, and the two cases have different wording on purpose: "Deleted 3"
 * means everything went; "Deleted 2 of 3" means you must go and look.
 */
export function describeBulk(
  verbPast: string,
  ok: number,
  failed: Array<{ what: string; error?: string }>,
): string {
  const first = failed[0]?.error ? ` (${failed[0].what}: ${failed[0].error})` : '';
  if (failed.length === 0) return `${verbPast} ${countLabel(ok, 'item')}.`;
  if (ok === 0) return `Nothing was changed — all ${failed.length} failed${first}`;
  return `${verbPast} ${ok} of ${ok + failed.length}; ${failed.length} failed${first}`;
}

/** The confirmation text. Destructive actions ask once, with the count in it. */
export function confirmBulk(what: string, count: number, extra = ''): string {
  return `Delete ${countLabel(count, what)}?${extra ? ` ${extra}` : ''}`;
}
