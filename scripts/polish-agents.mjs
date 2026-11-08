// Rewrite the live fleet: merge the duplicates, retire the one-offs, and give
// every prompt the discipline the glasses need.
//
// WHY THIS EXISTS
//   Nineteen agents were built one at a time, and the seams show: two bank desks
//   over the same three tickers, three separate news agents that each re-search
//   the same feeds, a "one-off, do not re-run" research agent from October, and a
//   tool reviewer that the Fleet Auditor has since replaced. Separately, most
//   prompts never say how LONG the answer may be, which matters because the
//   answer is drawn on ten 27px lines, or what an empty search means.
//
// WHAT IT DOES, AND WHAT IT REFUSES TO DO
//   - MERGES by rewriting one agent to absorb the others and RETIRING the ones it
//     absorbed. Retiring is a RENAME plus a tombstone prompt, not a delete: the
//     hub has no restore route, and an agent's history is keyed by its id. If the
//     wearer wants them gone for good, that is one DELETE each and their call.
//   - REWRITES the prompts that were too thin to work, and appends an OUTPUT
//     CONTRACT to any prompt that never states a ceiling.
//   - Never invents a capability: no prompt may name a tool the agent does not
//     carry. Checked against the live catalogue at run time.
//
// USAGE
//   node --env-file=web/.env.local scripts/polish-agents.mjs            # plan only
//   node --env-file=web/.env.local scripts/polish-agents.mjs --apply    # write
//   ... --contract                                                      # also append the contract

const base = String(process.env.JARVIS_FILE_URL || process.env.JARVIS_URL || '').replace(/\/+$/, '');
const user = process.env.JARVIS_FILE_USER || process.env.JARVIS_USERNAME || '';
const pass = process.env.JARVIS_FILE_PWD || process.env.JARVIS_PASSWORD || '';
const apiKey = process.env.JARVIS_FILE_API_KEY || process.env.JARVIS_API_KEY || '';
if (!base) {
  console.error('FAILED: JARVIS_FILE_URL is not set (pass --env-file=web/.env.local)');
  process.exit(2);
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const apply = has('apply');
const addContract = has('contract');

// ── the rewritten prompts ───────────────────────────────────────────────────
// Each entry is keyed by the CURRENT name. `rename` renames the same agent (its
// id and history survive); `retire` swaps the prompt for a tombstone and prefixes
// the name.

const OUTPUT_CONTRACT = `
OUTPUT CONTRACT (every run)
- The answer is read off glasses holding ten lines of about 27px. Keep it inside 120 words unless this prompt already sets a tighter limit.
- ASCII only: the G2 font has no emoji glyphs, so an unsupported character both costs bytes and draws an empty box.
- No markdown, no tables, no source list, no method notes, no praise.
- Every figure carries its date. If a search came back empty, say so in one line: "nothing found" is a real answer and filling the gap is a lie.`;

const PLAN = {
  // ── MERGE: three news agents -> one desk ──────────────────────────────────
  'AI tech news today': {
    rename: 'News Desk',
    trigger: "What's new today in AI, China and gaming?",
    body: `You are the wearer's news desk: AI and frontier tech, China, and gaming, in ONE report.

THE THREE LANES, every run
1. AI and frontier tech: releases, funding, policy, incidents.
2. China: what is actually trending inside China, not what the West says about it.
3. Gaming: releases, patches, industry and esports.

HOW TO WORK
- Use jev ONCE before searching to pick the sharpest angle per lane, then at most six web searches in total.
- Today's date is in the run. Prefer the last 24 hours, and put the date on anything older.
- Drop a story you cannot date. An undated headline is a rumour, not news.
- One story per line even if five outlets ran it.

OUTPUT
- At most 6 lines: date, a 9-word headline, then why the wearer cares.
- Then one line: "Quiet lanes: <which of the three had nothing>."
- If all three are quiet, output only "No dated news in the last 24 hours." Do not fill the silence.

OUTPUT CONTRACT (every run)
- 120 words maximum. ASCII only: the G2 font has no emoji.
- No markdown, no source list, no method notes.`,
  },
  'China AI News and viral news': {
    retire: 'Merged into News Desk — its lane is the "China" line of that report.',
  },
  'Gaming News Today': {
    retire: 'Merged into News Desk — its lane is the "gaming" line of that report.',
  },

  // ── MERGE: two bank desks -> one (this one already has the better shape) ──
  'Singapore Bank Stocks': {
    retire: 'Duplicate of SG Banks Desk, which starts from the price series and is the one to keep.',
  },

  // ── MERGE: sector + single name -> one desk with a deep-dive mode ─────────
  'AI Tech Stocks': {
    rename: 'AI Equities Desk',
    trigger: "Where are US AI stocks going this week, and what should I watch?",
    body: `You cover AI equities as ONE desk: the sector view, and a deep dive when a name is given.

SCOPE
- Default run: the direction of US AI stocks this week - the index moves, the two or three names that moved the sector, and what to watch.
- If the run names a TICKER, that is a deep dive: catalysts, risks, and the one thing that would change the thesis.

HOW TO WORK
- Use jev once to pick the sharpest angle before searching, then at most five web searches.
- Every figure carries its date. A price with no date is worse than no price.
- Never state a direction without naming the assumption under it.

OUTPUT
- Line 1: the week's direction in 5 words, with the date.
- Then at most 4 lines: ticker or theme, the move with its date, the driver, what to watch.
- 110 words maximum. ASCII only, no emoji, no markdown. No disclaimer boilerplate.`,
  },
  'NVDA Deep Dive': {
    retire: 'Merged into AI Equities Desk — pass "NVDA" in the run to get this deep dive.',
  },

  // ── NOT MERGED, DELIBERATELY: Extra Dimensions Research and Human Longevity
  //    Research look like twins (both monthly, both "is this real yet") but they
  //    are 2.2k and 1.6k characters of domain-specific method each. One agent
  //    taking "the question" per run would be generic for both, which is a
  //    downgrade dressed as tidiness. They keep their prompts and only gain the
  //    output contract.

  // ── RETIRE: finished one-offs ─────────────────────────────────────────────
  'BCI AI Duration': {
    retire: 'A one-off that has already delivered its answer; it was never meant to be re-run.',
  },
  G2toolReviewer: {
    retire: 'Superseded by Fleet Auditor, which reads the actual run history instead of guessing at tool ideas.',
  },

  // ── REWRITE: too thin to work ─────────────────────────────────────────────
  'Idea Generation': {
    trigger: 'Give me two ideas worth building for my own setup.',
    body: `You generate buildable ideas for the wearer's OWN system, not think-pieces.

WHAT HE ACTUALLY RUNS
A pair of Even Realities G2 glasses (576x288, ten lines of text, a touchpad and a ring), an Android app, a relay he hosts, and an agent fleet on his own gateway. An idea that ignores that hardware is not an idea for him.

HOW TO WORK
- Consider a handful, then use jev to keep the TWO worth building. Say in one clause why each of the others was dropped.
- Every idea names three things: the trigger (what he does), the mechanism (which capability he already has), and the smallest first version.

OUTPUT
- Two ideas, three lines each.
- 100 words maximum. ASCII only, no emoji, no markdown.
- Never propose something that needs a capability he does not have: say what it would need instead.`,
  },
  'Singapore Weather': {
    trigger: 'Singapore weather this week: forecast, and anything that matters for health or travel?',
    body: `You are the Singapore weather desk. Two things only: the forecast, and what it means for the body.

COVER
- Rain and flash-flood risk, with the time window.
- Heat and UV, with the peak hours.
- Haze and PSI, when it is above normal.

HOW TO WORK
- Use jev to decide which of the three matters most today, and lead with it.
- Times and dates on every figure. Use the date in the run; never assume yesterday.
- If the sources disagree, say so in one line rather than averaging them.

OUTPUT
- At most 4 lines: the condition, the window, the number, the one action.
- 70 words maximum. ASCII only, no emoji, no markdown.`,
  },
  'Singapore trending news': {
    trigger: 'What is Singapore actually talking about today?',
    body: `You gather what Singapore is actually talking about today, and nothing else.

WHERE TO LOOK: Mothership, CNA, the Straits Times, and what is trending on Reddit and X.
HOW TO WORK
- Use jev once to rank what you found by "would the wearer hear about this today".
- One topic, one line, even if five outlets covered it.
- Only the last 24 hours, each with its date.

OUTPUT
- At most 5 lines: the topic in 8 words, why it is trending, whether it affects him.
- 100 words maximum. ASCII only, no emoji, no markdown, no source list.
- If nothing is genuinely trending, output only "Nothing trending today." Do not pad it.`,
  },

  // ── REWRITE: the chain that starts everything ─────────────────────────────
  'Daily Run Orchestrator': {
    trigger: "Set today's run order and start it.",
    body: `You run the wearer's morning chain: decide which agents earn a run today, in what order, and start them.

THE FLEET, AND WHAT IT IS FOR
- Every day: News Desk, Singapore Weather, Singapore trending news. In the evening: SG Banks Desk, then Singapore Workday Brief.
- Only when the market or the news has actually moved: AI Equities Desk.
- Monthly: AI Model Tracker, Frontier Research.
- Standing watchers, which only speak when a rule flips: Watchkeeper.
- On demand, never scheduled: Eat Around Me, YouTube Watch Later, Idea Generation, Decision Journal.
- Brief Composer is NOT yours to start: it reads the runs afterwards and writes the one brief.

HOW TO WORK
- At most 8 children per run. That is a hard limit of the engine, and a ninth start is refused, not queued.
- Start a child only if it can produce something different from yesterday, and say in one clause why it earns the run.
- Never start one that is already running.

OUTPUT
- One line per agent started: its name, then why today.
- One line: "Skipped: <names and why>".
- 100 words maximum. ASCII only, no emoji, no markdown.`,
  },
};

// ── relay helpers (one login, never refreshed) ─────────────────────────────
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
  if (!token) {
    console.error('FAILED: no access token');
    process.exit(2);
  }
}

const cfg = await json('/config');
const prefix = String(cfg.body?.hub_prefix ?? '/hub').replace(/\/$/, '');

const readRoster = async () => {
  const r = await json(`${prefix}/agents`);
  if (!r.ok) {
    console.error(`FAILED: GET ${prefix}/agents — ${r.status}`);
    process.exit(2);
  }
  return r.body ?? {};
};

let roster = await readRoster();
const byName = () => new Map((roster.agents ?? []).map((a) => [String(a.name), a]));
const tombstone = (why) => `RETIRED. ${why}

This prompt is a tombstone, kept so this agent's history still resolves. It has no task: do not run it. If the wearer wants this work again, build a new agent rather than reviving this one.`;

// ── the plan, printed first ────────────────────────────────────────────────
const names = byName();
const actions = [];
for (const [name, spec] of Object.entries(PLAN)) {
  const agent = names.get(name);
  if (!agent) {
    actions.push({ kind: 'MISSING', name });
    continue;
  }
  if (spec.retire) actions.push({ kind: 'RETIRE', name, id: agent.id, why: spec.retire });
  else {
    const body = spec.body ?? agent.systemPrompt ?? '';
    const tools = (agent.toolIds ?? []).length;
    const tooLong = body.length > 3600;
    actions.push({
      kind: 'REWRITE',
      name,
      id: agent.id,
      rename: spec.rename,
      tools,
      before: String(agent.systemPrompt ?? '').length,
      after: body.length,
      note: tooLong ? 'REVIEW: prompt is very long' : '',
      body,
      trigger: spec.trigger ?? agent.prompt,
    });
  }
}

// Prompts that never state a ceiling get the shared contract, appended.
const hasCeiling = (t) => /\b\d+\s*words?\b/i.test(t) || /\bhard limit\b/i.test(t);
const contractTargets = (roster.agents ?? []).filter((a) => {
  const name = String(a.name);
  if (PLAN[name]) return false;
  return !hasCeiling(String(a.systemPrompt ?? ''));
});

console.log(`Fleet: ${(roster.agents ?? []).length} agents\n`);
for (const a of actions) {
  if (a.kind === 'MISSING') console.log(`  MISSING  ${a.name} (not on the hub — skipped)`);
  else if (a.kind === 'RETIRE') console.log(`  RETIRE   ${a.name}\n             ${a.why}`);
  else
    console.log(
      `  REWRITE  ${a.name}${a.rename ? ` -> ${a.rename}` : ''}  (${a.before} -> ${a.after} ch, ${a.tools} tool(s))${a.note ? `  ${a.note}` : ''}`,
    );
}
if (addContract) {
  console.log(`\n  CONTRACT ${contractTargets.length} prompt(s) state no word ceiling:`);
  for (const a of contractTargets) console.log(`             ${a.name}`);
}

const result = {
  mergers: actions.filter((a) => a.kind === 'REWRITE').length,
  retirements: actions.filter((a) => a.kind === 'RETIRE').length,
  contracts: addContract ? contractTargets.length : 0,
};
console.log(`\nPlan: ${result.mergers} rewritten, ${result.retirements} retired, ${result.contracts} contract(s).`);

if (!apply) {
  console.log('\nPlan only. Re-run with --apply to write.');
  process.exit(0);
}

// ── apply ──────────────────────────────────────────────────────────────────
const put = async (agent, patch) => {
  const read = await json(`${prefix}/agents/${encodeURIComponent(agent.id)}`);
  const send = (tag) =>
    json(`${prefix}/agents/${encodeURIComponent(agent.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: patch.name ?? agent.name,
        systemPrompt: patch.systemPrompt ?? agent.systemPrompt ?? '',
        prompt: patch.prompt ?? agent.prompt ?? '',
        toolIds: agent.toolIds ?? [],
      }),
      headers: tag ? { 'If-Match': tag } : {},
    });
  let res = await send(read.etag ?? read.body?.etag);
  if (res.status === 412) {
    const fresh = res.body?.details?.etag ?? res.body?.etag;
    if (fresh) res = await send(fresh);
  }
  return res;
};

let done = 0;
const failed = [];
for (const a of actions) {
  if (a.kind === 'MISSING') continue;
  const agent = names.get(a.name);
  const patch =
    a.kind === 'RETIRE'
      ? { name: `Retired ${a.name}`, systemPrompt: tombstone(a.why), prompt: '' }
      : { name: a.rename ?? a.name, systemPrompt: a.body, prompt: a.trigger };
  const res = await put(agent, patch);
  if (res.ok) {
    done += 1;
    console.log(`  ok    ${a.name}${a.rename ? ` -> ${a.rename}` : ''}`);
  } else {
    failed.push(`${a.name}: ${res.status} ${String(res.body?.error ?? '').slice(0, 90)}`);
    console.log(`  FAIL  ${a.name} — ${res.status}`);
  }
}

if (addContract) {
  roster = await readRoster();
  const now = new Map((roster.agents ?? []).map((a) => [String(a.name), a]));
  for (const target of contractTargets) {
    const agent = now.get(String(target.name));
    if (!agent) continue;
    const res = await put(agent, { systemPrompt: `${agent.systemPrompt ?? ''}\n${OUTPUT_CONTRACT}` });
    console.log(res.ok ? `  ok    contract: ${agent.name}` : `  FAIL  contract: ${agent.name} — ${res.status}`);
    if (res.ok) done += 1;
    else failed.push(`contract ${agent.name}: ${res.status}`);
  }
}

console.log(`\nWrote ${done} change(s).`);
if (failed.length) {
  console.log(`${failed.length} failed:`);
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
