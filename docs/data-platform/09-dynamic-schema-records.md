# 09 — Dynamic-schema records (schema stored as data)

**Status:** DELIVERED — hub `a746c01` (migration 4 live), client side in 0.3.79
**Owner:** backend (hub) + relay + AI tool surface · **Supersedes:** the "fixed-column `metric_table`" idea

> **What shipped, in one paragraph.** The hub gained `metric_object` / `metric_record`,
> nine routes under `/hub/records`, and a repository behind `ctx.records`; the series tables
> were not touched. This client then gained the other half: a relay mirror (`/api/records...`),
> five more `jarvis_metrics` actions, the record verbs folded into the three existing data
> capabilities, and a real table view in the Data tab. §8 and §11 below were **corrected after
> delivery** — the two entries this document originally asked for cannot exist without evicting
> a page's own actions, and migration 4 applies lazily rather than on boot.

---

## 1. The ask

> "Make these objects always ambiguous: a database that stores the schema itself, the AI
> constructs the schema on the fly, and the data simply passes through the schema to become a
> table. No static traditional table where the flat type must be in the header. Schema built on
> the fly, indexed, linking all the data and schema together."

Today's store cannot hold a row. A "row" for the BTO data is
`date | flat type | project | estate | price` — five facts about one launch. The store holds
five separate answers and *hopes* they line up on the slot.

This document specifies a second, general store beside the time-series one: **records**, where
the schema is itself a row in a table, so the schema can be created and widened at runtime by
the assistant, and each record is validated against it.

---

## 2. Why not a fixed-column table

The obvious design is `metric_table` with `columns` declared once and `ALTER TABLE`/`ADD COLUMN`
to widen it. Rejected for three reasons:

| fixed columns | dynamic schema (this spec) |
|---|---|
| adding a column is a schema migration on a live SQLite with no git | adding a column is a row update |
| every object needs its own DDL path, permissions, rollback | one code path, one table pair |
| the AI must know the column list before it can write | the AI writes a row; the field appears |
| empty columns for every object that lacks them | a field exists only where it is used |

The cost of dynamic schema is a soft failure mode — a typo becomes a new field instead of an
error. §5.3 pins how that is contained, and it is the main thing to review here.

---

## 3. Verified current state (measured, not remembered)

Facts this design is built on. All were confirmed against the live hub on 2026-11-10.

- Hub service: `/opt/jarvis-content-serve`, package `jarviscs`, systemd unit
  `jarvis-content.service` (`User=jarvis`), SQLite **3.45.1** → JSON1 (`json_extract`,
  `json_each`) is available. There is no git repo on the droplet.
- `jarviscs/hub/schema.py` holds `MIGRATIONS: tuple[Migration, ...]`, currently
  **version 1..3**, applied in order inside one `BEGIN IMMEDIATE`. `latest_version()` reads it.
- Routers are mounted in `jarviscs/hub/routes/__init__.py::build_hub_router()` via
  `for child in (hub, todo, docs, notes, …, notfound)`; **`notfound` must stay last** (it is the
  catch-all).
- Repositories are exposed on the request context by
  `jarviscs/hub/service/context.py` as `ctx.metrics` (`_get("metrics", MetricsRepository)`).
- The metrics rules live in `jarviscs/hub/metrics.py` (pure validation) and
  `jarviscs/hub/repository/metrics.py` (SQL); routes use `envelope`, `rev_of`, `hub_context`,
  `hub_metrics_access` from `routes/deps.py`.
- **A reading is one value at one time**: `metric_sample(user_id, series, ts, slot, value_num,
  value_text, source, run_id)` with a partial unique index on `(user_id, series, slot)` where
  slot is not null. `type` and `unit` are locked at declaration (`409 SERIES_SHAPE_LOCKED`).
- A second field on a reading is **refused** as of 0.3.76 (before that it was silently dropped).
- Text series work (≤ 500 chars). An attribute is a sibling text series at the same slot, and
  `read` joins it by slot — a **convention the writer follows, not a constraint the store
  enforces**. That is the gap this spec closes.
- One reading can be corrected (rewrite the slot) or deleted (`DELETE /samples?slot=`) since
  0.3.78.

---

## 4. Design: two tables, the schema is data

### 4.1 Migration (version 4)

Add to `jarviscs/hub/schema.py`:

```python
def _metric_objects_sql() -> str:
    return f"""
CREATE TABLE metric_object (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,
  strict     INTEGER NOT NULL DEFAULT 0,
  fields     TEXT NOT NULL DEFAULT '[]',   -- JSON: [{key,label,type,unit?,precision?}]
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, key),
  CHECK (length(key) BETWEEN 3 AND 200),
  CHECK (key GLOB '*[.]*'),
  CHECK (key NOT GLOB '*[^a-z0-9._-]*'),
  CHECK (json_valid(fields))
);

CREATE TABLE metric_record (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL,
  object     TEXT NOT NULL,
  rec_key    TEXT NOT NULL,   -- the row's identity: a date, a launch id, anything ≤64 chars
  body       TEXT NOT NULL,   -- JSON object, validated against metric_object.fields
  ts         INTEGER,         -- optional ordering time, derived (§5.4)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, object, rec_key),
  CHECK (json_valid(body))
);

CREATE INDEX metric_record_object_ts ON metric_record (user_id, object, ts);
"""

MIGRATIONS = (
    ...,
    Migration(version=4, name="metric-objects", sql=_metric_objects_sql()),
)
```

Deliberate choices, each with a cost:

- **No foreign key from `metric_record` to `metric_object`.** `PRAGMA foreign_keys` is off on this
  connection (as with `metric_sample`), so a declared FK is documentation that does not hold. The
  refusal is enforced in `RecordsRepository` instead, like `MetricsRepository.delete`.
- **No revision trigger.** Same reason as the metrics tables: a record write must not move the
  owner's `rev` and wake every client's sync loop.
- **`body` is JSON, not columns.** That is the whole point: widening the schema is an UPDATE to
  `fields`, never DDL.
- **JSON validity is checked by SQLite (`json_valid`) as a backstop**; Python is authoritative for
  shape, types and value limits.

### 4.2 Field descriptor

```json
{ "key": "price", "label": "Price", "type": "number", "unit": "SGD", "precision": 2 }
{ "key": "project", "label": "Project", "type": "text" }
{ "key": "launch_date", "label": "Launch date", "type": "date" }
```

- `key` matches `^[a-z][a-z0-9_]{0,31}$` (no dots — the object key already carries the namespace).
- `type` ∈ `text | number | bool | date`, **fixed once the field exists** (same rule as a series'
  type, and for the same reason: changing it reinterprets every value already stored).
- `label`, `unit`, `precision` are mutable.
- Max **40 fields** per object, max **32 records** per object per write, body ≤ 8 KiB.

### 4.3 Key rules

- Object key: reuse `metrics.require_key` verbatim (`bto.launch`, `sgx.dps.intraday`). Same
  alphabet, same dot rule, so a client can treat series keys and object keys alike.
- `rec_key`: 1–64 chars of `[A-Za-z0-9:._ -]`, compared as a **string** and never normalised —
  `2023-10-15` and `2023-10-15T00:00` are two different rows.

---

## 5. Validation and inference (`jarviscs/hub/records.py`, pure)

### 5.1 Inference (the "schema on the fly" part)

For a field not yet in the object's schema, infer its type from the JSON value:

| JSON value | inferred type | notes |
|---|---|---|
| `123`, `12.5` | `number` | must be finite; `true`/`false` are `bool`, not numbers |
| `true`/`false` | `bool` | |
| string matching `^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2})?$` or full ISO-8601 | `date` | must parse (§5.4 refuses 31 Feb) |
| any other string | `text` | ≤ 500 chars |
| `null` | **no field created** | a null is "I have nothing for this", not a schema decision |
| array / object | **refused** | `400` naming the field: a nested value is a document, not a cell |

### 5.2 Type enforcement on known fields

Value is coerced/refused against the declared type, and the refusal names the field, the value and
the type — the pattern `metrics._coerce_value` already uses:

- `number` ← JSON number, or a numeric string with thousands separators (`"2,431.50"`). Non-finite
  refused. Blank is **not** zero.
- `text` ← string (numbers are stringified); ≤ 500 chars.
- `bool` ← JSON bool, or `"true"`/`"false"`.
- `date` ← ISO date/datetime string; stored normalised to `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`.

### 5.3 Writing a field the schema does not have

Two modes, per object:

- **soft (default, `strict = 0`)** — the field is inferred, appended to `fields`, and the write
  succeeds. The response **must** report what was added:
  `"addedFields": [{"key":"estate","label":"Estate","type":"text","inferred":true}]`.
  This is the mode that makes "AI creates the schema on the fly" work.
- **strict (`strict = 1`)** — `400 UNKNOWN_FIELD`, `details.allowed = [<field keys>]`.
  For an object whose shape a human cares about.

The soft mode's failure mode — a typo becomes a new field — is contained by three things, all
required:

1. **the receipt names every inferred field**, so a caller that did not expect one sees it;
2. `objectRead` returns the field list, so the tool can look before it writes;
3. the tool description tells the model to re-use a field it can see rather than invent a near
   duplicate, and the tool **warns in its answer** when a write added a field whose name is within
   edit-distance 2 of an existing one (`estate` vs `estates`), naming both.

### 5.4 The ordering time (`ts`)

Derived, never required from the caller:

1. the record's `values` contains a `date`-typed field → that instant (UTC);
2. else `rec_key` parses as a date (§6.1 of this doc — same rule as `metrics._slot_instant`) →
   that instant;
3. else `NULL`, and the record is unordered (it still reads back, sorted by `created_at`).

A record with no time is legal. That is what makes non-time-series rows possible at all — the
thing a series cannot do.

---

## 6. HTTP surface

Mounted by adding `records` to the `for child in (...)` tuple in `routes/__init__.py`, **before
`notfound`**. Access dependency: `hub_metrics_access` (owner, or a relay writer with
`content:write`) — the same rule as metrics, for the same reason.

| Method | Path | Body / query | Success | Notes |
|---|---|---|---|---|
| GET | `/hub/records/objects` | — | `200 {objects:[{key,label,strict,fields,count,latestTs}]}` | ordered by key, so a dotted key groups |
| POST | `/hub/records/objects` | `{key,label?,fields?,strict?}` | `201` created / `200` merged | merging only **adds** fields; a type change is `409 FIELD_SHAPE_LOCKED` |
| GET | `/hub/records/objects/{key}` | `?limit=50` | `200 {object, records:[{key,values,ts,updatedAt}]}` | the row-shaped read |
| PATCH | `/hub/records/objects/{key}` | `{label?,strict?,addFields?,dropFields?}` | `200 {object}` | `dropFields` also strips them from every body (`?purge=1` required) |
| DELETE | `/hub/records/objects/{key}` | `?purge=1` | `200 {deletedRecords}` / `409 OBJECT_NOT_EMPTY` | mirrors `DELETE /metrics/series` |
| GET | `/hub/records/objects/{key}/records` | `?limit=&offset=&sort=&where=&order=desc` | `200 {records,count}` | `sort`/`where` name a **field**, not a column (§7) |
| POST | `/hub/records/objects/{key}/records` | `{records:[{key,values,replace?}]}` | `200 {records:[{key,action}],addedFields}` | upsert by `rec_key`; `values` **merge** unless `replace:true` |
| PATCH | `/hub/records/objects/{key}/records/{rec}` | `{values}` | `200 {record,addedFields}` | surgical: one field, one row |
| DELETE | `/hub/records/objects/{key}/records/{rec}` | — | `200 {deleted:1}` / `404` | one row |

Conventions inherited from the metrics routes (do not invent new ones):

- `envelope(rev=rev_of(ctx), ...)` on every response; `rev` never moves.
- **Allow-list the body fields first** (`unknown field in the records body`, with `allowed`), so a
  typo is reported before a value is judged.
- Batches are **per-item**: one bad record does not sink the rest; the response reports
  `accepted` plus `rejected:[{index,field,error,code}]`.
- A destructive call reports a **count**, never `204`.

Error codes: `UNKNOWN_FIELD`, `FIELD_SHAPE_LOCKED`, `OBJECT_NOT_EMPTY`, `INVALID_VALUE`,
`BAD_FIELD_KEY`, `TOO_MANY_FIELDS`, `TOO_MANY_RECORDS`.

---

## 7. Reading by field (`sort` / `where`)

SQLite's JSON1 makes a field queryable without giving it a column:

```sql
SELECT rec_key, body, ts FROM metric_record
 WHERE user_id = ? AND object = ?
   AND json_extract(body, '$.flat_type') = ?
 ORDER BY json_extract(body, '$.price') DESC
 LIMIT ?
```

- `where` accepts `field=value` and `field>=value` / `field<=value` (numeric fields only for the
  ordered forms), one clause only in v1. Parsed in Python, **never interpolated**; the field name
  is validated against the schema first, so an unknown field is a `400`, not a scan.
- This is a table scan bounded by `limit` (≤ 500). For the wearer's scale (tens of objects, tens
  to hundreds of records) that is the right trade. If it ever matters, an **expression index** can
  be created per hot field — `CREATE INDEX … ON metric_record (user_id, object,
  json_extract(body,'$.price'))` — without changing the model. Do not add one speculatively.

---

## 8. AI tool surface

Extend `jarvis_metrics` (`web/server/metrics-tool.mjs`) rather than adding a tool kind: the hub's
`tool.kind` enum is closed (`web tavily http jev files todo docs notes location metrics`) and a new
kind would need a migration and a roster update before any agent could hold it.

New `action` values (flat, like the existing five):

| action | args | does |
|---|---|---|
| `objects` | — | list objects with field lists and counts |
| `object` | `series` (the object key), `limit` | read rows |
| `objectDeclare` | `series`, `label`, `fields` | create/extend an object |
| `recordWrite` | `series`, `records: [{key, values}]` | upsert rows; schema grows as needed |
| `recordDelete` | `series`, `key` | delete one row |

Rules the tool must enforce (they are what keeps the model honest):

1. `recordWrite` **reports added fields** in its answer text, and warns on a near-duplicate name.
2. `recordDelete` requires `key`; there is no "clear the object" verb here (the Data page has it,
   behind a confirmation).
3. The tool description states the shape in one paragraph: an object declares a key and its known
   fields; writing a new field extends the object; a record's values are merged, so a partial write
   corrects one field.
4. `read` of a **series** keeps working exactly as it does now — this is additive.

Capability: **folded into the three that already own this subject — CORRECTED after delivery.**

The first draft of this section asked for two new app-wide entries (`records.act`,
`records.shape`, catalogue 13 → 15). That is not implementable without taking something away:
`MAX_TOOLS` is 20, the busiest page (agents) declares 8 of its own actions, and the globals
available at that moment are exactly 12 — so a thirteenth global evicts one of agents' own
actions from the tool list. Measured, not assumed: `jev-spec-sim` asserts both properties
(`the page budget still fits the largest page` and `every app-wide action is callable from
<page>`), and it fails the moment a 14th global is registered.

So the record verbs are **actions of the entries that already own the subject**, which is also
the honest split — one subject, three friction levels, exactly as before:

| capability | gains | gate |
|---|---|---|
| `metrics.act` | actions `objects`, `object`, `recordWrite` | none (effect: 'write') |
| `metrics.declare` | `kind: series|object`, `fields`, `strict` | `confirm: true` — what a thing IS |
| `metrics.forget` | `key` (a row) as an alternative to `slot` (a reading) | `confirm: true` — it destroys data |

`jev-spec-sim` therefore still pins **13**, and the assertion sentence did not change.

---

## 9. Data tab (UI)

1. Objects appear in the master list under their own heading, beside series (an object row shows
   `label · N records · fields`).
2. Selecting one renders a **real table**: columns from `fields`, one row per record, sorted by
   `ts` then `rec_key`.
3. The chart draws one **numeric field** by choice (a field selector in `md-controls`, defaulting
   to the first numeric field), reusing `MetricChart`; the tooltip shows that row's other fields —
   which is the multi-dimension tooltip, now enforced by the store rather than by the writer.
4. A row can be edited (values → `PATCH …/records/{key}`) and deleted, from the table.
5. The view (field, chart kind) is remembered per object in `LS_VIEWS`, like a series.

Out of scope for the first cut: creating/altering an object from the page (the tool does that);
multi-table joins (§12).

---

## 10. Relay (browser-facing) surface

Mirror under `/api/records/...` with the same shapes, so the page never talks to the hub directly
(it cannot — `cors_origins = []`):

- `GET /api/records` → objects + records (one call, like `/api/metrics`).
- `POST /api/records/objects`, `PATCH /api/records/objects/{key}`, `DELETE …{key}`
- `POST /api/records/objects/{key}/records`, `PATCH|DELETE …/records/{rec}`

Owner-only, same as the metrics writes. In relay-only mode (no `METRICS_API`) keep the same shapes
backed by a local JSON store, so the feature is testable without a hub.

---

## 11. Compatibility and rollout

- **`metric_series` / `metric_sample` are untouched.** Records are a new namespace; no existing
  reading moves. Do **not** add a `meta` column to `metric_sample`, and do not rebuild its CHECK
  constraints — SQLite cannot alter a CHECK, and a table rebuild on live data is the one migration
  worth avoiding.
- Sibling text series keep working. Migration of existing `*.project` / `*.estate` series into an
  object is **optional and manual** (a script reading both, writing one object).
- Migration 4 applies **lazily, on the first hub request** — not on boot. (Corrected: the first
  draft of this document said "on boot", and the backend flagged it. The preflight check that
  matters is therefore the import check below, not a restart log line.)
- Procedure on the droplet, in this order:
  1. `sqlite3` backup of `/var/lib/jarvis-content/jarvis.sqlite3` via
     `Connection.backup()` (not `cp` — a WAL copy can miss `-wal`);
  2. `scp` the files, `chown -R jarvis:jarvis`;
  3. validate **as the `jarvis` user** with the venv interpreter:
     `PYTHONPATH=/opt/jarvis-content-serve .venv/bin/python3 -c 'import main; print(len(main.app.openapi()["paths"]))'`
     — must import, and the path count must grow by the 9 new routes;
  4. `systemctl restart jarvis-content.service`, confirm `is-active`;
  5. run `glasses/tools/probe-records.mjs` (§12), which now also proves the relay derives its
     records base from `METRICS_API`.

---

## 12. Acceptance tests

**`glasses/tools/probe-records.mjs`** (live, named `probe-*` so `sim-all.mjs` skips it):

1. declare `probe.launch` with `fields: [{key:'date',type:'date'},{key:'price',type:'number',unit:'SGD'}]`
2. write one record `{key:'2023-10-15', values:{date:'2023-10-15', price:290000, project:'Garden Vale'}}`
   → `addedFields` names **project** (inferred `text`)
3. read the object → the row has all three values, `ts` = 2023-10-15T00:00Z
4. write a second record with a **new** field (`estate`) → schema grows again, count is 2
5. `where=flat_type` on a field that does not exist → `400`, not an empty list
6. `sort=price&order=desc` → highest price first
7. `PATCH …/records/2023-10-15 {values:{price:295000}}` → only that value changed
8. `DELETE …/records/2023-10-15` → `deleted:1`; the other record survives
9. strict object: writing an unknown field → `400 UNKNOWN_FIELD` naming the allowed fields
10. write a string into `price` → refused, naming the field and its declared type
11. `DELETE …/objects/{key}?purge=1` → gone; the series store is untouched (`GET /metrics/series`)

**Harnesses** (`sim-all`): `records-sim` (the inference table, the date rules, the caps, and the
local store — 94 assertions), `metrics-tool-sim` (each new action forwards the right call, the
added-field receipt, the near-duplicate warning, delete requires a key, and the six relay routes
over a real booted relay — 163), `metrics-capability-sim` (the two vocabularies, JSON rows
forwarded structurally — 82), `metrics-sim` (unchanged in intent; its DataPanel fingerprints were
updated for the second store), and `jev-spec-sim` (**still 13**, see §8).

**Layout**: `glasses/tools/probe-record-view.mjs` renders the table in a real engine against the
shipped stylesheet and measures it at 1440px and 390px — the phone run is what caught a grid track
declared `1fr` (which is `minmax(auto, 1fr)`, so it refuses to shrink below a table's min-content
and makes the whole page scroll sideways) and a date keyed row echoing its own date.

---

## 13. Risks and open questions

Risks, with the mitigation each already has:

| risk | mitigation |
|---|---|
| a typo silently widens the schema | inferred fields are reported; strict mode; near-duplicate warning |
| JSON rows are slower to query than columns | bounded scans; expression index available per hot field without a model change |
| unlimited objects/fields | caps: 40 fields, 8 KiB body, 32 records/write, `MAX_SERIES`-style object count |
| two stores that look alike confuse the model | the tool description states it once: a **series** is one number over time, an **object** is rows with fields |

Decisions I need from you before implementing:

1. **Soft or strict by default?** Soft is what makes "AI builds the schema" work; strict is safer
   for a table you care about. Current proposal: soft by default, strict opt-in per object.
2. **One list or two in the Data tab?** Objects beside series in the master list, or a separate
   section/tab? Proposal: one list, grouped.
3. **Existing BTO sibling series** — leave them as they are, or write a one-off script that folds
   `tengah.bto.4room{,.project,.estate}` into one `bto.launch` object? Proposal: leave them; migrate
   nothing automatically.
4. **Does the wearer need to *create* an object by hand** on the Data page, or is "ask Jarvis" the
   only path for now? Proposal: Jarvis only in v1.

---

## 14. Out of scope

- Real multi-table joins / foreign keys between objects (the "optional, separate thing, for
  genuinely different shapes" from the earlier note).
- Replacing `metric_series`: a series stays the right shape for one number over time, and every
  existing chart, collector and capability depends on it.
- Binary/attachment fields, per-field validation regexes, and per-record history (the ledger covers
  the audit story for tool calls).

---

## 15. What the client side delivered (0.3.79)

The four open questions in §13 were answered by their own proposals (soft by default, one grouped
list, migrate nothing automatically, Jarvis-only creation) and nothing needed a script.

| file | what it is |
|---|---|
| `web/server/records.mjs` | the hub's rules as pure functions — inference, dates, coercion, caps, `nearDuplicate`, and `createLocalRecords`, the relay-only store that answers with the hub's shapes |
| `web/server/records-remote.mjs` | the hub client; `recordsBaseFrom()` derives `/hub/records` from `METRICS_API` so no new environment variable exists to get wrong |
| `web/server/metrics-tool.mjs` | five actions: `objects`, `object`, `objectDeclare`, `recordWrite`, `recordDelete` — plus loose action-name matching, because the runner lowercases the action and `recordWrite` would otherwise answer "unknown action" |
| `web/server/local-sse.mjs` | `RECORDS_FILE`, the store accessors (one per operation, choosing hub or local), **create-on-first-write**, the six `/api/records` routes, and five tool deps |
| `glasses/src/web/metrics-client.ts` | `fetchRecords`, `writeRows`, `patchRow`, `deleteRow`, `deleteTable`, `declareTable` |
| `glasses/src/web/DataPanel.tsx` | tables in the master list (own heading), `TableDetail` (a real table + a numeric-column chart whose tooltip reads the whole row), inline row edit, per-row delete, table delete behind the two-step confirm |
| `glasses/src/ai/capabilities/metrics.ts` | the three capabilities extended, with `jsonArg()` for `rows`/`fields` |

### How the AI is taught the difference (the anti-overlap rule)

One sentence, repeated in the place the model reads before every call:

> A SERIES is one number over time; an OBJECT is a table of rows. A fact with more than one
> attribute is a ROW. Never keep the same row both ways — four sibling series joined by slot is
> the shape objects replace.

It appears in the tool description, in `metrics.act`'s description, in the `list` empty state, and
in the `read` attribute note (which now says the sibling-attribute join is the older shape).

Three mechanics back it up rather than relying on the sentence:

1. **`recordWrite` creates the table**, so "I need a schema first" never justifies the sibling-series
   fallback: the model writes the row it has.
2. **The receipt names every added column**, so a schema that grew is visible in the same turn.
3. **A near-duplicate column name is reported by name** (`estate` vs `estates`), with the fix.

### Two limits worth knowing

- An undeclared numeric *string* stays `text`: inference reads JSON numbers, so a model that sends
  `"290000"` gets a text column. It is refused rather than silently coerced the moment the column is
  declared `number`, and `objectDeclare` is the way to pre-set the type.
- The hub's strict-mode refusal names the offending field but not the columns that exist; the tool
  appends them from the schema it read before writing, so the model always sees the list.
