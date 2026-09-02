// Shared protocol types for G2 Even Reality Hub.
// Mirror these in web/src/types.ts — keep them in sync.

export type SectionId = 'todo' | 'docs' | 'notes';

export const SECTION_IDS: SectionId[] = ['todo', 'docs', 'notes'];

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/** A named, saved document (Docs section is now a library of these). */
export interface DocEntry {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
}

export interface HubState {
  activeSection: SectionId;
  sections: {
    todo: TodoItem[];
    /** Multiple named docs — pick one with `activeDocId`. */
    docs: DocEntry[];
    notes: string;
  };
  /** The currently-open doc (Docs mode). Null → fall back to the first doc. */
  activeDocId: string | null;
  updatedAt: number;
}

export interface StreamFrame {
  type: 'init' | 'state';
  state: HubState;
}

export function emptyHubState(): HubState {
  return {
    activeSection: 'todo',
    sections: { todo: [], docs: [], notes: '' },
    activeDocId: null,
    updatedAt: Date.now(),
  };
}

export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyDoc(title = 'Untitled'): DocEntry {
  return { id: uid(), title, content: '', updatedAt: Date.now() };
}

/** Resolve the doc that should be shown in Docs mode. */
export function activeDoc(state: HubState): DocEntry | null {
  return (
    state.sections.docs.find((d) => d.id === state.activeDocId) ??
    state.sections.docs[0] ??
    null
  );
}

/** Rewrite one doc in the collection (adds it if missing). */
export function upsertDoc(
  state: HubState,
  doc: DocEntry,
): { docs: DocEntry[]; activeDocId: string } {
  const exists = state.sections.docs.some((d) => d.id === doc.id);
  const docs = exists
    ? state.sections.docs.map((d) => (d.id === doc.id ? { ...doc, updatedAt: Date.now() } : d))
    : [...state.sections.docs, { ...doc, updatedAt: Date.now() }];
  return { docs, activeDocId: doc.id };
}
