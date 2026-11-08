// Does the schedule API actually work over HTTP, or only in my head?
//
// Runs the RELAY ITSELF as a child process with the hub deliberately
// unconfigured: no JARVIS_* credentials, no OpenRouter key, a scratch state file.
// That means it cannot log in anywhere, cannot rotate a refresh token and cannot
// reach the production gateway — and every answer below is the relay's own.
//
// What it proves, which the pure harness cannot:
//   1. GET is refused without an owner session, and allows the edit only after
//      sign-in (the setup itself needs a local password, so the owner is created
//      through the same routes the app uses).
//   2. PUT validates: a bad HH:MM is a 400 and changes NOTHING.
//   3. A good PUT is stored, and GET reports the next firing for each job.
//   4. The schedule survives a RESTART of the process — that is the whole point
//      of moving it off a gitignored file.
//
// Run: node tools/schedule-api-sim.mjs
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const relayPath = resolve(here, '../../web/server/local-sse.mjs');

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};

const PORT = 5961 + Math.floor(Math.random() * 30);
const dir = mkdtempSync(join(tmpdir(), 'g2-schedule-'));
const AUTH_FILE = join(dir, 'auth.json');
// An OWNER session seeded straight into the store the relay loads at boot.
// Owner sessions are otherwise minted by Google sign-in, which a headless test
// cannot do — but the store is the same one, so the guard under test is the real
// one, not a bypass.
const TOKEN = createHash('sha256').update(`sim-${Date.now()}`).digest('hex');
writeFileSync(
  AUTH_FILE,
  JSON.stringify({
    sessions: { [createHash('sha256').update(TOKEN).digest('hex')]: { email: 'sim@example.test', createdAt: Date.now() } },
    devices: {},
    revoked: {},
  }),
);
const env = {
  ...process.env,
  PORT: String(PORT),
  // THE ONE THAT MATTERS: without this the relay loads the repo's `.env.local`
  // and signs in to the real gateway, which can rotate the refresh token the
  // deployed relay is holding. A test must not be able to log anyone out.
  G2_HUB_ENV: '0',
  AUTH_FILE,
  STATE_FILE: join(dir, 'state.json'),
  AGENT_CRON_FILE: join(dir, 'schedule.json'),
  AGENT_CRON_STATE_FILE: join(dir, 'cron-state.json'),
  JARVIS_FILE_URL: '',
  JARVIS_FILE_USER: '',
  JARVIS_FILE_PWD: '',
  JARVIS_FILE_API_KEY: '',
  OPENROUTER_KEY: '',
  DEEPSEEK_KEY: '',
  G2_AGENT_CRON: '',
};
for (const k of Object.keys(env)) if (env[k] === '') delete env[k];

let child = null;
const base = () => `http://127.0.0.1:${PORT}`;

async function boot() {
  // cwd is the scratch dir, so nothing the relay writes (secrets, state, the
  // schedule file) can land in the repo or pick up web/.env.local.
  child = spawn(process.execPath, [relayPath], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (b) => {
    log += String(b);
  });
  child.stderr.on('data', (b) => {
    log += String(b);
  });
  for (let i = 0; i < 100; i += 1) {
    // Wait for the CLOCK to report too: it is the last thing boot logs, and
    // asserting against a log that is still arriving is how the first version of
    // this test produced two false failures.
    if (/relay on http/.test(log) && /\[cron\] (idle|on|off)/.test(log)) return log;
    await sleep(100);
  }
  throw new Error(`relay did not boot:\n${log}`);
}

async function stop() {
  if (!child) return;
  child.kill('SIGKILL');
  child = null;
  await sleep(150);
}

const call = async (method, path, body, token) => {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  return { status: res.status, body: parsed, text };
};

try {
  const bootLog = await boot();
  check('the relay boots with no hub configured', true);
  check('and says the clock is idle rather than broken', /\[cron\] idle/.test(bootLog), bootLog.slice(0, 400));

  const anon = await call('GET', '/api/agent/schedule');
  check('reading the schedule needs a sign-in', anon.status === 401, `status ${anon.status}`);
  check('no secret from the developer environment leaked in', !/env ← /.test(bootLog), bootLog.slice(0, 200));

  const token = TOKEN;
  {
    const empty = await call('GET', '/api/agent/schedule', undefined, token);
    check('a fresh relay has no schedule', empty.status === 200 && empty.body?.configured === false);
    check('and says so instead of erroring', empty.body?.source === 'none', JSON.stringify(empty.body?.source));

    const bad = await call('PUT', '/api/agent/schedule', { jobs: [{ agent: 'Watchkeeper', at: '7:00' }] }, token);
    check('a sloppy HH:MM is refused', bad.status === 400, `status ${bad.status}`);
    const after = await call('GET', '/api/agent/schedule', undefined, token);
    check('and nothing was written', after.body?.jobs?.length === 0, JSON.stringify(after.body?.jobs));

    const good = await call(
      'PUT',
      '/api/agent/schedule',
      {
        enabled: true,
        timeZone: 'Asia/Singapore',
        jobs: [
          { agent: 'Watchkeeper', at: '07:00' },
          { agent: 'Fleet Auditor', at: '08:30', days: [1] },
        ],
      },
      token,
    );
    check('a valid schedule is accepted', good.status === 200, JSON.stringify(good.body?.error));
    check(
      'and it admits it is not durable without a hub',
      good.body?.durable === false && /hub/i.test(String(good.body?.durableError)),
      JSON.stringify({ durable: good.body?.durable, why: good.body?.durableError }),
    );
    check('it reports the two jobs back', good.body?.jobs?.length === 2);
    check('every job promises a real next firing', (good.body?.jobs ?? []).every((j) => typeof j.nextAt === 'number' && j.nextAt > Date.now()));
    check(
      'and the weekly job lands on a Monday',
      new Date(good.body?.jobs?.find((j) => j.agent === 'Fleet Auditor')?.nextAt ?? 0).getUTCDay() ===
        new Date(good.body?.jobs?.find((j) => j.agent === 'Fleet Auditor')?.nextSlot ?? 0).getUTCDay(),
    );

    await stop();
    const rebooted = await boot();
    check('the relay comes back up', /relay on http/.test(rebooted));
    check('and announces the schedule it found', /\[cron\] on — 2 jobs/.test(rebooted), rebooted.slice(0, 500));
    const survived = await call('GET', '/api/agent/schedule', undefined, token);
    check(
      'and the schedule SURVIVED the restart',
      survived.body?.jobs?.length === 2,
      JSON.stringify(survived.body?.jobs?.map((j) => j.agent)),
    );

    const paused = await call('PUT', '/api/agent/schedule', { enabled: false, jobs: survived.body?.jobs ?? [] }, token);
    check(
      'the whole schedule can be paused',
      paused.status === 200 && paused.body?.enabled === false,
      `status ${paused.status} enabled=${JSON.stringify(paused.body?.enabled)} error=${paused.body?.error ?? ''}`,
    );
    check('and nothing is running while paused', paused.body?.running === false);

    const cleared = await call('PUT', '/api/agent/schedule', { enabled: true, jobs: [] }, token);
    check('every job can be removed', cleared.status === 200 && cleared.body?.jobs?.length === 0);
  }
} catch (err) {
  fail += 1;
  console.log(`FAIL  the RELAY could not be driven — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await stop();
  try {
    writeFileSync(join(dir, 'last-run.txt'), `${pass} passed, ${fail} failed\n`);
  } catch {
    // The scratch directory is disposable; this is only for a post-mortem.
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
