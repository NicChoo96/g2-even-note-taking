# Data Platform — specification set

**Status:** PLAN MODE — design documents only. No code in this set has been written,
and nothing here changes the shipped app (0.3.40).

**Purpose:** specify what it would take to move every piece of persistent state in
this project off `localStorage` / the Even App bridge store / the relay's JSON
state file, and onto a real database behind a REST API — with an offline-first web
cache, a re-sync protocol, and a first-class, MCP-addressable, JEV-selectable
Jarvis session store.

---

## ⭐ Building the backend? Read ONE file: [`BACKEND-BUILD-SPEC.md`](./BACKEND-BUILD-SPEC.md)

`BACKEND-BUILD-SPEC.md` is **self-contained**. It reproduces the full DDL, the
whole REST v1 contract, the MCP server surface and the deploy shape in one
document, so a backend implementer never has to cross-reference this set.
It also covers coexisting with the file server on `167.172.77.136`.

The nine documents below are the **rationale** set — read them when you want to
know *why* a rule exists, or when you want to change one.

---

## Read in this order

| # | Document | What it answers |
|---|---|---|
| 00 | [`00-overview.md`](./00-overview.md) | The thesis, the target architecture, the decision log, and what I refuse to build |
| 01 | [`01-inventory.md`](./01-inventory.md) | **Complete** data-model + interface + tool inventory of what exists today, and where each byte currently lives |
| 02 | [`02-database-spec.md`](./02-database-spec.md) | The physical schema: tables, columns, keys, indexes, constraints, retention |
| 03 | [`03-rest-api-spec.md`](./03-rest-api-spec.md) | Every endpoint, the auth model, the envelopes, idempotency, concurrency |
| 04 | [`04-web-integration.md`](./04-web-integration.md) | How the SPA consumes the API, and what happens to SSE |
| 05 | [`05-offline-cache-sync.md`](./05-offline-cache-sync.md) | Offline reads, the outbox, conflict policy, re-sync |
| 06 | [`06-jarvis-sessions.md`](./06-jarvis-sessions.md) | The session store: REST + MCP tools + versioned summaries + LLM recall |
| 07 | [`07-jev-recall.md`](./07-jev-recall.md) | JEV as the selector: STT text in, sessions out |
| 08 | [`08-roadmap-and-decisions.md`](./08-roadmap-and-decisions.md) | Phasing, risk register, acceptance criteria, open questions |

## The one-paragraph summary

The project already has a server, an auth model, a sync protocol and three
durability layers — they are just shaped around a **whole-state last-write-wins
blob per channel**. The change is therefore not "add a server"; it is
**decompose the blob into rows, keep every merge rule the blob was silently
encoding, and add the two things a blob can never express: idempotent operations
and per-collection revisions.** Everything else in this set follows from that.

## Conventions used throughout

- `MUST` / `MUST NOT` = a hard requirement, usually because removing it
  re-introduces a bug that already shipped (each is footnoted with the bug).
- `SHOULD` = the recommended choice, with the alternative named.
- Any rule marked **⚠ LOAD-BEARING** is load-bearing in the current code and
  carries forward verbatim. Breaking one is a regression, not a redesign.
- Field names in `code style` are the **real** names from the source, not
  proposals, unless the document explicitly says "new".
