// Browser-side helpers for the Agents feature.
//
// Every call goes through the relay (see web/server/local-sse.mjs) so the
// OpenRouter and Tavily keys live server-side and the WebView never has to be
// whitelisted for third-party origins. Auth is the same stream credential used
// by the SSE channel.
import { getStreamToken } from '../auth-token';
import { API_BASE } from '../stream';

/** Where a value came from: the host env wins over the settings page. */
export type ValueSource = 'env' | 'settings' | 'default' | 'none';

export interface AgentStatus {
  ok: boolean;
  /** Active LLM backend: 'openrouter' (default) or 'deepseek'. */
  provider?: string;
  llm: boolean;
  tavily: boolean;
  model: string;
  depth: string;
  /** Provenance per field, so the UI can lock env-managed inputs. */
  source?: {
    llm?: {
      key?: ValueSource;
      model?: ValueSource;
      referer?: ValueSource;
      title?: ValueSource;
      openrouterKey?: ValueSource;
      deepseekKey?: ValueSource;
    };
    tavily?: { key?: ValueSource; depth?: ValueSource };
  };
}

export interface SettingsPatch {
  openrouterKey?: string;
  deepseekKey?: string;
  tavilyKey?: string;
  model?: string;
  referer?: string;
  title?: string;
  depth?: string;
  /** Generic REST tool bearer tokens, keyed by tool id. */
  toolTokens?: Record<string, string>;
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

/** Are the LLM/Tavily keys configured, and what is the effective model? */
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

/** Run one tool (Tavily search, or a generic REST call) through the relay. */
export function runTool(args: {
  kind: string;
  toolId: string;
  url?: string;
  method?: string;
  searchDepth?: string;
  args: Record<string, unknown>;
}): Promise<ToolReply> {
  return post<ToolReply>('/api/tool', args);
}
