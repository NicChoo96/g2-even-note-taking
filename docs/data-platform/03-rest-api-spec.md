# 03 — REST API specification (v1)

Base: `https://g2-even-note-taking-production.up.railway.app/api/v1`
(same origin as the SPA — no CORS for the app itself).

## 1. Why `/api/v1` and not the existing paths

The existing routes (`/api/stream`, `/api/agent/*`, `/api/files/*`) are
**additive and stay**. `/api/v1` is a new, complete, versioned surface for the
persistent domain. Two reasons for a new namespace rather than editing in place:

1. **The bundle and the relay deploy independently.** The Even App caches the
   bundle and `/app.json` and the SPA can be at different versions during a
   rollout. A frozen `v1` prefix means an old bundle is never sent a payload it
   cannot parse, and a new bundle can probe for `v1` and fall back.
2. **The old routes carry a legacy contract that must not be broken.**
   `POST /api/stream` accepting a whole `HubState` blob with the `stale:true`
   reply is what every deployed client speaks today. Rewriting that route in
   place turns every in-field client into a beta test.

**Compatibility rule:** anything the old routes do that a client depends on must
have an exact `v1` equivalent before the old route is deprecated. The old routes
then keep working, unmodified, through Phase C. Removal is a separate, later
decision with a sunset header.

## 2. Envelope

Success:

```jsonc
{ "ok": true, /* payload */ }
```

Failure:

```jsonc
{ "ok": false, "error": "human sentence", "code": "MACHINE_CODE", "details": { } }
```

**⚠ This is not a stylistic choice.** Every existing client does
`const r = await res.json(); if (!r.ok) …` and reads `.error` for the sentence it
renders on the glasses. A bare HTTP-status-driven contract would break every
shipped bundle. `code` is new and additive — old clients ignore it.

### Status codes

| Code | When | Client must |
|---|---|---|
| `200` | done | — |
| `201` | created (also sets `Location`) | — |
| `204` | deleted, no body | — |
| `400` | malformed body / bad enum | fix and retry |
| `401` | credential **absent or invalid** | sign in / re-pair |
| `403` | valid credential, insufficient scope | re-consent |
| `404` | no such row, or a row not owned by the caller | treat as gone |
| `409` | `baseRev` mismatch, or a unique collision | **converge, then retry** (§6) |
| `412` | `If-Match` failed on a document write | reload the doc |
| `413` | body over the cap | shrink |
| `422` | semantically valid JSON, invalid domain value | fix |
| `429` | rate limited | back off per `Retry-After` |
| `5xx` | our fault | outbox retries |

> **⚠ 401 vs 403, and the `notifyIfCredentialWasSent` rule.** A `401` may only be
> interpreted as "your credential is bad" if a credential was **actually sent**.
> An anonymous probe legitimately gets a 401 and must not wipe the user's stored
> session. The relay already enforces this; the `v1` layer must keep it, because
> it is the difference between "signed out" and "the network dropped the header".

> **404 rather than 403 for a row you do not own.** Returning 403 for
> `GET /docs/:id` where `:id` belongs to someone else confirms the id exists.

### Machine codes (the set that matters to a client)

`NO_CREDENTIAL`, `BAD_CREDENTIAL`, `SCOPE_DENIED`, `NOT_FOUND`, `STALE_REV`,
`REV_REQUIRED`, `IF_MATCH_REQUIRED`, `IF_MATCH_FAILED`, `DUPLICATE_OP`,
`INVALID_ENUM`, `TOO_LARGE`, `RATE_LIMITED`, `PROVIDER_DOWN`,
`GATEWAY_DOWN`, `NOT_CONFIGURED`, `INTERNAL`.

`NOT_CONFIGURED` is a first-class code because a large share of runtime failures
in this app are "no API key yet", and it must be distinguishable from a provider
outage — the UI says different things for each.

## 3. Authentication

Three credentials, all read by the same `readToken(req, url)` order —
`?token=` first, then `Authorization: Bearer`:

| Kind | Shape | Reaches |
|---|---|---|
| owner | 48 hex chars | everything |
| device | 36-char UUID | everything except secret writes and device revocation |
| mcp | `mcp_<32 hex>` | only the scopes granted to the token |

> **Why `?token=` survives.** An `EventSource` cannot set headers. The SSE read
> path is the only place this matters, the token is short-lived, and inventing a
> cookie-based scheme for it drags CSRF into a zero-dependency server. The rule
> that keeps it safe: **a query token is only ever accepted on `GET`**. A state
> change must carry a header, so a URL never appears in a log next to a mutation.

### Scope vocabulary (`mcp_token.scopes`)

`sessions:read`, `sessions:write`, `memory:read`, `memory:write`, `recall`,
`ledger:read`, `settings:read`.

**An MCP token can never hold a scope that writes a secret or a device.** That
is not expressible in the vocabulary — a missing word is a better guarantee than
a check.

### CORS

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, If-Match, Idempotency-Key
Access-Control-Max-Age: 600
```

> **⚠ `Authorization` and `Idempotency-Key` MUST be listed.** Missing
> `Authorization` breaks every cross-origin Bearer call in the preflight, before
> the request is ever sent, with a client-side error that looks like a network
> failure. `Max-Age: 600` is not an optimisation — a preflight per mutation
> doubles the request count on a device that batches writes.

`OPTIONS` **must** be handled for every path, including unknown ones (return
`204`), or a typo in a path surfaces as a CORS error instead of a 404.

## 4. Concurrency: `rev`, `If-Match`, `Idempotency-Key`

Three headers, three distinct jobs. Conflating them is the classic way to get a
sync bug.

| Header | Direction | Guards against |
|---|---|---|
| `Idempotency-Key` | **request** | a retried write double-applying |
| `rev` (in body) | both | writing onto a collection someone else changed |
| `If-Match` / `ETag` | both | writing onto **one document** someone else changed |

### 4.1 `Idempotency-Key`

Every mutating request may carry `Idempotency-Key: <uuid v4>`. Semantics:

- First sighting → apply, store `applied_op(user_id, op_id, result)`.
- Subsequent sighting within 7 days → **return the stored `result` verbatim**,
  with `200` (not `201`), and `Duplicate: true`.
- An op id reused with a *different* body → `409 DUPLICATE_OP`. This is not
  paranoia: it catches a client that generated one id for a batch, and silently
  applying the wrong body would be much worse than a loud failure.
- A missing key on a `POST` is allowed but logged; the endpoint is then only
  idempotent by luck. `PUT` and `PATCH` should use `If-Match` anyway.

**Why this is new and non-optional:** whole-state `POST /api/stream` is naturally
idempotent (the same blob twice is the same state). Row-level creates are not.
Every offline queue (`05-offline-cache-sync.md`) replaying into a flaky network
produces duplicates without this.

### 4.2 `rev` — the collection guard

Every collection read returns `rev` and `updatedAt`:

```jsonc
{ "ok": true, "rev": 418, "updatedAt": 1730000000000, "items": [ /* … */ ] }
```

Every mutating request **may** carry `rev` (the value it believed). On mismatch:
`409 STALE_REV` **together with** the current server value in `details`. The
client then converges (§6). Omitting `rev` is an unconditional write — allowed
only for a `device` principal and only when the caller is the sole writer
by design (`PUT /memory`, `POST /ledger`).

> **⚠ Do NOT weaken this to a `!==` check with no payload.** The current relay
> replies `{ ok: true, stale: true }` and **re-broadcasts `channel.lastState`** so
> the refusing client immediately learns the winner. A bare rejection with no
> server state deadlocks two devices that both think they are right. The 409 body
> **must** carry the server value.

### 4.3 `If-Match` / `ETag` — the per-document guard

For `document`, `agent` and `session` rows:

- `GET /docs/:id` → `ETag: "<updated_at ms>"` (or a content hash for `content`).
- `PUT /docs/:id` requires `If-Match: <etag>` → `412 IF_MATCH_FAILED` with the
  current document in `details`.

**Why a doc needs a stricter guard than the collection:** `docs.set_content` is
**irreversible and confirm-gated** on the glasses. An overwrite of a document the
wearer just edited on the other surface is exactly the failure a tap-to-confirm
was supposed to prevent. The collection `rev` is too coarse — a todo added on the
phone must not invalidate an edit in flight on the browser.

**Why the doc `ETag` is content-derived, not just `updated_at`:** `updated_at` has
millisecond resolution and two writes inside the same millisecond are possible
when a run publishes and the user saves simultaneously. A hash makes the two
distinguishable.

## 5. Endpoints

Grouped by aggregate. `A` = required auth kind (`O` owner, `D` device, `M` mcp);
`Idem` = accepts `Idempotency-Key`; `Guard` = `rev` / `If-Match`.

### 5.1 Hub

| Method | Path | A | Idem | Guard | Notes |
|---|---|---|---|---|---|
| `GET` | `/hub` | O D | — | — | The whole `HubState` + `rev`. **The one call a cold boot needs.** |
| `PUT` | `/hub` | O D | ✔ | `rev` | Whole-state replace. The `v1` equivalent of `POST /api/stream`. Returns the accepted `rev`. |
| `PATCH` | `/hub` | O D | ✔ | `rev` | `{ activeSection?, activeDocId? }` only — the cheap focus writes |

`GET /hub` returns exactly the `HubState` shape from `01-inventory.md` §2, so the
glasses renderer needs no change:

```jsonc
{
  "ok": true, "rev": 418, "updatedAt": 1730000000000,
  "hub": {
    "activeSection": "todo",
    "sections": {
      "todo":  [ { "id": "…", "text": "…", "done": false } ],
      "docs":  [ { "id": "…", "title": "…", "content": "…", "updatedAt": 173… } ],
      "files": [ { "id": "f5ec…", "title": "…", "agent": "…", "url": "…", "size": 17912, "updatedAt": 173… } ],
      "notes": ""
    },
    "activeDocId": null,
    "updatedAt": 1730000000000
  }
}
```

**`GET /hub` is a projection, not a table.** It is assembled from `hub_state` +
`todo_item` + `document` + `note` + `file_ref` in one query (a `json_build_object`
with lateral aggregates). It exists so the render contract does not change.

> **⚠ `sections.files` is truncated in this response.** The projection returns at
> most 50 `file_ref` rows and sets `truncated: true`, because `HubState` is
> broadcast on every change. The full list lives at `GET /files`.

### 5.2 Todo

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/todos` | O D | — | — | → `{ ok, rev, updatedAt, items: TodoItem[] }` |
| `POST` | `/todos` | O D | ✔ | `rev` | `{ text, done? }` → `201`, `Location` |
| `PUT` | `/todos` | O D | ✔ | `rev` | `{ items: TodoItem[] }` — **whole-collection replace** |
| `PATCH` | `/todos/:id` | O D | ✔ | `rev` | `{ text?, done?, ordinal? }` |
| `DELETE` | `/todos/:id` | O D | ✔ | `rev` | → `204` |
| `POST` | `/todos/reorder` | O D | ✔ | `rev` | `{ ids: string[] }` — the full new order |
| `POST` | `/todos/clear-done` | O D | ✔ | `rev` | → `{ ok, removed: n }` |

**⚠ `PUT /todos` is a full replace and MUST NOT be implemented as a union.**
Union-merge of `todo` resurrects every deleted item the moment a device with an
older copy reconnects, and it is the single most likely mistake in this whole
document — because a union feels like the "safe, merge-friendly" choice.

`POST /todos/reorder` exists because array position is data and a reorder
expressed as N `PATCH`es is neither atomic nor orderable.

### 5.3 Docs

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/docs` | O D | — | — | `?include=content` — **omitted by default** |
| `POST` | `/docs` | O D | ✔ | `rev` | `{ title?, content? }` |
| `GET` | `/docs/:id` | O D | — | — | → `ETag` |
| `PUT` | `/docs/:id` | O D | ✔ | **`If-Match`** | `{ title?, content }` → the irreversible path |
| `PATCH` | `/docs/:id` | O D | ✔ | `rev` | `{ title?, ordinal? }` — **metadata only** |
| `DELETE` | `/docs/:id` | O D | ✔ | `rev` | soft delete → `204` |
| `GET` | `/docs/:id/revisions` | O D | — | — | *see below* |

**⚠ `GET /docs` omits `content` by default.** A library of 200 documents each
holding 18 KB is 3.6 MB per call, on a phone, to paint a list of titles. The
`include=content` escape hatch exists for the offline prime
(`05-offline-cache-sync.md` §5) and nothing else.

**⚠ `PUT /docs/:id` is the only write to `content`, and it requires `If-Match`.**
`PATCH` deliberately cannot touch `content` — that is how "rename" and "overwrite
the whole body" stay distinguishable in an audit, and it is what lets
`docs.rename` (a `write`) and `docs.set_content` (an `irreversible`, gated
action) remain different effects at the API layer, matching the capability
catalog exactly.

**Doc revisions are NOT in scope for v1.** The wearer's own docs get a soft
delete and an `updated_at`; versioning them duplicates what the Content Gateway
already does properly for published documents (`list_revisions` / `read_revision`
/ `restore_revision`). `GET /docs/:id/revisions` is reserved and returns
`{ ok: false, code: 'NOT_IMPLEMENTED' }` so the path is not accidentally taken
later by something incompatible.

### 5.4 Notes

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/notes` | O D | — | — | → `{ ok, rev, content, updatedAt }` |
| `PUT` | `/notes` | O D | ✔ | `rev` | `{ content }` — **whole-blob replace** |
| `POST` | `/notes/append` | O D | ✔ | `rev` | `{ text }` |

`PUT /notes` replaces, `POST /notes/append` appends. Both exist because the
capability catalog has both (`notes.set` is irreversible and gated;
`notes.append` is a plain write) and collapsing them would make an irreversible
action reachable through a non-gated route.

`POST /notes/append` is idempotent by `Idempotency-Key` only — appending is
inherently non-idempotent, which is exactly the case `applied_op.result` exists
for.

### 5.5 Files (gateway-backed)

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/files` | O D | — | — | `?limit&cursor&q&agent&tag&includeDeleted` → refs only |
| `POST` | `/files` | O D | ✔ | `rev` | `{ html, title?, agent?, tags?, id?, slug?, overwrite? }` → publish to gateway, then insert the ref |
| `GET` | `/files/:id` | O D | — | — | metadata only — **never the body** |
| `GET` | `/files/:id/text` | O D | — | — | the WHOLE body (`01-inventory.md`: no default window) |
| `GET` | `/files/:id/media` | O D | — | — | extracted media refs |
| `GET` | `/files/:id/revisions` | O D | — | — | |
| `POST` | `/files/:id/restore` | O D | ✔ | — | |
| `DELETE` | `/files/:id` | O D | ✔ | — | `?hard=true` for a real delete |
| `GET` | `/files/stats` | O D | — | — | |

**⚠ `POST /files` is idempotent in TWO layers, and both are required.** The
client-supplied 32-hex `id` makes the *gateway* publish idempotent
(`01-inventory.md` §6.3), and `Idempotency-Key` makes the *row insert*
idempotent. Relying on only one means a retry can either double a document on the
gateway or double a row locally.

**⚠ `GET /files/:id/text` returns the whole body, with no default window.** This
is a settled contract: the model needs the full text to modify the file. The
response carries `offset`, `limit`, `total`, `next`, `more` for a client that
wants to paginate anyway, but `next: null, more: false` on a normal read.
`BODY_MAX_CHARS = 60_000` is a **measured ceiling** (80 000 clips against the
120 000-char model budget), not a window — **do not reintroduce a default
window**.

### 5.6 Agents, tools, settings

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/agents` | O D | — | — | → `{ ok, rev, updatedAt, agents, tools, llm }` (no sessions) |
| `POST` | `/agents` | O D | ✔ | `rev` | `{ name, systemPrompt?, prompt?, toolIds?, model? }` |
| `GET` | `/agents/:id` | O D | — | — | |
| `PUT` | `/agents/:id` | O D | ✔ | **`If-Match`** | last-write-wins on the whole agent |
| `DELETE` | `/agents/:id` | O D | ✔ | `rev` | soft delete; **irreversible** |
| `POST` | `/agents/:id/clone` | O D | ✔ | `rev` | |
| `GET` | `/tools` | O D | — | — | |
| `POST` | `/tools` | O D | ✔ | `rev` | |
| `PUT` | `/tools/:id` | O D | ✔ | `rev` | |
| `DELETE` | `/tools/:id` | O D | ✔ | `rev` | |
| `PUT` | `/tools/:id/token` | **O** | ✔ | — | write-only; `DELETE` to remove |
| `GET` | `/settings` | O D | — | — | **non-secret** fields + provenance |
| `PUT` | `/settings` | **O** | ✔ | — | `{ searchProvider?, depth?, model?, referer?, title?, clear?: string[] }` |
| `PUT` | `/settings/secrets` | **O** | ✔ | — | write-only; never echoed |
| `DELETE` | `/settings/secrets/:key` | **O** | ✔ | — | |

> **⚠ `GET /agents` must apply `ensureWebTool()`.** If no `kind:'web'` tool exists
> it is injected. An install that carried only a legacy `tavily` tool would
> otherwise lose web search entirely — the client does this today and the
> server-side projection has to match, or a fresh bundle against a clean database
> silently has no search.
>
> **⚠ `GET /settings` never returns a secret, not even masked.** It returns
> `{ openrouter: true, tavily: true, brave: false, jev: true, files: { configured: true, mode: 'api_key' } }`
> plus `hint` (last 4 chars) and `source` per field
> (`'env' | 'settings' | 'default' | 'none'`), matching the existing
> `AgentStatus.source` map. A masked key is still a key-shaped secret in a
> response body that gets logged.

### 5.7 Sessions

Full design in `06-jarvis-sessions.md`. The surface:

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/sessions` | O D M(`sessions:read`) | — | — | `?kind&agentId&limit&cursor&includeDeleted&pinned` |
| `POST` | `/sessions` | O D M(`sessions:write`) | ✔ | — | `{ kind, agentId?, runId?, title?, status?, messages? }` |
| `GET` | `/sessions/:id` | O D M(`sessions:read`) | — | — | metadata + `summaryVersion`, **no messages** |
| `PATCH` | `/sessions/:id` | O D M(`sessions:write`) | ✔ | `If-Match` | `{ title?, status?, pinned? }` |
| `DELETE` | `/sessions/:id` | O D M(`sessions:write`) | ✔ | — | soft delete |
| `GET` | `/sessions/:id/messages` | O D M(`sessions:read`) | — | — | `?afterSeq&limit` → cursor |
| `POST` | `/sessions/:id/messages` | O D M(`sessions:write`) | ✔ | — | `{ seq?, messages: AgentMessage[] }` — **append-only** |
| `POST` | `/sessions/:id/summarize` | O D M(`sessions:write`) | ✔ | — | generate a NEW summary version |
| `GET` | `/sessions/:id/summaries` | O D M(`sessions:read`) | — | — | all versions, newest first |
| `GET` | `/sessions/search` | O D M(`sessions:read`) | — | — | `?q&entities&concepts&tasks&from&to&limit` — **over summaries** |
| `POST` | `/sessions/clear` | O D | ✔ | — | `{ agentId? }` → writes a tombstone |
| `GET` | `/sessions/stats` | O D M(`sessions:read`) | — | — | counts, words, summary coverage |

> **⚠ `POST /sessions/:id/messages` is append-only and MUST return `applied`.**
> A replay collides on `UNIQUE (session_id, seq)`; the response is
> `{ ok: true, applied: false, seq }` rather than an error, because the client's
> outbox is doing the right thing and must not be told it failed.
>
> **⚠ `GET /sessions/:id` does NOT return messages.** A transcript is the largest
> thing in this system; a list view that eagerly fetched 30 transcripts is the
> reason the old design capped sessions at 5.
>
> **⚠ `POST /sessions/clear` writes a tombstone and MUST NOT delete rows.** The
> tombstone is the only reason an explicit clear survives a union merge
> (`01-inventory.md` §3). Deleting the rows makes the clear indistinguishable
> from "this device never saw them", which is what resurrected history.

### 5.8 Memory

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/memory` | O D | — | — | → `JarvisMemory` projection (`versions, digest, digestAt, folded, turns, words, capWords`) |
| `PUT` | `/memory` | O D | ✔ | — | whole-state replace (legacy clients) |
| `POST` | `/memory/turns` | O D | ✔ | — | `{ role, text, at?, sessionId? }` — append |
| `POST` | `/memory/compact` | O D | ✔ | — | fold older turns into a NEW digest version |
| `DELETE` | `/memory` | O D | ✔ | — | clears turns **and** digests, writes a tombstone |

`POST /memory/compact` accepts an optional injected summariser for tests
(`{ respond?: string }`) — the same injection pattern `routeTools` uses, so the
whole compaction path is testable with no network.

### 5.9 Ledger

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/ledger` | O D M(`ledger:read`) | — | — | `?runId&sinceSeq&limit&kind&effect` |
| `POST` | `/ledger` | O D | ✔ | — | `{ entries: EntryInput[] }` — **bulk append** |

**⚠ There is no `PUT` and no `DELETE`, ever.** The append-only rule is enforced in
the database (`02-database-spec.md` §8); the absence of the route is the API-level
expression of the same fact.

Bulk append exists because a run produces ~20 entries in a burst and one request
per entry on a phone radio is the difference between a run that logs and one that
does not.

### 5.10 Sync

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/sync/pull` | O D | — | — | `?since=<rev>&collections=&sinceSeq=` |
| `POST` | `/sync/push` | O D | ✔ | — | `{ ops: Op[] }` |
| `POST` | `/sync/prime` | O D | — | — | the offline prime (§5.3 + `05-offline-cache-sync.md` §5) |

Full protocol in `05-offline-cache-sync.md`. The two shapes:

```ts
// GET /sync/pull?since=418&collections=todo,docs,notes
{ ok: true, rev: 431, collections: {
    todo:  { rev: 429, updatedAt: 173…, replace: [ /* full TodoItem[] */ ] },
    docs:  { rev: 431, updatedAt: 173…, replace: [ /* DocEntry[] WITHOUT content */ ] },
    notes: { rev: 425, updatedAt: 173…, replace: '' }
  },
  deleted: { docs: ['…'], files: ['…'] },
  truncated: { docs: false },
  serverTime: 173… }
```

```ts
// POST /sync/push
{ ops: [ /* see 05-offline-cache-sync.md §3 */ ] }
→ { ok: true, rev: 435,
    applied:  ['op-uuid-1', 'op-uuid-2'],
    duplicate:['op-uuid-3'],
    rejected: [ { opId:'op-uuid-4', code:'STALE_REV',
                  details:{ rev: 433, current: { /* the winning value */ } } } ],
    serverTime: 173… }
```

> **⚠ `replace` means replace.** The pull response honours each collection's
> merge policy: `todo`/`docs`/`notes` come back as complete arrays to be
> **substituted** (per §5.2's anti-union rule), while `sessions` comes back as a
> delta to be **unioned**
> (`01-inventory.md` §3). The response says which by its shape — `replace` for the
> former, `items`/`tombstones` for the latter — so a client cannot apply the wrong
> policy by accident.

### 5.11 Recall — the JEV entry point

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `POST` | `/recall` | O D M(`recall`) | ✔ | — | `{ text, limit?, top?, minScore?, includeMessages? }` |

```jsonc
// request
{ "text": "what did I decide about the ferry booking", "limit": 12, "top": 3 }

// response
{ "ok": true,
  "selected": [
    { "sessionId": "…", "title": "…", "at": 173…, "kind": "voice",
      "summaryVersion": 2, "summary": "…", "score": 0.91 }
  ],
  "candidates": 7,          // how many were retrieved before ranking
  "ranked": true,           // false → the ranker failed and recency was used
  "reason": "ranked 7 candidates",  // the SAME string vocabulary as routeTools
  "serverTime": 173… }
```

Full design and the fail-open rules in `07-jev-recall.md`.

### 5.12 Diagnostics

| Method | Path | A | Body |
|---|---|---|---|
| `GET` | `/health` | public | `{ ok, version, db: 'up'\|'down', migrations: n, time }` |
| `GET` | `/diag/invariants` | **O** | runs every check in `02-database-spec.md` §13 |
| `GET` | `/diag/schema` | **O** | the tool schemas the relay will send, post-`foldDrift` |

`GET /diag/schema` exists because a silent schema drift between the capability
layer and the relay's `toolSchema` is a class of bug that otherwise only shows up
as a model that stops calling a tool.

## 6. The converge-forward contract

On `409 STALE_REV` / `412 IF_MATCH_FAILED` the client **MUST**, in this order:

1. Adopt the server value from `details.current`.
2. Re-apply its own pending outbox ops for that collection **on top of** it —
   local intent wins over remote for the fields the user actually changed.
3. Resubmit with the fresh `rev` / `If-Match`.
4. If step 3 fails again, drop the local op, surface a non-blocking notice, and
   leave the server value in place.

**Why step 4 exists:** an unbounded retry loop against a device that is actively
writing is how a sync engine spins at 100% CPU on a phone. Two attempts, then
concede.

This is the generalised form of what `store.ts`'s `applyRemote` already does:
> `stamp < state.updatedAt` → **converge forward**: take the newer stamp and the
> *local* sections, i.e. keep what the user is looking at, but move the clock up
> so the next publish is not refused again.

The `rev` version makes the same manoeuvre explicit instead of inferring it from
a timestamp comparison, which is what makes it testable.

## 7. Rate limits

| Scope | Limit | Why |
|---|---|---|
| `POST /sessions/:id/summarize` | 10/min/user | Each one is a paid LLM call |
| `POST /recall` | 30/min/user | One per utterance; a runaway loop is possible |
| `POST /ledger` | 120/min/user | Bulk, so the count is low by design |
| `POST /files` | 20/min/user | Each one publishes to an external service |
| `POST /sync/push` | 60/min/user | A retrying client |
| everything else | 600/min/user | Generous; this is a personal app |

`429` carries `Retry-After`. **The outbox honours it** — a rate-limited op is
rescheduled, never dropped (`05-offline-cache-sync.md` §4).

## 8. The MCP surface

`POST /mcp` — JSON-RPC 2.0, protocol version `2024-11-05`, auth via an
`mcp_token`.

Methods: `initialize`, `tools/list`, `tools/call` (and `notifications/initialized`,
answered with `204`).

The tool set, with the scopes each requires:

| Tool | Scope | Purpose |
|---|---|---|
| `sessions_save` | `sessions:write` | Save a session **with its summary in one call** |
| `sessions_list` | `sessions:read` | `{ kind?, agentId?, limit?, cursor? }` |
| `sessions_read` | `sessions:read` | Metadata + summary (+ optional messages) |
| `sessions_search` | `sessions:read` | Over summaries, with `entities`/`concepts` filters |
| `sessions_summarize` | `sessions:write` | Produce a NEW summary version |
| `sessions_clear` | `sessions:write` | Tombstone |
| `sessions_stats` | `sessions:read` | Coverage, counts |
| `memory_read` | `memory:read` | The global digest + recent turns |
| `memory_write` | `memory:write` | Append a turn |
| `recall` | `recall` | STT text → ranked sessions (**the JEV selector**) |
| `ledger_read` | `ledger:read` | Entries for a run |
| `settings_read` | `settings:read` | Non-secret config |

> **⚠ `sessions_save` is ONE tool on purpose.** "Store this session with a
> summary" is the single operation an LLM should be able to perform, and making
> it two calls (save, then summarise) guarantees a client that does the first and
> forgets the second — producing a corpus with no summaries, which is exactly the
> state that makes recall useless. The summary is generated server-side inside
> the same request if the caller does not supply one. Full design in
> `06-jarvis-sessions.md` §4.

**Why a server-side MCP surface is real work, not a rename:** `mcp-tools.mjs` is
an MCP **client** (`createMcpTools` consumes a remote catalogue). Being an MCP
server means implementing the other half — `initialize` with capabilities, a
stable `tools/list` with JSON Schemas, `tools/call` with `content` blocks and
`isError`, and protocol-level error codes. `mcp-tools.mjs`'s constants and
`normalizeCatalogue` / `sanitizeInputSchema` are reusable; the dispatcher is new
(`06-jarvis-sessions.md` §5).

## 9. Deprecation of the old routes

| Old | New | Removal |
|---|---|---|
| `POST /api/stream` (write) | `PUT /hub`, `PATCH /hub`, `/todos`, `/docs`, `/notes` | Phase C + one release, with `Deprecation: true` and a `Sunset` header |
| `GET /api/stream` (read) | **stays** (`04-web-integration.md` §4) | not planned |
| `/api/agent/*` | `/sessions*`, `/agents*` | Phase C |
| `/api/settings` | `/settings`, `/settings/secrets` | Phase C |
| `/api/files/*` | `/files/*` | Phase C — thin re-export until then |
| `/api/tool`, `/api/decisions`, `/api/llm` | unchanged | not planned — they are stateless proxies, not storage |
| `/api/auth/*`, `/api/pair/*`, `/api/devices` | unchanged (repository swap only) | not planned |

**Rule:** no route is removed until its `v1` equivalent has shipped and the
deployed `/app.json` version at that time is at least one release newer than the
version that first shipped `v1`. A cached bundle in the Even App is the failure
mode this ordering exists to prevent.
