// To-Do page capabilities — layer 2.
//
// Mirrors every action the To-Do tab offers by hand: add, tick, edit, delete,
// clear finished. Each one is a plain data description plus a `run` that calls a
// store op, so the registry can expose, validate and undo it without knowing
// anything about to-do lists — and, because the store ops write to the hub,
// anything Jarvis does here persists and reaches the wearer's other devices.
//
// ⚠ EVERY WRITE HERE IS CONFIRMED, and that is a rule rather than a detail. A
// `run` may only report a task added, ticked, renamed or deleted once a re-read
// of the hub's OWN list has shown it (`WriteOutcome` in the store). All six of
// these used to return `ok: true` synchronously, before the hub had answered at
// all, so a `401` from an unpaired device — or a stale `rev`, or a relay that was
// down — read to Jarvis, to the ledger and to the wearer exactly like a save. The
// tasks were never written and the list on screen was the local cache. That is
// the bug this file's contract exists to make impossible.
import {
  addTask,
  clearDoneTasks,
  getState,
  removeTask,
  setTaskDone,
  setTaskTextNow,
  setTasks,
  type WriteOutcome,
} from '../../store';
import type { Capability, CapabilityResult } from '../types';
import { resolveTodo, short } from './shared';

/** Split a spoken list into separate items ("milk, eggs and bread" → 3). */
function splitItems(text: string): string[] {
  if (text.includes('\n')) {
    return text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [text.trim()].filter(Boolean);
}

/**
 * The answer when a write did not stick.
 *
 * The store's message IS the summary, because `main.ts` renders
 * `"<title> did NOT run — <summary>"` and `oneLine` truncates the line at 80
 * characters: the part that distinguishes this from a success has to come first,
 * and every message the store produces already leads with it.
 *
 * The `hint` exists because a delegated run's obvious next step is a retry, and
 * retrying an unpaired device never succeeds.
 */
function unwritten(out: WriteOutcome): CapabilityResult {
  return {
    ok: false,
    summary: out.error || 'the hub did not confirm it',
    hint: 'The change did NOT reach the hub, so it is not saved. Say so in one sentence. Do not retry — a retry cannot fix a sign-in or a stale list.',
  };
}

export const todoCapabilities: Capability[] = [
  {
    name: 'todo.add',
    page: 'todo',
    effect: 'write',
    title: 'Add task',
    description:
      'Add one or more to-do items. Put each item on its own line if the user listed several.',
    params: [{ name: 'text', type: 'string', description: 'The task text. One task per line.', required: true }],
    run: async (args) => {
      const items = splitItems(String(args.text ?? ''));
      if (!items.length) return { ok: false, summary: 'No task text given' };
      // One `POST /hub/todos` per item, NOT a wholesale replace of the list:
      // replacing it would drop a task another device added in the meantime, and
      // the hub has no multi-item create. SEQUENTIAL on purpose: each write
      // confirms itself by adopting the hub's own list, so a create issued while
      // an earlier confirmation was still in flight would have its optimistic
      // row replaced by a list that had not heard of it yet.
      for (let n = 0; n < items.length; n++) {
        const out = await addTask(items[n]);
        if (out.ok) continue;
        // Say how much of a spoken list landed. "add milk and eggs" that saved
        // milk and not eggs is a different thing to be told than a total
        // failure, and the wearer is about to look at the list.
        const landed = n ? `${n} of ${items.length} saved; ` : '';
        return {
          ok: false,
          summary: `${landed}${out.error}`,
          hint: 'The change did NOT fully reach the hub. Say which tasks saved and which did not.',
        };
      }
      return {
        ok: true,
        summary: items.length === 1 ? `Added "${short(items[0])}"` : `Added ${items.length} tasks`,
        data: { added: items },
      };
    },
  },
  {
    name: 'todo.set_done',
    page: 'todo',
    effect: 'write',
    title: 'Tick or untick task',
    description:
      'Mark an existing task complete or not complete. `target` is the task number shown in the list, ' +
      'its text, or part of its text.',
    params: [
      { name: 'target', type: 'string', description: 'Task number, full text, or part of the text.', required: true },
      { name: 'done', type: 'boolean', description: 'true to tick the task, false to untick it.', fallback: true },
    ],
    run: async (args) => {
      const todo = getState().sections.todo;
      if (!todo.length) return { ok: false, summary: 'The to-do list is empty' };
      const { index, item } = resolveTodo(String(args.target ?? ''), todo);
      if (!item || index < 0) {
        return {
          ok: false,
          summary: `No task matches "${short(String(args.target ?? ''), 24)}"`,
          hint: `current tasks: ${todo.map((t, i) => `${i + 1}. ${t.text}`).join(' | ')}`,
        };
      }
      const done = args.done !== false;
      if (item.done === done) {
        return { ok: true, summary: `"${short(item.text)}" is already ${done ? 'done' : 'open'}` };
      }
      const out = await setTaskDone(item.id, done);
      if (!out.ok) return unwritten(out);
      return { ok: true, summary: `${done ? 'Ticked' : 'Reopened'} "${short(item.text)}"`, data: { id: item.id, done } };
    },
  },
  {
    name: 'todo.edit',
    page: 'todo',
    effect: 'write',
    title: 'Edit task text',
    description: 'Replace the text of an existing task.',
    params: [
      { name: 'target', type: 'string', description: 'Task number, full text, or part of the text.', required: true },
      { name: 'text', type: 'string', description: 'The new task text.', required: true },
    ],
    run: async (args) => {
      const todo = getState().sections.todo;
      const { index, item } = resolveTodo(String(args.target ?? ''), todo);
      if (!item || index < 0) {
        return { ok: false, summary: `No task matches "${short(String(args.target ?? ''), 24)}"` };
      }
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, summary: 'No new text given' };
      // `setTaskTextNow`, not `setTaskText`: the debounced one answers from
      // inside its own 400 ms window, before the hub has heard anything.
      const out = await setTaskTextNow(item.id, text);
      if (!out.ok) return unwritten(out);
      return { ok: true, summary: `Edited task ${index + 1}`, data: { from: item.text, to: text } };
    },
  },
  {
    name: 'todo.remove',
    page: 'todo',
    effect: 'write',
    title: 'Delete task',
    description: 'Delete one task from the list. Removes it permanently.',
    params: [
      { name: 'target', type: 'string', description: 'Task number, full text, or part of the text.', required: true },
    ],
    confirm: true,
    run: async (args) => {
      const todo = getState().sections.todo;
      const { index, item } = resolveTodo(String(args.target ?? ''), todo);
      if (!item || index < 0) {
        return { ok: false, summary: `No task matches "${short(String(args.target ?? ''), 24)}"` };
      }
      const out = await removeTask(item.id);
      if (!out.ok) return unwritten(out);
      return { ok: true, summary: `Deleted "${short(item.text)}"` };
    },
  },
  {
    name: 'todo.clear_done',
    page: 'todo',
    effect: 'write',
    title: 'Clear finished tasks',
    description: 'Delete every task that is already ticked. Leaves open tasks alone.',
    params: [],
    confirm: true,
    available: () => getState().sections.todo.some((t) => t.done),
    run: async () => {
      const before = getState().sections.todo;
      const removed = before.filter((t) => t.done).length;
      const out = await clearDoneTasks();
      if (!out.ok) return unwritten(out);
      return { ok: true, summary: `Cleared ${removed} finished task(s)`, data: { removed } };
    },
  },
  {
    name: 'todo.clear_all',
    page: 'todo',
    effect: 'irreversible',
    title: 'Clear the list',
    description: 'Delete EVERY task, including open ones. Only when the user clearly asks to empty the list.',
    params: [],
    confirm: true,
    available: () => getState().sections.todo.length > 0,
    run: async () => {
      const removed = getState().sections.todo.length;
      const out = await setTasks([]);
      if (!out.ok) return unwritten(out);
      return { ok: true, summary: `Cleared the whole list (${removed})`, data: { removed } };
    },
  },
];
