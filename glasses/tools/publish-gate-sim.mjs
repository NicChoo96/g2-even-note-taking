#!/usr/bin/env node
// Publish-gate harness — does the store prove the write?
//
// WHY THIS EXISTS:
//   The same bug has now been reported three times: a run says it published a
//   page, and the store shows nothing. The previous fix compared the answer to
//   the transcript, which cannot catch the case that actually happens — the model
//   never calls the tool at all, so there is nothing to contradict it.
//
//   This gate asks the STORE, over its API. It is a comparison of two lists, and
//   the whole correctness of the fix is in these cases:
//     • a claim with no store tool attached must FAIL (the reported bug)
//     • a claim with no change in the store must RETRY, then FAIL
//     • a claim with a new document or a higher version must be CONFIRMED
//     • a store we could not read must FAIL, never "probably fine"
//     • an answer that claims nothing must be left alone
//
// Run: node tools/publish-gate-sim.mjs

import {
  PUBLISH_RETRY_INSTRUCTION,
  PUBLISH_RETRY_TURNS,
  hasPendingPublish,
  looksLikePublishAsk,
  missingToolNotice,
  publishVerdict,
  storeChanges,
  storeIndex,
} from '../../web/server/publish-gate.mjs';

let pass = 0;
const failures = [];

function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    return;
  }
  failures.push(`${label}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
}

function ok(label, cond, detail = '') {
  if (cond) pass += 1;
  else failures.push(`${label}${detail ? `\n     ${detail}` : ''}`);
}

const doc = (id, version, title = 'Page', agent = 'agent-a') => ({ id, version, title, agent });

// ── storeIndex: the store's envelope, and its junk ────────────────────────
const listed = storeIndex({
  items: [doc('a', 1), doc('b', 2), { id: '', version: 3 }, null],
  total: 3,
});
check('an items envelope indexes by id', [...listed.keys()], ['a', 'b']);
check('the version is kept as a number', listed.get('b').version, 2);
check('a bare array is accepted too', [...storeIndex([doc('x', 1)]).keys()], ['x']);
check('junk indexes to nothing', storeIndex(null).size, 0);
check('a non-numeric version is 0, not NaN', storeIndex({ items: [{ id: 'z', version: 'foo' }] }).get('z').version, 0);

// ── storeChanges: new, bumped, untouched, restored ────────────────────────
const before = storeIndex({ items: [doc('keep', 4), doc('bump', 1), doc('restore', 5)] });
const after = storeIndex({
  items: [doc('keep', 4), doc('bump', 2), doc('restore', 3), doc('fresh', 1)],
});
check(
  'a new document and a bumped version are changes',
  storeChanges(before, after).map((d) => d.id).sort(),
  ['bump', 'fresh'],
);
check('an untouched document is not a change', storeChanges(before, after).some((d) => d.id === 'keep'), false);
// A revert lowers the version. It is a real act, but it is not a publish, and
// counting it would let "I published it" pass after a restore.
check('a lower version is not a publish', storeChanges(before, after).some((d) => d.id === 'restore'), false);
check('a deleted document is not a change', storeChanges(before, storeIndex({ items: [doc('keep', 4)] })).length, 0);
check('no baseline yields no changes, not everything', storeChanges(null, after).length, 0);
check('no current snapshot yields no changes', storeChanges(before, null).length, 0);

// ── The gate itself ───────────────────────────────────────────────────────
const CLAIM = 'I have published the Singapore Workday Brief to your files.';
const NO_CLAIM = 'Here are the three stories I found this morning.';
const EMPTY = storeIndex({ items: [] });

// The ordinary case must stay silent: a gate that speaks on every run is noise.
check('an answer that claims nothing is not judged', publishVerdict({
  text: NO_CLAIM, hasStoreTool: true, before: EMPTY, after: EMPTY,
}).outcome, 'not-claimed');
check('a to-do save is not a store claim', publishVerdict({
  text: 'I saved the task to your list.', hasStoreTool: false, before: null, after: null,
}).outcome, 'not-claimed');

// THE REPORTED BUG. This agent had no usable write tool.
const noTool = publishVerdict({ text: CLAIM, hasStoreTool: false, before: null, after: null });
check('a claim with no store tool FAILS', noTool.outcome, 'fail');
ok('…and says the tool is not attached', /no document-store tool attached/.test(noTool.reason), noTool.reason);

// A store we could not read is a failure, never a pass.
check('an unreadable store FAILS', publishVerdict({
  text: CLAIM, hasStoreTool: true, before: EMPTY, after: EMPTY, storeError: 'gateway did not answer',
}).outcome, 'fail');
check('a missing baseline FAILS rather than confirming everything', publishVerdict({
  text: CLAIM, hasStoreTool: true, before: null, after: storeIndex({ items: [doc('old', 9)] }),
}).outcome, 'fail');
check('a missing current snapshot FAILS', publishVerdict({
  text: CLAIM, hasStoreTool: true, before: EMPTY, after: null,
}).outcome, 'fail');

// The happy path, proven by the store and not by prose.
const confirmed = publishVerdict({
  text: CLAIM,
  hasStoreTool: true,
  before: EMPTY,
  after: storeIndex({ items: [doc('new-page', 1, 'Singapore Workday Brief')] }),
});
check('a new document CONFIRMS the claim', confirmed.outcome, 'confirmed');
check('…and names the evidence', confirmed.evidence.map((d) => d.id), ['new-page']);

const bumped = publishVerdict({
  text: CLAIM,
  hasStoreTool: true,
  before: storeIndex({ items: [doc('page', 1)] }),
  after: storeIndex({ items: [doc('page', 2)] }),
});
check('a version bump CONFIRMS the claim', bumped.outcome, 'confirmed');

// No change: retry while attempts remain, fail when they run out.
const retry = publishVerdict({
  text: CLAIM, hasStoreTool: true, before: EMPTY, after: EMPTY, attemptsLeft: 1,
});
check('no change asks for a RETRY', retry.outcome, 'retry');
const exhausted = publishVerdict({
  text: CLAIM, hasStoreTool: true, before: EMPTY, after: EMPTY, attemptsLeft: 0,
});
check('no change with no retries left FAILS', exhausted.outcome, 'fail');
ok('…and names the store as the reason', /no new or updated document/.test(exhausted.reason), exhausted.reason);

// A claim is retried even when something unrelated changed? No: any change in
// the window confirms, because the gate cannot attribute a document to a run it
// did not observe being written. Documented here so the trade-off is explicit.
const unrelated = publishVerdict({
  text: CLAIM,
  hasStoreTool: true,
  before: EMPTY,
  after: storeIndex({ items: [doc('another-agent-page', 1, 'Something else', 'agent-b')] }),
});
check('any document written during the run confirms it', unrelated.outcome, 'confirmed');

// A publish handed to the DEVICE is not a lie, it is early: the store is empty
// because the phone runs the proposal after the loop ends. Failing that would
// punish the one path that did exactly what it was told.
const deferred = publishVerdict({
  text: CLAIM, hasStoreTool: true, before: EMPTY, after: EMPTY, pendingPublish: true,
});
check('a device-deferred publish is PENDING, not a failure', deferred.outcome, 'deferred');
ok('…and says it runs after the run', /runs after this run/.test(deferred.reason), deferred.reason);
// The device path needs no store tool of its own — the phone does the write — so
// a pending proposal is still deferred, not a failure.
check('a pending device publish needs no store tool', publishVerdict({
  text: CLAIM, hasStoreTool: false, before: null, after: null, pendingPublish: true,
}).outcome, 'deferred');
// …but a confirmed write still wins over the pending flag, so the transcript
// records what the STORE proved rather than what was merely asked for.
check('a proven write beats the pending flag', publishVerdict({
  text: CLAIM, hasStoreTool: true, before: EMPTY,
  after: storeIndex({ items: [doc('written', 1)] }), pendingPublish: false,
}).outcome, 'confirmed');

// How the pending fact is detected: the jarvis_app tool message that names the
// action, i.e. the same line the wearer reads.
check('a jarvis_app publish proposal is seen', hasPendingPublish([
  { role: 'tool', tool: 'jarvis_app', content: '{"ok":true,"summary":"files.publish queued"}' },
]), true);
check('another jarvis_app action is not a publish', hasPendingPublish([
  { role: 'tool', tool: 'jarvis_app', content: '{"ok":true,"summary":"todo.add"}' },
]), false);
check('a store tool result is not a proposal', hasPendingPublish([
  { role: 'tool', tool: 'jarvis_files', content: 'Published abc — "x"' },
]), false);
check('no transcript means no proposal', hasPendingPublish(null), false);

// ── Wiring constants ──────────────────────────────────────────────────────
check('two retries before failing', PUBLISH_RETRY_TURNS, 2);
ok('the retry instruction names the action', /"publish"/.test(PUBLISH_RETRY_INSTRUCTION), PUBLISH_RETRY_INSTRUCTION);
ok('the retry instruction offers an honest exit', /say plainly that nothing was published/.test(PUBLISH_RETRY_INSTRUCTION));
ok('the missing-tool notice says NOT attached', /NOT attached/.test(missingToolNotice()));

// ── When the notice is worth spending a turn on ───────────────────────────
check('a report task looks like a publish ask', looksLikePublishAsk('Build the daily run digest'), true);
check('an explicit publish looks like one', looksLikePublishAsk('publish the page'), true);
check('a grocery list does not', looksLikePublishAsk('add oat milk and eggs'), false);
check('an empty ask does not', looksLikePublishAsk(''), false);

// ── Report ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${pass} passed, 0 failed`);
  console.log('ALL CHECKS PASSED');
}
