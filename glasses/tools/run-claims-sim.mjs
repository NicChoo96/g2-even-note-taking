#!/usr/bin/env node
// Run-claim audit harness — does a finished run's answer match its tools?
//
// WHY THIS EXISTS:
//   The wearer's report was "it kept insisting that it did publish the HTML page
//   into the file system, but no file is actually uploaded". Nothing throws in
//   that bug: the write path either returned a document or returned a refusal,
//   and the ANSWER was written by a model that was free to say anything. So the
//   only assertion that can catch it is a comparison, and the comparison has to
//   be tested in both directions — a guard that fires on every answer would be
//   noise the wearer learns to ignore, and a guard that never fires is the bug.
//
// Run: node tools/run-claims-sim.mjs

import { auditRunClaims, claimsAWrite, STORE_TOOL_NAME } from '../../web/server/run-claims.mjs';

let pass = 0;
const failures = [];

function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
  } else {
    failures.push(`${name}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
  }
}

/** A relay-side successful publish, exactly as renderToolResult prints it. */
const PUBLISHED =
  'Published 4f2a1c9e8b7d6a5f4e3d2c1b0a9f8e7d — "Daily digest" (19.2 kB). ' +
  'It is listed on the Files page; the wearer reads the body there. ' +
  'Read back from the store: 19.2 kB at version 1.';

/** A relay-side refusal, exactly as runToolOnce prints it. */
const REFUSED = 'tool error: validation_error: html is required';

/** The device capability's own result shape (JSON). */
const DEVICE_OK = JSON.stringify({ ok: true, summary: 'Published "Daily digest"' });
const DEVICE_FAIL = JSON.stringify({ ok: false, summary: 'the store refused the write' });

const tool = (content, name = STORE_TOOL_NAME) => ({ role: 'tool', tool: name, content });

// ── The claim detector ──────────────────────────────────────────────────────
check('a publish claim is seen', claimsAWrite('I have published the digest page.'), true);
check('an upload claim is seen', claimsAWrite('Uploaded the report to your files.'), true);
check('a save-to-store claim is seen', claimsAWrite('I saved the page to the library.'), true);
check('plain prose is not a claim', claimsAWrite('The digest covers three stories.'), false);
check('a to-do save is not a store claim', claimsAWrite('I saved the task to your list.'), false);

// ── Provable answers are left EXACTLY as written ────────────────────────────
const proved = auditRunClaims('I have published the digest.', [tool(PUBLISHED)]);
check('a confirmed publish is left alone', proved.ok, true);
check('a confirmed publish gains no note', proved.text, 'I have published the digest.');

const provedDevice = auditRunClaims('Published it.', [tool(DEVICE_OK, 'files.publish')]);
check('a device-side confirmation counts too', provedDevice.ok, true);

// An answer with no write claim never gets a note, however the run went.
const noClaim = auditRunClaims('Your list has four items.', [tool(REFUSED)]);
check('an answer that claims nothing is untouched', noClaim.ok, true);
check('…and its text is byte-identical', noClaim.text, 'Your list has four items.');

check('an empty answer is untouched', auditRunClaims('', []).ok, true);

// ── The three ways a claim can be unprovable ────────────────────────────────
// 1. The store was never called at all. This is the reported bug's shape: the
//    model had no write path and said it had one.
const never = auditRunClaims('I published the page for you.', [tool('3 results found', 'web_search')]);
check('a claim with no store call is corrected', never.ok, false);
check(
  '…and says no call was made',
  /no document-store call was made/i.test(never.note),
  true,
);
check('…and keeps the original words', never.text.startsWith('I published the page for you.'), true);
check('…and appends the correction', never.text.includes(never.note), true);

// 2. The store was called and REFUSED. The refusal is quoted, because a
//    paraphrase is what turns "invalid html" into "it worked".
const refused = auditRunClaims('The digest is published.', [tool(REFUSED)]);
check('a refused write is corrected', refused.ok, false);
check('…and quotes the store', refused.note.includes('html is required'), true);
check('…and says nothing was published', /nothing was published/i.test(refused.note), true);

const refusedDevice = auditRunClaims('Saved to your files.', [tool(DEVICE_FAIL, 'files.publish')]);
check('a device-side refusal is corrected', refusedDevice.ok, false);

// 3. The store was called and returned something that is not a document.
const empty = auditRunClaims('Published the report.', [tool('No documents stored yet.')]);
check('a call with no document back is corrected', empty.ok, false);
check(
  '…and says nothing is confirmed',
  /returned no document/i.test(empty.note),
  true,
);

// A non-store tool that happens to say "Published" must not launder a claim.
const launder = auditRunClaims('Published the page.', [tool('published 2026-11-07 by the site', 'web_search')]);
check('another tool cannot confirm a store write', launder.ok, false);

// ── The result is never a crash, whatever arrives ──────────────────────────
check('a null answer is safe', auditRunClaims(null, null).ok, true);
check('a junk transcript is safe', auditRunClaims('Published it.', [null, {}, 'x']).ok, false);

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${pass} passed, 0 failed`);
  console.log('ALL CHECKS PASSED');
}
