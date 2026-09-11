// Bridge between the AI layer and the renderer.
//
// Capabilities mutate DATA directly through the plain modules (store.ts /
// agents-store.ts). Navigation lives inside main.ts's closures, so the renderer
// registers the two hooks it owns here instead of the AI layer reaching into the
// renderer. Adding a page therefore needs no change to the AI layer — only a
// section that already exists in the renderer.
//
// Note what is NOT here: the agent's notion of "which page is focused". That is
// run state (the caller supplies it and nav.open_page changes it), because a run
// started from the web tab and one started on the glasses must not each consult
// a different view. See ai/store.ts.
import type { PageId } from './types';

export interface AppBridge {
  /**
   * Navigate to a page. Section pages switch the glasses + companion tab;
   * 'settings' is a web-only tab the renderer forwards to the companion UI.
   */
  openPage(page: PageId): void;
  /** Leave the current sub-view (close the doc picker or the agent detail pane). */
  goBack(): void;
}

let bridge: AppBridge | null = null;

export function setAppBridge(next: AppBridge): void {
  bridge = next;
}

/**
 * No-op fallback used before the renderer mounts and by the node harnesses
 * (where there is no renderer). Keeps navigation harmless instead of crashing.
 */
const fallback: AppBridge = {
  openPage: () => undefined,
  goBack: () => undefined,
};

export function getAppBridge(): AppBridge {
  return bridge ?? fallback;
}

export function hasAppBridge(): boolean {
  return bridge !== null;
}

/** Test seam so a harness can observe navigation without a renderer. */
export function resetAppBridge(): void {
  bridge = null;
}
