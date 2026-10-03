import { useEffect, useSyncExternalStore, useState } from 'react';
import { categorize } from './categorize';
import { useAuth } from './auth';
import { MicButton } from './Dictate';
import { AgentsPanel } from './AgentsPanel';
import { AiPanel } from './AiPanel';
import { FilesPanel } from './FilesPanel';
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
  setTasks,
  subscribe,
  subscribeConn,
} from '../store';
import type { ConnStatus } from '../store';
import { activeDoc, type HubState, type SectionId } from '../types';

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
type Tab = SectionId | 'settings' | 'jarvis' | 'export';

// Agents leads: it is the page the switcher offers first on the glasses, so the
// web tabs keep the same order. Jarvis sits just before Settings: it is an AI
// surface over the whole app rather than a fifth glasses page, so it groups with
// the "meta" tab. Export trails Settings: it is the one page that looks at the
// data instead of changing it, so it does not sit among the working tabs.
const TAB_ORDER: Tab[] = ['agents', 'todo', 'docs', 'files', 'notes', 'jarvis', 'settings', 'export'];

function tabLabel(id: Tab): string {
  if (id === 'settings') return 'Settings';
  if (id === 'jarvis') return 'Jarvis';
  if (id === 'export') return 'Export';
  return SECTION_LABELS[id];
}

function useHubState(): HubState {
  return useSyncExternalStore(subscribe, getState);
}

function useConn(): ConnStatus {
  return useSyncExternalStore(subscribeConn, getConnStatus);
}

export default function App() {
  const state = useHubState();
  const conn = useConn();
  const { authed, email, inEvenApp, signOut } = useAuth();
  const [paste, setPaste] = useState('');
  const [detected, setDetected] = useState<SectionId[]>([]);
  const [newTask, setNewTask] = useState('');
  /** Local tab override — lets Settings show without changing the glasses section. */
  const [tab, setTab] = useState<Tab | null>(null);
  const activeTab: Tab = tab ?? state.activeSection;

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

  const handleCategorize = () => {
    if (!paste.trim()) return;
    const result = categorize(paste, state.sections.todo);
    setDetected(result.detected);
    // Each part is its own hub write, because the hub takes ONE collection per
    // route — there is no "apply this whole state" endpoint any more. The doc
    // append is a read-modify-write against the body the panel already holds.
    if (result.docs) {
      const cur = activeDoc(state);
      if (cur) appendDoc(cur.id, result.docs);
      else addDoc(result.docs.split('\n')[0].trim().slice(0, 40) || 'Untitled', result.docs);
    }
    if (result.notes) appendNote(result.notes);
    setTasks(result.todo);
    setPaste('');
  };

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

  const setNotes = (text: string) => storeSetNotes(text);

  const appendPaste = (text: string) => {
    setPaste((p) => (p.trim() ? `${p.replace(/\s+$/, '')}\n${text}` : text));
  };

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
    // editor), Jarvis (live timeline + action catalog) and Files (document list
    // + sandboxed preview). The 760px reading width that suits notes/docs would
    // squeeze all three.
    <div
      className={`app${
        activeTab === 'agents' || activeTab === 'jarvis' || activeTab === 'files' ? ' app-wide' : ''
      }`}
    >
      <header className="app-header">
        <div>
          <h1>🥽 G2 Even Reality Hub</h1>
          <p className="tagline">Paste once → stream live into your glasses → control with the R1 ring.</p>
        </div>
        <div className={`sync-chip ${chip.cls}`} title="Stream status">
          <span className="dot" />
          {chip.label}
          {state.updatedAt ? ` · ${new Date(state.updatedAt).toLocaleTimeString()}` : ''}
        </div>
        {authed && (
          <div className="sync-chip" title="Signed-in account">
            <span>👤 {email}</span>
            <button className="icon-btn" onClick={signOut} aria-label="Sign out">⏻</button>
          </div>
        )}
        {inEvenApp && <div className="sync-chip">Even App mode</div>}
      </header>

      <section className="paste-panel card">
        <div className="field-toolbar">
          <MicButton onText={appendPaste} hint="Speak → text lands in the box below" />
        </div>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={'Paste anything — notes, docs, tasks, meeting minutes…\n\n' +
            'Auto-sort hints:\n  • "- Do the dishes" or "todo: fix bug"  → To-Do\n  • "note: call mom" or "@idea"            → Notes\n  • anything else                          → Docs'}
          rows={7}
        />
        <div className="paste-actions">
          <div className="detected-tags">
            {detected.map((d) => (
              <span key={d} className="tag">
                → {SECTION_LABELS[d]}
              </span>
            ))}
          </div>
          <button className="primary" onClick={handleCategorize} disabled={!paste.trim()}>
            Categorize & Send
          </button>
        </div>
      </section>

      <nav className="tabs" role="tablist">
        {TAB_ORDER.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            className={activeTab === id ? 'tab active' : 'tab'}
            onClick={() =>
              // Settings, Jarvis and Export are companion-only tabs: they never
              // change the glasses section, because none of them is a G2 page.
              id === 'settings' || id === 'jarvis' || id === 'export'
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

        {activeTab === 'files' && <FilesPanel />}

        {activeTab === 'todo' && (
          <div className="todo-panel">
            <div className="todo-summary">
              <span>
                {doneCount} done · {pending} pending
              </span>
            </div>
            <ul className="todo-list">
              {state.sections.todo.length === 0 && (
                <li className="empty">No tasks yet — paste some or add one below.</li>
              )}
              {state.sections.todo.map((t) => (
                <li key={t.id} className={t.done ? 'todo-item done' : 'todo-item'}>
                  <button
                    className="check"
                    onClick={() => toggleTask(t.id)}
                    aria-label={t.done ? 'Mark not done' : 'Mark done'}
                  >
                    {t.done ? '✓' : ''}
                  </button>
                  <input
                    className="todo-text"
                    value={t.text}
                    onChange={(e) => editTask(t.id, e.target.value)}
                    placeholder="Task…"
                  />
                  <button className="icon-btn danger" onClick={() => removeTask(t.id)} aria-label="Remove task">
                    ✕
                  </button>
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
          <div className="docs-manager">
            <div className="panel-label">
              Docs library · auto-saved to storage & synced to all your devices
            </div>

            {docs.length === 0 ? (
              <div className="empty">No docs yet — create one to start writing.</div>
            ) : (
              <>
                <div className="doc-tabs" role="tablist" aria-label="Documents">
                  {docs.map((d) => (
                    <button
                      key={d.id}
                      role="tab"
                      aria-selected={active?.id === d.id}
                      className={active?.id === d.id ? 'doc-chip active' : 'doc-chip'}
                      onClick={() => selectDoc(d.id)}
                      title={d.title || '(untitled)'}
                    >
                      {d.title || '(untitled)'}
                    </button>
                  ))}
                </div>

                {active && (
                  <div className="doc-title-row">
                    <input
                      className="doc-title-input"
                      value={active.title}
                      onChange={(e) => renameActiveDoc(e.target.value)}
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
                )}

                <div className="field-toolbar">
                  <MicButton onText={appendToActiveDoc} hint="Speak → appends to this doc" />
                </div>
                <textarea
                  className="doc-textarea"
                  value={active?.content ?? ''}
                  onChange={(e) => setActiveDocContent(e.target.value)}
                  placeholder="Start writing… saved automatically and streamed live to your glasses."
                />
              </>
            )}

            <div className="docs-actions">
              <button className="primary" onClick={createDoc}>
                + New doc
              </button>
            </div>
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
              value={state.sections.notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Quick notes / memos. Edits stream live to the glasses."
            />
          </div>
        )}
      </main>

      <footer className="app-footer">
        <span>Same URL drives the web UI and the glasses · edits broadcast live</span>
        <span>R1 ring: swipe = move · single press = toggle · double-press = exit</span>
      </footer>
    </div>
  );
}
