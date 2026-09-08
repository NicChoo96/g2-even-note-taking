// Text rendering for G2 — mirrors the official evenhub-templates "minimal"
// pattern: ONE full-canvas text container, updated in place with
// textContainerUpgrade (flicker-free). No list containers, no OS menu, no
// rebuilds — the smallest surface area possible, so real firmware accepts it.
//
// Input model: swipe up/down moves a cursor (todo) or flips pages (docs/notes),
// and a single tap toggles the highlighted todo item. The container content is
// always clipped to the G2 OS's hard content cap — 999 UTF-8 bytes on BOTH
// createStartUpPageContainer and textContainerUpgrade (verified empirically in
// the simulator; oversized content makes the whole page get REJECTED).
import { MenuContainerProperty, MenuItemProperty, utf8ByteLength } from '@evenrealities/even_hub_sdk';
import { measureTextWrap } from '@evenrealities/pretext';
import {
  activeDoc,
  type AgentDef,
  type AgentSession,
  type DocEntry,
  type HubState,
  type SectionId,
  type TodoItem,
} from './types';

export interface SectionDef {
  id: SectionId;
  title: string;
  /** uint32 identifier used by the OS contextual menu (must be > 0, unique). */
  menuId: number;
}

export const SECTIONS: SectionDef[] = [
  { id: 'todo', title: 'To-Do', menuId: 1 },
  { id: 'docs', title: 'Docs', menuId: 2 },
  { id: 'notes', title: 'Notes', menuId: 3 },
  { id: 'agents', title: 'Agents', menuId: 4 },
];

export function sectionTitle(id: SectionId): string {
  return SECTIONS.find((s) => s.id === id)?.title ?? id;
}

/** OS contextual-menu item IDs (section switchers + section actions + Dictate). */
export const MENU = {
  TODO: 1,
  DOCS: 2,
  NOTES: 3,
  /** Section switcher: the Agents master-detail view. */
  AGENTS: 4,
  DOC_NEW: 10,
  DOC_SELECT: 11,
  DOC_DELETE: 12,
  /** R1 → long-press menu → Dictate: start glasses-mic speech-to-text. */
  DICTATE: 20,
  /** Return to the last non-special tab (switchers are hidden there). */
  BACK: 21,
  // Agents-tab actions.
  AGENT_SELECT: 30,
  AGENT_NEW: 31,
  AGENT_DELETE: 32,
  AGENT_RUN: 33,
} as const;

/**
 * Which section menu to build — drives the dynamic contextual menu.
 * The Agents tab additionally needs to know whether anything is selectable.
 */
export interface MenuState {
  /** The active section (section actions only show while that tab is active). */
  section: SectionId;
  /** Whether the docs library has any docs (Select/Delete need at least one). */
  hasDocs: boolean;
  /** Whether any agents exist (Select/Delete/Run need at least one). */
  hasAgents?: boolean;
}

/**
 * Build the OS contextual menu for the current state — reusable and
 * state-aware:
 *
 *   • **Dictate is always the FIRST item** so a long-press reaches it instantly.
 *   • **Docs tab** → Dictate · Back · New Docs · Select Docs · Delete Docs.
 *   • **Agents tab** → Dictate · Back · Select Agents · New Agents · Delete/Run.
 *     The section switchers are hidden here to keep the menu short; use Back to
 *     return to the last non-special tab.
 *   • **Any other tab** → Dictate · To-Do · Docs · Notes · Agents.
 *
 * The menu is applied on the startup page and REPLACED wholesale on every
 * `rebuildPageContainer`, so call this with the current state whenever the
 * active section (or collection count) changes. Items sit between the system
 * slots (Display off / Brightness on top, "Close Reality Hub" at the bottom).
 * Max 10 items.
 */
export function sectionMenu(state: MenuState): MenuContainerProperty {
  const items: MenuItemProperty[] = [
    // Global action, always first so a long-press reaches it immediately.
    new MenuItemProperty({ itemName: 'Dictate', itemID: MENU.DICTATE }),
  ];
  if (state.section === 'docs') {
    // Docs-scoped actions only — Back returns to the last non-special tab.
    items.push(new MenuItemProperty({ itemName: 'Back', itemID: MENU.BACK }));
    items.push(new MenuItemProperty({ itemName: 'New Docs', itemID: MENU.DOC_NEW }));
    if (state.hasDocs) {
      items.push(new MenuItemProperty({ itemName: 'Select Docs', itemID: MENU.DOC_SELECT }));
      items.push(new MenuItemProperty({ itemName: 'Delete Docs', itemID: MENU.DOC_DELETE }));
    }
  } else if (state.section === 'agents') {
    // Agents-scoped actions only. Select moves the ring to the master panel,
    // Run prompts the highlighted agent (dictation captures the prompt).
    items.push(new MenuItemProperty({ itemName: 'Back', itemID: MENU.BACK }));
    items.push(new MenuItemProperty({ itemName: 'Select Agents', itemID: MENU.AGENT_SELECT }));
    items.push(new MenuItemProperty({ itemName: 'New Agents', itemID: MENU.AGENT_NEW }));
    if (state.hasAgents) {
      items.push(new MenuItemProperty({ itemName: 'Delete Agents', itemID: MENU.AGENT_DELETE }));
      items.push(new MenuItemProperty({ itemName: 'Run', itemID: MENU.AGENT_RUN }));
    }
  } else {
    // Section switchers (Dictate is already first, so it is not repeated).
    for (const s of SECTIONS) {
      items.push(new MenuItemProperty({ itemName: s.title, itemID: s.menuId }));
    }
  }
  return new MenuContainerProperty({ menuItems: items });
}

export function sectionByMenuId(menuId: number): SectionDef | undefined {
  return SECTIONS.find((s) => s.menuId === menuId);
}

// ── Layout + content limits (font-measurement: line height 27px, 288 canvas) ─
// ~10 rendered lines fit on the 288px canvas at 27px line height — the todo
// window and doc pages are sized to stay under it so the OS never scrolls.
/** Hard G2 OS cap for create + upgrade content (UTF-8 bytes). */
export const MAX_CONTENT_BYTES = 999;
const TODO_ITEM_TEXT = 38; // chars per todo line so each item stays on 1 line
const VISIBLE_ITEMS = 6; // todo rows in the cursor window
// docs/notes: each page MUST fit the ~10-line screen (27px lines, 288px canvas)
// or the OS scrolls the container and swallows the swipe (no page flip). Page
// size is measured with @evenrealities/pretext to match the LVGL renderer —
// box-drawing glyphs are wide, so rough char estimates overflow.
const INNER_W = 568; // 576 - 2 * paddingLength(4)
const PAGE_BODY_LINES = 9; // body lines per page; compact 1-line header above
const PAGE_BYTES = 900; // body byte budget per page (≤ 999 - header)

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/** Byte-length-safe slice that never splits a multi-byte character. */
function cutAtBytes(s: string, n: number): number {
  if (utf8ByteLength(s) <= n) return s.length;
  let i = 0;
  let len = 0;
  for (const ch of s) {
    const bl = utf8ByteLength(ch);
    if (len + bl > n) break;
    i += ch.length;
    len += bl;
  }
  return i;
}

export function clipBytes(s: string, n: number): string {
  return s.slice(0, cutAtBytes(s, n));
}

/** Rendered line count of the given page text (LVGL-accurate via pretext). */
function pageLineCount(lines: string[]): number {
  try {
    return measureTextWrap(lines.join('\n'), INNER_W).lineCount;
  } catch {
    return lines.length;
  }
}

/** Split long text into pages that each fit the screen (line- and byte-aware). */
function pageText(text: string): string[] {
  const pages: string[] = [];
  let page: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (page.length) {
      pages.push(page.join('\n'));
      page = [];
      bytes = 0;
    }
  };
  for (const line of text.split('\n')) {
    const bl = utf8ByteLength(line);
    const fits = bl <= PAGE_BYTES && pageLineCount([line]) <= PAGE_BODY_LINES;
    if (fits) {
      const candidate = [...page, line];
      const nb = bytes + bl + (page.length ? 1 : 0);
      if (page.length && (pageLineCount(candidate) > PAGE_BODY_LINES || nb > PAGE_BYTES)) {
        // Page full — start a new page with just this line (bytes must reset to
        // THIS line's size, not the stale pre-flush total, or every later line
        // trips the byte budget and pages degenerate to one line each).
        flush();
        page.push(line);
        bytes = bl;
        continue;
      }
      page.push(line);
      bytes = nb;
      continue;
    }
    // Oversized single line — split it into pieces that each fit the screen.
    flush();
    let rest = line;
    while (rest) {
      let lo = 1;
      let hi = rest.length;
      let best = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const piece = rest.slice(0, mid);
        if (
          utf8ByteLength(piece) <= PAGE_BYTES &&
          pageLineCount([piece]) <= PAGE_BODY_LINES
        ) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      // Avoid splitting a surrogate pair.
      while (best < rest.length) {
        const c = rest.charCodeAt(best);
        if (c >= 0xdc00 && c <= 0xdfff) best++;
        else break;
      }
      pages.push(rest.slice(0, best));
      rest = rest.slice(best);
    }
  }
  flush();
  return pages.length ? pages : ['(empty)'];
}

/** Result of rendering the active section for the single glasses container. */
export interface SectionView {
  text: string;
  /** Clamped todo cursor (todo section only). */
  todoCursor: number;
  canPrev: boolean;
  canNext: boolean;
}

function todoView(items: TodoItem[], cursor: number): SectionView {
  if (items.length === 0) {
    return {
      text: clipBytes(
        'To-Do\n------------------\n(no tasks — add from web)\n▲▼ move · tap toggle',
        MAX_CONTENT_BYTES,
      ),
      todoCursor: 0,
      canPrev: false,
      canNext: false,
    };
  }
  const clamped = Math.min(items.length - 1, Math.max(0, cursor));
  const half = Math.floor(VISIBLE_ITEMS / 2);
  let start = Math.max(0, clamped - half);
  let end = Math.min(items.length, start + VISIBLE_ITEMS);
  start = Math.max(0, end - VISIBLE_ITEMS);

  const pending = items.filter((t) => !t.done).length;
  const lines: string[] = [`To-Do ${clamped + 1}/${items.length} · ${pending} open`];
  for (let i = start; i < end; i++) {
    const t = items[i];
    const sel = i === clamped ? '▶' : ' ';
    lines.push(`${sel} ${i + 1}. ${t.done ? '[x]' : '[ ]'} ${truncate(t.text, TODO_ITEM_TEXT)}`);
  }
  lines.push('▲▼ move · tap toggle');
  return {
    text: clipBytes(lines.join('\n'), MAX_CONTENT_BYTES),
    todoCursor: clamped,
    canPrev: clamped > 0,
    canNext: clamped < items.length - 1,
  };
}

function bodyView(title: string, raw: string, page: number): SectionView {
  const body = (raw || '').trim() || '(empty)';
  const pages = pageText(body);
  const idx = Math.min(pages.length - 1, Math.max(0, page));
  const head = truncate(title, 24);
  // Compact 1-line header (no divider/footer) so the measured body page fits.
  const header = pages.length > 1 ? `${head} ${idx + 1}/${pages.length}` : head;
  return {
    text: clipBytes(`${header}\n${pages[idx]}`, MAX_CONTENT_BYTES),
    todoCursor: 0,
    canPrev: idx > 0,
    canNext: idx < pages.length - 1,
  };
}

function docView(state: HubState, page: number): SectionView {
  const doc = activeDoc(state);
  if (!doc) {
    return {
      text: clipBytes(
        'Docs\n------------------\n(no docs yet — long-press for\nNew Doc, or create one on\nthe web app)',
        MAX_CONTENT_BYTES,
      ),
      todoCursor: 0,
      canPrev: false,
      canNext: false,
    };
  }
  return bodyView(doc.title, doc.content, page);
}

/** Render the active section (todo cursor window, active-doc page, or notes). */
export function sectionView(state: HubState, todoCursor: number, docPage: number): SectionView {
  const section = state.activeSection;
  if (section === 'todo') return todoView(state.sections.todo, todoCursor);
  if (section === 'docs') return docView(state, docPage);
  return bodyView(sectionTitle('notes'), state.sections.notes, docPage);
}

/** In-app doc picker list (long-press → Select/Delete Doc). Ring navigates. */
export function docPickerView(
  docs: DocEntry[],
  cursor: number,
  intent: 'open' | 'delete',
): SectionView {
  const label = intent === 'delete' ? 'Delete doc' : 'Open doc';
  if (docs.length === 0) {
    return {
      text: clipBytes(
        `${label}\n------------------\n(no docs yet — long-press for\nNew Doc, or create one on\nthe web app)`,
        MAX_CONTENT_BYTES,
      ),
      todoCursor: 0,
      canPrev: false,
      canNext: false,
    };
  }
  const clamped = Math.min(docs.length - 1, Math.max(0, cursor));
  const half = Math.floor(VISIBLE_ITEMS / 2);
  let start = Math.max(0, clamped - half);
  let end = Math.min(docs.length, start + VISIBLE_ITEMS);
  start = Math.max(0, end - VISIBLE_ITEMS);

  const lines: string[] = [`${label} ${clamped + 1}/${docs.length}`];
  for (let i = start; i < end; i++) {
    const sel = i === clamped ? '▶' : ' ';
    lines.push(`${sel} ${i + 1}. ${truncate(docs[i].title || '(untitled)', TODO_ITEM_TEXT)}`);
  }
  lines.push(intent === 'delete' ? '▲▼ move · tap delete' : '▲▼ move · tap open');
  return {
    text: clipBytes(lines.join('\n'), MAX_CONTENT_BYTES),
    todoCursor: clamped,
    canPrev: clamped > 0,
    canNext: clamped < docs.length - 1,
  };
}

// ── Agents: master–detail ────────────────────────────────────────────────────
// Two text containers on the 576×288 canvas: a narrow master list on the left
// and the detail/output pane on the right. Exactly ONE container may be
// isEventCapture:1, so the R1 ring is routed by an app-level focus flag rather
// than by which container received the event (see main.ts).
export type AgentFocus = 'master' | 'detail';

/** Panel geometry — the master list is narrow, the output pane takes the rest. */
export const AGENT_LAYOUT = {
  masterX: 0,
  masterW: 200,
  detailX: 208,
  detailW: 368,
  height: 288,
} as const;

const AGENT_ITEM_TEXT = 15; // chars per master row (200px panel)
const AGENT_ROWS = 7; // visible master rows

export interface AgentsView {
  /** Left panel: the agent list. */
  master: string;
  /** Right panel: the selected agent's output. */
  detail: string;
  /** Clamped agent cursor. */
  cursor: number;
  /** Clamped index into the selected agent's sessions (0 = newest). */
  sessionCursor: number;
  canPrev: boolean;
  canNext: boolean;
}

export interface AgentsViewInput {
  agents: AgentDef[];
  sessions: AgentSession[];
  cursor: number;
  focus: AgentFocus;
  /** Index of the session shown in the detail pane (0 = newest). */
  sessionCursor?: number;
  /** Transient status line while a run is in flight ("Thinking…"). */
  status?: string;
}

/** Left panel: numbered agent list with a ▶ cursor on the highlighted agent. */
function agentListView(agents: AgentDef[], cursor: number, focus: AgentFocus): string {
  const head = `Agents ${agents.length}${focus === 'master' ? ' ◀' : ''}`;
  if (agents.length === 0) {
    return clipBytes(
      `${head}\n------------------\n(no agents yet — long-press\nfor New Agents, or build one\nin the web app)`,
      MAX_CONTENT_BYTES,
    );
  }
  const clamped = Math.min(agents.length - 1, Math.max(0, cursor));
  const half = Math.floor(AGENT_ROWS / 2);
  let start = Math.max(0, clamped - half);
  const end = Math.min(agents.length, start + AGENT_ROWS);
  start = Math.max(0, end - AGENT_ROWS);

  const lines: string[] = [head];
  for (let i = start; i < end; i++) {
    const sel = i === clamped ? '▶' : ' ';
    lines.push(`${sel}${i + 1}.${truncate(agents[i].name || '(unnamed)', AGENT_ITEM_TEXT)}`);
  }
  lines.push(focus === 'master' ? '▲▼ move' : 'Select Agents');
  return clipBytes(lines.join('\n'), MAX_CONTENT_BYTES);
}

/** Right panel: the selected agent's setup + the chosen session output. */
function agentDetailView(
  agent: AgentDef | null,
  sessions: AgentSession[],
  toolNames: string[],
  sessionCursor: number,
  status: string,
): string {
  if (!agent) {
    return clipBytes(
      'Agents\n------------------\nSelect or create an agent\nfrom the menu, or build one\nin the web app.',
      MAX_CONTENT_BYTES,
    );
  }
  const mine = sessions.filter((s) => s.agentId === agent.id);
  const idx = mine.length ? Math.min(mine.length - 1, Math.max(0, sessionCursor)) : 0;
  const latest = mine[idx] ?? null;
  const tools = toolNames.length ? toolNames.join(', ') : 'none';
  const lines: string[] = [
    truncate(agent.name || '(unnamed)', 26),
    `tools: ${truncate(tools, 30)}`,
    '------------------',
  ];
  if (status) lines.push(status);
  else if (!latest) lines.push('No sessions yet.\nLong-press → Run to ask.');
  else {
    const answer =
      [...latest.messages].reverse().find((m) => m.role === 'assistant' && !m.tool)?.content ?? '';
    const body = answer.trim() || '(no answer)';
    // Fit roughly 6-7 lines of the 368px pane; clip on a byte boundary.
    const clipped = clipBytes(body, 360);
    lines.push(clipped + (clipped.length < body.length ? '…' : ''));
    lines.push(
      `— session ${idx + 1}/${mine.length} · ${latest.status}${mine.length > 1 ? ' · ▲▼ browse' : ''}`,
    );
  }
  return clipBytes(lines.join('\n'), MAX_CONTENT_BYTES);
}

/**
 * Render the Agents master–detail panes. The contextual menu is how the user
 * moves control between them: "Select Agents" puts the ring on the master list,
 * picking an agent moves it to the detail pane.
 *
 * `nameOf` resolves a tool id to its display name — injected so this module
 * stays free of store imports.
 */
export function agentsMasterDetailView(
  input: AgentsViewInput,
  nameOf: (id: string) => string = (id) => id,
): AgentsView {
  const { agents, sessions, focus } = input;
  const clamped = agents.length ? Math.min(agents.length - 1, Math.max(0, input.cursor)) : 0;
  const agent = agents[clamped] ?? null;
  const toolNames = agent ? agent.toolIds.map(nameOf).filter(Boolean) : [];
  const mine = agent ? sessions.filter((s) => s.agentId === agent.id) : [];
  const sessionCursor = mine.length
    ? Math.min(mine.length - 1, Math.max(0, input.sessionCursor ?? 0))
    : 0;
  return {
    master: agentListView(agents, clamped, focus),
    detail: agentDetailView(agent, sessions, toolNames, sessionCursor, input.status ?? ''),
    cursor: clamped,
    sessionCursor,
    canPrev: clamped > 0,
    canNext: clamped < agents.length - 1,
  };
}

/** One-line status for the master footer (e.g. "running…"). */
export function agentsStatusLine(running: boolean, error?: string): string {
  if (error) return `⚠️ ${truncate(error, 30)}`;
  return running ? 'Thinking…' : '';
}
