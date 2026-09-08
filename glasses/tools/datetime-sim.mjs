#!/usr/bin/env node
// Date-time injection harness.
//
// WHY THIS EXISTS:
//   Agents answered "what is new in AI this week?" from the model's training
//   data because nothing told it the date. The fix stamps every system prompt
//   with the device clock and pre-resolves relative phrases ("today", "last
//   week", "the past 3 months") into exact ranges before the first tool call.
//   This harness pins the clock and asserts that arithmetic, so a regression in
//   the calendar math is caught here instead of on the glasses.
//
// Run: node tools/datetime-sim.mjs

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TIME_MARKER,
  addDays,
  addMonths,
  dateTimeBlock,
  endOfMonth,
  fmt,
  iso,
  localParts,
  preprocessText,
  startOfMonth,
  startOfWeek,
  tzOffsetLabel,
  withDateTime,
  withDateTimeMessages,
} from '../../web/server/datetime.mjs';

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  assert(label, got === want, got === want ? '' : `\n      got:  ${got}\n      want: ${want}`);
const has = (label, hay, needle) =>
  assert(label, String(hay).includes(needle), String(hay).includes(needle) ? '' : `\n      missing: ${needle}\n      in: ${hay}`);

// 2026-09-09 is a Wednesday. Built as a LOCAL date so the assertions hold in
// every timezone the developer happens to be in.
const NOW = new Date(2026, 8, 9, 14, 5, 0);
const today = localParts(NOW);

console.log('── 1. clock primitives ──');
eq('localParts: year/month/day', `${today.y}-${today.m}-${today.d}`, '2026-9-9');
eq('weekday index is Wednesday', today.wd, 3);
eq('iso()', iso(today), '2026-09-09');
eq('fmt() carries the weekday', fmt(today), 'Wed 2026-09-09');
eq('startOfWeek is the Monday before', iso(startOfWeek(today)), '2026-09-07');
eq('startOfMonth', iso(startOfMonth(today)), '2026-09-01');
eq('endOfMonth (30-day month)', iso(endOfMonth(today)), '2026-09-30');
eq('addDays(-1)', iso(addDays(today, -1)), '2026-09-08');
eq('addMonths(-1) crosses the year cleanly', iso(addMonths(today, -1)), '2026-08-09');
eq('addMonths clamps 31 → 30', iso(addMonths({ y: 2026, m: 3, d: 31, wd: 2 }, -1)), '2026-02-28');
assert('tzOffsetLabel looks like UTC±HH:MM', /^UTC[+-]\d{2}:\d{2}$/.test(tzOffsetLabel(NOW)), tzOffsetLabel(NOW));

console.log('\n── 2. relative phrase → exact range ──');
const p = (s) => preprocessText(s, NOW).text;
has('today', p('What is new today?'), `today = Wed 2026-09-09`);
has('this week (Mon → today)', p('AI news this week'), 'this week = Mon 2026-09-07 to Wed 2026-09-09');
has('last week', p('what happened last week'), 'last week = Mon 2026-08-31 to Sun 2026-09-06');
has('next week', p('next week'), 'next week = Mon 2026-09-14 to Sun 2026-09-20');
has('yesterday', p('yesterday'), 'yesterday = Tue 2026-09-08');
has('tomorrow', p('tomorrow'), 'tomorrow = Thu 2026-09-10');
has('this month', p('this month'), 'this month = September 2026 (2026-09-01 to 2026-09-30)');
has('last month', p('last month'), 'last month = August 2026 (2026-08-01 to 2026-08-31)');
has('this year', p('this year'), 'this year = 2026 (2026-01-01 to 2026-12-31)');
has('last year', p('last year'), 'last year = 2025 (2025-01-01 to 2025-12-31)');
has('this quarter', p('this quarter'), 'this quarter = Q3 2026 (2026-07-01 to 2026-09-30)');
has('year to date', p('ytd results'), 'year to date = 2026-01-01 to Wed 2026-09-09');
has('this weekend', p('this weekend'), 'this weekend = Sat 2026-09-12 to Sun 2026-09-13');

console.log('\n── 3. the user\'s exact phrasings ──');
has('"today"', p('summarise the news today'), 'today = Wed 2026-09-09');
has('"this week"', p('what is new in AI this week'), 'this week = Mon 2026-09-07 to Wed 2026-09-09');
has('"last week"', p('what happened last week'), 'last week = Mon 2026-08-31 to Sun 2026-09-06');
has('"past 1 year"', p('summarise AI progress in the past 1 year'), 'past 1 year = 2025-09-09 to Wed 2026-09-09');
has('"past 3 months"', p('the past 3 months'), 'past 3 months = 2026-06-09 to Wed 2026-09-09');
has('"last 7 days"', p('last 7 days'), 'past 7 days = 2026-09-02 to Wed 2026-09-09');
has('"last 2 weeks"', p('last 2 weeks'), 'past 2 weeks = 2026-08-26 to Wed 2026-09-09');
has('"past hour"', p('past hour'), 'past 1 hour = since Wed 2026-09-09 13:05');
has('"next 30 days"', p('next 30 days'), 'next 30 days = 2026-09-09 to Fri 2026-10-09');

console.log('\n── 4. no false positives, no double-resolving ──');
eq('a prompt with no time words is untouched', p('Summarise the latest Rust release'), 'Summarise the latest Rust release');
eq('empty text stays empty', p(''), '');
assert('"this week" is not ALSO read as "past 1 week"', !p('this week').includes('past 1 week'), p('this week'));
assert('"last week" resolves exactly once', (p('last week').match(/last week =/g) || []).length === 1);
assert('original wording is preserved', p('what is new this week').startsWith('what is new this week'));
assert('resolutions are appended, not substituted', /\[Resolved time references \(device clock\):/.test(p('this week')));
const twice = preprocessText(preprocessText('this week', NOW).text, NOW).text;
eq('re-running the preprocessor is idempotent', twice, preprocessText('this week', NOW).text);

console.log('\n── 5. system-prompt clock block ──');
const block = dateTimeBlock(NOW);
has('block is labelled', block, TIME_MARKER);
has('block carries the full weekday + date', block, 'Wednesday, 9 September 2026');
has('block carries the wall-clock time', block, '14:05');
has('block carries the ISO date', block, '2026-09-09');
has('block states the week range', block, 'This week: Mon 2026-09-07 to Wed 2026-09-09');
has('block forbids guessing', block, 'Never guess the current date');
const stamped = withDateTime('You are a concise research assistant.', NOW);
has('the agent prompt survives', stamped, 'You are a concise research assistant.');
has('the clock is appended', stamped, TIME_MARKER);
eq('stamping twice leaves ONE block', (withDateTime(stamped, NOW).match(new RegExp(TIME_MARKER, 'g')) || []).length, 1);
assert('an empty prompt still gets a clock', withDateTime('', NOW).startsWith(TIME_MARKER));

console.log('\n── 6. message-list injection (/api/llm) ──');
const msgs = withDateTimeMessages(
  [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'What is new this week?' },
  ],
  NOW,
);
has('system message stamped', msgs[0].content, TIME_MARKER);
has('user message resolved', msgs[1].content, 'this week = Mon 2026-09-07 to Wed 2026-09-09');
const noSystem = withDateTimeMessages([{ role: 'user', content: 'today?' }], NOW);
eq('a missing system message is created', noSystem[0].role, 'system');
has('the created system message carries the clock', noSystem[0].content, TIME_MARKER);
const multi = withDateTimeMessages(
  [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'an answer' },
    { role: 'user', content: 'and today?' },
  ],
  NOW,
);
const lastUser = multi.map((m) => m.role).lastIndexOf('user');
assert(
  'only the LAST user turn is resolved',
  !/\[Resolved/.test(multi[1].content) && /\[Resolved/.test(multi[lastUser].content),
  JSON.stringify(multi.map((m) => m.role)),
);
assert('an empty message list is safe', Array.isArray(withDateTimeMessages([], NOW)));
assert('a non-array message list is safe', Array.isArray(withDateTimeMessages(null, NOW)));

console.log('\n── 7. the relay actually uses it (source) ──');
const relay = readFileSync(resolve('..', 'web/server/local-sse.mjs'), 'utf8');
assert('relay imports the clock module', /from '\.\/datetime\.mjs'/.test(relay));
assert('every run stamps the system prompt', /withDateTime\(run\.systemPrompt/.test(relay));
assert('the run preprocesses the user prompt', /preprocessText\(run\.prompt/.test(relay));
assert('the run clock is pinned at trigger time', /new Date\(run\.startedAt\)/.test(relay));
assert('/api/llm stamps the message list', /withDateTimeMessages\(body\.messages/.test(relay));
assert('the Tavily query is preprocessed', /preprocessText\(String\(args\.query/.test(relay));
assert('custom REST tool args are preprocessed', /resolvedArgs/.test(relay));
assert('the resolutions are surfaced in the transcript', /\[time\] \$\{resolved\.notes/.test(relay));
assert('no emoji reaches the G2 transcript (font has no glyphs)', !/🕒/.test(relay));

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
