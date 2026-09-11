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
import { monitorAge } from './ai/monitor';
import type { MonitorView } from './ai/monitor';
import { pageTitle } from './ai/registry';
import type { AiState } from './ai/store';
import type { PageId } from './ai/types';
import {
  activeDoc,
  orderedAgents,
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
  BACK: 21,  // Agents-tab actions. Select / New / Delete live in the WEB app now, so the
  // glasses menu only carries the run controls; ids 30–33 stay reserved so an
  // installed page with the previous menu still maps to something sensible.
  /** Run the selected agent's SAVED prompt (no dictation needed). */
  AGENT_TRIGGER: 34,
  /** Cancel the in-flight run. */
  AGENT_STOP: 35,
  /**
   * Jarvis: speak ONE sentence and let the AI agent work out which page and
   * which actions it needs. It is the FIRST item in every menu — same trigger,
   * same speech engine and same listen-then-act flow as Dictate (which is now
   * always LAST), so the difference the user feels is only in what happens
   * after they stop talking. Starting it also opens a CONVERSATION: when a turn
   * finishes the mic is re-armed so the next sentence needs no menu trip.
   */
  JARVIS: 30,
  /**
   * Stop the AI turn / end the Jarvis conversation; also declines a pending
   * destructive action. Shown as long as the agent is running, waiting on a
   * confirmation, or listening between turns — one of the two deliberate exits
   * from a conversation (the other is a double-tap).
   */
  JARVIS_STOP: 31,
  /** Revert the whole previous AI batch. Only shown while one exists. */
  UNDO_AI: 32,
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
  /** True while the Jarvis agent is running or waiting on a confirmation. */
  aiRunning?: boolean;
  /**
   * True while a Jarvis CONVERSATION is open but no turn is in flight — i.e.
   * the mic is re-armed, or the last reply is still on screen waiting to be
   * superseded. Distinguishing this from `aiRunning` is what lets "Undo AI"
   * stay reachable between turns (it would fight a live run for the same hand,
   * but merely talking to the agent is exactly when a revert is wanted).
   */
  aiListening?: boolean;
  /** True once an AI batch can be reverted → show "Undo AI". */
  aiUndo?: boolean;
}

/**
 * Build the OS contextual menu for the current state — reusable and
 * state-aware. The order is fixed and deliberate:
 *
 *   1. **Jarvis** (→ "Stop AI" while a run is live or a conversation is open)
 *      — the flagship action, so a long-press reaches it first.
 *   2. **Undo AI** — only while a revertible batch exists and nothing is
 *      running; the recovery for a wrong AI action, kept next to the way in.
 *   3. **Back** — wherever it applies (docs, agents). The escape hatch sits
 *      above the page's own actions so it is never the item you scroll past.
 *   4. **The page's own actions**, in this tab's order:
 *      • Docs → New Docs · Select Docs · Delete Docs
 *      • Agents → Trigger (becomes Stop while a run is in flight)
 *      • Any other tab → the To-Do · Docs · Notes · Agents switchers
 *   5. **Dictate** — always LAST. Same trigger, same speech engine as Jarvis;
 *      the difference is that the sentence is typed into the page instead of
 *      being routed through the agent. Keeping it last means the raw,
 *      no-undo path is the one you must reach for deliberately.
 *
 * The menu is applied on the startup page and REPLACED wholesale on every
 * `rebuildPageContainer`, so call this with the current state whenever the
 * active section (or collection count) changes. Items sit between the system
 * slots (Display off / Brightness on top, "Close Reality Hub" at the bottom).
 * Max 10 items.
 */
export function sectionMenu(state: MenuState): MenuContainerProperty {
  const items: MenuItemProperty[] = [
    // 1. Jarvis: same trigger, same speech flow — the only difference is that
    // the sentence is routed through the agent. While a run is live OR a
    // conversation is open the item flips to Stop so there is always a way out
    // of the HUD. (There is no "cancel the confirm" gesture on the glasses, so
    // this item is also what declines a pending destructive action, and it is
    // the deliberate way to end a Jarvis conversation.)
    state.aiRunning || state.aiListening
      ? new MenuItemProperty({ itemName: 'Stop AI', itemID: MENU.JARVIS_STOP })
      : new MenuItemProperty({ itemName: 'Jarvis', itemID: MENU.JARVIS }),
  ];
  // 2. Undo is offered only when there is actually something to revert, so the
  // destructive path always has a visible way back without cluttering the menu.
  if (state.aiUndo && !state.aiRunning) {
    items.push(new MenuItemProperty({ itemName: 'Undo AI', itemID: MENU.UNDO_AI }));
  }
  if (state.section === 'docs') {
    // 3. Escape hatch first, then this tab's actions — Back returns to the last
    // non-special tab.
    items.push(new MenuItemProperty({ itemName: 'Back', itemID: MENU.BACK }));
    items.push(new MenuItemProperty({ itemName: 'New Docs', itemID: MENU.DOC_NEW }));
    if (state.hasDocs) {
      items.push(new MenuItemProperty({ itemName: 'Select Docs', itemID: MENU.DOC_SELECT }));
      items.push(new MenuItemProperty({ itemName: 'Delete Docs', itemID: MENU.DOC_DELETE }));
    }
  } else if (state.section === 'agents') {
    // Back is the ONLY way off this tab (the switchers are hidden here), so it
    // stays — and per the fixed menu order it sits directly after the AI group,
    // above the run control. Then the run control: Trigger fires the highlighted
    // agent's SAVED prompt server-side (so it keeps running if the glasses page
    // is backgrounded) and streams the transcript back into the detail panel.
    // The master↔detail move is a gesture now (tap in, double-tap back), so
    // Select/New/Delete Agents are gone and the menu stays short.
    items.push(new MenuItemProperty({ itemName: 'Back', itemID: MENU.BACK }));
    if (state.hasAgents) {
      items.push(
        state.agentRunning
          ? new MenuItemProperty({ itemName: 'Stop', itemID: MENU.AGENT_STOP })
          : new MenuItemProperty({ itemName: 'Trigger', itemID: MENU.AGENT_TRIGGER }),
      );
    }
  } else {
    // Section switchers — the page core for the plain tabs, after Back (there
    // is nothing to go back to from here, so Back is absent by design).
    for (const s of SECTIONS) {
      items.push(new MenuItemProperty({ itemName: s.title, itemID: s.menuId }));
    }
  }
  // 5. Dictate LAST, and unconditional: it is the one entry that must never be
  // trimmed, because it is the raw (agent-free) path into the page.
  items.push(new MenuItemProperty({ itemName: 'Dictate', itemID: MENU.DICTATE }));
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

/**
 * Jarvis HUD — the full-screen overlay shown while the AI agent is working.
 *
 * Design notes (576×288, 4-bit greyscale, ~10 lines, 999-byte cap):
 *   • The FIRST line always says what the glasses are doing (working / confirm /
 *     done / failed) so the mode is never ambiguous when a page is redrawn.
 *   • The routing line (`→ <Page>`) is the visible proof of tool-call LAYER 1:
 *     the user watches the agent navigate, which is what makes multi-page
 *     requests understandable instead of "it did something somewhere". It shows
 *     the CURRENT page from the first turn on — a run that never navigates is
 *     still acting on a page, and that is exactly the fact the user needs.
 *   • The reasoning lines (`> …`) are the chain of thought: what the model said
 *     to itself before choosing an action. They are the model's own words, not
 *     our loop's labels, and they are interleaved with results in the order they
 *     happened so the HUD reads as a transcript.
 *   • Action results use ASCII marks ONLY. `▸`, `✓` and `⚠` are NOT in the
 *     firmware font (see SAFE_NON_ASCII) and would render as tofu boxes.
 *   • Destructive actions put their target on screen before the tap: a
 *     confirmation the user cannot read is not a confirmation.
 */
export interface AiViewOptions {
  /**
   * True while a Jarvis CONVERSATION is open — the mic is re-armed after this
   * turn, so the footer offers "speak again" instead of "dismiss". Only the
   * footer changes; the conversation itself is owned by the platform layer.
   */
  conversing?: boolean;
  /**
   * The runs Jarvis started and is watching (see ./ai/monitor). Drawn as a
   * strip at the BOTTOM of the HUD: the ring scrolls it, so the wearer can
   * check on a background run without leaving the conversation. Omitted when
   * nothing is being watched, in which case the HUD is exactly as it was.
   */
  queue?: MonitorView;
}

export function aiView(ai: AiState, opts: AiViewOptions = {}): SectionView {
  // A mirrored run is being driven from the phone panel. The controls have to
  // say so: offering "tap R1 = run" on a run this device cannot execute reads as
  // a dead button, and a confirmation answered in the wrong place is worse than
  // one never shown.
  const remote = ai.mirrored;
  // A conversation only exists on the surface that owns the loop — a mirror has
  // no mic to re-arm, so it keeps the plain dismiss hint.
  const conversing = !!opts.conversing && !remote;
  const head =
    ai.status === 'confirm'
      ? 'JARVIS · CONFIRM'
      : ai.status === 'done'
        ? 'JARVIS · done'
        : ai.status === 'error'
          ? 'JARVIS · failed'
          : `JARVIS · working ${Math.max(1, ai.turn)}/${Math.max(1, ai.maxSteps)}`;
  const body: string[] = [];
  // A queue with nothing in it must not change the HUD at all — the strip is
  // additive, never a permanently empty section.
  const queue = opts.queue && opts.queue.rows.length ? opts.queue : null;
  const scrollable = !!queue && queue.rows.length > 1;
  // `2x = end` is not decoration: it is the only exit that does not cost a
  // menu trip, and the menu's own exit is the first item ("Stop AI").
  const dismissHint =
    (conversing ? 'tap R1 = speak again · 2x = end' : 'tap R1 = dismiss') +
    (scrollable ? ' · scroll = sessions' : '');

  if (ai.status === 'confirm' && ai.pending) {
    body.push(...wrapToWidth(stripUnsupported(ai.pending.title).trim(), INNER_W).slice(0, 2));
    for (const line of ai.pending.lines.slice(0, 2)) {
      body.push(...wrapToWidth(stripUnsupported(line).trim(), INNER_W).slice(0, 1));
    }
    body.push('', remote ? 'from phone · tap = cancel' : 'tap R1 = run · Stop = cancel');
  } else if (ai.status === 'done') {
    body.push(...wrapToWidth(stripUnsupported(ai.result || 'Done').trim(), INNER_W).slice(0, 3));
    body.push('', remote ? 'from phone · tap = dismiss' : dismissHint);
  } else if (ai.status === 'error') {
    body.push(...wrapToWidth(stripUnsupported(ai.error || 'Something went wrong').trim(), INNER_W).slice(0, 3));
    body.push('', remote ? 'from phone · tap = dismiss' : dismissHint);
  } else {
    const said = stripUnsupported(ai.utterance).replace(/\s+/g, ' ').trim();
    if (said) body.push(truncate(`"${said}"`, 42));
    // Layer 1, always on screen. The seed step carries the raw page id (it is
    // written by aiBegin), later ones a title — resolve both through the
    // registry so the line reads the same way the companion panel prints it.
    const focuses = ai.steps.filter((s) => s.kind === 'focus');
    const current = focuses[focuses.length - 1];
    if (current) {
      const label = stripUnsupported(pageTitle(current.text as PageId)).trim() || current.text;
      body.push(`→ ${label}`);
    }
    // Chain of thought + results, newest last, interleaved in the order the
    // model produced them. `think` is the model's own reasoning, the rest are
    // our loop's labels for what it did.
    const shown = ai.steps
      .filter(
        (s) => s.kind === 'think' || s.kind === 'ok' || s.kind === 'fail' || s.kind === 'note',
      )
      // The queue strip costs lines, and the canvas holds ~10. Give it its own
      // room rather than letting a chatty run push it off the bottom.
      .slice(queue ? -2 : -3);
    for (const s of shown) {
      const mark = s.kind === 'ok' ? '·' : s.kind === 'fail' ? '!' : s.kind === 'think' ? '>' : '-';
      body.push(truncate(`${mark} ${stripUnsupported(s.text).replace(/\s+/g, ' ').trim()}`, 44));
    }
    if (!shown.length) body.push('··· thinking');
    body.push('', remote ? 'from phone · tap = stop' : 'tap R1 = stop action');
  }

  // The watched-session strip. `confirm` is excluded on purpose: a destructive
  // prompt is the one screen where nothing else may compete for attention.
  // The cursor row is the one the ring points at, and its `latest` is the whole
  // reason to scroll — "done" alone never told anyone anything.
  if (queue && ai.status !== 'confirm') {
    const rows = queue.rows;
    const at = Math.min(rows.length - 1, Math.max(0, queue.cursor));
    const row = rows[at];
    body.push(
      scrollable
        ? `sessions ${at + 1}/${rows.length}${queue.unread ? ` · ${queue.unread} new` : ''}`
        : `session${queue.unread ? ' · new' : ''}`,
    );
    // Only the row the ring points at is drawn, and `>` is how every other list
    // in this app marks its selection — including the doc picker. The position
    // line above (`sessions 2/3`) is what says which one that is.
    body.push(
      truncate(
        `> ${row.label} · ${row.status} · ${monitorAge(row.updatedAt)}${row.unread ? ' · NEW' : ''}`,
        44,
      ),
    );
    if (row.latest) body.push(truncate(`  ${row.latest}`, 44));
  }

  return {
    text: clipBytes(`${head}\n------------------\n${body.join('\n')}`, MAX_CONTENT_BYTES),
    todoCursor: 0,
    canPrev: false,
    canNext: false,
  };
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
      `${head}\n------------------\n(no agents yet — build one\nin the web app)`,
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
  lines.push(focus === 'master' ? '▲▼ move · tap open' : 'double-tap = back');
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
        'Agents\n------------------\nNo agent selected.\nBuild one in the web app.',
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
  const { sessions, focus } = input;
  // The list is ALWAYS shown newest-updated-first. The master cursor indexes
  // THIS order, so main.ts selects from the same ordered list (see
  // agentSelected / agentContainers).
  const agents = orderedAgents(input.agents);
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
