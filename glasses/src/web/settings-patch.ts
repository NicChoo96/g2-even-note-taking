/**
 * The one place that decides what a Settings save sends.
 *
 * WHY THIS IS A SEPARATE PURE FUNCTION:
 *   Because the bug it fixes was invisible inside a React component. `save()`
 *   used to include `model` whenever the relay did not own it, so pressing Save
 *   after changing the WEB-SEARCH PROVIDER also rewrote the model — from a field
 *   the wearer had never touched. Two independent settings shared one POST and
 *   nothing in the code expressed that they were independent, so nothing could
 *   catch a regression either.
 *
 *   Pulling the decision out makes the independence assertable without a DOM:
 *   "change only the provider" is now a function call whose result either does
 *   or does not contain a `model` key.
 *
 * THE RULE, STATED ONCE — one clause per field, no field reading another:
 *   • A save carries ONLY the fields it means to. There is no "save everything"
 *     patch, because that is what let one setting overwrite another.
 *   • A field whose value IS meaningful when blank (auto, unset) is sent as-is.
 *     Skipping it when blank would make it impossible to go back to auto.
 *   • A key is write-only and never echoed back, so a BLANK key box cannot be
 *     told apart from "leave it alone" — a blank key is not sent, and removing
 *     one is an explicit `clear`.
 *   • The MODEL is sent only when actually EDITED, because its displayed value
 *     is the effective model whenever the wearer has not typed anything, and
 *     echoing that back would re-assert it on every unrelated save.
 */

export interface PatchField {
  /** The value to store. The relay trims it. */
  value: string;
  /**
   * True when the wearer genuinely edited this field. Only the model needs it:
   * for every other field, presence in the patch IS the edit.
   */
  touched?: boolean;
}

export interface PatchInput {
  model: PatchField;
  depth: PatchField;
  title: PatchField;
  openrouterKey: PatchField;
  deepseekKey: PatchField;
  tavilyKey: PatchField;
  braveKey: PatchField;
  /** '' is meaningful here — it means "auto", i.e. whichever key is set. */
  searchProvider: PatchField;
  referer: PatchField;
}

export interface SettingsSave {
  /** Field values to store. A field absent from this object is left alone. */
  patch: Record<string, string>;
  /** Field names to REMOVE, so each falls back to the environment/default. */
  clear: string[];
}

export function buildSettingsSave(input: PatchInput): SettingsSave {
  const patch: Record<string, string> = {};
  const clear: string[] = [];

  /** '' is a real value (auto / fall back), so it is sent as-is. */
  const always = (key: string, f: PatchField) => {
    patch[key] = f.value;
  };
  /** A write-only field: blank is not an edit, so it is not sent at all. */
  const ifSet = (key: string, f: PatchField) => {
    const v = f.value.trim();
    if (v) patch[key] = v;
  };

  // The model carries its own envelope: only an explicit edit moves it, and an
  // edit that empties the box means "go back to the fallback", not "store ''".
  if (input.model.touched) {
    const v = input.model.value.trim();
    if (v) patch.model = v;
    else clear.push('model');
  }

  always('depth', input.depth);
  always('title', input.title);
  always('searchProvider', input.searchProvider);
  always('referer', input.referer);
  ifSet('openrouterKey', input.openrouterKey);
  ifSet('deepseekKey', input.deepseekKey);
  ifSet('tavilyKey', input.tavilyKey);
  ifSet('braveKey', input.braveKey);

  return { patch, clear };
}

/**
 * Fold the save into a request body. `clear` is omitted when empty so the common
 * case sends exactly the fields it means to and nothing else.
 */
export function settingsBody(save: SettingsSave): Record<string, unknown> {
  return save.clear.length ? { ...save.patch, clear: save.clear } : { ...save.patch };
}
