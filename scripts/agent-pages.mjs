// Give the agents whose output is a DOCUMENT the ability to publish one.
//
// WHICH AGENTS, AND THE RULE BEHIND IT
//   The `files` tool publishes a complete HTML page to the wearer's Files library,
//   which he opens later on a phone or a desktop. That is the right home for output
//   that is LONG, DATED and worth REOPENING — and the wrong home for a glance.
//
//   So the split is not "which agents are clever" but "which answers outlive the
//   moment they were read":
//
//     YES  monthly trackers and research (a comparison you review next month)
//          watch lists (the whole point is opening them later)
//          lyrics (too long for ten lines, and you want them while singing)
//          a price series, a weekly audit, a daily news archive
//     NO   weather and trending (read once, then stale)
//          the commitment list and the decision journal (those are EDITABLE docs,
//          not pages — `docs` is correct and already attached)
//          orchestrator orders and the glasses brief (a glance by design)
//
//   Attaching the tool is half the job; an unused tool is dead weight and the model
//   has no reason to reach for it. So each of these also gets a PUBLISH block that
//   says what the page is FOR and that the glasses answer stays short — the page
//   carries the depth so the ten lines do not have to.
//
// USAGE
//   node --env-file=web/.env.local scripts/agent-pages.mjs            # plan only
//   node --env-file=web/.env.local scripts/agent-pages.mjs --apply
//
// ASCII only, no import side effects, one login, never refreshed.

const base = String(process.env.JARVIS_FILE_URL || process.env.JARVIS_URL || '').replace(/\/+$/, '');
const user = process.env.JARVIS_FILE_USER || process.env.JARVIS_USERNAME || '';
const pass = process.env.JARVIS_FILE_PWD || process.env.JARVIS_PASSWORD || '';
const apiKey = process.env.JARVIS_FILE_API_KEY || process.env.JARVIS_API_KEY || '';
if (!base) {
  console.error('FAILED: JARVIS_FILE_URL is not set (pass --env-file=web/.env.local)');
  process.exit(2);
}
const apply = process.argv.includes('--apply');

/**
 * name -> the page it is allowed to write.
 *
 * `title` is a TEMPLATE the agent fills in: {date}, {month}, {topic}. Naming the
 * shape here means ten runs make ten findable pages instead of ten pages called
 * "report".
 */
const PAGES = [
  { name: 'AI Model Tracker', title: 'AI Models - {month}', why: 'a monthly comparison you re-read across months' },
  { name: 'Extra Dimensions Research', title: 'Research - {topic} - {date}', why: 'monthly deep research, far longer than ten lines' },
  { name: 'Human Longevity Research', title: 'Research - {topic} - {date}', why: 'monthly deep research, far longer than ten lines' },
  { name: 'YouTube Watch Later', title: 'Watch list - {date}', why: 'its own purpose is a page you open later' },
  { name: 'SG Banks Desk', title: 'SG Banks - {date}', why: 'a price series is a table, not a sentence' },
  { name: 'Fleet Auditor', title: 'Fleet audit - {date}', why: 'a weekly report worth comparing to last week' },
  { name: 'News Desk', title: 'News - {date}', why: 'a dated archive you can go back to' },
];

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
    console.error(`FAILED: login refused — ${r.status}`);
    process.exit(2);
  }
  token = String(r.body?.access_token ?? r.body?.token ?? '').trim();
}
const cfg = await json('/config');
const prefix = String(cfg.body?.hub_prefix ?? '/hub').replace(/\/$/, '');

const roster = await json(`${prefix}/agents`);
if (!roster.ok) {
  console.error(`FAILED: GET ${prefix}/agents — ${roster.status}`);
  process.exit(2);
}
const agents = roster.body?.agents ?? [];
const tools = roster.body?.tools ?? [];
const filesTool = tools.find((t) => t.kind === 'files');
if (!filesTool) {
  console.error('FAILED: the catalogue has no "files" tool — nothing to attach');
  process.exit(2);
}
const byName = new Map(agents.map((a) => [String(a.name), a]));

const publishBlock = (title) => `
PUBLISH IT AS A PAGE
The glasses answer stays short. The FULL report goes to a page, because that is where it can be read properly and found again.
- Use the files tool with action "publish", a title of the form "${title}" (fill in the real date, month, or subject), and html set to ONE complete self-contained document: inline CSS, no external scripts, no external images. It may be as long as the subject needs.
- Put the detail there: the numbers, the comparison, the dates, the caveats.
- Then end your glasses answer with one line: "Saved to Files." If publishing failed, say "Page NOT saved" and the reason instead. Never claim a page you did not see confirmed.`;

const plan = [];
for (const spec of PAGES) {
  const agent = byName.get(spec.name);
  if (!agent) {
    plan.push({ spec, missing: true });
    continue;
  }
  const toolIds = agent.toolIds ?? [];
  const addTool = !toolIds.includes(filesTool.id);
  const body = String(agent.systemPrompt ?? '');
  const hasBlock = /action "publish"/i.test(body);
  plan.push({ spec, agent, addTool, hasBlock, next: hasBlock ? body : `${body}\n${publishBlock(spec.title)}` });
}

console.log(`Fleet: ${agents.length} agents, files tool = ${filesTool.id}\n`);
for (const row of plan) {
  if (row.missing) {
    console.log(`  MISSING  ${row.spec.name}`);
    continue;
  }
  const bits = [row.addTool ? '+files' : 'files already attached', row.hasBlock ? 'publish block present' : 'adds publish block'];
  console.log(`  ${row.spec.name.padEnd(26)} ${bits.join(', ')}`);
  console.log(`      ${row.spec.why}`);
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
  const { agent, spec } = row;
  const toolIds = [...(agent.toolIds ?? [])];
  if (!toolIds.includes(filesTool.id)) toolIds.push(filesTool.id);
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
    console.log(`  ok    ${spec.name}`);
  } else {
    failed.push(`${spec.name}: ${res.status} ${String(res.body?.error ?? '').slice(0, 90)}`);
    console.log(`  FAIL  ${spec.name} — ${res.status}`);
  }
}
console.log(`\nWrote ${done} agent(s).`);
if (failed.length) {
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
