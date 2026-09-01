// Shared protocol types for G2 Even Reality Hub.
// Mirror these in web/src/types.ts — keep them in sync.

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
