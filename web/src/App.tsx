import { useCallback, useEffect, useRef, useState } from 'react';
import { categorize } from './categorize';
import { publishState } from './stream';
import { loadState, saveState } from './store';
import type { HubState, SectionId, TodoItem } from './types';
import { uid } from './types';

const SECTION_LABELS: Record<SectionId, string> = {
  todo: 'To-Do',
  docs: 'Docs',
  notes: 'Notes',
};

type SyncState = 'idle' | 'pushing' | 'synced' | 'offline';

export default function App() {
  const [state, setState] = useState<HubState>(() => loadState());
  const [paste, setPaste] = useState('');
  const [detected, setDetected] = useState<SectionId[]>([]);
  const [newTask, setNewTask] = useState('');
  const [sync, setSync] = useState<SyncState>('idle');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const publishTimer = useRef<number | null>(null);

  // Mutate state, stamping updatedAt so the glasses can order frames.
  const mutate = useCallback((fn: (s: HubState) => HubState) => {
    setState((prev) => ({ ...fn(prev), updatedAt: Date.now() }));
  }, []);

  // Persist to localStorage + broadcast to the glasses on every change (debounced).
  useEffect(() => {
    saveState(state);
    setSync('pushing');
    if (publishTimer.current) window.clearTimeout(publishTimer.current);
    publishTimer.current = window.setTimeout(() => {
      void publishState(state).then((ok) => {
        setSync(ok ? 'synced' : 'offline');
        if (ok) setLastSync(Date.now());
      });
    }, 300);
    return () => {
      if (publishTimer.current) window.clearTimeout(publishTimer.current);
    };
  }, [state]);

  // Seed the hub with the stored state on first load (in case the server restarted).
  useEffect(() => {
    void publishState(loadState());
  }, []);

  const handleCategorize = () => {
    if (!paste.trim()) return;
    const result = categorize(paste, state.sections.todo);
    setDetected(result.detected);
    mutate((s) => ({
      ...s,
      sections: {
        todo: result.todo,
        docs: result.docs || s.sections.docs,
        notes: result.notes || s.sections.notes,
      },
    }));
    setPaste('');
  };

  const addTask = () => {
    const text = newTask.trim();
    if (!text) return;
    const item: TodoItem = { id: uid(), text, done: false };
    mutate((s) => ({ ...s, sections: { ...s.sections, todo: [...s.sections.todo, item] } }));
    setNewTask('');
  };

  const toggleTask = (id: string) => {
    mutate((s) => ({
      ...s,
      sections: {
        ...s.sections,
        todo: s.sections.todo.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
      },
    }));
  };

  const editTask = (id: string, text: string) => {
    mutate((s) => ({
      ...s,
      sections: {
        ...s.sections,
        todo: s.sections.todo.map((t) => (t.id === id ? { ...t, text } : t)),
      },
    }));
  };

  const removeTask = (id: string) => {
    mutate((s) => ({
      ...s,
      sections: { ...s.sections, todo: s.sections.todo.filter((t) => t.id !== id) },
    }));
  };

  const setTextSection = (section: 'docs' | 'notes', text: string) => {
    mutate((s) => ({ ...s, sections: { ...s.sections, [section]: text } }));
  };

  const switchSection = (section: SectionId) => {
    mutate((s) => ({ ...s, activeSection: section }));
  };

  const pending = state.sections.todo.filter((t) => !t.done).length;
  const doneCount = state.sections.todo.length - pending;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>🥽 G2 Even Reality Hub</h1>
          <p className="tagline">Paste once → stream live into your glasses → control with the R1 ring.</p>
        </div>
        <div className={`sync-chip ${sync}`} title="Broadcast status">
          <span className="dot" />
          {sync === 'pushing' && 'Syncing…'}
          {sync === 'synced' && 'Live'}
          {sync === 'offline' && 'Offline'}
          {sync === 'idle' && 'Ready'}
          {lastSync ? ` · ${new Date(lastSync).toLocaleTimeString()}` : ''}
        </div>
      </header>

      <section className="paste-panel card">
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
        {(Object.keys(SECTION_LABELS) as SectionId[]).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={state.activeSection === id}
            className={state.activeSection === id ? 'tab active' : 'tab'}
            onClick={() => switchSection(id)}
          >
            {SECTION_LABELS[id]}
            {id === 'todo' && state.sections.todo.length > 0 && (
              <span className="count">
                {pending}/{state.sections.todo.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="content card">
        {state.activeSection === 'todo' && (
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

        {state.activeSection === 'docs' && (
          <div className="text-panel">
            <div className="panel-label">Live Docs Stream · double-sync with glasses</div>
            <textarea
              className="doc-textarea"
              value={state.sections.docs}
              onChange={(e) => setTextSection('docs', e.target.value)}
              placeholder="Pasted docs / long-form text appear here. Edits stream live to the glasses."
            />
          </div>
        )}

        {state.activeSection === 'notes' && (
          <div className="text-panel">
            <div className="panel-label">Notes · double-sync with glasses</div>
            <textarea
              className="doc-textarea"
              value={state.sections.notes}
              onChange={(e) => setTextSection('notes', e.target.value)}
              placeholder="Quick notes / memos. Edits stream live to the glasses."
            />
          </div>
        )}
      </main>

      <footer className="app-footer">
        <span>Web = source of truth · localStorage + SSE broadcast</span>
        <span>Double-tap R1 ring = open system exit · single press = confirm · swipe = scroll</span>
      </footer>
    </div>
  );
}
