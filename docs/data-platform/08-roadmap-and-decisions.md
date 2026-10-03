# 08 — Roadmap, risks, and what I would refuse to build

## 1. Phasing

Three phases, matching `02-database-spec.md` §12. **The exit criterion of each
phase is a working app, not a merged PR.** Every phase is independently
deployable and independently revertible.

### Phase A — the database exists, nothing depends on it yet

| Work | Deliverable |
|---|---|
| Postgres + the migration runner (forward-only, advisory lock) | `repository/` is the only SQL importer |
| All DDL from `02-database-spec.md` §3–§10 | an empty schema with every invariant check passing |
| The three-file import: `.g2-hub-state.json`, `.g2-hub-auth.json`, `.g2-hub-secrets.json` | a populated database, verified by `GET /diag/invariants` |
| `repository/` over the new tables | reads return the same shapes the relay returns today |
| `/api/v1` read-only: `GET /hub`, `/todos`, `/docs`, `/notes`, `/agents`, `/tools`, `/settings`, `/sessions`, `/memory`, `/ledger` | byte-compatible payloads |
| `POST /api/stream` **still writes to the JSON files** (dual-write) under `DATA_BACKEND='stream'` | no client changes at all |

**Exit criteria**
- `GET /diag/invariants` returns all 9 checks passing against imported data.
- Every `GET /api/v1/*` payload matches the corresponding old payload for the same
  account, field for field, modulo the added `rev`/`updatedAt`.
- The relay serves the existing bundle with **zero behaviour change**.
- **Rollback:** stop the v1 routes. Nothing else ever depended on them.

> **The dual-write in Phase A is the whole safety net.** The JSON files remain
> authoritative until the import is proven correct, so reverting is "unset an
> env var", not "restore a backup".

### Phase B — the client writes ops, the server still accepts both

| Work | Deliverable |
|---|---|
| `glasses/src/data/` — `api`, `cache`, `outbox`, `sync`, `policy` | the seam |
| `policy.ts` extracted from `agents-store.ts` / `types.ts`, plus `policy-sim.mjs` | the three merge rules pinned, one implementation |
| L1 `rev`/`cacheAt` + the content-stripping migration + tolerant reader | boot path unchanged for a `stream` client |
| L2 IndexedDB, the versioned `cacheSchema`, eviction | bulk moves out of `localStorage` |
| `mutate()` as the single write path, both backends behind it | `DATA_BACKEND` flag |
| `POST /sync/push` + `GET /sync/pull` + `POST /sync/prime` | server side live |
| The 15-row test matrix from `05-offline-cache-sync.md` §9 | every row harnessed |

**Exit criteria**
- With `VITE_DATA_BACKEND=v1` the app is fully functional: create/edit/delete todo,
  docs, notes, agents, sessions; restart with the network off and everything
  survives; reconnect and exactly-once delivery holds (matrix rows 1–3).
- With `VITE_DATA_BACKEND=stream` (still the default) behaviour is byte-identical
  to today.
- **Rollback:** flip the env var back. The outbox flushes on the next boot
  (`04-web-integration.md` §7) so no op is stranded.

### Phase C — v1 becomes the default, the blob path is deprecated

| Work | Deliverable |
|---|---|
| `VITE_DATA_BACKEND` default flips to `v1` | the new path is the only path |
| `POST /api/stream` gains `Deprecation: true` + a `Sunset` header | one release of notice |
| `/sessions*`, `/recall`, `/mcp` ship | the Jarvis requirement lands |
| `pruneSessions` stops deleting | history stops being destroyed |
| The `agents` broadcast channel keeps its window | no payload growth |
| Old routes deleted | **one release after the version that first shipped v1** |

**Exit criteria**
- `GET /diag/invariants` passing in production.
- The old JSON files are stale by more than one release and nothing reads them.
- Matrix rows 4–15 green.
- `sessions_stats.summaryCoverage` at or near 100% after a week.
- **Rollback:** the old routes are still present for one release, so a bundle
  rollback works without a server rollback. After deletion, rollback is
  forward-only — hence the one-release gap.

## 2. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | A union-merge is introduced for `todo`/`docs`/`notes` "to be safe" | **high** | data resurrection, silent | it is stated as a MUST NOT in three documents; matrix row 5/6; a DB-level test that a delete survives a stale `PUT` |
| 2 | L1 (`localStorage`) blows its quota once doc content stops being stripped | medium | **boot failure** | content never persisted in L1; the `quotaExceededError` handler; a test asserting no `content` in `hub:docs` |
| 3 | The two jev traps are re-implemented in `recall` | medium | wrong-but-plausible recall | `rankItems` is the only implementation; tests 2/3/4 |
| 4 | `TRANSIENT_CHANNELS` guard lost in the channel refactor | medium | the 0.3.24 "Jarvis killed itself" bug returns | matrix row 12; three call sites documented in `04-web-integration.md` §4 |
| 5 | A summariser is wired with `tools` attached | low | unbounded recursion, cost | §`06` 4.4; a test that the summary call sends no `tools` |
| 6 | Summary generation blocks the save transaction | medium | lost transcripts on a provider outage | save commits first; §`06` 4.3; a test with a throwing summariser |
| 7 | The `agents` channel carries uncapped sessions | medium | per-frame payload grows forever | the window is kept; `01-inventory.md` §3; a test on the broadcast projection |
| 8 | A device is left half-migrated (flag flips mid-session) | low | stranded outbox | the flag is read once at boot; the flip rule in §`04` 7 |
| 9 | MCP token over-scoped | medium | an LLM can clear history | the scope vocabulary cannot express a secret/device write; tombstones make clears recoverable |
| 10 | `Idempotency-Key` table grows unbounded | high | slow writes | 7-day TTL + a nightly prune (`02-database-spec.md` §10) |
| 11 | The relay is edited but not restarted, and "nothing works" | **high** | hours lost | `server/*.mjs` edits require a relay restart; `glasses-dist` does not |
| 12 | Embeddings are added as the only retrieval path | medium | recall breaks on any model change | FTS is primary; pgvector is commented out and is a ranker, never the retriever |
| 13 | A secret is exposed through `GET /settings` | low | credential leak | non-secret projection only; hint is 4 chars; a test asserting no key material in the response |
| 14 | The ledger is made mutable for "corrections" | low | the audit trail stops being one | `CREATE RULE … DO INSTEAD NOTHING`; no PUT/DELETE route exists |

**The two highest-likelihood rows (1 and 11) are both cases where the code does
exactly what it looks like it does and the cost is paid later.**

## 3. Acceptance criteria

The whole engagement is done when all of these are true:

**Data**
1. Every entity in `01-inventory.md` §9 has a row in Postgres.
2. `GET /diag/invariants` passes all 9 checks.
3. The three legacy JSON files are imported with zero loss, verified by
   count-and-hash per collection.
4. No `file` body is stored in the database (`filesNoBody`).
5. No `ledger_entry` has ever been updated or deleted (`ledgerNoUpdate`).

**API**
6. Every endpoint in `03-rest-api-spec.md` §5 responds per spec.
7. `Idempotency-Key` replay returns the stored result and `Duplicate: true`.
8. A stale `rev` returns `409` **with the current value in `details`**.
9. `PUT /docs/:id` without `If-Match` is rejected.
10. `GET /settings` contains no key material.

**Offline**
11. All 15 rows of the `05` §9 matrix pass.
12. Cold boot with the network off paints the menu and the todo list from L1.
13. A change made offline is delivered exactly once.
14. `visibilitychange` triggers a flush.

**Jarvis**
15. `POST /sessions` and `sessions_save` generate a summary in the same call.
16. A summariser failure saves the session anyway.
17. Summaries are appended, never updated.
18. `POST /mcp` implements `initialize` / `tools/list` / `tools/call` with correct
    JSON-RPC error codes.
19. `POST /recall` returns `ranked: false` with a `reason` when jev fails.
20. `sessions_stats.summaryCoverage` is reported.

**Regression**
21. `tsc --noEmit` clean.
22. The 23 runnable harnesses still pass (the two pre-existing failures stay at
    their recorded counts — `ai-agent-sim` at exactly 11, never 12).
23. The packed bundle renders the HUD identically at 576×288 with no frame over
    999 bytes.

## 4. What I would refuse to build

In full prose, because these are the requests that will arrive and the reasons
matter more than the refusal.

### 4.1 A CRDT / Automerge / Yjs sync engine

It is the technically interesting answer and it is the wrong one here. The two
things this app shares are a **todo list** and **a document body**. Those are not
collaborative-editing workloads: there is one user and a handful of devices, and
the realistic concurrency is "the phone added an item while the browser had the
docs panel open". A CRDT would replace a `rev` integer with a merge structure that
must be **stored, transmitted and interpreted identically on the glasses** —
`main.ts` and `sections.ts` read a plain `HubState` to draw a frame, and there is
no harness for that code path. The failure mode of getting it wrong is a display
that does not match the data, which is the one bug you cannot debug from a
screenshot. The `rev` + converge-forward design gives a bounded, auditable,
explainable conflict policy, and §`05` 8.1 states its one limitation honestly. **No.**

### 4.2 A union-merge anywhere the user can delete

Union-merge for `todo`, `docs`, or `notes` is the seductive "safe" choice and it
is a data-loss mechanism. A union cannot represent an absence, so every deletion
is undone by the next device that reconnects. The user deletes an item, it comes
back, and the bug reproduces only with two devices and only after a reconnect —
which means it ships. The three merge policies in `01-inventory.md` §3 exist
because these are **different kinds of data**, and the tombstone in
`02-database-spec.md` §6 exists because an explicit clear is the one absence a
union *can* encode. **No union, anywhere.**

### 4.3 Storing file bodies in the database

Content Gateway documents are up to `MAX_HTML_BYTES = 4 MiB`, and there are an
unbounded number of them. Putting the bodies in Postgres means: the database
becomes a blob store; every backup doubles; `GET /hub` (a broadcast) risks carrying
one; and the whole point of a *reference* becomes moot. The `file_ref` row is a
pointer with `url`, `size` and `updatedAt` and **no body column at all** — that
absence is the enforcement (`filesNoBody`). File text is fetched on demand and
never cached wholesale. **No.**

### 4.4 An LLM or provider API key in the client bundle

`VITE_*` variables are inlined into the JavaScript the Even App caches and any
browser can read. A `VITE_OPENROUTER_KEY` is a published key. Every provider call
already goes through `POST /api/llm`, because that is where the key lives and where
the balance can be enforced. **No key may be reachable from the bundle, and no
client-side code may hold a credential that is not the user's own session token.**

### 4.5 Embeddings-only retrieval

Handled in `07-jev-recall.md` §6.3 and stated here as a refusal. A corpus that is
findable only via an embedding model becomes unfindable when the model, the
dimension count, or the vendor changes — and the *summaries are the durable
artefact*. Full-text search over `session_summary.text` using the stored
`tsvector` works with no model, no network, and no re-index when the summariser is
upgraded. An embedding may **re-rank** a retrieved set (that is what the
commented-out pgvector block is for) but it may not be the only way in. **No.**

### 4.6 One token shared between the phone, the browser and an MCP client

The three credentials exist because they have genuinely different blast radii. An
owner token can write a secret; a device token cannot. An MCP token can be handed
to an LLM and cannot write a secret or revoke a device — and that is enforced by
the *vocabulary*, not by a check. Sharing one token means the weakest holder
constrains the strongest, i.e. the browser's token becomes as sensitive as the
owner's. **No.**

### 4.7 Unbounded sessions on the broadcast channel

`AgentsState.sessions` rides the `agents` SSE channel, which every connected
device receives and which is cached in `channel.lastState`. Uncapping the *store*
is right; uncapping the *broadcast projection* would make every frame grow
monotonically with the user's history, on a device that renders `HubState` into a
999-byte content budget. The list endpoint is paginated; the broadcast stays
windowed. **No.**

### 4.8 A second source of truth for a summary

A summary is **derived**, always. The moment a summary is editable in place and
treated as a record, three things break: it cannot be regenerated with a better
prompt, it cannot be compared across versions, and a model's behaviour becomes
unexplainable because the input it saw has been overwritten. Summaries are
append-only versions; the transcript is the evidence. **No in-place edit.**

### 4.9 Making the ledger mutable

Every "just let me fix this one entry" request ends the ledger's usefulness.
Append-only is what makes it possible to answer "what did the system think at the
time" — and that is the only question an audit trail answers. Corrections are new
entries with a `refs` link, not edits. The database rule refuses `UPDATE` and
`DELETE` at the engine level, and no route exists to try. **No.**

## 5. Open questions

These are genuinely undecided and should be answered before Phase C, not
presumed:

1. **Does `/recall` run for every spoken turn?** `converse.ts` is specified to call
   it in parallel and use it opportunistically, but the cost model is unknown —
   one jev call per utterance on a personal account. A threshold ("only when the
   utterance contains a referring phrase") would reduce cost and increase
   complexity. **Needs a week of real usage to decide.**
2. **Should `session_summary` keep `prompt_words`/`summary_words`?** It is the
   observability for the 400-word contract, and it is also two columns that are
   only read by a stats endpoint. Leaning yes (cheap, and the alternative is
   guessing why a prompt grew).
3. **Is `kind:'note'` used at all?** It is in the model because a dictated memo
   has no agent and no reply. If nothing ever writes one, the vocabulary has a
   dead value and should be removed rather than left as a misleading option.
4. **The retention policy for `ledger_entry`.** It grows per run, and the client
   only keeps 400 in L2. Server-side retention is unspecified. A monthly partition
   and a 12-month drop is the obvious answer and it is worth confirming that
   nothing wants a longer trail.
5. **Does `document` need versioning after all?** The recommendation is no
   (`03-rest-api-spec.md` §5.3) — the Content Gateway versions published documents
   properly. If in-app docs turn out to be where real editing happens, that
   changes.
6. **`/sync/push` batch size.** 50 is a guess. It should be tuned against the
   actual op production rate, and against the 60/min rate limit for a client that
   is catching up.

## 6. Expert recommendation, in one paragraph

Build Phase A exactly as specified and stop there until the import is proven —
the dual-write makes Phase A free to abandon and it is where every shape mistake
will surface. The single most important client decision is the `mutate()` seam in
Phase B, because it is what turns offline support from a feature into an
invariant; the single most important server decision is the `Idempotency-Key`
table, because it is what makes a retrying phone safe. Extract `rankItems` from
`routeTools` before writing `recall`, or the jev traps will be implemented twice
and fixed once. Keep the ledger append-only and the summaries versioned; those two
rules are the difference between a system that can explain itself and one that
cannot. Do not build a CRDT, do not union-merge a list the user can delete, and do
not let a derived artefact become the only copy of anything. Everything else in
these nine documents is either a consequence of those five sentences or a detail
that can be changed later.
