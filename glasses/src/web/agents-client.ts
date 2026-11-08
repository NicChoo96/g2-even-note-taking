// Browser-side helpers for the Agents feature.
//
// Every call goes through the relay (see web/server/local-sse.mjs) so the LLM
// and web-search keys live server-side and the WebView never has to be
// whitelisted for third-party origins. Auth is the same stream credential used
// by the SSE channel.
import { getStreamToken } from '../auth-token';
import { API_BASE } from '../stream';

/**
 * Where a value came from: a value saved on the settings page wins over the
 * host environment, which is only the fallback for a field nobody has saved.
 */
export type ValueSource = 'env' | 'settings' | 'default' | 'none';

export interface AgentStatus {
  ok: boolean;
  /** Active LLM backend: 'openrouter' (default) or 'deepseek'. */
  provider?: string;
  llm: boolean;
  /**
   * Whether the ACTIVE search provider is configured. Deprecated alias — new
   * code reads `search`; kept so an older bundle keeps rendering correctly.
   */
  tavily: boolean;
  /** The web-search setting: which provider is live, and both key states. */
  search?: {
    provider?: 'tavily' | 'brave' | string;
    configured?: boolean;
    depth?: string;
    keys?: { tavily?: boolean; brave?: boolean };
  };
  /**
   * True when the relay holds an OpenRouter key, which is what jev needs.
   * Deliberately NOT the same as `llm`: the chat provider can be DeepSeek while
   * jev is always OpenRouter, so the two can disagree in either direction.
   */
  jev?: boolean;
  /**
   * The document store (agent-authored HTML). `configured` means the relay
   * holds a CREDENTIAL, never that the gateway answered — a momentary outage
   * must not make the app claim the feature is unset. `hint` names the env
   * vars to set and never carries a value.
   */
  files?: {
    configured?: boolean;
    mode?: 'api_key' | 'password' | string;
    url?: string;
    hint?: string;
  };
  model: string;
  depth: string;
  /**
   * Every NON-SECRET setting at its current value, so the page can seed each
   * field with the truth rather than guessing a default and writing it back.
   * Keys are absent on purpose — they are booleans only, above.
   */
  fields?: {
    model?: string;
    depth?: string;
    /** The SAVED provider setting — '' means auto. */
    searchProvider?: SearchProvider | '';
    referer?: string;
    title?: string;
  };
  /**
   * Provenance per field. NOTE: a field being 'env' does NOT lock its input —
   * a saved setting wins over the environment, so this only says where the
   * CURRENT value comes from (and therefore what the field falls back to when
   * cleared).
   */
  source?: {
    llm?: {
      key?: ValueSource;
      model?: ValueSource;
      referer?: ValueSource;
      title?: ValueSource;
      openrouterKey?: ValueSource;
      deepseekKey?: ValueSource;
    };
    search?: {
      provider?: ValueSource;
      key?: ValueSource;
      depth?: ValueSource;
      tavilyKey?: ValueSource;
      braveKey?: ValueSource;
    };
    /** Deprecated mirror of `search`, for the older bundle. */
    tavily?: { key?: ValueSource; depth?: ValueSource };
    jev?: { key?: ValueSource };
  };
}

export type SearchProvider = 'tavily' | 'brave';

export interface SettingsPatch {
  openrouterKey?: string;
  deepseekKey?: string;
  tavilyKey?: string;
  braveKey?: string;
  /** Which web-search backend to use. '' means auto (whichever key is set). */
  searchProvider?: SearchProvider | '';
  model?: string;
  referer?: string;
  title?: string;
  depth?: string;
  /** Generic REST tool bearer tokens, keyed by tool id. */
  toolTokens?: Record<string, string>;
  /**
   * Field names to REMOVE, so each one falls back to the environment value (or
   * its built-in default). Explicit because a blank string cannot carry this
   * meaning: a write-only key is never echoed back, so an empty key box is
   * indistinguishable from "leave it alone".
   */
  clear?: string[];
}

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * The model's "chain of thought" for this assistant turn. The relay
   * normalises DeepSeek's `reasoning_content` and OpenRouter's `reasoning` into
   * this one field, so the agent loop can show what the model reasoned before
   * it acted instead of only the actions it took.
   */
  reasoning_content?: string;
}

export interface LlmReply {
  ok: boolean;
  model?: string;
  message?: WireMessage;
  usage?: unknown;
  error?: string;
}

export interface ToolReply {
  ok: boolean;
  result?: string;
  error?: string;
}

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const token = getStreamToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: j?.error || `HTTP ${res.status}` } as T;
    return j;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T;
  }
}

/**
 * Are the LLM and web-search keys configured, which search provider is live,
 * and what is the effective model? Also returns the current value of every
 * non-secret setting so the page can seed its fields.
 */
export async function fetchAgentStatus(): Promise<AgentStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/api/agent/status`, { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as AgentStatus;
  } catch {
    return null;
  }
}

/** Owner-only: store provider keys / model / tool tokens server-side. */
export function saveSettings(patch: SettingsPatch): Promise<AgentStatus & { error?: string }> {
  return post<AgentStatus & { error?: string }>('/api/settings', patch);
}

/** One chat completion (tool-calling capable) through the relay. */
export function llmChat(args: {
  model: string;
  messages: WireMessage[];
  tools?: unknown[];
}): Promise<LlmReply> {
  return post<LlmReply>('/api/llm', args);
}

/** Run one tool (web search, or a generic REST call) through the relay. */
export function runTool(args: {
  /** 'web' (legacy 'tavily' also accepted) or 'http'. */
  kind: string;
  toolId: string;
  url?: string;
  method?: string;
  searchDepth?: string;
  args: Record<string, unknown>;
}): Promise<ToolReply> {
  return post<ToolReply>('/api/tool', args);
}

// ── The agent schedule ──────────────────────────────────────────────────────
// The clock runs on the RELAY, not on this device, which is why a daily agent
// fires with the glasses in a drawer and the phone asleep. The page's whole job
// is to describe that schedule and change it.

/** One scheduled run, as the relay sees it. */
export interface ScheduleJob {
  agent: string;
  /** `HH:MM` on the relay's clock, in `timeZone`. */
  at: string;
  /** `0`=Sunday … `6`=Saturday; `null` means every day. */
  days: number[] | null;
  /** An extra instruction layered on the agent's own saved task. */
  ask: string;
  enabled: boolean;
  /** The next firing, as epoch ms — `null` when it will never fire. */
  nextAt: number | null;
  /** The same instant as an ISO string, so nothing is recomputed in the browser. */
  nextSlot: string | null;
  /** The last slot this job actually ran, `YYYY-MM-DD HH:MM`, if it ever has. */
  lastSlot: string | null;
  lastError: string | null;
}

export interface ScheduleState {
  ok: boolean;
  /** Where the running schedule came from. `none` is a real answer, not a fault. */
  source: 'hub' | 'ui' | 'file' | 'env' | 'none';
  configured: boolean;
  enabled: boolean;
  /** True when there is a schedule AND the kill switch is not thrown. */
  running: boolean;
  /** `G2_AGENT_CRON=0` on the relay — the schedule exists but cannot fire. */
  killed: boolean;
  timeZone: string;
  graceMinutes: number;
  jobs: ScheduleJob[];
  caps: { perTick: number; perDay: number };
  serverNow: string;
  /** Whether the save reached the hub — a schedule only in memory dies on deploy. */
  durable?: boolean;
  durableError?: string;
  error?: string;
}

/** The schedule, plus when each job next fires. */
export async function fetchSchedule(): Promise<ScheduleState | null> {
  try {
    const res = await fetch(`${API_BASE}/api/agent/schedule`, { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as ScheduleState;
  } catch {
    return null;
  }
}

/**
 * Replace the whole schedule.
 *
 * Whole-value on purpose: the relay validates it in one pass and either accepts
 * every job or none, so a half-applied edit can never leave an agent firing at a
 * time nobody chose.
 */
export async function saveSchedule(patch: {
  enabled?: boolean;
  timeZone?: string;
  jobs: Array<{ agent: string; at: string; days?: number[] | null; ask?: string; enabled?: boolean }>;
}): Promise<ScheduleState> {
  try {
    const res = await fetch(`${API_BASE}/api/agent/schedule`, {
      method: 'PUT',
      headers: authHeaders(true),
      body: JSON.stringify(patch),
    });
    const j = (await res.json().catch(() => ({}))) as ScheduleState;
    if (!res.ok) return { ...j, ok: false, error: j?.error || `HTTP ${res.status}` };
    return j;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as ScheduleState;
  }
}

/** Start one run now — the same run the clock would start, for testing a prompt. */
export function runAgentNow(agent: string): Promise<ToolReply> {
  return post<ToolReply>('/api/agent/schedule/run', { agent });
}
