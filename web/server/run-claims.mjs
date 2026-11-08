// Does a finished run's answer agree with what its tools actually did?
//
// WHY THIS EXISTS
//   The wearer's report is precise and it has happened before: an agent "kept
//   insisting that it did publish the HTML page into the file system", and no
//   page exists. Nothing in the read path was broken — `renderToolResult` only
//   ever prints "Published …" for a document the gateway returned, and the
//   client throws `empty_result` rather than inventing one. What was missing is
//   the other half of the contract: after the loop, NOBODY compared the answer
//   against the tool results. A model that called nothing, or that was refused
//   and then narrated anyway, produced a transcript that reads exactly like a
//   run that worked.
//
//   So this module is deliberately not a language model, a heuristic score or a
//   second opinion. It counts what the run can PROVE: the document store either
//   returned a document back to it or it did not. When the answer claims a write
//   and the run cannot prove one, the claim is corrected in place — the answer
//   keeps its content and gains one true sentence, because deleting the model's
//   words would hide the fact that it said them.
//
// WHAT IT IS NOT ALLOWED TO DO
//   Fire on an answer that makes no write claim. Almost every run finishes with
//   prose about results, and adding a note to all of them would train the wearer
//   to ignore the note. It is also never allowed to turn an ok answer into a
//   failed run: `ok` on the result describes the RUN, not the claim.

/** The document store's model-facing name (relay side). */
export const STORE_TOOL_NAME = 'jarvis_files';

/**
 * A claim that a DOCUMENT was written.
 *
 * Two shapes, because models write the same act two ways: the verb on its own
 * ("published the digest", "uploaded it"), and a save that names where
 * ("saved it to your files", "stored the page in the library"). The second form
 * needs the object, because "saved" alone is how a model reports a to-do list and
 * a to-do list is a different store with its own proof.
 */
const WRITE_VERB = /\b(?:publish(?:ed|es|ing)?|upload(?:ed|s|ing)?)\b/i;
const SAVE_TO_STORE =
  /\b(?:saved|stored|wrote|written|created|added)\b[^.!?\n]{0,48}\b(?:file|files|page|pages|document|documents|library|store)\b/i;

/** The relay's success line for a store write, e.g. `Published 1a2b… — "x"`. */
const CONFIRMED_TEXT = /^(?:Published|Updated|Reverted)\b/;
/** A refusal from a relay tool. */
const REFUSED_TEXT = /^tool error:/i;
/** The device-side capability result, which is JSON: `{"ok":true,…}`. */
const CONFIRMED_JSON = /^\{\s*"ok"\s*:\s*true/;
const REFUSED_JSON = /^\{\s*"ok"\s*:\s*false/;

/** Did the model claim it wrote a document? */
export function claimsAWrite(text) {
  const t = String(text ?? '');
  return WRITE_VERB.test(t) || SAVE_TO_STORE.test(t);
}

/**
 * Is this tool message a document-store call at all?
 *
 * Matched on the tool NAME rather than the result text, so a refusal from the
 * store is still attributed to the store (its text begins `tool error:`, which
 * says nothing about which tool produced it). `files` catches both `jarvis_files`
 * and the device's own `files.publish`.
 */
function isStoreCall(message) {
  return /files/i.test(String(message?.tool ?? ''));
}

/**
 * Compare an answer against the run's own transcript.
 *
 * @returns {{ok: boolean, note: string, text: string}}
 *   `text` is what should be shown: the answer unchanged when it is provable,
 *   otherwise the answer followed by one correction sentence.
 */
export function auditRunClaims(answer, messages) {
  const text = String(answer ?? '');
  const unchanged = { ok: true, note: '', text };

  // A run with nothing to say cannot be lying about a write.
  if (!text.trim()) return unchanged;
  if (!claimsAWrite(text)) return unchanged;

  const storeCalls = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && m.role === 'tool' && isStoreCall(m),
  );
  const contentOf = (m) => String(m?.content ?? '').trim();
  const confirmed = storeCalls.some(
    (m) => CONFIRMED_TEXT.test(contentOf(m)) || CONFIRMED_JSON.test(contentOf(m)),
  );
  if (confirmed) return unchanged;

  const refusal = storeCalls.find(
    (m) => REFUSED_TEXT.test(contentOf(m)) || REFUSED_JSON.test(contentOf(m)),
  );

  let note;
  if (refusal) {
    // The run has the store's own words. Quote them: a summary of a refusal is
    // exactly the paraphrase that turns "invalid html" into "it worked".
    const said = contentOf(refusal).replace(/^tool error:\s*/i, '').slice(0, 240);
    note =
      `Correction: the document store refused this write (${said}), so nothing was published. ` +
      'The answer above was written before that refusal was checked.';
  } else if (storeCalls.length) {
    note =
      'Correction: the document store was called but returned no document, so nothing is confirmed ' +
      'saved. The answer above describes an intention, not a stored page.';
  } else {
    note =
      'Correction: no document-store call was made in this run, so nothing was published or uploaded. ' +
      'The answer above describes an intention, not a stored page.';
  }

  return { ok: false, note, text: `${text}\n\n${note}` };
}
