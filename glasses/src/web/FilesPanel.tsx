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
  fetchFileMedia,
  fetchFilesStatus,
  fileBodyUrl,
  listFiles,
  publishFile,
  readFile,
  restoreFile,
  toFileRef,
  type FilesStatus,
  type MediaRef,
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
  /**
   * Soft-deleted documents, i.e. flagged gone but still on the gateway.
   *
   * Held separately from `docs` because they are NOT members of the library any
   * more — they must not reach the glasses mirror or the preview frame — but
   * they are also not truly gone, and hiding them was the defect: a delete whose
   * whole selling point was that it could be undone left the document reachable
   * from nowhere.
   */
  const [deleted, setDeleted] = useState<StoredDoc[]>([]);
  /** Which list the left column is showing. */
  const [showDeleted, setShowDeleted] = useState(false);
  const [status, setStatus] = useState<FilesStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The last soft delete, offered as an inline Undo beside the notice. */
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
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
  /**
   * Videos the selected document points at, as the relay resolved them.
   * Empty for most documents, which is not an error and renders nothing.
   */
  const [media, setMedia] = useState<MediaRef[]>([]);
  /** Which of them the box above the document is currently playing, if any. */
  const [playing, setPlaying] = useState<MediaRef | null>(null);

  /**
   * Ask the relay what videos the selected document holds.
   *
   * The relay, not this page: the body goes straight into a sandboxed frame
   * with an opaque origin, so nothing here can read it. The request is cheap
   * and answers `media: []` for a document with none — the common case — so it
   * needs no pre-flight knowledge of what a document contains.
   */
  useEffect(() => {
    setPlaying(null);
    setMedia([]);
    if (!selected || showDeleted) return;
    let live = true;
    void fetchFileMedia(selected).then((r) => {
      // Guarded: a selection made while this was in flight must not have its
      // own, correct list overwritten by this one's late answer.
      if (live) setMedia(r.ok && Array.isArray(r.media) ? r.media : []);
    });
    return () => {
      live = false;
    };
  }, [selected, showDeleted]);

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
      // ONE request answers both questions. `include_deleted` returns the live
      // documents AND the deleted ones, and each row says which it is, so the two
      // lists are a partition of a single page rather than two pages that can
      // disagree with each other (a delete landing between them would make the
      // counts lie).
      const res = await listFiles({
        limit: PAGE_LIMIT,
        q: q?.trim() || undefined,
        includeDeleted: true,
      });
      setBusy(false);
      if (!res.ok) {
        setError(res.error || 'could not reach the document store');
        return;
      }
      const items = res.items ?? [];
      const live = items.filter((d) => !d.deleted);
      const gone = items.filter((d) => d.deleted);
      setDocs(live);
      setDeleted(gone);
      // Only LIVE documents are mirrored to the glasses: the Files section there
      // lists what the wearer can open, and a soft-deleted document no longer
      // has a readable body (its HTML endpoint answers 404).
      syncRefs(live);
      // Keep a selection across a refresh, and pick the first document when the
      // previous selection is gone — an empty preview pane with a full list is
      // the one state a reader cannot interpret.
      setSelected((cur) =>
        cur && live.some((d) => d.id === cur) ? cur : (live[0]?.id ?? null),
      );
      // A list with nothing deleted has no Deleted tab to be looking at.
      if (!gone.length) setShowDeleted(false);
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

  const listed = showDeleted ? deleted : docs;
  const active = useMemo(() => listed.find((d) => d.id === selected) ?? null, [listed, selected]);

  // Read the chosen document's METADATA (never its body) so the header can show
  // the version and revision time, which is what tells a reader whether the
  // frame in front of them is the latest revision.
  const [meta, setMeta] = useState<StoredDoc | null>(null);
  useEffect(() => {
    // A soft-deleted document has no readable metadata (the read answers 404),
    // so asking would only earn a pointless failed request.
    if (!selected || !configured || showDeleted) {
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
  }, [selected, configured, frameKey, showDeleted]);

  /** Put a soft-deleted document back in the library. Also the Undo handler. */
  const onRestore = async (target: { id: string; title: string }) => {
    setBusy(true);
    setError(null);
    const res = await restoreFile(target.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || 'restore failed');
      return;
    }
    setNotice(`Restored "${res.document?.title || target.title}"`);
    setUndo(null);
    await refresh(query);
    setSelected(target.id);
  };

  const onDelete = async (doc: StoredDoc) => {
    if (!window.confirm(`Move "${doc.title}" to Deleted? You can restore it from the Deleted tab.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await deleteFile(doc.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || 'delete failed');
      return;
    }
    setNotice(`Moved "${doc.title}" to Deleted`);
    // JEV's ruling put the undo in BOTH places: here, one click from the action,
    // and in the Deleted tab for anyone who comes back later.
    setUndo({ id: doc.id, title: doc.title });
    await refresh(query);
  };

  /** Purge the stored bytes. The one delete here that cannot be undone. */
  const onPurge = async (doc: StoredDoc) => {
    if (
      !window.confirm(
        `Permanently delete "${doc.title}"? This purges the stored bytes and cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await deleteFile(doc.id, true);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || 'permanent delete failed');
      return;
    }
    setNotice(`Permanently deleted "${doc.title}"`);
    if (undo?.id === doc.id) setUndo(null);
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

          {/*
            Live / Deleted. A toggle rather than one merged list, because the two
            rows are not the same kind of thing: a deleted document can be
            restored or purged but not read, and mixing them into one list would
            invite a click on a row whose preview can never load.
          */}
          {deleted.length > 0 && (
            <div className="files-tabs">
              <button
                className={showDeleted ? 'files-tab' : 'files-tab active'}
                onClick={() => setShowDeleted(false)}
              >
                Library ({docs.length})
              </button>
              <button
                className={showDeleted ? 'files-tab active' : 'files-tab'}
                onClick={() => setShowDeleted(true)}
              >
                Deleted ({deleted.length})
              </button>
            </div>
          )}

          {notice && (
            <div className="files-notice">
              <span>{notice}</span>
              {undo && (
                <button
                  className="link-btn"
                  onClick={() => void onRestore(undo)}
                  disabled={busy}
                  title={`Restore "${undo.title}"`}
                >
                  Undo
                </button>
              )}
            </div>
          )}
          {error && <div className="files-error">{error}</div>}

          {showDeleted ? (
            <ul className="agent-list files-list">
              {deleted.map((d) => (
                <li key={d.id} className="files-row-deleted">
                  <span className="agent-name" title={d.title || 'Untitled'}>
                    {d.title || 'Untitled'}
                  </span>
                  <span className="agent-meta">
                    {d.agent || 'unknown'} · {sizeLabel(d.size)}
                    {d.deletedAt ? ` · deleted ${whenLabel(d.deletedAt)}` : ''}
                  </span>
                  {/*
                    NOT a button wrapping another button: the row itself is not
                    clickable here, because selecting a deleted document has
                    nothing to preview — its body endpoint answers 404.
                  */}
                  <span className="files-row-actions">
                    <button
                      className="primary"
                      onClick={() => void onRestore(d)}
                      disabled={busy}
                      title="Put this document back in the library"
                    >
                      Restore
                    </button>
                    <button
                      className="icon-btn danger"
                      onClick={() => void onPurge(d)}
                      disabled={busy}
                      title="Purge the stored bytes — cannot be undone"
                      aria-label="Delete permanently"
                    >
                      🗑
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : docs.length === 0 ? (
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

          {/* Publishing from the Deleted tab would write into the library the
              wearer is not currently looking at, so the box belongs on the
              Library tab only. */}
          {!showDeleted && (
            <div className="docs-actions">
              <button className="primary" onClick={() => setDraftOpen((v) => !v)} disabled={!configured}>
                {draftOpen ? 'Cancel' : '+ New document'}
              </button>
            </div>
          )}

          {!showDeleted && draftOpen && (
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
          {showDeleted ? (
            /*
              A deleted document has no preview to show — its body endpoint
              answers 404 while it is flagged deleted — so the pane explains the
              two actions instead of pretending to render something. Saying WHY
              the frame is empty is the point: the row used to disappear with no
              trace at all, which is what made the delete feel irreversible.
            */
            <div className="empty files-deleted-note">
              <p>
                {deleted.length === 1
                  ? '1 document is deleted but not purged.'
                  : `${deleted.length} documents are deleted but not purged.`}
              </p>
              <p>
                A delete here only flags the document: its bytes stay on the gateway and its stored
                size is still counted. <strong>Restore</strong> puts it back in the library.
                <strong> Delete permanently</strong> purges the bytes and ends that document for
                good.
              </p>
              <p className="agent-meta">
                A document still appears here when Jarvis or the glasses removed one, so a delete
                made anywhere in the app is visible and reversible in this one place.
              </p>
            </div>
          ) : !active ? (
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
                  {/*
                    Open the document OUTSIDE the pane, in a tab of its own.

                    An ANCHOR rather than a button calling `window.open`, for
                    three reasons: the browser only offers middle-click and
                    "open link in new tab" for a real link; `window.open` with
                    `noopener` returns null even on success, so a blocked-popup
                    check would cry wolf; and `rel="noopener"` is what denies
                    the opened document a `window.opener` handle back into this
                    app — the very reach the sandbox exists to deny.

                    The href is the SAME relay URL the frame loads, token
                    included, so it authenticates identically. A new tab is NOT
                    a way around the sandbox: the relay serves that response
                    under `Content-Security-Policy: sandbox allow-scripts`
                    whatever asks for it, so the document still runs with an
                    opaque origin. What it buys is a full-window read of a wide
                    report, instead of the 62vh letterbox the split allows.
                  */}
                  <a
                    className="icon-btn"
                    href={fileBodyUrl(active.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open this document in its own tab"
                    aria-label="Open this document in its own tab"
                  >
                    ↗
                  </a>
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
                The videos in this document, if it has any.

                They are played HERE, above the document, rather than inside it
                — and that is not a stylistic choice. The document's own embeds
                cannot work: the frame is served under
                `Content-Security-Policy: sandbox allow-scripts`, which carries
                no `frame-src` (so a nested YouTube frame falls back to
                `default-src 'none'` and is refused) and, deliberately, no
                `allow-same-origin` (so the nested document gets an opaque
                origin and YouTube's player will not initialise — it needs
                cookies, storage and postMessage). Measured live, in both
                directions. Granting `allow-same-origin` is the one thing this
                page must not do, because that is what would make a
                model-authored document same-origin with this app.

                So these thumbnails and the player below them are ordinary
                elements of THIS document, on this origin, loading YouTube's own
                origin in a plain cross-origin frame. The sandboxed document is
                untouched by any of it and never sees this list.
              */}
              {media.length > 0 && (
                <div className="files-media">
                  <span className="agent-meta">
                    {media.length === 1
                      ? '1 video in this document'
                      : `${media.length} videos in this document`}
                  </span>
                  <ul className="files-media-strip">
                    {media.map((v) => (
                      <li key={`${v.provider}:${v.id}`}>
                        <button
                          className={
                            playing?.id === v.id
                              ? 'files-media-thumb active'
                              : 'files-media-thumb'
                          }
                          onClick={() => setPlaying(playing?.id === v.id ? null : v)}
                          title={`${playing?.id === v.id ? 'Close' : 'Play'} ${v.label} ${v.id}`}
                          aria-label={`${playing?.id === v.id ? 'Close' : 'Play'} ${v.label} video`}
                          aria-pressed={playing?.id === v.id}
                        >
                          <img src={v.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          <span className="files-media-play" aria-hidden="true">
                            {playing?.id === v.id ? '■' : '▶'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/*
                `sandbox="allow-scripts"` and NOTHING else. No `allow-same-origin`
                means the frame runs with an opaque origin, so a generated document
                cannot read this app's DOM, its storage or its session token — and
                `allow-scripts` is kept so inline charts still work. This matches
                the relay's own `Content-Security-Policy: sandbox allow-scripts`;
                the two are belt and braces, and neither one alone is relied on.

                While a video is open this frame is REPLACED rather than stacked
                under it: the pane is a letterbox already, and a 16:9 player above
                a 62vh document would leave neither one usable.
              */}
              {playing ? (
                <div className="files-player">
                  <iframe
                    key={`${playing.provider}:${playing.id}`}
                    className="files-player-frame"
                    title={`${playing.label} video ${playing.id}`}
                    src={playing.embed}
                    /*
                      NO `sandbox` here, and that is deliberate — it is the whole
                      reason this works. This frame is YouTube's OWN content on
                      YouTube's own origin, not model-authored code on ours, so it
                      needs the ordinary privileges a player requires:
                      `allow-same-origin` keeps it on youtube-nocookie.com rather
                      than an opaque origin (it is still not THIS origin, which is
                      what would matter), and `allow-presentation` lets it go
                      fullscreen. Sandboxing it the way the document is sandboxed
                      is exactly what produced a blank box in testing.
                    */
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    referrerPolicy="strict-origin-when-cross-origin"
                    allowFullScreen
                  />
                  <div className="files-player-bar">
                    <span className="agent-meta">
                      {playing.label} · {playing.id}
                    </span>
                    <a
                      className="link-btn"
                      href={playing.watch}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Watch on {playing.label} ↗
                    </a>
                    <button
                      className="icon-btn"
                      onClick={() => setPlaying(null)}
                      title="Close the video and show the document"
                      aria-label="Close the video and show the document"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <iframe
                  key={`${active.id}:${frameKey}`}
                  className="files-frame"
                  title={active.title || 'Document preview'}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  src={fileBodyUrl(active.id)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
