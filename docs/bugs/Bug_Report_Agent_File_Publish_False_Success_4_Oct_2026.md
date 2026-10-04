# Bug Report — Agent File Publish False Success

**Date:** 4 Oct 2026
**Area:** Agents → Files (document store) publish
**Severity:** High — silent data loss, false success reported to the wearer
**Reporter:** wearer, via Jarvis glasses

## Summary

The Daily Run Orchestrator finished its 4 Oct run reporting that it had published a digest page of about 19.2 kB (19200 bytes). Nothing exists in the Files store. A fresh check of the store, including deleted items, and a search for "Daily Run" both return nothing. The page was never written.

## Steps to reproduce

1. Trigger the Daily Run Orchestrator.
2. Let the run finish. The transcript reports a successful publish with a byte count.
3. Open Files and list the store. Search the title. Include deleted documents.

## Expected

The published page appears in the Files list and renders on the web Files tab.

## Actual

No matching document. The store is unchanged, not even a deleted or failed entry. The success line is false.

## Why this happens — analysis of the flow

1. **The agent has no publish tool.** The tool offer given to agents is effectively web search plus an app slot; the document-store publish action is not among the agent's tools. An agent with no write path cannot have written. It produced a plausible success sentence instead, which is the classic hallucinated-write pattern.
2. **The runner's tool offer is malformed.** The runner lists its own tool slot (jarvis_app) twice, and that collision is what aborted earlier runs on the same day (see Agent Run Errors — Diagnosis, 4 Oct 2026). A duplicated slot makes the offer unreliable even where a needed tool does exist.
3. **The runner passes its own configuration, not the agent's.** It passes its own model string rather than reading deepseek-flash off the agent card; the same pattern applies to tools, so a run executes with what the runner assumes, not with what the agent holds.
4. **This is not a guardrail, and there is no permission gate.** A blocked write would surface an error; a permission gate would surface a prompt. Neither appears — no refusal, no confirmation request, no error. The failure is the opposite of over-blocking: there is no write gate and no post-write read-back, so a fabricated success is indistinguishable from a real one. Recommendation 9 of Jarvis Tool Gaps — On-the-Spot Speech and Agent Chaining (keep human confirmation on any agent write) is still unimplemented, and agents still hold no Docs, Notes or To-Do write tools.

## Impact

- The wearer believes a report exists when it does not; the work is lost with no warning.
- Run transcripts stop being evidence: "done" no longer implies a write landed.
- Related: the Files delete bug, where deletes do not persist, compounds the difficulty of telling what the store actually holds.

## Suggested fixes, in order

1. **Runner-side first.** Build the tool offer from the agent's own card, deduplicate the slots, and pass the agent's model rather than the runner's string.
2. **Give agents the write tools.** Document-store publish, plus Docs, Notes and To-Do, per the Agent & Jarvis Tool Exposure Gap Report.
3. **Verify every agent write.** Read the target back after writing and report the read result, not the intent. Fail loudly when the read finds nothing.
4. **Add the write-confirmation pause** so an agent publish is a visible, approved act rather than a silent claim.