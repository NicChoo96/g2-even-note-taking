# 02 — Database specification

Target: **Postgres** (Railway managed). The DDL below is the physical schema.
Every rule carried over from `01-inventory.md` is restated here as a constraint,
an index, or an explicit "do not do this".

## 1. Layering

```
web/server/local-sse.mjs          ← routes; knows nothing about SQL
web/server/repository/index.mjs   ← the ONLY module that imports the driver
web/server/repository/<entity>.mjs← one module per aggregate
web/server/repository/sql/        ← migrations, numbered, forward-only
```

**Rule:** no `import` of the driver outside `repository/`. A route handler asks
`await repos.hub.get(principal)`. This is what keeps a SQLite test adapter
possible, keeps transactions in one place, and keeps the route file reviewable.

**Migrations:** `sql/0001_init.sql`, `0002_….sql`, forward-only, applied at relay
boot under an advisory lock, recorded in `schema_migration(version, applied_at)`.
No down-migrations: a rollback is a new forward migration, exactly like the
ledger.

## 2. Types and conventions

| Concern | Convention |
|---|---|
| Ids | `uuid` (`gen_random_uuid()`), except gateway doc ids which are 32-hex → `text` with a `CHECK (id ~ '^[0-9a-f]{32}$')` |
| Timestamps | `timestamptz`. The wire uses ms-epoch `number`; the repository converts at the boundary, **never in the route** |
| Soft delete | `deleted_at timestamptz NULL` + a partial index `WHERE deleted_at IS NULL` |
| Collections order | **`ordinal integer`**, not `created_at`. Array position is data (`01-inventory.md` §2) |
| Free-form sub-objects | `jsonb` — only `args` and `payload` qualify |
| Enums | native Postgres `enum` types. They are additive-friendly (`ALTER TYPE … ADD VALUE`) and self-documenting in `\d` |
| Secrets | `text` holding **ciphertext** (see §9). Never plaintext, never in a broadcast read |
| Revisions | `bigint`, bumped **inside the same transaction** as the write |

## 3. Identity and access

```sql
CREATE TYPE pair_status AS ENUM ('pending', 'approved', 'revoked');

CREATE TABLE app_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

-- An owner session. The token is stored HASHED: a database dump must not be a
-- set of live credentials (the current .g2-hub-auth.json stores them raw).
CREATE TABLE auth_session (
  token_hash  text PRIMARY KEY,          -- sha256 of the 48-hex token
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX auth_session_user ON auth_session(user_id);

CREATE TABLE device (
  device_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES app_user(id) ON DELETE CASCADE,   -- NULL until approved
  label       text NOT NULL DEFAULT '',
  pair_code   text,
  status      pair_status NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  revoked_at  timestamptz
);
-- One live device per pair code: the code is claimed exactly once.
CREATE UNIQUE INDEX device_pair_code_live ON device(pair_code)
  WHERE pair_code IS NOT NULL AND status = 'pending';
CREATE INDEX device_user ON device(user_id) WHERE revoked_at IS NULL;

-- MCP is its own trust boundary (00-overview D10) and so gets its own credential.
CREATE TABLE mcp_token (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  label       text NOT NULL DEFAULT 'mcp',
  scopes      text[] NOT NULL DEFAULT '{}',   -- sessions:read, sessions:write, memory:read, recall
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX mcp_token_user ON mcp_token(user_id) WHERE revoked_at IS NULL;
```

**Repository mapping of `principalFromToken(token)`:**

| Token shape | Table | Principal |
|---|---|---|
| 48 hex | `auth_session` (unrevoked) | `{ kind:'owner', userId, email }` |
| 36-char UUID | `device` where `status='approved' AND revoked_at IS NULL` | `{ kind:'device', userId, deviceId }` |
| `mcp_…` prefix | `mcp_token` (unrevoked) | `{ kind:'mcp', userId, scopes }` |

Shape-first dispatch is deliberate: it keeps `readToken` a pure string function
(deployed bundles depend on it) and avoids a table scan on every request.

## 4. Hub aggregate

```sql
CREATE TYPE section_id AS ENUM ('todo','docs','files','notes','agents');

CREATE TABLE hub_state (
  user_id         uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  active_section  section_id NOT NULL DEFAULT 'todo',
  active_doc_id   uuid,                -- NULL → fall back to the first doc (activeDoc())
  rev             bigint NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

`rev` is the **control-plane** stamp. It is bumped by every write to any hub
child row, in the same transaction. It replaces the `updatedAt` comparison that
`POST /api/stream` performs today (`01-inventory.md` §7.1) — same guard, but
explicit and per-collection instead of implicit in a blob comparison.

```sql
CREATE TABLE todo_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,
  text        text NOT NULL,
  done        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX todo_item_order ON todo_item(user_id, ordinal);
CREATE UNIQUE INDEX todo_item_ordinal ON todo_item(user_id, ordinal);
```

**⚠ Do not add a unique index that lets a client reorder by rewriting ordinals
one at a time.** Reordering is a single `UPDATE … FROM (VALUES …)` or a full
replace; a per-row loop will collide on `todo_item_ordinal`.

```sql
CREATE TABLE document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,
  title       text NOT NULL DEFAULT 'Untitled',
  content     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX document_list   ON document(user_id, ordinal) WHERE deleted_at IS NULL;
CREATE INDEX document_recent ON document(user_id, updated_at DESC) WHERE deleted_at IS NULL;
```

`content` is `text` (unbounded) on purpose. **Do not add a length cap** — the
whole-file read contract (`BODY_MAX_CHARS = 60_000`, measured against the
120 000-char model budget) governs what is *returned to a model*, not what may be
*stored*. A stored doc is complete.

```sql
CREATE TABLE note (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  content    text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- A REFERENCE. There is deliberately NO body/htmly/html column and none may be added.
CREATE TABLE file_ref (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),  -- gateway doc id
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  agent       text NOT NULL DEFAULT '',
  slug        text,
  tags        text[] NOT NULL DEFAULT '{}',
  url         text NOT NULL,
  size        bigint NOT NULL DEFAULT 0,
  version     integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  deleted_reason text
);
CREATE INDEX file_ref_list ON file_ref(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX file_ref_tags ON file_ref USING gin (tags);
```

> **⚠ THE HARD RULE.** `HubState` is broadcast to every device and mirrored by
> the relay, so a body here would be copied into a public-ish place; and a 4 MiB
> document blows the 999-UTF-8-byte frame budget on the glasses regardless. The
> gateway is the body store. A migration that "helpfully" denormalises `html`
> into this table is the single most damaging thing that could be done to this
> schema.

## 5. Agents aggregate

```sql
CREATE TYPE tool_kind AS ENUM
  ('web','http','jev','files','todo','docs','notes','location');
CREATE TYPE http_method AS ENUM ('GET','POST');
CREATE TYPE web_depth AS ENUM ('basic','advanced');

CREATE TABLE llm_settings (
  user_id   uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  provider  text NOT NULL DEFAULT 'openrouter',
  model     text NOT NULL DEFAULT 'inclusionai/ling-3.0-flash-sante:free',
  referer   text NOT NULL DEFAULT '',
  title     text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- hasKey is DERIVED, never stored: EXISTS (select from app_secret where key='llm').

CREATE TABLE tool (
  id            text PRIMARY KEY,            -- 'tool-web', 'tool-jev', … (seed ids are literals)
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          tool_kind NOT NULL,
  description   text NOT NULL DEFAULT '',
  url           text,
  method        http_method,
  body_template text,
  has_token     boolean NOT NULL DEFAULT false,   -- the BOOLEAN only
  search_depth  web_depth,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- the model-facing name must satisfy the provider's ^[a-zA-Z0-9_-]+$ rule
  CHECK (name ~ '^[a-zA-Z0-9_-]+$')
);
CREATE INDEX tool_user ON tool(user_id);

CREATE TABLE agent (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name          text NOT NULL DEFAULT 'New Agent',
  system_prompt text NOT NULL DEFAULT '',
  prompt        text NOT NULL DEFAULT '',     -- backfilled to '' historically
  model         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX agent_list ON agent(user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE agent_tool (
  agent_id uuid NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  tool_id  text NOT NULL REFERENCES tool(id) ON DELETE CASCADE,
  ordinal  integer NOT NULL,
  PRIMARY KEY (agent_id, tool_id)
);
CREATE INDEX agent_tool_order ON agent_tool(agent_id, ordinal);
```

**The web-search tool is always present.** `loadLocal()` re-injects a
`kind:'web'` tool if the list lacks one, because an install that had only a
legacy `tavily` tool would otherwise lose web search entirely. The repository's
`agents.read()` MUST apply the same rule (`ensureWebTool()`), or a new client
against a clean database has no search.

## 6. Sessions — the canonical store

See `06-jarvis-sessions.md` for the product design; this is the physical shape.

```sql
-- 'agent' = a run of an AgentDef; 'voice' = a spoken exchange (converse.ts);
-- 'note'  = a passive capture (a dictated memo, a location ping).
-- The client union `AgentSession.status` is 'running'|'done'|'error'; the extra
-- 'stopped' here is a superset the projection maps onto 'done'.
CREATE TYPE session_kind   AS ENUM ('agent','voice','note');
CREATE TYPE session_status AS ENUM ('running','done','error','stopped');
CREATE TYPE message_role   AS ENUM ('user','assistant','tool','system');

CREATE TABLE jarvis_session (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind            session_kind NOT NULL,
  agent_id        uuid REFERENCES agent(id) ON DELETE SET NULL,   -- NULL for 'voice'
  run_id          uuid,                       -- the AgentRun that produced it, when there was one
  title           text NOT NULL DEFAULT '',
  status          session_status NOT NULL DEFAULT 'done',
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  turn_count      integer NOT NULL DEFAULT 0, -- maintained by trigger; the SIZE GUARD's input
  word_count      integer NOT NULL DEFAULT 0,
  summary_version integer NOT NULL DEFAULT 0,
  deleted_at      timestamptz,
  pinned          boolean NOT NULL DEFAULT false
);
CREATE INDEX session_list   ON jarvis_session(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX session_agent  ON jarvis_session(user_id, agent_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX session_kind   ON jarvis_session(user_id, kind, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX session_pinned ON jarvis_session(user_id) WHERE pinned AND deleted_at IS NULL;
```

`turn_count` is **denormalised and maintained by a trigger**, because it is the
input to the union merge's "richer wins" comparison (`01-inventory.md` §3). A
`COUNT(*)` per row during a merge is an N+1 query on the hottest path.

```sql
CREATE TABLE session_message (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES jarvis_session(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  role       message_role NOT NULL,
  content    text NOT NULL DEFAULT '',
  tool       text,
  args       text,                   -- JSON as a STRING (matches AgentMessage.args)
  at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE INDEX session_message_read ON session_message(session_id, seq);
```

`UNIQUE (session_id, seq)` is what makes appending idempotent: a replayed
`POST /sessions/:id/messages` collides harmlessly and the repository reports
`applied: false` rather than duplicating a turn.

> **⚠ `args` is `text`, not `jsonb`,** matching `AgentMessage.args` exactly. It is
> a string in the wire protocol and in the transcript renderer; typing it as
> `jsonb` would force a parse/serialise round-trip on every read for no gain.

```sql
-- APPEND-ONLY. A re-summarisation is a NEW version; it never overwrites.
CREATE TABLE session_summary (
  session_id uuid NOT NULL REFERENCES jarvis_session(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  model      text NOT NULL,
  kind       text NOT NULL DEFAULT 'digest',   -- 'digest' | 'manual' | 'rollup'
  text       text NOT NULL,
  concepts   text[] NOT NULL DEFAULT '{}',
  entities   text[] NOT NULL DEFAULT '{}',      -- names, places, products
  decisions  text[] NOT NULL DEFAULT '{}',
  tasks      text[] NOT NULL DEFAULT '{}',
  tokens     integer,
  PRIMARY KEY (session_id, version)
);
CREATE INDEX summary_fts      ON session_summary
  USING gin (to_tsvector('english', text));
CREATE INDEX summary_concepts ON session_summary USING gin (concepts);
CREATE INDEX summary_entities ON session_summary USING gin (entities);
CREATE INDEX summary_tasks    ON session_summary USING gin (tasks);
```

**Why `text[]` and not `jsonb`:** Postgres gives a GIN index and array
containment (`entities @> ARRAY['ferry']`) for free, and the values are
genuinely a flat set of short strings. `jsonb` would buy nesting nobody needs and
cost a containment operator nobody can remember.

**Why versioned:** a summary is *derived*. Re-deriving it (a better model, a
longer session, a corrected transcript) must not destroy what the LLM already
cited. This mirrors the ledger's append-only doctrine, and it is what makes
"refer back to a past session" auditable — you can see which summary a given
answer was built on.

```sql
-- The tombstone map, one row per cleared scope. agent_id NULL = "clear everything".
CREATE TABLE session_tombstone (
  user_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  agent_id  uuid,                      -- NULL for a global clear
  cleared_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);
```

**⚠ `(user_id, agent_id)` cannot be the primary key** in Postgres when
`agent_id` is nullable — NULLs are not equal, so a second global-clear row would
be permitted. Use a `COALESCE` unique index instead:

```sql
CREATE UNIQUE INDEX session_tombstone_scope
  ON session_tombstone(user_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid));
```

Optional, only if embeddings are ever enabled (`07-jev-recall.md` §6):

```sql
-- CREATE EXTENSION IF NOT EXISTS vector;
-- CREATE TABLE session_embedding (
--   session_id uuid NOT NULL REFERENCES jarvis_session(id) ON DELETE CASCADE,
--   version    integer NOT NULL,
--   model      text NOT NULL,
--   vec        vector(1536) NOT NULL,
--   at         timestamptz NOT NULL DEFAULT now(),
--   PRIMARY KEY (session_id, version)
-- );
-- CREATE INDEX session_embedding_ann ON session_embedding
--   USING hnsw (vec vector_cosine_ops);
```

## 7. Memory log

`JarvisMemory` becomes a projection, but the raw log is what makes it
reconstructible. A voice turn that belongs to a run is **attached to that
session**; a turn that belongs to no run gets a `voice` session of its own.

```sql
CREATE TABLE memory_turn (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  session_id uuid REFERENCES jarvis_session(id) ON DELETE SET NULL,
  role       message_role NOT NULL,
  text       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_turn_recent ON memory_turn(user_id, at DESC);
CREATE INDEX memory_turn_session ON memory_turn(session_id, at);

-- The GLOBAL digest (what MEMORY_MAX_WORDS describes). Versioned, append-only.
CREATE TABLE memory_digest (
  user_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  version  integer NOT NULL,
  text     text NOT NULL,
  folded   integer NOT NULL,          -- how many turns this digest accounts for
  model    text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);

-- Words actually written, for the 100k-word promise. A materialised rollup, not
-- a COUNT over memory_turn on every read.
CREATE TABLE memory_usage (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  words      bigint NOT NULL DEFAULT 0,
  turns      bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**Retention, and the one rule that must not change:** crossing
`MEMORY_MAX_WORDS` or `MEMORY_MAX_CHARS` triggers **folding, never discarding**.
`memory_turn` rows are **never deleted** by compaction — `folded` records how
many are accounted for by a digest. Deleting the raw turns is what would make the
digest unverifiable.

## 8. Ledger

```sql
CREATE TYPE ledger_effect AS ENUM ('pure','read','write','irreversible');
CREATE TYPE ledger_kind AS ENUM
  ('ask','delta','route','call','result','reply','decision','gate','note','error');
CREATE TYPE ledger_by AS ENUM ('wearer','jarvis','agent','jev','system');
CREATE TYPE ledger_status AS ENUM ('pending','ok','failed','skipped','declined');
CREATE TYPE ledger_locus AS ENUM ('client','relay');

CREATE TABLE ledger_entry (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  seq     bigint NOT NULL,                 -- per-user monotonic, from a sequence
  run_id  uuid NOT NULL,
  at      timestamptz NOT NULL,
  kind    ledger_kind NOT NULL,
  by      ledger_by NOT NULL,
  effect  ledger_effect NOT NULL,
  status  ledger_status NOT NULL,
  text    text NOT NULL CHECK (length(text) <= 120),
  refs    bigint[] NOT NULL DEFAULT '{}',
  locus   ledger_locus,
  payload jsonb,
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX ledger_run     ON ledger_entry(user_id, run_id, seq);
CREATE INDEX ledger_recent  ON ledger_entry(user_id, seq DESC);
-- refs containment, for the causal-chain queries
CREATE INDEX ledger_refs    ON ledger_entry USING gin (refs);
```

> **⚠ APPEND-ONLY, ENFORCED, NOT DOCUMENTED.** The doctrine is load-bearing
> (`01-inventory.md` §5.3), so enforce it in the database rather than in a
> comment:
>
> ```sql
> CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entry DO INSTEAD NOTHING;
> CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entry DO INSTEAD NOTHING;
> ```
> and grant the application role `INSERT, SELECT` only. A revoked `UPDATE` grant
> is stronger than a code review.
>
> **The safety invariant is a query, not a convention:**
> ```sql
> -- MUST return zero rows.
> SELECT e.user_id, e.run_id, e.seq
> FROM ledger_entry e
> WHERE e.effect = 'irreversible' AND e.status = 'ok'
>   AND NOT EXISTS (
>     SELECT 1 FROM ledger_entry g
>     WHERE g.user_id = e.user_id AND g.run_id = e.run_id
>       AND g.kind = 'gate' AND g.status = 'ok'
>       AND g.seq < e.seq AND g.payload->>'approve' = 'true'
>   );
> ```
> Run it as a `CHECK`-style fixture in the test suite, and on demand from the
> debug route. Note the `g.kind = 'gate'` guard — without it the query flags the
> approval entry itself, which is exactly the bug `ungatedIrreversible()` had.

## 9. Settings and secrets

```sql
CREATE TABLE app_setting (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key        text NOT NULL,       -- searchProvider, depth, model, referer, title, …
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Secrets are separated from settings so no "return all settings" read can
-- leak one by accident, and so the SELECT grant can differ.
CREATE TABLE app_secret (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key        text NOT NULL,       -- 'llm' | 'search:tavily' | 'search:brave' | 'tool:<toolId>'
  ciphertext text NOT NULL,       -- AES-256-GCM, key from the platform env
  hint       text NOT NULL DEFAULT '',   -- last 4 chars, for the UI ("sk-…4f2a")
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
```

`toolTokens` (today a `Map<toolId, token>` in a JSON file) becomes rows with key
`tool:<toolId>` — which fixes a latent bug: the map is stored as an object, so a
tool id that happens to collide with `Object.prototype` would already be
unreachable.

**`hasKey` / `tavily` / `jev` / `files.configured` are DERIVED at read time**
from `EXISTS (… app_secret …)`, never stored. A stored boolean is a boolean that
goes stale when a secret is written by a path that forgot to update it.

**Ciphertext, not plaintext.** The current secrets file is plaintext JSON on
disk. If the database is a managed add-on, its backups and its
`DATABASE_URL`-holding environment are a wider blast radius than one container's
filesystem. Derive the key from a platform secret (`SECRET_KEY`), and **fail
closed**: if `SECRET_KEY` is absent and secrets already exist, refuse to serve
them rather than silently returning empty strings.

## 10. Idempotency and sync

```sql
-- Every client-generated operation id that was applied. Bounded by TTL.
CREATE TABLE applied_op (
  user_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  op_id     uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  result    jsonb,
  PRIMARY KEY (user_id, op_id)
);
CREATE INDEX applied_op_gc ON applied_op(applied_at);

-- The server-side view of what a client has. One row per (device, collection).
CREATE TABLE client_cursor (
  device_id  uuid NOT NULL REFERENCES device(device_id) ON DELETE CASCADE,
  collection text NOT NULL,
  rev        bigint NOT NULL DEFAULT 0,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, collection)
);
```

`applied_op` is what makes a row-level `POST` safe to retry. **A TTL of 7 days**
is generous: an op older than that has either been superseded by a user-visible
state or the client has done a full re-pull. GC nightly.

**Why `result` is stored:** a retried op must return the *same* answer, not a
re-execution. Without it, "create todo" is idempotent but "add 1 to the counter"
is not — and every increment-style mutation in this app (ordinals, versions,
`rev`) is of that shape.

## 11. What deliberately has NO table

| Thing | Why not |
|---|---|
| `AgentRun` live state | Ephemeral by design (`01-inventory.md` §6.1). A finished run becomes a `jarvis_session`; a running one lives in memory because the relay is the only writer and a restart losing an in-flight run is acceptable and already the behaviour. |
| `AiState` / `AiStep` / the mirror | A high-frequency transient signal. Persisting it would resurrect a stale HUD on the other surface, which is why the channel is transient in the first place. |
| The SSE channel map | Rebuilt at boot. `lastState` is a cache of the hub aggregate, i.e. `repos.hub.get()`. |
| `AiControl` frames | Directed and short-lived (`CONTROL_TTL_MS = 15000`). |
| Undo batches (`MAX_BATCHES = 3`) | Session-local UI affordance; an undo that survives a reconnect is a different (and much larger) feature. |
| Capability registry | It is **code**. `Capability.run` is a closure. Nothing about it belongs in a database; only its *effects on data* do. |
| `MemoryView` | Derived (`01-inventory.md` §4). |
| Document bodies for `file_ref` | §4. |
| Full-text index over `session_message.content` | Deliberately NOT. Search over raw transcripts invites "the LLM read your whole history to answer a question". Search goes over `session_summary`, which is the reviewed, bounded artifact. Raw-message search is a debug affordance, scoped to a session id, and not indexed. |

## 12. Migration from today's stores

Three phases, each independently deployable and independently revertible.

### Phase A — schema, dual-write, database is NOT yet authoritative

1. Apply `0001_init.sql`.
2. On boot, if a user has zero rows in `hub_state` and `app_user`, **import** the
   three JSON files:
   - `.g2-hub-auth.json` → `app_user`, `auth_session` (hashing tokens on the way
     in), `device`
   - `.g2-hub-secrets.json` → `app_setting` + `app_secret` (encrypting on the way
     in)
   - `.g2-hub-state.json` → `hub_state` + `todo_item` + `document` + `note` +
     `file_ref` + `agent` + `tool` + `agent_tool` + `llm_settings` +
     `jarvis_session` + `session_message`, splitting the `agents` blob's
     `sessions` array per agent.
     - `data.agents[].sessions[].messages[]` → `session_message` rows with
       `seq = index`
     - `data.sessionsClearedAt` → `session_tombstone` rows
     - a `ToolDef` with `hasToken: true` → `tool.has_token = true`, and the
       token text (if present in `toolTokens`) → `app_secret('tool:<id>')`
3. Reads still come from the JSON files. Writes go to **both**, and any
   disagreement is logged with a counter (this is the whole point of Phase A).
4. Ship the read-only REST surface (`GET`) and verify it byte-for-byte against
   the blob for a week of real use.

**Phase A exit criterion:** zero disagreement-log entries over a full day.

### Phase B — database is authoritative, the file is a cold cache

5. Reads move to the repository. The file is read **only** when
   `SELECT count(*) FROM hub_state WHERE user_id = $1` is `0` — i.e. a first boot
   against a database that has never seen this user.
6. `persistState()` stops writing per-change and becomes a periodic snapshot
   (every 5 min) purely so a catastrophic database loss still has *something*.
7. Writes are transactional; `rev` is introduced and the `stale` guard is
   re-expressed as a `409`.
8. Sessions stop being capped in the database; the `agents` channel keeps its
   `MAX_SESSIONS = 5` broadcast cap, applied at *projection* time.

**Phase B exit criterion:** the JSON files can be deleted and nothing is lost.

### Phase C — offline cache and outbox

9. IndexedDB cache + `L2`/`L3` (`05-offline-cache-sync.md`).
10. `POST /api/v1/sync/push` with `opId`s; `Idempotency-Key` on single mutations.
11. Retire the whole-state `POST /api/stream` write path. **The read path (SSE
    broadcast) stays** — see `04-web-integration.md` §4.

## 13. Invariants as executable checks

Every rule in this document that is marked load-bearing gets a query in
`web/server/repository/checks.mjs`, runnable from a debug route and asserted in
the test suite. A documented invariant decays; a failing test does not.

| Check | Assertion |
|---|---|
| `filesNoBody` | `file_ref` has no column matching `%body%` or `%html%` |
| `ledgerNoUpdate` | `ledger_entry` UPDATE and DELETE grants are absent |
| `ledgerGated` | the query in §8 returns zero rows |
| `sessionMonotonic` | every `session_message.seq` set per session is `0..n-1` with no gaps |
| `summaryVersioned` | `summary_version = max(version)` in `session_summary` for every session |
| `tombstoneScope` | no duplicate `(user_id, COALESCE(agent_id))` in `session_tombstone` |
| `webToolPresent` | every `app_user` with ≥1 agent has ≥1 `tool` of `kind='web'` |
| `memoryNotDiscarded` | `memory_usage.turns >= count(memory_turn)` (folding never deletes) |
| `ordinalDense` | every `todo_item`/`document`/`agent_tool` ordinal set per parent is `0..n-1` |
