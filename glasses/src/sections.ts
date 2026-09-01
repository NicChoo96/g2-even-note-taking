import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk';
import type { HubState, SectionId, TodoItem } from './types';

// G2 canvas is 576x288. Title bar on top, content below.
export const TITLE_BAR_H = 32;
const CONTENT_X = 8;
const CONTENT_Y = TITLE_BAR_H + 8;
const CONTENT_W = 576 - CONTENT_X * 2; // 560
const CONTENT_H = 288 - TITLE_BAR_H - 16;

// Max characters for text containers per SDK constraints.
const MAX_CREATE_TEXT = 1000;
const MAX_LIST_ITEMS = 20;
const MAX_ITEM_CHARS = 60;

export interface SectionDef {
  id: SectionId;
  title: string;
  /** uint32 identifier used by the OS contextual menu (must be > 0, unique). */
  menuId: number;
}

/**
 * Expandable section registry — add a new entry here (plus a matching slot in
 * HubState.sections in types.ts) and it shows up in the glasses menu + web UI.
 */
export const SECTIONS: SectionDef[] = [
  { id: 'todo', title: 'To-Do', menuId: 1 },
  { id: 'docs', title: 'Docs', menuId: 2 },
  { id: 'notes', title: 'Notes', menuId: 3 },
];

export function sectionTitle(id: SectionId): string {
  return SECTIONS.find((s) => s.id === id)?.title ?? id;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function titleBar(text: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: TITLE_BAR_H,
    borderWidth: 1,
    borderColor: 10,
    borderRadius: 2,
    paddingLength: 4,
    containerID: 1,
    containerName: 'title',
    isEventCapture: 0,
    zOrderIndex: 1,
    textColor: 4,
    content: text,
  });
}

function textContent(text: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: CONTENT_X,
    yPosition: CONTENT_Y,
    width: CONTENT_W,
    height: CONTENT_H,
    borderWidth: 1,
    borderColor: 6,
    borderRadius: 2,
    paddingLength: 4,
    containerID: 2,
    containerName: 'content',
    isEventCapture: 1,
    zOrderIndex: 2,
    textColor: 4,
    content: truncate(text, MAX_CREATE_TEXT),
  });
}

function todoList(items: TodoItem[]): ListContainerProperty {
  const labels = items
    .slice(0, MAX_LIST_ITEMS)
    .map((t) => `${t.done ? '[x]' : '[ ]'} ${truncate(t.text, MAX_ITEM_CHARS)}`);
  if (labels.length === 0) labels.push('(no tasks — add from web)');
  return new ListContainerProperty({
    xPosition: CONTENT_X,
    yPosition: CONTENT_Y,
    width: CONTENT_W,
    height: CONTENT_H,
    borderWidth: 1,
    borderColor: 6,
    borderRadius: 2,
    containerID: 2,
    containerName: 'todoList',
    isEventCapture: 1,
    zOrderIndex: 2,
    itemContainer: new ListItemContainerProperty({
      itemCount: labels.length,
      itemWidth: 0, // auto-fill container width
      isItemSelectBorderEn: 1, // native selection highlight
      itemName: labels,
    }),
  });
}

/** Native OS contextual menu = the glasses overlay section switcher. */
function sectionMenu(): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: SECTIONS.map(
      (s) => new MenuItemProperty({ itemName: s.title, itemID: s.menuId }),
    ),
  });
}

/** Build the page containers for the current active section. */
export function buildPage(state: HubState): RebuildPageContainer {
  const section = state.activeSection;
  const page = new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [],
    listObject: [],
    menuObject: sectionMenu(),
  });

  if (section === 'todo') {
    page.textObject = [titleBar('To-Do')];
    page.listObject = [todoList(state.sections.todo)];
  } else {
    const text = section === 'docs' ? state.sections.docs : state.sections.notes;
    page.textObject = [titleBar(sectionTitle(section)), textContent(text)];
  }
  return page;
}

/** One-shot startup page (must be called exactly once at boot). */
export function buildStartupPage(state: HubState): CreateStartUpPageContainer {
  const p = buildPage(state);
  return new CreateStartUpPageContainer({
    containerTotalNum: p.containerTotalNum,
    listObject: p.listObject,
    textObject: p.textObject,
    imageObject: p.imageObject,
    menuObject: p.menuObject,
  });
}

export const CONTENT_ID = 2;
export const CONTENT_NAME = 'content';
