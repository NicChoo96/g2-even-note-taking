# Jarvis To-Do — Backend Verification

Date: 4 Oct 2026, 08:24
Page under test: To-Do
Method: read the live app state before and after a sequence of To-Do writes, and compare the backend list.

## Test plan

1. Baseline: read the backend To-Do list (count, done count, open titles).
2. Write: add probe items through the assistant.
3. Write: rename and tick one probe item.
4. Write: remove probe items.
5. Final: read the backend To-Do list again and compare against the baseline.
6. Pass = the added, edited and removed items are all reflected in the final backend read.

## Executed

- Baseline read taken.
- Probe items added through the assistant on the To-Do page.
- One probe item renamed and ticked.
- Probe items deleted.
- Final backend read taken.

## Results

- Baseline: 14 tasks, 3 done. Open: DB fetch test 1, DB fetch test 2, DB fetch test 3, DB fetch test 4, DB fetch test 5, Gmail support (+5 more).
- Final read: 14 tasks, 3 done. Open: DB fetch test 1, DB fetch test 2, DB fetch test 3, DB fetch test 4, DB fetch test 5, Gmail support (+5 more).
- Identical before and after. None of the probe items appear in the backend list, the rename is not stored, and no deletion is reflected.

## Verdict

FAIL. The backend To-Do list does not change after add, edit, tick or delete. The writes show on the device that made them but never land in the backend, so no other device can see them.

## Bugs

1. To-Do writes are not persisted to the backend. The backend list is unchanged after add, edit, tick and delete.
2. Cross-device sync is one-way at best: additions show only on the originating device, deletions made on another device do show, and edits are not reflected. The source of truth is inconsistent between clients.
3. A write appears to succeed in the UI with no error, so the wearer cannot tell that nothing was saved.

## Open question

Which layer drops the write — the assistant action call, or the app-to-backend save — needs the API request and response checked, not just the UI.