// Files page capabilities — layer 2.
//
// WHAT THIS PAGE IS
//   `sections.files` is a list of REMOTE documents published to the Jarvis
//   document store (agent-authored HTML, served by a separate service). The
//   app keeps REFERENCES only — id, title, agent, size, updatedAt — and the
//   bodies are streamed into a sandboxed frame on the web page. Nothing here
//   ever holds a document's HTML.
//
// WHY THE RELAY IS IN THE MIDDLE
//   The store's CORS allow-list is empty and its credential is a server secret,
//   so this module calls `/api/files/*` on the relay (see files-client.ts) and
//   the relay makes the authenticated call. That is what lets an in-app Jarvis
//   publish a page without the credential, or the HTML, entering the bundle.
import { getState, update } from '../../store';
import type { FileRef } from '../../types';
import type { Capability, CapabilityResult } from '../types';
import {
  deleteFile,
  listFiles,
  publishFile,
  toFileRef,
  type StoredDoc,
} from '../../web/files-client';
import { resolveFile, short } from './shared';

/** The refs the glasses list and the page are showing. */
function files(): FileRef[] {
  return getState().sections.files;
}

/** Write fresh refs into state — references only, never a body. */
function syncRefs(refs: FileRef[]): void {
  update((s) => ({ ...s, sections: { ...s.sections, files: refs } }));
}

function sizeLabel(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function oneLine(summary: string): string {
  return short(summary, 80);
}

const CAP = 40;

export const filesCapabilities: Capability[] = [
  {
    name: 'files.list',
    page: 'files',
    title: 'List stored documents',
    description:
      'Refresh and list the documents in the Jarvis document store (agent-authored HTML pages). ' +
      'Use when asked what documents, reports or pages exist.',
    params: [
      { name: 'query', type: 'string', description: 'Optional words to search titles and bodies for.' },
      { name: 'agent', type: 'string', description: 'Optional: only documents published by this agent name.' },
    ],
    run: async (args): Promise<CapabilityResult> => {
      const query = String(args.query ?? '').trim();
      const agent = String(args.agent ?? '').trim();
      const res = await listFiles({ limit: CAP, q: query || undefined, agent: agent || undefined });
      if (!res.ok) {
        return {
          ok: false,
          summary: oneLine(`Could not reach the document store: ${res.error ?? 'unknown error'}`),
          hint: 'the relay serves these on /api/files; if it says not configured, the JARVIS_FILE_* env vars are unset',
        };
      }
      syncRefs(res.items.map(toFileRef));
      if (!res.items.length) {
        return {
          ok: true,
          summary: query ? `No documents match "${short(query, 24)}"` : 'No documents stored yet',
          data: { total: res.total, documents: [] },
        };
      }
      return {
        ok: true,
        summary: `${res.items.length} document(s): ${res.items.map((d) => short(d.title || 'Untitled', 18)).join(', ')}`,
        data: {
          total: res.total,
          hasMore: res.hasMore,
          documents: res.items.map((d) => ({
            id: d.id,
            title: d.title || 'Untitled',
            agent: d.agent,
            size: d.size,
            version: d.version,
            tags: d.tags,
            updatedAt: d.updatedAt,
          })),
        },
        hint: 'the body of a stored page is HTML and is only rendered on the web Files tab — use files.read for its details',
      };
    },
  },
  {
    name: 'files.read',
    page: 'files',
    title: 'Read stored document details',
    description:
      'Get one stored document\'s details (title, publishing agent, size, version, tags, when it changed). ' +
      'This does NOT return the page\'s HTML, which is only rendered in the web viewer.',
    params: [
      { name: 'document', type: 'string', description: 'Document title, part of a title, or its number.', required: true },
    ],
    run: async (args): Promise<CapabilityResult> => {
      const target = resolveFile(String(args.document ?? ''), files());
      if (!target) {
        const list = files();
        return {
          ok: false,
          summary: list.length ? 'No stored document matches that' : 'No documents are stored yet',
          hint: list.length ? `documents: ${list.map((f, i) => `${i + 1}. ${short(f.title, 20)}`).join(' | ')}` : 'call files.list first',
        };
      }
      const res = await listFiles({ limit: CAP });
      const doc: StoredDoc | undefined = res.ok
        ? res.items.find((d) => d.id === target.id)
        : undefined;
      // A stale ref is normal: someone can delete a document outside this app.
      if (res.ok && !doc) {
        syncRefs(res.items.map(toFileRef));
        return {
          ok: false,
          summary: `"${short(target.title, 24)}" is no longer in the store`,
          hint: 'the list has been refreshed; the document was deleted elsewhere',
        };
      }
      const size = doc?.size ?? target.size;
      const when = new Date(doc?.updatedAt || target.updatedAt).toISOString().slice(0, 10);
      return {
        ok: true,
        summary: oneLine(`"${short(target.title, 24)}" · ${sizeLabel(size)} · updated ${when}`),
        data: {
          id: target.id,
          title: doc?.title || target.title,
          agent: doc?.agent || target.agent,
          size,
          version: doc?.version,
          tags: doc?.tags,
          updatedAt: doc?.updatedAt ?? target.updatedAt,
          revisionAvailable: Boolean(doc?.version && doc.version > 1),
        },
        hint: 'to show someone the page itself, tell them to open the Files tab on the web app',
      };
    },
  },
  {
    name: 'files.publish',
    page: 'files',
    effect: 'write',
    title: 'Publish an HTML page',
    description:
      'Publish a self-contained HTML document to the Jarvis document store so it can be viewed on the web ' +
      'Files tab. Use when asked to build or save a page, report or dashboard. Pass the COMPLETE HTML ' +
      'document. Sending the same "id" again makes it an update instead of a second copy.',
    params: [
      { name: 'html', type: 'string', description: 'The complete HTML document, starting with <!DOCTYPE html>.', required: true },
      { name: 'title', type: 'string', description: 'Title shown in the list and viewer.', fallback: 'Untitled' },
      { name: 'tags', type: 'string', description: 'Optional comma-separated tags.' },
      { name: 'id', type: 'string', description: 'Existing 32-hex document id to overwrite instead of creating a new page.' },
    ],
    // Writing to a store that serves other people is outward-facing, so it is
    // gated like the other destructive actions even though it is classified
    // `write` (the relay can delete it again).
    confirm: true,
    run: async (args): Promise<CapabilityResult> => {
      const html = String(args.html ?? '');
      if (!html.trim()) return { ok: false, summary: 'No HTML given to publish' };
      const rawTitle = String(args.title ?? '').trim();
      const title = (rawTitle || 'Untitled').slice(0, 300);
      const tags = String(args.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);
      const id = String(args.id ?? '').trim();
      const res = await publishFile({
        html,
        title,
        ...(tags.length ? { tags } : {}),
        ...(id ? { id, overwrite: true } : {}),
      });
      if (!res.ok || !res.document) {
        return {
          ok: false,
          summary: oneLine(`Publish failed: ${res.error ?? 'unknown error'}`),
          hint: 'a body that is not HTML must be published as text/plain; over 4 MB is rejected',
        };
      }
      const doc = res.document;
      // Show the new page immediately rather than at the next poll.
      const already = files().some((f) => f.id === doc.id);
      const next = already
        ? files().map((f) => (f.id === doc.id ? toFileRef(doc) : f))
        : [toFileRef(doc), ...files()].slice(0, CAP);
      syncRefs(next);
      return {
        ok: true,
        summary: oneLine(`${already ? 'Updated' : 'Published'} "${short(title, 24)}" (${sizeLabel(doc.size)})`),
        data: { id: doc.id, title: doc.title, size: doc.size, version: doc.version, tags: doc.tags },
        hint: 'open the Files tab on the web app to view it',
      };
    },
  },
  {
    name: 'files.delete',
    page: 'files',
    effect: 'irreversible',
    title: 'Delete a stored document',
    description:
      'Permanently delete a document from the Jarvis document store. Use only when explicitly asked to ' +
      'remove a stored page.',
    params: [
      { name: 'document', type: 'string', description: 'Document title, part of a title, or its number.', required: true },
    ],
    confirm: true,
    run: async (args): Promise<CapabilityResult> => {
      const target = resolveFile(String(args.document ?? ''), files());
      if (!target) {
        return {
          ok: false,
          summary: files().length ? 'No stored document matches that' : 'No documents are stored yet',
        };
      }
      const res = await deleteFile(target.id, true);
      if (!res.ok) {
        return { ok: false, summary: oneLine(`Delete failed: ${res.error ?? 'unknown error'}`) };
      }
      syncRefs(files().filter((f) => f.id !== target.id));
      return {
        ok: true,
        summary: oneLine(`Deleted "${short(target.title, 24)}"`),
        data: { id: target.id, deleted: res.deleted === true },
      };
    },
  },
];

/** How many stored documents the app currently knows about (page summaries). */
export function storedCount(): number {
  return getState().sections.files.length;
}
