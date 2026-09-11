// The default catalog: page definitions + every capability, registered once.
//
// THIS IS THE ONLY FILE A NEW PAGE NEEDS TO TOUCH. Add a `registerPage(...)`
// block, drop the capability objects in, and the new page automatically gets
// tool schemas, argument validation, layer-2 focus enforcement, the HUD routing
// label, the system-prompt catalog entry, the web tool catalog and undo —
// because every one of those is derived from the registry at run time.
import { registerCapabilities, registerPage } from './registry';
import { agentsCapabilities } from './capabilities/agents';
import { docsCapabilities } from './capabilities/docs';
import { globalCapabilities } from './capabilities/global';
import { notesCapabilities } from './capabilities/notes';
import { settingsCapabilities } from './capabilities/settings';
import { todoCapabilities } from './capabilities/todo';
import type { Capability } from './types';

const CAPABILITIES: Capability[] = [
  ...globalCapabilities,
  ...todoCapabilities,
  ...docsCapabilities,
  ...notesCapabilities,
  ...agentsCapabilities,
  ...settingsCapabilities,
];

let done = false;

/** Idempotent: safe to call from anywhere, including a harness. */
export function registerDefaultCatalog(): void {
  if (done) return;
  done = true;

  registerPage({
    id: 'todo',
    title: 'To-Do',
    synonyms: ['todo', 'to do', 'tasks', 'task list', 'checklist', 'list', 'shopping list'],
    summary: 'The task list: add, tick, edit and delete tasks.',
  });
  registerPage({
    id: 'docs',
    title: 'Docs',
    synonyms: ['docs', 'documents', 'notes library', 'my notes', 'document'],
    summary: 'A library of named documents: create, open, append to, rename and delete them.',
  });
  registerPage({
    id: 'notes',
    title: 'Notes',
    synonyms: ['notes', 'scratchpad', 'notepad', 'jot', 'quick notes'],
    summary: 'One free-text scratchpad for quick captures.',
  });
  registerPage({
    id: 'agents',
    title: 'Agents',
    synonyms: ['agents', 'ai agents', 'assistants', 'bots'],
    summary: 'AI agents you have built and can run on a prompt.',
  });
  registerPage({
    id: 'settings',
    title: 'Settings',
    synonyms: ['settings', 'preferences', 'config', 'keys'],
    summary: 'Provider keys, model and tool settings. Read-only for the assistant.',
  });

  registerCapabilities(CAPABILITIES);
}

registerDefaultCatalog();

export { CAPABILITIES as catalogCapabilities };
