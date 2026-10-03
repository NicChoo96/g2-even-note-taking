# 01 — Inventory: every data interface, model and tool that exists today

Everything in this document was read from the source. Field names are real.
"Null?" is `?` in the source unless the note says otherwise. Where a field is
load-bearing, the note says why — those notes are the requirements the database
schema has to reproduce.

---

## 1. Where every byte lives today

### 1.1 Browser / WebView stores

| Key | Owner module | Shape | Written by |
|---|---|---|---|
| `hub:docs` | `durable-docs.ts` | `{ docs: DocEntry[], activeDocId: string \| null }` (serialized) | `store.ts` on every hub change |
| `hub:agents` | `durable-agents.ts` | `{ agents, tools, llm }` — **no sessions** | `agents-store.ts` `persist()` (bridge mirror) |
| `hub:agents` (localStorage) | `agents-store.ts` | full `AgentsState` **including sessions** | `agents-store.ts` `persist()` |
| `hub:agentSessions` | `durable-agents.ts` | `AgentSession[]` | `agents-store.ts` `persist()` |
| `hub:ai-memory` | `durable-docs.ts` | `JarvisMemory` JSON | `ai/memory.ts` `persist()` |
| `hub:deviceId` | `durable-docs.ts` | string (UUID) | pairing flow |
| `hub:owner` | `durable-docs.ts` | `OwnerSession { token, email \| null }` | sign-in |

**⚠ LOAD-BEARING divergence:** on a **real Even App device**, only the bridge
store survives a WebView teardown; on a **browser**, only `localStorage` does. The
bridge mirror of `hub:agents` deliberately omits `sessions`, which is exactly why
`loadLocal()` runs `mergeSessions([], sessions, cleared)` instead of a bare
`pruneSessions` — the two copies disagree by design, and merging is what stops the
narrower one deleting the other's history.

### 1.2 Relay-side files

| File | Shape | Notes |
|---|---|---|
| `web/.g2-hub-state.json` | `{ [channel]: lastState \| null }` | **Only** `hub` and `agents` may appear — `persistState` skips `TRANSIENT_CHANNELS` |
| `web/.g2-hub-auth.json` | `{ sessions: {...}, devices: {...} }` | session token → `{ email, createdAt }`; device → `{ deviceId, pairCode, status, createdAt, approvedAt }` |
| `web/.g2-hub-secrets.json` | `{ openrouterKey, tavilyKey, braveKey, model, referer, title, depth, searchProvider, toolTokens: { [toolId]: token } }` | Never leaves the server. Only booleans are echoed to clients. |

All three are git-ignored. `STATE_FILE` / `AUTH_FILE` / `SECRETS_FILE` default to
`join(process.cwd(), …)`, which is why the relay is started from `web/`.

### 1.3 In-memory only

`AiState` (the run HUD), the ledger (`entries`, `nextSeq`), `agent-runs.ts`'s live
run list, `ai/monitor.ts` watch queue, `ai/undo.ts` batches, `ai/store.ts` mirror
state, and the location snapshot side table. **None of this is persisted today.**
The ledger and the location snapshot are both nominated for persistence in
`02-database-spec.md`; the rest stay in memory on purpose.

---

## 2. The hub data model

Source: `glasses/src/types.ts`. This is **the render contract** — its shape must
not change, only its source.

```ts
type SectionId = 'todo' | 'docs' | 'files' | 'notes' | 'agents';
const SECTION_IDS: SectionId[] = ['agents','todo','docs','files','notes']; // display order
```

`SECTION_IDS` is the single ordering authority: the glasses menu (`SECTIONS` in
`sections.ts`) and the web tabs (`TAB_ORDER`) both mirror it.

### `HubState`

| Field | Type | Null? | Notes |
|---|---|---|---|
| `activeSection` | `SectionId` | no | Which tab is showing. Per-device UI state that happens to be synced. |
| `sections.todo` | `TodoItem[]` | no | Ordered by array position — **the order is data**. |
| `sections.docs` | `DocEntry[]` | no | A library (multiple named docs). |
| `sections.files` | `FileRef[]` | no | **References only.** |
| `sections.notes` | `string` | no | One free-text blob. May be empty, never null. |
| `activeDocId` | `string \| null` | yes | `null` → fall back to `docs[0]` (see `activeDoc()`). |
| `updatedAt` | `number` (ms epoch) | no | **The collection stamp** the backwards-sync guard compares. |

### `TodoItem`

| Field | Type | Null? | Notes |
|---|---|---|---|
| `id` | `string` | no | `uid()` → `crypto.randomUUID()`, with an `id-<ts>-<rand>` fallback. |
| `text` | `string` | no | Rendered verbatim; clipped by `clipBytes` at 999 UTF-8 bytes for the HUD only. |
| `done` | `boolean` | no | |

### `DocEntry`

| Field | Type | Null? | Notes |
|---|---|---|---|
| `id` | `string` | no | |
| `title` | `string` | no | `emptyDoc()` defaults to `'Untitled'`. |
| `content` | `string` | no | **Unbounded.** This is the largest field in `HubState` and the reason `HubState` cannot simply be a row. |
| `updatedAt` | `number` | no | Re-stamped by `upsertDoc()` on **every** write, including renames. |

### `FileRef` — a REFERENCE, and it must never gain a body

| Field | Type | Null? | Notes |
|---|---|---|---|
| `id` | `string` | no | The gateway's 32-hex document id. |
| `title` | `string` | no | |
| `agent` | `string` | no | Authoring agent as recorded by the publisher; `''` when unset. |
| `url` | `string` | no | Absolute gateway URL of the body. **For display/debug — the gateway refuses to be framed.** |
| `size` | `number` | no | Bytes. |
| `updatedAt` | `number` | no | |

> **⚠ LOAD-BEARING (twice over).** `HubState` is broadcast to every device *and*
> mirrored to the relay's state file, so a body stored here is copied into a
> public-ish place; and a 4 MiB document would blow the 999-byte frame budget
> anyway. The list row is all the glasses can ever show. **The database schema
> must not have a body column on the file-ref table** — see `02-database-spec.md`.

### Hub helpers (the semantics the schema must preserve)

| Function | Semantics |
|---|---|
| `emptyHubState()` | `activeSection:'todo'`, all sections empty, `activeDocId:null`, `updatedAt: Date.now()`. |
| `activeDoc(state)` | find by `activeDocId` → else `docs[0]` → else `null`. |
| `upsertDoc(state, doc)` | rewrite if `id` exists else append; **both** stamp `updatedAt: Date.now()`. Returns the new `docs` array **and** `activeDocId = doc.id`. |

Note what `upsertDoc` implies: **opening a doc is not a write, but saving one
always makes it newest and makes it active.** The database equivalent is a
`PUT /docs/:id` that returns the new `updated_at` and sets `hub_state.active_doc_id`
in the same transaction.

---

## 3. The agents data model

Source: `glasses/src/types.ts`. **A separate channel from `HubState`, on purpose.**

> Agent configs, tool secrets and session transcripts must never ride the hub
> channel: `HubState` is broadcast to every device *and* mirrored to the relay's
> state file, so anything in it is effectively public.

### `AgentsState`

| Field | Type | Null? | Notes |
|---|---|---|---|
| `agents` | `AgentDef[]` | no | Ordered by the surface (`orderedAgents`: `updatedAt` desc, `createdAt` fallback). |
| `tools` | `ToolDef[]` | no | **⚠ The seeded web-search tool (`kind:'web'`) is always present** — `loadLocal()` re-injects it. |
| `llm` | `LlmSettings` | no | |
| `sessions` | `AgentSession[]` | no | Newest first, capped per agent. |
| `sessionsClearedAt` | `Record<string, number>` | optional | **The tombstone map.** `agentId → ms`. |
| `updatedAt` | `number` | no | Collection stamp. |

### `AgentDef`

| Field | Type | Null? | Notes |
|---|---|---|---|
| `id` | `string` | no | |
| `name` | `string` | no | |
| `systemPrompt` | `string` | no | |
| `prompt` | `string` | no | **Backfilled to `''` on every ingress path** — legacy agents predate it and the glasses menu calls `.trim()`. |
| `toolIds` | `string[]` | no | Ids of `ToolDef`s this agent may call. **Normalized through `normalizeToolId` on every ingress path** so a migrated tool and its reference stay consistent. |
| `model` | `string` | optional | Per-agent override; falls back to `LlmSettings.model`. |
| `createdAt` | `number` | no | |
| `updatedAt` | `number` | optional | Drives list order; backfilled to `createdAt`. |

### `ToolDef`

| Field | Type | Null? | Notes |
|---|---|---|---|
| `id` | `string` | no | Seed ids: `tool-web`, `tool-jev`, `tool-files`, `tool-todo`, `tool-docs`, `tool-notes`, `tool-location`. |
| `name` | `string` | no | **Model-facing.** Must match the provider's `^[a-zA-Z0-9_-]+$`. |
| `kind` | `ToolKind` | no | `'web' \| 'http' \| 'jev' \| 'files' \| 'todo' \| 'docs' \| 'notes' \| 'location'` |
| `description` | `string` | no | What the model reads when deciding to call it. |
| `url` | `string` | optional | `http` tools: absolute endpoint. |
| `method` | `'GET' \| 'POST'` | optional | `http` tools; default POST. |
| `bodyTemplate` | `string` | optional | **Its KEYS become the parameters the model is offered.** An empty/null value is REQUIRED; a filled one is the default. Blank → fall back to a free-form `body` object. |
| `hasToken` | `boolean` | optional | The secret itself is server-side (`toolTokens` in the secrets file). **Never the token, only this boolean.** |
| `searchDepth` | `'basic' \| 'advanced'` | optional | `web` only. Default `'basic'`. |

**Legacy normalization, one place per concern** (`normalizeTool` / `normalizeToolId`):
kind `tavily`→`web`; id `tool-tavily`→`tool-web`; name `tavily_search`→`web_search`
**only** when the tool was actually of the legacy kind and still carried the seed
name (a user who deliberately named a tool `tavily_search` keeps their label).

### `LlmSettings`

| Field | Type | Null? | Notes |
|---|---|---|---|
| `provider` | `'openrouter'` | no | Literal, not a union — there is one provider. |
| `model` | `string` | no | `DEFAULT_MODEL = 'inclusionai/ling-3.0-flash-sante:free'`. |
| `referer` | `string` | optional | Sent as `HTTP-Referer`. |
| `title` | `string` | optional | Sent as `X-OpenRouter-Title`. |
| `hasKey` | `boolean` | optional | **True once a key is configured SERVER-SIDE. The key itself never reaches a client.** |

### `AgentSession` / `AgentMessage`

| `AgentSession` | Type | Null? | Notes |
|---|---|---|---|
| `id` | `string` | no | |
| `agentId` | `string` | no | |
| `title` | `string` | no | First prompt, truncated — the history-list label. |
| `messages` | `AgentMessage[]` | no | |
| `status` | `'running' \| 'done' \| 'error'` | no | |
| `createdAt` | `number` | no | |
| `updatedAt` | `number` | no | Drives ordering **and** the tombstone filter. |

| `AgentMessage` | Type | Null? | Notes |
|---|---|---|---|
| `role` | `'user' \| 'assistant' \| 'tool'` | no | |
| `content` | `string` | no | |
| `tool` | `string` | optional | assistant: name of the tool it called. |
| `args` | `string` | optional | assistant: **JSON args as a string** — shown in the detail pane. |
| `at` | `number` | no | |

### Caps, and what they are actually for

```ts
MAX_SESSIONS = 5;              // per agent
MAX_SESSIONS_TOTAL = MAX_SESSIONS * 6;  // 30
```

> "This list is published in full on every `agents` edit and persisted verbatim
> by the relay, so it must not be unbounded."

**This is a sync-budget constraint, not a product decision** — and it is the
single strongest argument for moving sessions to their own table. `pruneSessions`
is *per agent* (the fix for a shipped bug where the cap was applied to the whole
array, so "5 sessions" meant "5 sessions for the entire app" and finishing a run
for agent B evicted agent A's last session).

### The three merge policies, verbatim

| Function | Policy | The bug it prevents |
|---|---|---|
| `mergeSessions(local, incoming, clearedAt)` | Union by `id`; **incoming wins unless it is strictly POORER** (`(s.messages?.length ?? 0) >= (prev.messages?.length ?? 0)`); then tombstone-filter `!stamp \|\| (s.updatedAt ?? 0) > stamp`; then `pruneSessions`. | A backgrounded device ships a *shorter* list (it never learned about runs it did not witness). Replacing with it deleted history — on the relay too, because the relay persisted the deletion. |
| `mergeClearedAt(local, incoming)` | Newest-wins union of the tombstone maps. | An older clear overwriting a newer one would resurrect everything cleared in between. |
| `pruneSessions(list)` | Per-agent cap to `MAX_SESSIONS`, then the global ceiling. | See above. |

> **⚠ LOAD-BEARING note in the source:** the comparison direction is the whole
> fix. Writing it as `>` on the local side makes an incoming **rewrite** lose on
> equal lengths, which breaks backdating and corrections — it made the monitor
> harness's backdated fixtures a no-op.
>
> **⚠ LOAD-BEARING:** no stamp means nothing was ever cleared for that agent, so
> every session is kept. The filter must never act as an accidental
> `updatedAt > 0` test.

---

## 4. Jarvis memory model

Source: `glasses/src/ai/memory.ts`.

```ts
interface MemoryTurn { role: 'user' | 'assistant'; text: string; at: number }

interface JarvisMemory {
  version: number;        // MEMORY_VERSION = 1
  digest: string;         // model-written gist of everything folded away ('' until first)
  digestAt: number;
  folded: number;         // how many turns have been folded into `digest`
  turns: MemoryTurn[];    // verbatim, oldest → newest
  updatedAt: number;
}
```

### Budgets

| Constant | Value | Kind |
|---|---|---|
| `MEMORY_MAX_WORDS` | `100_000` | **The promise.** Words (whitespace tokens) — the only unit a user can reason about. |
| `MEMORY_DIGEST_WORDS` | `400` | Summary target length. |
| `MEMORY_KEEP_TURNS` | `20` | Never folded away — the recent conversation. |
| `MEMORY_PROMPT_TURNS` | `6` | Verbatim turns pasted into a turn's transcript. |
| `MEMORY_PROMPT_CHARS` | `1400` | Char budget for that block. |
| `MEMORY_TURN_CHARS` | `2000` | One turn's cap. |
| `MEMORY_MAX_CHARS` | `60_000` | **A storage guard, not a policy.** Persistence is a WebView bridge round-trip; a blob past a few tens of KB is a write that can fail silently. Crossing it folds EARLY — it never discards. |

### Derived read model

`MemoryView { turns, folded, words, capWords, digestWords, digest, updatedAt }` —
a flattened, cached-identity shape for `useSyncExternalStore`.

### The compaction contract — this IS the summary design

`compactionPrompt(m, older)` asks for **ONE factual summary of at most 400
words**, plain prose, third person, no markdown/lists/emoji, **merging the
existing summary rather than restarting it**. Keep: names, dates, preferences,
decisions, outstanding tasks, anything the wearer asked to be remembered. Drop:
pleasantries, failed attempts, repeated commands, anything with no lasting value.

`compactMemory(ask?)` keeps every turn except the newest `MEMORY_KEEP_TURNS`,
bumps `folded`, persists, emits. **On failure it KEEPS the verbatim log** — "a
relay that is down must not cost history."

> **This is the pattern the database must generalise.** Today it is one global
> digest. `06-jarvis-sessions.md` makes it per-session and versioned. Two things
> must survive: the summariser is optional and its failure is non-destructive;
> and a summary is **derived**, never authoritative.

### The tool-free LLM call

`defaultAsk` calls `llmChat({ model, messages })` with **no `tools` on purpose** —
"a tool-free request is the one shape DeepSeek will answer in prose (see
`./tool-markup` for what happens otherwise)." Any new summarisation call must
respect this.

---

## 5. The AI run / capability model

### 5.1 `Capability` — the declarative tool layer

Source: `glasses/src/ai/types.ts`.

> Everything the AI can DO in the app is described declaratively as a
> `Capability`. Nothing in the agent loop, the JSON-schema builder, the argument
> validator, the dispatcher, the HUD labels or the web catalog knows about any
> specific capability. Introducing a new page or a new action is a pure DATA
> change.

| Field | Type | Null? | Notes |
|---|---|---|---|
| `name` | `string` | no | Globally unique dotted: `'todo.add'`. |
| `page` | `PageId` | no | Layer-2 routing key. |
| `title` | `string` | no | Short human label for the HUD. |
| `description` | `string` | no | LLM-facing. |
| `params` | `ParamSpec[]` | no | |
| `confirm` | `boolean` | optional | On the glasses the run pauses for a tap-to-confirm (**destructive-only policy**). |
| `effect` | `Effect` | optional | **Declared, not inferred.** See §5.3. |
| `available` | `() => boolean` | optional | Declarative gating against live state. |
| `run` | `(args) => CapabilityResult \| Promise<…>` | no | |

`PageId = SectionId | 'global' | 'settings'`; `GLOBAL_PAGE = 'global'`.

```ts
interface PageDef { id: PageId; title: string; synonyms: string[]; summary: string }
type ParamType = 'string' | 'number' | 'boolean' | 'enum';
interface ParamSpec {
  name: string; type: ParamType; description: string;
  required?: boolean; values?: string[];                // values only for 'enum'
  fallback?: string | number | boolean;
}
interface CapabilityResult { ok: boolean; summary: string; data?: unknown; hint?: string }
```

`CapabilityResult.summary` is **ONE short line rendered verbatim on the glasses**
— keep it emoji-free (the G2 firmware font has no emoji glyphs).

> **⚠ LOAD-BEARING — the wire-name rule.** The provider requires
> `function.name` to match `^[a-zA-Z0-9_-]+$`. **One dotted name rejects the
> ENTIRE tools array with HTTP 400.** So the adapter keeps the authoring name
> `page.action` and emits `page__action` (`WIRE_SEP = '__'`); `capabilityByName`
> accepts both.

> **⚠ LOAD-BEARING — `effectOf(cap)`.** `cap.effect ?? (cap.confirm ?
> 'irreversible' : 'read')`. This fallback reproduces the pre-ledger behaviour
> **exactly**, so adding `effect` changed nothing that had already shipped. Any
> schema for capabilities must keep `effect` nullable and keep this derivation.

### 5.2 `AiState` — the run HUD (in memory, not persisted)

Source: `glasses/src/ai/store.ts`.

| Field | Type | Null? | Notes |
|---|---|---|---|
| `status` | `'idle' \| 'running' \| 'confirm' \| 'done' \| 'error'` | no | |
| `focus` | `PageId` | no | The page layer-2 actions may run on. |
| `utterance` | `string` | no | |
| `steps` | `AiStep[]` | no | ⚠ `MAX_STEPS_KEPT = 60` — mirrored to the other surface on every change. |
| `turn` / `maxSteps` | `number` | no | Drives the HUD's counter. |
| `pending` | `{ title, lines } \| null` | yes | Set while a run waits for a tap-to-confirm. |
| `result` / `error` | `string` | no | |
| `webTab` | `string \| null` | yes | A companion tab the AI asked to open; consumed by `App.tsx`. |
| `settings` | `AiSettings` | no | `{ enabled, model, maxSteps }`. |
| `mirrored` | `boolean` | no | **Part of the rendered state on purpose** — the controls must tell the user to act on the owning surface instead of silently doing nothing. |

`AiStep { kind: AiStepKind; text; at }` with
`AiStepKind = 'focus' | 'think' | 'call' | 'ok' | 'fail' | 'reply' | 'note'`.
`'think'` is the model's **own** reasoning; the others are written by the loop.
`AiStepMeta { effect?, locus?, status?, refs?, by?, payload? }` is the optional
classification a caller attaches when it knows more than the store.

**Cross-surface shapes** (transient, never persisted):
`AiSnapshot { owner, at, status, focus, utterance, steps, turn, maxSteps, pending,
result, error }` — trimmed to what a renderer draws (settings and `webTab` stay
local to the owner). `AiControl { target, at, action:'stop'|'confirm', approve? }`
— a **directed** frame; everyone but the target drops it.

**Timings** (`ai/sync.ts`): `HEARTBEAT_MS = 2000`, `MIRROR_TTL_MS = 8000`,
`CONTROL_TTL_MS = 15000`, `MIRROR_MAX_AGE_MS = 3_600_000`; `AI_INSTANCE_ID` is
per-boot.

### 5.3 The ledger — the only durable-by-intent log

Source: `glasses/src/ai/ledger.ts`.

```ts
type Effect = 'pure' | 'read' | 'write' | 'irreversible';   // EFFECT_ORDER, weakest first
type EntryKind = 'ask'|'delta'|'route'|'call'|'result'|'reply'|'decision'|'gate'|'note'|'error';
type EntryBy = 'wearer' | 'jarvis' | 'agent' | 'jev' | 'system';
type EntryStatus = 'pending' | 'ok' | 'failed' | 'skipped' | 'declined';
type EntryLocus = 'client' | 'relay';
```

| `Entry` | Type | Null? | Notes |
|---|---|---|---|
| `seq` | `number` | no | Monotonic, never reused. **The causal handle.** |
| `runId` | `string` | no | |
| `at` | `number` | no | |
| `kind` / `by` / `effect` / `status` | enums above | no | |
| `text` | `string` | no | ⚠ ONE short ASCII line, `MAX_TEXT_CHARS = 120`, stripped to `\x20-\x7E`. Safe to render on the glasses. |
| `refs` | `number[]` | no | **`seq` values this entry consumed — its causal parents.** Turns a flat list into a traceable chain and lets a chain step inherit the exact output it was built on instead of re-reading a summary. |
| `locus` | `EntryLocus` | optional | |
| `payload` | `unknown` | optional | Structured detail. **Never rendered on the glasses.** |

`MAX_ENTRIES = 400` (bounded because it is mirrored on every change).

> **⚠ LOAD-BEARING rule 1 — APPEND-ONLY.** No update, no delete. A reversed
> decision is a NEW entry; the old one stays. `ledgerResolve(seq, status, text?)`
> is an **append** referencing the original's `seq`, not an edit.
>
> **⚠ LOAD-BEARING rule 2 — the ledger RECORDS; it does not OWN state.**
> `HubState` stays the single source of truth. The ledger is a SUPERSET generated
> *from* `run.messages`. It must never become a competing copy.
>
> **⚠ THE SAFETY INVARIANT:** an `irreversible` entry may not succeed without a
> preceding **approved `gate`** in the same run. Checked by
> `ungatedIrreversible()` (which must exclude `kind !== 'gate'`, or it flags the
> approval itself) and asserted by the harness. `write` is deliberately **NOT**
> gated — "gating an undoable action trains the wearer to approve without
> reading." A property of the record cannot be forgotten; a per-tool flag has a
> 100% failure rate eventually.

`ledgerBegin(runId)` sets the default `runId` for subsequent appends.

### 5.4 The capability catalog — all 44, by page

`page` is the routing key; `name` is the dotted authoring name; the wire name is
`page__action`.

#### `global` — always available (`global.ts`)

| name | effect | confirm | Notes |
|---|---|---|---|
| `nav.list_pages` | — | — | |
| `nav.list_actions` | — | — | |
| `nav.open_page` | — | — | |
| `nav.back` | — | — | |
| `app.status` | — | — | |
| `say.reply` | `pure` | — | The model's answer to the wearer. |
| `undo.last` | `write` | — | `MAX_BATCHES = 3`; `undo.ts`'s `history` is module-local. |

`ALWAYS_AVAILABLE = ['jev.decide']` is separate from `global` — jev is mandatory,
not a page action.

#### `todo` (`todo.ts`)

| name | effect | confirm |
|---|---|---|
| `todo.add` | `write` | — |
| `todo.set_done` | `write` | — |
| `todo.edit` | `write` | — |
| `todo.remove` | `write` | ✔ |
| `todo.clear_done` | `write` | ✔ |
| `todo.clear_all` | **`irreversible`** | ✔ |

#### `docs` (`docs.ts`) — the wearer's own library

| name | effect | confirm |
|---|---|---|
| `docs.new` | `write` | — |
| `docs.open` | — | — |
| `docs.append` | `write` | — |
| `docs.set_content` | **`irreversible`** | ✔ |
| `docs.rename` | `write` | — |
| `docs.delete` | **`irreversible`** | ✔ |
| `docs.read` | — | — |

#### `notes` (`notes.ts`)

| name | effect | confirm |
|---|---|---|
| `notes.append` | `write` | — |
| `notes.set` | **`irreversible`** | ✔ |
| `notes.clear` | **`irreversible`** | ✔ |
| `notes.read` | — | — |

#### `files` (`files.ts`) — the gateway-backed store

| name | effect | confirm |
|---|---|---|
| `files.list` | — | — |
| `files.read` | — | — |
| `files.publish` | `write` | ✔ |
| `files.delete` | **`irreversible`** | ✔ |
| `files.history` | `read` | — |
| `files.revert` | `write` | ✔ |

#### `agents` (`agents.ts`)

| name | effect | confirm | Notes |
|---|---|---|---|
| `agents.list` | — | — | |
| `agents.sessions` | — | — | |
| `agents.trigger` | `write` | — | |
| `agents.stop` | `write` | — | |
| `agents.create` | `write` | — | |
| `agents.update` | `write` | — | |
| `agents.clone` | `write` | — | |
| `agents.delete` | **`irreversible`** | ✔ | |
| `tools.list` | — | — | **⚠ A READ that must NEVER call `ensureSeedTool`.** |

`SEED_TOOLS` in this file has 6+ entries with two ordering constraints that are
load-bearing: **`FILES_SEED` must stay LAST**, and **`DOCS_SEED` must not contain
a bare `docs?`** (it would match the docs page's own actions).

#### `settings` (`settings.ts`) — read-only on purpose

| name | effect |
|---|---|
| `settings.open` | — |
| `settings.read` | — |

#### `jev` (`jev.ts`)

| name | effect | Notes |
|---|---|---|
| `jev.decide` | `pure` | Params `state` + `questions`, where `questions` is a **JSON-encoded string** (because `ParamSpec` has no object type). **Fails honestly.** |

#### `location` (`location.ts`)

| name | effect | Notes |
|---|---|---|
| `location.get` | `read` | **Not `pure`.** The only kind whose data the RELAY cannot fetch: a fix lives in the phone, so the client resolves it at trigger time and sends it ALONG WITH the run. The snapshot lives in a side table, **never on the run object**. |

#### The six irreversible capabilities (the gate set)

`docs.set_content`, `docs.delete`, `notes.set`, `notes.clear`, `todo.clear_all`,
`agents.delete`.

### 5.5 The agent loop's own limits (`ai/agent.ts`)

`MAX_TOOLS = 13`; `MAX_RESULT_CHARS = 120000`; `MANDATORY` / `RESERVED` keep
`jev.decide` always available; `pageBudget = MAX_TOOLS - reserved.length` = 9;
`selectTools` is **exported for tests**; `shortJson` clips string **leaves**
longest-first. `AiRunOptions` / `AiRunResult` are the loop's I/O types.

---

## 6. Live run + transport models

### 6.1 `AgentRun` — server-side execution, never persisted as-is

Source: `glasses/src/stream.ts`.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | |
| `agentId` / `agentName` | `string` | |
| `prompt` / `title` | `string` | |
| `messages` | `RunMessage[]` | `RunMessage { role, content, tool?, args?, at }` |
| `status` | `'running' \| 'done' \| 'error' \| 'stopped'` | |
| `statusText` | `string` | |
| `error` | `string` | optional |
| `startedAt` / `updatedAt` | `number` | |

`RunFrame = { type:'run', run } | { type:'runInit', runs }`.
`RunStartResult { runId: string \| null; error: string }` — **the failure reason is
returned rather than swallowed**, because a CORS preflight rejection, an expired
session and a missing key all used to collapse into one opaque message.

`agent-runs.ts` keeps the last **12** in memory (running first, then newest) and
`pickRunForAgent()` resolves strictly by `agentId` — a run still executing owns
the pane whatever its age.

### 6.2 SSE frames

| Frame | Payload | When |
|---|---|---|
| `init` | `{ type:'init', state }` | once on connect |
| `state` | `{ type:'state', state }` | every change |
| multiplexed | same, **plus `channel`** | a frame on a multi-channel connection |

URL shape: `/api/stream?channel=hub&token=<session-token-or-device-id>`, or
`?channels=a,b,c` for the multiplexed form. **⚠ One `EventSource` per relay base,
never one per channel** — see the socket-starvation note in `00-overview.md` D-§2.

### 6.3 Web clients — the shapes the SPA already speaks

| Type | File | Fields |
|---|---|---|
| `AgentStatus` | `web/agents-client.ts` | `ok, provider?, llm, tavily, search?{provider,configured,depth,keys{tavily,brave}}, jev?, files?{configured,mode,url,hint}, model, depth, fields?{model,depth,searchProvider,referer,title}, source?{llm,search,tavily,jev}` |
| `SettingsPatch` | same | `openrouterKey?, deepseekKey?, tavilyKey?, braveKey?, searchProvider?, model?, referer?, title?, depth?, toolTokens?, clear?: string[]` |
| `WireToolCall` | same | `{ id, type:'function', function:{ name, arguments } }` |
| `WireMessage` | same | `{ role:'system'\|'user'\|'assistant'\|'tool', content, tool_calls?, tool_call_id?, name?, reasoning_content? }` |
| `LlmReply` | same | `{ ok, model?, message?, usage?, error? }` |
| `ToolReply` | same | `{ ok, result?, error? }` |
| `ValueSource` | same | `'env' \| 'settings' \| 'default' \| 'none'` |

`reasoning_content` is the normalised chain-of-thought: the relay folds DeepSeek's
`reasoning_content` and OpenRouter's `reasoning` into this one field.

**Two `SettingsPatch` rules that are semantics, not style** (from
`settings-patch.ts`, which is **PURE — no DOM**):
`always(key, f)` — blank **IS** the value; `ifSet(key, f)` — write-only, blank keys
are never sent; `model` travels only when `touched`. And `clear: string[]` exists
because a blank string cannot express "remove this" — a write-only key is never
echoed back, so an empty key box is indistinguishable from "leave it alone".

| Type | File | Fields |
|---|---|---|
| `StoredDoc` | `web/files-client.ts` | `id, title, agent, slug, tags[], version, size, url, updatedAt, deleted, deletedAt?, deletedReason?` |
| `FilesStatus` | same | `ok, configured?, mode?, url?, docOrigin?, hint?, error?` |
| `ListResult` | same | `ok, items: StoredDoc[], total, hasMore, error?` |
| `PublishInput` | same | `html, title?, agent?, tags?, id?, slug?, overwrite?, contentType?` |
| `ReadResult` / `DeleteResult` / `RestoreResult` | same | `{ok, document?/id?/hard?/deleted?, error?}` |
| `TextResult` | same | the whole-body read (`offset`, `limit`, `next`, `total`, `more`) |
| `UpdateInput`, `RevisionRef`, `RevisionListResult`, `RevisionResult`, `FileStats`, `TicketResult`, `MediaRef`, `MediaResult` | same | gateway wrappers |

`SELF_AGENT = 'g2-hub'` — whose name a document is filed under when this app
publishes one. `PublishInput.id` is a **32-hex id: re-sending the same id makes
publishing idempotent** — the one place idempotency already exists in this
codebase, and the model for `Idempotency-Key` everywhere else.

### 6.4 Location

`LocationFix { latitude, longitude, accuracy?, altitude?, speed?, heading?,
timestamp?, source:'hub'|'browser', capturedAt }`;
`STALE_AFTER_MS = 10 * 60 * 1000`.
`normalizeFix(raw, source, capturedAt)` requires lat/long **by RANGE, not
truthiness** — `0/0` is a real coordinate in the Gulf of Guinea and must be
believed; a missing or out-of-range pair yields `null`, never a substituted
default. Optional fields are dropped on failure rather than poisoning the fix.
`formatCoords` → 5 decimals (~1.1 m).

### 6.5 Identity

| Type | File | Fields |
|---|---|---|
| `OwnerSession` | `durable-docs.ts` | `{ token: string; email: string \| null }` |
| `PairedDevice` | `web/auth.tsx` | the device row shown in the Devices panel |
| principal | relay | `{ kind:'owner', email }` or `{ kind:'device', deviceId }` |

Owner session token = **48 hex chars** (`randomBytes(24)`); device ids = **36-char
UUIDs**. `readToken(req, url)` reads `?token=` then `Authorization: Bearer`.

---

## 7. The relay's existing API surface (the baseline REST set)

Enumerated from `web/server/local-sse.mjs`. Everything below is **already
authenticated and already same-origin** — the new API extends this, it does not
replace it.

| Route | Method | Auth |
|---|---|---|
| `/api/stream` | POST (state) / GET (SSE) | principal |
| `/api/config` | GET | public |
| `/api/auth/verify` `/api/auth/logout` `/api/auth/me` | POST/POST/GET | mixed |
| `/api/pair/request` `/api/pair/status` `/api/pair/approve` `/api/pair/revoke` | POST/GET/POST/POST | mixed |
| `/api/devices` | GET | owner |
| `/api/stt` `/api/stt/status` `/api/stt/ws` | POST/GET/WS | principal |
| `/api/agent/status` `/api/agent/run` `/api/agent/stop` `/api/agent/runs` | GET/POST/POST/GET | principal |
| `/api/settings` | POST | owner |
| `/api/llm` | POST | principal |
| `/api/tool` | POST | principal |
| `/api/decisions` | POST | principal |
| `/api/files` and `/api/files/:id` plus `/html`, `/text`, `/media`, `/ticket`, `/restore`, `/revisions`, `/revisions/:n`, `/revisions/:n/restore`, `/stats` | GET/POST/DELETE/PATCH | principal |
| `/app.json` | GET | public |

### 7.1 Channel state machine (the thing being replaced)

```js
TRANSIENT_CHANNELS = new Set(['ai', 'ai-ctl']);
getChannel(name) → { name, clients: Set, lastState: null }
loadPersistedState()   // skips TRANSIENT_CHANNELS
persistState(name, lastState)  // writes ALL non-transient channels, serialising each
send(client, frame, channelName)  // tags with `channel` only for a MULTIPLEXED client
publishHubState(state)  // the ONLY publisher that needs a socket
```

> **⚠ LOAD-BEARING:** a transient frame must never be cached in
> `channel.lastState`. A cached transient frame replays as the next client's
> `init`, which *is* the 0.3.24 "Jarvis killed itself" bug.

> **⚠ LOAD-BEARING — the backwards-sync guard (0.3.38):** `POST /api/stream`
> refuses a write when `!TRANSIENT_CHANNELS.has(...) && cachedStamp !== null &&
> incomingStamp !== null && incomingStamp < cachedStamp`, replies
> `{ ok: true, stale: true }` and re-broadcasts `channel.lastState`. Hub-tool call
> sites read `getChannel('hub').lastState` and return `NO_HUB_STATE_MSG` before
> calling the reducer. **This must not be weakened to a plain `!==`.**

`setCors`: `Access-Control-Allow-Origin: *`,
`Allow-Methods: GET, POST, OPTIONS`,
`Allow-Headers: Content-Type, Authorization` (**`Authorization` MUST be listed**
or the preflight blocks every Bearer call), `Max-Age: 600`.

### 7.2 The hub tool contract

`web/server/hub-tools.mjs`:
`HUB_TOOL_KINDS = Set(['todo','docs','notes'])`;
`runHubTool(tool, args, hub) → { ok, text, state? }` where **`state` is present
ONLY when something actually changed**; `normalizeHub` is **TOTAL**;
`READ_CHARS = 12000`.

| kind | actions |
|---|---|
| `todo` | `list`, `add`, `set_done`, `edit`, `remove`, `clear_done` |
| `docs` | `list`, `read`, `create`, `append`, `set_content`, `rename`, `delete`, `open` |
| `notes` | `read`, `append`, `set_content`, `clear` |

Other helpers: `short(text, max=40)`, `readFrom(raw, total)`, `splitItems(text)`,
`resolveIndex(target, items)`, `activeDocOf(hub)`, `hubToolSchema(t)`,
`hubToolSummary(tool, args)`.

### 7.3 The MCP substrate — a CLIENT today

`web/server/mcp-tools.mjs`:
`createMcpTools({ name, transport, prefix, ttlMs, now, log })` →
`{ name, list, schemas, catalog, call, drift, clear, peek }`.
Single-flight `list()`; **the cache is not written on failure** (a server briefly
down must not leave a half-built catalogue for ten minutes).
`httpTransport({ url, headers, fetch, handshake=false, timeoutMs=30_000 })`.
Constants: `MCP_INIT_METHOD='initialize'`, `MCP_LIST_METHOD='tools/list'`,
`MCP_CALL_METHOD='tools/call'`, `MCP_PROTOCOL_VERSION='2024-11-05'`,
`TOOLS_TTL_MS=600_000`, `MAX_TOOL_NAME=64`, `MAX_TOOLS=64`.
Helpers: `isJsonRpcError`, `rpcRequest(id, method, params)`,
`sanitizeInputSchema`, `toFunctionSchema`, `sanitizeToolName`,
`normalizeCatalogue(listResult, {prefix})`, `diffParams`, `foldDrift({...})`.

`web/server/mcp-router.mjs`:
`routeTools({ ask, catalogue, top=DEFAULT_TOP, respond, minCandidates=2 })` →
`{ chosen, all, routed, ranking, unresolved, reason }`.
`ROUTE_NAME='use'`, `DEFAULT_TOP=4`, `MAX_CANDIDATES=LIMITS.MAX_CRITERIA_COUNT=12`.
**It fails OPEN in eight distinct ways** and requires ≥1 numeric `p`, because an
unreadable jev result must never be read as declared order.

`web/server/jev-spec.mjs` (and its twin `glasses/src/ai/jev/spec.ts`):
`QUESTION_TYPES = ['noul','choice','score']`; `TOOL_KINDS = [...QUESTION_TYPES, 'rank']`;
`LIMITS` (incl. `MAX_CRITERIA_COUNT = 12`); `RANK_MARGIN = 0.1`;
`NAME_RE = /^[a-z][a-z0-9_]*$/`; `NOUL_KEYS = ['true','false']`.
Shapes: `JevNoulQuestion` / `JevChoiceQuestion` / `JevScoreQuestion` /
`JevQuestion` / `JevQuestions = Record<string, JevQuestion>` / `JevRequest`;
answers `JevNoulAnswer` / `JevChoiceAnswer` / `JevScoreAnswer` / `JevAnswer` /
`JevAnswers`; plus `JevFailure`, `JevResult<T> = {ok:true,value:T} | JevFailure`,
`JevRanked`, `JevRanking`. All validators return `{ ok: true, value }`.

> **⚠ THE TWO JEV TRAPS (settled by a live probe):**
> 1. A `score` answer is a **0-BASED CONTINUOUS float** — never shift it, only
>    clamp.
> 2. `probabilities` is keyed by **LABEL for `choice`** but by **INDEX for
>    `score`** — use the `relabel` param, never assume.
>
> `describeAnswers()` is the ONE formatter, ASCII only.

---

## 8. Tool schemas that already exist server-side

These are the wire contracts the database and the new API must keep feeding:

| Module | Export | Shape |
|---|---|---|
| `hub-tools.mjs` | `hubToolSchema(t)` | 1 schema per hub tool, actions as an `enum` |
| `jarvis-files.mjs` | `filesToolSchema` | **1 tool / 11 actions** |
| `http-tool.mjs` | `httpToolSchema`, `parseBodyTemplate`, `httpRequestArgs` | keys of `bodyTemplate` → parameters |
| `web-search.mjs` | `buildSearchRequest`, `tavilyHits`, `braveHits` | `PROVIDERS=['tavily','brave']`, both producing the SAME `[{title,url,content,age}]` — **byte-identical output invariant** |
| `mcp-tools.mjs` | `toFunctionSchema`, `normalizeCatalogue` | remote MCP → OpenAI function schema |
| `wire.mjs` | `assembleWire(run, resolvedText, now)` | merges **Card → Directives → Material → Ask** with a **byte-identity contract** |

> **⚠ DO NOT add a new top-level property to `filesToolSchema`** — it trips
> `mcp-tools-sim.mjs`'s `missingOnServer` **and** the relay's boot schema-drift
> check (`FILES_FOLD` / `checkFilesSchemaDrift()`). The `content` flag belongs to
> the capability layer.

---

## 9. Summary of what the database must accept

| # | Entity | Cardinality | Size class | Merge policy |
|---|---|---|---|---|
| 1 | hub scalar (`activeSection`, `activeDocId`) | 1/user | tiny | replace + `rev` |
| 2 | `TodoItem` | ~10²/user | tiny | **replace collection** + `rev` (never union) |
| 3 | `DocEntry` | ~10²/user | **large** (`content` unbounded) | **replace collection** + `rev`, per-doc `If-Match` |
| 4 | `notes` | 1/user | medium | replace + `rev` |
| 5 | `FileRef` | ~10²/user | tiny | upsert by id + soft-delete; **no body column** |
| 6 | `AgentDef` | ~10¹/user | small | LWW on the collection |
| 7 | `ToolDef` + `toolTokens` | ~10¹/user | small | LWW; token **server-only** |
| 8 | `LlmSettings` | 1/user | tiny | LWW; only `hasKey` echoed |
| 9 | `AgentSession` + `AgentMessage` | **unbounded in DB**, broadcast capped | large | **union + richer-wins + tombstone** |
| 10 | `JarvisMemory` turns + digest | unbounded in DB | large | append-only; digest **versioned** |
| 11 | `MemoryView` | derived | — | never stored |
| 12 | ledger `Entry` | 400 in memory, unbounded in DB | medium | **append-only, never merged** |
| 13 | `AgentRun` | ephemeral, ≤12 | medium | never persisted (finished run → session) |
| 14 | `LocationFix` snapshot | 1/run | tiny | append-only side table |
| 15 | device / pair / session / secret | ~10/user | tiny | server-authoritative |
| 16 | `session_summary` | 1..n/session | small | **append-only, versioned** |
