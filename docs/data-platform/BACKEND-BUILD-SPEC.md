# Backend build spec — one service: Postgres + REST v1 + MCP

**This is the single document a backend implementer needs.** It is
self-contained: the DDL, the endpoint contract, the MCP surface and the deploy
shape are all reproduced here in full, so nothing requires cross-referencing the
other nine documents. Where a rule exists because a bug already shipped, the rule
is marked **⚠** and the reason is stated inline.

The other documents in `docs/data-platform/` remain the *rationale* set — read
them when you disagree with something here. This file is the *build contract*.

**Scope of this document:** create the database, expose it over REST, expose it
over MCP. It does **not** specify the web client (`04-web-integration.md`,
`05-offline-cache-sync.md`) or the JEV algorithm internals
(`07-jev-recall.md`) beyond the two request/response shapes this service must
accept.

---

## 0. What you are building

Three surfaces, one process:

```
                    ┌────────────────────────────────────────────┐
   SPA / glasses ───┤  GET/POST /api/v1/*        (REST, storage)  │
                    │                                            │
   LLM / MCP host ──┤  POST /mcp/hub             (JSON-RPC 2.0)  │
                    │                                            │
   ops / tests ─────┤  GET /health, /diag/*      (diagnostics)   │
                    └───────────────────┬────────────────────────┘
                                        │  repository/  ← the ONLY SQL importer
                                        ▼
                                  PostgreSQL
```

The process is an **addition** to the existing relay, not a replacement for the
stateless proxies. `POST /api/llm`, `POST /api/tool`, `POST /api/decisions` and
the auth routes keep doing exactly what they do today — they are not storage and
this spec does not touch them.

---

## 1. Deploy shape — coexisting with the file server on the same host

The file server (`jarvis-file-server-mcp`) already owns the host. The hub backend
runs alongside it.

### 1.1 The one conflict you must resolve deliberately

| Existing | Wants | Collision |
|---|---|---|
| `jarvis-file-server-mcp` | `POST /mcp` | **path collision** — there can be only one `/mcp` |
| `jarvis-file-server-mcp` | `/auth/login`, `/auth/refresh` | leave alone |
| hub backend | `/api/v1/*` | free |
| hub backend | `/health`, `/diag/*` | free |
| hub backend | `POST /mcp` | ⚠ collides |

**Recommended resolution — path-mount the hub's MCP, do not squat `/mcp`:**

```
Public 80/443  ──┬──  /api/v1/*     → hub:8080
  (reverse proxy)├──  /mcp/hub      → hub:8080/mcp     ← the hub's MCP endpoint
                 ├──  /mcp          → file-server:PORT  ← unchanged
                 ├──  /auth/*       → file-server:PORT  ← unchanged
                 └──  /            → app (existing)
```

The hub keeps its internal route as `POST /mcp` (so the code and the docs agree);
the **proxy** publishes it at `/mcp/hub`. That way the file server's own MCP
endpoint is untouched and both MCP servers exist on one host.

> **Why not "just share one `/mcp` and multiplex by tool name"?** Because the two
> servers have different auth (the file server has its own bearer session; the hub
> has `mcp_token` scopes) and different `initialize` results. A multiplexer would
> have to answer `initialize` and `tools/list` for both, which means a bug in the
> multiplexer becomes a bug in a service that currently works. Two paths, no
> shared code.

### 1.2 Process and modules

```
app.mjs                              ← http server, routing, no SQL
server/routes/hub.mjs                ← /hub, /todos, /docs, /notes
server/routes/agents.mjs             ← /agents, /tools, /settings
server/routes/sessions.mjs           ← /sessions*, /memory, /recall
server/routes/ledger.mjs             ← /ledger  (append-only)
server/routes/sync.mjs               ← /sync/pull|push|prime
server/routes/diag.mjs               ← /health, /diag/*
server/mcp/server.mjs                ← initialize / tools/list / tools/call
server/repository/index.mjs          ← THE ONLY module that imports the driver
server/repository/<entity>.mjs       ← one per aggregate
server/repository/checks.mjs         ← the invariant queries (§8)
server/repository/sql/0001_init.sql  ← forward-only, numbered
```

**⚠ Rule: no driver import outside `repository/`.** A route handler calls
`await repos.hub.get(principal)`. This is what keeps transactions in one place,
makes a SQLite test adapter possible, and keeps the route file reviewable.

**Migrations:** forward-only, applied at boot under an advisory lock, recorded in
`schema_migration`. **No down-migrations** — a rollback is a new forward
migration, exactly like the ledger. If the lock cannot be taken, the process must
**refuse to start** (two instances migrating concurrently is worse than a
downtime).

### 1.3 Calling the file server (the hub is a client of it)

The hub stores `file_ref` rows that point at documents on the gateway, and it
publishes/fetches bodies there. Reuse the client already in the relay
(`jarvis-files.mjs` semantics):

| Action | Call |
|---|---|
| login | `POST {GATEWAY_BASE}/auth/login` |
| refresh | `POST {GATEWAY_BASE}/auth/refresh` — **rotates BOTH tokens; the old one is consumed** |
| create/read/update/delete | `POST {GATEWAY_BASE}/mcp` → `tools/call` |
| body read | `read_session { include_html: true }` → returns `html` |
| optimistic concurrency | `if_version` on updates |

`GATEWAY_BASE` is plain `http://167.172.77.136` today. The hub must treat a
gateway outage as `GATEWAY_DOWN` (`503`) and must **never** cache a body into
`file_ref` to "make it work offline" — see §3.7.

---

## 2. Configuration

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string |
| `SECRET_KEY` | **yes in prod** | AES-256-GCM key for `app_secret.ciphertext`. **Fail closed**: if absent and secrets already exist, refuse to serve them rather than returning `''` |
| `PORT` | no (default `8080`) | hub listen port |
| `HUB_PUBLIC_URL` | no | absolute base for `Location` headers |
| `GATEWAY_BASE` | **yes** | file server origin, e.g. `http://167.172.77.136` |
| `GATEWAY_USER` / `GATEWAY_PASS` | **yes** | file server credentials |
| `LLM_PROVIDER` | no | `deepseek` locally; the summariser reads this |
| `OPENROUTER_API_KEY` | for summaries | the one LLM credential — **jev shares it** (it is not a second credential) |
| `SUMMARISE_MODEL` | no | model used by the summariser |
| `MEMORY_DIGEST_WORDS` | no (default `400`) | summary word ceiling |
| `MEMORY_MAX_WORDS` | no | the folding threshold |
| `DEFAULT_MODEL` | no | `inclusionai/ling-3.0-flash-sante:free` |
| `ALLOWED_EMAILS` | **yes** | owner whitelist |
| `LOG_LEVEL` | no | |

**⚠ Never log a token, a query string containing `?token=`, or a secret.**
`readToken` accepts `?token=` on `GET` (§4.4); an access log that records the
full URL is a credential leak.

---

## 3. Database

### 3.0 The one paragraph of doctrine

The current system stores **one last-write-wins blob per channel** and encodes
several merge rules *implicitly* by comparing an `updatedAt`. This schema
decomposes that blob into rows and must **keep every merge rule, made explicit**.
Three rules are load-bearing and each prevents a bug that already shipped:

| Rule | Where it lives |
|---|---|
| `todo`/`docs`/`notes`/`files` **replace**, never union | `PUT` is a whole replace; tombstones for clears |
| `sessions` **merge by union**, richer-wins, tombstone-filtered | `UNIQUE(session_id,seq)` + `turn_count` + `session_tombstone` |
| `ledger` and summaries are **append-only** | `CREATE RULE … DO INSTEAD NOTHING` |

### 3.1 Conventions

| Concern | Convention |
|---|---|
| Ids | `uuid` (`gen_random_uuid()`); gateway doc ids are 32-hex → `text` + `CHECK (id ~ '^[0-9a-f]{32}$')` |
| Timestamps | `timestamptz` internally; the wire uses **ms-epoch numbers**. Convert in the repository, **never in the route** |
| Soft delete | `deleted_at timestamptz NULL` + partial indexes `WHERE deleted_at IS NULL` |
| Collection order | **`ordinal integer`**, not `created_at`. Array position is data |
| Free-form | `jsonb` only for `args` (**no** — see below) and `payload` |
| Enums | native Postgres enum types (additive via `ALTER TYPE … ADD VALUE`) |
| Secrets | `text` holding **ciphertext**. Never plaintext, never in a broadcast read |
| Revisions | `bigint`, bumped **inside the same transaction** as the write |

### 3.2 `0001_init.sql` — identity and access

```sql
CREATE TABLE schema_migration (
  version    integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE pair_status AS ENUM ('pending','approved','revoked');

CREATE TABLE app_user (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

-- The token is stored HASHED: a database dump must not be a set of live
-- credentials (today's .g2-hub-auth.json stores them raw).
CREATE TABLE auth_session (
  token_hash   text PRIMARY KEY,          -- sha256 of the 48-hex token
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
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

-- MCP is its own trust boundary, so it gets its own credential.
CREATE TABLE mcp_token (
  token_hash   text PRIMARY KEY,          -- sha256 of the mcp_<32hex> token
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  label        text NOT NULL DEFAULT 'mcp',
  scopes       text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX mcp_token_user ON mcp_token(user_id) WHERE revoked_at IS NULL;
```

**Credential dispatch is shape-first, and that is deliberate** — it keeps
`readToken` a pure string function (deployed bundles call it) and avoids a table
scan per request:

| Token shape | Table | Principal |
|---|---|---|
| 48 hex chars | `auth_session` unrevoked | `{ kind:'owner', userId, email }` |
| 36-char UUID | `device` where `status='approved' AND revoked_at IS NULL` | `{ kind:'device', userId, deviceId }` |
| `mcp_<32 hex>` | `mcp_token` unrevoked | `{ kind:'mcp', userId, scopes }` |
| anything else | — | `null` → `401 NO_CREDENTIAL` |

### 3.3 `0001_init.sql` — hub aggregate

```sql
CREATE TYPE section_id AS ENUM ('todo','docs','files','notes','agents');

CREATE TABLE hub_state (
  user_id        uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  active_section section_id NOT NULL DEFAULT 'todo',
  active_doc_id  uuid,                -- NULL → fall back to the first doc
  rev            bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE todo_item (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  ordinal    integer NOT NULL,
  text       text NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX todo_item_order ON todo_item(user_id, ordinal);
CREATE UNIQUE INDEX todo_item_ordinal ON todo_item(user_id, ordinal);

CREATE TABLE document (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  ordinal    integer NOT NULL,
  title      text NOT NULL DEFAULT 'Untitled',
  content    text NOT NULL DEFAULT '',    -- UNBOUNDED on purpose (§3.4)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX document_list   ON document(user_id, ordinal) WHERE deleted_at IS NULL;
CREATE INDEX document_recent ON document(user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE note (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  content    text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A REFERENCE. There is deliberately NO body/html column, and none may be added.
CREATE TABLE file_ref (
  id             text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title          text NOT NULL DEFAULT '',
  agent          text NOT NULL DEFAULT '',
  slug           text,
  tags           text[] NOT NULL DEFAULT '{}',
  url            text NOT NULL,
  size           bigint NOT NULL DEFAULT 0,
  version        integer,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  deleted_reason text
);
CREATE INDEX file_ref_list ON file_ref(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX file_ref_tags ON file_ref USING gin (tags);
```

**⚠ Reordering must be one statement.** `todo_item_ordinal` is unique per user; a
client that rewrites ordinals one row at a time will collide mid-loop. Reorder is
`UPDATE … FROM (VALUES …)` inside one transaction, or a full replace.

**⚠ `document.content` is `text` with no cap.** The whole-file read contract
(`BODY_MAX_CHARS = 60_000`, a *measured* ceiling) governs what is **returned to a
model**, not what may be **stored**. A stored doc is complete.

**⚠ `file_ref` must never gain a body column.** `HubState` is broadcast to every
device and mirrored by the relay, so a body here lands in a public-ish place; and
a 4 MiB document blows the glasses' 999-UTF-8-byte frame budget regardless. A
migration that "helpfully" denormalises `html` into this table is the single most
damaging change possible to this schema. The invariant check `filesNoBody` (§8)
asserts the absence.

### 3.4 `0001_init.sql` — agents aggregate

```sql
CREATE TYPE tool_kind   AS ENUM ('web','http','jev','files','todo','docs','notes','location');
CREATE TYPE http_method AS ENUM ('GET','POST');
CREATE TYPE web_depth   AS ENUM ('basic','advanced');

CREATE TABLE llm_settings (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  provider   text NOT NULL DEFAULT 'openrouter',
  model      text NOT NULL DEFAULT 'inclusionai/ling-3.0-flash-sante:free',
  referer    text NOT NULL DEFAULT '',
  title      text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- hasKey is DERIVED at read time: EXISTS(select from app_secret where key='llm').
-- It is never a stored boolean.

CREATE TABLE tool (
  id            text PRIMARY KEY,        -- 'tool-web', 'tool-jev', … seed ids are literals
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          tool_kind NOT NULL,
  description   text NOT NULL DEFAULT '',
  url           text,
  method        http_method,
  body_template text,
  has_token     boolean NOT NULL DEFAULT false,   -- the BOOLEAN only, never the token
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
  prompt        text NOT NULL DEFAULT '',   -- backfilled to '' historically
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

**⚠ `ensureWebTool()` is a repository responsibility.** If a user's tool list
contains no `kind:'web'` row, `agents.read()` **injects** one. An install carrying
only a legacy `tavily` tool would otherwise lose web search entirely, and a fresh
bundle against a clean database would silently have no search. Assert with the
`webToolPresent` check (§8).

### 3.5 `0001_init.sql` — sessions (the canonical Jarvis store)

```sql
-- 'agent' = a run of an AgentDef; 'voice' = a spoken exchange;
-- 'note'  = a passive capture (a dictated memo, a location ping).
CREATE TYPE session_kind   AS ENUM ('agent','voice','note');

-- ⚠ TWO DIFFERENT STATUS UNIONS EXIST IN THE SOURCE CODE. Do not unify them.
--   Live, in-memory AgentRun / MonitorStatus (stream.ts:434, monitor.ts:26)
--       = 'running' | 'done' | 'error' | 'stopped'
--   Persisted AgentSession.status (types.ts:252 — shipped client type)
--       = 'running' | 'done' | 'error'
-- The row must accept the 4-value live set, because the relay projects a run
-- into a session, and 'stopped' is a legitimate outcome of one (the wearer
-- cancelled it). The API PROJECTION normalises 'stopped' -> 'done' on the way
-- out, because the shipped glasses client's switch has no 'stopped' arm and an
-- unmatched value renders as a blank status. Add the value to the type; map it
-- in the projection. Do not add it to the client union.
CREATE TYPE session_status AS ENUM ('running','done','error','stopped');
CREATE TYPE message_role   AS ENUM ('user','assistant','tool','system');

CREATE TABLE jarvis_session (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind            session_kind NOT NULL,
  agent_id        uuid REFERENCES agent(id) ON DELETE SET NULL,   -- NULL for 'voice'
  run_id          uuid,                     -- the AgentRun that produced it, when there was one
  title           text NOT NULL DEFAULT '',
  status          session_status NOT NULL DEFAULT 'done',
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  turn_count      integer NOT NULL DEFAULT 0,   -- trigger-maintained: the size guard's input
  word_count      integer NOT NULL DEFAULT 0,   -- trigger-maintained
  summary_version integer NOT NULL DEFAULT 0,
  deleted_at      timestamptz,
  pinned          boolean NOT NULL DEFAULT false
);
CREATE INDEX session_list   ON jarvis_session(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX session_agent  ON jarvis_session(user_id, agent_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX session_kind   ON jarvis_session(user_id, kind, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX session_pinned ON jarvis_session(user_id) WHERE pinned AND deleted_at IS NULL;

CREATE TABLE session_message (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES jarvis_session(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  role       message_role NOT NULL,
  content    text NOT NULL DEFAULT '',
  tool       text,
  args       text,                        -- JSON as a STRING (matches AgentMessage.args)
  at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE INDEX session_message_read ON session_message(session_id, seq);

-- APPEND-ONLY. A re-summarisation is a NEW version; it never overwrites.
CREATE TABLE session_summary (
  session_id uuid NOT NULL REFERENCES jarvis_session(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  model      text NOT NULL,
  kind       text NOT NULL DEFAULT 'digest',   -- 'digest' | 'manual' | 'rollup'
  text       text NOT NULL,
  concepts   text[] NOT NULL DEFAULT '{}',
  entities   text[] NOT NULL DEFAULT '{}',
  decisions  text[] NOT NULL DEFAULT '{}',
  tasks      text[] NOT NULL DEFAULT '{}',
  source_seq_from integer,
  source_seq_to   integer,
  tokens     integer,
  superseded_at   timestamptz,
  PRIMARY KEY (session_id, version)
);
CREATE INDEX summary_fts      ON session_summary USING gin (to_tsvector('english', text));
CREATE INDEX summary_concepts ON session_summary USING gin (concepts);
CREATE INDEX summary_entities ON session_summary USING gin (entities);
CREATE INDEX summary_tasks    ON session_summary USING gin (tasks);

-- The tombstone map, one row per cleared scope. agent_id NULL = "clear everything".
CREATE TABLE session_tombstone (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  agent_id   uuid,
  cleared_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);
```

**⚠ `(user_id, agent_id)` cannot be the primary key when `agent_id` is nullable**
— NULLs are not equal in Postgres, so a second global-clear row would be
permitted. Replace the PK with a `COALESCE` unique index:

```sql
CREATE UNIQUE INDEX session_tombstone_scope
  ON session_tombstone(user_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid));
```

**Why `session_summary.text[]` and not `jsonb`:** Postgres gives a GIN index and
array containment (`entities @> ARRAY['ferry']`) for free, and these are genuinely
flat sets of short strings.

**Why summaries are versioned:** a summary is *derived*. Re-deriving it (better
model, longer session, corrected transcript) must not destroy what an LLM already
cited. This is what makes "refer back to a past session" auditable — you can see
which summary a given answer was built on.

**⚠ `UNIQUE (session_id, seq)` is what makes appending idempotent.** A replayed
append collides harmlessly and the repository reports `applied: false` instead of
duplicating a turn.

**Triggers** (maintain the denormalised counters — they are the merge's
"richer-wins" input, and a `COUNT(*)` per row during a merge is an N+1 on the
hottest path):

```sql
CREATE FUNCTION bump_session_counters() RETURNS trigger AS $$
BEGIN
  UPDATE jarvis_session s SET
    turn_count = (SELECT count(*) FROM session_message m WHERE m.session_id = s.id),
    word_count = (SELECT coalesce(sum(array_length(regexp_split_to_array(trim(m.content), '\s+'), 1)), 0)
                  FROM session_message m WHERE m.session_id = s.id),
    updated_at = now()
  WHERE s.id = COALESCE(NEW.session_id, OLD.session_id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER session_message_counters
  AFTER INSERT OR UPDATE OR DELETE ON session_message
  FOR EACH ROW EXECUTE FUNCTION bump_session_counters();
```

### 3.6 `0001_init.sql` — memory log

```sql
CREATE TABLE memory_turn (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  session_id uuid REFERENCES jarvis_session(id) ON DELETE SET NULL,
  role       message_role NOT NULL,
  text       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_turn_recent  ON memory_turn(user_id, at DESC);
CREATE INDEX memory_turn_session ON memory_turn(session_id, at);

-- The GLOBAL digest (what MEMORY_DIGEST_WORDS describes). Versioned, append-only.
CREATE TABLE memory_digest (
  user_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  version  integer NOT NULL,
  text     text NOT NULL,
  folded   integer NOT NULL,          -- how many turns this digest accounts for
  model    text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);

-- A materialised rollup, not a COUNT over memory_turn on every read.
CREATE TABLE memory_usage (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  words      bigint NOT NULL DEFAULT 0,
  turns      bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**⚠ Crossing the word/char budget triggers FOLDING, never DISCARDING.**
`memory_turn` rows are **never deleted** by compaction; `memory_digest.folded`
records how many are accounted for. Deleting the raw turns makes the digest
unverifiable. Assert with `memoryNotDiscarded` (§8).

### 3.7 `0001_init.sql` — ledger (append-only, enforced)

```sql
CREATE TYPE ledger_effect AS ENUM ('pure','read','write','irreversible');
CREATE TYPE ledger_kind   AS ENUM ('ask','delta','route','call','result','reply','decision','gate','note','error');
CREATE TYPE ledger_by     AS ENUM ('wearer','jarvis','agent','jev','system');
CREATE TYPE ledger_status AS ENUM ('pending','ok','failed','skipped','declined');
CREATE TYPE ledger_locus  AS ENUM ('client','relay');

CREATE TABLE ledger_entry (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  seq     bigint NOT NULL,               -- per-user monotonic, from a sequence
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
CREATE INDEX ledger_run    ON ledger_entry(user_id, run_id, seq);
CREATE INDEX ledger_recent ON ledger_entry(user_id, seq DESC);
CREATE INDEX ledger_refs   ON ledger_entry USING gin (refs);
```

**⚠ Append-only, enforced in the engine, not documented in a comment:**

```sql
-- The application must NOT connect as the schema owner, or it can just
-- ALTER the rule away. Two roles: hub_owner (migrations) and hub_app (runtime).
CREATE ROLE hub_owner LOGIN;
CREATE ROLE hub_app   LOGIN;

CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entry DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entry DO INSTEAD NOTHING;

-- runtime role: INSERT and SELECT on the ledger, nothing else
REVOKE ALL ON ledger_entry FROM hub_app;
GRANT INSERT, SELECT ON ledger_entry TO hub_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hub_app;
```

**⚠ `hub_app` MUST hold `SELECT` on `app_secret`. Do not "harden" that away.**
The relay reads the user's OpenRouter key to make the LLM call that produces a
summary — a revoke-all looks safer and silently breaks every summarise and every
LLM proxy route with a permissions error that reads like a database outage.

So the "never return a secret" guarantee does **not** rest on grants here. It
rests on two things that are actually structural:

1. **The rows are separated by table.** `app_setting` has no secret in it, so the
   only table a "return all settings" handler can reach is safe by construction.
   That is the whole reason `app_secret` is a separate table rather than extra
   `key` values in `app_setting`.
2. **No route returns a secret value, and no broadcast read touches the table.**
   Every secret is exposed to the client only as a derived `hasKey` boolean or a
   4-character `hint` (§3.8). Enforce that with a check in
   `repository/checks.mjs`: grep the route layer for any selection of
   `ciphertext` outside `repository/secret.mjs`.

This one genuinely *is* a code rule, and it should be reviewed as one rather than
implied by a grant.

A revoked `UPDATE` grant is stronger than a code review, and `DATABASE_URL`
must use `hub_app`. A migration that runs as `hub_app` instead of `hub_owner`
is a build error — assert the current role at boot.

**The safety invariant is a query, not a convention:**

```sql
-- MUST return zero rows.
SELECT e.user_id, e.run_id, e.seq
FROM ledger_entry e
WHERE e.effect = 'irreversible' AND e.status = 'ok'
  AND NOT EXISTS (
    SELECT 1 FROM ledger_entry g
    WHERE g.user_id = e.user_id AND g.run_id = e.run_id
      AND g.kind = 'gate' AND g.status = 'ok'
      AND g.seq < e.seq AND g.payload->>'approve' = 'true'
  );
```

> Note the `g.kind = 'gate'` guard. Without it the query flags the approval entry
> itself, which is exactly the bug the old `ungatedIrreversible()` had.

### 3.8 `0001_init.sql` — settings and secrets

```sql
CREATE TABLE app_setting (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key        text NOT NULL,       -- searchProvider, depth, model, referer, title, …
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Secrets are separated from settings so no "return all settings" read can leak
-- one by accident, and so the SELECT grant can differ.
CREATE TABLE app_secret (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key        text NOT NULL,       -- 'llm' | 'search:tavily' | 'search:brave' | 'tool:<toolId>'
  ciphertext text NOT NULL,       -- AES-256-GCM, key from SECRET_KEY
  hint       text NOT NULL DEFAULT '',   -- last 4 chars, for the UI ("sk-…4f2a")
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
```

**`toolTokens` (today a `Map<toolId, token>` in a JSON file) becomes rows keyed
`tool:<toolId>`.** This also fixes a latent bug: the map is stored as an object,
so a tool id colliding with `Object.prototype` would already be unreachable.

**`hasKey` / `tavily` / `jev` / `files.configured` are DERIVED at read time**
from `EXISTS(… app_secret …)`, never stored. A stored boolean goes stale when a
secret is written by a path that forgot to update it.

**Ciphertext, not plaintext.** Derive the key from `SECRET_KEY` and **fail
closed**: absent key + existing secrets → refuse to serve, do not return `''`.

**⚠ `app_secret` must not be readable by the `SELECT` grant used for broadcast
reads.** If the app role can read it, the "never return a secret" rule depends
entirely on code.

### 3.9 `0001_init.sql` — idempotency and sync

```sql
-- Every client-generated operation id that was applied. Bounded by TTL.
CREATE TABLE applied_op (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  op_id      uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  body_hash  text NOT NULL,           -- to detect an op id reused with a new body
  result     jsonb,
  PRIMARY KEY (user_id, op_id)
);
CREATE INDEX applied_op_gc ON applied_op(applied_at);   -- nightly GC, 7-day TTL

-- The server-side view of what a device has. One row per (device, collection).
CREATE TABLE client_cursor (
  device_id  uuid NOT NULL REFERENCES device(device_id) ON DELETE CASCADE,
  collection text NOT NULL,
  rev        bigint NOT NULL DEFAULT 0,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, collection)
);
```

**Why `result` is stored:** a retried op must return the *same* answer, not a
re-execution. Without it, "create todo" is idempotent but "append a turn" is not —
and every increment-shaped mutation in this app (`ordinal`, `version`, `rev`) is
of the second kind.

**`body_hash` makes the `409 DUPLICATE_OP` check possible** — the same op id with
a different body is a loud failure, not a silent wrong apply.

### 3.10 `0001_init.sql` — the `rev` bump

`hub_state.rev` is the **control-plane** stamp, bumped by every write to a hub
child row in the same transaction. It replaces the implicit `updatedAt`
comparison the old `POST /api/stream` performs — same guard, made explicit.

```sql
CREATE FUNCTION bump_hub_rev() RETURNS trigger AS $$
DECLARE v_user uuid;
BEGIN
  v_user := COALESCE(NEW.user_id, OLD.user_id);
  INSERT INTO hub_state(user_id) VALUES (v_user)
    ON CONFLICT (user_id) DO NOTHING;
  UPDATE hub_state SET rev = rev + 1, updated_at = now() WHERE user_id = v_user;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER hub_rev_todo  AFTER INSERT OR UPDATE OR DELETE ON todo_item
  FOR EACH ROW EXECUTE FUNCTION bump_hub_rev();
CREATE TRIGGER hub_rev_doc   AFTER INSERT OR UPDATE OR DELETE ON document
  FOR EACH ROW EXECUTE FUNCTION bump_hub_rev();
CREATE TRIGGER hub_rev_note  AFTER INSERT OR UPDATE OR DELETE ON note
  FOR EACH ROW EXECUTE FUNCTION bump_hub_rev();
CREATE TRIGGER hub_rev_file  AFTER INSERT OR UPDATE OR DELETE ON file_ref
  FOR EACH ROW EXECUTE FUNCTION bump_hub_rev();
CREATE TRIGGER hub_rev_agent AFTER INSERT OR UPDATE OR DELETE ON agent
  FOR EACH ROW EXECUTE FUNCTION bump_hub_rev();
```

### 3.11 What deliberately has NO table

| Thing | Why not |
|---|---|
| `AgentRun` live state | Ephemeral. A finished run becomes a `jarvis_session`; a running one lives in memory — the relay is the only writer and losing an in-flight run on restart is acceptable and already the behaviour |
| `AiState` / `AiStep` / the mirror | A high-frequency transient signal. Persisting it resurrects a stale HUD on the other surface — which is exactly why the channel is transient today |
| The SSE channel map | Rebuilt at boot. `lastState` is just a cache of `repos.hub.get()` |
| `AiControl` frames | Directed and short-lived (`CONTROL_TTL_MS = 15000`) |
| Undo batches (`MAX_BATCHES = 3`) | Session-local UI affordance |
| The capability registry (44 capabilities) | It is **code**; `Capability.run` is a closure. Only its *effects on data* belong here |
| `MemoryView` | Derived |
| Document bodies for `file_ref` | §3.3 |
| A full-text index over `session_message.content` | **Deliberately NOT.** Search over raw transcripts invites "the LLM read your whole history". Search goes over `session_summary`, the reviewed bounded artefact. Raw-message search is a debug affordance scoped to a session id, and is not indexed |

### 3.12 Optional: embeddings

Only if embeddings are ever enabled. **They may rank a retrieved set; they may
never be the only way in** (see §6.4).

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
-- CREATE INDEX session_embedding_ann ON session_embedding USING hnsw (vec vector_cosine_ops);
```

---

## 4. Request contract

### 4.1 Envelope

Success: `{ "ok": true, /* payload */ }`
Failure: `{ "ok": false, "error": "human sentence", "code": "MACHINE_CODE", "details": { } }`

**⚠ This is not stylistic.** Every deployed client does
`const r = await res.json(); if (!r.ok) …` and renders `.error` on the glasses. A
status-code-driven contract would break every shipped bundle. `code` is new and
additive — old clients ignore it.

### 4.2 Status codes

| Code | When | Client must |
|---|---|---|
| `200` | done | — |
| `201` | created (also sets `Location`) | — |
| `204` | deleted, no body | — |
| `400` | malformed body / bad enum | fix and retry |
| `401` | credential **absent or invalid** | sign in / re-pair |
| `403` | valid credential, insufficient scope | re-consent |
| `404` | no such row, **or a row not owned by the caller** | treat as gone |
| `409` | `rev` mismatch, or a unique collision | **converge, then retry** (§4.7) |
| `412` | `If-Match` failed on a document write | reload the doc |
| `413` | body over the cap | shrink |
| `422` | valid JSON, invalid domain value | fix |
| `429` | rate limited | back off per `Retry-After` |
| `503` | gateway/provider down | outbox retries |
| `5xx` | our fault | outbox retries |

**⚠ 401 vs 403, and the `notifyIfCredentialWasSent` rule.** A `401` may only be
read as "your credential is bad" if a credential was **actually sent**. An
anonymous probe legitimately gets a `401` and must not wipe the user's stored
session. Get this wrong and "signed out" becomes indistinguishable from "the
proxy dropped the header".

**⚠ 404 rather than 403 for a row you do not own.** A `403` on
`GET /docs/:id` for someone else's id confirms the id exists.

### 4.3 Machine codes

```
NO_CREDENTIAL  BAD_CREDENTIAL  SCOPE_DENIED  NOT_FOUND  STALE_REV
REV_REQUIRED   IF_MATCH_REQUIRED  IF_MATCH_FAILED  DUPLICATE_OP
INVALID_ENUM   TOO_LARGE  RATE_LIMITED  NOT_IMPLEMENTED
PROVIDER_DOWN  GATEWAY_DOWN  NOT_CONFIGURED  INTERNAL
```

`NOT_CONFIGURED` is first-class because a large share of runtime failures here are
"no API key yet" and the UI says something different for that than for an outage.

### 4.4 Authentication

All three credentials are read by the same `readToken(req, url)` order —
`?token=` first, then `Authorization: Bearer`:

| Kind | Shape | Reaches |
|---|---|---|
| owner | 48 hex | everything |
| device | 36-char UUID | everything except secret writes and device revocation |
| mcp | `mcp_<32 hex>` | only the scopes on the token |

**⚠ A query token is only ever accepted on `GET`.** An `EventSource` cannot set
headers, so the SSE read path needs `?token=` — but a state change must carry a
header, so a URL never appears in a log next to a mutation.

**MCP scope vocabulary:** `sessions:read`, `sessions:write`, `memory:read`,
`memory:write`, `recall`, `ledger:read`, `settings:read`.

**⚠ An MCP token can never hold a scope that writes a secret or a device.** That
is not expressible in the vocabulary — a missing word is a better guarantee than a
check.

### 4.5 CORS

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, If-Match, Idempotency-Key
Access-Control-Max-Age: 600
```

**⚠ `Authorization` and `Idempotency-Key` MUST be listed.** Omitting
`Authorization` breaks every cross-origin Bearer call in the preflight, before the
request is sent, with a client-side error that looks like a network failure.
`Max-Age: 600` is not an optimisation: a preflight per mutation doubles the
request count on a device that batches writes.

**⚠ Handle `OPTIONS` on every path including unknown ones** (return `204`), or a
typo'd path surfaces as a CORS error instead of a `404`.

### 4.6 The three concurrency headers

Three headers, three jobs. Conflating them is the classic sync bug.

| Header | Direction | Guards against |
|---|---|---|
| `Idempotency-Key` | **request** | a retried write double-applying |
| `rev` (in body) | both | writing onto a **collection** someone else changed |
| `If-Match` / `ETag` | both | writing onto **one document** someone else changed |

**`Idempotency-Key: <uuid v4>`** — first sighting: apply and store
`applied_op(user_id, op_id, body_hash, result)`. Replay within 7 days: return the
stored `result` verbatim with `200` (not `201`) and `Duplicate: true`. Same op id
with a **different** body: `409 DUPLICATE_OP`. (Catches a client that generated
one id for a batch — silently applying the wrong body is far worse than a loud
failure.)

**`rev`** — every collection read returns `rev` and `updatedAt`; every mutating
request may carry the `rev` it believed. Mismatch → `409 STALE_REV` **with the
current server value in `details`**. Omitting `rev` is an unconditional write,
allowed only for the `device` principal on routes where it is the sole writer by
design (`PUT /memory`, `POST /ledger`).

> **⚠ Do NOT weaken this to a `!==` check with no payload.** The old relay replies
> `{ok:true, stale:true}` **and re-broadcasts the winning state** so the refusing
> client immediately learns the winner. A bare rejection with no server state
> deadlocks two devices that both think they are right.

**`If-Match` / `ETag`** — for `document`, `agent` and `session`:
`GET /docs/:id` → `ETag: "<updated_at ms>:<content hash>"`; `PUT` requires
`If-Match` → `412 IF_MATCH_FAILED` with the current document in `details`.

> **Why a doc needs a stricter guard than the collection:** overwriting a document
> the wearer just edited on the other surface is exactly what tap-to-confirm was
> supposed to prevent. The collection `rev` is too coarse — a todo added on the
> phone must not invalidate a browser edit in flight.
>
> **Why the doc `ETag` is content-derived:** `updated_at` is millisecond-resolution
> and two writes inside one millisecond are possible when a run publishes while the
> user saves. A hash makes them distinguishable.

### 4.7 The converge-forward contract

On `409 STALE_REV` / `412 IF_MATCH_FAILED` the client **MUST**, in this order:

1. Adopt the server value from `details.current`.
2. Re-apply its own pending outbox ops **on top of** it (local intent wins for the
   fields the user actually changed).
3. Resubmit with the fresh `rev` / `If-Match`.
4. If step 3 fails again, **drop the local op**, surface a non-blocking notice,
   and leave the server value.

**Why step 4 exists:** an unbounded retry loop against a device that is actively
writing is how a sync engine spins at 100% CPU on a phone. Two attempts, then
concede.

### 4.8 Rate limits

| Scope | Limit | Why |
|---|---|---|
| `POST /sessions/:id/summarize` | 10/min/user | each is a paid LLM call |
| `POST /recall` | 30/min/user | one per utterance; a runaway loop is possible |
| `POST /ledger` | 120/min/user | bulk — the count is low by design |
| `POST /files` | 20/min/user | each publishes to an external service |
| `POST /sync/push` | 60/min/user | a retrying client |
| everything else | 600/min/user | generous; this is a personal app |

`429` carries `Retry-After`. The outbox reschedules, never drops.

---

## 5. REST API — `/api/v1`

Base: `https://<host>/api/v1`. Same origin as the app, so no CORS for the app
itself; the CORS block applies to the MCP/remote clients.

**Column key:** `A` = required auth (`O` owner, `D` device, `M` mcp + scope);
`Idem` = accepts `Idempotency-Key`; `Guard` = `rev` / `If-Match`.

### 5.1 Hub

| Method | Path | A | Idem | Guard | Notes |
|---|---|---|---|---|---|
| `GET` | `/hub` | O D | — | — | whole `HubState` + `rev`. **The one call a cold boot needs** |
| `PUT` | `/hub` | O D | ✔ | `rev` | whole-state replace (the `v1` equivalent of `POST /api/stream`) |
| `PATCH` | `/hub` | O D | ✔ | `rev` | `{ activeSection?, activeDocId? }` only |

`GET /hub` returns **exactly** the `HubState` shape so the glasses renderer needs
no change:

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

`GET /hub` is a **projection**, not a table — one query assembling
`hub_state + todo_item + document + note + file_ref` (`json_build_object` with
lateral aggregates). It exists so the render contract does not change.

> **⚠ `sections.files` is truncated.** Return at most 50 `file_ref` rows and set
> `truncated: true`, because `HubState` is broadcast on every change. The full
> list is `GET /files`.

### 5.2 Todo

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/todos` | O D | — | — | → `{ ok, rev, updatedAt, items: TodoItem[] }` |
| `POST` | `/todos` | O D | ✔ | `rev` | `{ text, done? }` → `201` + `Location` |
| `PUT` | `/todos` | O D | ✔ | `rev` | `{ items: TodoItem[] }` — **whole-collection replace** |
| `PATCH` | `/todos/:id` | O D | ✔ | `rev` | `{ text?, done?, ordinal? }` |
| `DELETE` | `/todos/:id` | O D | ✔ | `rev` | → `204` |
| `POST` | `/todos/reorder` | O D | ✔ | `rev` | `{ ids: string[] }` — the full new order |
| `POST` | `/todos/clear-done` | O D | ✔ | `rev` | → `{ ok, removed: n }` |

> **⚠ `PUT /todos` is a full replace and MUST NOT be implemented as a union.**
> Union-merging `todo` resurrects every deleted item the moment a device with an
> older copy reconnects. This is the single most likely mistake in the whole
> document — because a union *feels* like the safe, merge-friendly choice.

`POST /todos/reorder` exists because array position is data and N `PATCH`es are
neither atomic nor orderable.

### 5.3 Docs

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/docs` | O D | — | — | `?include=content` — **content omitted by default** |
| `POST` | `/docs` | O D | ✔ | `rev` | `{ title?, content? }` |
| `GET` | `/docs/:id` | O D | — | — | → `ETag` |
| `PUT` | `/docs/:id` | O D | ✔ | **`If-Match`** | `{ title?, content }` — the irreversible path |
| `PATCH` | `/docs/:id` | O D | ✔ | `rev` | `{ title?, ordinal? }` — **metadata only** |
| `DELETE` | `/docs/:id` | O D | ✔ | `rev` | soft delete → `204` |
| `GET` | `/docs/:id/revisions` | O D | — | — | reserved → `{ ok:false, code:'NOT_IMPLEMENTED' }` |

> **⚠ `GET /docs` omits `content` by default.** A library of 200 docs each holding
> 18 KB is 3.6 MB per call, on a phone, to paint a list of titles. `include=content`
> exists for the offline prime and nothing else.
>
> **⚠ `PUT /docs/:id` is the ONLY write to `content`, and it requires `If-Match`.**
> `PATCH` deliberately cannot touch `content` — that is how "rename" and "overwrite
> the body" stay distinguishable in an audit, and it keeps `docs.rename`
> (`write`) and `docs.set_content` (`irreversible`, gated) different effects at the
> API layer, matching the capability catalog exactly.
>
> **Doc revisions are NOT in scope for v1.** The Content Gateway already versions
> published documents properly. The reserved path returns `NOT_IMPLEMENTED` so
> nothing incompatible claims it later.

### 5.4 Notes

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/notes` | O D | — | — | → `{ ok, rev, content, updatedAt }` |
| `PUT` | `/notes` | O D | ✔ | `rev` | `{ content }` — **whole-blob replace** |
| `POST` | `/notes/append` | O D | ✔ | `rev` | `{ text }` |

Both replace and append exist because the capability catalog has both
(`notes.set` is irreversible and gated; `notes.append` is a plain write).
Collapsing them would make an irreversible action reachable through a non-gated
route. `append` is idempotent by `Idempotency-Key` **only** — which is exactly the
case `applied_op.result` exists for.

### 5.5 Files (gateway-backed)

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/files` | O D | — | — | `?limit&cursor&q&agent&tag&includeDeleted` → refs only |
| `POST` | `/files` | O D | ✔ | `rev` | `{ html, title?, agent?, tags?, id?, slug?, overwrite? }` — publish to gateway, then insert the ref |
| `GET` | `/files/:id` | O D | — | — | metadata only — **never the body** |
| `GET` | `/files/:id/text` | O D | — | — | the WHOLE body, no default window |
| `GET` | `/files/:id/media` | O D | — | — | extracted media refs |
| `GET` | `/files/:id/revisions` | O D | — | — | |
| `POST` | `/files/:id/restore` | O D | ✔ | — | |
| `DELETE` | `/files/:id` | O D | ✔ | — | `?hard=true` for a real delete |
| `GET` | `/files/stats` | O D | — | — | |

> **⚠ `POST /files` is idempotent in TWO layers, both required.** The client-supplied
> 32-hex `id` makes the *gateway* publish idempotent; `Idempotency-Key` makes the
> *row insert* idempotent. Relying on one means a retry either doubles a document on
> the gateway or doubles a row locally.
>
> **⚠ `GET /files/:id/text` returns the whole body with no default window.** The
> model needs the full text to modify the file. The response carries `offset`,
> `limit`, `total`, `next`, `more` so a client *may* paginate, but `next: null,
> more: false` on a normal read. `BODY_MAX_CHARS = 60_000` is a **measured ceiling**
> (80 000 clips against the 120 000-char model budget), **not a window** — do not
> reintroduce a default window.

### 5.6 Agents, tools, settings

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/agents` | O D | — | — | → `{ ok, rev, updatedAt, agents, tools, llm }` (no sessions) |
| `POST` | `/agents` | O D | ✔ | `rev` | `{ name, systemPrompt?, prompt?, toolIds?, model? }` |
| `GET` | `/agents/:id` | O D | — | — | |
| `PUT` | `/agents/:id` | O D | ✔ | **`If-Match`** | whole-agent last-write-wins |
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

> **⚠ `GET /agents` must apply `ensureWebTool()`** (§3.4), or a fresh bundle
> against a clean database silently has no web search.
>
> **⚠ `GET /settings` never returns a secret, not even masked.** Return
> `{ openrouter: true, tavily: true, brave: false, jev: true, files: { configured: true, mode: 'api_key' } }`
> plus a `hint` (last 4 chars) and a `source` per field
> (`'env' | 'settings' | 'default' | 'none'`). A masked key is still a key-shaped
> secret in a response body that gets logged.

### 5.7 Sessions

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/sessions` | O D M`read` | — | — | `?kind&agentId&limit&cursor&includeDeleted&pinned` |
| `POST` | `/sessions` | O D M`write` | ✔ | — | `{ kind, agentId?, runId?, title?, status?, messages? }` |
| `GET` | `/sessions/:id` | O D M`read` | — | — | metadata + `summaryVersion`, **no messages** |
| `PATCH` | `/sessions/:id` | O D M`write` | ✔ | `If-Match` | `{ title?, status?, pinned? }` |
| `DELETE` | `/sessions/:id` | O D M`write` | ✔ | — | soft delete |
| `GET` | `/sessions/:id/messages` | O D M`read` | — | — | `?afterSeq&limit` → cursor |
| `POST` | `/sessions/:id/messages` | O D M`write` | ✔ | — | `{ seq?, messages: AgentMessage[] }` — **append-only** |
| `POST` | `/sessions/:id/summarize` | O D M`write` | ✔ | — | generate a **NEW** summary version |
| `GET` | `/sessions/:id/summaries` | O D M`read` | — | — | all versions, newest first |
| `GET` | `/sessions/search` | O D M`read` | — | — | `?q&entities&concepts&tasks&from&to&limit` — **over summaries** |
| `POST` | `/sessions/clear` | O D | ✔ | — | `{ agentId? }` → writes a **tombstone** |
| `GET` | `/sessions/stats` | O D M`read` | — | — | counts, words, summary coverage |

**`POST /sessions` — save with a summary in one call:**

```jsonc
// request
{ "kind": "voice",
  "agentId": null,
  "runId": "…",
  "title": null,                       // server seeds from the first utterance
  "messages": [ { "role": "user", "text": "…", "at": 173… } ],
  "summary": null,                     // ← null means "write one for me"
  "summarise": "auto" }                // "auto" | "always" | "never"

// response
{ "ok": true, "sessionId": "…", "applied": true, "seq": 12,
  "summary": { "version": 1, "text": "…", "model": "…", "generatedAt": 173… },
  "summarised": true, "summariseSkipped": null }
```

#### 5.7.1 ⚠ The summary is generated inside the same request

The reasoning is a **failure mode**, not an optimisation. If saving and
summarising are two separate calls, then a client saves, succeeds, and never
summarises. Nothing errors, nothing is missing — the corpus simply has sessions
with no summaries, which makes recall fall back to titles, which makes it useless,
and **there is no signal anywhere that it happened**. Making it one call makes the
good outcome the default and the bad outcome require deliberate action
(`summarise: "never"`).

#### 5.7.2 The summary contract (reused verbatim from `memory.ts`)

| Rule | Value |
|---|---|
| Words | ≤ `MEMORY_DIGEST_WORDS = 400` |
| Person | third person ("the user") |
| Format | prose — **no markdown, no lists, no emoji** |
| Merge | **fold into the previous summary** rather than restart |
| Keep | names, dates, preferences, decisions, outstanding tasks |
| Drop | pleasantries, failed attempts, repeats |
| On failure | **non-destructive** — keep the old summary, report `summariseError` |

**Why no markdown/lists:** the summary is injected into a prompt that is *also
rendered in part on a 576×288 4-bit display* with a firmware font. A bulleted
summary survives the prompt and breaks the display.

**Why fold rather than restart:** a restart-summary loses anything mentioned once
and not repeated. Folding is the only way a preference stated once survives.

#### 5.7.3 ⚠ Failure must be non-destructive

| Outcome | `summarised` | Side effect |
|---|---|---|
| generated | `true` | insert a new `session_summary` version |
| provider down / no key | `false` + `summariseSkipped:'no provider'` | **write nothing**; session is saved |
| generated but unusable (too long / wrong shape) | `false` + `summariseSkipped:'rejected: …'` | **write nothing**; the previous version stands |

**⚠ A failed summarise must never write an empty or partial summary, and must
never overwrite a previous version.** An empty summary is worse than no summary: it
makes recall return the session with nothing to match on and no way to tell it
apart from a genuinely empty one.

**⚠ Summarisation is never on the write's critical path to correctness.** The
session row and its messages are committed **before** the summary call. A
summariser outage must not lose a transcript.

#### 5.7.4 ⚠ The summariser must be a tool-free LLM call

Send **no `tools`**. A summariser that can call tools can decide to call
`sessions_read` while summarising, and that recursion — summarise → read →
summarise — is unbounded with no natural termination. The summary call is a plain
chat completion with a system prompt and no tool schema, and **no code path may
add one**.

#### 5.7.5 Endpoint warnings

> **⚠ `POST /sessions/:id/messages` is append-only and MUST return `applied`.**
> A replay collides on `UNIQUE(session_id, seq)`; the response is
> `{ ok: true, applied: false, seq }` — not an error, because the client's outbox
> is doing the right thing and must not be told it failed.
>
> **⚠ `GET /sessions/:id` does NOT return messages.** A transcript is the largest
> thing in this system; a list view that eagerly fetched 30 of them is why the old
> design capped sessions at 5.
>
> **⚠ `POST /sessions/clear` writes a tombstone and MUST NOT delete rows.** The
> tombstone is the only reason an explicit clear survives a union merge. Deleting
> the rows makes the clear indistinguishable from "this device never saw them" —
> which is what resurrected history.

### 5.8 Memory

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/memory` | O D | — | — | → the `JarvisMemory` projection (`versions, digest, digestAt, folded, turns, words, capWords`) |
| `PUT` | `/memory` | O D | ✔ | — | whole-state replace (legacy clients) |
| `POST` | `/memory/turns` | O D | ✔ | — | `{ role, text, at?, sessionId? }` — append |
| `POST` | `/memory/compact` | O D | ✔ | — | fold older turns into a **new** digest version |
| `DELETE` | `/memory` | O D | ✔ | — | clears turns **and** digests, writes a tombstone |

`POST /memory/compact` accepts an optional injected summariser for tests
(`{ respond?: string }`) — the same injection pattern the tool router uses, so the
whole compaction path is testable with no network.

### 5.9 Ledger

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/ledger` | O D M`ledger:read` | — | — | `?runId&sinceSeq&limit&kind&effect` |
| `POST` | `/ledger` | O D | ✔ | — | `{ entries: EntryInput[] }` — **bulk append** |

**⚠ There is no `PUT` and no `DELETE`, ever.** The append-only rule is enforced in
the database (§3.7); the absence of the route is the API-level expression of the
same fact.

Bulk append exists because a run produces ~20 entries in a burst, and one request
per entry on a phone radio is the difference between a run that logs and one that
does not.

### 5.10 Sync

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `GET` | `/sync/pull` | O D | — | — | `?since=<rev>&collections=&sinceSeq=` |
| `POST` | `/sync/push` | O D | ✔ | — | `{ ops: Op[] }` |
| `POST` | `/sync/prime` | O D | — | — | the budgeted offline prime |

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
// the Op the server must accept
interface Op {
  opId: string;              // uuid v4 — also the Idempotency-Key
  at: number;                // client clock, display ordering only
  collection: 'todo'|'docs'|'notes'|'files'|'agents'|'tools'|'settings'
            |'sessions'|'memory'|'ledger'|'hub';
  action: 'create'|'update'|'delete'|'replace'|'append'|'clear'|'reorder';
  targetId?: string;
  baseRev?: number;
  ifMatch?: string;          // document ETag for content writes
  payload: unknown;
  attempts: number;
  lastError?: string;
  retryAt?: number;
}
```

```ts
// POST /sync/push
{ ops: [ /* Op[] */ ] }
→ { ok: true, rev: 435,
    applied:  ['op-uuid-1','op-uuid-2'],
    duplicate:['op-uuid-3'],
    rejected: [ { opId:'op-uuid-4', code:'STALE_REV',
                  details:{ rev: 433, current: { /* the winning value */ } } } ],
    serverTime: 173… }
```

> **⚠ `replace` means replace.** The pull response honours each collection's merge
> policy: `todo`/`docs`/`notes` come back as complete arrays to be **substituted**,
> while `sessions` comes back as a delta to be **unioned**. The response says which
> **by its shape** (`replace` vs `items`/`tombstones`) so a client cannot apply the
> wrong policy by accident.
>
> **⚠ Each op is applied in its own transaction.** A batch is a sequence of atomic
> applications, not one transaction — a partial batch is far more useful than an
> all-or-nothing batch, because the client gets per-op results and retries only the
> failures.
>
> **⚠ `dependsOn` is honoured server-side too.** An op may carry
> `dependsOn: string[]` (op ids). A create+update pair in one batch must not be
> applied in whatever order the server happens to iterate, or the update hits a row
> that does not exist yet.

### 5.11 Recall — the JEV entry point

| Method | Path | A | Idem | Guard | Body |
|---|---|---|---|---|---|
| `POST` | `/recall` | O D M`recall` | ✔ | — | `{ text, limit?, top?, minScore?, includeMessages? }` |

```jsonc
// request
{ "text": "what did I decide about the ferry booking", "limit": 12, "top": 3 }

// response
{ "ok": true,
  "selected": [
    { "sessionId": "…", "title": "…", "at": 173…, "kind": "voice",
      "summaryVersion": 2, "summary": "…", "score": 0.91 }
  ],
  "candidates": 7,                  // how many were retrieved before ranking
  "ranked": true,                   // false → the ranker failed and recency was used
  "reason": "ranked 7 candidates",  // the SAME vocabulary the tool router uses
  "serverTime": 173… }
```

**The pipeline (7 steps):**

1. **Retrieve** — full-text + containment over `session_summary` (never over raw
   messages), newest-first, capped at `limit`.
2. **Guarantee the floor** — a **recency fallback** is always in the candidate set,
   so an unrelated `q` still returns something the user recognises.
3. **Label** the candidates (`c0…cn`) by construction, not by position.
4. **Rank** via jev (`choice` mode for recall) — `POST
   https://openrouter.ai/api/alpha/decisions`.
5. **Relabel** — map jev's answer keys back to session ids.
6. **Order** by the ranking; truncate to `top`.
7. **Fail open** — any failure at 4 or 5 returns `ranked:false` with a `reason`
   and the recency order, never an error.

**⚠ `ranked:false` MUST be surfaced**, not silently swallowed — a caller that
cannot tell "ranked and chose X" from "could not rank, here is recency" will
present a guess as a decision.

### 5.12 Diagnostics

| Method | Path | A | Body |
|---|---|---|---|
| `GET` | `/health` | public | `{ ok, version, db: 'up'|'down', migrations: n, time }` |
| `GET` | `/diag/invariants` | **O** | runs every check in §8 |
| `GET` | `/diag/schema` | **O** | the tool schemas the relay will send, post-drift-fold |

`GET /diag/schema` exists because silent schema drift between the capability layer
and the relay's tool schema is a class of bug that otherwise only shows up as a
model that stops calling a tool.

### 5.13 Deprecation

| Old | New | Removal |
|---|---|---|
| `POST /api/stream` (write) | `PUT /hub`, `/todos`, `/docs`, `/notes` | deprecate + `Sunset` header, then remove one release later |
| `GET /api/stream` (read) | **stays** | not planned |
| `/api/agent/*` | `/sessions*`, `/agents*` | later |
| `/api/settings` | `/settings`, `/settings/secrets` | later |
| `/api/files/*` | `/files/*` | later — thin re-export until then |
| `/api/tool`, `/api/decisions`, `/api/llm` | unchanged — stateless proxies, not storage | not planned |
| `/api/auth/*`, `/api/pair/*`, `/api/devices` | unchanged (repository swap only) | not planned |

**Rule:** no route is removed until its `v1` equivalent has shipped and the
deployed `/app.json` version is at least **one release newer** than the version
that first shipped `v1`. A cached bundle in the Even App is the failure mode this
ordering prevents.

---

## 6. The MCP server

### 6.1 Transport and methods

`POST /mcp/hub` (published by the proxy; internally `/mcp`) — **JSON-RPC 2.0 over
HTTP**, protocol version **`2024-11-05`**. **Stateless**: no `Mcp-Session-Id`, no
server-initiated messages, no streaming transport. Every tool here is
request/response, and a stream would add the browser socket-cap problem to a
machine client that does not need it.

| Method | Response |
|---|---|
| `initialize` | protocol version, capabilities, server info |
| `tools/list` | the stable tool list with JSON Schemas |
| `tools/call` | `content` blocks |
| `notifications/initialized` | `204` |

```jsonc
// initialize
→ { "jsonrpc":"2.0", "id":1, "result": {
      "protocolVersion": "2024-11-05",
      "capabilities": { "tools": { "listChanged": false } },
      "serverInfo": { "name": "g2-even-hub", "version": "1.0.0" } } }

// tools/list
→ { "jsonrpc":"2.0", "id":2, "result": { "tools": [
      { "name":"sessions_save", "description":"…",
        "inputSchema": { "type":"object",
                         "properties": { … },
                         "required": [ … ],
                         "additionalProperties": false } } ] } }

// tools/call
{ "jsonrpc":"2.0", "id":3, "method":"tools/call",
  "params": { "name":"sessions_save", "arguments": { … } } }
→ { "jsonrpc":"2.0", "id":3, "result": {
      "content": [ { "type":"text", "text":"Saved session … (summary v1, 118 words)" } ],
      "isError": false } }
```

### 6.2 ⚠ Protocol rules that are easy to get wrong

| Rule | Detail |
|---|---|
| **`listChanged: false` is a promise** | The tool list is stable for the life of a connection. A **user-created** `http` tool must **not** appear in `tools/list` — otherwise a client that cached the list and one that did not disagree about indices. User tools are addressable by name only through `tools/call`, and are not listed |
| **Tool names match `NAME_RE = /^[a-z][a-z0-9_]*$/`** | The model's typed tool syntax and `normalizeToolId` both assume it. `sessions-save` would parse as a subtraction. `MAX_TOOL_NAME = 64`, `MAX_TOOLS = 64` apply |
| **Unknown tool → JSON-RPC error, not `isError`** | `-32601 Method not found` for an unknown method; `-32602 Invalid params` for a bad argument; `-32600 Invalid Request` for a malformed envelope. **`isError:true` is reserved for "the tool ran and the operation failed"** — a provider down, a session that does not exist. Conflating them makes a client unable to tell a protocol bug from a business failure |
| **Every result is one `content` block of `type:'text'`** | short, **ASCII**, emoji-free lines. Same discipline as the capability layer's summaries, and for the same reason: these results are read by a model *and* partly by the firmware font |
| **Auth is `mcp_token`** | `Authorization: Bearer mcp_<32hex>`; scope-checked per tool |

### 6.3 The tool set (twelve)

| Tool | Scope | Args | Returns |
|---|---|---|---|
| `sessions_save` | `sessions:write` | `kind, title?, messages, summary?, summarise?` | `sessionId`, `applied`, `summary`, `summarised` |
| `sessions_list` | `sessions:read` | `kind?, agentId?, limit?, cursor?, pinned?` | one line per session: `id — title (n turns, summary v2)` |
| `sessions_read` | `sessions:read` | `sessionId, includeMessages?, summaryVersion?` | title, status, summary, optionally the transcript |
| `sessions_search` | `sessions:read` | `q, entities?, concepts?, tasks?, from?, to?, limit?` | matching sessions + the matched summary excerpt |
| `sessions_summarize` | `sessions:write` | `sessionId, sinceSeq?` | the new version number and text |
| `sessions_clear` | `sessions:write` | `agentId?, sessionId?` | `removed: n` (via tombstone) |
| `sessions_stats` | `sessions:read` | — | counts, words, **summary coverage %** |
| `memory_read` | `memory:read` | `turns?` | the digest + the newest turns |
| `memory_write` | `memory:write` | `role, text, sessionId?` | `seq` |
| `recall` | `recall` | `text, limit?, top?, minScore?` | the ranked sessions (§5.11) |
| `ledger_read` | `ledger:read` | `runId?, sinceSeq?, limit?` | entries |
| `settings_read` | `settings:read` | — | non-secret config + provenance |

> **⚠ `sessions_save` is ONE tool on purpose** — see §5.7.1. Making it two calls
> guarantees a client that does the first and forgets the second.

**Observability you must ship:** `sessions_stats.summaryCoverage`. It is the only
signal that the "saved but never summarised" failure mode (§5.7.1) is happening.

### 6.4 Retaining the retrieval discipline

`recall` and `sessions_search` search **summaries**, not transcripts.

- Full-text search over `session_summary.text` uses the stored `tsvector`. It works
  with no model, no network, and **no re-index when the summariser is upgraded.**
- `entities`/`concepts`/`tasks` are array containment (`@>`), also indexed.
- **An embedding may re-rank a retrieved set. It may never be the only way in.** A
  corpus findable only via an embedding model becomes unfindable when the model,
  the dimension count, or the vendor changes.

### 6.5 What being an MCP server actually means

The existing `mcp-tools.mjs` is an MCP **client** — it consumes a remote
catalogue. Being a server is the **other half** of the protocol:
`initialize` + capabilities, a stable `tools/list` with JSON Schemas, and
`tools/call` with `content` blocks and `isError`. The client's constants
(`MCP_PROTOCOL_VERSION`, `MAX_TOOL_NAME`, `MAX_TOOLS`) and
`normalizeCatalogue` / `sanitizeInputSchema` are reusable; **the dispatcher is new
code.** Budget for it as new code, not a rename.

---

## 7. Invariants (implement as runnable checks, not comments)

Every load-bearing rule above gets a query in `repository/checks.mjs`, runnable
from `GET /diag/invariants` and asserted in the test suite. **A documented
invariant decays; a failing test does not.**

| Check | Assertion |
|---|---|
| `filesNoBody` | no column in `file_ref` matches `%body%` or `%html%` |
| `ledgerNoUpdate` | `ledger_entry` UPDATE and DELETE grants are absent |
| `ledgerGated` | the query in §3.7 returns zero rows |
| `sessionMonotonic` | every per-session `session_message.seq` set is `0..n-1` with no gaps |
| `summaryVersioned` | `summary_version = max(version)` in `session_summary`, per session |
| `tombstoneScope` | no duplicate `(user_id, COALESCE(agent_id))` in `session_tombstone` |
| `webToolPresent` | every `app_user` with ≥1 agent has ≥1 `tool` of `kind='web'` |
| `memoryNotDiscarded` | `memory_usage.turns >= count(memory_turn)` |
| `ordinalDense` | every `todo_item`/`document`/`agent_tool` ordinal set per parent is `0..n-1` |
| `roleSeparation` | the runtime role is `hub_app` (never `hub_owner`), and `ledger_entry` has no `UPDATE`/`DELETE` grant for it |
| `noSecretInRoutes` | no module outside `repository/secret.mjs` selects `app_secret.ciphertext` |
| `summaryCoverage` | reported (not asserted) — `count(sessions) - count(sessions with a summary)`. The only signal for the §5.7.1 failure mode |

---

## 8. Import from the existing three JSON files

On boot, **if and only if** the user has zero rows in `app_user`/`hub_state`,
import the three files (path-configurable; today they live beside the relay in
`web/`):

| File | → |
|---|---|
| `.g2-hub-auth.json` | `app_user`, `auth_session` (**hash the tokens on the way in**), `device` |
| `.g2-hub-secrets.json` | `app_setting` + `app_secret` (**encrypt on the way in**) |
| `.g2-hub-state.json` | `hub_state`, `todo_item`, `document`, `note`, `file_ref`, `agent`, `tool`, `agent_tool`, `llm_settings`, `jarvis_session`, `session_message`, `session_tombstone` |

Mapping notes:

| Source | Target |
|---|---|
| `data.agents[].sessions[].messages[]` | `session_message` rows with `seq = index` |
| `data.agents[].sessions[]` | `jarvis_session` with `kind='agent'`, `agent_id` from the parent |
| `data.sessionsClearedAt` | `session_tombstone` rows |
| a `ToolDef.hasToken === true` | `tool.has_token = true`, **and** the token text from `toolTokens` → `app_secret('tool:<id>')` |
| `hub:ai-memory` turns | `memory_turn` rows; the digest → `memory_digest` v1 |
| `hub:docs` / `hub:devices` L1 keys | not imported (they are client caches, not server state) |

**⚠ `sections.files` in the legacy blob holds `FileRef` rows only — never bodies.**
If an imported row has a body-like field, drop it and log loudly; that would be the
one case where the legacy file violated the hard rule.

**Verification before you trust the import:** count-and-hash per collection, both
sides, printed to the log. Phase A is only done when the disagreement counter is
zero over a full day of real use.

---

## 9. Build order (a checklist you can execute)

**Phase A — schema + read-only API + dual-write**

1. `0001_init.sql` (§3.2–§3.10), migration runner + advisory lock.
2. `repository/` per aggregate.
3. `checks.mjs` (§7) + `GET /health` + `GET /diag/invariants`.
4. Boot import (§8) + the count-and-hash verification.
5. Read-only `GET` endpoints: `/hub`, `/todos`, `/docs`, `/notes`, `/files`,
   `/agents`, `/tools`, `/settings`, `/sessions`, `/memory`, `/ledger`.
6. Dual-write: keep writing the JSON files, log every disagreement.

**Exit:** `diag/invariants` all green; every `GET` payload matches the legacy
payload field-for-field; **zero disagreement-log entries over a full day**.

**Phase B — authoritative database + the write API**

7. Flip reads to the repository; the JSON file is read only on a first boot.
8. `rev` + the `409 STALE_REV` guard; `If-Match` on docs/agents/sessions.
9. `applied_op` + `Idempotency-Key` on every mutating route.
10. All the write routes in §5 (POST/PUT/PATCH/DELETE) + `/sync/pull|push`.
11. `ensureWebTool()` in `agents.read()`; derived `hasKey`/`settings`.
12. Periodic snapshot (every 5 min) to the JSON file, purely as a catastrophe net.

**Exit:** the JSON files can be deleted and nothing is lost.

**Phase C — sessions, MCP, recall, offline**

13. `/sessions*` incl. the one-call save+summarise (§5.7.1–5.7.4).
14. `POST /mcp/hub` — the server (§6), with the twelve tools.
15. `/recall` (§5.11) + `/sessions/search`.
16. `/diag/schema`.
17. Rate limits (§4.8) + `Retry-After`.
18. `Deprecation` + `Sunset` on `POST /api/stream`.

**Exit:** `sessions_stats.summaryCoverage` near 100% after a week; every §7 check
green in production; the old routes removable one release later.

---

## 10. The five rules that matter most

If you read nothing else, these are the ones whose violation is a shipped bug:

1. **`PUT` on `todo`/`docs`/`notes` is a replace, never a union.** A union
   resurrects deletions on reconnect and only reproduces with two devices.
2. **Sessions merge by union; everything else replaces.** `UNIQUE(session_id,seq)`
   + `turn_count` + `session_tombstone` are how that is expressed.
3. **Summarise inside the save.** Two calls guarantees a corpus with no summaries
   and no signal that it happened.
4. **`sections.files` holds references, never bodies.** No body column in
   `file_ref`, ever.
5. **A `409` must carry the server value in `details`.** A bare rejection
   deadlocks two devices that both think they are right.

Plus two that are cheap to get right and expensive to get wrong: **the ledger has
no `UPDATE` and no `DELETE`** (enforce it in the engine), and **an MCP token has
no vocabulary for writing a secret or a device** (enforce it in the scope list).
