import { useEffect, useSyncExternalStore, useState } from 'react';
import { categorize } from './categorize';
import { useAuth } from './auth';
import { getConnStatus, getState, subscribe, subscribeConn, update } from '../store';
import type { ConnStatus } from '../store';
import type { HubState, SectionId, TodoItem } from '../types';
import { activeDoc, emptyDoc, uid, upsertDoc } from '../types';

const SECTION_LABELS: Record<SectionId, string> = {
  todo: 'To-Do',
  docs: 'Docs',
  notes: 'Notes',
};

function useHubState(): HubState {
  return useSyncExternalStore(subscribe, getState);
}

function useConn(): ConnStatus {
  return useSyncExternalStore(subscribeConn, getConnStatus);
}

/** Owner-only device manager: approve a pairing code + revoke glasses devices. */
function DevicesPanel() {
  const { devices, pairDevice, revokeDevice, refreshDevices, pairError } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const approve = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setDone(null);
    const r = await pairDevice(code);
    setBusy(false);
    if (r.ok) {
      setDone('Device approved 🎉');
      setCode('');
    }
  };

  return (
    <section className="card devices-panel">
      <div className="panel-label">
        Devices · each glasses device must be approved here before it can see the stream
      </div>
      <div className="pair-row">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && approve()}
          placeholder="Pairing code (shown on the glasses phone screen)"
          maxLength={6}
        />
        <button className="primary" onClick={approve} disabled={busy || !code.trim()}>
          {busy ? 'Approving…' : 'Approve'}
        </button>
      </div>
      {pairError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{pairError}</p>}
      {done && <p style={{ color: 'var(--good)', fontSize: 12 }}>{done}</p>}
      {(devices ?? []).length > 0 && (
        <ul className="device-list">
          {(devices ?? []).map((d) => (
            <li key={d.deviceId} className="device-row">
              <span className="device-name" title={d.deviceId}>
                🥽 {d.deviceId.slice(0, 8)}…
              </span>
              <span className="device-meta">
                {d.email} · {d.approvedAt ? new Date(d.approvedAt).toLocaleDateString() : ''}
              </span>
              <button
                className="icon-btn danger"
                onClick={() => void revokeDevice(d.deviceId)}
                aria-label="Revoke device"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function App() {
  const state = useHubState();
  const conn = useConn();
  const { authed, email, inEvenApp, signOut } = useAuth();
  const [paste, setPaste] = useState('');
  const [detected, setDetected] = useState<SectionId[]>([]);
  const [newTask, setNewTask] = useState('');

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

  const switchSection = (section: SectionId) => {
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
    <div className="app">
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

        {state.activeSection === 'notes' && (
          <div className="text-panel">
            <div className="panel-label">Notes · double-sync with glasses</div>
            <textarea
              className="doc-textarea"
              value={state.sections.notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Quick notes / memos. Edits stream live to the glasses."
            />
          </div>
        )}
      </main>

      {authed && !inEvenApp && <DevicesPanel />}

      <footer className="app-footer">
        <span>Same URL drives the web UI and the glasses · edits broadcast live</span>
        <span>R1 ring: swipe = move · single press = toggle · double-press = exit</span>
      </footer>
    </div>
  );
}
