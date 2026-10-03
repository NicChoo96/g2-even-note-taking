// DATA EXPORT — one JSON file holding the whole configurable dataset, in the
// shapes the Postgres backend wants, so it can be used as the initial seed.
//
// WHY THIS EXISTS
// The app's state is spread over localStorage, the Even App bridge store and the
// relay's JSON state file — and every one of those is shaped for the CLIENT (a
// docs array, an agents blob, a memory log). The backend needs it shaped for the
// DATABASE (`document` rows, `agent_tool` joins, `session_message` rows with a
// sequence number). This module is that translation, in ONE place, so the export
// and the schema cannot drift apart in silence. The target shapes are defined in
// `docs/data-platform/BACKEND-BUILD-SPEC.md` §3 (DDL) and §8 (import mapping).
//
// FIVE THINGS THIS MODULE DELIBERATELY DOES NOT DO
//   1. It never writes a secret VALUE. The relay returns booleans, never keys
//      (§8, and the reason `hub:owner.token` is opt-in below). `collections.app_secret`
//      is therefore a MANIFEST — what exists, where it came from, and `value: null`.
//   2. It never invents an id. Every id is the client's own, carried verbatim, with
//      a warning about the ones that are not UUIDs.
//   3. It never copies a document BODY into `file_ref`. Those rows are references;
//      a body there is the single thing the schema forbids outright.
//   4. It does not export the L1 durable caches as tables. `hub:docs`, `hub:deviceId`
//      and `hub:owner` are client caches, not server state (§8) — the documents
//      travel as `document` rows, taken from the live hub state.
//   5. It does not send the owner bearer token unless the caller asks. That is a
//      live credential; bundling it into a file that gets emailed around is how a
//      token leaks. `includeOwnerCredential` is false by default.
//
// NOTHING HERE IS ASYNC ON PURPOSE. Every value comes from a synchronous store
// read, so the caller decides when to pay for the gather and the download handler
// stays a straight line.

import type { AgentsState, HubState, ToolDef } from '../types';
import type { AiSettings, AiState } from '../ai/store';
import type { JarvisMemory } from '../ai/memory';
import type { Entry } from '../ai/ledger';
import type { AgentStatus, ValueSource } from './agents-client';

/** Marks the file as OURS, so an importer can refuse a random JSON. */
export const EXPORT_FORMAT = 'g2-hub-seed';
/** Bump when a collection is renamed or a row's shape changes incompatibly. */
export const EXPORT_VERSION = 1;
/** Where the target shapes live, printed into the file itself. */
export const EXPORT_SPEC = 'docs/data-platform/BACKEND-BUILD-SPEC.md §3 (DDL), §8 (import)';

/** `present: null` means the relay did not tell us — never guess `false`. */
type Tri = boolean | null;

/** One credential the backend will need, and whether it exists. Never its value. */
export interface ExportSecretRef {
  /** `app_secret.key` — e.g. `llm`, `llm:deepseek`, `search:tavily`, `tool:tool-web`. */
  key: string;
  present: Tri;
  /** Provenance of the value the relay is using. */
  source: ValueSource | 'unknown';
  /** A non-secret hint (env var names, a last-4 tail). Never the key. */
  hint: string;
  /** Always null. Stated explicitly so no importer assumes it was omitted by accident. */
  value: null;
  /** Only present when a value is genuinely required to make the feature work. */
  note?: string;
}

export interface ExportMeta {
  generatedAt: string;
  generatedAtMs: number;
  appVersion: string | null;
  /** The relay origin this browser was talking to when it exported. */
  origin: string;
  href: string;
  userAgent: string;
  format: string;
  version: number;
  spec: string;
}

export interface ExportIdentity {
  email: string | null;
  deviceId: string | null;
  /** Present only when the caller opted in. See the module header, point 5. */
  ownerToken?: string;
}

export interface ExportCollections {
  /** One row, derived from the signed-in account. */
  app_user: Array<{ email: string }>;
  /** Non-secret server-side settings, at their current live values. */
  app_setting: Array<{ key: string; value: string }>;
  app_secret: ExportSecretRef[];
  hub_state: {
    active_section: string;
    active_doc_id: string | null;
    updated_at_ms: number;
  };
  todo_item: Array<{ id: string; text: string; done: boolean; ordinal: number }>;
  document: Array<{ id: string; title: string; content: string; updated_at_ms: number; ordinal: number }>;
  note: { content: string };
  /** References only — never a body. See the module header, point 3. */
  file_ref: Array<{
    id: string;
    title: string;
    agent: string;
    url: string;
    size: number;
    updated_at_ms: number;
    ordinal: number;
  }>;
  llm_settings: Record<string, string>;
  tool: Array<Record<string, unknown>>;
  agent: Array<Record<string, unknown>>;
  agent_tool: Array<{ agent_id: string; tool_id: string; ordinal: number }>;
  jarvis_session: Array<Record<string, unknown>>;
  session_message: Array<Record<string, unknown>>;
  session_tombstone: Array<{ agent_id: string; cleared_at_ms: number }>;
  memory_turn: Array<{ role: string; text: string; at_ms: number; ordinal: number }>;
  /** Versioned, append-only — this is always `v1` of the current digest. */
  memory_digest: Array<{ version: number; digest: string; at_ms: number }>;
  /** Transient, in-memory, opt-in. Empty unless the caller asked for it. */
  ledger_entry: Array<Record<string, unknown>>;
}

export interface ExportBundle {
  $format: string;
  $version: number;
  meta: ExportMeta;
  identity: ExportIdentity;
  counts: Record<string, number>;
  warnings: string[];
  collections: ExportCollections;
  /** Settings this BROWSER owns. Not server state — kept apart from `app_setting`. */
  client_local: { ai_settings: AiSettings };
}

export interface BuildExportInput {
  hub: HubState;
  agents: AgentsState;
  ai: AiState;
  memory: JarvisMemory;
  /** The relay's own report. `null` = unreachable, which is reported, not hidden. */
  status: AgentStatus | null;
  email: string | null;
  deviceId: string | null;
  appVersion: string | null;
  origin: string;
  /** Defaults to `location.href`. Passed in so this stays testable off-browser. */
  href?: string;
  /** Opt-in: the ledger is runtime state, not part of the persistent corpus. */
  ledger?: Entry[] | null;
  /** Opt-in: a live bearer credential. Off by default, and it should stay off. */
  includeOwnerCredential?: string | null;
  now?: number;
}

/** True when provenance says a value exists anywhere. `undefined` = unknown. */
function presence(src: ValueSource | undefined): Tri {
  if (src === undefined) return null;
  return src !== 'none';
}

function srcOf(src: ValueSource | undefined): ValueSource | 'unknown' {
  return src ?? 'unknown';
}

/**
 * The credentials the backend will need, and where each one comes from.
 *
 * Read off the relay's `source` map rather than its `configured` booleans, because
 * the booleans only cover the provider that happens to be ACTIVE: a user with both
 * a Tavily and a Brave key shows `configured: true` once and tells you nothing
 * about the other one. Provenance covers every field.
 */
function secretManifest(
  status: AgentStatus | null,
  tools: ToolDef[],
): ExportSecretRef[] {
  const s = status?.source;
  const out: ExportSecretRef[] = [
    {
      key: 'llm',
      present: status ? status.llm : null,
      source: srcOf(s?.llm?.key),
      hint: 'The active chat provider key (OPENROUTER_API_KEY / DEEPSEEK_API_KEY).',
      value: null,
      note: 'Required for /sessions/{id}/summarise.',
    },
    {
      key: 'llm:openrouter',
      present: presence(s?.llm?.openrouterKey),
      source: srcOf(s?.llm?.openrouterKey),
      hint: 'jev always uses OpenRouter, whatever the chat provider is.',
      value: null,
      note: 'Required for jev decisions.',
    },
    {
      key: 'llm:deepseek',
      present: presence(s?.llm?.deepseekKey),
      source: srcOf(s?.llm?.deepseekKey),
      hint: 'Only used when LLM_PROVIDER=deepseek.',
      value: null,
    },
    {
      key: 'search:tavily',
      present: presence(s?.search?.tavilyKey),
      source: srcOf(s?.search?.tavilyKey),
      hint: 'TAVILY_API_KEY.',
      value: null,
    },
    {
      key: 'search:brave',
      present: presence(s?.search?.braveKey),
      source: srcOf(s?.search?.braveKey),
      hint: 'BRAVE_API_KEY.',
      value: null,
    },
    {
      key: 'gateway',
      present: status?.files?.configured ?? null,
      source: 'unknown',
      hint: status?.files?.hint || 'GATEWAY_USER / GATEWAY_PASS for the file server.',
      value: null,
      note: 'Required for the Files feature and for every document body.',
    },
    {
      key: 'mcp',
      present: null,
      source: 'unknown',
      hint: 'A `mcp_<32 hex>` token is minted by the backend, not exported from here.',
      value: null,
    },
  ];

  // Per-tool REST tokens. The client knows which tools EXPECT one (`hasToken`)
  // but never whether the relay holds it, so `present` is null, not false.
  for (const t of tools) {
    if (!t.hasToken) continue;
    out.push({
      key: `tool:${t.id}`,
      present: null,
      source: 'unknown',
      hint: `Bearer token for the "${t.name}" http tool.`,
      value: null,
    });
  }
  return out;
}

/**
 * Turn an `AgentSession` into DB rows.
 *
 * `kind` is always `'agent'`: the client only ever records agent runs. Voice and
 * note sessions exist in the schema for the backend's own writers and have no
 * client-side counterpart to import.
 */
function sessionRows(session: AgentsState['sessions'][number]): {
  session: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
} {
  return {
    session: {
      id: session.id,
      agent_id: session.agentId,
      kind: 'agent',
      title: session.title,
      status: session.status,
      turn_count: session.messages.length,
      created_at_ms: session.createdAt,
      updated_at_ms: session.updatedAt,
    },
    messages: session.messages.map((m, seq) => ({
      session_id: session.id,
      // The client stores messages in order and has no explicit sequence, so the
      // ARRAY INDEX *is* the sequence. Derived, not invented.
      seq,
      role: m.role,
      content: m.content,
      tool: m.tool ?? null,
      args: m.args ?? null,
      at_ms: m.at,
    })),
  };
}

/**
 * Build the whole bundle. Pure: no I/O, no clock reads beyond `now`.
 *
 * Everything is optional-chained because it is all assembled from stores that may
 * legitimately be empty — a fresh install exports an empty seed, and that is the
 * correct answer rather than an error.
 */
export function buildExportBundle(input: BuildExportInput): ExportBundle {
  const { hub, agents, ai, memory, status } = input;
  const now = input.now ?? Date.now();
  const tools = agents.tools ?? [];
  const agentsList = agents.agents ?? [];

  const documents = hub.sections?.docs ?? [];
  const todos = hub.sections?.todo ?? [];
  const files = hub.sections?.files ?? [];

  const toolRows = tools.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    description: t.description,
    url: t.url ?? null,
    method: t.method ?? null,
    body_template: t.bodyTemplate ?? null,
    has_token: t.hasToken === true,
    search_depth: t.searchDepth ?? null,
  }));

  const agentRows = agentsList.map((a) => ({
    id: a.id,
    name: a.name,
    system_prompt: a.systemPrompt,
    prompt: a.prompt,
    model: a.model ?? null,
    created_at_ms: a.createdAt,
    updated_at_ms: a.updatedAt ?? a.createdAt,
  }));

  const agentToolRows = agentsList.flatMap((a) =>
    (a.toolIds ?? []).map((toolId, ordinal) => ({ agent_id: a.id, tool_id: toolId, ordinal })),
  );

  const sessionParts = (agents.sessions ?? []).map(sessionRows);

  const appSettings: Array<{ key: string; value: string }> = [];
  const push = (key: string, value: string | undefined) => {
    if (value === undefined || value === '') return;
    appSettings.push({ key, value });
  };
  // Read from `fields` (the SAVED values) and not from the resolved ones, so an
  // export does not freeze an environment fallback into the database as if the
  // wearer had chosen it.
  push('model', status?.fields?.model ?? agents.llm?.model);
  push('referer', status?.fields?.referer ?? agents.llm?.referer);
  push('title', status?.fields?.title ?? agents.llm?.title);
  push('searchProvider', status?.fields?.searchProvider);
  push('depth', status?.fields?.depth ?? status?.search?.depth ?? status?.depth);

  const llmSettings: Record<string, string> = {
    provider: status?.provider || agents.llm?.provider || 'openrouter',
    model: status?.fields?.model ?? agents.llm?.model ?? '',
    referer: status?.fields?.referer ?? agents.llm?.referer ?? '',
    title: status?.fields?.title ?? agents.llm?.title ?? '',
  };

  const collections: ExportCollections = {
    app_user: input.email ? [{ email: input.email }] : [],
    app_setting: appSettings,
    app_secret: secretManifest(status, tools),
    hub_state: {
      active_section: hub.activeSection,
      active_doc_id: hub.activeDocId,
      updated_at_ms: hub.updatedAt,
    },
    todo_item: todos.map((t, ordinal) => ({ id: t.id, text: t.text, done: t.done, ordinal })),
    document: documents.map((d, ordinal) => ({
      id: d.id,
      title: d.title,
      content: d.content,
      updated_at_ms: d.updatedAt,
      ordinal,
    })),
    note: { content: hub.sections?.notes ?? '' },
    file_ref: files.map((f, ordinal) => ({
      id: f.id,
      title: f.title,
      agent: f.agent,
      url: f.url,
      size: f.size,
      updated_at_ms: f.updatedAt,
      ordinal,
    })),
    llm_settings: llmSettings,
    tool: toolRows,
    agent: agentRows,
    agent_tool: agentToolRows,
    jarvis_session: sessionParts.map((p) => p.session),
    session_message: sessionParts.flatMap((p) => p.messages),
    session_tombstone: Object.entries(agents.sessionsClearedAt ?? {}).map(([agent_id, at]) => ({
      agent_id,
      cleared_at_ms: at,
    })),
    memory_turn: (memory.turns ?? []).map((t, ordinal) => ({
      role: t.role,
      text: t.text,
      at_ms: t.at,
      ordinal,
    })),
    memory_digest: [
      { version: memory.version, digest: memory.digest, at_ms: memory.digestAt },
    ],
    ledger_entry: (input.ledger ?? []).map((e) => ({
      seq: e.seq,
      run_id: e.runId,
      at_ms: e.at,
      kind: e.kind,
      by: e.by,
      effect: e.effect,
      status: e.status,
      text: e.text,
      refs: e.refs ?? [],
      locus: e.locus ?? null,
      payload: e.payload ?? null,
    })),
  };

  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(collections)) {
    counts[key] = Array.isArray(value) ? value.length : 1;
  }

  const warnings: string[] = [
    'Ids are the CLIENT\'s own. `uid()` uses crypto.randomUUID() when the WebView has it and falls back to `id-<ms>-<rand>`, so some ids are NOT UUIDs. Map each legacy id deterministically (e.g. uuidv5) and keep the original in a `legacy_id` column, or the insert fails on the uuid primary key.',
    'app_secret rows are a MANIFEST: `value` is null for every one of them. Secret values never reach the browser by design. Seed them from web/.g2-hub-secrets.json (or the host environment) — the `key` and `hint` fields tell you what to fetch.',
    'file_ref carries REFERENCES only. No row in this file holds a document body, and none should: bodies live on the gateway and are fetched on demand.',
    'session_message.seq is the array index. The client stores messages in order and has no explicit sequence number, so the index IS the sequence.',
    'sessions are capped CLIENT-side (MAX_SESSIONS=5 per agent, MAX_SESSIONS_TOTAL=30). The exported history is therefore a subset of everything ever run, and it is the same subset every device already has.',
    'jarvis_session.kind is always \'agent\'. The client records agent runs only; `voice` and `note` sessions have no client-side counterpart.',
    'Every timestamp is a ms-epoch NUMBER (`*_at_ms`, `updated_at_ms`). Convert to timestamptz in the repository layer, never in a route.',
    '`ordinal` on todo_item / document / file_ref is the ARRAY POSITION of the collection. Array position is data here — it is the user\'s chosen order — so import it rather than re-sorting by created_at.',
    'The L1 durable keys (hub:docs, hub:deviceId, hub:owner) are client CACHES, not server state, and are not exported as tables. Documents arrive as `document` rows from the live hub state.',
    'app_setting holds only NON-SECRET relay settings, read from the SAVED values. client_local.ai_settings is browser-local (Jarvis enable/model/maxSteps) and is NOT server state — do not seed it into app_setting.',
  ];
  if (input.ledger) {
    warnings.push(
      'ledger_entry was requested explicitly: it is TRANSIENT, in-memory runtime state with a seq that restarts on reload, not part of the persistent corpus. Seeding it into an append-only audit table is a deliberate choice, not a migration of user data.',
    );
  } else {
    warnings.push(
      'ledger_entry is EMPTY because it was not requested. The run ledger is transient runtime state; include it only if you intend to seed the audit table.',
    );
  }
  if (!status) {
    warnings.push(
      'The relay did not answer when this export ran, so `app_secret.present` is null for every key (unknown, not absent) and app_setting holds only what the client already had.',
    );
  }

  return {
    $format: EXPORT_FORMAT,
    $version: EXPORT_VERSION,
    meta: {
      generatedAt: new Date(now).toISOString(),
      generatedAtMs: now,
      appVersion: input.appVersion,
      origin: input.origin,
      href: input.href ?? (typeof location === 'undefined' ? '' : location.href),
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      spec: EXPORT_SPEC,
    },
    identity: {
      email: input.email,
      deviceId: input.deviceId,
      ...(input.includeOwnerCredential ? { ownerToken: input.includeOwnerCredential } : {}),
    },
    counts,
    warnings,
    collections,
    client_local: { ai_settings: ai.settings },
  };
}

/** `g2-hub-seed-2026-09-30-1412.json` — sortable, and obvious at a glance. */
export function exportFilename(now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `g2-hub-seed-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

/** Pretty-printed, so the file can be read and diffed by a human. */
export function serializeBundle(bundle: ExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Hand the text to the browser as a download.
 *
 * Returns the blob size, or `null` when the WebView refused to start a download —
 * which happens on some Even App builds. The caller must handle the null by
 * offering the clipboard, because a silent failure here is indistinguishable from
 * a successful export that produced nothing.
 */
export function downloadJson(filename: string, text: string): number | null {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on a later task: Safari/iOS cancels an in-flight download if the
    // object URL is revoked synchronously after the click.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return blob.size;
  } catch {
    return null;
  }
}

/** `12.4 kB` — for a status line, not arithmetic. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
