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
  /** Legacy id for the old dictation-based Run item. */
  AGENT_RUN: 33,
  /** Run the selected agent's SAVED prompt (no dictation needed). */
  AGENT_TRIGGER: 34,
  /** Cancel the in-flight run. */
  AGENT_STOP: 35,
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
  /** Whether any agents exist (Select/Delete/Trigger need at least one). */
  hasAgents?: boolean;
  /** True while a server-side agent run is in flight → show Stop instead. */
  agentRunning?: boolean;
}

/**
 * Build the OS contextual menu for the current state — reusable and
 * state-aware:
 *
 *   • **Dictate is always the FIRST item** so a long-press reaches it instantly.
 *   • **Docs tab** → Dictate · Back · New Docs · Select Docs · Delete Docs.
 *   • **Agents tab** → Dictate · Back · Select Agents · New Agents · Delete Agents
 *     · Trigger (becomes Stop while a run is in flight). Trigger runs the
 *     agent's SAVED prompt — no dictation needed on this tab.
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
    // Agents-scoped actions only. Select moves the ring to the master panel;
    // Trigger fires the highlighted agent's SAVED prompt server-side (so it
    // keeps running if the glasses page is backgrounded) and streams the
    // transcript back into the detail panel.
    items.push(new MenuItemProperty({ itemName: 'Back', itemID: MENU.BACK }));
    items.push(new MenuItemProperty({ itemName: 'Select Agents', itemID: MENU.AGENT_SELECT }));
    items.push(new MenuItemProperty({ itemName: 'New Agents', itemID: MENU.AGENT_NEW }));
    if (state.hasAgents) {
      items.push(new MenuItemProperty({ itemName: 'Delete Agents', itemID: MENU.AGENT_DELETE }));
      items.push(
        state.agentRunning
          ? new MenuItemProperty({ itemName: 'Stop', itemID: MENU.AGENT_STOP })
          : new MenuItemProperty({ itemName: 'Trigger', itemID: MENU.AGENT_TRIGGER }),
      );
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

/** True when `s` renders on a single line at the given pixel width. */
function lineFits(s: string, width: number): boolean {
  try {
    return measureTextWrap(s, width).lineCount <= 1;
  } catch {
    return utf8ByteLength(s) <= 40;
  }
}

/**
 * Split one logical line into pieces that EACH render on exactly one line at
 * `width`. Word wrap cannot break a long unbroken token (a URL, a long CJK
 * run), which would otherwise overflow the pane and blow the byte budget — so
 * hard-split those on the pixel boundary.
 */
function splitAtWidth(s: string, width: number): string[] {
  if (!s) return [''];
  if (lineFits(s, width)) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest) {
    let lo = 1;
    let hi = rest.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineFits(rest.slice(0, mid), width)) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // Never split a surrogate pair (an emoji would render as a broken box).
    while (best < rest.length) {
      const c = rest.charCodeAt(best);
      if (c >= 0xdc00 && c <= 0xdfff) best++;
      else break;
    }
    out.push(rest.slice(0, best));
    rest = rest.slice(best);
  }
  return out;
}

/** Line + byte budget for one screen of text. */
interface PageBudget {
  /** Pixel width the text is laid out in. */
  width: number;
  /** Rendered lines that fit. */
  lines: number;
  /** UTF-8 byte cap for the page (stays under the 999-byte OS limit). */
  bytes: number;
}

/**
 * Pack logical lines into screen-sized pages. Each logical line is first split
 * so that every entry occupies exactly ONE rendered line, which reduces packing
 * to a count + byte-budget loop (no per-candidate re-measurement).
 */
function paginateLines(rawLines: readonly string[], budget: PageBudget): string[] {
  const lines: string[] = [];
  for (const l of rawLines) lines.push(...splitAtWidth(l, budget.width));
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
  for (const line of lines) {
    const bl = utf8ByteLength(line);
    // Page full — the byte budget must reset to THIS line's size, not the stale
    // pre-flush total, or every later line trips it and pages degenerate.
    if (page.length && (page.length >= budget.lines || bytes + 1 + bl > budget.bytes)) flush();
    page.push(line);
    bytes += (page.length > 1 ? 1 : 0) + bl;
  }
  flush();
  return pages.length ? pages : [''];
}

/** Split long text into pages that each fit the screen (line- and byte-aware). */
function pageText(text: string): string[] {
  return paginateLines(text.split('\n'), {
    width: INNER_W,
    lines: PAGE_BODY_LINES,
    bytes: PAGE_BYTES,
  });
}

/** Join parts with " · " while the result stays within `max` characters. */
function joinFit(parts: readonly string[], max: number): string {
  let out = '';
  for (const p of parts) {
    const next = out ? `${out} · ${p}` : p;
    if (next.length > max) break;
    out = next;
  }
  return out;
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
  // `stripUnsupported` drops emoji the firmware font cannot draw; they would
  // otherwise show as tofu boxes and still consume the byte budget.
  const body = stripUnsupported(raw || '').trim() || '(empty)';
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
  /** Clamped page of the detail pane's transcript (0 = newest). */
  detailPage: number;
  /** Total pages available in the detail pane (>= 1). */
  detailPages: number;
  canPrev: boolean;
  canNext: boolean;
}

/** Minimal shape of a live run — kept local so this module stays store-free. */
export interface LiveRun {
  id: string;
  status: string;
  statusText: string;
  error?: string;
  messages: { role: string; content: string; tool?: string }[];
}

export interface AgentsViewInput {
  agents: AgentDef[];
  sessions: AgentSession[];
  cursor: number;
  focus: AgentFocus;
  /** Index of the session shown in the detail pane (0 = newest). */
  sessionCursor?: number;
  /** Page of that session's transcript (0 = newest). */
  detailPage?: number;
  /** Transient status line while a run is in flight ("Thinking…"). */
  status?: string;
  /** The relay-owned live run for the selected agent, if any. */
  run?: LiveRun | null;
}

/** Inner width of the 368px detail panel (paddingLength 4 each side). */
const DETAIL_W = 360;
/** Body lines a live (streaming) run shows under the 3-line header. */
const DETAIL_LINES = 7;

/** Greedy word-wrap to a pixel width, LVGL-accurate via pretext. */
function wrapToWidth(s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      let lines = 1;
      try {
        lines = measureTextWrap(next, width).lineCount;
      } catch {
        lines = 1;
      }
      if (lines > 1 && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Characters the firmware font is known to draw. Anything outside this set
 * (emoji, most pictographs) renders as an empty tofu box AND still costs its
 * UTF-8 bytes against the 999-byte container cap, so strip it from text that
 * arrives from the network (tool results, model output) before paginating.
 */
const SAFE_NON_ASCII = new Set([
  ...'─━│┌┐└┘├┤┬┴┼╭╮╯╰═║▲△▶▷▼▽◀◁●○■□▪▫★☆·•‣–—―…′″→←↑↓↔≤≥≠±×÷−°§¶†‡',
  ...'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿŒœß',
  ...'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω',
  ...'“”‘’«»„',
]);

function stripUnsupported(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x7f || SAFE_NON_ASCII.has(ch)) out += ch;
  }
  return out;
}

/**
 * Flatten a transcript into wrapped lines, NEWEST turn first. Each entry is
 * prefixed with a label so the glasses and the browser read alike (`You:` /
 * `[tool]`). Reversing here (rather than slicing the tail) is what makes the
 * pane paginatable: page 0 is always the newest turn, and older turns are one
 * swipe further back.
 *
 * Labels stay ASCII on purpose, and `stripUnsupported` removes any emoji the
 * model or a search result embedded: the firmware font has no glyph for them,
 * so they would draw as tofu boxes and waste the byte budget.
 */
function transcriptLines(messages: readonly { role: string; content: string; tool?: string }[]) {
  const out: string[] = [];
  for (const m of [...messages].reverse()) {
    const label = m.role === 'user' ? 'You: ' : m.role === 'tool' ? `[${m.tool ?? 'tool'}] ` : '';
    const text = stripUnsupported(`${label}${m.content}`).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push(...wrapToWidth(text, DETAIL_W));
  }
  return out;
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

/** Detail pane: body text plus the pagination state it produced. */
interface DetailRender {
  text: string;
  page: number;
  pages: number;
}

/** Rendered lines the 288px canvas holds at the fixed 27px line height. */
const DETAIL_MAX_LINES = 10;
/** Header (name / tools / divider) above the body on a single-page view. */
const DETAIL_HEAD_LINES = 3;
/** Body lines under that header, reserving one line for the footer. */
const DETAIL_BODY_LINES = DETAIL_MAX_LINES - DETAIL_HEAD_LINES - 1;
/** Body lines when the header collapses to one line (multi-page transcripts). */
const DETAIL_COMPACT_BODY_LINES = DETAIL_MAX_LINES - 2;
/** Body byte budget per page (999 OS cap − header, name and tools line). */
const DETAIL_PAGE_BYTES = 820;

/** Right panel: the selected agent's setup + live run output or chosen session. */
function agentDetailView(
  agent: AgentDef | null,
  sessions: AgentSession[],
  toolNames: string[],
  sessionCursor: number,
  detailPage: number,
  status: string,
  run?: LiveRun | null,
): DetailRender {
  if (!agent) {
    return {
      text: clipBytes(
        'Agents\n------------------\nSelect or create an agent\nfrom the menu, or build one\nin the web app.',
        MAX_CONTENT_BYTES,
      ),
      page: 0,
      pages: 1,
    };
  }
  const mine = sessions.filter((s) => s.agentId === agent.id);
  const idx = mine.length ? Math.min(mine.length - 1, Math.max(0, sessionCursor)) : 0;
  const latest = mine[idx] ?? null;
  const tools = toolNames.length ? toolNames.join(', ') : 'none';
  const head = [
    truncate(agent.name || '(unnamed)', 26),
    `tools: ${truncate(tools, 30)}`,
    '------------------',
  ];

  const compactHead = truncate(`${agent.name || '(unnamed)'} · ${idx + 1}/${mine.length}`, 22);

  const render = (bodyLines: string[], footer: string, budget: PageBudget): DetailRender => {
    const first = paginateLines(bodyLines, budget);
    // A transcript that does not fit one screen collapses the 3-line header to
    // a single line, which frees two more rendered lines for the content.
    let pages = first;
    let header = head;
    if (first.length > 1) {
      const packed = paginateLines(bodyLines, { ...budget, lines: budget.lines + 2 });
      if (packed.length > 1) {
        pages = packed;
        header = [compactHead];
      }
    }
    const p = Math.min(pages.length - 1, Math.max(0, detailPage));
    const more = pages.length > 1 ? ` (${p + 1}/${pages.length})` : '';
    const tail = footer ? `${footer}${more}` : more.trim();
    const lines = tail ? [...header, pages[p], tail] : [...header, pages[p]];
    return { text: clipBytes(lines.join('\n'), MAX_CONTENT_BYTES), page: p, pages: pages.length };
  };

  // A live run owns the pane while it is in flight — newest turn on page 0.
  if (run && run.status === 'running') {
    return render(
      [run.statusText || status || 'Thinking…', ...transcriptLines(run.messages)],
      '',
      { width: DETAIL_W, lines: DETAIL_LINES, bytes: 860 },
    );
  }
  if (run && run.status === 'error' && !latest) {
    return render(
      [`! ${truncate(run.error ?? 'run failed', 40)}`, ...transcriptLines(run.messages)],
      '',
      { width: DETAIL_W, lines: DETAIL_LINES, bytes: 860 },
    );
  }

  if (status) return { text: clipBytes([...head, status].join('\n'), MAX_CONTENT_BYTES), page: 0, pages: 1 };
  if (!latest) {
    return {
      text: clipBytes(
        [...head, 'No sessions yet.\nLong-press → Trigger to run.'].join('\n'),
        MAX_CONTENT_BYTES,
      ),
      page: 0,
      pages: 1,
    };
  }

  // A stored session pages through the WHOLE transcript (newest first) so the
  // glasses show what the web panel's Transcript shows, not just a clipped
  // answer. The footer is built first so the page budget can reserve its line.
  const footer = joinFit(
    [`${latest.status}`, `session ${idx + 1}/${mine.length}`, '▲▼ pages'],
    40,
  );
  return render(
    transcriptLines(latest.messages),
    footer,
    {
      width: DETAIL_W,
      lines: footer ? DETAIL_BODY_LINES : DETAIL_COMPACT_BODY_LINES,
      bytes: DETAIL_PAGE_BYTES,
    },
  );
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
  const detail = agentDetailView(
    agent,
    sessions,
    toolNames,
    sessionCursor,
    input.detailPage ?? 0,
    input.status ?? '',
    input.run ?? null,
  );
  return {
    master: agentListView(agents, clamped, focus),
    detail: detail.text,
    cursor: clamped,
    sessionCursor,
    detailPage: detail.page,
    detailPages: detail.pages,
    canPrev: clamped > 0,
    canNext: clamped < agents.length - 1,
  };
}

/** One-line status for the master footer (e.g. "running…"). */
export function agentsStatusLine(running: boolean, error?: string): string {
  if (error) return `! ${truncate(error, 30)}`;
  return running ? 'Thinking…' : '';
}
