// The bar that appears when a list is in multi-select mode.
//
// Deliberately one component for Todo, Docs and Files: the three panels differ in
// what they delete and in nothing else, and a wearer who learns this bar once
// should not have to learn it three times. It renders NOTHING when not picking,
// so the calm single-select layout is untouched.
import { countLabel } from './selection';

export function SelectionBar({
  picking,
  count,
  total,
  allSelected,
  busy,
  deleteLabel,
  onAll,
  onClear,
  onDelete,
  onCancel,
}: {
  picking: boolean;
  count: number;
  /** How many rows are visible right now — what "All" means. */
  total: number;
  allSelected: boolean;
  busy?: boolean;
  deleteLabel: string;
  onAll: () => void;
  onClear: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  if (!picking) return null;
  return (
    <div className="pick-bar">
      <span className="pick-count">
        {count === 0 ? 'Tap items to pick them' : `${countLabel(count, 'item')} selected`}
      </span>
      <div className="field-toolbar">
        <button onClick={allSelected ? onClear : onAll} disabled={total === 0 || busy}>
          {allSelected ? 'None' : `All ${total}`}
        </button>
        <button className="danger" onClick={onDelete} disabled={count === 0 || busy}>
          {busy ? 'Working…' : `${deleteLabel}${count > 0 ? ` (${count})` : ''}`}
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
