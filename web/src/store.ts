import type { HubState } from './types';
import { emptyHubState } from './types';

const LS_KEY = 'g2-hub:state';

/** Load the persisted HubState from localStorage (the web app is the source of truth). */
export function loadState(): HubState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptyHubState();
    const parsed = JSON.parse(raw) as Partial<HubState>;
    if (parsed?.sections) return { ...emptyHubState(), ...parsed };
  } catch {
    /* ignore */
  }
  return emptyHubState();
}

export function saveState(state: HubState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
