# To-Do Delete Failure Log

Date: 4 October 2026, 17:11
Page: To-Do (16 tasks, 0 done)
Request: delete every list item except the "support" items (keep Gmail support, Telegram support)

## Attempt

Retried the deletion. Five deletes issued in one batch, targeting the named non-support items:

| # | Target | Result |
|---|--------|--------|
| 1 | DB fetch test 1 | FAILED |
| 2 | DB fetch test 2 | FAILED |
| 3 | DB fetch test 3 | FAILED |
| 4 | DB fetch test 4 | FAILED |
| 5 | DB fetch test 5 | FAILED |

## Error returned (identical for all five)

```
ok: false
summary: "Failed to fetch"
hint: "The change did NOT reach the hub, so it is not saved.
       Say so in one sentence. Do not retry — a retry cannot
       fix a sign-in or a stale list."
```

## What this means

- Nothing was deleted. The list still holds all 16 tasks; the five DB fetch tests remain open.
- The write never reached the hub, so this is a transport / session failure, not a rejection of the items.
- Same pattern as the earlier to-do deletion on 4 October: deletes do not persist (see Jarvis To-Do Backend Verification — no persistence and false success reporting).
- Retrying cannot fix a sign-in failure or a stale list.

## Not done

- The remaining 10 items beyond the six visible ones were never attempted: the live state truncated the list ("+10 more") and the To-Do page exposes no list action, so the full set could not be enumerated and non-support items could not be identified safely.