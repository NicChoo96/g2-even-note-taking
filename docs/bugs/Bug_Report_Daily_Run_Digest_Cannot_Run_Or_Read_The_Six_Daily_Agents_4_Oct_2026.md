# Bug Report — Daily Run Digest Cannot Run Or Read The Six Daily Agents

Date: 4 October 2026
Reported by: wearer, via Jarvis on glasses
Component: Daily Run Orchestrator (agent) + Daily Run Digest block
Severity: High — the daily digest is the point of the orchestrator

## Summary

The Daily Run Orchestrator holds a DAILY RUN DIGEST block and it holds the Files tool and
web search, so it *can* publish. What it cannot do is run the six daily agents or read
their output. It therefore has nothing to compile, and it re-reads an older page and
presents that as the digest. Publishing the digest is a separate, manual step.

## Observed

- The orchestrator ran at 17:01 and produced a "digest" drawn from an older page, not from
  that day's six agents.
- The run's real output sits in the agent's session (Agents > sessions). It is not in the
  document store and not anywhere Jarvis can recall on its own.
- The digest only reaches Files when the wearer asks Jarvis to take it out of the session
  and publish it. That works, and is how the last one landed.

## Expected

- The orchestrator calls the six daily agents (Weather, AI tech news, Bank Stocks,
  Trending, Gaming News Today, Workday Brief), reads their results, compiles them into a
  self-contained mobile-first HTML page in a modern soft flat UI, and publishes to Files.
- No ask from the wearer. The run assembles and publishes the digest on its own.

## Root cause

Missing tool exposure. The orchestrator has no way to (a) trigger the six agents or (b)
read their results. The DAILY RUN DIGEST block is only instructions; without the ability
to gather the six results it operates on stale material.

This is the same class of gap as the earlier one where the run published
"Daily Run — 4 October 2026" (19.2 kB) and it never reached the document store — the
false-success / silent post-write hand-back pattern.

## Impact

- Every digest to date is a manual publish.
- The wearer cannot trust a digest to reflect the current run.
- Silent: the run reports success while reporting someone else's content.

## Fix

Give the Daily Run Orchestrator the ability to run the six daily agents and read their
results. That is a proposal to attach tools on the Agents page and needs a tap-to-confirm
from the wearer. Once attached, the orchestrator can assemble and publish the digest
itself, with no ask. Until then, treat every digest as a manual publish.

## Related

- Jarvis To-Do Backend Verification — logs no persistence and false success reporting
- Agent & Jarvis Tool Exposure Gap Report (4 Oct 2026) — web search on only 6 of 19 agents
- Daily Run Orchestrator rewrite to two passes (four-action cap)