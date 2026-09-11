// To-Do page capabilities — layer 2.
//
// Mirrors every action the To-Do tab offers by hand: add, tick, edit, delete,
// clear finished. Each one is a plain data description plus a `run` that
// mutates the shared store, so the registry can expose, validate and undo it
// without knowing anything about to-do lists.
import { getState, update } from '../../store';
import { uid, type TodoItem } from '../../types';
import type { Capability } from '../types';
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

function withTodo(fn: (todo: TodoItem[]) => TodoItem[]): TodoItem[] {
  update((s) => ({ ...s, sections: { ...s.sections, todo: fn(s.sections.todo) } }));
  return getState().sections.todo;
}

export const todoCapabilities: Capability[] = [
  {
    name: 'todo.add',
    page: 'todo',
    title: 'Add task',
    description:
      'Add one or more to-do items. Put each item on its own line if the user listed several.',
    params: [{ name: 'text', type: 'string', description: 'The task text. One task per line.', required: true }],
    run: (args) => {
      const items = splitItems(String(args.text ?? ''));
      if (!items.length) return { ok: false, summary: 'No task text given' };
      const added = items.map((text) => ({ id: uid(), text, done: false }));
      withTodo((todo) => [...todo, ...added]);
      return {
        ok: true,
        summary: added.length === 1 ? `Added "${short(added[0].text)}"` : `Added ${added.length} tasks`,
        data: { added: added.map((a) => a.text) },
      };
    },
  },
  {
    name: 'todo.set_done',
    page: 'todo',
    title: 'Tick or untick task',
    description:
      'Mark an existing task complete or not complete. `target` is the task number shown in the list, ' +
      'its text, or part of its text.',
    params: [
      { name: 'target', type: 'string', description: 'Task number, full text, or part of the text.', required: true },
      { name: 'done', type: 'boolean', description: 'true to tick the task, false to untick it.', fallback: true },
    ],
    run: (args) => {
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
      withTodo((list) => list.map((t, i) => (i === index ? { ...t, done } : t)));
      return { ok: true, summary: `${done ? 'Ticked' : 'Reopened'} "${short(item.text)}"`, data: { id: item.id, done } };
    },
  },
  {
    name: 'todo.edit',
    page: 'todo',
    title: 'Edit task text',
    description: 'Replace the text of an existing task.',
    params: [
      { name: 'target', type: 'string', description: 'Task number, full text, or part of the text.', required: true },
      { name: 'text', type: 'string', description: 'The new task text.', required: true },
    ],
    run: (args) => {
      const todo = getState().sections.todo;
      const { index, item } = resolveTodo(String(args.target ?? ''), todo);
      if (!item || index < 0) {
        return { ok: false, summary: `No task matches "${short(String(args.target ?? ''), 24)}"` };
      }
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, summary: 'No new text given' };
      withTodo((list) => list.map((t, i) => (i === index ? { ...t, text } : t)));
      return { ok: true, summary: `Edited task ${index + 1}`, data: { from: item.text, to: text } };
    },
  },
  {
    name: 'todo.remove',
    page: 'todo',
    title: 'Delete task',
    description: 'Delete one task from the list. Removes it permanently.',
    params: [
      { name: 'target', type: 'string', description: 'Task number, full text, or part of the text.', required: true },
    ],
    confirm: true,
    run: (args) => {
      const todo = getState().sections.todo;
      const { index, item } = resolveTodo(String(args.target ?? ''), todo);
      if (!item || index < 0) {
        return { ok: false, summary: `No task matches "${short(String(args.target ?? ''), 24)}"` };
      }
      withTodo((list) => list.filter((_, i) => i !== index));
      return { ok: true, summary: `Deleted "${short(item.text)}"` };
    },
  },
  {
    name: 'todo.clear_done',
    page: 'todo',
    title: 'Clear finished tasks',
    description: 'Delete every task that is already ticked. Leaves open tasks alone.',
    params: [],
    confirm: true,
    available: () => getState().sections.todo.some((t) => t.done),
    run: () => {
      const before = getState().sections.todo;
      const removed = before.filter((t) => t.done).length;
      withTodo((list) => list.filter((t) => !t.done));
      return { ok: true, summary: `Cleared ${removed} finished task(s)`, data: { removed } };
    },
  },
  {
    name: 'todo.clear_all',
    page: 'todo',
    title: 'Clear the list',
    description: 'Delete EVERY task, including open ones. Only when the user clearly asks to empty the list.',
    params: [],
    confirm: true,
    available: () => getState().sections.todo.length > 0,
    run: () => {
      const removed = getState().sections.todo.length;
      withTodo(() => []);
      return { ok: true, summary: `Cleared the whole list (${removed})`, data: { removed } };
    },
  },
];
