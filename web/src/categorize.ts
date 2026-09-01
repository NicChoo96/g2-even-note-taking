import type { SectionId, TodoItem } from './types';
import { uid } from './types';

export interface Categorization {
  todo: TodoItem[];
  docs: string;
  notes: string;
  detected: SectionId[];
}

// Lines that look like tasks: "- ...", "* ...", "[ ] / [x]", "todo:", "task:", "fix:"
const TASK_PREFIX = /^\s*(?:[-*]|\[\s*x?\s*\]|\b(?:todo|task|fix)\b\s*[:.-])\s*/i;
// Lines that look like quick notes: "note:", "notes:", "memo:", "@..."
const NOTE_PREFIX = /^(?:note|notes|memo)\s*[:.-]/i;

/**
 * Heuristic auto-sort of pasted text into To-Do / Docs / Notes.
 * Tasks keep their check state ([x] -> done), everything else falls back to Docs.
 */
export function categorize(text: string, existing: TodoItem[]): Categorization {
  const todo: TodoItem[] = [];
  const docs: string[] = [];
  const notes: string[] = [];
  const detected = new Set<SectionId>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (TASK_PREFIX.test(line)) {
      const done = /^\[x\]/i.test(line);
      const clean = line
        .replace(/^\[[ xX]\]\s*/, '')
        .replace(/^[-*]\s*/, '')
        .replace(/^(?:todo|task|fix)\s*[:.-]\s*/i, '')
        .trim();
      if (clean) {
        todo.push({ id: uid(), text: clean, done });
        detected.add('todo');
      }
    } else if (NOTE_PREFIX.test(line) || line.startsWith('@')) {
      const clean = line.replace(NOTE_PREFIX, '').trim();
      notes.push(clean || line);
      detected.add('notes');
    } else {
      docs.push(line);
      detected.add('docs');
    }
  }

  return {
    todo: [...existing, ...todo],
    docs: docs.join('\n'),
    notes: notes.join('\n'),
    detected: [...detected],
  };
}
