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
//
// The fallback is derived from API_BASE — NOT the bare same-origin path. The
// deployed relay serves the app from its own root, so same-origin and the hub
// origin happen to agree there; but a locally-built bundle (dev server, LAN, or
// a file:// WebView) would otherwise subscribe to an agents channel on the
// wrong origin while publishing hub state to the right one, and agents would
// silently never sync between the browser and the glasses.
export const AGENTS_STREAM_URL: string =
  (import.meta.env.VITE_HUB_AGENTS_URL as string | undefined) ??
  `${API_BASE}/api/stream?channel=agents`;

// The Jarvis run gets its own pair of channels, for the same reason agents did:
// the mirror is a HIGH-FREQUENCY transient signal (a frame per model step), and
// it must never bloat — or be resurrected from — the persisted hub snapshot.
//
//   ai      → the owner's run snapshot, broadcast to every surface
//   ai-ctl  → rare DIRECTED frames (Stop / confirm answer) sent back to the
//             owner, so the surface the user is NOT holding can still answer
//             a run. Both are transient on the relay.
export const AI_STREAM_URL: string =
  (import.meta.env.VITE_HUB_AI_URL as string | undefined) ?? `${API_BASE}/api/stream?channel=ai`;

export const AI_CTL_STREAM_URL: string = `${API_BASE}/api/stream?channel=ai-ctl`;

/** The SSE/state URL with the current stream credential appended. */
export function streamUrl(): string {
  return withToken(STREAM_URL);
}

export function agentsStreamUrl(): string {
  return withToken(AGENTS_STREAM_URL);
}

export function aiStreamUrl(): string {
  return withToken(AI_STREAM_URL);
}

export function aiCtlStreamUrl(): string {
  return withToken(AI_CTL_STREAM_URL);
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
  /** The relay answered; `hasSnapshot` is false when it holds nothing yet. */
  onHandshake?(hasSnapshot: boolean): void;
}

export interface AgentsStreamHandlers {
  onState(state: AgentsState): void;
  onStatus?(status: 'connecting' | 'open' | 'error'): void;
  onHandshake?(hasSnapshot: boolean): void;
}

/** Publish the full HubState snapshot to the relay (broadcast to all devices). */
export async function publishState(state: HubState): Promise<boolean> {
  return postJson(STREAM_URL, state);
}

/** Publish the agents snapshot (configs + the last 5 sessions) to the relay. */
export async function publishAgents(state: AgentsState): Promise<boolean> {
  return postJson(AGENTS_STREAM_URL, state);
}

/** Broadcast a Jarvis run snapshot (the cross-surface HUD mirror). */
export async function publishAi(snapshot: unknown): Promise<boolean> {
  return postJson(AI_STREAM_URL, snapshot);
}

/** Send a directed control frame (Stop / confirm answer) to the run's owner. */
export async function publishAiControl(msg: unknown): Promise<boolean> {
  return postJson(AI_CTL_STREAM_URL, msg);
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
  return subscribe(CHANNEL_HUB, (frame) => (frame.state ? (frame.state as HubState) : undefined), handlers);
}

/** Same SSE client, pointed at the separate 'agents' channel. */
export function connectAgentsStream(handlers: AgentsStreamHandlers): () => void {
  return subscribe(
    CHANNEL_AGENTS,
    (frame) => (frame.state ? (frame.state as AgentsState) : undefined),
    handlers,
  );
}

/**
 * Subscribe to mirrored Jarvis runs. Only `state` frames are delivered — the
 * control channel is a separate subscription so a control frame can never be
 * mistaken for a run to render.
 */
export function connectAiStream<T>(handlers: {
  onState(state: T): void;
  onStatus?(status: 'connecting' | 'open' | 'error'): void;
}): () => void {
  return subscribe(
    CHANNEL_AI,
    (frame) => (frame.type === 'state' && frame.state ? (frame.state as T) : undefined),
    handlers,
  );
}

/**
 * Subscribe to directed control frames. The relay's `init` frame carries the
 * channel's last state, so a reconnect can replay an old instruction — the
 * consumer must freshness-check it (see the CONTROL_TTL_MS guard in ai/sync.ts).
 */
export function connectAiControlStream<T>(handlers: {
  onState(state: T): void;
  onStatus?(status: 'connecting' | 'open' | 'error'): void;
}): () => void {
  return subscribe(CHANNEL_AI_CTL, (frame) => (frame.state ? (frame.state as T) : undefined), handlers);
}

// ── One socket for every channel ─────────────────────────────────────────────
//
// WHY: a browser keeps at most SIX HTTP/1.1 connections per origin, and an SSE
// response never gives its socket back. Opening one EventSource per channel
// pinned 4 of them per tab (hub, agents, ai, ai-ctl), so the second open tab
// already exceeded the cap and EVERY other request — most importantly the
// POST /api/llm that drives a Jarvis run — queued behind them indefinitely.
// The symptom was a run frozen on its first model turn, with no HUD overlay
// and no error: it looked like a hung provider, but nothing was ever sent.
//
// So all channels ride ONE multiplexed EventSource (`?channels=hub,agents,...`)
// and each frame is routed by its `channel` tag. Adding a channel is now free —
// the connection count stays at one, however many channels the app grows — and
// a relay that still answers with untagged frames keeps working unchanged.

/** The relay's channel names, taken from the (env-overridable) channel URLs. */
const CHANNEL_HUB = channelNameOf(STREAM_URL, 'hub');
const CHANNEL_AGENTS = channelNameOf(AGENTS_STREAM_URL, 'agents');
const CHANNEL_AI = channelNameOf(AI_STREAM_URL, 'ai');
const CHANNEL_AI_CTL = channelNameOf(AI_CTL_STREAM_URL, 'ai-ctl');

/**
 * Where each channel lives, so channels pointed at DIFFERENT relays still get
 * their own socket and never receive another relay's frames. Normally all four
 * agree — the deployed app is served by the relay — so they share one socket.
 * The base keeps any mount prefix (e.g. `/glasses`) instead of assuming the
 * stream sits at the very root.
 */
const BASES: Record<string, string> = {
  [CHANNEL_HUB]: baseOf(STREAM_URL),
  [CHANNEL_AGENTS]: baseOf(AGENTS_STREAM_URL),
  [CHANNEL_AI]: baseOf(AI_STREAM_URL),
  [CHANNEL_AI_CTL]: baseOf(AI_CTL_STREAM_URL),
};

function channelNameOf(url: string, fallback: string): string {
  const m = /[?&]channel=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : fallback;
}

/** Everything before `/api/` — 'http://host:5198', '/glasses', or '' same-origin. */
function baseOf(url: string): string {
  const i = url.indexOf('/api/');
  return i >= 0 ? url.slice(0, i) : '';
}

interface Subscriber {
  channel: string;
  pick: (frame: Record<string, unknown>) => unknown | undefined;
  onState(state: unknown): void;
  onStatus?(status: 'connecting' | 'open' | 'error'): void;
  onHandshake?(hasSnapshot: boolean): void;
  handshakeSeen: boolean;
}

interface Hub {
  /** Socket this group of channels arrived on. */
  base: string;
  subs: Set<Subscriber>;
  es: EventSource | null;
  retry: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The exact URL the live socket is subscribed to (null when disconnected). */
  live: string | null;
}

const hubs = new Map<string, Hub>();

/** One EventSource per relay base, lazily created and torn down with its last sub. */
function hub(base: string): Hub {
  let h = hubs.get(base);
  if (!h) {
    h = { base, subs: new Set(), es: null, retry: 0, timer: null, live: null };
    hubs.set(base, h);
  }
  return h;
}

/**
 * The multiplexed stream URL for `h`: every channel this base serves, with the
 * current credential. Kept as a string so a channel-set change is a plain
 * comparison (and therefore a reconnect we can detect and coalesce).
 *
 * Names are de-duplicated: two features may legitimately subscribe to the same
 * channel (the agents panel and the live-run transcript both want 'agents'), and
 * that must not change the URL — a URL change is what triggers a reconnect.
 */
function hubUrl(h: Hub): string {
  const names = [...new Set([...h.subs].map((s) => s.channel))];
  names.sort();
  return withToken(`${h.base}/api/stream?channels=${names.join(',')}`);
}

/**
 * Connect (or reconnect) `h` if the channel set changed. Deferred by a tick so
 * the four subscriptions made back-to-back during app start coalesce into ONE
 * socket instead of four sequential connects.
 */
function schedule(h: Hub): void {
  if (h.timer) return;
  h.timer = setTimeout(() => {
    h.timer = null;
    flush(h);
  }, 0);
}

function flush(h: Hub): void {
  if (h.subs.size === 0) {
    teardown(h);
    return;
  }
  const url = hubUrl(h);
  if (h.es && h.live === url) return; // already on the right channel set
  const wasOpen = h.live !== null;
  teardown(h, { keepStatus: wasOpen });
  connect(h, url);
}

function teardown(h: Hub, opts: { keepStatus?: boolean } = {}): void {
  if (h.timer) {
    clearTimeout(h.timer);
    h.timer = null;
  }
  h.es?.close();
  h.es = null;
  h.live = null;
  if (!opts.keepStatus) h.retry = 0;
}

function connect(h: Hub, url: string): void {
  if (h.subs.size === 0) return;
  for (const s of h.subs) s.onStatus?.('connecting');
  const es = new EventSource(url);
  h.es = es;
  h.live = url;

  es.onopen = () => {
    h.retry = 0;
    for (const s of h.subs) s.onStatus?.('open');
  };

  es.onerror = () => {
    for (const s of h.subs) s.onStatus?.('error');
    es.close();
    if (h.es !== es) return; // superseded by a reconnect of our own
    h.es = null;
    h.live = null;
    const delay = Math.min(1000 * 2 ** h.retry, 15000);
    h.retry += 1;
    // After a few failed reconnects, confirm the credential is still valid;
    // a 401 (reset auth store) otherwise shows as a misleading "Offline".
    // Only meaningful when we actually HAVE a credential — a reconnect that
    // raced ahead of session restore must not be read as "signed out".
    if (h.retry === 3 && getStreamToken()) {
      void credentialStillValid().then((ok) => {
        if (!ok) notifyAuthRejected();
      });
    }
    if (h.timer) clearTimeout(h.timer);
    h.timer = setTimeout(() => {
      h.timer = null;
      // Recompute rather than reusing `url`: a subscription made BEFORE sign-in
      // was refused a token by withToken(), so replaying that exact URL would
      // retry unauthenticated forever — the credential that later arrived would
      // never reach the wire.
      connect(h, hubUrl(h));
    }, delay);
  };

  es.onmessage = (e) => {
    try {
      const frame = JSON.parse(e.data as string) as Record<string, unknown>;
      route(h, frame);
    } catch {
      // ignore malformed frames
    }
  };
}

/**
 * Deliver one frame to the subscribers it belongs to.
 *
 * A multiplexed relay tags every frame with its origin channel, so routing is
 * exact — essential because e.g. both the hub and the agents channel broadcast
 * `{type:'state', state}`, and only the tag tells them apart. Against a relay
 * that predates multiplexing there is no tag; those sockets carry exactly one
 * channel, so a single subscriber may claim it, and anything ambiguous is
 * dropped rather than mis-delivered.
 */
function route(h: Hub, frame: Record<string, unknown>): void {
  const tag = typeof frame.channel === 'string' ? frame.channel : null;
  if (!tag && h.subs.size !== 1) return;
  for (const s of h.subs) {
    if (tag && tag !== s.channel) continue;
    if (!s.handshakeSeen && frame.type === 'init') {
      s.handshakeSeen = true;
      s.onHandshake?.(frame.state != null);
    }
    const value = s.pick(frame);
    if (value !== undefined) s.onState(value);
  }
}

/**
 * Shared SSE subscription. `pick` turns a raw frame into the value to deliver,
 * or `undefined` to ignore it (the agents channel carries BOTH state snapshots
 * and transient run frames, so the picker decides which one this subscriber
 * wants).
 *
 * `onHandshake` fires for the channel's very first `init` frame and reports
 * whether it carried a snapshot. `hasSnapshot === false` means "the server has
 * nothing, you may seed it"; no frame at all means the relay never spoke, so
 * seeding must stay off.
 */
function subscribe<T>(
  channel: string,
  pick: (frame: Record<string, unknown>) => T | undefined,
  handlers: {
    onState(state: T): void;
    onStatus?(status: 'connecting' | 'open' | 'error'): void;
    onHandshake?(hasSnapshot: boolean): void;
  },
): () => void {
  const h = hub(BASES[channel] ?? '');
  const sub: Subscriber = {
    channel,
    pick: pick as (frame: Record<string, unknown>) => unknown | undefined,
    onState: handlers.onState as (state: unknown) => void,
    onStatus: handlers.onStatus,
    onHandshake: handlers.onHandshake,
    handshakeSeen: false,
  };
  h.subs.add(sub);
  schedule(h);

  return () => {
    h.subs.delete(sub);
    if (h.subs.size === 0) teardown(h);
    else schedule(h);
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

/** Outcome of asking the relay to start a run. */
export interface RunStartResult {
  runId: string | null;
  /** Why it failed (network/CORS, 401, 501, …). Empty on success. */
  error: string;
}

/**
 * Ask the relay to execute an agent.
 *
 * The failure reason is returned rather than swallowed: a CORS preflight
 * rejection, an expired session and a missing API key all used to collapse into
 * the same opaque "relay refused the run" message, which made them impossible to
 * tell apart from the UI.
 */
export async function startRun(args: {
  agent: { id: string; name: string; systemPrompt: string; model?: string };
  tools: unknown[];
  prompt: string;
  model: string;
}): Promise<RunStartResult> {
  try {
    const res = await fetch(`${API_BASE}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(args),
    });
    if (res.status === 401) notifyIfCredentialWasSent();
    const j = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      runId?: string;
      error?: string;
    };
    if (j?.ok && j.runId) return { runId: j.runId, error: '' };
    return { runId: null, error: j?.error || `relay replied ${res.status}` };
  } catch {
    return { runId: null, error: `cannot reach the relay at ${API_BASE}` };
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
    if (res.status === 401) notifyIfCredentialWasSent();
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

/**
 * A 401 only means "your credential is bad" if we actually SENT one. Boot-time
 * requests (connectRuns/fetchRuns fire before a session is restored) used to
 * trip this and revoke a perfectly valid session, which is why the agents panel
 * showed "session failed to fetch". Anonymous 401s are ignored here; the SSE
 * path still re-checks the credential after repeated reconnect failures.
 */
function notifyIfCredentialWasSent(): void {
  if (getStreamToken()) notifyAuthRejected();
}

/** Subscribe to run frames on the agents channel. Returns an unsubscribe fn. */
export function connectRuns(handlers: {
  onRun?(run: AgentRun): void;
  onInit?(runs: AgentRun[]): void;
}): () => void {
  return subscribe(
    CHANNEL_AGENTS,
    (frame) => frame as unknown as RunFrame,
    {
      onState: (frame: RunFrame) => {
        if (frame.type === 'run' && frame.run) handlers.onRun?.(frame.run);
        else if (frame.type === 'runInit') handlers.onInit?.(frame.runs ?? []);
      },
    },
  );
}
