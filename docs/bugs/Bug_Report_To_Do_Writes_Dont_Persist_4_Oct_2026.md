# Bug Report — To-Do Writes Don't Persist to the Backend

**Date:** 4 October 2026, 16:20 UTC
**Reporter:** Wearer (via Jarvis on smart glasses)
**Area:** To-Do page → backend write path
**Severity:** High — silent data loss, false success reporting
**Status:** Open, awaiting cross-device / after-reload verification

## Summary
Edits and deletions made on the To-Do page appear to change only the local (in-session) copy of the list. The backend does not receive the change, so other web-linked devices never see it and the change is lost on reload. The tool reports success either way, so the failure is silent.

## Steps to Reproduce
1. Open the To-Do page.
2. Rename an existing task (e.g. "DB fetch test 2" → "DB fetch test 2 - PERSISTENCE PROBE, reload and check").
3. Note the tool reports success and the new text is visible in the live app state.
4. Delete another existing task (e.g. "DB fetch test 3"); note task count falls 15 → 14 and the item disappears.
5. Reload / reopen the app, or open the same list on a second web-linked device.

## Expected
- Renames and deletes are written to the backend store, survive a reload, and are visible on every linked device.
- If the write fails, the tool reports the failure instead of success.

## Actual
- The change is visible only in the local front-end state for the current session.
- The backend is not updated, so other devices do not get the change.
- The tool returns a success message regardless, so there is no signal that anything went wrong.

## Evidence
- Write path: rename reported success; live state showed the new text.
- Delete path: delete reported success; live state dropped from 15 tasks to 14 with the item gone.
- Both paths only ever expose the tool's own success message plus a front-end read-back — nothing observable confirms the backend row.
- Consistent with the earlier "deletes don't persist" observation and with the Jarvis To-Do Backend Verification report (no persistence, false success reporting).

## Impact
- Silent data loss on reload.
- No cross-device consistency — a user cannot trust the list on a second device.
- Blocks any workflow that depends on to-do state (including agents that write to the to-do list).

## Working Hypothesis
The write is applied to a local/in-memory store and never flushed to the durable backend, or the backend write is issued but the response is not checked — so failure is swallowed and success is reported unconditionally. Same shape as the previously logged to-do wipe bug.

## Verification Needed (owner: wearer)
The test cannot be settled from inside the app — the assistant cannot see the backend.
1. Reload or reopen the app.
2. If "DB fetch test 3" reappears, or "DB fetch test 2" reverts to its plain name, the backend never took the write — bug confirmed.
3. If both stick, writes are persisting and the earlier report was a stale view.
- Caveat: do not tick any of the DB fetch items while testing; that adds a third variable to the round trip.

## Probes Left in Place
- "DB fetch test 2 - PERSISTENCE PROBE, reload and check" (renamed)
- "DB fetch test 3" (deleted; watch whether it returns)
- Remaining junk DB fetch items pending cleanup once the result is known.

## Fix Direction
- Verify the backend write is actually issued and acknowledged before returning success.
- Make the hand-back explicit: report failure loudly, and never report success without confirming the durable write.
- Restore the probes and clean up the junk DB fetch items once persistence is confirmed.

## Untouched
- Gmail support and Telegram support tasks were not modified during testing.