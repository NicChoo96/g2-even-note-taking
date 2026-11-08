// Put a working schedule on the hub — the fleet's default day.
//
// WHY A SCRIPT
//   The schedule is ONE document on the hub (`/hub/relay/agent-cron`), and every
//   write replaces it wholesale. That is how a real four-job schedule was wiped: a
//   caller sent `jobs: []` and the hub answered 200. This file is the schedule as
//   CODE, so rebuilding it is one command instead of an act of memory.
//
// WHY IT WRITES THE HUB DOCUMENT, NOT /api/agent/schedule
//   The relay's route needs an OWNER session; the relay's own API key is
//   allow-listed for the document the relay reads at boot. Writing that same
//   document means the seed works from a terminal with the key alone, and the relay
//   validates it on load exactly as it validates a save from the page.
//
// THE RULE BEHIND THE TIMES
//   All Asia/Singapore, ordered the way a morning actually goes: weather first (it
//   decides what you wear), then the news, then the brief that summarises the runs
//   above it, then the market desks at the close, then the evening checks. No two
//   jobs share a minute — the relay fires at most two per tick, so a collision
//   silently drops one — and a weekday total of 9 sits inside the 12/day cap with
//   room for a weekly job.
//
// USAGE
//   node --env-file=web/.env.local scripts/seed-agent-schedule.mjs            # plan
//   node --env-file=web/.env.local scripts/seed-agent-schedule.mjs --apply
//   ... --keep-existing    # merge: keep jobs already there, replace only ties
//
// ASCII only.

const base = String(process.env.JARVIS_FILE_URL || process.env.JARVIS_URL || '').replace(/\/+$/, '');
const token = String(process.env.JARVIS_FILE_API_KEY || process.env.JARVIS_API_KEY || '').trim();
if (!base || !token) {
  console.error('FAILED: need JARVIS_FILE_URL + JARVIS_FILE_API_KEY (pass --env-file=web/.env.local)');
  process.exit(2);
}
const apply = process.argv.includes('--apply');
const keepExisting = process.argv.includes('--keep-existing');

const KEY = process.env.G2_SCHEDULE_KEY || 'agent-cron';
const WEEKDAYS = [1, 2, 3, 4, 5];

/** The day, in order. `why` is not decoration: a schedule nobody can explain is
 *  a schedule nobody dares change. */
const JOBS = [
  { agent: 'Singapore Weather', at: '06:45', days: WEEKDAYS, why: 'the forecast decides the commute' },
  { agent: 'Singapore Workday Brief', at: '07:00', days: WEEKDAYS, why: 'what today looks like before it starts' },
  { agent: 'Watchkeeper', at: '07:05', days: null, why: 'speaks only when something crosses a rule' },
  { agent: 'Singapore trending news', at: '07:10', days: WEEKDAYS, why: 'what people are talking about today' },
  { agent: 'AI Equities Desk', at: '07:15', days: WEEKDAYS, why: 'the US close, read at breakfast' },
  { agent: 'Brief Composer', at: '07:20', days: WEEKDAYS, why: 'composes LAST, so it reads the runs above' },
  { agent: 'News Desk', at: '12:00', days: WEEKDAYS, why: 'a midday top-up, not a second morning' },
  { agent: 'SG Banks Desk', at: '17:30', days: WEEKDAYS, why: 'the local close' },
  { agent: 'Commitment Keeper', at: '20:30', days: null, why: 'the evening check on promises made today' },
  { agent: 'AI Model Tracker', at: '08:00', days: [1], why: 'weekly, Monday: a comparison you re-read' },
  { agent: 'Fleet Auditor', at: '20:00', days: [0], why: 'weekly, Sunday: did the week actually run' },
  { agent: 'YouTube Watch Later', at: '19:00', days: [0], why: 'weekly, Sunday: the watch list as a page' },
];

const json = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Connection: 'close',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, body: parsed, text };
};

const roster = await json('GET', '/hub/agents');
if (!roster.ok) {
  console.error(`FAILED: GET /hub/agents — ${roster.status}`);
  process.exit(2);
}
const names = new Set((roster.body?.agents ?? []).map((a) => String(a.name)));

const current = await json('GET', `/hub/relay/${encodeURIComponent(KEY)}`);
if (!current.ok) {
  console.error(`FAILED: GET /hub/relay/${KEY} — ${current.status} ${String(current.body?.error ?? '')}`);
  console.error('  (the relay key must be allow-listed for this key: HUB_RELAY_WRITERS)');
  process.exit(2);
}
const doc = current.body?.value ?? {};
const existing = Array.isArray(doc.jobs) ? doc.jobs : [];
// A `probe.`-prefixed declaration is a test's, never the wearer's, and leaving one
// in the document is what makes the Data tab show a series nobody asked for. They
// are dropped here so a seed also cleans up after the probes.
const allSeries = Array.isArray(doc.series) ? doc.series : [];
const series = allSeries.filter((s) => !String(s?.key ?? '').startsWith('probe.'));
if (series.length !== allSeries.length) {
  console.log(`  dropping ${allSeries.length - series.length} probe series declaration(s) from the document`);
}

// A job for an agent that does not exist fails every morning, so it is dropped
// HERE, with the reason, rather than at 06:45.
const wanted = JOBS.filter((j) => {
  if (names.has(j.agent)) return true;
  console.log(`  SKIP (no such agent): ${j.agent}`);
  return false;
});

// No two jobs in the same minute: the relay fires at most two per tick, and a
// collision would drop one silently.
const seen = new Map();
for (const j of wanted) {
  if (seen.has(j.at)) {
    console.error(`FAILED: ${j.agent} and ${seen.get(j.at)} are both at ${j.at}`);
    process.exit(2);
  }
  seen.set(j.at, j.agent);
}

const key = (j) => `${String(j.agent).toLowerCase()}|${j.at}`;
const incoming = keepExisting
  ? [...existing.filter((e) => !wanted.some((w) => key(w) === key(e))), ...wanted]
  : wanted;

const daysLabel = (d) => (!d ? 'every day' : d.join(','));

console.log(`\nSchedule document: ${KEY}`);
console.log(`  there now: ${existing.length} job(s)${existing.length ? ` — ${existing.map((j) => j.agent).join(', ')}` : ''}`);
console.log(`  writing:   ${incoming.length} job(s) — ${keepExisting ? 'merged' : 'replacing'}`);
console.log(`  series kept: ${series.length}\n`);
for (const j of wanted) {
  console.log(`  ${j.at}  ${j.agent.padEnd(26)} ${daysLabel(j.days).padEnd(10)} ${j.why}`);
}

if (!apply) {
  console.log('\nPlan only. Re-run with --apply to write it.');
  process.exit(0);
}

const value = {
  version: Number(doc.version) || 1,
  enabled: true,
  timeZone: doc.timeZone || 'Asia/Singapore',
  graceMinutes: Number(doc.graceMinutes) || 20,
  // Declarations ride with the schedule, so a seed that only knows about jobs
  // preserves them rather than silently resetting them.
  series,
  jobs: incoming.map((j) => ({
    agent: j.agent,
    at: j.at,
    days: j.days ?? null,
    ask: j.ask ?? '',
    enabled: j.enabled !== false,
  })),
};

// The relay-state route takes ONLY `value` — probed: `{value, rev}` and
// `{value, idempotencyKey}` are both `400 unknown field in the relay body`. There
// is no revision to hold and therefore no optimistic concurrency here at all: the
// last writer wins. That is precisely why the relay's own save route refuses a
// write that would empty a non-empty schedule, and why a probe must never point at
// this key.
const saved = await json('PUT', `/hub/relay/${encodeURIComponent(KEY)}`, { value });
if (!saved.ok) {
  console.error(`\nFAILED: PUT — ${saved.status} ${String(saved.body?.error ?? '')}`);
  process.exit(1);
}
console.log('\nSaved.');

// Verify by RE-READING: a 200 from the write is not the same claim as a document
// that reads back the way it was written.
const after = await json('GET', `/hub/relay/${encodeURIComponent(KEY)}`);
const kept = Array.isArray(after.body?.value?.jobs) ? after.body.value.jobs : [];
console.log(`read back: ${kept.length} job(s) — ${kept.length === incoming.length ? 'matches' : 'MISMATCH'}`);
console.log('The relay picks this up on restart; re-open the Schedule tab to see it.');
if (kept.length !== incoming.length) process.exit(1);
