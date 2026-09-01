// Minimal text rendering for G2 — mirrors the official evenhub-templates
// "minimal" pattern: ONE full-canvas text container, updated in place with
// textContainerUpgrade. No list containers, no OS menu, no rebuilds — the
// smallest surface area possible, so real firmware accepts the page.
import { MenuContainerProperty, MenuItemProperty } from '@evenrealities/even_hub_sdk';
import type { HubState, SectionId } from './types';

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
];

export function sectionTitle(id: SectionId): string {
  return SECTIONS.find((s) => s.id === id)?.title ?? id;
}

/**
 * OS contextual menu — your items sit between the system slots (Display off /
 * Brightness on top, "Close Reality Hub" at the bottom). Declared ONCE on the
 * startup page so they live for the page's lifetime. Max 10 items.
 */
export function sectionMenu(): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: SECTIONS.map(
      (s) => new MenuItemProperty({ itemName: s.title, itemID: s.menuId }),
    ),
  });
}

export function sectionByMenuId(menuId: number): SectionDef | undefined {
  return SECTIONS.find((s) => s.menuId === menuId);
}

// textContainerUpgrade hard cap is 2000 chars — keep well under it.
const MAX_TEXT = 1800;
const MAX_ITEM_CHARS = 60;
const MAX_LIST_ITEMS = 30;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/** Render the active section as plain text for the single glasses container. */
export function sectionText(state: HubState): string {
  const section = state.activeSection;
  const title = sectionTitle(section);

  if (section === 'todo') {
    const items = state.sections.todo;
    const lines = items
      .slice(0, MAX_LIST_ITEMS)
      .map((t, i) => `${i + 1}. ${t.done ? '[x]' : '[ ]'} ${truncate(t.text, MAX_ITEM_CHARS)}`);
    const body = lines.length > 0 ? lines.join('\n') : '(no tasks — add from web)';
    return truncate(`${title}\n${'-'.repeat(18)}\n${body}`, MAX_TEXT);
  }

  const text = section === 'docs' ? state.sections.docs : state.sections.notes;
  const body = text.trim() || '(empty)';
  return truncate(`${title}\n${'-'.repeat(18)}\n${body}`, MAX_TEXT);
}
