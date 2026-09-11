// Docs page capabilities — layer 2.
//
// The Docs tab is a library of named documents with one "open" doc. These
// capabilities mirror the manager UI: create, open, rename, append to, replace
// and delete.
import { getState, update } from '../../store';
import { activeDoc, emptyDoc, upsertDoc, type DocEntry } from '../../types';
import type { Capability } from '../types';
import { appendText, resolveDoc, short } from './shared';

function docs(): DocEntry[] {
  return getState().sections.docs;
}

function write(doc: DocEntry): void {
  update((s) => {
    const { docs: next, activeDocId } = upsertDoc(s, doc);
    return { ...s, sections: { ...s.sections, docs: next }, activeDocId };
  });
}

function titleOf(d: DocEntry): string {
  return d.title || 'Untitled';
}

export const docsCapabilities: Capability[] = [
  {
    name: 'docs.new',
    page: 'docs',
    title: 'Create document',
    description: 'Create a new empty document and open it. Use for "start a new note/doc called X".',
    params: [
      { name: 'title', type: 'string', description: 'Title for the new document.', fallback: 'Untitled' },
      { name: 'content', type: 'string', description: 'Optional starting text for the document.' },
    ],
    run: (args) => {
      const title = String(args.title ?? '').trim() || 'Untitled';
      const content = String(args.content ?? '').trim();
      const doc = emptyDoc(title);
      doc.content = content;
      write(doc);
      return {
        ok: true,
        summary: `Created "${short(title)}"`,
        data: { id: doc.id, title, chars: content.length },
      };
    },
  },
  {
    name: 'docs.open',
    page: 'docs',
    title: 'Open document',
    description: 'Open one of the existing documents by title or number.',
    params: [{ name: 'doc', type: 'string', description: 'Document title, part of a title, or its number.', required: true }],
    run: (args) => {
      const list = docs();
      if (!list.length) return { ok: false, summary: 'There are no documents yet' };
      const found = resolveDoc(String(args.doc ?? ''), list, null);
      if (!found) {
        return {
          ok: false,
          summary: `No document matches "${short(String(args.doc ?? ''), 24)}"`,
          hint: `documents: ${list.map((d, i) => `${i + 1}. ${titleOf(d)}`).join(' | ')}`,
        };
      }
      update((s) => ({ ...s, activeDocId: found.id }));
      return { ok: true, summary: `Opened "${short(titleOf(found))}"`, data: { id: found.id } };
    },
  },
  {
    name: 'docs.append',
    page: 'docs',
    title: 'Append to document',
    description:
      'Add text to the END of a document, keeping what is already there. Use this for "add this to my X ' +
      'notes". Defaults to the currently open document.',
    params: [
      { name: 'text', type: 'string', description: 'The text to append.', required: true },
      { name: 'doc', type: 'string', description: 'Document title or number. Omit for the open document.' },
    ],
    run: (args) => {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, summary: 'Nothing to append' };
      const list = docs();
      const target = resolveDoc(String(args.doc ?? ''), list, getState().activeDocId);
      if (!target) {
        // No document exists yet — creating one is clearly what the user meant.
        const doc = emptyDoc('Untitled');
        doc.content = text;
        write(doc);
        return { ok: true, summary: `Started a new doc with the text`, data: { id: doc.id, created: true } };
      }
      write({ ...target, content: appendText(target.content, text) });
      return {
        ok: true,
        summary: `Appended to "${short(titleOf(target))}"`,
        data: { id: target.id, charsAdded: text.length },
      };
    },
  },
  {
    name: 'docs.set_content',
    page: 'docs',
    title: 'Replace document text',
    description:
      'REPLACE a document\'s entire contents. Destructive — only when the user asks to rewrite or ' +
      'overwrite the document.',
    params: [
      { name: 'text', type: 'string', description: 'The new full text of the document.', required: true },
      { name: 'doc', type: 'string', description: 'Document title or number. Omit for the open document.' },
    ],
    confirm: true,
    run: (args) => {
      const list = docs();
      const target = resolveDoc(String(args.doc ?? ''), list, getState().activeDocId);
      if (!target) return { ok: false, summary: 'There is no document to replace' };
      const text = String(args.text ?? '').trim();
      write({ ...target, content: text });
      return { ok: true, summary: `Rewrote "${short(titleOf(target))}"`, data: { id: target.id, chars: text.length } };
    },
  },
  {
    name: 'docs.rename',
    page: 'docs',
    title: 'Rename document',
    description: 'Change the title of a document.',
    params: [
      { name: 'title', type: 'string', description: 'The new title.', required: true },
      { name: 'doc', type: 'string', description: 'Document title or number. Omit for the open document.' },
    ],
    run: (args) => {
      const list = docs();
      const target = resolveDoc(String(args.doc ?? ''), list, getState().activeDocId);
      if (!target) return { ok: false, summary: 'There is no document to rename' };
      const title = String(args.title ?? '').trim();
      if (!title) return { ok: false, summary: 'No new title given' };
      const from = titleOf(target);
      write({ ...target, title });
      return { ok: true, summary: `Renamed to "${short(title)}"`, data: { from, id: target.id } };
    },
  },
  {
    name: 'docs.delete',
    page: 'docs',
    title: 'Delete document',
    description: 'Delete a document and its contents permanently.',
    params: [
      { name: 'doc', type: 'string', description: 'Document title or number. Omit for the open document.' },
    ],
    confirm: true,
    run: (args) => {
      const list = docs();
      const target = resolveDoc(String(args.doc ?? ''), list, getState().activeDocId);
      if (!target) return { ok: false, summary: 'There is no document to delete' };
      update((s) => {
        const next = s.sections.docs.filter((d) => d.id !== target.id);
        const nextActive =
          s.activeDocId === target.id ? next[0]?.id ?? null : s.activeDocId;
        return { ...s, sections: { ...s.sections, docs: next }, activeDocId: nextActive };
      });
      return { ok: true, summary: `Deleted "${short(titleOf(target))}"`, data: { id: target.id } };
    },
  },
  {
    name: 'docs.read',
    page: 'docs',
    title: 'Read document',
    description: 'Read the text of a document so you can answer questions about it or summarise it.',
    params: [
      { name: 'doc', type: 'string', description: 'Document title or number. Omit for the open document.' },
    ],
    run: (args) => {
      const list = docs();
      const target = resolveDoc(String(args.doc ?? ''), list, getState().activeDocId);
      if (!target) return { ok: false, summary: 'There is no document to read' };
      const max = 4000;
      const body = target.content.length > max ? `${target.content.slice(0, max)}\n…(truncated)` : target.content;
      return {
        ok: true,
        summary: `Read "${short(titleOf(target))}" (${target.content.length} chars)`,
        data: { id: target.id, title: titleOf(target), content: body },
      };
    },
  },
];

/** Convenience for other modules (AiPanel, context) that show the open doc. */
export function openDocTitle(): string {
  const d = activeDoc(getState());
  return d ? titleOf(d) : '';
}
