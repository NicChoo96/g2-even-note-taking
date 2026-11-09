// A text field the NETWORK is not allowed to type over.
//
// WHY THIS EXISTS
//   Every editor in this app is a controlled input bound to a value that arrives
//   over the stream: the doc title, the doc body, the notes box. A peer's nudge —
//   or this tab's own stale-rev refresh — re-reads the collection and commits a
//   new state object, and React re-renders the input from the SERVER's copy. If
//   that copy is even one keystroke behind (the save is debounced, so it always
//   is), the letters vanish and the field "twitches". The same frames also used to
//   move the tab and the selected row, which is the other half of the complaint.
//
// THE RULE
//   While the field has focus it is the wearer's. Remote values are applied only
//   when the field is NOT being edited. When it loses focus the latest remote value
//   is adopted, so a change that arrived mid-typing is not lost for ever — it
//   appears when the wearer is done, not under their cursor.
//
// WHAT THIS DOES NOT DO
//   It does not delay or batch the WRITE; `commit` is the caller's existing
//   (debounced, hub-backed) save, so typing still streams to the relay and the
//   glasses exactly as before. This only stops the read path from overwriting an
//   input mid-word.
import { useEffect, useRef, useState } from 'react';

export interface RemoteDraft {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  onFocus: () => void;
  onBlur: () => void;
}

export function useRemoteDraft(value: string, commit: (next: string) => void): RemoteDraft {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  // The last remote value this hook has taken into account. A save is debounced,
  // so the prop lags the caret; without this the blur transition would "restore"
  // that lagging copy and delete the last keystrokes.
  const lastRemote = useRef(value);

  useEffect(() => {
    if (value === lastRemote.current) return; // no new news from the server
    lastRemote.current = value;
    // Typing wins. The held value is not lost: this field's own write re-commits
    // the draft, and the next genuine remote change is adopted as normal.
    if (editing) return;
    setDraft(value);
  }, [value, editing]);

  return {
    value: draft,
    onChange: (e) => {
      const next = e.target.value;
      // Local first, so the caret never waits for React to hear from the relay.
      setDraft(next);
      commit(next);
    },
    onFocus: () => setEditing(true),
    onBlur: () => setEditing(false),
  };
}
