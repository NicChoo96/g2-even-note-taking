// Shared protocol types — mirror glasses/src/types.ts and keep in sync.

export type SectionId = 'todo' | 'docs' | 'notes';

export const SECTION_IDS: SectionId[] = ['todo', 'docs', 'notes'];

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface HubState {
  activeSection: SectionId;
  sections: {
    todo: TodoItem[];
    docs: string;
    notes: string;
  };
  updatedAt: number;
}

export interface StreamFrame {
  type: 'init' | 'state';
  state: HubState;
}

export function emptyHubState(): HubState {
  return {
    activeSection: 'todo',
    sections: { todo: [], docs: '', notes: '' },
    updatedAt: Date.now(),
  };
}

export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
