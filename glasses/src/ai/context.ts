// One source of truth for "what does the app currently look like".
//
// Used twice, deliberately: it is pasted into the system prompt so the model can
// resolve "the second one" / "my shopping list" without a round trip, and it
// backs the `app.status` capability so a user asking "what's in here?" gets the
// same answer from the same code.
import { getAgents } from '../agents-store';
import { getState } from '../store';
import { activeDoc, type DocEntry, type TodoItem } from '../types';
import { pageTitle } from './registry';
import { getAiFocus } from './store';

const MAX_LIST = 6;

function names(items: string[], max = MAX_LIST): string {
  const shown = items.slice(0, max).map((t) => t.trim()).filter(Boolean);
  const extra = items.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}

function trim(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Compact, single-line-per-topic snapshot. Safe to render inside a prompt. */
export function appSnapshotText(): string {
  const s = getState();
  const a = getAgents();
  const todo: TodoItem[] = s.sections.todo;
  const docs: DocEntry[] = s.sections.docs;
  const open: DocEntry | null = activeDoc(s) ?? null;
  const notes = (s.sections.notes ?? '').trim();

  const openTasks = todo.filter((t) => !t.done).map((t) => t.text);
  const doneCount = todo.length - openTasks.length;

  const lines: string[] = [];
  lines.push(`Focused page: ${pageTitle(getAiFocus())}`);
  lines.push(
    `To-Do: ${todo.length} task(s), ${doneCount} done. Open: ${openTasks.length ? names(openTasks) : 'none'}`,
  );
  lines.push(
    `Docs: ${docs.length} — ${docs.length ? names(docs.map((d) => d.title)) : 'none'}` +
      (open ? ` [open: "${trim(open.title, 30)}", ${open.content.length} chars]` : ''),
  );
  lines.push(notes ? `Notes: ${notes.length} chars — "${trim(notes, 60)}"` : 'Notes: empty');
  if (a.agents.length) {
    lines.push(`Agents: ${names(a.agents.map((x) => x.name))}`);
    const running = a.sessions.filter((x) => x.status === 'running').length;
    if (running) lines.push(`Running agents: ${running}`);
  } else {
    lines.push('Agents: none configured');
  }
  return lines.join('\n');
}

/** The doc body, if the user's command reads like it is about the open doc. */
export function openDocText(max = 2000): string {
  const doc = activeDoc(getState());
  if (!doc) return '';
  const body = doc.content.trim();
  return body.length > max ? `${body.slice(0, max)}\n…(truncated)` : body;
}
