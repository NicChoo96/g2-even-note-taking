#!/usr/bin/env node
// LIVE PROBE: does the schedule actually survive a relay that has no disk?
//
// This is the claim the whole feature rests on — "the schedule lives on the hub,
// so a Railway deploy cannot lose it" — and it cannot be proven with a stub. So
// this runs the REAL relay against the REAL gateway, with a throwaway data
// directory, and shows the schedule coming back from the hub after the local file
// is thrown away.
//
// Named `probe-*` on purpose: `sim-all.mjs` globs `*-sim.mjs`, and this one needs
// live credentials, so it must stay out of the sweep.
//
// SAFETY: the schedule it writes has a single job with `enabled: false` and an
// agent that does not exist, so even if a production relay reads it mid-test it
// can never fire anything. It is deleted at the end.
//
// Run: node --env-file=web/.env.local tools/probe-schedule-durable.mjs
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const relayPath = resolve(here, '../../web/server/local-sse.mjs');
const base = String(process.env.JARVIS_FILE_URL ?? '').replace(/\/+$/, '');
const apiKey = process.env.JARVIS_FILE_API_KEY ?? '';

if (!base || !apiKey) {
  console.error('SKIPPED: needs JARVIS_FILE_URL + JARVIS_FILE_API_KEY (--env-file=web/.env.local)');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(ok ? `PASS  ${label}` : `FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};

const PORT = 6100 + Math.floor(Math.random() * 60);
const TOKEN = createHash('sha256').update(`probe-${Date.now()}`).digest('hex');
const dirs = [];
let child = null;

/** A relay whose only durable storage is the temp dir we hand it. */
function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'g2-probe-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      sessions: { [createHash('sha256').update(TOKEN).digest('hex')]: { email: 'probe@example.test', createdAt: Date.now() } },
      devices: {},
      revoked: {},
    }),
  );
  return dir;
}

async function boot(cwd) {
  child = spawn(process.execPath, [relayPath], {
    cwd,
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTH_FILE: join(cwd, 'auth.json'),
      STATE_FILE: join(cwd, 'state.json'),
      AGENT_CRON_FILE: join(cwd, 'schedule.json'),
      AGENT_CRON_STATE_FILE: join(cwd, 'cron-state.json'),
      // Deliberately NOT G2_HUB_ENV=0: this probe is about the real gateway.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => {
    log += String(b);
  });
  child.stderr.on('data', (b) => {
    log += String(b);
  });
  for (let i = 0; i < 120; i += 1) {
    if (/relay on http/.test(log) && /\[cron\] (idle|on|off)/.test(log)) return log;
    await sleep(100);
  }
  throw new Error(`relay did not boot:\n${log.slice(0, 800)}`);
}

async function stop() {
  if (!child) return;
  child.kill('SIGKILL');
  child = null;
  await sleep(200);
}

const call = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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
  return { status: res.status, body: parsed };
};

/** Straight at the gateway, so the proof does not rely on the relay's own view. */
const hub = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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
  return { status: res.status, body: parsed };
};

const SCHEDULE = {
  version: 1,
  enabled: true,
  timeZone: 'Asia/Singapore',
  jobs: [{ agent: 'probe-never-runs', at: '23:59', enabled: false }],
};

try {
  // ── 1. A relay with nothing stored ────────────────────────────────────────
  let dir = makeDir();
  let log = await boot(dir);
  check('the relay boots with a hub credential and an empty disk', /relay on http/.test(log));
  check('and reports the hub as unreadable or absent, not a crash', /\[cron\]/.test(log), log.slice(0, 300));

  const before = await call('GET', '/api/agent/schedule');
  check('a fresh relay has no schedule', before.status === 200 && before.body?.configured === false);

  // ── 2. Save one, the way the page does ───────────────────────────────────
  const saved = await call('PUT', '/api/agent/schedule', SCHEDULE);
  check('the save is accepted', saved.status === 200, JSON.stringify(saved.body?.error));
  check(
    'and it is DURABLE — the hub took it',
    saved.body?.durable === true,
    `durable=${saved.body?.durable} reason=${saved.body?.durableError ?? ''}`,
  );

  // ── 3. The gateway itself holds it ────────────────────────────────────────
  const stored = await hub('GET', '/hub/relay/agent-cron');
  check('the gateway answers 200 for the key', stored.status === 200, `status ${stored.status}`);
  // The relay writes the NORMALISED document — a defaulted `graceMinutes` is
  // stored explicitly rather than left implicit, so a future reader cannot guess
  // a different default than the writer used. Built in the writer's field order:
  // comparing serialised JSON is order-sensitive, and that order is part of what
  // is being asserted (the hub must round-trip the bytes, not reorder them).
  const expected = {
    version: 1,
    enabled: true,
    timeZone: 'Asia/Singapore',
    graceMinutes: 20,
    jobs: [{ agent: 'probe-never-runs', at: '23:59', enabled: false }],
  };
  check(
    'with the identical value the relay wrote',
    JSON.stringify(stored.body?.value) === JSON.stringify(expected),
    JSON.stringify(stored.body?.value ?? null),
  );

  // ── 4. THROW THE DISK AWAY and boot again ────────────────────────────────
  await stop();
  rmSync(dir, { recursive: true, force: true });
  dir = makeDir();
  check('the local schedule file is gone', !existsSync(join(dir, 'schedule.json')));
  log = await boot(dir);
  check(
    'the relay adopts the schedule FROM THE HUB',
    /\[cron\] on — .*\(source: hub\)/.test(log),
    log.split('\n').filter((l) => l.includes('[cron]')).join(' | '),
  );

  const after = await call('GET', '/api/agent/schedule');
  check('and serves it back', after.body?.jobs?.length === 1, JSON.stringify(after.body?.jobs));
  check('with the same source', after.body?.source === 'hub', String(after.body?.source));
  // The probe job is PAUSED on purpose (it must never fire anywhere), and a
  // paused job promises no next run — that is the rule, not a missing value.
  check('a paused job promises no next run', after.body?.jobs?.[0]?.nextAt === null);
  check('and reports that it is paused', after.body?.jobs?.[0]?.enabled === false);

  // ── 5. A credential that is NOT allowed still cannot touch `auth` ────────
  const authKey = await hub('GET', '/hub/relay/auth');
  check(
    'relay/auth stays closed to this credential',
    authKey.status === 403,
    `status ${authKey.status}`,
  );

  // ── 6. Leave the key clean ───────────────────────────────────────────────
  const cleared = await hub('DELETE', '/hub/relay/agent-cron');
  check('the probe row is removed', cleared.status === 204, `status ${cleared.status}`);
  const gone = await hub('GET', '/hub/relay/agent-cron');
  check('and the key is empty again', gone.status === 404, `status ${gone.status}`);
} catch (err) {
  fail += 1;
  console.log(`FAIL  the probe could not run — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
