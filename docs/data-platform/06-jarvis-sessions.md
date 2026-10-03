# 06 — Jarvis sessions: save, summarise, and serve over MCP

The hardest part of the design. This document defines what a session **is**, how
it is stored, how a summary is produced, what "refer back to past sessions"
actually means mechanically, and how all of it is exposed as an MCP server so an
LLM can call it.

## 1. The problem with the current model

Today there are **two unrelated notions of "memory"**, stored in two places, with
two different shapes:

| | `AgentSession` (`types.ts`) | `JarvisMemory` (`ai/memory.ts`) |
|---|---|---|
| Where | `hub:agentSessions` (L1) | `hub:ai-memory` (L1) |
| Scope | per agent | global |
| Unit | `AgentMessage[]` (role, content, tool, args, at) | `MemoryTurn[]` (role, text, at) |
| Cap | `MAX_SESSIONS = 5` per agent, `MAX_SESSIONS_TOTAL = 30` | `MEMORY_MAX_WORDS = 2000`, `MEMORY_KEEP_TURNS = 40` |
| Summary | `title` only | one rolling `digest`, `MEMORY_DIGEST_WORDS = 400` |
| Retrieval | `latestSession(agentId)` | the digest is **unconditionally injected** into every prompt |

Consequences, in plain terms:

1. **Nothing is addressable.** `latestSession` is the only lookup. There is no way
   to ask for "the session where I planned the ferry trip".
2. **Nothing is searchable.** The digest is a lossy 400-word blob; a fact that was
   folded out is gone forever, and the cap makes that inevitable.
3. **The caps exist because the store is a blob.** 30 sessions × unbounded
   messages in one `localStorage` key is a quota failure waiting to happen, so
   sessions are pruned. `pruneSessions` **deletes** the 31st. A conversation the
   wearer had is silently destroyed by opening a new one.
4. **Voice sessions and agent sessions are different things that should not be.**
   A spoken utterance handled by `converse.ts` creates no session at all — it lands
   in `JarvisMemory.turns` if anywhere.
5. **The digest can only grow or be replaced, never be consulted.** There is no
   read path that says "show me what I decided about X".

The database design (`02-database-spec.md` §6–7) resolves these by making
**`jarvis_session` the single fact** and `AgentSession` and `JarvisMemory` into
**projections** of it. This document is about the behaviour on top of that.

## 2. One session model, three kinds

```ts
export type SessionKind =
  | 'agent'    // a run of an AgentDef: the loop in ai/agent.ts
  | 'voice'    // a spoken exchange handled by converse.ts / dictate
  | 'note';    // a passive capture (a dictated memo, a location ping)
```

All three rows share `jarvis_session`:

```
jarvis_session
  id             text pk            -- client-generated for offline creates
  user_id
  kind           SessionKind
  agent_id       text null          -- agent KIND only
  run_id         text null          -- links to the live AgentRun, if any
  title          text               -- user-editable; seeded from the first utterance
  status         'running'|'done'|'error'
  pinned         bool
  turn_count     int                -- denormalised by trigger (the richer-wins merge)
  word_count     int                -- denormalised; the compaction signal
  summary_version int               -- newest version, 0 = none
  created_at / updated_at / deleted_at
```

**Why one table and not three:** every operation an LLM or the wearer performs —
*find, summarise, read, clear* — is the same operation regardless of kind. Three
tables means three of everything, three recall paths, and three MCP tools that do
the same thing. The `kind` column is the discriminator, not a table.

**Why `turn_count` and `word_count` are denormalised by trigger rather than
computed:** the merge rule for sessions is *richer wins*
(`01-inventory.md` §3) and it must be evaluable **in SQL, in one query, for 30
sessions, in a list view**. Counting messages for every row in a list is the query
that makes the list slow enough that someone re-adds a cap.

## 3. `AgentSession` and `JarvisMemory` become projections

### 3.1 `AgentSession`

```sql
-- what GET /sessions?kind=agent&agentId=… returns, masked into AgentSession
SELECT s.id, s.agent_id, s.title, s.status, s.created_at, s.updated_at
FROM jarvis_session s WHERE s.deleted_at IS NULL …
```

The in-memory `AgentSession` keeps its exact shape. `messages` is populated
**only** when asked for (`GET /sessions/:id/messages`). `agent-runs.ts` continues
to reconcile live runs by `run_id`.

### 3.2 `JarvisMemory`

`JarvisMemory` stays as the injected prompt block, but becomes a **view**:

```
digest      ← the newest session_summary with scope='global'
turns       ← the newest `MEMORY_KEEP_TURNS` memory_turn rows
folded      ← count of memory_turn rows with folded_at IS NOT NULL
capWords    ← MEMORY_MAX_WORDS (unchanged, still client-enforced)
```

**⚠ The prompt contract must not change.** `JarvisMemory` is injected verbatim as
a system block. If the projection returns a different string, every prompt in the
app changes behaviour at once, with no test that would catch it. The projection
therefore returns the **same shape and the same rendering**, and the only
difference is where the words came from. `ai/memory.ts`'s `memoryBlock()` /
`compactionPrompt()` remain the only code that formats it.

### 3.3 Why projection and not migration

An alternative is to keep writing `hub:ai-memory` as the source of truth and
*treat* sessions as derived. Rejected: it makes the digest authoritative and the
transcript secondary, so a transcript that is lost is unrecoverable even though
the digest survives — the wrong way round, since the transcript is the evidence.
The digest is a **derived** artefact and must never be the only copy.

### 3.4 The caps, after

| Old cap | New | Why |
|---|---|---|
| `MAX_SESSIONS = 5` per agent | **no cap**; `GET /sessions` is paginated | the cap existed for the blob store |
| `MAX_SESSIONS_TOTAL = 30` | **no cap**; `pruneSessions` becomes *archive*, never delete | deleting history is the failure being fixed |
| `MEMORY_MAX_WORDS = 2000` | **unchanged** | it is a *prompt* budget, not a storage budget |
| `MEMORY_KEEP_TURNS = 40` | **unchanged** | same |
| `MEMORY_DIGEST_WORDS = 400` | **unchanged** | it is the summary contract (§4.2) |

> **⚠ `pruneSessions` must not delete.** It currently removes the oldest session
> once the cap is exceeded. After this change it may set `pinned = false` or drop
> the *cached messages* (L2 eviction), but it must never remove a
> `jarvis_session` row. The whole point of the exercise is that a conversation the
> wearer had is not destroyed by having a new one.

> **⚠ The `agents` SSE channel stays capped.** The broadcast `AgentsState.sessions`
> keeps a **client-side window** (the newest N for the agents the UI has open),
> because it rides a channel that every device receives. "No cap" means the
> *store* is uncapped and the *list endpoint* is paginated. An uncapped
> `AgentsState.sessions` on the broadcast path is a per-frame payload that grows
> forever — a real regression, not a feature.

## 4. Saving a session with a summary, in one call

### 4.1 `POST /sessions` and `sessions_save`

```jsonc
// sessions_save
{ "kind": "voice",
  "title": null,                       // server seeds from the first utterance
  "messages": [ { "role": "user", "text": "…", "at": 173… } ],
  "summary": null,                     // ← null means "write one for me"
  "summarise": "auto" }                // "auto" | "always" | "never"
→ { "ok": true, "sessionId": "…", "applied": true, "seq": 12,
    "summary": { "version": 1, "text": "…", "model": "…", "generatedAt": 173… },
    "summarised": true, "summariseSkipped": null }
```

**⚠ The summary is generated inside the same request. This is the entire point of
`sessions_save`.**

The reasoning is a failure mode, not an optimisation. If saving and summarising
are two tools, then:
- A client calls `sessions_save`, succeeds, and never calls `sessions_summarize`.
- Nothing errors. Nothing is missing. The corpus simply has sessions with no
  summaries — which makes `recall` fall back to titles, which makes it useless —
  and there is no signal anywhere that this happened.
- The bug is invisible until someone reads 200 transcripts and notices the summary
  column is empty.

Making it one call makes the good outcome the default and the bad outcome require
deliberate action (`summarise: "never"`).

### 4.2 The summary contract (unchanged from `memory.ts`)

The summary is produced by the existing compaction contract, reused verbatim:

| Rule | Value |
|---|---|
| Words | ≤ `MEMORY_DIGEST_WORDS = 400` |
| Person | third person ("the user") |
| Format | prose, **no markdown, no lists, no emoji** |
| Merge | fold into the previous summary rather than restart |
| Keep | names, dates, preferences, decisions, outstanding tasks |
| Drop | pleasantries, failed attempts, repeats |
| On failure | **non-destructive** — keep the old summary, report `summariseError` |

**Why no markdown and no lists:** the summary is injected into a prompt that is
also rendered, in part, on a 576×288 4-bit display with a firmware font. A
bulleted summary survives the prompt and breaks the display.

**Why "merge rather than restart":** a restart-summary loses anything mentioned
in an earlier turn and not repeated. Folding is the only way a preference stated
once survives.

### 4.3 ⚠ Failure must be non-destructive

`summarise()` has three outcomes, and **the difference between the second and
third is load-bearing**:

| Outcome | `summarised` | Side effect |
|---|---|---|
| generated | `true` | insert a new `session_summary` version |
| provider down / no key | `false` + `summariseSkipped: 'no provider'` | **write nothing**; session is saved |
| generated but unusable (too long, wrong shape) | `false` + `summariseSkipped: 'rejected: …'` | **write nothing**; the previous version stands |

**⚠ A failed summarise must never write an empty or partial summary, and must
never overwrite a previous version.** An empty summary is worse than no summary:
it makes `recall` return the session with nothing to match on and no way to tell
it apart from a genuinely empty one.

**⚠ Summarisation is never on the write's critical path to correctness.** The
session row and its messages are committed **before** the summary call. If the
summary call throws, the transaction that saved the session is already done. A
summariser failure must not lose the transcript.

### 4.4 ⚠ The summariser must be a tool-free LLM call

`defaultAsk` sends **no `tools`** on purpose. A summariser that can call tools can
decide to call `sessions_read` while summarising a session, and that recursion —
summarise → read → summarise — is unbounded and has no natural termination. The
summary call is a plain chat completion with a system prompt and no tool schema,
and there must be no code path that adds one.

### 4.5 Versioned, append-only summaries

```
session_summary
  id, session_id, version, text, model, prompt_words, summary_words,
  source_seq_from, source_seq_to, generated_at, superseded_at
```

- **Append-only.** A new summary is a new row. Never `UPDATE`.
- **`superseded_at`** marks an older version as no longer current, without
  deleting it.
- **Why:** the same reason the ledger is append-only, and it is a better reason
  here. A summary is machine-generated prose injected into future prompts. When a
  model behaves oddly and you need to know why, the question is *"what summary did
  it have at the time?"* — which an in-place `UPDATE` destroys. It also makes the
  summary a **derived** artefact that can be regenerated with a better prompt and
  compared, which is the only honest way to improve summarisation.
- **`source_seq_from`/`to`** record the message range the summary covers, so a
  "summarise only the new messages" pass is expressible and verifiable.

## 5. The MCP server

### 5.1 What exists and what is new

| | Today | Needed |
|---|---|---|
| `web/server/mcp-tools.mjs` | an MCP **client** — consumes a remote catalogue | reusable constants + `normalizeCatalogue` + `sanitizeInputSchema` + `diffParams`/`foldDrift` |
| **server** | **nothing** | `initialize`, `tools/list`, `tools/call` |

**This is the honest framing: being an MCP server is new code, not a rename of
the client.** The client's job is "ask a server what it can do, then call it".
The server's job is "describe what I can do in a JSON Schema, then dispatch a
call and return `content` blocks". Different halves of the protocol, sharing
constants.

### 5.2 Transport

`POST /mcp` — JSON-RPC 2.0 over HTTP, protocol version `2024-11-05`.
Stateless: no `Mcp-Session-Id`, no server-initiated messages. An `EventSource`-style
streaming transport is **not** provided, because every tool here is
request/response and a stream would add the browser socket-cap problem
(`04-web-integration.md` §4) to a machine client that does not need it.

### 5.3 The three methods

```jsonc
// initialize
→ { "jsonrpc":"2.0", "id":1, "result": {
      "protocolVersion": "2024-11-05",
      "capabilities": { "tools": { "listChanged": false } },
      "serverInfo": { "name": "g2-even-hub", "version": "1.0.0" } } }

// tools/list
→ { "result": { "tools": [ { "name": "sessions_save",
                             "description": "…",
                             "inputSchema": { "type":"object", "properties": { … },
                                              "required": [ … ],
                                              "additionalProperties": false } } ] } }

// tools/call
{ "name": "sessions_save", "arguments": { … } }
→ { "result": { "content": [ { "type": "text", "text": "Saved session … (summary v1, 118 words)" } ],
                "isError": false } }
```

**⚠ `listChanged: false` is a promise.** It says the tool list is stable for the
life of a connection. If a hub tool is added at runtime (a user-created `http`
tool), it must **not** appear in `tools/list` — otherwise a client that cached the
list and a client that did not would disagree about indices. User-created tools
are addressable by name only through `tools/call`, and are **not listed**. That
keeps `listChanged: false` true.

**⚠ Tool names must match `NAME_RE = /^[a-z][a-z0-9_]*$/`.** The model's typed
tool syntax (`tool-markup.ts`) and `normalizeToolId` both assume it. A name like
`sessions-save` would parse as a subtraction. `MAX_TOOL_NAME = 64` and
`MAX_TOOLS = 64` are already defined and apply here unchanged.

**⚠ An unknown tool is a JSON-RPC error, not an `isError` content block.**
`-32601 Method not found` for an unknown method; `-32602 Invalid params` for a
bad argument; `-32600 Invalid Request` for a malformed envelope. `isError: true`
is reserved for *the tool ran and the operation failed* — a provider being down,
a session that does not exist. Conflating them makes a client unable to tell a
protocol bug from a business failure.

### 5.4 The tool set

Twelve tools (`03-rest-api-spec.md` §8). The shapes:

| Tool | Args | Returns |
|---|---|---|
| `sessions_save` | `kind`, `title?`, `messages`, `summary?`, `summarise?` | `sessionId`, `applied`, `summary`, `summarised` |
| `sessions_list` | `kind?`, `agentId?`, `limit?`, `cursor?`, `pinned?` | one line per session: `id — title (n turns, summary v2)` |
| `sessions_read` | `sessionId`, `includeMessages?`, `summaryVersion?` | title, status, summary, and optionally the transcript |
| `sessions_search` | `q`, `entities?`, `concepts?`, `tasks?`, `from?`, `to?`, `limit?` | matching sessions with the matched summary excerpt |
| `sessions_summarize` | `sessionId`, `sinceSeq?` | the new version number and text |
| `sessions_clear` | `agentId?`, `sessionId?` | `removed: n` (via tombstone) |
| `sessions_stats` | — | counts, words, **summary coverage %** |
| `memory_read` | `turns?` | the digest + the newest turns |
| `memory_write` | `role`, `text`, `sessionId?` | `seq` |
| `recall` | `text`, `limit?`, `top?`, `minScore?` | the ranked sessions (§`07-jev-recall.md`) |
| `ledger_read` | `runId?`, `sinceSeq?`, `limit?` | entries |
| `settings_read` | — | non-secret config + provenance |

**Text-first content.** Every result is one `content` block of `type:'text'`
containing **short, emoji-free, ASCII** lines — the same discipline as
`CapabilityResult.summary`, and for the same reason: these results are read by a
model that may render them on the glasses. `sessions_read` with
`includeMessages` is the only tool that can return a large body, and it must
report `truncated: true` with a `cursor` rather than silently clipping.

**⚠ `sessions_stats` reporting summary coverage is not decoration.** It is the
observability for §4.1: if coverage drops, the save path is being called without
summarising, and that is the invisible failure mode this whole design exists to
prevent. It is also the first thing to check when `recall` degrades.

## 6. Referring back to a past session

This is what the user asked for and it has **three distinct mechanisms**, which
must not be conflated:

| Mechanism | Trigger | Latency | Used for |
|---|---|---|---|
| the injected digest | every prompt, unconditional | none | general continuity ("the user prefers X") |
| **recall** (JEV-ranked) | the STT text | one jev call | "what did I say about X" |
| `sessions_search` (FTS) | an explicit query | one DB query | tool-driven lookup, exact terms |

### 6.1 Why the digest stays unconditional

Cheap, always-relevant, and it costs one system block. `MEMORY_DIGEST_WORDS = 400`
is a prompt budget that is already paid for on every request today. Removing it in
favour of retrieval-only would make continuity *worse* for the common case where
the relevant fact is generic.

### 6.2 Why recall is a separate mechanism from search

- **Search is exact and literal.** It matches words. "What did I decide about the
  ferry booking" does not contain the words that will be in the summary
  ("booked the 08:40 sailing, paid the deposit").
- **Recall is semantic and forgiving.** It hands a set of candidate summaries to a
  decision model with the user's own words as the state, and asks which are
  relevant.
- Both are needed. Search is the fallback when the ranker fails open and the
  deterministic path when a tool wants a specific term.

### 6.3 The retrieval stage

Before ranking, candidates are gathered by, in order:

1. **Pinned sessions** — always candidates.
2. **FTS over `session_summary.text`** using the stored `tsvector` — the primary
   path, and the only one that knows nothing about embeddings.
3. **Array containment** on `entities`, `concepts`, `tasks` (GIN) — for a named
   entity a summary mentions but the query does not phrase.
4. **Recency** — the newest N as filler so a short candidate list can still be
   ranked.

Cap the union at `limit` (default 12), which is exactly `MAX_CRITERIA_COUNT`, so
the ranker is never asked for more than `12` candidates
(`07-jev-recall.md` §3).

> **⚠ No embeddings-only retrieval.** Stated in `08-roadmap-and-decisions.md` §4
> and implemented here: FTS + array containment is the primary path, and the
> optional pgvector block in `02-database-spec.md` §6 is a **ranking aid**, not
> the retrieval mechanism. A corpus that can only be found by an embedding model
> becomes unfindable the moment the model or the dimension changes, and the
> summary text is the durable artefact.

## 7. Lifecycle of one voice session, end to end

```
1. STT returns "remind me to check the ferry times, and note that I picked the 08:40"
2. converse.ts writes a memory_turn (role:'user')                 ← unchanged path
3. the intent resolves to a capability (todo.add ×2)              ← unchanged
4. the capability runs; a ledger entry is appended per effect      ← unchanged
5. converse.ts calls sessions_save { kind:'voice', messages:[…] }
                                                    ↓ server, one request
6.   INSERT jarvis_session                        (committed first)
7.   INSERT session_message ×n                    (committed)
8.   summarise() — tool-free llmChat, ≤400 words  (may fail: non-destructive)
9.   INSERT session_summary v1                    (append-only)
10.   trigger updates turn_count, word_count, summary_version
11.  session row is broadcast on the `agents` channel as a windowed projection
                                                    ↓ back on the glasses
12. the HUD shows one line: "Saved · 2 items added"
```

**Note what step 5 is not:** it is not a second network round trip the user waits
on. `sessions_save` is called with the response of the capability already
rendered. The summary arrives asynchronously in the identity of the request but
its absence is not a failure to the wearer — step 12 does not depend on step 8.

## 8. MCP authentication and blast radius

- One `mcp_token` per client (`02-database-spec.md` §3), with explicit `scopes`.
- **No MCP token can ever hold a scope that writes a secret or a device.** The
  vocabulary has no such word, which is the strong form of the guarantee.
- `sessions_clear` and `memory_write` require `sessions:write` / `memory:write`
  and are the only destructive tools; every one writes a **tombstone**, so a
  misbehaving MCP client can hide history but cannot destroy it. A restore is a
  `DELETE FROM jarvis_tombstone WHERE …` an owner can perform.
- Every MCP call that mutates appends a `ledger_entry` with `by: 'mcp:<tokenId>'`.
  An LLM with a token is then auditable exactly like an agent.
- Rate limits are per-token, not per-user (`03-rest-api-spec.md` §7), so a looping
  MCP client degrades only itself.

## 9. What "refer back" must never do

Collected, because these are the ways a session-memory feature goes wrong in
practice:

- **Never inject a whole transcript into a prompt.** A 200-turn session is tens of
  thousands of tokens. Recall injects the **summary** (≤400 words) plus, at most,
  a bounded number of matched message excerpts.
- **Never let a summary be the only copy of a decision.** The transcript is the
  evidence; the summary is derived (§3.3).
- **Never present a summary as authoritative.** `sessions_read` returns
  `generatedAt`, `model` and `version` alongside the text, so a caller can tell a
  two-month-old v1 from a fresh v3.
- **Never let summary generation block a save** (§4.3).
- **Never let a summariser call a tool** (§4.4).
- **Never delete a row to honour a clear** (§4.1's tombstone rule).
- **Never re-summarise in place** (§4.5).
