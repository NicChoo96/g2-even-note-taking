import { useEffect, useSyncExternalStore, useState } from 'react';
import { categorize } from './categorize';
import { useAuth } from './auth';
import { MicButton } from './Dictate';
import { AgentsPanel } from './AgentsPanel';
import { AiPanel } from './AiPanel';
import { SettingsPanel } from './SettingsPanel';
import { consumeWebTab, getAi, subscribeAi } from '../ai';
import { getConnStatus, getState, subscribe, subscribeConn, update } from '../store';
import type { ConnStatus } from '../store';
import type { HubState, SectionId, TodoItem } from '../types';
import { activeDoc, emptyDoc, uid, upsertDoc } from '../types';

const SECTION_LABELS: Record<SectionId, string> = {
  todo: 'To-Do',
  docs: 'Docs',
  notes: 'Notes',
  agents: 'Agents',
};

/** Local tabs — Settings is browser-only and never becomes the glasses section. */
type Tab = SectionId | 'settings' | 'jarvis';

// Jarvis sits just before Settings: it is an AI surface over the whole app
// rather than a fifth glasses page, so it groups with the "meta" tab.
const TAB_ORDER: Tab[] = ['todo', 'docs', 'notes', 'agents', 'jarvis', 'settings'];

function tabLabel(id: Tab): string {
  if (id === 'settings') return 'Settings';
  if (id === 'jarvis') return 'Jarvis';
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
    update((s) => {
      const docText = result.docs;
      let docs = s.sections.docs;
      let activeDocId = s.activeDocId;
      let activeSection = s.activeSection;
      if (docText) {
        const cur = activeDoc(s);
        if (cur) {
          // Append the pasted text to the currently-open doc.
          docs = docs.map((d) =>
            d.id === cur.id
              ? {
                  ...d,
                  content: d.content ? `${d.content}\n${docText}` : docText,
                  updatedAt: Date.now(),
                }
              : d,
          );
        } else {
          // No doc yet — start one from the paste.
          const firstLine = docText.split('\n')[0].trim().slice(0, 40) || 'Untitled';
          const doc = emptyDoc(firstLine);
          docs = [...docs, { ...doc, content: docText }];
          activeDocId = doc.id;
          activeSection = 'docs';
        }
      }
      const notes = result.notes
        ? s.sections.notes
          ? `${s.sections.notes}\n${result.notes}`
          : result.notes
        : s.sections.notes;
      return {
        ...s,
        activeSection,
        activeDocId,
        sections: { todo: result.todo, docs, notes },
      };
    });
    setPaste('');
  };

  const addTask = () => {
    const text = newTask.trim();
    if (!text) return;
    const item: TodoItem = { id: uid(), text, done: false };
    update((s) => ({ ...s, sections: { ...s.sections, todo: [...s.sections.todo, item] } }));
    setNewTask('');
  };

  const toggleTask = (id: string) => {
    update((s) => ({
      ...s,
      sections: {
        ...s.sections,
        todo: s.sections.todo.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
      },
    }));
  };

  const editTask = (id: string, text: string) => {
    update((s) => ({
      ...s,
      sections: {
        ...s.sections,
        todo: s.sections.todo.map((t) => (t.id === id ? { ...t, text } : t)),
      },
    }));
  };

  const removeTask = (id: string) => {
    update((s) => ({
      ...s,
      sections: { ...s.sections, todo: s.sections.todo.filter((t) => t.id !== id) },
    }));
  };

  // ── Docs library (multiple named docs, auto-saved + synced across devices) ─
  const docs = state.sections.docs;
  const active = activeDoc(state);

  const selectDoc = (id: string) => {
    update((s) => ({ ...s, activeDocId: id }));
  };

  const createDoc = () => {
    const doc = emptyDoc('Untitled');
    update((s) => {
      const { docs: ds, activeDocId } = upsertDoc(s, doc);
      return { ...s, activeSection: 'docs', activeDocId, sections: { ...s.sections, docs: ds } };
    });
  };

  const renameActiveDoc = (title: string) => {
    const id = active?.id;
    if (!id) return;
    update((s) => ({
      ...s,
      sections: {
        ...s.sections,
        docs: s.sections.docs.map((d) =>
          d.id === id ? { ...d, title, updatedAt: Date.now() } : d,
        ),
      },
    }));
  };

  const setActiveDocContent = (content: string) => {
    const id = active?.id;
    if (!id) return;
    update((s) => ({
      ...s,
      sections: {
        ...s.sections,
        docs: s.sections.docs.map((d) =>
          d.id === id ? { ...d, content, updatedAt: Date.now() } : d,
        ),
      },
    }));
  };

  const deleteDoc = (id: string) => {
    if (!window.confirm('Delete this doc? This syncs to all your devices.')) return;
    update((s) => {
      const remaining = s.sections.docs.filter((d) => d.id !== id);
      return {
        ...s,
        sections: { ...s.sections, docs: remaining },
        activeDocId:
          remaining.length > 0 ? (s.activeDocId === id ? remaining[0].id : s.activeDocId) : null,
      };
    });
  };

  const setNotes = (text: string) => {
    update((s) => ({ ...s, sections: { ...s.sections, notes: text } }));
  };

  const appendPaste = (text: string) => {
    setPaste((p) => (p.trim() ? `${p.replace(/\s+$/, '')}\n${text}` : text));
  };

  const appendTask = (text: string) => {
    setNewTask((t) => (t.trim() ? `${t.replace(/\s+$/, ' ')}${text}` : text));
  };

  const appendToActiveDoc = (text: string) => {
    const id = active?.id;
    if (!id) return;
    update((s) => ({
      ...s,
      sections: {
        ...s.sections,
        docs: s.sections.docs.map((d) =>
          d.id === id
            ? { ...d, content: d.content ? `${d.content.replace(/\s+$/, '')}\n${text}` : text, updatedAt: Date.now() }
            : d,
        ),
      },
    }));
  };

  const appendToNotes = (text: string) => {
    update((s) => ({
      ...s,
      sections: {
        ...s.sections,
        notes: s.sections.notes ? `${s.sections.notes.replace(/\s+$/, '')}\n${text}` : text,
      },
    }));
  };

  const switchSection = (section: SectionId) => {
    setTab(null); // a real section clears the local Settings override
    update((s) => ({ ...s, activeSection: section }));
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
    // editor) and Jarvis (live timeline + action catalog). The 760px reading
    // width that suits notes/docs would squeeze both.
    <div className={`app${activeTab === 'agents' || activeTab === 'jarvis' ? ' app-wide' : ''}`}>
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
              // Settings and Jarvis are companion-only tabs: they never change
              // the glasses section, because neither is a G2 page.
              id === 'settings' || id === 'jarvis' ? setTab(id) : switchSection(id)
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

        {activeTab === 'jarvis' && <AiPanel />}

        {activeTab === 'agents' && <AgentsPanel />}

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
