// Shared resolvers for the capability catalog.
//
// The model refers to things the way a person would ("the milk one", "task 2",
// "Meeting Minutes"), so every capability that targets an existing item uses
// the same forgiving resolver instead of inventing its own matching rules.
import { activeDoc, type DocEntry, type TodoItem } from '../../types';

/** Cap for any string that will be rendered on the glasses. */
export function short(text: string, max = 40): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}\u2026` : one;
}

/**
 * Resolve a spoken reference to a list index.
 * Accepts a 1-based number ("2"), an id, an exact match, or a substring —
 * in that order of confidence. Returns -1 when nothing matches.
 */
function resolveIndex(target: string, items: { id: string; label: string }[]): number {
  const t = target.trim();
  if (!t) return -1;

  const num = Number(t);
  if (Number.isInteger(num) && num >= 1 && num <= items.length) return num - 1;

  const byId = items.findIndex((i) => i.id === t);
  if (byId !== -1) return byId;

  const lower = t.toLowerCase();
  const exact = items.findIndex((i) => i.label.toLowerCase() === lower);
  if (exact !== -1) return exact;

  const partial = items.findIndex((i) => i.label.toLowerCase().includes(lower));
  if (partial !== -1) return partial;

  // Last resort: every spoken word appears somewhere in the label.
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 1) {
    const all = items.findIndex((i) => {
      const l = i.label.toLowerCase();
      return words.every((w) => l.includes(w));
    });
    if (all !== -1) return all;
  }
  return -1;
}

/** Resolve a spoken reference to a to-do item. */
export function resolveTodo(target: string, todo: TodoItem[]): { index: number; item: TodoItem | null } {
  const index = resolveIndex(
    target,
    todo.map((t) => ({ id: t.id, label: t.text })),
  );
  return { index, item: index >= 0 ? todo[index] : null };
}

/** Resolve a spoken reference to a document. Falls back to the open doc. */
export function resolveDoc(target: string, docs: DocEntry[], activeDocId: string | null): DocEntry | null {
  const t = (target ?? '').trim();
  if (t) {
    const index = resolveIndex(
      t,
      docs.map((d) => ({ id: d.id, label: d.title || 'Untitled' })),
    );
    if (index >= 0) return docs[index];
    return null;
  }
  return docs.find((d) => d.id === activeDocId) ?? docs[0] ?? null;
}

/** The "list" flavour of the same resolver, for the agent catalog. */
export function resolveAgent<T extends { id: string; name: string }>(
  target: string,
  agents: T[],
): T | null {
  if (!agents.length) return null;
  const t = (target ?? '').trim();
  if (!t) return agents[0];
  const index = resolveIndex(
    t,
    agents.map((a) => ({ id: a.id, label: a.name })),
  );
  return index >= 0 ? agents[index] : null;
}

/** Append to existing text with a single blank-line separator. */
export function appendText(existing: string, addition: string): string {
  const add = addition.replace(/^\s*\n+/, '').replace(/\s+$/, '');
  if (!add) return existing;
  if (!existing.trim()) return add;
  return `${existing.replace(/\s+$/, '')}\n\n${add}`;
}

/** How many docs the app currently has (used by capability gating). */
export function currentDoc(state: { sections: { docs: DocEntry[] }; activeDocId: string | null }): DocEntry | null {
  return activeDoc(state as Parameters<typeof activeDoc>[0]);
}
