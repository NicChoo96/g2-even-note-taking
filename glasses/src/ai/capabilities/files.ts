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
  fetchFileStats,
  listFiles,
  listRevisions,
  publishFile,
  readRevision,
  restoreRevision,
  toFileRef,
  updateFile,
  type RevisionRef,
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
      { name: 'tag', type: 'string', description: 'Optional: only documents carrying this tag.' },
      { name: 'deleted', type: 'boolean', description: 'Set true to ALSO list deleted documents, so one can be restored.' },
    ],
    run: async (args): Promise<CapabilityResult> => {
      const query = String(args.query ?? '').trim();
      const agent = String(args.agent ?? '').trim();
      const tag = String(args.tag ?? '').trim();
      const deleted = args.deleted === true || args.deleted === 'true';
      const res = await listFiles({
        limit: CAP,
        q: query || undefined,
        agent: agent || undefined,
        tag: tag || undefined,
        // The gateway hides a soft-deleted document from EVERY other query, so
        // without this there is no way to see one and therefore no way to know
        // it is recoverable.
        includeDeleted: deleted,
      });
      if (!res.ok) {
        return {
          ok: false,
          summary: oneLine(`Could not reach the document store: ${res.error ?? 'unknown error'}`),
          hint: 'the relay serves these on /api/files; if it says not configured, the JARVIS_FILE_* env vars are unset',
        };
      }
      // Deleted documents must NOT enter the live list: the glasses page and
      // "what do I have" both read those refs, and the reason to ask for them at
      // all is to see what is recoverable.
      const live = res.items.filter((d) => !d.deleted);
      syncRefs(live.map(toFileRef));
      if (!res.items.length) {
        return {
          ok: true,
          summary: query ? `No documents match "${short(query, 24)}"` : 'No documents stored yet',
          data: { total: res.total, documents: [] },
        };
      }
      const gone = res.items.length - live.length;
      return {
        ok: true,
        summary:
          `${live.length} document(s): ${live.map((d) => short(d.title || 'Untitled', 18)).join(', ')}`
          + (gone ? ` — plus ${gone} deleted, restorable` : ''),
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
            deleted: d.deleted,
            deletedReason: d.deletedReason,
          })),
        },
        hint: deleted
          ? 'these include deleted documents; restore one from the Files tab on the web app'
          : 'the body of a stored page is HTML and is only rendered on the web Files tab — use files.read for its details',
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
      const rawTitle = String(args.title ?? '').trim();
      const title = (rawTitle || 'Untitled').slice(0, 300);
      const tags = String(args.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);
      const id = String(args.id ?? '').trim();
      // A METADATA-ONLY EDIT: an existing document, no body.
      //
      // This is the gateway's `update_session`, not `create_session`, and the
      // difference is the whole point: it changes the title or the tags and
      // leaves the stored document alone. Routing it through `overwrite` instead
      // is not possible from here — this app never holds a document's body, so
      // there would be no replacement to send. Before this existed, renaming a
      // stored page was the one edit the wearer simply could not do.
      if (!html.trim() && id) {
        if (!rawTitle && !tags.length) {
          return {
            ok: false,
            summary: 'Nothing to change — give a new title or new tags, or the whole HTML document',
          };
        }
        const patched = await updateFile(id, {
          ...(rawTitle ? { title } : {}),
          ...(tags.length ? { tags } : {}),
        });
        if (!patched.ok || !patched.document) {
          return {
            ok: false,
            summary: oneLine(`Update failed: ${patched.error ?? 'unknown error'}`),
            hint: 'the document must still exist and be live; re-run files.list, or restore it first if it was deleted',
          };
        }
        const edited = patched.document;
        syncRefs(files().map((f) => (f.id === edited.id ? toFileRef(edited) : f)));
        return {
          ok: true,
          summary: oneLine(`Updated "${short(edited.title, 24)}"`),
          data: { id: edited.id, title: edited.title, version: edited.version, tags: edited.tags },
          hint: 'the page itself is unchanged; open the Files tab on the web app to see it',
        };
      }
      if (!html.trim()) return { ok: false, summary: 'No HTML given to publish' };
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
    // Deliberately HARD, and deliberately worded as such.
    //
    // This is the app's one PURGE path: the web page's own delete only flags a
    // document and lists it under Deleted with a Restore button, so this is what
    // reclaims the bytes. Because that makes it the only delete that cannot be
    // undone, it is marked `irreversible` and gated behind `confirm`, and both
    // the title the wearer sees in the confirmation and the summary they hear
    // afterwards say "permanently" — a soft-sounding word on an irreversible
    // action is how the wearer ends up surprised.
    title: 'Permanently delete a stored document',
    description:
      'Permanently delete a document from the Jarvis document store, purging its stored bytes. ' +
      'This cannot be undone. Use only when explicitly asked to remove a stored page for good.',
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
        // Says "permanently" because that is what happened: the relay's delete
        // response is a flat { ok, id, hard, deleted }, and `hard` is what
        // distinguishes a purged document from a restorable one.
        summary: oneLine(`Permanently deleted "${short(target.title, 24)}"`),
        data: { id: target.id, hard: res.hard === true, deleted: res.deleted === true },
      };
    },
  },
  {
    name: 'files.history',
    page: 'files',
    effect: 'read',
    title: 'Show what changed in a document, or how much is stored',
    description:
      'Show a stored document\'s change history — every version, what changed and when — or, with no ' +
      'document named, how many documents the library holds. Use when asked what changed, when a page ' +
      'was last updated, how much is stored, or to find the revision number to go back to.',
    params: [
      {
        name: 'document',
        type: 'string',
        description: 'Document title, part of a title, or its number. Omit for library-wide totals.',
      },
      {
        name: 'revision',
        type: 'number',
        description: 'One specific revision number to look at, as listed by this same action.',
      },
    ],
    run: async (args): Promise<CapabilityResult> => {
      const want = String(args.document ?? '').trim();

      // No document named: the library's own totals. A different question, and
      // the only one `session_stats` can answer — how many documents exist is
      // not derivable from a page of them, which is why this is not simply
      // "list everything and count".
      if (!want) {
        const stats = await fetchFileStats();
        if (!stats.ok) {
          return {
            ok: false,
            summary: oneLine(`Could not read the library totals: ${stats.error ?? 'unknown error'}`),
          };
        }
        const live = Number(stats.live_sessions ?? stats.sessions) || 0;
        const gone = Number(stats.deleted_sessions) || 0;
        const stored = Number(stats.bytes) || 0;
        return {
          ok: true,
          summary: oneLine(
            `${live} document(s)${gone ? `, ${gone} deleted` : ''}, ${sizeLabel(stored)} stored`,
          ),
          data: {
            documents: live,
            deleted: gone,
            agents: stats.agents,
            tags: stats.tags,
            bytes: stored,
            revisions: stats.revisions,
          },
          hint: gone
            ? 'the deleted ones are still stored — restore them from the Files tab on the web app'
            : undefined,
        };
      }

      const target = resolveFile(want, files());
      if (!target) {
        const list = files();
        return {
          ok: false,
          summary: list.length ? 'No stored document matches that' : 'No documents are stored yet',
          hint: list.length
            ? `documents: ${list.map((f, i) => `${i + 1}. ${short(f.title, 20)}`).join(' | ')}`
            : 'call files.list first',
        };
      }

      // One named revision: its details. Not its body — the body is HTML and is
      // only ever rendered in the web viewer, which is what keeps a document out
      // of this app's state (and out of a model's context) entirely.
      const rev = Number(args.revision);
      if (Number.isFinite(rev) && rev >= 1) {
        const res = await readRevision(target.id, rev);
        if (!res.ok || !res.revision) {
          return {
            ok: false,
            summary: oneLine(`"${short(target.title, 20)}" has no revision ${rev}`),
            hint: 'call files.history without a revision to see which ones exist',
          };
        }
        const r: RevisionRef = res.revision;
        const day = new Date(r.createdAt || Date.now()).toISOString().slice(0, 10);
        return {
          ok: true,
          summary: oneLine(
            `Revision ${r.revision}: ${r.change} on ${day}, ${sizeLabel(r.size)}, v${r.version}`,
          ),
          data: {
            id: r.id,
            revision: r.revision,
            version: r.version,
            change: r.change,
            changedContent: r.contentChanged,
            size: r.size,
            createdAt: r.createdAt,
          },
          hint: 'use files.revert to make this revision current again',
        };
      }

      const list = await listRevisions(target.id, { limit: 12 });
      if (!list.ok) {
        return { ok: false, summary: oneLine(`Could not read the history: ${list.error ?? 'unknown error'}`) };
      }
      if (!list.items.length) {
        return { ok: true, summary: oneLine(`"${short(target.title, 20)}" has no recorded changes yet`) };
      }
      const top = list.items[0];
      // Only the last few are spoken; the whole set goes back as data. The
      // glasses summary is what the wearer HEARS, so it has to stay a sentence.
      const story = list.items
        .slice(0, 4)
        .map((r) => `${r.change} ${new Date(r.createdAt || Date.now()).toISOString().slice(0, 10)}`)
        .join(', ');
      return {
        ok: true,
        summary: oneLine(
          `"${short(target.title, 20)}" v${top.version}, ${list.total} change(s): ${story}`,
        ),
        data: {
          id: target.id,
          version: top.version,
          total: list.total,
          hasMore: list.hasMore,
          revisions: list.items.map((r) => ({
            revision: r.revision,
            version: r.version,
            change: r.change,
            changedContent: r.contentChanged,
            createdAt: r.createdAt,
          })),
        },
        hint: 'use files.revert with a revision number to go back to an earlier version',
      };
    },
  },
  {
    name: 'files.revert',
    page: 'files',
    effect: 'write',
    // Confirmed, like publish and for the same reason: this changes a document
    // that other people read. It is classified `write` rather than
    // `irreversible` because the gateway implements it by APPENDING a revert
    // entry — the versions it replaces stay in the history, so a revert can
    // itself be reverted. Calling that irreversible would be a lie in the other
    // direction, and the wearer would be warned off an undo they can safely use.
    title: 'Go back to an earlier version',
    description:
      'Restore an earlier revision of a stored document so it becomes the current version again. ' +
      'Use when asked to undo a change to a stored page, or to go back to a previous version. The ' +
      'versions it replaces are kept, so this can itself be undone.',
    params: [
      { name: 'document', type: 'string', description: 'Document title, part of a title, or its number.', required: true },
      { name: 'revision', type: 'number', description: 'The revision number to go back to, from files.history.', required: true },
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
      const rev = Number(args.revision);
      if (!Number.isFinite(rev) || rev < 1) {
        return {
          ok: false,
          summary: 'Which revision? Give the number from files.history',
        };
      }
      const res = await restoreRevision(target.id, rev, { restoreMetadata: true });
      if (!res.ok || !res.document) {
        return {
          ok: false,
          summary: oneLine(`Could not go back: ${res.error ?? 'unknown error'}`),
          hint: 'the document must still be live; restore it first if it was deleted',
        };
      }
      const doc = res.document;
      syncRefs(files().map((f) => (f.id === doc.id ? toFileRef(doc) : f)));
      return {
        ok: true,
        summary: oneLine(`"${short(doc.title, 22)}" is back to revision ${rev}, now v${doc.version}`),
        data: { id: doc.id, revision: rev, version: doc.version, size: doc.size },
        // Says so plainly, because it is the fact that makes the action safe to
        // accept: nothing was thrown away, so no second confirmation is needed.
        hint: 'the version this replaced is still in the history, so this can be undone the same way',
      };
    },
  },
];

/** How many stored documents the app currently knows about (page summaries). */
export function storedCount(): number {
  return getState().sections.files.length;
}
