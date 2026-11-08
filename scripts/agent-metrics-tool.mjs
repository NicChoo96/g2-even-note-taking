// Give the agents that PRODUCE numbers the ability to store them, and the
// agents that SUMMARISE them the ability to read them back.
//
// WHY A SCRIPT AND NOT A HANDBOOK PAGE
//   An agent's toolset is the list of ids saved on its roster row. Attaching a
//   tool therefore means: make sure the catalogue HAS the tool, then edit each
//   agent's `toolIds` under optimistic concurrency. Doing that by hand on a
//   phone is how the fleet silently forks.
//
// THE RULE BEHIND WHO GETS IT
//   `jarvis_metrics` is not a general-purpose store. A series has a fixed unit
//   and a fixed type, and it is declared by the wearer on the Data page — so an
//   agent may only ever touch a series that a HUMAN already decided to track.
//   That makes the split:
//
//     WRITE  an agent whose answer contains a number worth keeping over time
//            (a price, a temperature, a benchmark score, a weekly count)
//     READ   an agent whose answer is a SUMMARY of history — it cannot compose
//            "how has this moved" from one glance at today
//     NO     an agent that answers a question and forgets it (a lookup, a
//            watch list, a draft). An unused tool is dead weight, and worse, it
//            invites the model to write a series nobody declared.
//
//   Attaching the tool is half the job. A tool with no instruction is one the
//   model has no reason to reach for, so each agent also gets a guidance block
//   that states the rule it must not break: never invent a series key, and if
//   the dashboard is empty, say so rather than writing to a guess.
//
// USAGE
//   node --env-file=web/.env.local scripts/agent-metrics-tool.mjs           # plan
//   node --env-file=web/.env.local scripts/agent-metrics-tool.mjs --apply
//
// ASCII only, one login, never refreshed.

const base = String(process.env.JARVIS_FILE_URL || process.env.JARVIS_URL || '').replace(/\/+$/, '');
const user = process.env.JARVIS_FILE_USER || process.env.JARVIS_USERNAME || '';
const pass = process.env.JARVIS_FILE_PWD || process.env.JARVIS_PASSWORD || '';
const apiKey = process.env.JARVIS_FILE_API_KEY || process.env.JARVIS_API_KEY || '';
if (!base) {
  console.error('FAILED: JARVIS_FILE_URL is not set (pass --env-file=web/.env.local)');
  process.exit(2);
}
const apply = process.argv.includes('--apply');

const TOOL_NAME = 'jarvis_metrics';

/**
 * name -> what this agent does with the dashboard.
 *
 * `series` is only a HINT for the plan output: the agent must still call `list`
 * and use whatever exists, because the wearer may have named their series
 * differently or not declared it yet.
 */
const TARGETS = [
  { name: 'SG Banks Desk', intent: 'write', hint: 'bank share prices' },
  { name: 'AI Equities Desk', intent: 'write', hint: 'equity prices' },
  { name: 'Singapore Weather', intent: 'write', hint: 'temperature and humidity' },
  { name: 'AI Model Tracker', intent: 'write', hint: 'benchmark scores' },
  { name: 'Fleet Auditor', intent: 'write', hint: 'how many agents failed a run' },
  { name: 'Watchkeeper', intent: 'read', hint: 'how the situation has moved' },
  { name: 'Brief Composer', intent: 'read', hint: 'the latest reading of anything tracked' },
  { name: 'Daily Run Orchestrator', intent: 'read', hint: 'what has already been recorded today' },
];

const guidance = (intent, hint) => {
  const head = `
DASHBOARD NUMBERS (the metrics tool)
The wearer keeps NUMBER SERIES on a dashboard. You have the metrics tool.`;
  const write = `
- Call it with action "list" FIRST to see which series exist, and use the keys it returns exactly as written. Never invent a series key: a series can only be created by the wearer on the Data page, and an unknown key is refused.
- If you have a number worth keeping (${hint}), record it with action "write". Use the same slot twice and the earlier value is REPLACED, so re-running is safe.
- If "list" returns nothing, do not guess a key. Say in your answer that nothing is declared yet and that the Data page has to declare the series first.`;
  const read = `
- Call it with action "list" FIRST, then "read" the series you need. Use the keys exactly as returned; never invent one.
- Your answer is a summary of history: compare the readings you read back, and say what changed and when. Do not present a single reading as a trend.
- If a series has no readings or nothing is declared, say so plainly instead of estimating.`;
  if (intent === 'write') return `${head}${write}`;
  if (intent === 'read') return `${head}${read}`;
  return `${head}${write}${read}`;
};

let token = apiKey || '';
const json = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
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

if (!token) {
  const r = await json('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!r.ok) {
    console.error(`FAILED: login refused - ${r.status}`);
    process.exit(2);
  }
  token = String(r.body?.access_token ?? r.body?.token ?? '').trim();
}
const cfg = await json('/config');
const prefix = String(cfg.body?.hub_prefix ?? '/hub').replace(/\/$/, '');

let roster = await json(`${prefix}/agents`);
if (!roster.ok) {
  console.error(`FAILED: GET ${prefix}/agents - ${roster.status}`);
  process.exit(2);
}

// ── the catalogue row ───────────────────────────────────────────────────────
// The tool must exist before any agent can reference it by id, because the run
// resolves `toolIds` against the hub's catalogue and nothing else.
let metricsTool = (roster.body?.tools ?? []).find((t) => t.name === TOOL_NAME || t.kind === 'metrics');
if (!metricsTool) {
  const created = await json(`${prefix}/tools`, {
    method: 'POST',
    body: JSON.stringify({
      name: TOOL_NAME,
      kind: 'metrics',
      description: 'Read and record the number series on the wearer\u2019s dashboard.',
      rev: roster.body?.rev,
    }),
  });
  if (created.ok) {
    metricsTool = created.body?.tool ?? created.body;
    console.log(`Created the catalogue tool ${TOOL_NAME} (${metricsTool?.id ?? 'id unknown'}).\n`);
    roster = await json(`${prefix}/agents`);
  } else if (created.body?.code === 'INVALID_ENUM') {
    // Honest stop. Half-applying this would attach an id the catalogue does not
    // have, and the agent would run with a tool it cannot call.
    const allowed = created.body?.details?.allowed ?? [];
    console.error('BLOCKED BY THE BACKEND, not by this script.');
    console.error(`  POST ${prefix}/tools rejected kind "metrics": ${created.body?.error ?? created.status}`);
    console.error(`  allowed kinds: ${allowed.join(', ')}`);
    console.error('');
    console.error('ASK THE BACKEND FOR ONE CHANGE:');
    console.error(`  add "metrics" to the allowed \`kind\` enum on POST/PUT ${prefix}/tools`);
    console.error('  (the relay already executes that kind: web/server/metrics-tool.mjs)');
    console.error('');
    console.error('Nothing was written. Re-run this script once the enum accepts it.');
    process.exit(2);
  } else {
    console.error(`FAILED: could not create the tool - ${created.status} ${String(created.body?.error ?? '')}`);
    process.exit(2);
  }
}
const toolId = metricsTool.id;
if (!toolId) {
  console.error('FAILED: the catalogue tool has no id');
  process.exit(2);
}

// ── the plan ────────────────────────────────────────────────────────────────
const agents = roster.body?.agents ?? [];
const tools = roster.body?.tools ?? [];
const byName = new Map(agents.map((a) => [String(a.name), a]));
const plan = [];
for (const target of TARGETS) {
  const agent = byName.get(target.name);
  if (!agent) {
    plan.push({ target, missing: true });
    continue;
  }
  const toolIds = agent.toolIds ?? [];
  const addTool = !toolIds.includes(toolId);
  const body = String(agent.systemPrompt ?? '');
  const hasBlock = /DASHBOARD NUMBERS \(the metrics tool\)/.test(body);
  plan.push({
    target,
    agent,
    addTool,
    hasBlock,
    next: hasBlock ? body : `${body}\n${guidance(target.intent, target.hint)}`,
  });
}

console.log(`Fleet: ${agents.length} agents, catalogue tools: ${tools.length}, metrics tool = ${toolId}\n`);
for (const row of plan) {
  if (row.missing) {
    console.log(`  MISSING  ${row.target.name}`);
    continue;
  }
  const bits = [
    row.addTool ? '+' + 'metrics' : 'metrics already attached',
    row.hasBlock ? 'guidance present' : 'adds guidance',
  ];
  console.log(`  ${row.target.name.padEnd(24)} ${String(row.target.intent).padEnd(5)} ${bits.join(', ')}`);
}
const todo = plan.filter((r) => r.agent && (r.addTool || !r.hasBlock));
console.log(`\nPlan: ${todo.length} agent(s) change.`);
if (!apply) {
  console.log('Plan only. Re-run with --apply to write.');
  process.exit(0);
}

let done = 0;
const failed = [];
for (const row of todo) {
  const { agent } = row;
  const toolIds = [...(agent.toolIds ?? [])];
  if (!toolIds.includes(toolId)) toolIds.push(toolId);
  // Re-read for a fresh etag: the roster read above may be minutes stale by the
  // time this row is written, and a stale tag is a 412 rather than a lost edit.
  const read = await json(`${prefix}/agents/${encodeURIComponent(agent.id)}`);
  const send = (tag) =>
    json(`${prefix}/agents/${encodeURIComponent(agent.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: agent.name,
        systemPrompt: row.next,
        prompt: agent.prompt ?? '',
        toolIds,
      }),
      headers: tag ? { 'If-Match': tag } : {},
    });
  let res = await send(read.etag ?? read.body?.etag);
  if (res.status === 412) {
    const fresh = res.body?.details?.etag ?? res.body?.etag;
    if (fresh) res = await send(fresh);
  }
  if (res.ok) {
    done += 1;
    console.log(`  ok    ${agent.name}`);
  } else {
    failed.push(`${agent.name}: ${res.status} ${String(res.body?.error ?? '').slice(0, 90)}`);
    console.log(`  FAIL  ${agent.name} - ${res.status}`);
  }
}
console.log(`\nWrote ${done} agent(s).`);

// ── verify by reading back, never by trusting the write ─────────────────────
const after = await json(`${prefix}/agents`);
if (after.ok) {
  const aTools = after.body?.tools ?? [];
  const present = aTools.some((t) => t.id === toolId);
  console.log(`  catalogue: ${present ? 'metrics tool present' : 'METRICS TOOL MISSING'}`);
  if (!present) failed.push('the catalogue lost the metrics tool');
  for (const target of TARGETS) {
    const agent = (after.body?.agents ?? []).find((a) => a.name === target.name);
    if (!agent) continue;
    const has = (agent.toolIds ?? []).includes(toolId);
    console.log(`  ${has ? 'attached ' : 'NOT      '} ${target.name}`);
    if (!has) failed.push(`${target.name} did not keep the tool`);
  }
}

if (failed.length) {
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nDone.');
