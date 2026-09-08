import type { AgentsState, HubState } from './types';
import { getStreamToken, notifyAuthRejected } from './auth-token';

// Same-origin by default: the deployed app is served by the relay at the bare
// root, so /api/stream resolves to the live stream next to it. Local dev
// overrides via VITE_HUB_STREAM_URL in .env.local.
export const STREAM_URL: string =
  (import.meta.env.VITE_HUB_STREAM_URL as string | undefined) ?? '/api/stream?channel=hub';

// Base origin of the relay API (auth / config / stream). Same-origin by default.
export const API_BASE: string = STREAM_URL.split('/api/')[0];

// Agents ride a SEPARATE channel: agent configs + session transcripts must not
// bloat or leak through the hub channel (HubState is broadcast + persisted).
export const AGENTS_STREAM_URL: string =
  (import.meta.env.VITE_HUB_AGENTS_URL as string | undefined) ?? '/api/stream?channel=agents';

/** The SSE/state URL with the current stream credential appended. */
export function streamUrl(): string {
  return withToken(STREAM_URL);
}

export function agentsStreamUrl(): string {
  return withToken(AGENTS_STREAM_URL);
}

function withToken(url: string): string {
  const token = getStreamToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export interface StreamHandlers {
  onState(state: HubState): void;
  onStatus?(status: 'connecting' | 'open' | 'error'): void;
}

export interface AgentsStreamHandlers {
  onState(state: AgentsState): void;
  onStatus?(status: 'connecting' | 'open' | 'error'): void;
}

/** Publish the full HubState snapshot to the relay (broadcast to all devices). */
export async function publishState(state: HubState): Promise<boolean> {
  return postJson(STREAM_URL, state);
}

/** Publish the agents snapshot (configs + the last 5 sessions) to the relay. */
export async function publishAgents(state: AgentsState): Promise<boolean> {
  return postJson(AGENTS_STREAM_URL, state);
}

async function postJson(url: string, body: unknown): Promise<boolean> {
  const token = getStreamToken();
  if (!token) return false; // not authorized yet — nothing to publish to
  try {
    const res = await fetch(withToken(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) notifyAuthRejected(); // credential no longer valid
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Is the current credential still accepted by the relay? Owner sessions are
 * checked against /api/auth/me; Even App device IDs against /api/pair/status.
 * On a network error we optimistically return true (don't sign out on a blip).
 */
async function credentialStillValid(): Promise<boolean> {
  const token = getStreamToken();
  if (!token) return false;
  try {
    const me = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (me.ok) return true;
  } catch {
    return true; // network issue — can't tell, keep trying
  }
  try {
    const st = await fetch(`${API_BASE}/api/pair/status?deviceId=${encodeURIComponent(token)}`);
    if (st.ok) {
      const j = (await st.json()) as { status?: string };
      return j.status === 'approved';
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * SSE client for the G2 Even Reality Hub stream.
 * Auto-reconnects with exponential backoff (EventSource handles most of it,
 * but we manage re-creation to surface status changes).
 */
export function connectStream(handlers: StreamHandlers): () => void {
  return connectSse<HubState>(
    streamUrl,
    (frame) => frame.state as HubState,
    handlers,
  );
}

/** Same SSE client, pointed at the separate 'agents' channel. */
export function connectAgentsStream(handlers: AgentsStreamHandlers): () => void {
  return connectSse<AgentsState>(
    agentsStreamUrl,
    (frame) => frame.state as AgentsState,
    handlers,
  );
}

/**
 * Shared SSE client. `pick` turns a raw frame into the value to deliver, or
 * `undefined` to ignore it (the agents channel carries BOTH state snapshots and
 * transient run frames, so the picker decides which one this subscriber wants).
 */
function connectSse<T>(
  urlFn: () => string,
  pick: (frame: Record<string, unknown>) => T | undefined,
  handlers: { onState(state: T): void; onStatus?(status: 'connecting' | 'open' | 'error'): void },
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    handlers.onStatus?.('connecting');
    es = new EventSource(urlFn());

    es.onopen = () => {
      retry = 0;
      handlers.onStatus?.('open');
    };

    es.onerror = () => {
      handlers.onStatus?.('error');
      es?.close();
      if (!closed) {
        const delay = Math.min(1000 * 2 ** retry, 15000);
        retry += 1;
        // After a few failed reconnects, confirm the credential is still valid;
        // a 401 (reset auth store) otherwise shows as a misleading "Offline".
        if (retry === 3) {
          void credentialStillValid().then((ok) => {
            if (!ok) notifyAuthRejected();
          });
        }
        setTimeout(connect, delay);
      }
    };

    es.onmessage = (e) => {
      try {
        const frame = JSON.parse(e.data as string) as Record<string, unknown>;
        const value = pick(frame);
        if (value !== undefined) handlers.onState(value);
      } catch {
        // ignore malformed frames
      }
    };
  };

  connect();

  return () => {
    closed = true;
    es?.close();
    es = null;
  };
}

// ── Live agent runs (transient — never part of the synced agents state) ──────
// A run executes SERVER-SIDE in the relay, so it survives the glasses page
// being backgrounded and BOTH the glasses detail pane and the browser watch the
// same transcript as it is produced. Frames ride the agents channel as
// `{ type: 'run', run }`; the client replays in-flight runs on (re)connect.
export type RunStatus = 'running' | 'done' | 'error' | 'stopped';

export interface RunMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool?: string;
  args?: string;
  at: number;
}

/** One server-side agent execution. Mirrors AgentSession but is NOT persisted. */
export interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  prompt: string;
  title: string;
  messages: RunMessage[];
  status: RunStatus;
  statusText: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

/** Frames the relay pushes for a run, plus the replay snapshot. */
export type RunFrame =
  | { type: 'run'; run: AgentRun }
  | { type: 'runInit'; runs: AgentRun[] };

/** Ask the relay to execute an agent. Returns the new run id (or null). */
export async function startRun(args: {
  agent: { id: string; name: string; systemPrompt: string; model?: string };
  tools: unknown[];
  prompt: string;
  model: string;
}): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(args),
    });
    if (res.status === 401) notifyAuthRejected();
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; runId?: string };
    return j?.ok && j.runId ? j.runId : null;
  } catch {
    return null;
  }
}

/** Ask the relay to stop an in-flight run. */
export async function stopRun(runId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/agent/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ runId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Replay every run the relay still remembers (used after a background gap). */
export async function fetchRuns(): Promise<AgentRun[]> {
  try {
    const res = await fetch(`${API_BASE}/api/agent/runs`, { headers: authHeader() });
    if (res.status === 401) notifyAuthRejected();
    if (!res.ok) return [];
    const j = (await res.json()) as { ok?: boolean; runs?: AgentRun[] };
    return j?.runs ?? [];
  } catch {
    return [];
  }
}

function authHeader(): Record<string, string> {
  const token = getStreamToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Subscribe to run frames on the agents channel. Returns an unsubscribe fn. */
export function connectRuns(handlers: {
  onRun?(run: AgentRun): void;
  onInit?(runs: AgentRun[]): void;
}): () => void {
  return connectSse<RunFrame>(agentsStreamUrl, (frame) => frame as unknown as RunFrame, {
    onState: (frame) => {
      if (frame.type === 'run' && frame.run) handlers.onRun?.(frame.run);
      else if (frame.type === 'runInit') handlers.onInit?.(frame.runs ?? []);
    },
  });
}
