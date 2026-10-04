// One source of truth for "what does the app currently look like".
//
// Used twice, deliberately: it is pasted into the system prompt so the model can
// resolve "the second one" / "my shopping list" without a round trip, and it
// backs the `app.status` capability so a user asking "what's in here?" gets the
// same answer from the same code.
import { getAgents } from '../agents-store';
import { getState } from '../store';
import { activeDoc, type DocEntry, type TodoItem } from '../types';
import { SEED_TOOLS } from './capabilities/agents';
import { exposureGaps, kindLabel, promiseRules } from './exposure';
import { getMonitorView } from './monitor';
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
  // Where an agent's words and its tool list disagree.
  //
  // This is here rather than in the Agents page because it is a fact about the
  // APP, like "how many tasks are open" — and because both readers of this
  // function need it: the system prompt, so Jarvis can SAY what is missing when
  // asked, and `app.status`, so "is anything misconfigured?" gets the same answer
  // from the same code. Re-derived every call and never stored: a prompt can be
  // edited on another machine, so a remembered answer would be the one thing
  // guaranteed to be stale.
  const gaps = exposureGaps({ agents: a.agents, tools: a.tools }, promiseRules(SEED_TOOLS));
  const short = gaps.filter((g) => g.missing.length);
  if (short.length) {
    const list = short.map((g) => `${trim(g.agentName, 24)} (${g.missing.map(kindLabel).join(', ')})`);
    lines.push(
      `Agent tool gaps — the prompt promises a tool the agent does not hold: ${names(list)}. ` +
        'Call agents__expose to PROPOSE attaching them; a tool is only attached once the wearer accepts.',
    );
  }
  // A prompt that both mentions and disowns a capability. Reported, never acted
  // on: this is the case where attaching the tool would be the app arguing with
  // the agent's own instructions, so agents__expose leaves it alone and says so.
  const denied = gaps.filter((g) => g.denied.length);
  if (denied.length) {
    const list = denied.map((g) => `${trim(g.agentName, 24)} (${g.denied.map(kindLabel).join(', ')})`);
    lines.push(`Agents whose prompt disowns a tool it mentions: ${names(list)}`);
  }
  // The runs Jarvis itself started, still being watched. Without this the model
  // would only learn a run had finished if the wearer asked — and "is it done?"
  // is exactly the question voice is best at.
  const q = getMonitorView();
  if (q.rows.length) {
    const rows = q.rows
      .slice(0, 3)
      .map((r) => `${r.label} ${r.status}${r.unread ? ' [NEW]' : ''}`)
      .join(', ');
    lines.push(
      `Jarvis agent queue (${q.rows.length} watched, ${q.unread} new): ${rows}` +
        (q.rows.length > 3 ? ` (+${q.rows.length - 3} more)` : ''),
    );
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
