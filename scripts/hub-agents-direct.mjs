#!/usr/bin/env node
/**
 * Talk to the JARVIS gateway DIRECTLY and repair the agent fleet there.
 *
 * WHY DIRECT, AND WHY THIS IS CAREFUL
 *   The agents live on the gateway (Digital Ocean), not on the Railway relay —
 *   the relay is a proxy that happens to hold a session. So the honest place to
 *   fix them is the gateway itself: one login, a few writes, exit.
 *
 *   The gateway rotates refresh tokens, so a long-lived second client can rotate
 *   against the relay's session and revoke the family. This script is built to be
 *   the opposite of that: it logs in ONCE, never calls /auth/refresh, does all its
 *   work inside the access token's lifetime, and exits. Nothing survives it.
 *
 * CREDENTIALS
 *   JARVIS_FILE_URL / JARVIS_FILE_USER / JARVIS_FILE_PWD (or JARVIS_FILE_API_KEY),
 *   loaded with `node --env-file` so this file never reads or prints them.
 *
 * USAGE
 *   node --env-file=web/.env.local scripts/hub-agents-direct.mjs            # read only
 *   node --env-file=web/.env.local scripts/hub-agents-direct.mjs --apply    # repair
 *   ... --starters --apply                                                  # + starters
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);

const die = (m) => {
  console.error(`\nFAILED: ${m}`);
  process.exit(1);
};
const log = (...a) => console.log(...a);

const base = String(process.env.JARVIS_FILE_URL || process.env.JARVIS_URL || '').replace(/\/+$/, '');
const apiKey = process.env.JARVIS_FILE_API_KEY || process.env.JARVIS_API_KEY || '';
const user = process.env.JARVIS_FILE_USER || process.env.JARVIS_USERNAME || '';
const pass = process.env.JARVIS_FILE_PWD || process.env.JARVIS_PASSWORD || '';
if (!base) die('JARVIS_FILE_URL is not set (pass --env-file=web/.env.local)');
if (!apiKey && (!user || !pass)) die('no credential: set JARVIS_FILE_API_KEY or JARVIS_FILE_USER/PWD');

/** Every request in this process shares the ONE token this process minted. */
let token = apiKey || '';
const json = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      // No keep-alive socket left to close under the process, which is what
      // makes Node 26 on Windows assert inside libuv when a failed run exits.
      Connection: 'close',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body, text, etag: res.headers.get('etag') ?? undefined };
};

// ── one login, never refreshed ─────────────────────────────────────────────
if (!token) {
  if (has('diag')) {
    const shape = (v) => (v === undefined ? 'unset' : `${v.length}ch first=${JSON.stringify(v.slice(0, 1))} last=${JSON.stringify(v.slice(-1))}`);
    log(`diag base=${base}`);
    log(`diag JARVIS_FILE_URL    ${shape(process.env.JARVIS_FILE_URL)}`);
    log(`diag JARVIS_FILE_USER   ${shape(process.env.JARVIS_FILE_USER)}`);
    log(`diag JARVIS_FILE_PWD    ${shape(process.env.JARVIS_FILE_PWD)}`);
    log(`diag user looks like an email: ${/@/.test(user)}`);
  }
  const r = await json('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password: pass }) });
  if (!r.ok) {
    const shown = typeof r.body === 'object' && r.body
      ? `keys=${Object.keys(r.body).join(',')} ${JSON.stringify(r.body.error ?? r.body.message ?? r.body.detail ?? '').slice(0, 160)}`
      : String(r.text).slice(0, 160);
    die(`login refused — ${r.status} ${shown}`);
  }
  token = String(r.body?.access_token ?? r.body?.token ?? '').trim();
  if (!token) die('login returned no access token');
  log('logged in once (no refresh will be attempted)');
} else {
  log('using an API key (no login at all)');
}

// ── discover the hub prefix, never assume /hub ─────────────────────────────
const cfg = await json('/config').catch(() => null);
const prefix = String(cfg?.body?.hub_prefix ?? '/hub').replace(/\/$/, '');
log(`gateway ${base}${prefix}${cfg?.body?.max_html_bytes ? `  (max_html_bytes ${cfg.body.max_html_bytes})` : ''}`);

// ── read the fleet ─────────────────────────────────────────────────────────
const roster = await json(`${prefix}/agents`);
if (!roster.ok) die(`GET ${prefix}/agents — ${roster.status} ${String(roster.body?.error ?? roster.text).slice(0, 120)}`);
const agents = roster.body?.agents ?? [];
const tools = roster.body?.tools ?? [];
log(`\n${agents.length} agents, ${tools.length} tools [${tools.map((t) => `${t.kind}:${t.name}`).join(', ')}]\n`);

const byId = new Map(tools.map((t) => [t.id, t]));
const KIND = (id) => byId.get(id)?.kind ?? '?';
for (const a of [...agents].sort((x, y) => String(x.name).localeCompare(String(y.name)))) {
  const kinds = (a.toolIds ?? []).map(KIND);
  log(`  ${String(a.name).padEnd(28)} [${kinds.join(', ') || 'none'}]`);
}

// ── the repair rule (same as the shipped client) ────────────────────────────
const pick = tools.find((t) => t.kind === 'web') ?? tools.find((t) => t.kind !== 'jev');
if (!pick) die('no tool can fetch — nothing to attach');
const plan = [];
for (const a of agents) {
  const ids = a.toolIds ?? [];
  if (ids.includes(pick.id)) continue;
  const fetching = ids.map((id) => byId.get(id)).filter(Boolean).filter((t) => t.kind !== 'jev');
  if (fetching.length) continue;
  plan.push(a);
}
log(`\nNo fetching tool: ${plan.length}`);
for (const a of plan) log(`  ${a.name}  -> +${pick.name}`);

if (!has('apply')) {
  log('\nRead only. Re-run with --apply to write.');
  process.exit(0);
}

// ── write, one agent at a time, surviving a moved etag ─────────────────────
let done = 0;
const failed = [];
for (const a of plan) {
  const read = await json(`${prefix}/agents/${encodeURIComponent(a.id)}`);
  let etag = read.etag ?? read.body?.etag;
  const body = JSON.stringify({
    name: a.name,
    systemPrompt: a.systemPrompt ?? '',
    prompt: a.prompt ?? '',
    toolIds: [...(a.toolIds ?? []), pick.id],
  });
  const send = (tag) =>
    json(`${prefix}/agents/${encodeURIComponent(a.id)}`, {
      method: 'PUT',
      body,
      headers: tag ? { 'If-Match': tag } : {},
    });
  let res = await send(etag);
  if (res.status === 412) {
    // A moved etag answers with the current record and a fresh QUOTED etag.
    const fresh = res.body?.details?.etag ?? res.body?.etag;
    if (fresh) res = await send(fresh);
  }
  if (res.ok) {
    done += 1;
    log(`  ok    ${a.name}`);
  } else {
    failed.push(`${a.name}: ${res.status} ${String(res.body?.error ?? res.text).slice(0, 100)}`);
    log(`  FAIL  ${a.name} — ${res.status}`);
  }
}
log(`\nRepaired ${done}/${plan.length}`);

// ── optional: the starter fleet ────────────────────────────────────────────
if (has('starters')) {
  const { build } = await import(
    pathToFileURL(resolve(root, 'glasses/node_modules/esbuild/lib/main.js')).href
  );
  const out = resolve(root, '.tmp-e2e/starter-specs.mjs');
  await build({
    stdin: {
      contents: `export { STARTER_AGENTS } from './agent-starters.ts';`,
      resolveDir: resolve(root, 'glasses/src'),
      loader: 'ts',
      sourcefile: 'entry.ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
  });
  const { STARTER_AGENTS } = await import(pathToFileURL(out).href);
  const have = new Set(agents.map((a) => String(a.name).toLowerCase()));
  const byKind = new Map();
  for (const t of tools) if (!byKind.has(t.kind)) byKind.set(t.kind, t.id);
  log('\nStarters:');
  for (const spec of STARTER_AGENTS) {
    if (have.has(spec.name.toLowerCase())) {
      log(`  skip  ${spec.name}`);
      continue;
    }
    const toolIds = [];
    const missing = spec.kinds.filter((k) => {
      const id = byKind.get(k);
      if (id) toolIds.push(id);
      return !id;
    });
    if (missing.length) {
      log(`  block ${spec.name} — no ${missing.join(', ')} tool`);
      continue;
    }
    // A create is guarded by the `rev` it is writing against, and every create
    // ADVANCES that rev — so it is re-read per agent rather than taken once for
    // the whole loop, which would make the second create fail with the first's rev.
    const cur = await json(`${prefix}/agents`);
    const rev = Number(cur.body?.rev);
    const res = await json(`${prefix}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        name: spec.name,
        systemPrompt: spec.systemPrompt,
        prompt: spec.prompt,
        toolIds,
        ...(Number.isFinite(rev) ? { rev } : {}),
      }),
    });
    log(
      res.ok
        ? `  add   ${spec.name}`
        : `  FAIL  ${spec.name} — ${res.status} ${String(res.body?.error ?? '').slice(0, 80)}`,
    );
  }
}

// ── verify from a fresh read ───────────────────────────────────────────────
const after = await json(`${prefix}/agents`);
const still = (after.body?.agents ?? []).filter((a) => {
  const ids = a.toolIds ?? [];
  if (ids.includes(pick.id)) return false;
  return !ids.map((id) => byId.get(id)).filter(Boolean).some((t) => t.kind !== 'jev');
});
log(`\nVerify: ${(after.body?.agents ?? []).length} agents; ${still.length} still cannot fetch.`);
if (still.length) log(`  ${still.map((a) => a.name).join(', ')}`);
process.exit(failed.length ? 1 : 0);
