// Notes page capabilities — layer 2.
//
// Notes is a single free-text scratchpad, so the actions are append / replace /
// clear / read. It is the natural target for "note that down".
import { getState, update } from '../../store';
import type { Capability } from '../types';
import { appendText, short } from './shared';

function notes(): string {
  return getState().sections.notes ?? '';
}

function setNotes(next: string): void {
  update((s) => ({ ...s, sections: { ...s.sections, notes: next } }));
}

export const notesCapabilities: Capability[] = [
  {
    name: 'notes.append',
    page: 'notes',
    title: 'Add to notes',
    description:
      'Add a line to the end of the notes scratchpad, keeping existing notes. This is the right target for ' +
      '"make a note", "note this down", "jot that down".',
    params: [{ name: 'text', type: 'string', description: 'The text to add.', required: true }],
    run: (args) => {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, summary: 'Nothing to add' };
      const before = notes();
      setNotes(appendText(before, text));
      return { ok: true, summary: `Noted: "${short(text)}"`, data: { charsAdded: text.length } };
    },
  },
  {
    name: 'notes.set',
    page: 'notes',
    title: 'Replace notes',
    description: 'REPLACE the entire notes scratchpad. Destructive — only when the user asks to rewrite them.',
    params: [{ name: 'text', type: 'string', description: 'The new full notes text.', required: true }],
    confirm: true,
    run: (args) => {
      const text = String(args.text ?? '').trim();
      setNotes(text);
      return { ok: true, summary: `Rewrote notes (${text.length} chars)` };
    },
  },
  {
    name: 'notes.clear',
    page: 'notes',
    title: 'Clear notes',
    description: 'Delete all notes.',
    params: [],
    confirm: true,
    available: () => notes().trim().length > 0,
    run: () => {
      const had = notes().length;
      setNotes('');
      return { ok: true, summary: 'Cleared all notes', data: { had } };
    },
  },
  {
    name: 'notes.read',
    page: 'notes',
    title: 'Read notes',
    description: 'Read the notes so you can answer questions about them or summarise them.',
    params: [],
    run: () => {
      const body = notes();
      const max = 4000;
      return {
        ok: true,
        summary: `Notes: ${body.length} chars`,
        data: { content: body.length > max ? `${body.slice(0, max)}\n…(truncated)` : body },
      };
    },
  },
];
