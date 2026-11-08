# Metrics store — backend specification

**Self-contained.** Everything needed to implement and verify it is in this file.

| | |
|---|---|
| **Purpose** | Give collected numbers (and their schema) a durable, queryable home, so a dashboard survives a deploy and can be read by range instead of in full. |
| **What the backend must build** | Two tables and five routes. No existing table changes. |
| **Why it cannot use `/hub/relay/{key}`** | That family is a single opaque JSON value per key: whole-value replace, 128 KiB cap, no query, no index. Sample history is append-only, grows without bound, and is read by `(series, from, to)`. It is the wrong shape, not the wrong permission. |
| **Who writes** | The relay's clock (`kind: 'fetch'` collector jobs) and, later, agents through `metric.write`. |
| **Who reads** | The relay (dashboard), the glasses (one number at a time), agents (their own history). |
| **Relay identity** | The same API key already minted for relay state (`g2-relay`, `content:read`, `content:write`). Add the two namespaces to the same allow-list mechanism (`HUB_RELAY_WRITERS` or its successor). |
| **Status** | **IMPLEMENTED AND LIVE** (commit `eb2cd82`, schema v2; extended 2026-11-09). The relay talks to it when `METRICS_API` is set; verified end to end by `scripts/probe-metrics-remote-e2e.mjs` (**22/22**) including a real HTTPS collector whose reading landed in the hub, a purging delete, and a 426-char provenance URL surviving the round trip. The second changeset added `DELETE /samples`, `GET /series/{key}`, `kind: 'metrics'` on `/hub/tools` and a 500-char `source` — so §7's three gaps are now closed and kept only as history. |

---

## 0. Data model

Two tables. Both scoped by `user_id`, like every other hub table.

```sql
create table metric_series (
  id          bigserial primary key,
  user_id     uuid not null,
  key         text not null,              -- 'sgx.dbs.price'
  label       text not null,
  type        text not null check (type in ('number','string')),
  unit        text not null default '',
  precision   int  not null default 2 check (precision between 0 and 6),
  cadence     text not null default '',
  source      text not null default '',
  retention   int  not null default 2000 check (retention between 2 and 20000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, key),
  check (key ~ '^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){1,5}$')
);

create table metric_sample (
  id          bigserial primary key,
  user_id     uuid not null,
  series      text not null,
  ts          timestamptz not null,
  slot        text,                        -- '2026-11-09 09:00' in the wearer's zone
  value_num   double precision,            -- exactly one of these two is set
  value_text  text,
  source      text not null default '',
  run_id      text not null default '',
  created_at  timestamptz not null default now(),
  foreign key (user_id, series) references metric_series(user_id, key) on delete restrict,
  check ((value_num is null) <> (value_text is null))
);

-- The index every read uses.
create index metric_sample_series_ts on metric_sample (user_id, series, ts);

-- IDEMPOTENCY. A collector that fires twice inside the grace window must
-- overwrite its own reading, never plot a second point at the same minute.
create unique index metric_sample_slot on metric_sample (user_id, series, slot)
  where slot is not null;
```

**Why `slot` and `ts` are both stored:** `slot` is the *scheduled* minute (the identity), `ts` is when it actually landed (the fact). A late run has a slot of 09:00 and a `ts` of 09:14; storing only one of them either loses punctuality or loses deduplication.

**Why `retention` is on the series:** it is the only knob that keeps a personal deployment bounded. Trim after insert:

```sql
delete from metric_sample s
 where s.user_id = $1 and s.series = $2
   and s.id not in (select id from metric_sample
                     where user_id = $1 and series = $2
                     order by ts desc limit $3);
```

---

## 1. Routes

All are owner-scoped in the same sense as the rest of the hub, but the relay's allow-listed API key must be accepted. Errors use the standard envelope `{ok:false, error, code, details}`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/hub/metrics/series` | Declarations + the latest reading each, for the dashboard |
| `POST` | `/hub/metrics/series` | Declare or refine a series (additive only — §3) |
| `DELETE` | `/hub/metrics/series/{key}` | Remove a declaration. `409` while samples exist (§3) |
| `POST` | `/hub/metrics/samples` | Append samples (bulk, idempotent by slot) |
| `GET` | `/hub/metrics/samples?series=&from=&to=&limit=` | Read a range, oldest first |

### 1.1 `POST /hub/metrics/series`

```json
{ "key": "sgx.dbs.price", "label": "DBS", "unit": "SGD", "type": "number", "precision": 2, "retention": 2000 }
```

* `200` with the stored declaration (upsert on `(user_id, key)`).
* A declaration that already exists may change `label`, `precision`, `cadence`, `source`, `retention` — **display** properties.
* It may **not** change `type` or `unit`. That is `409 SERIES_SHAPE_LOCKED` with `details.current` — see §3.
* Bad key → `400 VALIDATION_ERROR`, `details.field = "key"`, `details.expected` naming the regex.
* **Never auto-create a series from a sample write.** That rule is the reason cardinality cannot explode; it must live on the server, not only in the relay.

### 1.2 `POST /hub/metrics/samples`

```json
{ "samples": [ { "series": "sgx.dbs.price", "value": 36.4, "slot": "2026-11-09 10:00", "source": "https://…", "runId": "" } ] }
```

`200`:

```json
{ "ok": true, "accepted": [ … ], "rejected": [ { "series": "sgx.dbs.price", "error": "value \"n/a\" is not a number" } ] }
```

Rules:

* **Per-item results, always.** A batch of ten with one bad value is `200` with one entry in `rejected`. Never a whole-batch failure, and never a silent drop — the caller must be able to say "9 of 10 stored, and why the tenth was not".
* Unknown `series` → that item is rejected with `"unknown series"`. Not created.
* `value` for a `number` series: a finite JSON number, or a string that parses to one after stripping thousands separators. **Blank, `null`, `"n/a"`, `NaN` and `Infinity` are rejected** — a coercion to `0` would plot a fake reading.
* `value` for a `string` series: stored in `value_text` as given (≤ 500 chars).
* `ts` absent → server `now()`. `ts` given → must be within ±365 days, else `400`.
* `slot`, when present, must match `^[A-Za-z0-9:._-]{1,32}$` — **a space is refused**. The relay's own slot format is `YYYY-MM-DD HH:MM`, so it crosses the wire as `YYYY-MM-DDTHH:MM` and is translated back by the adapter (`metrics-remote.mjs`).
* `source`, when present, is **at most 500 characters** (widened 2026-11-09; it was 32, which cost every reading the middle of its URL). The relay sends the URL whole and only shortens it past that limit, because an oversized value takes the whole reading down with `samples[0].source must be at most 500 characters`. See §7.2 for the measurement.
* No `slot` → plain append (a point in time, not a scheduled reading).
* Duplicate `slot` → **UPDATE** the existing row (`value`, `ts`, `source`, `run_id`), and report it in `accepted` with `replaced: true`.
* Request body cap: 256 KiB, `413 TOO_LARGE` above it.
* Trim by `retention` in the same transaction, so the table cannot be made to grow by inserting.

### 1.3 `GET /hub/metrics/samples`

Query: `series` (required, may repeat up to 6), `from` / `to` (epoch ms or ISO, optional), `limit` (default 500, max 2000).

`200`:

```json
{ "ok": true, "series": { "sgx.dbs.price": [ { "ts": 1791046286329, "value": 36.4, "slot": "2026-11-09 10:00" } ] }, "truncated": false }
```

* Oldest first, because that is the order every chart draws in.
* `truncated: true` when `limit` cut the range — the client can then ask for a narrower window instead of silently plotting a different series.
* Downsample **is not** the backend's job in v1: it needs a policy (mean? last?) and a chart that says which. The relay asks for the last N points.

### 1.4 `GET /hub/metrics/series`

`200`:

```json
{
  "ok": true,
  "series": [
    { "key": "sgx.dbs.price", "label": "DBS", "unit": "SGD", "type": "number", "precision": 2,
      "retention": 2000, "count": 42,
      "latest": { "ts": 1791046286329, "value": 36.4, "slot": "2026-11-09 10:00" },
      "previous": { "ts": 1791042686329, "value": 36.1 } }
  ]
}
```

`latest` and `previous` are what the card renders; without `previous` the delta cannot be computed without a second round trip.

---

## 2. Non-functional requirements

1. **`hub_state.rev` must not move.** Samples are not a synced collection and must not invalidate every client's cached todo/document mirrors once a minute. Do not add them to `GET /hub`, `/hub/sync/*`, or `/hub/diag/schema`.
2. **Rate scope `default`.** A collector fires at most once a minute (12/day today), so this cannot be a meaningful share of the budget.
3. **Idempotency.** `POST /samples` with `Idempotency-Key` honoured; the unique slot index is the real guarantee.
4. **Time.** All `ts` values are epoch milliseconds in the API (matching every other hub timestamp), `timestamptz` in storage.
5. **Never a 500 for bad input.** Out-of-range numbers (`1e400` → non-finite), wrong types and unknown series are `400`/per-item rejections.
6. **Retention is enforced by the backend**, not by the caller. A caller that stops trimming must not be able to fill the database.

---

## 3. The two rules worth arguing over

**Additive schema only.** Changing a series' `unit` or `type` is refused (`409 SERIES_SHAPE_LOCKED`), because every chart already drawn assumed the old one. A genuine change means a new key (`sgx.dbs.price.v2`), which keeps history honest and costs nothing. Renaming a label is a display change and is allowed.

**Declare before write.** No route creates a series implicitly. A prompt that says "track every ticker I mention" must produce N explicit declarations, which is a decision someone can see — not N silent new series.

---

## 4. Verification

```bash
BASE=http://167.172.77.136
KEY=$(cat /root/jarvis-content-relay-key.txt)   # the g2-relay key
H="Authorization: Bearer $KEY"

# 1. Declare
curl -s -X POST "$BASE/hub/metrics/series" -H "$H" -H 'Content-Type: application/json' \
  -d '{"key":"sgx.dbs.price","label":"DBS","unit":"SGD","type":"number","precision":2}' | jq -c
# expect 200 + the stored declaration

# 2. Shape is locked
curl -s -X POST "$BASE/hub/metrics/series" -H "$H" -H 'Content-Type: application/json' \
  -d '{"key":"sgx.dbs.price","type":"number","unit":"USD"}' | jq -c
# expect 409 SERIES_SHAPE_LOCKED, details.current.unit == "SGD"

# 3. Append, with one bad value
curl -s -X POST "$BASE/hub/metrics/samples" -H "$H" -H 'Content-Type: application/json' \
  -d '{"samples":[
        {"series":"sgx.dbs.price","value":"36.10","slot":"2026-11-09 09:00"},
        {"series":"sgx.dbs.price","value":"n/a","slot":"2026-11-09 10:00"},
        {"series":"nope.nothing","value":1}]}' | jq -c
# expect accepted:1, rejected:2 — and NOT a 400 for the whole batch

# 4. Same slot again replaces
curl -s -X POST "$BASE/hub/metrics/samples" -H "$H" -H 'Content-Type: application/json' \
  -d '{"samples":[{"series":"sgx.dbs.price","value":37.2,"slot":"2026-11-09 09:00"}]}' | jq -c
# expect accepted[0].replaced == true

# 5. Count is still 1
curl -s "$BASE/hub/metrics/samples?series=sgx.dbs.price" -H "$H" | jq '.series["sgx.dbs.price"] | length'
# expect 1

# 6. rev did not move
curl -s "$BASE/hub" -H "$H" | jq .rev

# 7. A device-scoped credential is refused
# expect 403 SCOPE_DENIED
```

Acceptance checklist:

- [ ] Declaring twice with the same shape is `200` and does not duplicate the row.
- [ ] Declaring a different `unit`/`type` is `409` and changes nothing.
- [ ] `value: null`, `""`, `"n/a"`, `NaN` are each rejected **per item**, never stored as `0`.
- [ ] Two samples with the same `slot` leave exactly one row, holding the newer value.
- [ ] An unknown `series` is rejected, and no row appears in `metric_series`.
- [ ] `limit` is honoured and `truncated` is reported.
- [ ] `hub_state.rev` is unchanged after a burst of inserts.
- [ ] `GET /hub` does not include metrics.
- [ ] Retention trims the oldest rows after insert.

---

## 5. How the relay will use it

The relay already speaks this shape; only the transport changes.

* **`METRICS_API` unset (today):** samples are stored in `$G2_DATA_DIR/.g2-metrics.json`, series declarations ride `/hub/relay/agent-cron`. The Data tab says *"readings survive a restart, not a deploy"* — no hopeful silence.
* **`METRICS_API` set to `$BASE/hub/metrics`:** the same calls go to these routes with `Authorization: Bearer $JARVIS_FILE_API_KEY`. This is the mode production must run in — the local file survives a restart, not a deploy.

Two things only exist on the hub path and are worth knowing when reading the code: deleting a series needs `?purge=1` to also remove its readings (see §7.4), and a single declaration can be fetched directly (`GET /hub/metrics/series/{key}` → `404` when it is gone) instead of being pattern-matched out of a list.

A collector job is a cron entry and needs no backend support:

```json
{ "kind": "fetch", "series": "sgx.dbs.price", "at": "09:00", "days": [1,2,3,4,5],
  "select": "data.last",
  "request": { "url": "https://api.example.com/quote", "method": "GET",
               "headers": "{\"X-Api-Key\": \"env:QUOTE_KEY\"}",
               "bodyTemplate": "{\"symbol\": \"D05\"}" } }
```

`env:NAME` in a header is resolved **from the relay's environment**, so a credential never enters the schedule document that is mirrored to the hub.

---

## 7. Live-only constraints and one gap

Found by probing the deployed service after it shipped; recorded because each one is invisible until a write fails.

1. **A slot may not contain a space** (`[A-Za-z0-9:._-]{1,32}`). The relay's canonical slot is `YYYY-MM-DD HH:MM`, so the adapter translates to `T` on the way out and back on the way in. One place, tested.
2. **`source` used to be capped at 32 characters.** Provenance showed `host + path`, truncated, so a deep URL lost the part that identifies it. **FIXED 2026-11-09 — the column now takes 500**, measured by sending 200/500/1000/2000: 500 stored verbatim, 1000 refused as `samples[0].source must be at most 500 characters`. One consequence was on the relay's side and is fixed with it: `normaliseSample` kept clipping at **300**, so the stored source was being shortened before it ever reached the hub. `SOURCE_MAX` now lives once, in `metrics.mjs`, and the transport imports it — with a harness check that the whole URL survives.
3. **A batch where nothing was accepted answers `400`**, not `200` with all items rejected. The adapter treats it as per-item outcomes, which is what it means; a caller that treats it as a transport error will retry a permanently invalid payload.
4. **GAP (CLOSED 2026-11-09) — samples could not be deleted, so a series with readings could never be removed.** `DELETE /hub/metrics/series/{key}` answers `409 SERIES_NOT_EMPTY` with `details.count`, and there was no route to delete samples. The backend added both routes, and probing them fixed the behaviour in detail:

```
DELETE /hub/metrics/samples?series={key}[&before={ts}]  → 200 {ok, series, before, deleted: n}
GET    /hub/metrics/series/{key}                         → 200 {ok, item} / 404 NOT_FOUND
```

* `series` is **mandatory** — a call without it is refused `VALIDATION_ERROR`, which is the difference between a delete and a wipe.
* Idempotent: a second call answers `deleted: 0`, so a retry after a timeout cannot report a failure someone would act on.
* `before` filters on **`ts`**, not on `slot` — a sample written without `ts` gets the server's clock, so it is never older than a cutoff just because its slot says so.

The relay now deletes in the only order that works — readings first, then the declaration — and only when asked: `DELETE /api/metrics/series/{key}?purge=1`. Without `purge` it answers `409` with the count, and the Data tab turns that into a second, narrower question ("delete those N readings as well?"). Destroying history has to be an answer the wearer gave, not a side effect of pressing delete.

5. **GAP (CLOSED 2026-11-09) — the tool catalogue's `kind` enum was closed, so `jarvis_metrics` could not be attached to an agent.** `POST /hub/tools` refused `kind: "metrics"` with `400 INVALID_ENUM` against a list of nine, and a run resolves an agent's toolset as `roster.tools.filter(t => agent.toolIds.includes(t.id))` — against the hub catalogue and nothing else — so no agent could hold a tool the catalogue would not store. The backend added `metrics` to that enum, and the tool is now live:

```
metrics   58df5769-2255-4fd4-8b01-c854f026a12b   jarvis_metrics
```

`scripts/agent-metrics-tool.mjs --apply` created the row and attached it to eight agents, then verified by **re-reading the roster** rather than trusting the writes: writers SG Banks Desk, AI Equities Desk, Singapore Weather, AI Model Tracker, Fleet Auditor; readers Watchkeeper, Brief Composer, Daily Run Orchestrator. Each also got a guidance block, because an attached tool with no instruction is one the model has no reason to reach for — and the block states the two rules that matter (use the keys `list` returns, never invent one; if nothing is declared, say so instead of guessing).

Jarvis himself did not have to wait for any of this: `metrics.act` reaches the same relay runner over `POST /api/tool`, which is why the wearer could already ask "what is DBS at" before the enum moved.

---

## 8. Phase 2 (only if the numbers are actually used)

1. **`metric.write` as an agent tool**, so an LLM can store a reading it computed. It must go through the same validation — a model must never be able to widen a series' shape.

   **BUILT AND LIVE.** `web/server/metrics-tool.mjs` offers `list | read | write` and deliberately no `declare`; writes are validated by the store and its refusals are passed through verbatim, so a model cannot be told one thing by the tool and another by the endpoint; reads are bounded at 240 points and say when they were truncated. The schema is offered to a run by `toolSchemaFor` and executed by `runTool`, which is the same pair every other built-in uses — no second dispatcher. Attached to eight agents via `scripts/agent-metrics-tool.mjs`, and Jarvis has it as `metrics.act`.
2. **Downsampling with a declared policy** (`mean`/`last`/`min`/`max` per series) once a chart has more points than pixels.
3. **Anomaly flags on the sample** (`{z: 3.1}`) written by the collector, so the dashboard can mark a spike without recomputing history in the browser.
4. **A `metric_alert` table** — "tell me when this crosses X". That is the first thing that turns a dashboard into something you act on, and it belongs here rather than in the cron document.
