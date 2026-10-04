# Relay state persistence + cross-device live sync

**This document is a work order, not a description of what runs today.**

`backend-specs-integration.md` next to it is *generated* from the running
`jarvis-content-gateway` and is always right about the present. This file is the
opposite: it proposes three new routes and describes the app-side work that
depends on them. When the routes exist, the generated spec will absorb them and
this file becomes the *rationale* for them.

It has exactly two audiences, and each has its own part. Read your part, ignore
the other one:

| Part | Audience | What it says |
| --- | --- | --- |
| **Part 1** | the **backend** — `jarvis-content-gateway` | 3 new routes, and the rules they must obey |
| **Part 2** | the **app** — `g2-even-reality-hub` (relay + web client) | what to build, half of which needs nothing from Part 1 |

Everything in Part 2 that does **not** touch `/hub/relay/*` can ship today, in
parallel with Part 1, because it uses only routes that already exist.

---

## 0. The two problems being solved

### 0.1 Signing out, and losing paired devices, on every redeploy

The relay (`web/server/local-sse.mjs`) keeps owner sessions and paired devices
in memory and persists them to **a file on the container's own filesystem**:

```js
// web/server/local-sse.mjs:293-295
const AUTH_FILE = process.env.AUTH_FILE || join(process.cwd(), '.g2-hub-auth.json');
```

The relay is deployed on Railway with no volume and no `AUTH_FILE` override, so
that file is recreated empty on every deploy. Consequences, both observed:

* an owner session that was still well inside its 30-day TTL stops working, the
  app's `GET /api/auth/me` answers `401`, and the UI drops to the login screen;
* every approved glasses device disappears, so the device has to be paired again.

The relay is the **only** thing on that ephemeral host. The hub database is not:
`hub.sqlite3` lives beside `jarvis-content-gateway` on a persistent host, which
is why 19 documents and 18 agents survive everything while a session token does
not. So the backend is the correct home for this state — and the `app_setting`
table already has the exact shape it needs.

### 0.2 Two devices never see each other's writes

Since the platform migration the web app renders from the hub database, but
**nothing ever tells a second client that the database changed**:

* the relay's `/api/hub*` proxy is a pure passthrough — it forwards bytes and
  broadcasts nothing, so device A's write is invisible to device B;
* the client reads once at boot (`main.ts`) and only re-reads if *its own* write
  loses a `409 STALE_REV` race, which cannot happen for a device that is only
  reading;
* `GET /hub` and `GET /hub/todos` return **no `ETag`** and `cache-control:
  no-store`, so no conditional poll is available either;
* the hub has no push or subscribe route at all.

So the sync has to be driven from the relay, which is the one process that sees
every write. This needs **no backend work** — see §2.3.

---

## Decisions already made

| # | Decision | Consequence |
| --- | --- | --- |
| 1 | Relay state is persisted **through the hub API**, not a Railway volume | needs Part 1; survives any host or restart, not just a redeploy |
| 2 | The owner session is kept in **durable storage in every environment** | a new tab and a browser restart both stay signed in, not just the Even App WebView |
| 3 | Cross-device sync is a **relay nudge + refetch on focus** | no polling traffic, no backend change, reuses the SSE socket that is already open |

---

# Part 1 — backend: `jarvis-content-gateway`

## 1.1 What is being added

One route family, three methods, over the table `app_setting` that **already
exists** (§8 of the generated spec: `user_id`, `key`, `value`, `updated_at`).
There is **no migration and no new table.**

The relay stores its own state as an opaque JSON object. The hub does not
interpret it. That is the whole design: the backend gains a small, bounded,
owner-only state slot; the relay stops depending on local disk.

## 1.2 Route index

Add these three rows to §5 of the generated spec, in the hub family:

| Method | Path | Scope | Success | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/hub/relay/{key}` | `read_relay_state` | 200 | One stored object, or `404 NOT_FOUND` when that key was never written. |
| `PUT` | `/hub/relay/{key}` | `replace_relay_state` | 200 | **Upsert.** Whole-value replace. `rev` is **not** required and **must not** move (§1.6). |
| `DELETE` | `/hub/relay/{key}` | `delete_relay_state` | 204 | Remove one key. `404` when there was none, matching `DELETE /hub/settings/secrets/{key}`. No body. |

`key` is a **path segment**, not a query parameter, and is constrained to
`^[a-z0-9][a-z0-9-]{0,31}$` — lowercase, digits and single hyphens, 1–32
characters. A key that does not match is `400 VALIDATION_ERROR` with
`details.field = "key"`, raised **before** any storage is touched.

The only key in use is `auth`, so today the live set of routes is exactly:

```
GET    /hub/relay/auth
PUT    /hub/relay/auth
DELETE /hub/relay/auth
```

## 1.3 `GET /hub/relay/{key}` → 200

```json
{
  "ok": true,
  "rev": 68,
  "key": "auth",
  "value": { "sessions": { "...": { "...": "..." } }, "devices": { "...": {} } },
  "updatedAt": 1791046286329
}
```

* `value` is whatever was last `PUT`, **byte-identical after a JSON round trip**.
  The backend must not add, drop, reorder or retype anything inside it.
* `updatedAt` is **epoch milliseconds**, like every other hub timestamp (§4.7).
* Never written → `404`, error code `NOT_FOUND`, and `details.key` naming it.
  **Absence is normal, not an error condition** — it is how the relay knows it
  is the first writer and should push its existing local state up (§2.1 step 3).

## 1.4 `PUT /hub/relay/{key}` → 200

Request body:

```json
{ "value": { "sessions": {}, "devices": {} } }
```

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `value` | object | yes | Any JSON **object**. Serialised size ≤ **131072 bytes** (128 KiB). |

Response: **identical in shape to `GET`**, including the `value` that was just
stored and the freshly stamped `updatedAt`. Echoing it back lets the relay
confirm the write landed without a follow-up read.

* Missing `value` → `400 VALIDATION_ERROR`, `details.field = "value"`.
* `value` present but not an object (a string, array, number, or `null`) →
  `400 VALIDATION_ERROR`, `details.field = "value"`.
* Serialised size over the cap → **`413 TOO_LARGE`**, `details.limit = 131072`.
  Use `TOO_LARGE`, not `VALIDATION_ERROR` — that is the code that already means
  "the payload, not the shape" (§11).
* Any top-level key other than `value` → `400 VALIDATION_ERROR` with
  `details.allowed = ["value"]`. Do **not** silently ignore extras; a typo in
  the relay must fail loudly.
* Upsert semantics: create if absent, replace if present, and **always** `200`.
  Never `201` — a `PUT` that is also a create is still a `200` here, matching
  `PUT /hub/settings`.
* `Idempotency-Key` is accepted and honoured per §4.4. The relay does not send
  one, because a whole-value `PUT` is naturally idempotent, but a client that
  does must get replay protection rather than a double write.

## 1.5 `DELETE /hub/relay/{key}` → 204

* Removes the row. **`204` with no body at all** — do not send `.json()`-able
  content.
* The key was absent → `404 NOT_FOUND`, `details.key`. The relay treats a `404`
  here as success, so this is a reporting distinction only.
* Not used by the relay today; it exists so that a corrupted blob can be reset
  without direct database access.

## 1.6 Rules that are easy to get wrong

These are the parts where a reasonable implementation could still be wrong, so
they are stated as requirements rather than implied.

1. **`rev` must not move.** `app_setting` is **not** one of the five tables that
   advance `hub_state.rev` (§4.3). A `PUT /hub/relay/{key}` therefore returns the
   *current* `rev`, unchanged — the same `rev` it returned before the write. If
   this route bumps `rev`, it will invalidate every other client's cached todo
   and document mirrors on a routine session refresh, which is precisely the
   background-refetch storm §4.3 was written to prevent. **A client must not
   infer "something changed" from a `rev` in this response.**
2. **Owner-only.** The route reads and writes credentials. It requires an owner
   credential and must refuse a device-scoped or MCP-scoped one with `403
   SCOPE_DENIED`. Model it on `GET /hub/settings`.
3. **Invisible to MCP.** Do **not** add a tool for it, and do not alias an
   existing one onto it. The hub's MCP surface is what the LLM agent calls; an
   agent that can read this blob can read every live session token. Add a test
   that asserts the tool list is unchanged (12 tools) after this route lands.
4. **Never part of `GET /hub`.** The `hub_state` projection must not include it.
   `GET /hub` is fetched by every client on boot and is ~63 KB already; inlining
   the credential store there would hand every reader the relay's session
   tokens.
5. **Never part of `/hub/sync/pull` or `/hub/sync/push`.** It is not a synced
   collection. The relay is its only writer.
6. **Never part of `GET /hub/diag/schema`** — that endpoint reports the MCP tool
   schemas (§5.12), and this route has no tool.
7. **Rate scope is `default`** (600/min, §4.8). No new scope bucket. The relay
   writes at most once per auth mutation, debounced, so this cannot be a
   meaningful share of the budget.
8. **Storage.** One `app_setting` row per key per user, with the row's `key`
   column namespaced as **`relay:<key>`** (so `relay:auth`). Namespacing keeps
   it from colliding with the settings keys (`searchProvider`, `depth`) that
   legitimately live in that same table, and makes the family greppable in the
   database. `value` is the serialised JSON.
9. **`updatedAt` is server-stamped**, from the same clock as every other
   `*At` in the hub. Do not accept a timestamp from the client.

## 1.7 What the relay will store in the blob

So that the backend owner knows what is being trusted and how big it can get.
The value of `auth` is:

```json
{
  "v": 1,
  "sessions": {
    "<sha256 of the session token, 64 hex chars>": { "email": "…", "createdAt": 1790000000000 }
  },
  "devices": {
    "<deviceId, a UUID>": {
      "deviceId": "…",
      "status": "pending",
      "pairCode": "8S46XW",
      "createdAt": 1790000000000,
      "email": "…",
      "approvedAt": 1790000000000
    }
  }
}
```

* **Session tokens are stored only as SHA-256 digests**, never in the clear, so
  a database dump does not yield a usable credential. The `v` field is a format
  version so a future shape change is detectable.
* **Size expectation: well under 1 KiB.** Sessions are swept on every write —
  expired ones (30-day TTL) are dropped and the list is capped at 50 — and a
  household has a handful of devices. The 128 KiB cap is a guard rail far above
  the real payload, not a target.

## 1.8 Acceptance tests for Part 1

```bash
# 1. absent key is NOT_FOUND, and it is a normal answer
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/hub/relay/auth" | jq -c .
# => {"ok":false,"error":"…","code":"NOT_FOUND","details":{"key":"auth"}}

# 2. round trip — value comes back byte-identical after a JSON round trip
curl -s -X PUT "$BASE/hub/relay/auth" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":{"v":1,"sessions":{"abc":{"email":"a@b.c"}},"devices":{}}}' | jq -c '.value'
curl -s "$BASE/hub/relay/auth" -H "Authorization: Bearer $TOKEN" \
  | jq -c '.value'          # must equal the value just PUT

# 3. rev must NOT move across the write — capture rev, write, re-read
REV_BEFORE=$(curl -s "$BASE/hub" -H "Authorization: Bearer $TOKEN" | jq .rev)
#   ... PUT as above ...
REV_AFTER=$(curl -s "$BASE/hub" -H "Authorization: Bearer $TOKEN" | jq .rev)
[ "$REV_BEFORE" = "$REV_AFTER" ] && echo "PASS rev untouched" || echo "FAIL rev moved"

# 4. GET /hub must not carry the blob
curl -s "$BASE/hub" -H "Authorization: Bearer $TOKEN" | grep -q 'relay' \
  && echo "FAIL: blob leaked into GET /hub" || echo "PASS not in GET /hub"

# 5. MCP tool count unchanged (must still be 12)
#    and PUT /hub/relay/auth is refused for a device-scoped credential
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$BASE/hub/relay/auth" \
  -H "Authorization: Bearer $DEVICE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":{}}'                       # => 403

# 6. validation and size
curl -s -X PUT "$BASE/hub/relay/auth" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'            | jq -r .code  # VALIDATION_ERROR
curl -s -X PUT "$BASE/hub/relay/auth" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"value":"x"}' | jq -r .code  # VALIDATION_ERROR
curl -s -X PUT "$BASE/hub/relay/auth" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"value":{},"junk":1}' | jq -r .code  # VALIDATION_ERROR
curl -s -X PUT "$BASE/hub/relay/Bad Key" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"value":{}}'  | jq -r .code  # VALIDATION_ERROR
# a >128 KiB value => 413 TOO_LARGE

# 7. DELETE is 204 with no body, then 404 the second time
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$BASE/hub/relay/auth" \
  -H "Authorization: Bearer $TOKEN"                      # 204
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$BASE/hub/relay/auth" \
  -H "Authorization: Bearer $TOKEN"                      # 404
```

Test 3 is the one to be pedantic about: it is the only rule here whose violation
is invisible in the route's own response and shows up as *other* clients
re-fetching.

---

# Part 2 — app: `g2-even-reality-hub`

Four changes. §2.1 needs Part 1. **§2.2, §2.3 and §2.4 need nothing from the
backend and can ship immediately.**

## 2.1 Relay: move the auth store into the hub

**File:** `web/server/local-sse.mjs`

Keep the on-disk file exactly as it is — it becomes the local working copy and
the offline fallback, so none of the existing auth logic changes shape. Add a
sync layer around `persistAuthStore()` / the boot load.

1. **On boot**, after the auth store is read from disk, call
   `GET /hub/relay/auth` through the existing hub client:
   * `200` → **adopt the hub's blob** as authoritative, rewrite the local file
     from it. (Hub always wins; the file is a cache.)
   * `404` → the hub has never seen this key. `PUT` the local file's contents up
     as the first write, so an existing deployment's sessions and devices are
     carried over rather than invalidated.
   * unreachable / `5xx` → keep running from the file and retry on a timer.
     **A hub outage must never break sign-in.**
2. **On every mutation** (login, pair request, approve, revoke, logout), keep
   the existing `persistAuthStore()` and add a **debounced (~250 ms)
   `PUT /hub/relay/auth`** with the whole blob. Debouncing matters: approve and
   revoke can fire in the same second.
3. **Hash the session tokens.** Change the sessions map to be keyed by
   `sha256(token)` — lookup hashes the presented token, so `requireOwner` needs
   no new input, and a leaked blob yields no usable credential. On load,
   normalise any legacy entry whose key is not 64 hex characters by re-keying it
   to the digest of that key in place, so **currently signed-in users stay
   signed in across this change.**
4. **Sweep before every write:** drop sessions past the 30-day TTL and cap the
   list at 50 entries, so the blob cannot grow without bound.
5. A hub write failure is logged once and retried; it never rejects the request
   that triggered it. Login succeeds even if the hub is down.
6. **Reconcile before the listener accepts anything.** `loadAuthStore()` is a
   synchronous read at `local-sse.mjs:449`, and `server.listen()` is at line
   3594, so there is room to `await` the hub read in between. Do that, with a
   **~5 s timeout**, and fall back to the file on timeout or failure. This is
   not a nicety: if the listener starts serving first with an empty local file,
   a perfectly valid token gets a `401` for a moment, and the client's
   `onAuthRejected` path signs the user straight out — which is the bug being
   fixed, reintroduced as a startup race. A short boot delay is the correct
   trade.

## 2.2 Relay: broadcast a change nudge

**File:** `web/server/local-sse.mjs`

This is the fix for §0.2 and it is entirely local. The relay already has an SSE
channel named `hub` with a fan-out helper used by `publishHubState()`; reuse it.

* In the `/api/hub/*` passthrough, **after** a successful mutating call
  (`POST`/`PUT`/`PATCH`/`DELETE` with a `2xx`), fan a small frame out to the
  `hub` channel's clients:

  ```json
  { "type": "hub-changed", "path": "/todos", "rev": 69, "origin": "<client id>" }
  ```

  `path` is the **hub-relative** first segment of the upstream path
  (`/hub/todos` → `/todos`, `/hub/docs/<id>` → `/docs`), so a client can refetch
  just the affected collection instead of the whole ~63 KB snapshot.
* Include an `origin` identifier and have the writing client ignore its own echo,
  so a write does not cause a round trip back to its author. The client already
  knows its own identifier when it opens the stream.
* A **read** (`GET`) broadcasts nothing. A failed write broadcasts nothing: the
  other devices must not be told to refetch state that did not change.
* Do not invent a `rev` when the route has none. Sessions, memory, the ledger and
  settings do not move `rev` (§4.3), so the frame carries the path regardless and
  `rev` is present only when the upstream response actually contained one. **The
  nudge names the collection; it never claims a rev.**

## 2.3 Web client: durable owner session, in every environment

**File:** `glasses/src/web/auth.tsx`

Currently the owner token lives in `sessionStorage`, which is tab-scoped, and
the durable mirror is gated to the Even App:

```ts
// the durable copy is written only here, and only inside the Even App
if (detectEvenApp()) void saveOwnerSession({ token: sessionToken, email: em });
```

So a new tab, or a browser restart, is signed out even though the relay still
holds the session. Change it so that:

* the owner session is written to durable storage (`durable-docs.ts`, which
  already dual-writes to `window.localStorage` and the SDK bridge) **in every
  environment**, not only under `detectEvenApp()`;
* the boot effect reads the durable session **unconditionally**, so the
  `inEvenApp` guard no longer decides whether a stored session is honoured;
* `sessionStorage` may stay as a fast path, but it must never be the only copy.

## 2.4 Web client: fix the device list, then keep it live

**File:** `glasses/src/web/auth.tsx` (and the store, `glasses/src/store.ts`)

* `refreshDevices()` currently begins `const tok = sessionStorage.getItem(...);
  if (!tok) return;` — so on any tab without that key the Settings device list
  renders **empty with no error**. It must read the token from the durable
  session as well, which §2.3 makes reliable.
* Subscribe to the `hub-changed` frame from §2.2. On a frame whose `origin` is
  not this client, and whose `path` maps to a collection this app renders,
  refetch **only that collection** and merge it. Debounce, because a burst of
  writes produces a burst of frames.
* Additionally refetch once when the document becomes visible again
  (`visibilitychange` → visible, plus `focus`), so a tab or phone that was
  asleep catches up on whatever it missed while hidden. This is the safety net
  for anything the relay never saw.
* Leave `applyRemote()`'s existing early-return alone. The relay's cached
  `lastState` stays a bootstrap-only path; the refresh path is the semantic
  per-collection read, which is the point of the migration.

## 2.5 Acceptance tests for Part 2

The repo judges harnesses on **exit code**, invoked bare:

```
cd glasses && node tools/sim-all.mjs
```

New coverage to add:

| Harness | Asserts |
| --- | --- |
| auth store sync | a `200` from `/hub/relay/auth` **overwrites** the local file; a `404` **uploads** it; an unreachable hub leaves the file intact and does not fail a login |
| session digests | a raw token in a legacy file is re-keyed to its digest on load, and that same token still authenticates afterwards |
| nudge | a `2xx` `PUT /api/hub/todos` fans exactly one `hub-changed` frame with `path: "/todos"`; a `GET` fans none; a `4xx` write fans none |
| client refresh | a `hub-changed` frame from another origin triggers one refetch of that collection and **zero** full-snapshot reads; the author's own frame is ignored |
| device list | the list renders from a durable session with `sessionStorage` empty |

Then the existing sweep must stay green, and the browser path must be checked by
hand: sign in, **open a second tab** (still signed in), **restart the browser**
(still signed in), and edit a todo on one device while watching the other update
without a manual refresh.

---

## 3. Interface summary

| Direction | Contract |
| --- | --- |
| backend ← app | `GET`/`PUT`/`DELETE /hub/relay/auth`, an opaque JSON object, ≤128 KiB, key constrained to `[a-z0-9-]{1,32}` |
| backend → app | `200 {ok, rev, key, value, updatedAt}`; `404 NOT_FOUND` when never written; `rev` **unchanged** by a write |
| backend → app | the blob must **not** appear in `GET /hub`, `/hub/sync/*`, `GET /hub/diag/schema`, or any MCP tool |
| app internally | the relay is the only writer of the blob, and it degrades to its local file whenever the hub is unreachable |
| app internally | `hub-changed` frames are relay→client only; they name a path and never assert a rev |

## 4. Order of work

1. **Part 2 §2.2–§2.4** — app-only, ships now, fixes the device list and gives
   live cross-device sync on its own.
2. **Part 1** — the three routes.
3. **Part 2 §2.1** — relay switches to the hub store, with the file kept as the
   fallback so the change is reversible.
4. Re-run the sweep, then install the new `.ehpk` on the glasses.
