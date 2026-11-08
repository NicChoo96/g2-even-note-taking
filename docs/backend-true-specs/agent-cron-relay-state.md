# Agent schedule — relay state contract (`/hub/relay/agent-cron`)

**Status:** relay side SHIPPED (0.3.66-era). Backend side: **one auth change needed**, plus this value contract.
**Audience:** the backend (Jarvis file server / `167.172.77.136`).
**Parent spec:** `relay-state-and-live-sync.md` §1 — this document does **not** invent a new route family. `GET|PUT|DELETE /hub/relay/{key}` already exists and already answers correctly; what is missing is that the relay's machine credential is refused by it.

---

## 0. The short version

| | |
|---|---|
| What is stored | One JSON object: the agent schedule (which agent runs at what time, in what timezone, on which weekdays). |
| Where | `PUT /hub/relay/agent-cron` — the generic relay-state key. No new endpoint. |
| Who writes | The relay only (Railway). The hub never writes it. |
| Who reads | The relay, once at boot and every tick while it holds no fresh copy. |
| Secret content | **None.** Agent names, `HH:MM`, weekday numbers. Worth knowing when you decide the scope rule (see §2). |
| Biggest size | ~8 KiB in practice; the family cap is 128 KiB and is not a concern here. |
| Blocking issue today | `GET /hub/relay/agent-cron` → **403 `SCOPE_DENIED`** with the relay's current login. |

---

## 1. Where the trigger fires (and why not on the hub)

This matters to the endpoint design, so it is stated explicitly.

**The run engine lives in the relay.** An agent run needs: the agent's saved prompt and `toolIds` (from the hub), the LLM call with the OpenRouter/DeepSeek key, the web-search tool, the document-store tool, and the run recorder. All of that is `web/server/*` on the Railway process. The hub stores agents and state; it does not execute them.

So there are exactly three places a trigger could live:

| Option | How it works | Verdict |
|---|---|---|
| **A. Hub triggers the run** | Hub's own cron calls the LLM and tools itself | **No.** Duplicates the entire run engine, splits billing, and needs every provider key on the hub. |
| **B. Hub pushes a "run now" to the relay** | Hub cron `POST`s the relay at 07:00 | **Not now.** Requires inbound auth to Railway, retry policy, and an idempotency key; a relay that is redeploying at 07:00 either loses the run or double-fires it. |
| **C. Relay owns the clock, hub holds the schedule** | Relay ticks every 60 s, reads the schedule, fires what is due | **Yes.** One process owns both the clock and the run, so there is no cross-service delivery problem. A relay restart resumes from the stored schedule with no coordination. |

**Recommendation: C.** The hub is the **store of record** (durable, backed up with the rest of the database); the relay is the **clock**. The hub's cron is then free to do one useful thing that the relay cannot: nothing at all — or optionally a watchdog that reports "the relay has not checked in for N minutes" (§10).

Trigger cost on the hub: **zero requests per run.** The relay reads the key **once at boot** and writes it **once per save** from the page; ticking is a local computation. (If you want the hub to be editable elsewhere as well, see §6 — the relay would then need a periodic re-read, which is a small change on our side.)

### How a run is actually triggered (relay side)

1. Boot: read the schedule (hub first, then the local file, then `G2_AGENT_CRON_JSON`).
2. `setInterval` every 60 s, `unref`'d, started after the port is open.
3. Each tick is pure: it computes the wearer's wall clock in `timeZone`, finds jobs whose `at` has arrived and are inside the **grace window (20 min)**, and ignores any whose exact slot (`YYYY-MM-DD HH:MM`) is already recorded.
4. Before firing, it reads the roster once and resolves the agent by name; an unknown agent spends the slot (a config fault must not retry 20 times).
5. Fires `startAgentRun` with the agent's **own** saved prompt and tools. The slot is then recorded in `.g2-agent-cron-state.json`.
6. Caps: 2 runs per tick, 12 per day. `G2_AGENT_CRON=0` on the relay disables the clock entirely.

Consequences worth having in writing: a missed window is **skipped, not replayed** (no burst of five runs after an outage); a run cannot double-fire (slot key); and nothing depends on the phone or glasses being awake.

---

## 2. What the hub has to change — the actual ask

`/hub/relay/{key}` is owner-scoped by design (§1.2 of the parent spec) because the `auth` key holds **live session tokens**. That rule is correct and should stay for `auth`.

The relay signs in with a **work credential** (`JARVIS_FILE_USER`, `/auth/login`), which is not an owner credential, so both keys currently get `403 SCOPE_DENIED` from the relay. `agent-cron` contains no secrets, so there are three ways to fix it; pick one.

**Option 1 (preferred) — a machine owner identity for the relay.**
Issue an owner-scoped credential for the relay process and pass it as `G2_HUB_OWNER_TOKEN` (or extend `JARVIS_FILE_USER`/`JARVIS_FILE_PWD` to be owner-scoped). This fixes **both** keys at once — including `relay/auth`, which has been silently failing to mirror sessions for the same reason, so the session store currently survives only on the relay's disk.

**Option 2 — narrow the scope rule for non-secret keys.**
Allow the relay's service account to read/write a documented allow-list of relay keys that contain no credentials (`agent-cron`, `agent-cron-state`, `relay-meta`) while continuing to refuse `auth`. This is a small, auditable exception; it is **not** a general widening.

**Option 3 — a dedicated route.**
`GET|PUT /hub/schedule` with the same value contract and service-account scope. More code, no benefit over Option 2, but it is the cleanest if the route family should stay strictly owner-only.

Required in all three cases:

- `PUT` is **upsert, whole-value**, returns **200** (never 201) with the same envelope as `GET`.
- `GET` returns `404 NOT_FOUND` + `details.key` when the key was never written. **Absence is normal** — it is how the relay knows it is the first writer.
- **`rev` must not move** (§1.6 of the parent spec). This is not a synced collection.
- Not exposed to MCP, not part of `GET /hub`, not part of `/hub/sync/*`, not in `/hub/diag/schema`.
- Rate scope `default`; the relay's traffic is a handful of requests per day.

---

## 3. The value contract

### 3.1 Key `agent-cron`

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
| `version` | integer | no (defaults 1) | Must equal `1`. A higher version is **refused**, not ignored. |
| `enabled` | boolean | no (defaults `true`) | The master switch. `false` = keep the jobs, run none. |
| `timeZone` | string | no (defaults `Asia/Singapore`) | Any IANA name. An unknown name falls back to the default **and the relay logs it**. |
| `graceMinutes` | integer | no (defaults 20) | Clamped to `0…180`. |
| `jobs` | array | yes (may be empty) | Order is irrelevant. |
| `jobs[].agent` | string | **yes** | The agent's **name** as it appears on the hub (case-insensitive match at run time). An id is also accepted. A name that does not exist is a runtime refusal, not a validation error — the hub cannot know. |
| `jobs[].at` | string | **yes** | `HH:MM`, 24-hour, **zero-padded**, on the wearer's clock in `timeZone`. `"7:00"` and `"24:00"` are invalid. |
| `jobs[].days` | number[] | no | `0`=Sunday … `6`=Saturday. Omitted/null/`[]` means **every day**. A list that contains no valid weekday is **refused** — never silently made daily. |
| `jobs[].ask` | string | no | Extra instruction layered on the agent's own saved prompt. Never replaces it. Max 500 chars. |
| `jobs[].enabled` | boolean | no (defaults `true`) | Per-job pause. |

An empty `jobs` array with `enabled: true` is valid and means "clock on, nothing scheduled".

### 3.2 Key `agent-cron-state` (optional, Phase 2)

Written by the relay after each tick that fires something, so the hub holds the audit trail:

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

Pure observability: the relay does not need it to function, and losing it costs at most one duplicate run inside a grace window. Skip it if it complicates the scope decision.

---

## 4. Endpoint behaviour

Pinned to the parent spec; repeated here so this document stands alone.

| Method | Path | Success | Notes |
|---|---|---|---|
| `GET` | `/hub/relay/agent-cron` | `200` | `{ok, rev, key, value, updatedAt}`. `value` byte-identical after a JSON round trip. |
| `GET` | `/hub/relay/agent-cron` (never written) | `404` | `NOT_FOUND`, `details.key = "agent-cron"`. Normal, not an error. |
| `PUT` | `/hub/relay/agent-cron` | `200` | Body `{"value": {...}}`. Upsert. Response identical in shape to `GET`, echoing the stored value. |
| `DELETE` | `/hub/relay/agent-cron` | `204` | No body. `404` when absent; the relay treats that as success. |

Error table:

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Missing `value`; `value` not an object; **any top-level key other than `value`** (`details.allowed = ["value"]`) — extras must fail loudly. |
| `403` | `SCOPE_DENIED` | Credential is not permitted for this key (today's answer). |
| `413` | `TOO_LARGE` | Serialised `value` > 131072 bytes (`details.limit`). |
| `404` | `NOT_FOUND` | `GET`/`DELETE` on a key never written. |

---

## 5. Server-side validation (please enforce it, not just the relay)

The relay validates before every write, but the hub is the store of record and must not accept a document a future client would misread:

1. `version === 1` — otherwise `400` (a future version must be refused, not best-efforted).
2. `jobs` is an array; every `jobs[].agent` is a non-empty string; every `jobs[].at` matches `^([01]\d|2[0-3]):[0-5]\d$`.
3. `jobs[].days`, when present and non-null, must be a non-empty array of integers `0…6`. An array naming no valid weekday → `400`.
4. `timeZone` must resolve via `Intl.DateTimeFormat` — reject an unresolvable zone rather than storing it.
5. `graceMinutes`, when present, is an integer `0…180`.

Keep these rules **in the hub as well as the relay**. Two validators that disagree is how a schedule saves successfully and then never runs.

---

## 6. Concurrency

- **Whole-value replace, last writer wins.** There is one editor (the relay), and every write carries the complete document, so no merge is needed.
- `rev` is **not** required on `PUT`, and `PUT` must **not** advance `hub_state.rev`.
- `If-Match` is **not** used for this key. (It is used for `PUT /docs/{id}`, which is a different collection.)
- `Idempotency-Key` is accepted but not sent by the relay; a whole-value `PUT` is naturally idempotent.
- If you ever allow a second editor (a web page writing the key directly), tell us first: the relay's rule is "adopt the hub copy only when its `updatedAt` is newer than the last value we wrote", and that rule needs revisiting with two writers.

---

## 7. Test vectors

```bash
BASE=http://167.172.77.136
TOKEN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"<user>","password":"<pass>"}' | jq -r .access_token)

# 1. Never written -> 404, and that is correct
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/hub/relay/agent-cron" \
  -H "Authorization: Bearer $TOKEN"        # expect 404 (or 403 until §2 lands)

# 2. Create
curl -s -X PUT "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":{"version":1,"enabled":true,"timeZone":"Asia/Singapore","graceMinutes":20,
       "jobs":[{"agent":"Watchkeeper","at":"07:00"}]}}' | jq -c
# expect 200, ok:true, value echoed, updatedAt = epoch ms

# 3. Read back — byte-identical value
curl -s "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" | jq -c .value

# 4. Replace (same key, one job -> two) -> 200, still one row
# 5. A bad time -> the HUB refuses, if §5 is enforced
curl -s -X PUT "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":{"version":1,"jobs":[{"agent":"Watchkeeper","at":"7:00"}]}}' | jq -c
# expect 400 VALIDATION_ERROR (relay refuses this too, but the hub must not store it)

# 6. rev must not move
curl -s "$BASE/hub" -H "Authorization: Bearer $TOKEN" | jq .rev   # before
curl -s -X PUT "$BASE/hub/relay/agent-cron" ...                   # the write
curl -s "$BASE/hub" -H "Authorization: Bearer $TOKEN" | jq .rev   # after: identical

# 7. Extra top-level key is a loud failure
curl -s -X PUT "$BASE/hub/relay/agent-cron" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"value":{},"rev":3}' | jq -c
# expect 400, details.allowed == ["value"]
```

---

## 8. What happens on the relay once §2 lands

No code change is needed on our side — `SCHEDULE_HUB_PATH = '/relay/agent-cron'` is already the target.

- Boot: `GET` the key. `200` → adopt it (`source: hub`). `404` → fall back to the local file, and **push it up** so a hand-written schedule is not lost on the first deploy after the change. `403` → fall back to the file and **say so** on the settings page ("the gateway refuses this credential…"), which is today's behaviour.
- Every save from the UI: `PUT` the whole value, and the page reports `durable: true` only if the hub returned `200`.
- The schedule then survives a deploy with **no Railway volume required**, alongside sessions.

Until §2 lands, the schedule lives in the relay's file and survives a restart but not a deploy (unless the host mounts a volume and sets `G2_DATA_DIR`).

---

## 9. Failure modes and what the wearer sees

| Situation | Behaviour |
|---|---|
| Hub down at boot | Relay runs from its file, logs `[cron] idle — …`, retries on the next boot. No user-visible failure. |
| Hub refuses (403) | Runs from the file; the page prints the exact reason and the fix. |
| Relay redeployed at 07:00 | Schedule reloads from the hub; a job still inside the 20-minute grace fires late, otherwise it is skipped. No replay burst. |
| Agent deleted but still scheduled | Slot is spent with `errors[slot] = "no such agent"`; the page shows the error against that job. Does not retry for 20 minutes. |
| Clock fires twice (restart mid-tick) | The slot key prevents a second run for the same `YYYY-MM-DD HH:MM`. |
| Two relay instances | Not supported. Both would tick. One instance, or the claim in §10. |

---

## 10. Phase 2 (only if you want the hub to be more than storage)

1. **Watchdog.** If `agent-cron-state.updatedAt` is older than 24 h, the hub emails/flags "the relay has stopped ticking". Costs one scheduled query; catches a dead Railway with no user report.
2. **Atomic claim.** `POST /hub/relay/agent-cron/claim {slot}` returning `409` if the slot is already claimed, so two relays can never double-run. Only needed if the relay is ever scaled beyond one instance.
3. **Server-side trigger (Option B).** A hub cron `POST`s the relay's `/api/agent/schedule/run` with an `Idempotency-Key` per slot. Worth doing only if the relay stops being always-on.
