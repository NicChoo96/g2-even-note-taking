// WHEN an agent runs without a device — the schedule half of the cron.
//
// WHY THIS EXISTS
//   Until now the fleet had cadence written into its prompts ("daily", "every
//   morning") and NO CLOCK anywhere: no cron, no interval, in the relay or in
//   the app. "Daily" therefore meant "when the wearer taps it". That is fine for
//   a research agent you poke, and wrong for the class of agent worth having —
//   a watcher that has to notice a threshold crossing at 07:00 whether or not
//   anyone is awake.
//
//   The clock belongs on the SERVER, because the server is the only thing that is
//   running when the phone is in a pocket and the glasses are on a table. This
//   module is the decision half of that: given a schedule and a moment, WHICH
//   jobs are due. It reads no files, starts no runs, and never throws — the
//   relay does the I/O and the running, exactly as it does for a tool call.
//
// TIME ZONES ARE THE WHOLE POINT
//   "07:00" must mean 07:00 where the wearer lives, not 07:00 UTC. Railway runs
//   in UTC, so a schedule resolved with `getHours()` would drift by eight hours.
//   Every wall-clock value here comes from `Intl.DateTimeFormat` with an explicit
//   zone, and the day-of-week comes from the same call so a DST or a zone change
//   can never move the hour and the weekday independently.
//
// CATCH-UP, AND WHY IT IS BOUNDED
//   A host that slept through 07:00 should still run the 07:00 job shortly after
//   it wakes, or a restart at 06:59 silently costs the wearer their morning. But
//   an UNBOUNDED catch-up would replay every missed job after a long outage and
//   bill for a week of them at once. So there is a grace window (default 20
//   minutes): inside it a job is due, outside it the slot is missed and said so.
//   The slot key is exact, which also makes a tick that fires twice in one minute
//   harmless.

/** Bumped when the file's meaning changes, so an old file is refused not guessed. */
export const CRON_VERSION = 1;

/** Where the wearer is. A schedule without a zone is a schedule in UTC, which is wrong. */
export const DEFAULT_TIME_ZONE = 'Asia/Singapore';

/** How late a missed job may still run once the host is awake. */
export const DEFAULT_GRACE_MINUTES = 20;

/** How many jobs one tick may start, so a wake-up burst cannot fan out. */
export const MAX_JOBS_PER_TICK = 2;

/** A hard daily ceiling, whatever the file says. */
export const MAX_JOBS_PER_DAY = 12;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `'07:30'` → 450. `null` for anything else. */
export function minuteOfDay(at) {
  const m = HHMM.exec(String(at ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A job's stable identity: the agent plus the time it is pinned to. */
export function jobKey(job) {
  return `${String(job?.agent ?? '').trim().toLowerCase()}|${String(job?.at ?? '').trim()}`;
}

/**
 * The wall clock at `nowMs` in `timeZone`.
 *
 * `slot` is `YYYY-MM-DD HH:MM` — one string to compare against the recorded run,
 * which is cheaper and less error-prone than comparing a timestamp and then
 * having to decide whether "same minute" means the same second too.
 */
export function zonedNow(nowMs, timeZone = DEFAULT_TIME_ZONE) {
  const zone = String(timeZone ?? '').trim() || DEFAULT_TIME_ZONE;
  let parts;
  try {
    // en-CA gives ISO-shaped numbers, and hourCycle h23 keeps midnight as 00
    // rather than 24 — a 24 here would make "00:30" unexpressible.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  } catch {
    // An unknown zone name is a CONFIGURATION fault, not a reason to stop time.
    // Fall back to the default zone and report it, so the relay can log once.
    return { ...zonedNow(nowMs, DEFAULT_TIME_ZONE), zoneFault: zone };
  }
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    slot: `${parts.year}-${parts.month}-${parts.day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + minute,
    dayOfWeek: dayOfWeek < 0 ? 0 : dayOfWeek,
    zone,
  };
}

/**
 * Validate a schedule file's contents.
 *
 * Returns a VALUE, never throws: the caller is a server boot path, and a typo in
 * a schedule must cost a logged refusal rather than the relay.
 */
export function parseCronConfig(raw) {
  let body = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (!body || typeof body !== 'object') return { ok: false, error: 'not an object' };
  if (Array.isArray(body)) return { ok: false, error: 'an array is not a schedule' };
  const version = Number(body.version ?? CRON_VERSION);
  if (version !== CRON_VERSION) {
    return { ok: false, error: `version ${version} is not ${CRON_VERSION}` };
  }
  const jobsIn = Array.isArray(body.jobs) ? body.jobs : [];
  const jobs = [];
  const problems = [];
  for (const [i, j] of jobsIn.entries()) {
    const agent = String(j?.agent ?? j?.agentId ?? '').trim();
    const at = String(j?.at ?? '').trim();
    if (!agent) {
      problems.push(`job ${i}: no agent`);
      continue;
    }
    const minutes = minuteOfDay(at);
    if (minutes === null) {
      problems.push(`job ${i} (${agent}): at "${at}" is not HH:MM`);
      continue;
    }
    const days = Array.isArray(j?.days)
      ? j.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : null;
    // A day list that names NO real weekday is a fault, not an instruction to run
    // every day. Coercing it to daily would run an agent seven times as often as
    // the wearer asked, which is the one direction this must never guess in.
    if (j?.days !== undefined && !days?.length) {
      problems.push(`job ${i} (${agent}): days ${JSON.stringify(j.days)} names no real weekday`);
      continue;
    }
    jobs.push({
      agent,
      at,
      minutes,
      // Omitted (or empty by design) means every day.
      days: days && days.length ? days : null,
      ask: String(j?.ask ?? '').trim(),
      enabled: j?.enabled !== false,
    });
  }
  return {
    ok: true,
    config: {
      version: CRON_VERSION,
      enabled: body.enabled !== false,
      timeZone: String(body.timeZone ?? '').trim() || DEFAULT_TIME_ZONE,
      graceMinutes: Number.isFinite(Number(body.graceMinutes))
        ? Math.max(0, Math.min(180, Number(body.graceMinutes)))
        : DEFAULT_GRACE_MINUTES,
      jobs,
    },
    problems,
  };
}

/**
 * Which jobs are due at `nowMs`, given what has already run.
 *
 * `lastRuns` is `{ [jobKey]: slot }` where slot is the `YYYY-MM-DD HH:MM` that ran.
 * A job is due when: it is enabled, its weekday matches (or it has none), the
 * clock is at or after its minute and within the grace window, and its exact slot
 * has not already been recorded.
 */
export function dueJobs(config, nowMs, lastRuns = {}) {
  if (!config || config.enabled === false) return [];
  const now = zonedNow(nowMs, config.timeZone);
  const out = [];
  for (const job of config.jobs ?? []) {
    if (job.enabled === false) continue;
    if (job.days && !job.days.includes(now.dayOfWeek)) continue;
    const late = now.minutes - job.minutes;
    if (late < 0 || late > (config.graceMinutes ?? DEFAULT_GRACE_MINUTES)) continue;
    const slot = `${now.date} ${job.at}`;
    if (lastRuns[jobKey(job)] === slot) continue;
    out.push({ key: jobKey(job), job, slot, lateMinutes: late, now });
  }
  return out;
}

/** The slot a job would record if it ran at `nowMs` (punctuation-free, for state). */
export function slotAt(nowMs, timeZone = DEFAULT_TIME_ZONE) {
  return zonedNow(nowMs, timeZone).slot;
}

/** One human line describing the schedule, for the boot log. */
export function describeCron(config) {
  if (!config) return 'no schedule';
  const zone = config.timeZone ?? DEFAULT_TIME_ZONE;
  const jobs = (config.jobs ?? []).filter((j) => j.enabled !== false);
  if (!jobs.length) return `0 jobs (${zone})`;
  const names = jobs.slice(0, 6).map((j) => `${j.at} ${j.agent}`).join(', ');
  return `${jobs.length} job${jobs.length === 1 ? '' : 's'} (${zone}): ${names}${jobs.length > 6 ? ', …' : ''}`;
}
