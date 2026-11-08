#!/usr/bin/env node
// Run-budget harness — how long a run may go on, and what stops it.
//
// WHY THIS EXISTS:
//   The step budget is the one number the wearer has hit twice, from both sides:
//   agents stopped mid-task, and Jarvis answering before the work was done. The
//   failure mode is silent — a run that stops early produces a confident summary,
//   not an error — so the budget rules deserve an assertion of their own rather
//   than a grep for a constant.
//
// Run: node tools/run-budget-sim.mjs

import { agentStepBudget, MAX_IDENTICAL_CALLS } from '../../web/server/run-budget.mjs';

let pass = 0;
const failures = [];

function check(name, got, want) {
  if (Object.is(got, want)) {
    pass += 1;
  } else {
    failures.push(`${name}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
  }
}

// ── No limit is the DEFAULT ────────────────────────────────────────────────
check('unset means no limit', agentStepBudget({}), 0);
check('empty string means no limit', agentStepBudget({ G2_AGENT_MAX_STEPS: '' }), 0);
check('whitespace means no limit', agentStepBudget({ G2_AGENT_MAX_STEPS: '   ' }), 0);
check('an explicit 0 means no limit', agentStepBudget({ G2_AGENT_MAX_STEPS: '0' }), 0);

// ── A budget, when one is asked for ───────────────────────────────────────
check('a positive number is honoured', agentStepBudget({ G2_AGENT_MAX_STEPS: '25' }), 25);
check('a float is floored, not rejected', agentStepBudget({ G2_AGENT_MAX_STEPS: '7.9' }), 7);
check('a large number is not clamped', agentStepBudget({ G2_AGENT_MAX_STEPS: '1000' }), 1000);

// ── Junk falls BACK to no limit, never to a low cap ───────────────────────
// The failure to avoid is a missing answer. A typo must not produce NaN and a
// run that cannot be started, nor a silent 1-turn run.
check('a negative number means no limit', agentStepBudget({ G2_AGENT_MAX_STEPS: '-5' }), 0);
check('a word means no limit', agentStepBudget({ G2_AGENT_MAX_STEPS: 'unlimited' }), 0);
check('a typo means no limit', agentStepBudget({ G2_AGENT_MAX_STEPS: '12x' }), 0);
check('NaN means no limit', agentStepBudget({ G2_AGENT_MAX_STEPS: 'NaN' }), 0);

// ── The guard that actually ends an unlimited run ─────────────────────────
check('three identical calls is the trip point', MAX_IDENTICAL_CALLS, 3);

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${pass} passed, 0 failed`);
  console.log('ALL CHECKS PASSED');
}
