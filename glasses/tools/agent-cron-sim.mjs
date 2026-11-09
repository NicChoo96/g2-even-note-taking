#!/usr/bin/env node
// SCHEDULED-AGENT harness — the decision half of the clock.
//
// WHY THIS EXISTS
//   "Daily" in an agent's prompt meant nothing until this module existed: there
//   was no cron, no interval, nowhere in the relay or the app, so every daily
//   agent ran when the wearer tapped it. The moment a clock exists, the failure
//   modes are all TIME: a schedule resolved in UTC fires eight hours early for a
//   Singapore wearer; a host that was asleep at 07:00 either loses the morning or
//   replays a week of runs; and a tick that fires twice in one minute double-runs
//   and double-bills.
//
//   So this asserts the parts that are easy to get subtly wrong and impossible to
//   notice from the outside:
//     1. `HH:MM` is parsed strictly — "7:00" and "24:00" are refused, not guessed.
//     2. The wall clock is the WEARER's, resolved through Intl with an explicit
//        zone, and the day-of-week comes from the same call.
//     3. A missed slot runs LATE inside the grace window and is dropped outside
//        it, and a slot never runs twice.
//     4. A malformed file returns a value the boot path can log, and never throws.
//
// Run: node tools/agent-cron-sim.mjs

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = resolve(here, '../../web/server/agent-cron.mjs');
const src = readFileSync(mod, 'utf8');
const {
  CRON_VERSION,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_TIME_ZONE,
  MAX_JOBS_PER_DAY,
  MAX_JOBS_PER_TICK,
  describeCron,
  dueJobs,
  jobKey,
  minuteOfDay,
  nextRunAt,
  parseCronConfig,
  slotAt,
  upcomingRuns,
  zonedNow,
  zonedWallToUtc,
  // A query string makes this a FRESH module instance, so a stale cache can
  // never make an edited schedule module look unchanged.
} = await import(`${pathToFileURL(mod).href}?v=${Date.now()}`);

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
};
const checkTrue = (label, got) => check(label, got === true, true);

// ── 1. strict HH:MM ─────────────────────────────────────────────────────────
check('07:00 is 420 minutes', minuteOfDay('07:00'), 420);
check('00:00 is zero', minuteOfDay('00:00'), 0);
check('23:59 is the last minute', minuteOfDay('23:59'), 1439);
check('7:00 is refused (not zero-padded)', minuteOfDay('7:00'), null);
check('24:00 is refused', minuteOfDay('24:00'), null);
check('07:60 is refused', minuteOfDay('07:60'), null);
check('an empty string is refused', minuteOfDay(''), null);
check('a number is refused', minuteOfDay(700), null);

// ── 2. the file is validated, never trusted ─────────────────────────────────
check('bad JSON is a value, not a throw', parseCronConfig('{nope').ok, false);
check('a non-object is refused', parseCronConfig('[]').ok, false);
check('a future version is refused', parseCronConfig({ version: 99 }).ok, false);

const empty = parseCronConfig({ version: 1 });
checkTrue('an empty file is valid', empty.ok);
check('with no jobs', empty.config.jobs.length, 0);
check('and the default zone', empty.config.timeZone, DEFAULT_TIME_ZONE);
check('and the default grace', empty.config.graceMinutes, DEFAULT_GRACE_MINUTES);
check('and enabled by default', empty.config.enabled, true);

const mixed = parseCronConfig({
  version: 1,
  enabled: false,
  timeZone: 'Europe/London',
  graceMinutes: 999,
  jobs: [
    { agent: 'A', at: '07:00' },
    { agent: '', at: '08:00' },
    { agent: 'B', at: '25:00' },
    { agent: 'C', at: '09:00', days: [9, 10] },
    { agent: 'D', at: '10:00', days: [1, 3] },
    { agent: 'E', at: '11:00', enabled: false },
  ],
});
checkTrue('a file with problems is still usable', mixed.ok);
check('every broken job is reported', mixed.problems.length, 3);
check('only the usable jobs remain', mixed.config.jobs.map((j) => j.agent), ['A', 'D', 'E']);
check(
  'a job whose day list names no weekday is REFUSED, never made daily',
  mixed.config.jobs.some((j) => j.agent === 'C'),
  false,
);
check('a real day list is kept', mixed.config.jobs[1].days, [1, 3]);
// The page reads a schedule back and saves it again, so what this module EMITS
// has to be something it ACCEPTS. `days: null` is its own word for "every day";
// refusing it made every edit of an un-pinned job a 400.
check(
  'but days:null round-trips as every day',
  parseCronConfig({ jobs: [{ agent: 'Weather', at: '06:00', days: null }] }).problems.length,
  0,
);
check(
  'an empty day list is still refused',
  parseCronConfig({ jobs: [{ agent: 'Weather', at: '06:00', days: [] }] }).problems.length,
  1,
);
check('a disabled job is kept but marked', mixed.config.jobs[2].enabled, false);
check('grace is clamped to an hour-based ceiling', mixed.config.graceMinutes, 180);
check('the zone is kept', mixed.config.timeZone, 'Europe/London');
check('enabled:false is kept', mixed.config.enabled, false);

const negative = parseCronConfig({ version: 1, graceMinutes: -5 });
check('a negative grace clamps to zero', negative.config.graceMinutes, 0);

// ── 3. the wall clock is the WEARER's ───────────────────────────────────────
// 22:00 UTC is 06:00 the next morning in Singapore. A getHours() implementation
// would call this 22:00 and fire nothing all day.
const tenPMUtc = Date.parse('2026-11-08T22:00:00Z');
const sgt = zonedNow(tenPMUtc, 'Asia/Singapore');
check('22:00 UTC is 06:00 in Singapore', sgt.slot.slice(11), '06:00');
check('and on the NEXT calendar day', sgt.slot.slice(0, 10) > '2026-11-08', true);
check('minutes agree with the slot', sgt.minutes, 360);
// The weekday is asserted against Date.UTC rather than against Intl twice.
const expectedDow = new Date(`${sgt.date}T00:00:00Z`).getUTCDay();
check('the day-of-week matches the zoned date', sgt.dayOfWeek, expectedDow);

const utc = zonedNow(tenPMUtc, 'UTC');
check('the same instant in UTC is 22:00', utc.slot.slice(11), '22:00');
check('an unknown zone falls back and says so', zonedNow(tenPMUtc, 'Mars/Olympus').zoneFault, 'Mars/Olympus');
check('floor midnight is 00:00, not 24:00', zonedNow(Date.parse('2026-11-08T16:00:00Z'), 'Asia/Singapore').slot.slice(11), '00:00');

// ── 4. which jobs are due ───────────────────────────────────────────────────
const config = parseCronConfig({
  version: 1,
  timeZone: 'Asia/Singapore',
  graceMinutes: 20,
  jobs: [{ agent: 'Weather', at: '06:00', days: [expectedDow] }, { agent: 'Other', at: '23:00' }],
}).config;

check('at 06:00 it is due', dueJobs(config, tenPMUtc, {}).map((d) => d.job.agent), ['Weather']);
check('and it is not late', dueJobs(config, tenPMUtc, {})[0].lateMinutes, 0);

const nineteenLate = tenPMUtc + 19 * 60 * 1000;
const late = dueJobs(config, nineteenLate, {});
check('19 minutes late is still due (grace 20)', late.length, 1);
check('and reports how late', late[0].lateMinutes, 19);

check('21 minutes late is MISSED, not replayed', dueJobs(config, tenPMUtc + 21 * 60 * 1000, {}).length, 0);
check('one minute early is not due', dueJobs(config, tenPMUtc - 60 * 1000, {}).length, 0);

const ran = { [jobKey({ agent: 'Weather', at: '06:00' })]: slotAt(tenPMUtc, 'Asia/Singapore') };
check('a slot that already ran does not run again', dueJobs(config, tenPMUtc, ran).length, 0);
check('even a minute later inside the window', dueJobs(config, tenPMUtc + 60 * 1000, ran).length, 0);
const everyDay = { ...config, jobs: [{ agent: 'Weather', at: '06:00' }] };
const ranEveryDay = { [jobKey({ agent: 'Weather', at: '06:00' })]: slotAt(tenPMUtc, 'Asia/Singapore') };
check(
  'but the NEXT day is a new slot',
  dueJobs(everyDay, tenPMUtc + 24 * 60 * 60 * 1000, ranEveryDay).length,
  1,
);
check(
  'a weekday-pinned job does NOT run on the wrong day',
  dueJobs(config, tenPMUtc + 24 * 60 * 60 * 1000, ran).length,
  0,
);

const otherDay = { ...config, jobs: [{ ...config.jobs[0], days: [(expectedDow + 3) % 7] }] };
check('a job not scheduled today is not due', dueJobs(otherDay, tenPMUtc, {}).length, 0);
check('a job with no days runs every day', dueJobs({ ...config, jobs: [{ agent: 'X', at: '06:00' }] }, tenPMUtc, {}).length, 1);
check('a disabled schedule runs nothing', dueJobs({ ...config, enabled: false }, tenPMUtc, {}).length, 0);
check('a disabled JOB runs nothing', dueJobs({ ...config, jobs: [{ ...config.jobs[0], enabled: false }] }, tenPMUtc, {}).length, 0);
check('dueJobs never throws on a null config', dueJobs(null, tenPMUtc, {}), []);

// ── 4b. a COLLECTOR job: a plain HTTPS call with no model in it ────────────
// The second job kind. It exists so "collect this number every morning" does
// not require paying a model to fetch a JSON field — and it is validated at the
// same gate as everything else, because a collector that never fires is silent.
const collectors = parseCronConfig({
  jobs: [
    {
      kind: 'fetch',
      series: 'sgx.dbs.price',
      at: '09:00',
      select: 'data.last',
      request: { url: 'https://api.example.com/quote', method: 'GET', headers: '{"X-Api-Key":"env:K"}' },
    },
    { kind: 'fetch', series: 'x.y', at: '10:00', request: { url: 'http://insecure.example.com' } },
    { kind: 'fetch', at: '11:00', request: { url: 'https://api.example.com' } },
    { kind: 'fetch', series: 'a.b', at: '12:00', request: { url: 'https://api.example.com', method: 'DELETE' } },
    { kind: 'fetch', series: 'a.b', at: '7:00', request: { url: 'https://api.example.com' } },
  ],
});
check('a collector job is kept', collectors.config.jobs.length, 1);
check('with its series', collectors.config.jobs[0]?.series, 'sgx.dbs.price');
check('and its select path', collectors.config.jobs[0]?.select, 'data.last');
check('and its method', collectors.config.jobs[0]?.request?.method, 'GET');
check('and its header template', collectors.config.jobs[0]?.request?.headers, '{"X-Api-Key":"env:K"}');
check('every refusal is reported, not silent', collectors.problems.length, 4);
checkTrue('a plain http:// collector is refused', collectors.problems.some((p) => /https/.test(p)));
checkTrue('a collector with no series is refused', collectors.problems.some((p) => /no series/.test(p)));
checkTrue('an unsupported method is refused', collectors.problems.some((p) => /method/.test(p)));
// The key is what the state file records, so a collector and an agent at the same
// minute must never share one.
check('a collector keys by series', jobKey(collectors.config.jobs[0]), 'sgx.dbs.price|09:00');
check('an agent still keys by name', jobKey({ agent: 'Watchkeeper', at: '09:00' }), 'watchkeeper|09:00');
check(
  'a collector is described by its series',
  describeCron(collectors.config),
  '1 job (Asia/Singapore): 09:00 sgx.dbs.price (fetch)',
);

// ── 5. the caps exist and are small enough to matter ────────────────────────checkTrue('per-tick cap is 1..4', MAX_JOBS_PER_TICK >= 1 && MAX_JOBS_PER_TICK <= 4);
checkTrue('daily cap is below a fleet of 20', MAX_JOBS_PER_DAY > 0 && MAX_JOBS_PER_DAY < 20);
check('the version is pinned', CRON_VERSION, 1);

// ── 6. the boot log says what will happen ──────────────────────────────────
check('an empty schedule says zero jobs', describeCron({ jobs: [], timeZone: 'UTC' }), '0 jobs (UTC)');
const described = describeCron(config);
checkTrue('a real schedule names the jobs and the zone', /2 jobs \(Asia\/Singapore\): 06:00 Weather/.test(described));
check('no schedule at all is said plainly', describeCron(null), 'no schedule');

// ── 6b. WHAT THE PAGE PROMISES: the next firing ────────────────────────────
// A schedule the wearer cannot inspect is the state this feature was stuck in.
// These assert the answer the page prints, so "next 07:00" can be trusted or
// caught rather than believed.
const atSixUtc = Date.UTC(2026, 0, 5, 6, 0, 0); // Mon 5 Jan 2026, 14:00 SGT
const sevenSgt = { agent: 'Brief', at: '07:00', minutes: 420, days: null, enabled: true };

// Singapore is UTC+8, so 07:00 SGT is 23:00 UTC the day BEFORE. Getting this
// sign wrong is a whole day of error, which is why it is asserted directly.
check(
  '07:00 in Singapore is 23:00 UTC the day before',
  new Date(zonedWallToUtc(2026, 1, 6, 420, 'Asia/Singapore')).toISOString(),
  '2026-01-05T23:00:00.000Z',
);
check(
  'an already-passed time is tomorrow, not now',
  new Date(nextRunAt(sevenSgt, atSixUtc, 'Asia/Singapore')).toISOString(),
  '2026-01-05T23:00:00.000Z',
);
const afterSgtMorning = Date.UTC(2026, 0, 6, 0, 0, 0); // 08:00 SGT on the 6th
check(
  'a time still ahead today is today',
  new Date(nextRunAt({ ...sevenSgt, at: '12:00', minutes: 720 }, afterSgtMorning, 'Asia/Singapore')).toISOString(),
  '2026-01-06T04:00:00.000Z',
);
check(
  'a day-pinned job finds that weekday, not the next minute',
  new Date(nextRunAt({ ...sevenSgt, days: [0] }, atSixUtc, 'Asia/Singapore')).toISOString(),
  '2026-01-10T23:00:00.000Z', // Sunday 11 Jan, 07:00 SGT
);
check('a paused job promises nothing', nextRunAt({ ...sevenSgt, enabled: false }, atSixUtc, 'Asia/Singapore'), null);
check('a job with no usable time promises nothing', nextRunAt({ agent: 'X', at: 'oops' }, atSixUtc, 'Asia/Singapore'), null);
const queue = upcomingRuns(
  { timeZone: 'Asia/Singapore', jobs: [{ ...sevenSgt, at: '18:00', minutes: 1080 }, sevenSgt] },
  atSixUtc,
);
// 14:00 SGT: tonight's 18:00 is sooner than tomorrow's 07:00, so the later
// CLOCK TIME sorts first. Ordering by the time-of-day field would put 07:00 on
// top and quietly lie about what happens next.
check('the queue is earliest first', queue.map((r) => r.job.at), ['18:00', '07:00']);
check('and empty for no schedule', upcomingRuns(null, atSixUtc), []);

// ── 7. the relay's wiring is present and ordered ───────────────────────────
const relay = readFileSync(resolve(here, '../../web/server/local-sse.mjs'), 'utf8');
checkTrue('the relay imports the schedule module', /from '\.\/agent-cron\.mjs'/.test(relay));
checkTrue('the relay has a tick', /async function cronTick\(/.test(relay));
checkTrue('started after the port is open, not before', relay.indexOf('startAgentCron();') > relay.indexOf('server.listen(PORT'));
checkTrue('the timer cannot hold the process open', /timer\.unref/.test(relay));
checkTrue('an env kill switch exists', /G2_AGENT_CRON/.test(relay));
// The interesting property is ORDER: a roster that cannot be read must return
// BEFORE any slot is marked, or a hub outage silently eats the morning.
const rosterBranch = relay.slice(relay.indexOf("roster unavailable"), relay.indexOf("roster unavailable") + 260);
checkTrue('a missing hub roster does NOT spend the slot', rosterBranch.includes('return;') && !rosterBranch.includes('state.slots'));
checkTrue('a run is started with the agent OWN prompt', /prompt: savedTask/.test(relay));

// ── 8. the schedule has a HOME, and a control surface ──────────────────────
// The first version read a gitignored file, so a deployed relay could never have
// a schedule, and the only knob was an environment variable — which is how a
// working clock came to look like a missing feature. These pin the fix.
checkTrue(
  'the schedule is stored on the hub, not only on disk',
  // The key is env-overridable now, so the literal `/relay/agent-cron` is no
  // longer the whole story: the DEFAULT has to be agent-cron, and test keys have
  // to be possible without editing code.
  /SCHEDULE_HUB_PATH = `\/relay\/\$\{[^}]*G2_SCHEDULE_KEY[^}]*\}`/.test(relay) && /'agent-cron'/.test(relay),
);
checkTrue('it is read from the hub at boot', /client\.call\('GET', SCHEDULE_HUB_PATH\)/.test(relay));
checkTrue(
  'it is written back as a whole value',
  /client\.call\('PUT', SCHEDULE_HUB_PATH, \{ body: \{ value: storedSchedule\(config\) \} \}\)/.test(relay),
);
checkTrue('the page can read it', /url\.pathname === '\/api\/agent\/schedule' && req\.method === 'GET'/.test(relay));
checkTrue('the page can replace it', /url\.pathname === '\/api\/agent\/schedule' && req\.method === 'PUT'/.test(relay));
checkTrue('a run can be started on demand', /'\/api\/agent\/schedule\/run'/.test(relay));
// "Run now" created a run record and never executed it, so the page said
// "Started …" and the record sat at Thinking… for ever. Both halves are asserted
// because either one alone looks fine: a run nobody broadcasts is invisible, and a
// broadcast run nobody executes is a corpse the UI keeps showing.
const runBranch = relay.slice(relay.indexOf("'/api/agent/schedule/run'"));
// 6000, not 2000: the route carries a long comment about exactly this bug, and a
// slice that stops before the code it exists to find is a false FAIL.
checkTrue('a run started from the page is BROADCAST to the clients', /broadcastRun\(run\)/.test(runBranch.slice(0, 6000)));
checkTrue(
  'and actually EXECUTED, with the failure routed to the run',
  /void executeRun\(run\)\.catch\([\s\S]{0,80}?failRun\(run/.test(runBranch.slice(0, 6000)),
);
// A whole-document PUT from a caller that forgot to read first deletes every job
// it did not know about. That is how a four-job schedule was wiped with a 200 OK.
checkTrue('an accidental wipe is refused', /WOULD_EMPTY_SCHEDULE/.test(relay));
checkTrue('and an intentional one is allowed', /confirmEmpty !== true/.test(relay));
// The probe that caused that wipe must never be able to point at the real key.
checkTrue('the hub key can be pointed elsewhere for tests', /G2_SCHEDULE_KEY/.test(relay));
// Owner-only: a schedule spends money unattended, so a paired device must not
// be able to edit it.
const putBranch = relay.slice(relay.indexOf("'/api/agent/schedule' && req.method === 'PUT'"));
checkTrue('editing the schedule needs the owner', putBranch.slice(0, 400).includes('requireOwner'));

// ── the tick must actually RUN what it starts ──────────────────────────────
// Found live: the Schedule tab claimed "last ran 06:45" for seven jobs, and not
// one run existed — no session, no tool call, no file. The tick called
// `startAgentRun` (which only creates the record) and marked the slot.
const tickBranch = relay.slice(relay.indexOf('const agentDue'), relay.indexOf('const agentDue') + 4000);
checkTrue('a scheduled run is broadcast to the clients', /broadcastRun\(res\.run\)/.test(tickBranch));
checkTrue(
  'and executed, with a failure routed to the run',
  /void executeRun\(res\.run\)\.catch\([\s\S]{0,80}?failRun\(res\.run/.test(tickBranch),
);
// Order matters more than presence: the slot and the daily counter used to be
// spent BEFORE the refusal was inspected, so a misconfigured model burned all
// twelve slots by lunchtime and reported a satisfied schedule.
const refusalAt = tickBranch.indexOf('if (!res.ok)');
const countAt = tickBranch.indexOf('state.count += 1');
checkTrue('a refusal is inspected before the budget is spent', refusalAt > 0 && refusalAt < countAt);

// Which slots have fired is the only thing stopping a deploy from re-running the
// morning, so it cannot live on a container's disk alone.
checkTrue('the clock state is written to the hub', /PUT', CRON_STATE_HUB_PATH/.test(relay));
checkTrue('and read back at boot', /call\('GET', CRON_STATE_HUB_PATH\)/.test(relay));
// ...and the first tick must wait for that read, or it re-fires what it just
// failed to remember.
checkTrue('the first tick waits for the state, not just the schedule', /cronReady\.then\(\(\) => cronTick\(\)\)/.test(relay));
// A schedule half-saved is a schedule that runs something nobody asked for.
const validateIdx = putBranch.indexOf('parseCronConfig(body)');
checkTrue('every job is validated before anything is written', validateIdx > 0 && validateIdx < putBranch.indexOf('saveCronConfig'));
// The timer must not depend on a file existing at boot, or saving a schedule
// would still need a redeploy — the exact thing that made this look broken.
const bootFn = relay.slice(relay.indexOf('function startAgentCron()'), relay.indexOf('server.listen(PORT'));
checkTrue('the clock starts even with nothing configured', bootFn.includes('loadCronConfig') && !/return;\s*\n\s*}\s*\n\s*const read/.test(bootFn));
checkTrue('the kill switch is still reported, not silently obeyed', /killed:/.test(relay));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
