// Notes page capabilities — layer 2.
//
// Notes is a single free-text scratchpad, so the actions are append / replace /
// clear / read. It is the natural target for "note that down".
import { getState, update } from '../../store';
import type { Capability } from '../types';
import { READ_CHARS, appendText, readFrom, short } from './shared';

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
    effect: 'write',
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
    effect: 'irreversible',
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
    effect: 'irreversible',
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
    description:
      'Read the notes so you can answer questions about them or summarise them. Notes longer than one read come ' +
      'back in slices: the text then ends with a marker naming the offset to continue from. Keep calling with that ' +
      'offset until a read comes back WITHOUT the marker — that is the end of the notes.',
    params: [
      {
        name: 'offset',
        type: 'number',
        description:
          'Character to start from, for continuing long notes. Omit to read from the start. A truncated read ' +
          'reports the exact offset to pass next.',
      },
    ],
    run: (args) => {
      const body = notes();
      const total = body.length;
      const from = readFrom(args.offset, total);
      const to = Math.min(total, from + READ_CHARS);
      const more = to < total;
      const slice = body.slice(from, to);
      return {
        ok: true,
        summary: more ? `Notes: ${from}-${to} of ${total} chars` : `Notes: ${total} chars`,
        data: {
          content: more
            ? `${slice}\n…(truncated at ${to} of ${total} chars — call again with offset ${to})`
            : slice,
          offset: from,
          next: more ? to : null,
          total,
          more,
        },
        ...(more ? { hint: `the notes continue — call notes.read again with offset ${to}` } : {}),
      };
    },
  },
];
