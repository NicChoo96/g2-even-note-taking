# Jarvis architecture — one log, many projections

Status: **D1 shipped, ledger shipped, menus shipped. R1/R2/D2/D3 designed only.**
This is the design record for the multi-agent layer. `docs/context-and-reranker-plan.md`
covers the *context* problem (what the model is told); this document covers the
*shape* of the layer itself — how actions are classified, recorded, gated, and
composed.

---

## 1. The thesis

The features you eventually want — context that survives a run, chaining one
action onto another, a trace you can read back, injecting a correction mid-run,
a human gate before a destructive write, undo — are normally built as six
separate systems with six stores and six bugs.

They are not six systems. **They are six projections over one log.**

| Feature | Is really |
|---|---|
| Trace the chain | read the log |
| Share context between runs | replay the log |
| Typed handoff (agent → step → agent) | the next step reading the previous step's entries |
| Human gate | an entry sitting `pending` until approved |
| Mid-run injection | an append that later readers pick up for free |
| Undo | a compensating append, and the old entries stay |

That is the whole argument for `glasses/src/ai/ledger.ts`. Getting the *shape*
right is what makes the six features cheap later; building them one at a time
without it is what makes them expensive.

---

## 2. The ledger

`glasses/src/ai/ledger.ts` — pure, no SSE, no stores, no SDK, no imports. That
purity is load-bearing: it is what lets `glasses/tools/ledger-sim.mjs` bundle it
and assert every rule.

```ts
interface Entry {
  seq: number;          // monotonic, never reused — the causal handle
  runId: string;        // groups one run
  at: number;
  kind: EntryKind;      // ask | delta | route | call | result | reply | decision | gate | note | error
  by: EntryBy;          // wearer | jarvis | agent | jev | system
  effect: Effect;       // pure | read | write | irreversible
  status: EntryStatus;  // pending | ok | failed | skipped | declined
  text: string;         // ONE short ASCII line — safe to render on the glasses
  refs: number[];       // the seqs this entry consumed: its causal parents
  locus?: EntryLocus;   // client | relay — where the work would happen
}
```

### Two rules that are load-bearing

**APPEND-ONLY.** There is no update and no delete. A reversed decision is a NEW
entry; the old one stays. A log you can rewrite cannot be audited, and "what
actually happened" is the entire point.

**The ledger RECORDS; it does not OWN state.** `HubState` stays the single source
of truth for the wearer's data. Nothing in the ledger is authoritative for
anything except the history of what was attempted.

That second rule matters specifically because **0.3.28 rebuilt `run.messages`** to
fix the transcript-truncation bug. The ledger is a **SUPERSET** generated *from*
that traffic. If it ever became a competing copy of it, the truncation fix would
be undone by the thing meant to build on top of it. Entries live in a separate
parallel collection precisely so prompt bytes are provably unchanged — asserted
in `ledger-sim.mjs` §8.

### Why `refs` matters

`refs` is what turns a flat list into a chain. A step's parents are the seqs it
consumed; `ledgerMaterial(runId)` is the read that hands a later step exactly
those results and typed decisions — **instead of a raw prose transcript it has to
re-interpret**. That is the typed handoff, and it costs one filter.

`pending` is the other interesting status: it means the entry is a **proposal**.
An agent that is not currently being watched can record an intent, and the next
client to connect runs it through the normal gate and undo path. No round-trip
to a client that may be offline, and no unattended write.

---

## 3. Effect classes

A per-tool `confirm: true` flag has a failure mode with a 100% hit rate
eventually: the ninth capability is added by someone who did not know about the
flag. So the flag became a classification, and the safety rule became a property
of the record.

```ts
type Effect = 'pure' | 'read' | 'write' | 'irreversible';
```

| Effect | Meaning | Gated? |
|---|---|---|
| `pure` | no observable effect | no |
| `read` | reads state, changes nothing | no |
| `write` | changes state, **can be undone** | no |
| `irreversible` | cannot be undone once done | **yes** |

### The safety invariant

> An `irreversible` entry may not reach `status: 'ok'` without a preceding
> **approved gate** in the same run.

`ungatedIrreversible()` returns the violations; it **must be empty**. This is an
assertion, not a warning — an irreversible action that ran unapproved is a
data-loss bug that already happened once (`BUG F`, 0.3.14, where a tap approved a
mirrored destructive confirm).

**The converse is what makes this easier to use, not harder.** `write` entries are
NOT gated. Gating an undoable action trains the wearer to approve without
reading, which is exactly how a gate that matters gets ignored. Six capabilities
are `irreversible`; the rest are `write` and just happen.

### One trap worth recording

A gate's own resolved entry inherits `effect: 'irreversible'` from the prompt it
answers and carries `status: 'ok'`. So a naive filter reports **the approval
itself** as an ungated irreversible success, making the invariant non-empty on
every *correct* run — at which point the safety check is noise and gets ignored.
`ledger-sim.mjs` §2 found this. `ungatedIrreversible()` excludes `kind === 'gate'`,
and there is a dedicated regression assertion for it, because the fix is not
obvious from reading the predicate.

**A harness that does not exercise the failure mode cannot validate a safety
property.** §2 therefore carries a *positive control*: an unapproved irreversible
success is injected and asserted to be reported.

### Where the classification is enforced

`asksToConfirm(cap)` in `glasses/src/ai/registry.ts` is the single predicate:

```ts
export function asksToConfirm(cap: Capability): boolean {
  return Boolean(cap.confirm) || needsGate(effectOf(cap));
}
```

It drives **both** the model-visible tool schema and `prepare()`'s
`needsConfirm`. Keeping them in lockstep means an `irreversible` capability can no
longer forget `confirm: true` — the description the model reads and the
enforcement the runtime applies cannot disagree.

`effectOf()` reproduces the pre-ledger behaviour exactly for anything that
declares nothing:

```ts
export function effectOf(cap: Capability): Effect {
  if (cap.effect) return cap.effect;
  return cap.confirm ? 'irreversible' : 'read';
}
```

---

## 4. The menu — the constraint that shapes the UX

The G2 OS contextual menu holds **max 10 items**, and the firmware has no
switch to scroll it. So the menu is a budget, and a budget spent on this tab's
actions is a budget not available in the next state.

The fixed order (`sectionMenu`, `glasses/src/sections.ts`):

```
1. Jarvis  (→ "Stop AI" while a run is live or a conversation is open)
2. Undo AI  — only while a revertible batch exists and nothing is running
3. Back  — wherever it applies (docs, agents)
4. this tab's own actions
     Docs   → New Docs · Select Docs · Delete Docs
     Agents → Trigger (→ Stop while a run is in flight)
     other  → To-Do · Docs · Notes · Agents switchers
5. Dictate  — always LAST and never trimmed
```

`Dictate` is last on purpose: it is the raw, agent-free path into the page, so it
is the one you must reach for deliberately. `Jarvis` is first because it is the
flagship action.

### The conversation exception

While a Jarvis conversation is open the menu is **the AI group alone** — `Stop AI`
· `Undo AI?` · `Back?` · `Dictate`.

A conversation is modal by design: the HUD owns the tap and the mic re-arms
without a menu trip. Listing the page's own actions next to a live transcript made
the long-press two menus in one — `Delete Docs` sitting under a half-finished
sentence is genuinely ambiguous about whether you are talking to Jarvis or
commanding the page. Removing them makes the long-press answer **one** question.

The rule that decides *what* may be trimmed: **never trim an item that is the only
way out of a tab** (0.3.10). So:

| Item | Trimmed? | Why |
|---|---|---|
| `Stop AI` | no | ends the conversation; always item 1 |
| `Undo AI` | kept if present | suppresses a live run; between turns is exactly when a revert is wanted |
| `Back` | **kept on docs/agents** | the only way off agents (its switchers are hidden) |
| `Dictate` | **never** | keeps the raw page path one press away |
| this tab's actions | yes | reachable the moment the conversation ends; double-tap also ends it |

Measured item counts (`menu-sim.mjs`, 167 checks):

| State | Docs | Agents | To-Do | Notes |
|---|---|---|---|---|
| normal | 6 | 4 | 6 | 6 |
| in conversation | **3** | **3** | **2** | **2** |

Well under the cap in both states, and ending the conversation restores the menu
**byte-identically** — asserted.

---

## 5. The router (R1/R2) — designed, not built

Today the model picks a capability from a prompt. The router is the plan to make
that cheap: a **cascade** that answers "which action is this?" without a full
model round-trip in the common case.

```
utterance
   │
   ├─ 1. exact/alias match on a small intent table   → resolved, no model
   ├─ 2. jev: score each candidate capability's description → typed decision
   └─ 3. the model, with the surviving candidates as tools
```

Each stage only runs if the previous was inconclusive, and every stage writes a
`route` entry so the cascade is visible in the trace.

### Honest caveat — read this before building R1

**The router is the biggest bet and the least measured.** Step 2 assumes jev can
rank *our* capability descriptions reliably. That is **unproven**, and jev has
already produced two traps that a probe settled (`score` vs `probabilities`).

So R1 starts with a probe, not with code:

```
glasses/tools/probe-routing.mjs
  → take the real capability descriptions
  → take ~50 real utterances (including deliberately ambiguous ones)
  → ask jev to rank, compare against a hand-labelled expectation
  → report accuracy per capability and the worst confusions
```

**If accuracy is not good, the cascade gets simpler (jev demoted to a tie-breaker,
or dropped) and nothing else changes.** That is the point of probing first: the
router is a layer over the capability table, not a dependency of it.

---

## 6. Mining (D3) — designed, not built

Every entry already carries `{kind, by, effect, status, text, refs}`. Recurring
*shape* in that log is a learned macro:

```
calls      route("add a todo") → call("todo.add") → ok
repeat ×7  ────────────────────────────────────────
mined      "add a todo" becomes a direct route
```

Two things mining can produce, and they are different:

- **Modifiers** — a recurring directive appended to many runs
  (`deltaBlock` already gives this a home). Mined, not authored, so the wearer
  never manages a library.
- **Chains** — a recurring `route → call → call` shape promoted to one intent.

Mining is a **read** over the ledger, and anything it promotes is a *proposal*
entry, not an install. Silent learning that changes behaviour without a visible
`pending` entry is indistinguishable from a bug.

---

## 7. Intents (D2) — designed, not built

Agent runs already have tools (`web`, `http`, `jev`). The plan is for the
relay to expose the app's own capabilities to agents as *intents*: a run proposes
`docs.append`, the entry lands `pending`, and the **client** executes it through
the normal gate and undo path.

```
relay run ──► ledger entry {kind:'call', locus:'client', status:'pending'}
                                    │
                          next connected client
                                    │
                     gate (if irreversible) → execute → append result
```

This is why `locus` exists on the entry and why `pendingEntries()` filters to
`locus === 'client' && effect !== 'read'`. It is also why the agent loop must
**not** get its own private copy of the capability table — see §8.

---

## 8. What I would refuse to build

These are the decisions that keep the above from rotting. Each is a thing that
looks like a feature and is actually a second source of truth.

- **A second capability list for agents.** Sharing the table is the whole
  reason D2 is possible. A parallel list guarantees drift.
- **A modifier-library UI.** The wearer should never curate a list of learned
  modifiers. Mined, or it does not exist.
- **Hand-authored chains before mining.** A hand-built chain is a guess about
  what recurs. Measure first; the naive version becomes load-bearing.
- **Gating undoable writes.** Explained in §3 — it trains approval without
  reading.
- **Letting the ledger become authoritative.** §2, rule 2. `HubState` owns data;
  the ledger owns history. 0.3.28 depends on this.
- **Scoping the router to *replace* the model.** It is a fast path with a
  fallback, and the fallback is load-bearing. The model remains the answer for
  anything the cascade cannot resolve.

---

## 9. What shipped, and what it cost

| Slice | Status | Files |
|---|---|---|
| Ledger (append-only typed record) | **shipped** | `glasses/src/ai/ledger.ts` |
| Effect classes + `asksToConfirm` | **shipped** | `ai/types.ts`, `ai/registry.ts`, 6 capability files |
| Gate entries + `ungatedIrreversible` | **shipped** | `ai/store.ts` (gate lifecycle), `ai/ledger.ts` |
| **D1** — spoken delta does not discard the card | **shipped** | `capabilities/agents.ts`, `stream.ts`, `web/server/local-sse.mjs`, `web/server/wire.mjs` |
| Menu collapse in conversation | **shipped** | `glasses/src/sections.ts` |
| Router (R1/R2) | **designed** | §5 — probe first |
| Mining (D3), Intents (D2) | **designed** | §6, §7 |
| Web search is provider-swappable | **shipped** | `web/server/web-search.mjs` + client migration |

**D1 was the concrete bug that motivated the log.** A spoken sentence used to
*replace* the agent's saved prompt and discard it — so saying one extra word threw
away the task. Now:

- `prompt` is the task,
- `savedPrompt` carries the saved card as **material**,
- `instructions` layers onto the **system prompt** as a directive,
- `assembleWire(run, resolvedText, now)` merges **Card → Directives → Material → Ask**.

The byte-identity contract is what makes this safe to add: with both new fields
empty, the assembled `content` is the raw `withDateTime(systemPrompt)` string and
the user content is the raw resolved text — **not a one-element join, not a
trimmed copy**. Asserted in `ledger-sim.mjs` §8. Every new field is optional and
omitted (not empty-stringed) when unused, so an old caller produces the exact wire
body it did before.

`web/server/wire.mjs` was extracted from `local-sse.mjs` for one reason: the relay
starts a server on import, so nothing it built was reachable from a test. Moving
code breaks source-scanning tests, so `datetime-sim.mjs` §7 now scans `wire.mjs`
**and** asserts the relay still delegates to it — a scan of the wrong file would
otherwise pass while the real path went unstamped.

---

## 10. Verification

Everything below is asserted by a harness, not by prose.

| Harness | Checks | Covers |
|---|---|---|
| `glasses/tools/ledger-sim.mjs` | 81 | append-only + bounds, the gate invariant **with a positive control**, all projections, effect classification, a source scan of the capability table, and the relay wire byte-identity |
| `glasses/tools/menu-sim.mjs` | 167 | menu item counts per state, the conversation collapse, restore-identity, and the 10-item cap |
| `glasses/tools/jev-spec-sim.mjs` | — | jev's typed contract |
| `glasses/tools/datetime-sim.mjs` | — | the clock, and the wire delegation |
| `glasses/tools/web-search-sim.mjs` | 152 | both request shapes, the byte-identity invariant, the budget chain, provider resolution, the relay's delegation, and the client's tool-id migration |
| `glasses/tools/sim-all.mjs` | — | the sweep itself (exit-code judged, per-harness verdict dialects) |

Two source-scan assertions are worth calling out because they catch classes of
error a unit test cannot:

1. **Nothing asks to confirm a harmless action**, and **every irreversible
   capability asks first.** This is what stops `confirm: true` drifting onto a
   read.
2. **The menu never trims the only escape** from a tab.

### Known-broken, pre-existing (not caused by this work)

- `glasses/tools/agents-sim.mjs` — bundles `src/agents.ts`, a file that no longer
  exists. The entry point needs repointing.
- `glasses/tools/ai-agent-sim.mjs` — 8 failing assertions (4 CoT + 4
  Conversation-source invariants).

Sweep: `node tools/sim-all.mjs [name-filter…]` runs every `tools/*-sim.mjs` with
`spawnSync` so one crash cannot abort the rest. **Judge on the exit code** — sims
word their summaries differently (`ALL PASS`, `ALL CHECKS PASSED`,
`RESULT: PASS`, `57 passed, 0 failed`) and `segment-sim.mjs` takes a WAV path as
argv, so a token-matching detector produces false negatives. Run it in batches:
the heavy bundled sims exceed a single shell call.

Two lessons from building that sweep, both recorded because they cost time:

1. **Never infer a failure count from a passing line.** `57 passed, 0 failed`
   contains the word *failed*; a careless regex reads it as a failure.
2. **`process.exit()` discards a piped report.** `console.log` is asynchronous
   when stdout is a pipe, so exiting immediately races the flush. Set
   `process.exitCode` and let the process drain.

### Web search is one tool over two backends

The agent never chose a vendor and should not start now. The model always calls
`web_search`; the relay resolves a provider from `SEARCH_PROVIDER` (or
`secrets.searchProvider`, or whichever key is present, Tavily first) and
delegates to `web/server/web-search.mjs`. That module owns both request shapes
— Brave is a `GET` with `X-Subscription-Token`, Tavily a `POST` with
`Authorization: Bearer` — because two `fetch` shapes in one file is how a wrong
auth header becomes a silent 401.

The invariant that makes the swap invisible is that **both providers emit
byte-identical output** for an equivalent hit. The search result string feeds the
token-budget chain (`PER_HIT_CHARS` → `TOOL_RESULT_CHARS` →
`TRANSCRIPT_MSG_CHARS` → `MAX_STEPS × TOOL_RESULT_CHARS`), so a second output
shape would silently invalidate the loop's sizing. Asserted by `web-search-sim.mjs`
§8, which formats the same hit through both providers and compares the strings.

The design decisions worth keeping:

- **LLM Context, not Answers.** The tool returns snippets for the model to read;
  a synthesised answer would be a second writer of the same text.
- **No pinned `Api-Version`.** Brave's new content pipeline is the default; pinning
  would quietly opt out of it.
- **No hardcoded `country`/`search_lang`.** Guessing the wearer's region is worse
  than letting the service default.
- **A selected provider with no key resolves to an empty key** and fails with the
  exact env var name. Falling back to the other key would be a silently fabricated
  provenance — the result would claim Brave while being Tavily.
- **The rename migrates both sides of the reference pair.** `tool-tavily` →
  `tool-web` in the tool *id* **and** in every `agent.toolIds`, in the same
  `normalize...` pass, or the agent quietly ends up with no working tools.
