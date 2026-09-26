// Hub tools — let an AGENT read and write the To-Do list, the document library
// and the notes blob.
//
// WHY THIS IS A MODULE (and why it is pure):
//   Agent runs execute SERVER-SIDE in the relay, which until now could only reach
//   the web, the Jarvis document gateway and jev. Todos, docs and notes lived in
//   `HubState` — which the relay *holds* but never *touched* — so "have my agent
//   add a task" had no route at all. These functions are that route.
//
//   Every function takes a `HubState` and RETURNS A NEW ONE rather than mutating
//   a store, because the relay is not the only caller: a harness imports this
//   file directly and asserts the semantics (see `tools/hub-tools-sim.mjs`).
//   `local-sse.mjs` binds it to the live hub channel; nothing in here knows what
//   a socket is.
//
// THE CONTRACT WITH THE MODEL:
//   The same shape as the Jarvis document tool — one tool per AREA, with an
//   `action` enum, and a `target` that is resolved forgivingly (a number, an id,
//   an exact title, a substring, or "all the words appear in it"). A model
//   writes "the meeting one" as readily as a wearer says it, so both get the
//   same resolver rather than each inventing matching rules.
//
// WHAT A CALL RETURNS:
//   `{ ok, text, state? }`. `state` is present only when something CHANGED, and
//   the relay is what persists and broadcasts it — so a read can never rewrite
//   the hub, and a failed call can never half-apply.

/** The tool kinds this module owns. Deliberately NOT 'files', which is the
 *  gateway-backed document store (`jarvis-files.mjs`) — a different thing. */
export const HUB_TOOL_KINDS = new Set(['todo', 'docs', 'notes']);

/** The model-facing tool name per kind, used when a ToolDef does not name one. */
export const HUB_TOOL_NAMES = {
  todo: 'jarvis_todo',
  docs: 'jarvis_docs',
  notes: 'jarvis_notes',
};

export function isHubTool(t) {
  return Boolean(t) && HUB_TOOL_KINDS.has(t.kind);
}

/**
 * How much of a document or the notes blob ONE read returns.
 *
 * The same bound and the same reasoning as the client capability catalog: a
 * wearer's text has no size limit, so an unbounded read would swallow the run's
 * whole context budget. What it must never be is a DEAD END — every read reports
 * the offset to resume from, so a long document can be walked to its end over
 * several turns instead of being silently cut.
 */
export const READ_CHARS = 12000;

/** Cap for any string that will be rendered as a label. */
export function short(text, max = 40) {
  const one = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}\u2026` : one;
}

/**
 * Clamp a requested read offset to a real position in `total` characters.
 *
 * Absent, NaN, negative or fractional all mean "from the start". An
 * out-of-range offset handed straight to `slice` comes back EMPTY, which reads
 * to the model as "the text is blank" — the one wrong answer that looks like a
 * successful read.
 */
export function readFrom(raw, total) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), total);
}

/**
 * Split a spoken or written list into separate items ("milk, eggs and bread").
 *
 * Newlines are the explicit separator; a single line stays a single task even
 * when it contains commas, because "Buy milk, eggs and bread" is one errand and
 * inventing three tasks from it is a worse failure than storing one long one.
 */
export function splitItems(text) {
  const raw = String(text ?? '');
  if (raw.includes('\n')) {
    return raw
      .split('\n')
      .map((s) => s.replace(/^\s*[-*\u2022]\s*/, '').trim())
      .filter(Boolean);
  }
  return [raw.trim()].filter(Boolean);
}

/**
 * Resolve a spoken reference to a list index.
 * Accepts a 1-based number ("2"), an id, an exact match, or a substring — in
 * that order of confidence. Returns -1 when nothing matches.
 */
export function resolveIndex(target, items) {
  const t = String(target ?? '').trim();
  if (!t) return -1;

  const num = Number(t);
  if (Number.isInteger(num) && num >= 1 && num <= items.length) return num - 1;

  const byId = items.findIndex((i) => i.id === t);
  if (byId !== -1) return byId;

  const lower = t.toLowerCase();
  const exact = items.findIndex((i) => i.label.toLowerCase() === lower);
  if (exact !== -1) return exact;

  const partial = items.findIndex((i) => i.label.toLowerCase().includes(lower));
  if (partial !== -1) return partial;

  // Last resort: every spoken word appears somewhere in the label.
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 1) {
    const all = items.findIndex((i) => {
      const l = i.label.toLowerCase();
      return words.every((w) => l.includes(w));
    });
    if (all !== -1) return all;
  }
  return -1;
}

/**
 * Guarantee the HubState shape this module writes back.
 *
 * The relay can legitimately hold no hub state yet (a fresh install, or a relay
 * restarted before the glasses ever published), and a persisted blob is not ours
 * to trust — an action must not throw because `sections.todo` is missing. Note
 * that `files` is carried through UNTOUCHED: those rows reference documents on
 * the gateway and this module has no business rewriting them.
 */
export function normalizeHub(hub, now = Date.now()) {
  const s = hub && typeof hub === 'object' ? hub : {};
  const sections = s.sections && typeof s.sections === 'object' ? s.sections : {};
  return {
    activeSection: typeof s.activeSection === 'string' ? s.activeSection : 'todo',
    sections: {
      todo: Array.isArray(sections.todo) ? sections.todo.slice() : [],
      docs: Array.isArray(sections.docs) ? sections.docs.slice() : [],
      files: Array.isArray(sections.files) ? sections.files : [],
      notes: typeof sections.notes === 'string' ? sections.notes : '',
    },
    activeDocId: typeof s.activeDocId === 'string' ? s.activeDocId : null,
    updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : now,
  };
}

/** The open doc, or the first one — the same fallback the glasses use. */
export function activeDocOf(hub) {
  return hub.sections.docs.find((d) => d.id === hub.activeDocId) ?? hub.sections.docs[0] ?? null;
}

/**
 * A read slice plus the resume footer.
 *
 * Every read ends by naming where it stopped, so "is that everything?" has an
 * answer the model can act on rather than guess at.
 */
function readSlice(text, rawOffset) {
  const body = String(text ?? '');
  const from = readFrom(rawOffset, body.length);
  const slice = body.slice(from, from + READ_CHARS);
  const next = from + slice.length;
  const more = next < body.length ? `\n…[read to ${next} of ${body.length}. Read again with offset=${next}]` : '';
  return `${slice}${more}`;
}

/** New ids. The relay has no `crypto.randomUUID` guarantee under old Node. */
function newId() {
  return `hub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const TODO_ACTIONS = ['list', 'add', 'set_done', 'edit', 'remove', 'clear_done'];
const DOCS_ACTIONS = ['list', 'read', 'create', 'append', 'set_content', 'rename', 'delete', 'open'];
const NOTES_ACTIONS = ['read', 'append', 'set_content', 'clear'];

function todoSchema(t) {
  return {
    type: 'function',
    function: {
      name: t.name || HUB_TOOL_NAMES.todo,
      description:
        t.description ||
        'Read and change the To-Do list on the user\u2019s glasses. Use it to add a task, tick one off, rename or delete one, list what is outstanding, or clear the finished ones. Changes appear on the glasses immediately.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: TODO_ACTIONS, description: 'What to do.' },
          text: {
            type: 'string',
            description:
              'The task text: the new task for `add` (one task per line for several), or the replacement text for `edit`.',
          },
          target: {
            type: 'string',
            description:
              'Which task: its number in the list, its id, its exact text, or part of its text. Required for set_done, edit and remove.',
          },
          done: {
            type: 'boolean',
            description: 'set_done: true ticks the task, false reopens it. Defaults to true.',
          },
        },
        required: ['action'],
      },
    },
  };
}

function docsSchema(t) {
  return {
    type: 'function',
    function: {
      name: t.name || HUB_TOOL_NAMES.docs,
      description:
        t.description ||
        'Read and change the user\u2019s own saved documents on the glasses (the Docs tab — for publishing a page to a link, use the document-store tool instead). Use it to list the documents, read one, write a new one, append to one, replace or rename one, or delete one.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: DOCS_ACTIONS, description: 'What to do.' },
          target: {
            type: 'string',
            description:
              'Which document: its number in the list, its id, its exact title, or part of its title. Optional for `read` (defaults to the one currently open) and required for everything else except `create` and `list`.',
          },
          title: { type: 'string', description: 'create / rename: the document title.' },
          content: { type: 'string', description: 'create / set_content / append: the text to write.' },
          offset: {
            type: 'integer',
            description:
              'read: character position to start from. Omit for the start; a read that stops early tells you the offset to continue from.',
          },
        },
        required: ['action'],
      },
    },
  };
}

function notesSchema(t) {
  return {
    type: 'function',
    function: {
      name: t.name || HUB_TOOL_NAMES.notes,
      description:
        t.description ||
        'Read and change the user\u2019s Notes scratchpad on the glasses. Use it to read the notes, add a line to them, or rewrite them. Notes is one free-text blob, unlike the Docs tab\u2019s separate documents.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: NOTES_ACTIONS, description: 'What to do.' },
          text: { type: 'string', description: 'append / set_content: the text to write.' },
          offset: {
            type: 'integer',
            description: 'read: character position to start from. Omit for the start.',
          },
        },
        required: ['action'],
      },
    },
  };
}

/**
 * The provider-facing schema for a hub tool.
 *
 * Returns null for anything this module does not own, so the relay's dispatch
 * stays one line per kind and a future kind cannot silently get a wrong schema.
 */
export function hubToolSchema(t) {
  if (t?.kind === 'todo') return todoSchema(t);
  if (t?.kind === 'docs') return docsSchema(t);
  if (t?.kind === 'notes') return notesSchema(t);
  return null;
}

/** Render the to-do list the way the glasses number it (1-based, open first). */
function todoListText(hub) {
  const todo = hub.sections.todo;
  if (!todo.length) return 'The to-do list is empty.';
  const open = todo.filter((t) => !t.done).length;
  const lines = todo.map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text}`);
  return `${todo.length} task(s), ${open} still open:\n${lines.join('\n')}`;
}

function docsListText(hub) {
  const docs = hub.sections.docs;
  if (!docs.length) return 'There are no saved documents.';
  const open = activeDocOf(hub);
  const lines = docs.map(
    (d, i) => `${i + 1}. ${d.title || 'Untitled'} (id ${d.id}, ${d.content.length} chars)${d.id === open?.id ? ' ← open' : ''}`,
  );
  return `${docs.length} document(s):\n${lines.join('\n')}`;
}

function resolveTodoTarget(hub, target) {
  const index = resolveIndex(
    target,
    hub.sections.todo.map((t) => ({ id: t.id, label: t.text })),
  );
  return { index, item: index >= 0 ? hub.sections.todo[index] : null };
}

function resolveDocTarget(hub, target) {
  const t = String(target ?? '').trim();
  if (t) {
    const index = resolveIndex(
      t,
      hub.sections.docs.map((d) => ({ id: d.id, label: d.title || 'Untitled' })),
    );
    return { index, doc: index >= 0 ? hub.sections.docs[index] : null };
  }
  const doc = activeDocOf(hub);
  const index = doc ? hub.sections.docs.findIndex((d) => d.id === doc.id) : -1;
  return { index, doc };
}

/** A miss always says what WAS available — otherwise the model cannot recover. */
function noTodoMatch(hub, target) {
  return {
    ok: false,
    text: hub.sections.todo.length
      ? `No task matches "${short(target, 24)}". Current tasks: ${hub.sections.todo
          .map((t, i) => `${i + 1}. ${t.text}`)
          .join(' | ')}`
      : 'The to-do list is empty.',
  };
}

function noDocMatch(hub, target) {
  return {
    ok: false,
    text: hub.sections.docs.length
      ? `No document matches "${short(target, 24)}". Documents: ${hub.sections.docs
          .map((d, i) => `${i + 1}. ${d.title || 'Untitled'}`)
          .join(' | ')}`
      : 'There are no saved documents.',
  };
}

function runTodo(hub, args) {
  const action = String(args.action ?? 'list');
  const text = String(args.text ?? '');
  const now = Date.now();

  if (action === 'list') return { ok: true, text: todoListText(hub) };

  if (action === 'add') {
    const items = splitItems(text);
    if (!items.length) return { ok: false, text: 'No task text given.' };
    const added = items.map((t) => ({ id: newId(), text: t, done: false }));
    const next = { ...hub, sections: { ...hub.sections, todo: [...hub.sections.todo, ...added] }, updatedAt: now };
    return {
      ok: true,
      state: next,
      text:
        added.length === 1
          ? `Added "${short(added[0].text)}". The list now has ${next.sections.todo.length} task(s).`
          : `Added ${added.length} tasks: ${added.map((a) => short(a.text, 30)).join(' | ')}. The list now has ${next.sections.todo.length}.`,
    };
  }

  if (action === 'set_done') {
    const { index, item } = resolveTodoTarget(hub, args.target);
    if (!item || index < 0) return noTodoMatch(hub, args.target);
    const done = args.done !== false;
    if (item.done === done) {
      return { ok: true, text: `"${short(item.text)}" is already ${done ? 'done' : 'open'}.` };
    }
    const todo = hub.sections.todo.map((t, i) => (i === index ? { ...t, done } : t));
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, todo }, updatedAt: now },
      text: `${done ? 'Ticked' : 'Reopened'} "${short(item.text)}". ${todo.filter((t) => !t.done).length} still open.`,
    };
  }

  if (action === 'edit') {
    const { index, item } = resolveTodoTarget(hub, args.target);
    if (!item || index < 0) return noTodoMatch(hub, args.target);
    const replacement = text.trim();
    if (!replacement) return { ok: false, text: 'No replacement text given.' };
    const todo = hub.sections.todo.map((t, i) => (i === index ? { ...t, text: replacement } : t));
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, todo }, updatedAt: now },
      text: `Task ${index + 1} is now "${short(replacement)}" (was "${short(item.text)}").`,
    };
  }

  if (action === 'remove') {
    const { index, item } = resolveTodoTarget(hub, args.target);
    if (!item || index < 0) return noTodoMatch(hub, args.target);
    const todo = hub.sections.todo.filter((_, i) => i !== index);
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, todo }, updatedAt: now },
      text: `Deleted "${short(item.text)}". ${todo.length} task(s) remain.`,
    };
  }

  if (action === 'clear_done') {
    const done = hub.sections.todo.filter((t) => t.done);
    if (!done.length) return { ok: true, text: 'No finished tasks to clear.' };
    const todo = hub.sections.todo.filter((t) => !t.done);
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, todo }, updatedAt: now },
      text: `Cleared ${done.length} finished task(s). ${todo.length} remain open.`,
    };
  }

  return { ok: false, text: `Unknown action "${action}". Use one of: ${TODO_ACTIONS.join(', ')}.` };
}

function runDocs(hub, args) {
  const action = String(args.action ?? 'list');
  const now = Date.now();

  if (action === 'list') return { ok: true, text: docsListText(hub) };

  if (action === 'read') {
    const { doc } = resolveDocTarget(hub, args.target);
    if (!doc) {
      return hub.sections.docs.length
        ? noDocMatch(hub, args.target)
        : { ok: false, text: 'There are no saved documents to read.' };
    }
    if (!doc.content) return { ok: true, text: `"${doc.title || 'Untitled'}" is empty.` };
    return {
      ok: true,
      text: `"${doc.title || 'Untitled'}" (${doc.content.length} chars):\n${readSlice(doc.content, args.offset)}`,
    };
  }

  if (action === 'create') {
    const content = String(args.content ?? '');
    const title = String(args.title ?? '').trim() || short(content, 40).replace(/^\/+|\/+$/g, '') || 'Untitled';
    const doc = { id: newId(), title, content, updatedAt: now };
    const docs = [...hub.sections.docs, doc];
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, docs }, activeDocId: doc.id, updatedAt: now },
      text: `Created "${doc.title}" (id ${doc.id}, ${content.length} chars) and opened it.`,
    };
  }

  if (action === 'append') {
    const { index, doc } = resolveDocTarget(hub, args.target);
    if (!doc || index < 0) return noDocMatch(hub, args.target);
    const content = String(args.content ?? '');
    if (!content.trim()) return { ok: false, text: 'No content given to append.' };
    const merged = doc.content ? `${doc.content}\n${content}` : content;
    const docs = hub.sections.docs.map((d, i) =>
      i === index ? { ...d, content: merged, updatedAt: now } : d,
    );
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, docs }, updatedAt: now },
      text: `Appended ${content.length} chars to "${doc.title || 'Untitled'}" (now ${merged.length} chars).`,
    };
  }

  if (action === 'set_content') {
    const { index, doc } = resolveDocTarget(hub, args.target);
    if (!doc || index < 0) return noDocMatch(hub, args.target);
    const content = String(args.content ?? '');
    const docs = hub.sections.docs.map((d, i) =>
      i === index ? { ...d, content, updatedAt: now } : d,
    );
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, docs }, updatedAt: now },
      text: `Rewrote "${doc.title || 'Untitled'}" — ${doc.content.length} chars replaced with ${content.length}.`,
    };
  }

  if (action === 'rename') {
    const { index, doc } = resolveDocTarget(hub, args.target);
    if (!doc || index < 0) return noDocMatch(hub, args.target);
    const title = String(args.title ?? '').trim();
    if (!title) return { ok: false, text: 'No new title given.' };
    const docs = hub.sections.docs.map((d, i) => (i === index ? { ...d, title, updatedAt: now } : d));
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, docs }, updatedAt: now },
      text: `Renamed "${doc.title || 'Untitled'}" to "${short(title)}".`,
    };
  }

  if (action === 'delete') {
    const { index, doc } = resolveDocTarget(hub, args.target);
    if (!doc || index < 0) return noDocMatch(hub, args.target);
    const docs = hub.sections.docs.filter((_, i) => i !== index);
    // A deleted doc must not stay "open" — the glasses fall back to the first
    // doc when `activeDocId` names something gone, but leaving the dangling id
    // behind means every future read has to guess.
    const activeDocId = hub.activeDocId === doc.id ? (docs[0]?.id ?? null) : hub.activeDocId;
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, docs }, activeDocId, updatedAt: now },
      text: `Deleted "${doc.title || 'Untitled'}" (${doc.content.length} chars). ${docs.length} document(s) remain.`,
    };
  }

  if (action === 'open') {
    const { index, doc } = resolveDocTarget(hub, args.target);
    if (!doc || index < 0) return noDocMatch(hub, args.target);
    return {
      ok: true,
      state: { ...hub, activeSection: 'docs', activeDocId: doc.id, updatedAt: now },
      text: `Opened "${doc.title || 'Untitled'}" on the glasses.`,
    };
  }

  return { ok: false, text: `Unknown action "${action}". Use one of: ${DOCS_ACTIONS.join(', ')}.` };
}

function runNotes(hub, args) {
  const action = String(args.action ?? 'read');
  const text = String(args.text ?? '');
  const notes = hub.sections.notes;
  const now = Date.now();

  if (action === 'read') {
    if (!notes) return { ok: true, text: 'The notes are empty.' };
    return { ok: true, text: `Notes (${notes.length} chars):\n${readSlice(notes, args.offset)}` };
  }

  if (action === 'append') {
    if (!text.trim()) return { ok: false, text: 'No text given to add.' };
    const merged = notes ? `${notes}\n${text}` : text;
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, notes: merged }, updatedAt: now },
      text: `Added ${text.length} chars to the notes (now ${merged.length}).`,
    };
  }

  if (action === 'set_content') {
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, notes: text }, updatedAt: now },
      text: `Rewrote the notes — ${notes.length} chars replaced with ${text.length}.`,
    };
  }

  if (action === 'clear') {
    if (!notes) return { ok: true, text: 'The notes are already empty.' };
    return {
      ok: true,
      state: { ...hub, sections: { ...hub.sections, notes: '' }, updatedAt: now },
      text: `Cleared ${notes.length} chars of notes.`,
    };
  }

  return { ok: false, text: `Unknown action "${action}". Use one of: ${NOTES_ACTIONS.join(', ')}.` };
}

/**
 * Run one hub tool call against `hub`.
 *
 * `hub` may be null (a relay that has never seen a hub frame) and this never
 * throws: an action it does not understand comes back as `{ ok: false }` with
 * the list of actions it does, so the model can correct itself instead of the
 * run dying on a typo.
 */
export function runHubTool(tool, args, hub) {
  const state = normalizeHub(hub);
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (tool?.kind === 'todo') return runTodo(state, a);
  if (tool?.kind === 'docs') return runDocs(state, a);
  if (tool?.kind === 'notes') return runNotes(state, a);
  return { ok: false, text: `Not a hub tool: ${String(tool?.kind ?? 'unknown')}.` };
}

/** The one-line summary the run transcript shows beside the call. */
export function hubToolSummary(tool, args) {
  const action = String(args?.action ?? '');
  const label = HUB_TOOL_NAMES[tool?.kind] ?? 'hub';
  return action ? `${label}.${action}` : label;
}
