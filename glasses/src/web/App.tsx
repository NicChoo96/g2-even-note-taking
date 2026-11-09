import { useEffect, useSyncExternalStore, useState } from 'react';
import { useAuth } from './auth';
import { MicButton } from './Dictate';
import { AgentsPanel } from './AgentsPanel';
import { AiPanel } from './AiPanel';
import { FilesPanel } from './FilesPanel';
import { AgentSchedule } from './SchedulePanel';
import { DataPanel } from './DataPanel';
import { ExportPanel } from './ExportPanel';
import { SettingsPanel } from './SettingsPanel';
import { consumeWebTab, getAi, subscribeAi } from '../ai';
import {
  addDoc,
  addTask as storeAddTask,
  appendDoc,
  appendNote,
  getConnStatus,
  getState,
  removeDoc,
  removeTask as storeRemoveTask,
  selectDoc as storeSelectDoc,
  selectSection as storeSelectSection,
  setDocContent,
  setDocTitle,
  setNotes as storeSetNotes,
  setTaskDone,
  setTaskText,
  subscribe,
  subscribeConn,
} from '../store';
import type { ConnStatus } from '../store';
import { activeDoc, type HubState, type SectionId } from '../types';
import { bootCount, loadDeviceSession } from '../durable-docs';
import { docWords, filterDocs, orderDocs, whenLabel } from './doc-list';
import { useRemoteDraft } from './draft';
import { ThemeToggle } from './ThemeToggle';
import { SelectionBar } from './SelectionBar';
import {
  allSelected,
  confirmBulk,
  describeBulk,
  keepExisting,
  selectAll,
  toggleId,
} from './selection';

const SECTION_LABELS: Record<SectionId, string> = {
  todo: 'To-Do',
  docs: 'Docs',
  files: 'Files',
  notes: 'Notes',
  agents: 'Agents',
};

/**
 * Local tabs — Settings, Jarvis and Export are browser-only and never become the
 * glasses section. There is no G2 page for any of them.
 */
type Tab = SectionId | 'settings' | 'jarvis' | 'export' | 'schedule' | 'data';

// Agents leads: it is the page the switcher offers first on the glasses, so the
// web tabs keep the same order. Jarvis sits just before Settings: it is an AI
// surface over the whole app rather than a fifth glasses page, so it groups with
// the "meta" tab. Export trails Settings: it is the one page that looks at the
// data instead of changing it, so it does not sit among the working tabs.
const TAB_ORDER: Tab[] = [
  'agents',
  'schedule',
  'data',
  'todo',
  'docs',
  'files',
  'notes',
  'jarvis',
  'settings',
  'export',
];

function tabLabel(id: Tab): string {
  if (id === 'settings') return 'Settings';
  if (id === 'jarvis') return 'Jarvis';
  if (id === 'export') return 'Export';
  // Its own tab, not a card inside Agents: a clock you cannot find is a clock
  // that does not exist, and this one was buried under the agent editor.
  if (id === 'schedule') return 'Schedule';
  // The numbers a schedule collects live next to the clock that collects them.
  if (id === 'data') return 'Data';
  return SECTION_LABELS[id];
}

function useHubState(): HubState {
  return useSyncExternalStore(subscribe, getState);
}

/**
 * One to-do's text, drafted locally.
 *
 * A `/todos` nudge re-reads the whole list, so a row bound straight to hub state
 * loses whatever was typed since the last debounce — the "it eats my letters"
 * half of the twitch. The row owns its text while focused and adopts the hub's
 * value again once it is not.
 */
function TodoText({ id, text, onCommit, readOnly }: {
  id: string;
  text: string;
  onCommit: (id: string, text: string) => void;
  readOnly: boolean;
}) {
  const draft = useRemoteDraft(text, (v) => onCommit(id, v));
  return (
    <input
      className="todo-text"
      value={draft.value}
      onChange={draft.onChange}
      onFocus={draft.onFocus}
      onBlur={draft.onBlur}
      placeholder="Task…"
      readOnly={readOnly}
    />
  );
}

function useConn(): ConnStatus {
  return useSyncExternalStore(subscribeConn, getConnStatus);
}

export default function App() {
  const state = useHubState();
  const conn = useConn();
  const { authed, email, inEvenApp, signOut } = useAuth();
  const [newTask, setNewTask] = useState('');
  // Filter for the Docs master list. Kept here rather than in the store: it is a
  // view of the list, not a property of the library, so it must not sync to the
  // glasses or to another device.
  const [docQuery, setDocQuery] = useState('');
  /** Local tab override — lets Settings show without changing the glasses section. */
  const [tab, setTab] = useState<Tab | null>(null);
  const activeTab: Tab = tab ?? state.activeSection;

  /**
   * Multi-select, shared by the Todo and Docs tabs.
   *
   * `picking` is which tab is in selection mode, not a boolean: switching tabs
   * must not leave a stale selection armed on the other list, and doing it this
   * way makes that impossible rather than remembered.
   */
  const [picking, setPicking] = useState<'todo' | 'docs' | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  /** The line shown after a bulk delete. Empty means nothing happened yet. */
  const [bulkNote, setBulkNote] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const stopPicking = () => {
    setPicking(null);
    setPicked([]);
  };

  const pick = (id: string) => setPicked((ids) => toggleId(ids, id));

  // A live dot on the Jarvis tab, so an agent run started from the glasses or
  // from a confirmation prompt is visible without hunting for it.
  const ai = useSyncExternalStore(subscribeAi, getAi);
  const aiLive = ai.status === 'running' || ai.status === 'confirm';

  // The agent can ask the browser to show something (`nav.open_page`,
  // `settings.open`). Those come through as a one-shot request rather than a
  // subscription, so consume it and clear it — otherwise the user could never
  // navigate away from a page the AI opened.
  const requested = ai.webTab;
  useEffect(() => {
    if (!requested) return;
    consumeWebTab();
    // Guard the cast: a typo'd page name must not blank the content area.
    if (TAB_ORDER.includes(requested as Tab)) setTab(requested as Tab);
  }, [requested]);

  const addTask = () => {
    const text = newTask.trim();
    if (!text) return;
    storeAddTask(text);
    setNewTask('');
  };

  const toggleTask = (id: string) => {
    const item = state.sections.todo.find((t) => t.id === id);
    setTaskDone(id, !item?.done);
  };

  const editTask = (id: string, text: string) => setTaskText(id, text);

  const removeTask = (id: string) => storeRemoveTask(id);

  // ── Docs library (multiple named docs, auto-saved + synced through the hub) ─
  const docs = state.sections.docs;
  const active = activeDoc(state);

  /**
   * Where the open doc sat in the list when it was opened.
   *
   * Every keystroke in the body bumps `updatedAt`, and the list is "newest
   * first" — so without this the row you are writing into climbs to the top while
   * you type and the list appears to shuffle itself. Pinned, it stays where you
   * left it; the rest of the list is still live. Set during render (React's
   * documented adjust-on-prop-change pattern) so the very first paint of a newly
   * opened doc already uses the right stamp.
   */
  const [docPin, setDocPin] = useState<{ id: string; at: number } | null>(null);
  if (active && docPin?.id !== active.id) {
    setDocPin({ id: active.id, at: Number(active.updatedAt ?? 0) });
  } else if (!active && docPin) {
    setDocPin(null);
  }

  /**
   * Newest first, and filterable by title or body — both rules live in
   * ./doc-list so a harness can drive them without a React tree.
   */
  const orderedDocs = orderDocs(docs, docPin);
  const visibleDocs = filterDocs(orderedDocs, docQuery);

  /**
   * What the DURABLE store actually holds, read once per mount.
   *
   * Read from the bridge first (see durable-docs.ts), so this is the same value
   * the package would see after a restart — not the WebView's own localStorage,
   * which is the thing being compared against.
   */
  const [storage, setStorage] = useState<{ boots: number; device: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [boots, deviceId] = await Promise.all([bootCount(), loadDeviceSession()]);
      if (alive) setStorage({ boots, device: deviceId ? deviceId.slice(0, 8) : '' });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const selectDoc = (id: string) => storeSelectDoc(id);

  const createDoc = () => addDoc('Untitled');
  const renameActiveDoc = (title: string) => {
    const id = active?.id;
    if (id) setDocTitle(id, title);
  };

  const setActiveDocContent = (content: string) => {
    const id = active?.id;
    if (id) setDocContent(id, content);
  };

  const deleteDoc = (id: string) => {
    if (!window.confirm('Delete this doc? This removes it for every device.')) return;
    removeDoc(id);
  };

  /**
   * Bulk delete for the To-Do list.
   *
   * Sequential, not `Promise.all`: each delete is a hub write, and firing twelve
   * at once is how a rate limit turns into "some of them went". Sequential also
   * lets the summary tell the truth about which ones did not.
   */
  const bulkDeleteTodos = async () => {
    const ids = keepExisting(picked, state.sections.todo.map((t) => t.id));
    if (!ids.length) return;
    if (
      !window.confirm(
        confirmBulk('task', ids.length, 'This removes them on every device, not just here.'),
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setBulkNote('');
    const failed: Array<{ what: string; error?: string }> = [];
    let ok = 0;
    for (const id of ids) {
      const label = state.sections.todo.find((t) => t.id === id)?.text ?? id;
      const res = await storeRemoveTask(id);
      if (res?.ok === false) failed.push({ what: label.slice(0, 40), error: res.error });
      else ok += 1;
    }
    setBulkBusy(false);
    setBulkNote(describeBulk('Deleted', ok, failed));
    stopPicking();
  };

  /**
   * Bulk delete for the Docs library.
   *
   * `removeDoc` removes it locally and pushes the delete on its own, surfacing a
   * hub refusal in the sync banner — so there is no per-item result to collect
   * here, and the note says what actually happened on this device.
   */
  const bulkDeleteDocs = () => {
    const ids = keepExisting(picked, docs.map((d) => d.id));
    if (!ids.length) return;
    if (
      !window.confirm(confirmBulk('doc', ids.length, 'This removes them on every device, not just here.'))
    ) {
      return;
    }
    for (const id of ids) removeDoc(id);
    setBulkNote(describeBulk('Removed', ids.length, []));
    stopPicking();
  };

  const setNotes = (text: string) => storeSetNotes(text);

  const appendTask = (text: string) => {
    setNewTask((t) => (t.trim() ? `${t.replace(/\s+$/, ' ')}${text}` : text));
  };

  const appendToActiveDoc = (text: string) => {
    const id = active?.id;
    if (id) appendDoc(id, text);
  };

  const appendToNotes = (text: string) => appendNote(text);

  const switchSection = (section: SectionId) => {
    setTab(null); // a real section clears the local Settings override
    storeSelectSection(section);
  };

  // The editors below are fed by the hub, so a peer nudge or a stale-rev refresh
  // can hand them a copy that is one debounce behind the caret. `useRemoteDraft`
  // holds the typed text while the field has focus and adopts the server's value
  // again once it does not — see ./draft.
  const docTitle = useRemoteDraft(active?.title ?? '', renameActiveDoc);
  const docBody = useRemoteDraft(active?.content ?? '', setActiveDocContent);
  const notesDraft = useRemoteDraft(state.sections.notes, setNotes);

  const pending = state.sections.todo.filter((t) => !t.done).length;
  const doneCount = state.sections.todo.length - pending;
  const chip =
    conn === 'open'
      ? { cls: 'synced', label: 'Live' }
      : conn === 'connecting'
        ? { cls: 'pushing', label: 'Syncing…' }
        : conn === 'error'
          ? { cls: 'offline', label: 'Offline' }
          : { cls: '', label: 'Ready' };

  return (
    // `app-wide` widens the shell for the two-pane tabs: Agents (master list +
    // editor), Jarvis (live timeline + action catalog), Files (document list +
    // sandboxed preview) and now Docs (library + editor). The 760px reading
    // width that suits notes would squeeze all four.
    <div
      className={`app${
        activeTab === 'agents' || activeTab === 'jarvis' || activeTab === 'files' || activeTab === 'docs'
          ? ' app-wide'
          : ''
      }`}
    >
      <header className="app-header">
        <div className="brand">
          <h1>Reality Hub</h1>
          <p className="tagline">Ask Jarvis, or edit any page — it streams live to your glasses.</p>
        </div>
        <div className="header-actions">
          <div className={`sync-chip ${chip.cls}`} title="Stream status">
            <span className="dot" />
            {chip.label}
            {state.updatedAt ? ` · ${new Date(state.updatedAt).toLocaleTimeString()}` : ''}
          </div>
          {authed && (
            <div className="sync-chip" title="Signed-in account">
              <span className="account-email">{email}</span>
              <button className="icon-btn" onClick={signOut} aria-label="Sign out">
                ⏻
              </button>
            </div>
          )}
          {inEvenApp && <div className="sync-chip">Even App mode</div>}
          {/* The theme toggle belongs to the SHELL, not to Settings: it is a
              property of the whole surface, and a wearer flips it in the light
              they are standing in rather than in a configuration page. */}
          <ThemeToggle />
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {TAB_ORDER.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            className={activeTab === id ? 'tab active' : 'tab'}
            onClick={() =>
              // Settings, Jarvis, Export and Schedule are companion-only tabs:
              // they never change the glasses section, because none of them is a
              // G2 page.
              id === 'settings' || id === 'jarvis' || id === 'export' || id === 'schedule' || id === 'data'
                ? setTab(id)
                : switchSection(id)
            }
          >
            {tabLabel(id)}
            {id === 'jarvis' && aiLive && <span className="count">●</span>}
            {id === 'todo' && state.sections.todo.length > 0 && (
              <span className="count">
                {pending}/{state.sections.todo.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="content card">
        {activeTab === 'settings' && <SettingsPanel />}

        {activeTab === 'export' && <ExportPanel />}

        {activeTab === 'jarvis' && <AiPanel />}

        {activeTab === 'agents' && <AgentsPanel />}

        {activeTab === 'schedule' && (
          <div className="schedule-panel">
            <div className="panel-label">
              Scheduled runs · the clock lives on the relay, so they fire with every app closed
            </div>
            <AgentSchedule />
          </div>
        )}

        {activeTab === 'data' && <DataPanel />}

        {activeTab === 'files' && <FilesPanel />}

        {activeTab === 'todo' && (
          <div className="todo-panel">
            <div className="todo-summary">
              <span>
                {doneCount} done · {pending} pending
              </span>
              {state.sections.todo.length > 0 && (
                <button
                  onClick={() => {
                    if (picking === 'todo') stopPicking();
                    else {
                      setPicked([]);
                      setPicking('todo');
                    }
                  }}
                >
                  {picking === 'todo' ? 'Done' : 'Select'}
                </button>
              )}
            </div>
            {bulkNote && <p className="hint-line">{bulkNote}</p>}
            <SelectionBar
              picking={picking === 'todo'}
              count={picked.length}
              total={state.sections.todo.length}
              allSelected={allSelected(picked, state.sections.todo.map((t) => t.id))}
              busy={bulkBusy}
              deleteLabel="Delete"
              onAll={() => setPicked(selectAll(picked, state.sections.todo.map((t) => t.id)))}
              onClear={() => setPicked([])}
              onDelete={() => void bulkDeleteTodos()}
              onCancel={stopPicking}
            />
            <ul className="todo-list">
              {state.sections.todo.length === 0 && (
                <li className="empty">No tasks yet — add one below, or ask Jarvis.</li>
              )}
              {state.sections.todo.map((t) => (
                <li
                  key={t.id}
                  className={
                    (t.done ? 'todo-item done' : 'todo-item') +
                    (picking === 'todo' && picked.includes(t.id) ? ' picked' : '')
                  }
                >
                  {picking === 'todo' ? (
                    <input
                      type="checkbox"
                      className="pick-box"
                      checked={picked.includes(t.id)}
                      onChange={() => pick(t.id)}
                      aria-label={`Select ${t.text || 'task'}`}
                    />
                  ) : (
                    <button
                      className="check"
                      onClick={() => toggleTask(t.id)}
                      aria-label={t.done ? 'Mark not done' : 'Mark done'}
                    >
                      {t.done ? '✓' : ''}
                    </button>
                  )}
                  <TodoText
                    id={t.id}
                    text={t.text}
                    onCommit={editTask}
                    readOnly={picking === 'todo'}
                  />
                  {picking !== 'todo' && (
                    <button className="icon-btn danger" onClick={() => removeTask(t.id)} aria-label="Remove task">
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="todo-add">
              <MicButton compact onText={appendTask} title="Dictate a task" />
              <input
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTask()}
                placeholder="Add a task and press Enter…"
              />
              <button className="primary" onClick={addTask} disabled={!newTask.trim()}>
                Add
              </button>
            </div>
          </div>
        )}

        {activeTab === 'docs' && (
          <div className="docs-panel">
            <div className="panel-label">
              Docs library · newest first · auto-saved to storage & synced to all your devices
            </div>

            {bulkNote && <p className="hint-line">{bulkNote}</p>}
            <SelectionBar
              picking={picking === 'docs'}
              count={picked.length}
              total={visibleDocs.length}
              allSelected={allSelected(picked, visibleDocs.map((d) => d.id))}
              busy={bulkBusy}
              deleteLabel="Delete"
              onAll={() => setPicked(selectAll(picked, visibleDocs.map((d) => d.id)))}
              onClear={() => setPicked([])}
              onDelete={bulkDeleteDocs}
              onCancel={stopPicking}
            />

            {docs.length === 0 ? (
              <div className="empty">No docs yet — create one to start writing.</div>
            ) : (
              <div className="docs-split">
                {/* ── master: the whole library, newest first ─────────────── */}
                <div className="docs-master">
                  <input
                    className="docs-filter"
                    value={docQuery}
                    onChange={(e) => setDocQuery(e.target.value)}
                    placeholder="Filter by title or text…"
                    aria-label="Filter docs"
                  />
                  {docs.length > 1 && (
                    <div className="field-toolbar">
                      <button
                        onClick={() => {
                          if (picking === 'docs') stopPicking();
                          else {
                            setPicked([]);
                            setPicking('docs');
                          }
                        }}
                      >
                        {picking === 'docs' ? 'Done selecting' : 'Select multiple'}
                      </button>
                    </div>
                  )}
                  <ul className="doc-list" aria-label="Documents">
                    {visibleDocs.length === 0 && (
                      <li className="empty">No doc matches “{docQuery.trim()}”.</li>
                    )}
                    {visibleDocs.map((d) => {
                      const words = docWords(d);
                      const isPicked = picked.includes(d.id);
                      return (
                        <li
                          key={d.id}
                          className={
                            (active?.id === d.id && picking !== 'docs' ? 'doc-row active' : 'doc-row') +
                            (isPicked ? ' picked' : '')
                          }
                        >
                          {picking === 'docs' && (
                            <input
                              type="checkbox"
                              className="pick-box"
                              checked={isPicked}
                              onChange={() => pick(d.id)}
                              aria-label={`Select ${d.title || 'doc'}`}
                            />
                          )}
                          <button
                            className="doc-pick"
                            onClick={() => (picking === 'docs' ? pick(d.id) : selectDoc(d.id))}
                          >
                            <span className="doc-name">{d.title || '(untitled)'}</span>
                            <span className="doc-meta">
                              {whenLabel(d.updatedAt)}
                              {words > 0 ? ` · ${words}w` : ' · empty'}
                            </span>
                          </button>
                          {picking !== 'docs' && (
                            <button
                              className="icon-btn danger"
                              onClick={() => deleteDoc(d.id)}
                              aria-label={`Delete ${d.title || 'doc'}`}
                              title="Delete doc"
                            >
                              ✕
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <button className="primary" onClick={createDoc}>
                    + New doc
                  </button>
                </div>

                {/* ── detail: the one doc you picked ──────────────────────── */}
                <div className="docs-detail">
                  {!active ? (
                    <p className="empty">Pick a doc on the left, or create one.</p>
                  ) : (
                    <>
                      <div className="doc-title-row">
                        <input
                          className="doc-title-input"
                          value={docTitle.value}
                          onChange={docTitle.onChange}
                          onFocus={docTitle.onFocus}
                          onBlur={docTitle.onBlur}
                          placeholder="Doc title…"
                        />
                        <button
                          className="icon-btn danger"
                          onClick={() => deleteDoc(active.id)}
                          aria-label="Delete doc"
                          title="Delete doc"
                        >
                          🗑
                        </button>
                      </div>
                      <p className="hint-line">
                        {whenLabel(active.updatedAt)} · {docWords(active)} words
                      </p>

                      <div className="field-toolbar">
                        <MicButton onText={appendToActiveDoc} hint="Speak → appends to this doc" />
                      </div>
                      <textarea
                        className="doc-textarea"
                        value={docBody.value}
                        onChange={docBody.onChange}
                        onFocus={docBody.onFocus}
                        onBlur={docBody.onBlur}
                        placeholder="Start writing… saved automatically and streamed live to your glasses."
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            {docs.length === 0 && (
              <div className="docs-actions">
                <button className="primary" onClick={createDoc}>
                  + New doc
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="text-panel">
            <div className="panel-label">Notes · double-sync with glasses</div>
            <div className="field-toolbar">
              <MicButton onText={appendToNotes} hint="Speak → appends to notes" />
            </div>
            <textarea
              className="doc-textarea"
              value={notesDraft.value}
              onChange={notesDraft.onChange}
              onFocus={notesDraft.onFocus}
              onBlur={notesDraft.onBlur}
              placeholder="Quick notes / memos. Edits stream live to the glasses."
            />
          </div>
        )}
      </main>

      <footer className="app-footer">
        <span>Same URL drives the web UI and the glasses · edits broadcast live</span>
        {/* THE PERSISTENCE MEASUREMENT. Two facts, both durable: how many times
            this install has launched, and the device id the pairing is keyed to.
            If both survive an .ehpk update, a package can carry its credential
            and there is nothing to re-enter. If the count resets to 1, it cannot,
            and the answer is a re-authentication flow rather than more storage.
            Small and always visible on purpose — this is the thing being tested. */}
        <span className="storage-note" title="Device storage that survives an app update">
          {storage ? `device storage · boot #${storage.boots} · ${storage.device || 'no device id'}` : 'device storage · …'}
        </span>
        <span>R1 ring: swipe = move · single press = toggle · double-press = exit</span>
      </footer>
    </div>
  );
}
