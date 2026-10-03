# 07 — JEV as the session selector (recall)

The user's requirement, verbatim: *"using JEV tool to select the sessions based on
what Jarvis passed from STT from user"*.

This document defines `POST /recall` and the one primitive underneath it: the
existing tool-router's ranking step, extracted and generalised so that **routing a
tool** and **selecting a session** are the same operation with different
candidates.

## 1. The primitive already exists

`web/server/mcp-router.mjs` already does exactly the thing needed:

```js
routeTools({ ask, catalogue, top = 4, respond, minCandidates = 2 })
  → { chosen, all, routed, ranking, unresolved, reason }
```

It builds a jev `choice` specification from a list of candidate names
(`buildRouteSpec(entries, ask)`), asks jev which one the request refers to, and
**fails open in eight distinct ways** when the decision cannot be made — reporting
which way, in words, in `reason`.

Selecting a session is the same problem:

| | routing | recall |
|---|---|---|
| candidates | tool names | session summaries |
| the "ask" | the last user turn | **the STT text** |
| output | one tool to call | one session to read |
| failure | call the tool anyway / call nothing | return by recency |

So the design is: **extract the ranking step as `rankItems({ ask, candidates, top,
respond })`** and have both `routeTools` and `recall` call it. One implementation,
one set of traps, one set of fail-open reasons, one formatter, one test suite.

**Why extraction rather than a parallel implementation:** the two jev traps below
are non-obvious, dangerous, and currently only appear once in the codebase where
they have been fixed and documented. Copying that logic into a new module
duplicates the traps and guarantees that the next fix is applied to one of them.

## 2. The two jev traps (verbatim, and non-negotiable)

> ### ⚠ Trap 1 — `score` answers are **0-BASED CONTINUOUS floats**
>
> A `score` question returns a number in `[0, 1]`, not a rank and not an integer
> position. **Never shift it. Never round it. Never treat it as an index.**
> **Clamp only** — to `[0, 1]` — and compare directly.
>
> The specific bug this prevents: a value of `0` is a *legitimate score meaning
> "worst"*, and code that does `score || fallback` or `if (!score)` discards it and
> silently promotes a different candidate. That is not a crash; it is a wrong
> answer with no signal.

> ### ⚠ Trap 2 — `probabilities` is keyed by **LABEL** for `choice` but by **INDEX**
> for `score`
>
> A `choice` question comes back with `probabilities` keyed by the option's
> label. A `score` question comes back keyed by the option's **index**.
>
> The consequence: reading `probabilities[label]` for a `score` question yields
> `undefined` for every option. Any code that then sorts on `undefined` produces
> an arbitrary order that *looks* like a genuine ranking — and since the input
> order is often already close to correct, the output is plausible. **This is the
> most dangerous failure in the file.**
>
> The fix is the `relabel` parameter: emit the score question with labels, and pass
> `relabel` so the returned keys are labels too. Then one reader works for both
> modes. **Any call that constructs a `score` question without `relabel` is a
> bug**, and it must be asserted in a test that keys come back as labels.

### 2.1 Constants

| Constant | Value | Meaning |
|---|---|---|
| `QUESTION_TYPES` | `['noul','choice','score']` | the three jev modes |
| `TOOL_KINDS` | `[...QUESTION_TYPES, 'rank']` | what a *registered tool* may be |
| `RANK_MARGIN` | `0.1` | how far ahead the top option must be to count as decided |
| `NAME_RE` | `/^[a-z][a-z0-9_]*$/` | option/tool name shape (also the MCP rule) |
| `NOUL_KEYS` | `['true','false']` | the boolean mode's keys |
| `MAX_CRITERIA_COUNT` | `12` | never build a question with more options |
| `DEFAULT_TOP` | `4` | how many ranked results by default |

**⚠ `MAX_CANDIDATES = LIMITS.MAX_CRITERIA_COUNT` (= 12) and candidates above it are
NOT truncated — the call fails open.** Silently truncating to the first 12 would
mean the 13th candidate is unreachable *and* the caller believes all 13 were
considered. Failing open with a reason is the honest behaviour, and it is already
what `routeTools` does.

## 3. `rankItems` — the extracted primitive

```js
export async function rankItems({ ask, candidates, top = DEFAULT_TOP, respond,
                                  minCandidates = 2, mode = 'choice', relabel = true })
```

- `candidates: Array<{ id: string, label: string, text: string }>`
- `respond` — injected jev caller, so every test runs with no network. **The
  injection point is not optional**: without it there is no way to test any
  fail-open branch.
- Returns:

```js
{ ranked: boolean,          // false → fail-open, order came from the caller
  chosen: string[],         // ids, best first, length ≤ top
  all: Array<{ id, p }>,    // every candidate with its probability
  reason: string,           // the fail-open vocabulary (§4)
  mode: 'choice'|'score' }
```

### 3.1 Rules

1. **`candidates.length < minCandidates` → fail open**, `reason:'too few candidates
   to rank'`. Ranking one item is a jev call that costs money and cannot change the
   answer.
2. **`candidates.length > MAX_CANDIDATES` → fail open** with the count in the
   reason. Never truncate (§2.1).
3. **Build the spec with labels** for both `choice` and `score`, and pass `relabel`
   (§Trap 2).
4. **Read `probabilities` by label.** One reader for both modes.
5. **Require at least one numeric `p`.** If every value is `undefined` or
   non-numeric, the answer is unreadable → **fail open, not "everything scored 0"**.
6. **Clamp, never shift** (§Trap 1).
7. **Decide with `RANK_MARGIN`.** The top item is only *chosen* if
   `p[0] - p[1] >= RANK_MARGIN`. Otherwise the result is "these are close" — the
   `ranked` order is still returned, but a caller that needs a single answer must
   treat it as ambiguous rather than picking the top.
8. **`ranking` is always the caller's order when `ranked === false`.**

> **⚠ Rule 7 is what stops recall from being confidently wrong.** For tool routing,
> a near-tie is harmless — picking either tool is a reasonable guess. For session
> recall, a near-tie presented as "the session you meant" is a fabrication. The
> `RANK_MARGIN` threshold is what makes the difference expressible, and it is why
> `chosen` and `all` are separate fields.

## 4. The fail-open vocabulary

The **same** vocabulary as `routeTools`. A caller must be able to log one string
and know exactly why it fell back.

| `reason` | Cause |
|---|---|
| `no candidates to rank` | the candidate list was empty |
| `no request to route against` | the ask/STT text was empty |
| `too few candidates to rank` | `< minCandidates` |
| `the candidate list already fits` | everything fits in `top`; no decision needed |
| `no ranker configured` | no jev credential |
| `too many candidates to rank (N > 12)` | over `MAX_CANDIDATES` |
| `could not build a ranking: …` | spec construction failed |
| `the ranking request was rejected: …` | jev returned an error |
| `the ranker failed: …` | transport error |
| `the ranker returned no usable order` | no numeric `p` in the response |

> **⚠ An unreadable jev result must NEVER be read as a declared order.**
> If `probabilities` is missing, mis-keyed, or non-numeric, the correct outcome is
> `ranked: false` and the caller's own order. Treating a failed parse as "the order
> is whatever came back" is how a broken ranker becomes an invisible random
> selector — and because the caller's original order is usually already sensible,
> the wrongness is undetectable.

## 5. From STT text to a decision

### 5.1 The ask

The `state` passed to jev is **the STT text, and only the STT text** — not the
digest, not the recent turns, not the system prompt.

**Why the raw utterance:** jev is a typed *decision* primitive. The question is
"given this person just said *X*, which of these sessions is *X* about?" Adding
context changes the question into something fuzzier and makes the answer
unattributable when it goes wrong. If context is needed, it belongs in the
candidate labels, where it can be seen.

Guard: an empty or whitespace-only utterance → fail open with
`no request to route against`, and **return recent sessions**. Never call jev with
an empty state.

### 5.2 The candidate labels

A `choice` option label must be **short, ASCII, and distinguishable** — the
`describeAnswers()` formatter (`§6`) is the only thing that renders it.

```
label = `${i}. ${truncate(session.title, 48)} — ${truncate(summary.firstClause, 60)}`
```

Rules:
- **`NAME_RE` does not apply to labels.** It applies to *tool* names. A label is
  free text, and forcing session titles into snake_case would destroy them.
- **Include the date** if the titles are not self-distinguishing ("the ferry trip"
  twice, three months apart). The date is the only disambiguator jev has.
- **Never include the full summary.** Twelve summaries at 400 words is 4 800 words
  of prompt to answer one multiple-choice question. The first clause plus the title
  is enough to separate candidates, and the ranking stage is a *selector*, not a
  reader.
- **Never include two candidates with identical labels.** Identical labels make the
  jev answer ambiguous by construction. `rankItems` must detect and de-duplicate
  labels (appending a disambiguator) **before** building the spec, and log when it
  had to.

### 5.3 `choice` or `score`?

| Mode | Use | Why |
|---|---|---|
| `choice` | **default for recall** | the question is genuinely "which one of these", and `choice` gives a normalised distribution over the candidates |
| `score` | when candidates are independent | used when a caller wants "how relevant is each, absolutely" — e.g. re-scoring a re-ranked set |

**Recall uses `choice`.** A user utterance refers to *one* session (or none); it is
not twelve independent relevance judgements. `score` would let twelve candidates
each score `0.9`, which has no interpretation as an answer to "which session".

**⚠ If a caller does pass `mode: 'score'`, the `relabel` requirement is
mandatory** (§Trap 2), and `rankItems` must enforce it rather than trusting the
caller.

## 6. `describeAnswers()` — the one formatter

`describeAnswers()` is the **only** code that renders a jev result into text, and
it is unchanged. Rules it enforces:

- **ASCII only.** The result may be rendered on the glasses, whose firmware font
  has no emoji and no `SAFE_NON_ASCII` guarantees.
- **One line per answered question**, `question: answer` shape.
- **A probability is rendered as a percentage with no more than one decimal**, so
  `0.7333` does not become a 6-character number in a 999-byte frame.
- **A near-tie is rendered as a near-tie**, not as a winner. If the top two are
  within `RANK_MARGIN` it appends an explicit marker. A formatter that always names
  a winner is where "confidently wrong" actually enters the product.

**⚠ No second formatter may be added.** A second one is how the ASCII rule and the
near-tie rule get lost one call site at a time.

## 7. `POST /recall`

```jsonc
// request
{ "text": "what did I decide about the ferry booking",
  "limit": 12,          // candidates retrieved before ranking (≤ MAX_CANDIDATES)
  "top": 3,             // ranked results returned
  "minScore": 0.2,      // drop candidates below this even if ranked
  "includeMessages": false,
  "kind": null,         // restrict to one SessionKind
  "pinned": null }
```

```jsonc
// response
{ "ok": true,
  "selected": [
    { "sessionId": "…", "title": "…", "at": 173…, "kind": "voice",
      "summaryVersion": 2, "summary": "…", "score": 0.91, "pinned": false }
  ],
  "candidates": 7,
  "ranked": true,
  "ambiguous": false,
  "reason": "ranked 7 candidates",
  "mode": "choice",
  "serverTime": 173… }
```

### 7.1 Field semantics

| Field | Meaning |
|---|---|
| `candidates` | how many survived retrieval **before** ranking |
| `ranked` | `false` → the ranker failed; `selected` is **recency order** |
| `ambiguous` | `true` → the top two are within `RANK_MARGIN`; `selected` is a list, not an answer |
| `reason` | the fail-open string (§4) or `'ranked N candidates'` |
| `score` | the jev probability, clamped; **`null` when `ranked === false`** |

**⚠ `score` is `null`, not `0`, when `ranked === false`.** A `0` is a real score
meaning "worst" (§Trap 1). Returning `0` for "we did not rank" makes the two
indistinguishable to every caller, and a caller that filters `score > 0.2` would
then discard the fallback results for the wrong reason.

**⚠ `ranked: false` must be surfaced in the UI, not swallowed.** This is the same
principle as every other fail-open in the codebase: degrading is fine, degrading
silently is not. A recall that fell back to recency and does not say so is a
feature that appears to work and sometimes returns nonsense.

### 7.2 The pipeline

```
1. validate text                  → empty? fail open, recency
2. retrieve candidates            → FTS + array containment + pinned + recency
                                    (06-jarvis-sessions.md §6.3), cap at limit
3. if candidates.length <= top    → fail open: 'the candidate list already fits'
4. rankItems({ ask: text, …, mode: 'choice', respond: jevCall, relabel: true })
5. apply minScore                 → but only when ranked === true
6. hydrate summaries for `top`    → session_summary at summary_version
7. return
```

**⚠ Step 5 must not run when `ranked === false`.** Filtering fallback results by a
score that does not exist is the same class of bug as `score || fallback`.

**⚠ Step 6 must read `summary_version`, not "the latest summary row".** A
regeneration that produced v3 while a client asked against v2 should not silently
return v3 — the version is requested explicitly so a caller can compare.

### 7.3 Ordering guarantee

**`selected` is always ordered by descending score when `ranked === true`, and by
descending `at` when `ranked === false`.** The order is therefore always
meaningful, and `ranked` says which meaning it has. This mirrors
`runById`/`pickRunForAgent`'s discipline in `agent-runs.ts`: never return an
unordered list where the caller will assume an order.

## 8. Wiring recall into the loop

Where recall is called, and where it deliberately is not:

| Caller | Calls recall? | Why |
|---|---|---|
| `converse.ts` (a spoken turn) | **yes**, with the raw STT text | this is the requirement |
| `agent.ts` loop, before planning | **no**, not automatically | the model can call the `recall` tool itself; auto-injecting would spend a jev call on every turn of every run |
| `dictate.ts` | **yes** (fire-and-forget) | to attach the utterance to a session |
| the `recall` MCP tool | yes | that is the tool |
| the panels | no | not a user-facing search; `sessions_search` is that |

> **⚠ Recall must never be on a latency-critical path.** It is one jev call plus
> a DB query. A spoken turn that blocks on it feels broken. `converse.ts` calls it
> **in parallel** with intent resolution and uses the result only if it arrives
> before the answer is composed; otherwise the turn proceeds with the digest alone
> and the session link is attached afterwards.
>
> **⚠ A recall failure is never a turn failure.** Every failure path in §4 ends in
> "the turn proceeds". Recall is an enhancement; the fallback is the digest, which
> is already injected.

## 9. Test requirements

| # | Case | Assertion |
|---|---|---|
| 1 | `choice` result | `probabilities` read by label; order correct |
| 2 | `score` result | **keys are labels, not indices** |
| 3 | `score` with a legitimate `0` | preserved as `0`, not treated as missing |
| 4 | every `p` non-numeric | `ranked: false`, reason `'no usable order'` |
| 5 | 13 candidates | fail open, no truncation, count in the reason |
| 6 | 1 candidate | fail open, jev **not called** |
| 7 | top two within `RANK_MARGIN` | `ambiguous: true`, order still returned |
| 8 | empty STT text | fail open, recency order, jev not called |
| 9 | jev 4xx | fail open with the provider message in `reason` |
| 10 | identical candidate labels | de-duplicated before the spec is built |
| 11 | `ranked: false` | `score` is `null` on every result |
| 12 | `minScore` with `ranked: false` | **not applied** |
| 13 | `describeAnswers` output | ASCII only, one line, ≤ 999 bytes |
| 14 | same corpus, ranker up vs down | `selected[0]` differs only when the ranker genuinely decided |

Rows 2, 3, 6, 10 and 12 are the ones that pass by accident without a harness —
they are exactly the traps in §2 and the extraction in §3 is what makes them
testable once instead of twice.
