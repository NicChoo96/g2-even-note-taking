// Did this run actually write a document? The store is the only judge.
//
// WHY THIS EXISTS
//   Reported three times now, and the third time with the store checked by hand:
//   an agent said it had published its HTML page, the only page with that title
//   was still on version 1 from weeks earlier, credited to somebody else, and
//   filtering the store by the agent's own name returned nothing. Nothing was
//   written — not partially, not with an error. The publish never happened and
//   the run reported success in prose.
//
//   "Comparing the answer to the transcript" is not enough, and that was the
//   previous fix's ceiling: if the model never calls the tool, the transcript has
//   nothing to contradict, and a correction sentence is still a `done` run with a
//   paragraph attached. The wearer has to read the paragraph to learn that the
//   work is missing.
//
//   So this module asks the STORE, over its API, for the one fact that cannot be
//   narrated: did a document appear, or did a version go up, since this run
//   started? That is a comparison of two lists, and it is the whole gate.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - It does not judge prose. `claimsAWrite` (./run-claims.mjs) decides whether a
//     claim was made; this decides whether the claim is TRUE.
//   - It does not look at titles to guess "the same page". A title is model
//     output; a new id or a higher version is the store's own arithmetic.
//   - It never returns "probably". Every outcome is one of: no claim made,
//     confirmed by a change, or a failure with the reason the check could not be
//     satisfied. "Unverifiable" is reported as a FAILURE, because a run that
//     cannot prove a write must not be shown to the wearer as a completed one.

import { claimsAWrite } from './run-claims.mjs';

/**
 * How many times a run may be re-asked to publish before it is failed.
 *
 * Two, because the first re-ask fixes the common causes (the model answered
 * instead of calling the tool; it called it with a truncated body) and a second
 * failure means the model cannot do it, so more turns only produce more prose.
 */
export const PUBLISH_RETRY_TURNS = 2;

/**
 * The store as a comparable index: id -> { title, version, agent }.
 *
 * Reads `items` because that is the envelope `client.list` returns (the same one
 * `renderToolResult` renders), and tolerates a bare array so a caller that has
 * already unwrapped it cannot silently produce "no documents".
 */
export function storeIndex(listResult) {
  const items = Array.isArray(listResult)
    ? listResult
    : Array.isArray(listResult?.items)
      ? listResult.items
      : [];
  const index = new Map();
  for (const doc of items) {
    const id = String(doc?.id ?? '').trim();
    if (!id) continue;
    index.set(id, {
      id,
      title: String(doc?.title ?? ''),
      version: Number(doc?.version) || 0,
      agent: String(doc?.agent ?? ''),
    });
  }
  return index;
}

/**
 * What changed between two snapshots: documents that are new, or that moved to a
 * higher version. A LOWER version is not a write by this run — it is a restore,
 * which is a different act and does not prove a publish.
 */
export function storeChanges(before, after) {
  if (!(after instanceof Map)) return [];
  if (!(before instanceof Map)) return [];
  const changed = [];
  for (const [id, doc] of after) {
    const was = before.get(id);
    if (!was || doc.version > was.version) changed.push(doc);
  }
  return changed;
}

/**
 * The gate.
 *
 * @param {object} input
 * @param {string} input.text        the answer the run is about to show
 * @param {boolean} input.hasStoreTool whether the agent has a store tool attached
 * @param {Map|null} input.before    snapshot taken BEFORE the loop
 * @param {Map|null} input.after     snapshot taken AFTER it
 * @param {string} [input.storeError] why a snapshot could not be taken
 * @param {number} [input.attemptsLeft] publish retries still available
 * @returns {{outcome: 'not-claimed'|'confirmed'|'retry'|'fail', reason: string, evidence: object[]}}
 */
export function publishVerdict({
  text,
  hasStoreTool,
  before = null,
  after = null,
  storeError = '',
  attemptsLeft = 0,
  pendingPublish = false,
}) {
  const none = { reason: '', evidence: [] };

  // No claim, nothing to prove. This is the ordinary case and it must stay
  // silent, or the wearer learns to ignore the gate.
  if (!claimsAWrite(text)) return { outcome: 'not-claimed', ...none };

  // The DEVICE was asked to publish. `jarvis_app` records a proposal that the
  // phone executes AFTER the run, so the store legitimately has nothing yet —
  // failing here would punish a run that did exactly what it was told. The
  // transcript says so instead, because "pending" is the honest word.
  if (pendingPublish) {
    return {
      outcome: 'deferred',
      reason: 'the publish was handed to the device and runs after this run finishes',
      evidence: [],
    };
  }

  // THE REPORTED BUG, EXACTLY. An agent with no store tool cannot have written,
  // whatever it says. Failing here costs nothing and catches the case that
  // started all of this.
  if (!hasStoreTool) {
    return {
      outcome: 'fail',
      reason:
        'this agent has no document-store tool attached, so nothing could have been published. ' +
        'Attach the Files tool to the agent and run it again.',
      evidence: [],
    };
  }

  if (storeError) {
    return {
      outcome: 'fail',
      reason: `the document store could not be checked (${storeError}), so the publish is unconfirmed`,
      evidence: [],
    };
  }

  // A baseline we never got is not a baseline of zero. Treating it as empty
  // would "confirm" every document already in the store.
  if (!(before instanceof Map) || !(after instanceof Map)) {
    return {
      outcome: 'fail',
      reason: 'the document store could not be read back, so the publish is unconfirmed',
      evidence: [],
    };
  }

  const evidence = storeChanges(before, after);
  if (evidence.length) return { outcome: 'confirmed', reason: '', evidence };

  if (attemptsLeft > 0) {
    return {
      outcome: 'retry',
      reason: 'no new or updated document was found in the store',
      evidence: [],
    };
  }

  return {
    outcome: 'fail',
    reason:
      'the document store shows no new or updated document from this run, so the publish did not happen',
    evidence: [],
  };
}

/**
 * The instruction a run is re-asked with when the gate says "retry".
 *
 * Names the tool and the action, states the fact that made this happen, and
 * allows the model an honest way out — a run that genuinely cannot publish should
 * say so rather than try again with the same missing capability.
 */
export const PUBLISH_RETRY_INSTRUCTION =
  'The document store shows no new or updated document from this run, so the '
  + 'publish you described did not happen. If the task needs a page, call the '
  + 'document-store tool now with action "publish" and the COMPLETE HTML body in '
  + 'one call. If you cannot, say plainly that nothing was published and stop.';

/**
 * What the model is told when it has NO store tool and the task looks like it
 * needs one — so the truthful sentence arrives BEFORE the claim rather than
 * after it. The gate still runs; this is the cheap half of the fix.
 */
export function missingToolNotice() {
  return (
    'Capability notice: the document-store tool is NOT attached to this agent. '
    + 'You cannot publish, upload or save any file in this run. If the task needs '
    + 'one, say so plainly and stop. Never say you published or saved anything.'
  );
}

/** Does this task look like it expects a document to be written? */
export function looksLikePublishAsk(text) {
  return /\b(?:publish(?:ed|es|ing)?|upload(?:ed|s|ing)?|save|saved|html|web ?page|digest|brief|report|file)\b/i.test(
    String(text ?? ''),
  );
}

/**
 * Did this run hand a publish to the DEVICE to execute later?
 *
 * The intent tool's whole contract is that the change happens afterwards, so a
 * claim here is not a lie — it is early. Detected from the transcript (a
 * `jarvis_app` tool message naming `files.publish`) because that is the record the
 * wearer reads, and it cannot drift from what was actually proposed the way a
 * side table could.
 */
export function hasPendingPublish(messages) {
  return (Array.isArray(messages) ? messages : []).some(
    (m) =>
      m &&
      m.role === 'tool' &&
      String(m.tool ?? '') === 'jarvis_app' &&
      /files\.publish/i.test(String(m.content ?? '')),
  );
}
