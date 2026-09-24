// The Files tab: the Jarvis document library, previewed in a sandboxed frame.
//
// WHAT THIS PAGE IS FOR
//   The agent can publish HTML through the `jarvis_files` tool. Those documents
//   live on the gateway, and this page is how a person actually READS them: a
//   list on the left, the selected document rendered on the right.
//
// THE TWO RULES THIS PAGE EXISTS TO KEEP
//   1. No document body is ever STORED in this app. The list is built from refs
//      (id, title, agent, size, updated) and the body is loaded by the browser
//      straight into a frame. Nothing here is written to the synced state, which
//      is also why the body survives a reload without being re-uploaded.
//   2. The frame cannot reach this app. It is served by the relay under
//      `Content-Security-Policy: sandbox allow-scripts` and the `sandbox`
//      attribute below agrees with that: no `allow-same-origin`, so the document
//      gets an opaque origin and cannot touch our DOM, storage or session token.
//
// The list IS mirrored into the shared state (references only) so the glasses
// page can show what exists — that is the whole point of the Files section
// there. `syncRefs` does that, and it only writes when something changed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MicButton } from './Dictate';
import {
  deleteFile,
  fetchFilesStatus,
  fileBodyUrl,
  listFiles,
  publishFile,
  readFile,
  toFileRef,
  type FilesStatus,
  type StoredDoc,
} from './files-client';
import { update } from '../store';
import type { FileRef } from '../types';

/** How many documents this page asks the relay for. */
const PAGE_LIMIT = 100;

function sizeLabel(n: number): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} kB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function whenLabel(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** Are two ref lists the same list? Value comparison, so a re-render is a no-op. */
function sameRefs(a: FileRef[], b: FileRef[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.title !== y.title || x.size !== y.size || x.updatedAt !== y.updatedAt) {
      return false;
    }
  }
  return true;
}

export function FilesPanel() {
  const [docs, setDocs] = useState<StoredDoc[]>([]);
  const [status, setStatus] = useState<FilesStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped to force the frame to re-fetch (a revision may have landed). */
  const [frameKey, setFrameKey] = useState(0);
  /** Draft for the publish box. Local only — never synced, never stored. */
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftHtml, setDraftHtml] = useState('');
  /**
   * Last refs we pushed into the shared state. Kept in a ref (not state) so the
   * mirroring effect can answer "did I already write this?" without causing the
   * render that writing triggers.
   */
  const mirrored = useRef<FileRef[]>([]);

  const configured = status?.configured !== false && !status?.error;

  /** Mirror the REFERENCE list into shared state so the glasses can list it. */
  const syncRefs = useCallback((items: StoredDoc[]) => {
    const next = items.map(toFileRef);
    if (sameRefs(mirrored.current, next)) return;
    mirrored.current = next;
    update((s) => ({ ...s, sections: { ...s.sections, files: next } }));
  }, []);

  const refresh = useCallback(
    async (q?: string) => {
      setBusy(true);
      setError(null);
      const res = await listFiles({ limit: PAGE_LIMIT, q: q?.trim() || undefined });
      setBusy(false);
      if (!res.ok) {
        setError(res.error || 'could not reach the document store');
        return;
      }
      const items = res.items.filter((d) => !d.deleted);
      setDocs(items);
      syncRefs(items);
      // Keep a selection across a refresh, and pick the first document when the
      // previous selection is gone — an empty preview pane with a full list is
      // the one state a reader cannot interpret.
      setSelected((cur) =>
        cur && items.some((d) => d.id === cur) ? cur : (items[0]?.id ?? null),
      );
    },
    [syncRefs],
  );

  useEffect(() => {
    void (async () => {
      const s = await fetchFilesStatus();
      setStatus(s);
      if (s.ok && s.configured) await refresh();
    })();
    // Intentionally once, on mount: the relay caches its credential at boot, so
    // re-probing status on every render would tell us nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useMemo(() => docs.find((d) => d.id === selected) ?? null, [docs, selected]);

  // Read the chosen document's METADATA (never its body) so the header can show
  // the version and revision time, which is what tells a reader whether the
  // frame in front of them is the latest revision.
  const [meta, setMeta] = useState<StoredDoc | null>(null);
  useEffect(() => {
    if (!selected || !configured) {
      setMeta(null);
      return;
    }
    let live = true;
    void (async () => {
      const res = await readFile(selected);
      if (live && res.ok && res.document) setMeta(res.document);
    })();
    return () => {
      live = false;
    };
  }, [selected, configured, frameKey]);

  const onDelete = async (doc: StoredDoc) => {
    if (!window.confirm(`Delete "${doc.title}"? It is a soft delete, so the bytes stay restorable.`)) {
      return;
    }
    setBusy(true);
    const res = await deleteFile(doc.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || 'delete failed');
      return;
    }
    setNotice(`Deleted "${doc.title}"`);
    await refresh(query);
  };

  const onPublish = async () => {
    const html = draftHtml.trim();
    if (!html) return;
    setBusy(true);
    setError(null);
    const res = await publishFile({
      html,
      title: draftTitle.trim() || undefined,
      tags: ['g2-hub'],
    });
    setBusy(false);
    if (!res.ok || !res.document) {
      setError(res.error || 'publish failed');
      return;
    }
    setNotice(`Published "${res.document.title}"`);
    setDraftTitle('');
    setDraftHtml('');
    setDraftOpen(false);
    setSelected(res.document.id);
    await refresh(query);
  };

  return (
    <div className="files-panel">
      <div className="agents-split">
        <div className="agents-master">
          <div className="panel-label">
            Jarvis documents · stored on the gateway, never in this app
          </div>

          {status && !configured && (
            <div className="files-hint">
              Not configured{status.hint ? ` — ${status.hint}` : ''}. Set the document-store
              environment variables and restart the relay.
            </div>
          )}

          <div className="files-search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void refresh(query)}
              placeholder="Filter by title or text…"
            />
            <button className="primary" onClick={() => void refresh(query)} disabled={busy || !configured}>
              {busy ? '…' : 'Sync'}
            </button>
          </div>

          {notice && <div className="files-notice">{notice}</div>}
          {error && <div className="files-error">{error}</div>}

          {docs.length === 0 ? (
            <div className="empty">
              {configured
                ? 'No documents yet — ask Jarvis to publish one, or write one below.'
                : 'Configure the document store to see published documents.'}
            </div>
          ) : (
            <ul className="agent-list files-list">
              {docs.map((d) => (
                <li key={d.id}>
                  <button
                    className={d.id === selected ? 'agent-row active files-row' : 'agent-row files-row'}
                    onClick={() => setSelected(d.id)}
                    title={d.url || d.id}
                  >
                    <span className="agent-name">{d.title || 'Untitled'}</span>
                    <span className="agent-meta">
                      {d.agent || 'unknown'} · {sizeLabel(d.size)}
                      {d.version > 1 ? ` · v${d.version}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="docs-actions">
            <button className="primary" onClick={() => setDraftOpen((v) => !v)} disabled={!configured}>
              {draftOpen ? 'Cancel' : '+ New document'}
            </button>
          </div>

          {draftOpen && (
            <div className="files-draft">
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Title…"
              />
              <div className="field-toolbar">
                <MicButton
                  compact
                  onText={(t) => setDraftHtml((p) => (p.trim() ? `${p.replace(/\s+$/, '')}\n${t}` : t))}
                  title="Dictate the document body"
                />
                <span className="files-draft-note">HTML or plain text — prose is filed as text.</span>
              </div>
              <textarea
                className="doc-textarea"
                rows={10}
                value={draftHtml}
                onChange={(e) => setDraftHtml(e.target.value)}
                placeholder={'<!doctype html>\n<html>…</html>'}
              />
              <div className="docs-actions">
                <button className="primary" onClick={() => void onPublish()} disabled={busy || !draftHtml.trim()}>
                  Publish
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="agents-detail">
          {!active ? (
            <div className="empty">
              Select a document to preview it. Documents render in a sandboxed frame that cannot
              reach this app.
            </div>
          ) : (
            <>
              <div className="files-preview-head">
                <div className="files-preview-title">
                  <strong>{active.title || 'Untitled'}</strong>
                  <span className="agent-meta">
                    {active.agent || 'unknown'} · {sizeLabel(active.size)} ·{' '}
                    {whenLabel((meta ?? active).updatedAt)}
                    {(meta ?? active).version > 1 ? ` · v${(meta ?? active).version}` : ''}
                  </span>
                </div>
                <div className="files-preview-actions">
                  <button
                    className="icon-btn"
                    onClick={() => setFrameKey((k) => k + 1)}
                    title="Reload the preview"
                    aria-label="Reload the preview"
                  >
                    ⟳
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={() => void onDelete(active)}
                    title="Delete this document"
                    aria-label="Delete this document"
                    disabled={busy}
                  >
                    🗑
                  </button>
                </div>
              </div>
              {/*
                `sandbox="allow-scripts"` and NOTHING else. No `allow-same-origin`
                means the frame runs with an opaque origin, so a generated document
                cannot read this app's DOM, its storage or its session token — and
                `allow-scripts` is kept so inline charts still work. This matches
                the relay's own `Content-Security-Policy: sandbox allow-scripts`;
                the two are belt and braces, and neither one alone is relied on.
              */}
              <iframe
                key={`${active.id}:${frameKey}`}
                className="files-frame"
                title={active.title || 'Document preview'}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                src={fileBodyUrl(active.id)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
