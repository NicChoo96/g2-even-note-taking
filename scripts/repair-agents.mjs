#!/usr/bin/env node
/**
 * Repair the live agent fleet: attach a fetching tool to every agent that has none.
 *
 * WHY A SCRIPT AND NOT A DIRECT HUB CALL
 *   The hub's refresh family is single-use: a SECOND client that logs in rotates
 *   the token and the loser's next refresh answers `refresh_token_reuse`, which
 *   REVOKES THE WHOLE FAMILY and signs every surface out. So this never logs in.
 *   It talks to the relay, which already holds that one session, and identifies
 *   itself as an owner-APPROVED DEVICE — the mechanism the app uses for the
 *   glasses, and the only way in that does not mint a credential.
 *
 *   `requirePrincipal` accepts a device token on every `/api/hub/...` route, and
 *   the relay injects the hub bearer server-side, so a write here is the same
 *   write the Agents page makes: `PUT /hub/agents/{id}` guarded by `If-Match`.
 *
 * WHAT IT CHANGES
 *   Additive only. An agent with no non-jev tool gets the catalogue's Web tool.
 *   Nothing is detached, no prompt is touched, and an agent that can already
 *   fetch is skipped. `--dry-run` prints the plan and writes nothing.
 *
 * USAGE
 *   node scripts/repair-agents.mjs --pair            # request a code, wait for approval
 *   node scripts/repair-agents.mjs --dry-run         # show the plan
 *   node scripts/repair-agents.mjs --apply           # do it
 *   node scripts/repair-agents.mjs --starters --apply # also create the starter agents
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const RELAY = process.env.REPAIR_RELAY || 'http://127.0.0.1:5198';
const DEVICE_FILE = resolve(root, '.tmp-e2e-repair-device.txt');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);

const die = (msg) => {
  console.error(`\nFAILED: ${msg}`);
  process.exit(1);
};
const log = (...a) => console.log(...a);

const deviceId = () =>
  existsSync(DEVICE_FILE) ? readFileSync(DEVICE_FILE, 'utf8').trim() : '';

/** One relay call as the approved device. Returns {status, body}. */
async function relay(method, path, body) {
  const token = deviceId();
  if (!token) die('no device id — run with --pair first');
  const res = await fetch(`${RELAY}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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
  return { status: res.status, body: parsed, text };
}

// ── pairing ────────────────────────────────────────────────────────────────
async function pair() {
  let id = deviceId();
  if (!id) {
    id = `repair-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    writeFileSync(DEVICE_FILE, id);
  }
  const ask = await fetch(`${RELAY}/api/pair/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: id, label: 'Repair script' }),
  }).then((r) => r.json());

  if (!ask?.ok) die(`the relay refused the pairing request — ${ask?.error ?? 'no reason given'}`);
  if (ask.status === 'approved') {
    log('already approved');
    return;
  }
  log(`\n  Pairing code: ${ask.pairCode}`);
  log('  Approve it in the app: Settings -> Devices -> "Waiting to connect".');
  log('  Waiting up to 5 minutes...\n');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await fetch(
      `${RELAY}/api/pair/status?deviceId=${encodeURIComponent(id)}`,
    ).then((r) => r.json());
    if (s?.status === 'approved') {
      log('  approved\n');
      return;
    }
  }
  die('timed out waiting for approval');
}

// ── the roster ─────────────────────────────────────────────────────────────
async function readRoster() {
  const r = await relay('GET', '/api/hub/agents');
  if (r.status === 401) die('the relay does not recognise this device — approve it first (--pair)');
  if (r.status === 501) {
    die(
      `this relay has no hub configured (${r.body?.error ?? 'not configured'}). ` +
        'Pair against the relay that owns the hub — the deployed one.',
    );
  }
  if (!r.body?.ok) die(`reading the roster failed — ${r.body?.error ?? r.status}`);
  return r.body;
}

/**
 * The same rule as the shipped client (`glasses/src/agent-repair.ts`): an agent
 * with NO tool that can fetch gets one. `jev` ranks text it is given and cannot
 * obtain it, so it never counts — and is never what gets added.
 */
function planRepair(agents, tools) {
  const byId = new Map(tools.map((t) => [t.id, t]));
  const pick = tools.find((t) => t.kind === 'web') ?? tools.find((t) => t.kind !== 'jev');
  if (!pick) return { pick: null, rows: [] };
  const rows = [];
  for (const agent of agents) {
    const ids = agent.toolIds ?? [];
    if (ids.includes(pick.id)) continue;
    const held = ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .filter((t) => t.kind !== 'jev');
    if (held.length) continue;
    rows.push({ agent, add: pick.id });
  }
  return { pick, rows };
}

// ── write one agent, surviving a moved etag ────────────────────────────────
async function putAgent(agent, patch) {
  const read = await relay('GET', `/api/hub/agents/${encodeURIComponent(agent.id)}`);
  let etag = read.body?.ok ? read.body.etag : undefined;
  const body = {
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? '',
    prompt: agent.prompt ?? '',
    toolIds: agent.toolIds ?? [],
    ...patch,
  };
  const send = (tag) =>
    fetch(`${RELAY}/api/hub/agents/${encodeURIComponent(agent.id)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${deviceId()}`,
        'Content-Type': 'application/json',
        ...(tag ? { 'If-Match': tag } : {}),
      },
      body: JSON.stringify(body),
    });

  let res = await send(etag);
  if (res.status === 412) {
    // A moved etag carries the current record and a fresh one under `details`.
    const body412 = await res.json().catch(() => null);
    const fresh = body412?.details?.etag;
    if (fresh) res = await send(fresh);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `${res.status} ${text.slice(0, 120)}` };
  }
  return { ok: true };
}

// ── starters (optional) ────────────────────────────────────────────────────
async function starters() {
  // Bundle the SHIPPED specs so there is one source of truth for their prompts.
  const { build } = await import(resolve(root, 'glasses/node_modules/esbuild/lib/main.js'));
  const out = resolve(root, '.tmp-e2e/starter-specs.mjs');
  await build({
    stdin: {
      contents: `export { STARTER_AGENTS } from './agent-starters.ts';`,
      resolveDir: resolve(root, 'glasses/src'),
      loader: 'ts',
      sourcefile: 'harness-entry.ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
  });
  const { STARTER_AGENTS } = await import(`file:///${out.replace(/\\/g, '/')}`);
  return STARTER_AGENTS;
}

// ── main ───────────────────────────────────────────────────────────────────
if (has('pair')) await pair();

const roster = await readRoster();
const agents = roster.agents ?? [];
const tools = roster.tools ?? [];
log(`Fleet: ${agents.length} agents, ${tools.length} tools (${tools.map((t) => t.kind).join(', ')})`);

const { pick, rows } = planRepair(agents, tools);
if (!pick) die('the catalogue has no tool that can fetch anything — nothing to attach');

log(`\nAgents with no fetching tool: ${rows.length}`);
for (const r of rows) {
  const ids = r.agent.toolIds ?? [];
  log(`  - ${r.agent.name}  [${ids.length ? ids.join(', ') : 'no tools'}]  -> +${pick.name}`);
}

if (has('dry-run') || (!has('apply') && !has('starters'))) {
  log('\nDry run. Nothing was written. Re-run with --apply.');
  process.exit(0);
}

let done = 0;
const failed = [];
for (const row of rows) {
  const next = [...(row.agent.toolIds ?? [])];
  if (!next.includes(row.add)) next.push(row.add);
  const res = await putAgent(row.agent, { toolIds: next });
  if (res.ok) {
    done += 1;
    log(`  ok    ${row.agent.name}`);
  } else {
    failed.push(`${row.agent.name}: ${res.error}`);
    log(`  FAIL  ${row.agent.name} — ${res.error}`);
  }
}
log(`\nRepaired ${done}/${rows.length}.`);

if (has('starters')) {
  const specs = await starters();
  const have = new Set(agents.map((a) => a.name.trim().toLowerCase()));
  const byKind = new Map();
  for (const t of tools) if (!byKind.has(t.kind)) byKind.set(t.kind, t.id);
  log('\nStarter agents:');
  for (const spec of specs) {
    if (have.has(spec.name.trim().toLowerCase())) {
      log(`  skip  ${spec.name} (already there)`);
      continue;
    }
    const toolIds = [];
    const missing = spec.kinds.filter((k) => {
      const id = byKind.get(k);
      if (id) toolIds.push(id);
      return !id;
    });
    if (missing.length) {
      log(`  block ${spec.name} (no ${missing.join(', ')} tool)`);
      continue;
    }
    const res = await relay('POST', '/api/hub/agents', {
      name: spec.name,
      systemPrompt: spec.systemPrompt,
      prompt: spec.prompt,
      toolIds,
      rev: roster.rev,
    });
    if (res.body?.ok) log(`  add   ${spec.name}`);
    else log(`  FAIL  ${spec.name} — ${res.body?.error ?? res.status}`);
  }
}

// ── verify from a fresh read ───────────────────────────────────────────────
const after = await readRoster();
const still = planRepair(after.agents ?? [], after.tools ?? []).rows;
log(`\nVerify: ${(after.agents ?? []).length} agents; ${still.length} still cannot fetch.`);
if (still.length) log(`  ${still.map((r) => r.agent.name).join(', ')}`);
if (failed.length) {
  console.log(`\n${failed.length} write(s) failed:`);
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nDone.');
