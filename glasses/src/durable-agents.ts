// Durable storage for the Agents feature.
//
// On the real Even App the WebView can be torn down at any moment, so agent
// definitions, tools, LLM settings and the last sessions are dual-written to
// the bridge (bridge.setLocalStorage) AND localStorage — reading bridge-first
// and migrating up, exactly like durable-docs.ts. Only the LAST 5 sessions are
// kept, per the product requirement.
import { getDurableBridge, isStartupReady } from './durable-docs';
import { pruneSessions, type AgentSession, type AgentsState } from './types';

const AGENTS_KEY = 'hub:agents';
const SESSIONS_KEY = 'hub:agentSessions';

interface DurableBridge {
  setLocalStorage?: (key: string, value: string) => Promise<unknown>;
  getLocalStorage?: (key: string) => Promise<unknown>;
  removeLocalStorage?: (key: string) => Promise<unknown>;
}

function getBridge(): DurableBridge | null {
  return (getDurableBridge() as unknown as DurableBridge) ?? null;
}

async function durableSet(key: string, value: string): Promise<void> {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  try {
    await getBridge()?.setLocalStorage?.(key, value);
  } catch {
    /* bridge may not be ready yet — localStorage still holds it */
  }
}

async function durableGet(key: string): Promise<string | null> {
  try {
    const fromBridge = await getBridge()?.getLocalStorage?.(key);
    if (typeof fromBridge === 'string' && fromBridge) {
      try {
        if (localStorage.getItem(key) !== fromBridge) localStorage.setItem(key, fromBridge);
      } catch {
        /* ignore */
      }
      return fromBridge;
    }
  } catch {
    /* fall through to localStorage */
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist agent definitions + tools + LLM settings (never the API keys). */
export async function saveAgentsDurable(state: AgentsState): Promise<void> {
  if (!isStartupReady()) return;
  const { agents, tools, llm } = state;
  await durableSet(AGENTS_KEY, JSON.stringify({ agents, tools, llm }));
}

/** Persist the (already pruned) session list. */
export async function saveSessionsDurable(sessions: AgentSession[]): Promise<void> {
  if (!isStartupReady()) return;
  await durableSet(SESSIONS_KEY, JSON.stringify(pruneSessions(sessions)));
}

/** Load the durable agents payload; returns null when nothing was saved. */
export async function loadAgentsDurable(): Promise<Partial<AgentsState> | null> {
  const raw = await durableGet(AGENTS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<AgentsState>;
  } catch {
    return null;
  }
}

/** Load the durable session list (already capped at 5 on write). */
export async function loadSessionsDurable(): Promise<AgentSession[] | null> {
  const raw = await durableGet(SESSIONS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AgentSession[];
    return Array.isArray(parsed) ? pruneSessions(parsed) : null;
  } catch {
    return null;
  }
}
