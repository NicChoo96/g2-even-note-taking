# Agent schedule — backend specification

**This document is self-contained.** Everything needed to implement and verify it is below; no other spec has to be read.

| | |
|---|---|
| **Purpose** | Give the agent scheduler a durable home in the hub database so a schedule survives a Railway redeploy. |
| **What the backend must build** | Nothing new, if you are willing to widen one permission. `GET\|PUT\|DELETE /hub/relay/{key}` already exists; the relay is simply refused by it. §4 covers the three ways to allow it. |
| **Data stored** | One JSON object of ~1–8 KiB: agent names, `HH:MM` times, weekday numbers. **No secrets, no tokens, no personal data.** |
| **Who writes** | The relay (Railway) only. The hub never writes it. |
| **Who reads** | The relay, once at boot and once per save. Not per run, not per minute. |
| **Current status** | `GET /hub/relay/agent-cron` → **403 `SCOPE_DENIED`** with the relay's credential. That is the only blocker. |

---

## 1. The two systems, and which one owns what

```
┌──────────────────────────┐        ┌───────────────────────────────────────┐
│  HUB  (167.172.77.136)   │        │  RELAY  (Railway)                     │
│  Postgres, owner-scoped  │        │  Node, one instance, always on        │
│                          │        │                                       │
│  agents, tools, docs     │◀──GET──│  reads the schedule at boot           │
│  agent-cron  (schedule)  │◀──PUT──│  writes it when the wearer edits it   │
│  sessions, devices       │        │  RUNS the agent on a 60 s tick        │
└──────────────────────────┘        │  holds LLM key, tools, run recorder   │
                                    └───────────────────────────────────────┘
```

**The hub is the store of record. The relay is the clock.**

That split is not an accident: an agent run needs the LLM API key, the web-search tool, the document-store tool, and the run recorder — all of which live in the relay process. The hub stores agents; it does not execute them. See §3 for why the trigger belongs on the relay and not in a hub cron.

---

## 2. What "schedule" means here

A wearer opens the hub page, Agents tab, and adds: *"Watchkeeper every day at 07:00"*.

* The **relay** ticks every 60 s, computes the wall clock in the schedule's `timeZone`, and fires the agent whose `at` has arrived.
* It **does not ask the hub each tick**. The schedule is read at boot and written when edited.
* A missed window (relay redeploying, hub down at 07:00) is **skipped, not replayed** — there is a 20-minute grace, and beyond that the slot is dropped. A returning relay must never fire five catch-up runs.
* A run cannot double-fire: the relay records the slot key `YYYY-MM-DD HH:MM` and refuses a second run for it.
* Caps: **2 runs per tick**, **12 per day**. `G2_AGENT_CRON=0` on the relay disables the clock entirely.

---

## 3. Where the trigger fires (the design decision behind this route)

Three options exist. This section is the argument, so the choice does not have to be re-litigated later.

| Option | Mechanism | Verdict |
|---|---|---|
| **A. Hub runs the agents on its own cron** | Hub calls the LLM and the tools itself at 07:00 | **No.** It duplicates the whole run engine, splits billing across two systems, and requires every provider key (OpenRouter/DeepSeek/Tavily) to live on the hub as well. |
| **B. Hub pushes "run now" to the relay** | Hub cron `POST`s the relay at 07:00 | **Not now.** Requires inbound auth into Railway, a retry policy, and a per-slot idempotency key. A relay that happens to be redeploying at 07:00 either loses the run or fires it twice. |
| **C. Relay owns the clock; hub holds the schedule** | Relay ticks locally, reads the schedule from the hub | **Yes.** One process owns both the clock and the run, so there is no cross-service delivery problem to solve. A relay restart simply reloads the schedule. |

**Recommended: C.** The hub's traffic cost is **one `GET` per relay boot and one `PUT` per edit** — nothing per run.

If the relay ever stops being always-on, B becomes worth revisiting; §10 describes it.

---

## 4. The route family (full contract — already implemented, listed for completeness)

The family is a **single owner-scoped key/value slot** on the existing `app_setting` table. No migration, no new table.

### 4.1 Route index

| Method | Path | Scope name | Success | Notes |
|---|---|---|---|---|
| `GET` | `/hub/relay/{key}` | `read_relay_state` | `200` | One stored object, or `404 NOT_FOUND` when that key was never written. |
| `PUT` | `/hub/relay/{key}` | `replace_relay_state` | `200` | **Upsert.** Whole-value replace. `rev` is **not** required and **must not move** (§4.5). |
| `DELETE` | `/hub/relay/{key}` | `delete_relay_state` | `204` | Removes one key. `404` when there was none. **No body at all** on success. |

### 4.2 Key format

`key` is a **path segment**, not a query parameter, constrained to:

```
^[a-z0-9][a-z0-9-]{0,31}$
```

lowercase letters, digits and single hyphens, 1–32 characters. A key that does not match is `400 VALIDATION_ERROR` with `details.field = "key"`, raised **before** any storage is touched.

Keys in use after this lands: `auth` (relay sessions and paired devices — secret), `agent-cron` (this document — not secret), optionally `agent-cron-state` (§6.2).

### 4.3 Envelope

Everything returns JSON except `204`. Errors:

```json
{ "ok": false, "error": "human readable sentence", "code": "MACHINE_CODE", "details": {} }
```

`GET` / `PUT` success:

```json
{
  "ok": true,
  "rev": 68,
  "key": "agent-cron",
  "value": { "version": 1, "enabled": true, "jobs": [] },
  "updatedAt": 1791046286329
}
```

* `value` is whatever was last `PUT`, **byte-identical after a JSON round trip**. Do not add, drop, reorder or retype anything inside it.
* `updatedAt` is **epoch milliseconds**, server-stamped from the same clock as every other `*At` in the hub. Never accept a timestamp from the client.
* `PUT` **echoes the stored value back**, so the relay can confirm the write without a follow-up read.

### 4.4 Error codes

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Key does not match §4.2 (`details.field = "key"`); missing `value` (`details.field = "value"`); `value` not an object; **any top-level key other than `value`** (`details.allowed = ["value"]`) — extras must fail loudly, never be ignored. |
| `403` | `SCOPE_DENIED` | The credential is not permitted for this key. **This is today's answer for the relay.** |
| `404` | `NOT_FOUND` | `GET`/`DELETE` on a key never written. `details.key` names it. **Absence is normal, not an error** — it is how the relay knows it is the first writer. |
| `409` | `STALE_REV` | Does not apply to this family; `rev` is not used here. |
| `413` | `TOO_LARGE` | Serialised `value` over the cap (`details.limit`). Use `TOO_LARGE`, not `VALIDATION_ERROR` — that code already means "payload size, not shape". |

### 4.5 Rules that are easy to get wrong

1. **`rev` must not move.** `app_setting` is not one of the tables that advance `hub_state.rev`. A `PUT /hub/relay/{key}` returns the *current* `rev`, unchanged. If this route bumped `rev`, it would invalidate every other client's cached todo and document mirrors on a routine schedule save. **A client must not infer "something changed" from the `rev` in this response.**
2. **Owner-scoped.** The route reads and writes the credential store, so it must refuse a device-scoped or MCP-scoped credential with `403 SCOPE_DENIED`. Model the check on `GET /hub/settings`.
3. **Invisible to MCP.** Do not add a tool for it, and do not alias an existing tool onto it. An agent that can read the `auth` blob can read every live session token. Add a test asserting the MCP tool list is unchanged after this route lands.
4. **Never part of `GET /hub`.** That projection is fetched by every client on boot and is already large; inlining the credential store would hand every reader the relay's session tokens.
5. **Never part of `/hub/sync/pull` or `/hub/sync/push`.** It is not a synced collection. The relay is its only writer.
6. **Not in `/hub/diag/schema`** — that endpoint reports MCP tool schemas, and this route has no tool.
7. **Rate scope `default`** (600/min). No new bucket. The relay's real traffic is a few requests per day.
8. **Storage layout.** One `app_setting` row per key per user, with the row's `key` column namespaced **`relay:<key>`** (so `relay:agent-cron`). Namespacing keeps it from colliding with settings keys (`searchProvider`, `depth`) that legitimately live in the same table, and makes the family greppable in the database. `value` is the serialised JSON.
9. **`Idempotency-Key`** is accepted and honoured, but the relay does not send one: a whole-value `PUT` is naturally idempotent.

### 4.6 What the relay stores (so you know what you are trusting)

| | `relay:auth` | `relay:agent-cron` (this work) |
|---|---|---|
| Contents | Session tokens as **SHA-256 digests**, paired-device rows | Agent names, `HH:MM`, weekday integers, a timezone name, an optional instruction string |
| Secret? | **Yes** — treat as credential material | **No** — nothing here is confidential |
| Typical size | < 1 KiB | < 2 KiB (cap 128 KiB) |
| Writers | Relay | Relay |

That asymmetry is the whole basis of Option 1/2 in §5.

---

## 5. What has to change — pick one

`/hub/relay/*` is owner-scoped because `auth` holds live session tokens. **That rule is correct for `auth`.** The relay signs in with a *work* credential (`POST /auth/login`, `JARVIS_FILE_USER`), which is neither owner nor device scoped, so both keys currently answer `403 SCOPE_DENIED`.

**Option 1 — preferred: a machine owner identity for the relay.**
Issue an owner-scoped credential for the relay process (env `G2_HUB_OWNER_TOKEN`, or make `JARVIS_FILE_USER`/`JARVIS_FILE_PWD` owner-scoped). This fixes **both** keys at once — including `auth`, whose mirror to the hub has been silently failing for the same reason, so sessions currently survive only on the relay's own disk.

**Option 2 — a documented non-secret allow-list.**
Let the relay's service account read/write a short, auditable set of keys that contain no credentials (`agent-cron`, `agent-cron-state`, `relay-meta`) while continuing to refuse `auth` with `403`. This is a narrow exception, not a general widening.

**Option 3 — a dedicated route.**
`GET|PUT /hub/schedule`, same value contract, service-account scope. More code than Option 2 with no functional gain, but it keeps the family strictly owner-only — reasonable if that invariant matters more than the extra route.

Whichever is chosen, the invariants in §4.3–§4.5 still apply unchanged.

---

## 6. The value contract

### 6.1 Key `agent-cron`

```json
{
  "version": 1,
  "enabled": true,
  "timeZone": "Asia/Singapore",
  "graceMinutes": 20,
  "jobs": [
    { "agent": "Watchkeeper", "at": "07:00" },
    { "agent": "News Desk", "at": "07:10", "ask": "Focus on AI chips." },
    { "agent": "Fleet Auditor", "at": "08:00", "days": [1], "enabled": true }
  ]
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `version` | integer | no — default `1` | Must equal `1`. A higher version is **refused**, not best-efforted. |
| `enabled` | boolean | no — default `true` | Master switch. `false` keeps the jobs and runs none. |
| `timeZone` | string | no — default `"Asia/Singapore"` | Any IANA zone name. An unresolvable name is a `400` (§7.4). |
| `graceMinutes` | integer | no — default `20` | Clamped to `0…180`. |
| `jobs` | array | **yes** — may be `[]` | Order is irrelevant. |
| `jobs[].agent` | string | **yes** | The agent's **name** as it appears on the hub; matched case-insensitively at run time. An agent id is also accepted. A name that does not exist is a *runtime* refusal, not a validation error — the hub cannot be expected to know which names the relay will resolve. |
| `jobs[].at` | string | **yes** | `HH:MM`, 24-hour, **zero-padded**, on the wearer's clock in `timeZone`. `"7:00"` and `"24:00"` are invalid. |
| `jobs[].days` | integer[] | no | `0`=Sunday … `6`=Saturday. Omitted / `null` / `[]` all mean **every day**. A list containing no valid weekday is **refused** — never silently converted to daily. |
| `jobs[].ask` | string | no | Extra instruction layered on top of the agent's own saved prompt. Never replaces it. Max 500 chars. |
| `jobs[].enabled` | boolean | no — default `true` | Per-job pause. |

An empty `jobs` array with `enabled: true` is valid and means "clock on, nothing scheduled".

**The relay always writes the whole document.** It never patches one field, so the hub needs no merge logic.

### 6.2 Key `agent-cron-state` — optional, Phase 2

Written by the relay after a tick that fires something, so the hub holds the audit trail:

```json
{
  "version": 1,
  "slots": { "watchkeeper|07:00": "2026-11-09 07:00" },
  "day": "2026-11-09",
  "count": 2,
  "errors": { "fleet auditor|08:00": "no such agent" },
  "updatedAt": 1791046286329
}
```

Pure observability — the relay does not need it to function, and losing it costs at most one duplicate run inside a grace window. Skip it if it complicates the scope decision, or implement it later; it uses the same generic route and costs no extra backend work beyond the allow-list entry.

---

## 7. Validation — please enforce it on the hub too

The relay validates before every write, but the hub is the store of record and must not accept a document a future client would misread.

1. `version === 1`, else `400`.
2. `jobs` is an array. Every `jobs[].agent` is a non-empty string.
3. Every `jobs[].at` matches `^([01]\d|2[0-3]):[0-5]\d$`.
4. `timeZone`, when present, must resolve via `Intl.DateTimeFormat` — reject an unresolvable zone rather than storing it.
5. `jobs[].days`, when present and non-null, must be a non-empty array of integers `0…6`. An array naming no valid weekday → `400`.
6. `graceMinutes`, when present, is an integer `0…180`;
7. `jobs[].ask`, when present, is a string ≤ 500 chars.

**Two validators that disagree is how a schedule saves successfully and then never runs.** Keep the rules identical in both places.

---

## 8. Concurrency and durability

* **One writer.** The relay is the only writer; the hub never originates a change.
* **Whole-value replace, last write wins.** No merge, no `If-Match`. (`If-Match` *is* used by `PUT /docs/{id}` — a different collection; do not apply it here.)
* **`rev` untouched** (§4.5 rule 1).
* If a second editor is ever permitted (a page writing this key directly), tell the relay team first: the relay's rule is *"adopt the hub copy only when its `updatedAt` is newer than the last value we wrote"*, and that rule needs revisiting with two writers.
* Durability expectation: a Railway redeploy must reclaim the schedule from the hub with no operator action. That is the whole point of this work.

---

## 9. Verification

### 9.1 Happy path and the two classic failures

```bash
BASE=http://167.172.77.136
TOKEN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"<user>","password":"<pass>"}' | jq -r .access_token)

# 0. Baseline rev, to prove the write does not move it
curl -s "$BASE/hub" -H "Authorization: Bearer $TOKEN" | jq .rev

# 1. Never written -> 404 NOT_FOUND with details.key
#    (today: 403 SCOPE_DENIED until §5 lands)
curl -s "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" | jq -c

# 2. Create -> 200, ok:true, value echoed, updatedAt = epoch ms
curl -s -X PUT "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":{"version":1,"enabled":true,"timeZone":"Asia/Singapore","graceMinutes":20,
       "jobs":[{"agent":"Watchkeeper","at":"07:00"}]}}' | jq -c

# 3. Read back -> value byte-identical
curl -s "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" | jq -c .value

# 4. Upsert -> same key, two jobs, still ONE row, still 200 (never 201)
# 5. rev unchanged after every write
curl -s "$BASE/hub" -H "Authorization: Bearer $TOKEN" | jq .rev

# 6. A sloppy time must be refused by the HUB, not merely by the relay
curl -s -X PUT "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":{"version":1,"jobs":[{"agent":"Watchkeeper","at":"7:00"}]}}' | jq -c
# expect 400 VALIDATION_ERROR

# 7. An extra top-level key must fail loudly
curl -s -X PUT "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"value":{},"rev":3}' | jq -c
# expect 400, details.allowed == ["value"]

# 8. A bad key shape is rejected before storage is touched
curl -s "$BASE/hub/relay/Bad%20Key" -H "Authorization: Bearer $TOKEN" | jq -c
# expect 400, details.field == "key"

# 9. DELETE -> 204 with no body; a second DELETE -> 404
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE \
  "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN"

# 10. A device-scoped or MCP-scoped credential must get 403 SCOPE_DENIED
```

### 9.2 Acceptance checklist

- [ ] `PUT` of the example in §6.1 returns `200`, and `GET` returns the identical `value`.
- [ ] `GET` before any write returns `404 NOT_FOUND` with `details.key = "agent-cron"`.
- [ ] `hub_state.rev` is identical before and after a `PUT`.
- [ ] `at: "7:00"` is refused with `400`.
- [ ] A top-level sibling of `value` is refused with `400` and `details.allowed = ["value"]`.
- [ ] A row exists in `app_setting` with `key = 'relay:agent-cron'` and the JSON in `value`.
- [ ] `GET /hub` does not include the key.
- [ ] The MCP tool list is unchanged.
- [ ] The relay's credential can read and write `agent-cron` (after §5).

---

## 10. What the relay does once this is allowed (no relay change needed)

`SCHEDULE_HUB_PATH = '/relay/agent-cron'` is already the relay's target.

* **Boot:** `GET /hub/relay/agent-cron`.
  * `200` → adopt it as the running schedule (`source: hub`).
  * `404` → fall back to the local file and **push it up**, so a hand-written schedule is not lost on the first deploy after this lands.
  * `403` → fall back to the file and surface the reason on the settings page rather than claiming a save.
* **Save (wearer edits in the UI):** `PUT` the whole document; the page reports *"stored on the hub, survives deploys"* **only** if the `PUT` returned `200`. Otherwise it reports where the schedule actually lives and why.
* **Ticks:** no hub traffic at all.

---

## 11. Failure modes and what the wearer sees

| Situation | Behaviour |
|---|---|
| Hub down at relay boot | Relay runs from its local file; logs `[cron] idle — …`; retries on next boot. No user-visible failure. |
| Hub refuses with `403` | Runs from the local file; the page prints the exact reason and the fix. |
| Relay redeployed at 07:00 | Schedule reloads from the hub; a job still inside the 20-minute grace fires late, otherwise it is skipped. No replay burst. |
| Agent deleted but still scheduled | The slot is spent once with `errors[slot] = "no such agent"`; the page shows the error against that job. It does not retry for 20 minutes. |
| Clock fires twice (restart mid-tick) | The slot key (`YYYY-MM-DD HH:MM`) prevents a second run. |
| Two relay instances | **Not supported** — both would tick. Keep one instance, or implement the claim in §12.2 first. |

---

## 12. Phase 2 — optional, only if the hub should do more than store

1. **Watchdog.** If `agent-cron-state.updatedAt` is older than 24 h, the hub raises "the relay has stopped ticking". One scheduled query; catches a dead Railway with no user report.
2. **Atomic claim.** `POST /hub/relay/agent-cron/claim {slot}` → `409` if the slot is already claimed. Only needed if the relay is ever scaled beyond one instance.
3. **Server-side trigger (Option B).** A hub cron `POST`s the relay's `/api/agent/schedule/run` with an `Idempotency-Key` per slot. Worth doing only if the relay stops being always-on; it needs inbound auth to Railway and a retry policy, which is why it is not the starting point.

---

## Appendix — the relay's HTTP surface (context, nothing to build)

For anyone tracing a run end to end. All of these are on the relay, owner-authenticated, and unrelated to the backend work:

| Route | Purpose |
|---|---|
| `GET /api/agent/schedule` | The schedule plus each job's next firing, last run, last error |
| `PUT /api/agent/schedule` | Replace the whole schedule (validated; refused whole or accepted whole) |
| `POST /api/agent/schedule/run` | Fire one agent now, using its own saved prompt — used to test a job without waiting for 07:00 |
