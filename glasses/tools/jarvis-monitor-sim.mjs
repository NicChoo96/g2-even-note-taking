#!/usr/bin/env node
/**
 * WHY THIS EXISTS
 * ---------------
 * Jarvis can now *watch* the agent runs it starts. Three things have to line up
 * for that to be true, and each of them fails silently:
 *
 *   1. `ai/monitor.ts` — the queue. A run is enqueued when the model triggers
 *      it and is updated from the relay's run frames. The tricky part is the
 *      notification edge: "unread" must rise EXACTLY once, on the
 *      running -> terminal transition, and it must not come back when the relay
 *      replays the same terminal frame on every reconnect (it does).
 *
 *   2. `agents.sessions` — the tool Jarvis reads runs with. Sessions live in two
 *      places that are each incomplete on their own (the relay's run store is the
 *      only place an IN-PROGRESS run exists; `AgentsState.sessions` is durable but
 *      terminal-only). The merge has to be newest-first, because the whole point
 *      is "read the latest one" — and it has to survive being clipped to 1500
 *      chars by the agent loop, which is why the transcript comes back
 *      pre-rendered as a string rather than as JSON.
 *
 *   3. The HUD. `aiView` now PAGES. It renders the FULL transcript (no per-line
 *      clipping), word-wraps it, and hands the ring index back to the caller
 *      through `todoCursor` / `canPrev` / `canNext` / `sessionStart`. Those
 *      units are transcript pages FIRST and then one unit per watched session
 *      row, so one index walks both. Every page must stay under the 999-byte
 *      container cap and draw only supported glyphs — an overflowing container
 *      makes the FIRMWARE scroll it, and that scroll eats the ring's swipe.
 *
 * So this harness drives the real modules with plain objects and asserts the
 * behaviours above. It is the only place the queue's edge-triggering and the
 * session merge are pinned down.
 *
 * Run: node tools/jarvis-monitor-sim.mjs        (SIM_QUIET=1 for the tally only)
 */
import { build } from 'esbuild';
import { measureTextWrap } from '@evenrealities/pretext';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const QUIET = !!process.env.SIM_QUIET;
let fail = 0;
let pass = 0;

function ok(label) {
  pass += 1;
  if (!QUIET) console.log(`  ok   ${label}`);
}
function bad(label, detail) {
  fail += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}
function check(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok(label);
  else bad(label, `got ${g}, want ${w}`);
}
function is(label, got, want) {
  if (got === want) ok(label);
  else bad(label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function assert(label, cond, detail = '') {
  if (cond) ok(label);
  else bad(label, detail);
}
function has(label, haystack, needle) {
  if (String(haystack).includes(needle)) ok(label);
  else bad(label, `${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 240))}`);
}
function lacks(label, haystack, needle) {
  if (!String(haystack).includes(needle)) ok(label);
  else bad(label, `${JSON.stringify(needle)} unexpectedly in ${JSON.stringify(String(haystack).slice(0, 240))}`);
}

// ── Fake host ───────────────────────────────────────────────────────────────
// Set up BEFORE any module loads: the stores read localStorage at import time
// and the streams reach for fetch on their own.
globalThis.window = globalThis;
// Node 26 defines `navigator` as a getter-only global, so redefine rather than assign.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node' },
  configurable: true,
  writable: true,
});
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};

/** What the relay would answer. Mutated by the tests. */
const relay = { runs: [], startId: 'run-triggered' };
globalThis.fetch = async (url) => {
  const u = String(url);
  const reply = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  if (u.includes('/api/agent/runs')) return reply({ ok: true, runs: relay.runs.slice() });
  if (u.includes('/api/agent/run')) return reply({ ok: true, runId: relay.startId });
  return reply({ ok: false, error: 'not stubbed' }, 404);
};

// ── Bundle the real modules ─────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'jarvis-monitor-sim-'));
const stub = join(dir, 'sdk-stub.mjs');
writeFileSync(
  stub,
  [
    'export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }',
    'export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }',
    'export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }',
    'export const utf8ByteLength = (s) => Buffer.byteLength(s, "utf8");',
    'export const measureTextWrap = () => ({ lineCount: 1 });',
    'export default {};',
  ].join('\n'),
);
const outfile = join(dir, 'bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * from './ai/monitor.ts';",
      "export * from './ai/index.ts';",
      "export * from './ai/registry.ts';",
      "export { runAiAgent } from './ai/agent.ts';",
      "export { aiView, listenView } from './sections.ts';",
      "export * as agentsStore from './agents-store.ts';",
      "export * as runsStore from './agent-runs.ts';",
    ].join('\n'),
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  alias: { '@evenrealities/even_hub_sdk': stub },
  define: { 'import.meta.env': '{}' },
});

const M = await import(pathToFileURL(outfile).href);
const {
  ackMonitor,
  agentsStore,
  appSnapshotText,
  callAction,
  enqueueMonitoredRun,
  getMonitored,
  getMonitorView,
  ingestMonitoredRuns,
  monitorAge,
  removeMonitoredRun,
  resetMonitor,
  runAiAgent,
  aiView,
  listenView,
} = M;

// ── Fixtures ────────────────────────────────────────────────────────────────
const ago = (ms) => Date.now() - ms;
const A1 = 'agent-news';
const A2 = 'agent-mail';

function seedAgents() {
  agentsStore.updateAgents((s) => ({
    ...s,
    agents: [
      {
        id: A1,
        name: 'News',
        systemPrompt: 'You are a news desk.',
        prompt: 'Give me the news',
        toolIds: [],
        model: '',
        createdAt: ago(60000),
        updatedAt: ago(60000),
      },
      {
        id: A2,
        name: 'Mail',
        systemPrompt: 'You triage mail.',
        prompt: 'Triage my inbox',
        toolIds: [],
        model: '',
        createdAt: ago(30000),
        updatedAt: ago(30000),
      },
    ],
    sessions: [],
  }));
}

function runMsg(role, content, extra = {}) {
  return { role, content, at: Date.now(), ...extra };
}
function relayRun(over = {}) {
  return {
    id: 'r1',
    agentId: A1,
    agentName: 'News',
    prompt: 'Give me the news',
    title: 'Give me the news',
    messages: [],
    status: 'running',
    statusText: '',
    startedAt: ago(5000),
    updatedAt: ago(5000),
    ...over,
  };
}

function fakeAi(over = {}) {
  return {
    status: 'done',
    focus: 'agents',
    utterance: 'run the news agent',
    steps: [{ kind: 'ok', text: 'Started News', at: Date.now() }],
    turn: 2,
    maxSteps: 5,
    pending: null,
    result: 'Started News',
    error: '',
    webTab: null,
    settings: { enabled: true, model: '', maxSteps: 5 },
    mirrored: false,
    ...over,
  };
}

/** Mirrors sections.ts / stripUnsupported: the firmware font draws these. */
const EXTRA_SAFE = new Set([...'─·•‣–—…′″→←↑↓↔≤≥≠±×÷−°§¶']);
function unsafeChars(text) {
  return [...text].filter((ch) => ch.codePointAt(0) >= 0x7f && !EXTRA_SAFE.has(ch));
}

// ── 1. Queue mechanics ──────────────────────────────────────────────────────
console.log('\n── queue mechanics ──');
resetMonitor();
check('empty view', getMonitorView(), { rows: [], unread: 0, running: 0 });

const row1 = enqueueMonitoredRun({ runId: 'r1', agentId: A1, agentName: 'News', prompt: 'Give me the news' });
assert('enqueue returns a row', row1 !== null);
is('enqueued status', row1?.status, 'running');
is('enqueued is not unread', row1?.unread, false);
is('enqueued label', getMonitorView().rows[0].label, 'News');
is('started running count', getMonitorView().running, 1);

// A tool-call-only assistant turn must NOT become the headline: it has no prose.
const toolOnly = relayRun({
  status: 'running',
  statusText: 'Searching the web…',
  messages: [
    runMsg('user', 'Give me the news'),
    runMsg('assistant', '', { tool: 'web_search', args: '{"query":"news"}' }),
  ],
});
let finished = ingestMonitoredRuns([toolOnly]);
check('running frame reports nothing finished', finished, []);
is('latest falls back to statusText', getMonitored('r1').latest, 'Searching the web…');
is('turn count from messages', getMonitored('r1').turns, 2);
is('a running frame raises no badge', getMonitorView().unread, 0);

// Prose arrives.
relay.runs = [
  relayRun({
    status: 'running',
    messages: [
      runMsg('user', 'Give me the news'),
      runMsg('assistant', '', { tool: 'web_search', args: '{}' }),
      runMsg('assistant', 'Found 3 stories so far'),
    ],
  }),
];
finished = ingestMonitoredRuns(relay.runs);
is('still running, no badge', getMonitorView().unread, 0);
is('latest is the newest prose turn', getMonitored('r1').latest, 'Found 3 stories so far');
check('no finish yet', finished, []);

// The run lands. This is the one edge that must fire.
const done = relayRun({
  status: 'done',
  statusText: 'Done',
  updatedAt: Date.now(),
  messages: [
    runMsg('user', 'Give me the news'),
    runMsg('assistant', '', { tool: 'web_search', args: '{}' }),
    runMsg('assistant', 'Found 3 stories so far'),
    runMsg('assistant', 'Three stories: the port, the storm, the budget.'),
  ],
});
relay.runs = [done];
finished = ingestMonitoredRuns(relay.runs);
is('terminal frame reports one finish', finished.length, 1);
is('finish status', finished[0]?.status, 'done');
is('finish runId', finished[0]?.runId, 'r1');
is('terminal frame raises the badge', getMonitorView().unread, 1);
is('badge marks the row', getMonitored('r1').unread, true);
is('latest is the final answer', getMonitored('r1').latest, 'Three stories: the port, the storm, the budget.');
is('running count drops', getMonitorView().running, 0);

// The relay re-sends the same terminal frame on every reconnect. That must NOT
// re-raise the badge, or the wearer is told the same run finished forever.
finished = ingestMonitoredRuns([done]);
check('replayed terminal frame reports nothing', finished, []);
is('replayed terminal frame keeps the badge', getMonitorView().unread, 1);

ackMonitor('r1');
is('ack clears the badge', getMonitorView().unread, 0);
is('ack clears the row flag', getMonitored('r1').unread, false);

finished = ingestMonitoredRuns([done]);
check('post-ack replay reports nothing', finished, []);
is('post-ack replay does not re-raise', getMonitorView().unread, 0);

// Idle frames for a run we never watched are ignored, not invented.
finished = ingestMonitoredRuns([relayRun({ id: 'ghost', status: 'done' })]);
check('unknown run ignored', finished, []);
is('unknown run not queued', getMonitorView().rows.length, 1);

// Newest first. There is no cursor here any more: the HUD's ring index is the
// only scroll position, and the view owns it (see the paging section below).
// Explicit timestamps: two enqueues inside the same millisecond tie on
// `startedAt`, and the tie-break (most recently updated) is not what this
// assertion is about.
resetMonitor();
const base = Date.now() - 10000;
enqueueMonitoredRun({ runId: 'r1', agentId: A1, agentName: 'News', at: base });
const row2 = enqueueMonitoredRun({ runId: 'r2', agentId: A2, agentName: 'Mail', at: base + 1000 });
assert('second enqueue returns a row', row2 !== null);
check('rows newest first', getMonitorView().rows.map((r) => r.runId), ['r2', 'r1']);
// Re-enqueuing refreshes the row instead of duplicating it, and must not lose
// where the ring was — the queue has no position of its own to reset.
is('re-enqueue refreshes in place', getMonitorView().rows.length, 2);

// Ack only clears the row you point at.
enqueueMonitoredRun({ runId: 'r3', agentId: A1, agentName: 'News', at: Date.now() });
enqueueMonitoredRun({ runId: 'r4', agentId: A2, agentName: 'Mail', at: Date.now() });
ingestMonitoredRuns([
  relayRun({ id: 'r3', status: 'done', updatedAt: Date.now(), messages: [runMsg('assistant', 'Three stories landed.')] }),
  relayRun({
    id: 'r4',
    agentId: A2,
    agentName: 'Mail',
    status: 'done',
    updatedAt: Date.now(),
    messages: [runMsg('assistant', 'Inbox is empty')],
  }),
]);
is('two badges', getMonitorView().unread, 2);
ackMonitor('r3');
is('ack targeted row only', getMonitored('r3').unread, false);
is('other row still unread', getMonitored('r4').unread, true);
is('badge count follows', getMonitorView().unread, 1);

is('age seconds', monitorAge(Date.now() - 42000), '42s');
is('age minutes', monitorAge(Date.now() - 180000), '3m');
is('age hours', monitorAge(Date.now() - 7200000), '2h');

// The queue is bounded so the strip and the prompt can't grow forever.
for (let i = 0; i < 12; i += 1) {
  enqueueMonitoredRun({ runId: `bulk-${i}`, agentId: A1, agentName: 'News', at: Date.now() + i });
}
is('queue capped', getMonitorView().rows.length, 8);
is('newest survives the cap', getMonitorView().rows[0].runId, 'bulk-11');

removeMonitoredRun('bulk-11');
is('remove drops the row', getMonitorView().rows.length, 7);
resetMonitor();
is('reset empties the queue', getMonitorView().rows.length, 0);

// ── 2. The tool Jarvis reads runs with ──────────────────────────────────────
console.log('\n── agents.sessions ──');
resetMonitor();
seedAgents();
const backdate = (id, ms) =>
  agentsStore.updateAgents((s) => ({
    ...s,
    sessions: s.sessions.map((x) =>
      x.id === id ? { ...x, createdAt: x.createdAt - ms, updatedAt: x.updatedAt - ms } : x,
    ),
  }));
// Two finished sessions (durable history) plus one run the relay still holds.
// Backdated explicitly so "newest first" is a real assertion, not a tie.
agentsStore.recordSession({
  id: 's-old',
  agentId: A2,
  title: 'Triage my inbox',
  status: 'done',
  messages: [runMsg('user', 'Triage my inbox'), runMsg('assistant', 'Two need a reply.')],
});
backdate('s-old', 7200000);
agentsStore.recordSession({
  id: 's-new',
  agentId: A1,
  title: 'Give me the news',
  status: 'done',
  messages: [
    runMsg('user', 'Give me the news'),
    runMsg('tool', 'headline one | headline two', { tool: 'web_search' }),
    runMsg('assistant', 'Port, storm, budget.'),
  ],
});
backdate('s-new', 3600000);
// An in-progress run only exists on the relay.
relay.runs = [
  relayRun({
    id: 'r-live',
    status: 'running',
    statusText: 'Searching the web…',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    messages: [runMsg('user', 'Give me the news'), runMsg('assistant', 'Looking for the latest headlines')],
  }),
];

const list = await callAction('agents.sessions', {}, 'agents');
assert('list ok', list.ok, list.summary);
is('three sessions merged', list.data?.sessions?.length, 3);
check('newest first (descending)', list.data.sessions.map((s) => s.id), ['r-live', 's-new', 's-old']);
check('handles are 1-based', list.data.sessions.map((s) => s.n), [1, 2, 3]);
is('newest is the live run', list.data.sessions[0].status, 'running');
is('newest is the live agent', list.data.sessions[0].agent, 'News');
assert('latest line present on running row', !!list.data.sessions[0].latest);
has('summary counts runs', list.summary, '3 sessions');has('summary counts running', list.summary, '1 running');
has('hint teaches the handle', list.hint, 'session');
assert('list summary is HUD-sized', list.summary.length <= 60, list.summary);
check('list summary is glyph-safe', unsafeChars(list.summary), []);

const detail = await callAction('agents.sessions', { session: '2' }, 'agents');
assert('detail ok', detail.ok, detail.summary);
is('detail agent', detail.data?.session?.agent, 'News');
is('detail transcript is a string', typeof detail.data?.transcript, 'string');
has('transcript has the prompt', detail.data.transcript, 'You: Give me the news');
has('transcript labels tool turns', detail.data.transcript, '[web_search]:');
has('transcript has the answer', detail.data.transcript, 'Port, storm, budget.');
assert('transcript survives a 1500-char clip', detail.data.transcript.length <= 1500);

const filtered = await callAction('agents.sessions', { agent: 'news' }, 'agents');
assert('agent filter ok', filtered.ok, filtered.summary);
is('agent filter narrows', filtered.data?.sessions?.length, 2);

const limited = await callAction('agents.sessions', { limit: '1' }, 'agents');
is('limit is honoured', limited.data?.sessions?.length, 1);

const noMatch = await callAction('agents.sessions', { agent: 'zzz' }, 'agents');
is('unknown agent fails', noMatch.ok, false);
has('unknown agent names the candidates', noMatch.hint, 'News');

// Triggering from Jarvis must put the run in the queue — that is the whole
// notification path.
resetMonitor();
const trig = await callAction('agents.trigger', { agent: 'News' }, 'agents');
assert('trigger ok', trig.ok, trig.summary);
is('trigger reports watching', trig.data?.watching, true);
assert('triggered run is enqueued', !!getMonitored(trig.data.runId), trig.data.runId);
is('triggered run is running in the queue', getMonitored(trig.data.runId).status, 'running');

// ── 3. The prompt and the tool list know about the queue ────────────────────
console.log('\n── prompt wiring ──');
resetMonitor();
enqueueMonitoredRun({ runId: 'r1', agentId: A1, agentName: 'News', at: Date.now() });
ingestMonitoredRuns([
  relayRun({ status: 'done', updatedAt: Date.now(), messages: [runMsg('assistant', 'Three stories landed.')] }),
]);
const snapshot = appSnapshotText();
has('snapshot announces the queue', snapshot, 'Jarvis agent queue');
has('snapshot flags the new run', snapshot, '[NEW]');
has('snapshot names the agent', snapshot, 'News');

let captured = null;
const scripted = async ({ messages, tools }) => {
  if (!captured) captured = { tools: (tools ?? []).map((t) => t.function.name), system: messages[0].content };
  const toolTurns = messages.filter((m) => m.role === 'tool');
  if (!toolTurns.length) {
    return {
      ok: true,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'agents__sessions', arguments: '{}' } },
        ],
      },
    };
  }
  captured.toolResult = toolTurns[toolTurns.length - 1].content;
  return { ok: true, message: { role: 'assistant', content: 'The news run finished.' } };
};
const run = await runAiAgent({ utterance: 'did the news run finish?', focus: 'agents', llm: scripted });
assert('run ok', run.ok, run.error);
is('run reply', run.reply, 'The news run finished.');
assert('system prompt carries the queue', captured.system.includes('Jarvis agent queue'));
has('tool list exposes the reader', captured.tools.join(','), 'agents__sessions');
has('tool result carries the sessions', captured.toolResult, 'sessions');
has('tool result names the newest run', captured.toolResult, 'News');

// ── 4. The HUD strip ────────────────────────────────────────────────────────
console.log('\n── hud strip ──');
resetMonitor();
enqueueMonitoredRun({ runId: 'r1', agentId: A1, agentName: 'News', at: Date.now() - 200000 });
enqueueMonitoredRun({ runId: 'r2', agentId: A2, agentName: 'Mail', at: Date.now() - 10000 });
ingestMonitoredRuns([
  relayRun({ status: 'done', updatedAt: Date.now() - 180000, messages: [runMsg('assistant', 'Three stories landed.')] }),
]);
ingestMonitoredRuns([
  relayRun({
    id: 'r2',
    agentId: A2,
    agentName: 'Mail',
    status: 'running',
    updatedAt: Date.now(),
    messages: [runMsg('assistant', 'Reading the inbox')],
  }),
]);

// `scroll` is the ring index: pages of the transcript first, then one unit per
// session row. Every assertion below is at a REAL index, because the view is
// what clamps it — main.ts echoes `todoCursor` straight back in.
const opts = (scroll) => ({ conversing: false, queue: getMonitorView(), scroll });

const view = aiView(fakeAi(), opts(0));
has('the newest page keeps the question', view.text, '"run the news agent"');
has('the newest page keeps the chain of thought', view.text, '· Started News');
// The turn reads newest-first: the ANSWER sits at the top of the pane and the
// question it answered is the last thing on it, so the first screenful is the
// part the wearer actually asked for. This used to be the other way round.
has('the answer leads the newest page', view.text, '= Started News');
assert(
  'the answer sits above the question on the page',
  view.text.indexOf('= Started News') < view.text.indexOf('"run the news agent"'),
  'answer must precede the question',
);
has('the page states its position once', view.text, 'scroll = 1/');
lacks('the position is not restated in the header', view.text, 'JARVIS · done · scroll');
is('the hud can page now', view.canNext, true);
is('the first page cannot go back', view.canPrev, false);
assert('hud under the byte cap', Buffer.byteLength(view.text, 'utf8') <= 999, `${Buffer.byteLength(view.text, 'utf8')} bytes`);
assert(
  'hud under the line cap',
  view.text.split('\n').length <= 10,
  `${view.text.split('\n').length} lines`,
);
check('hud has no unsupported glyphs', unsafeChars(view.text), []);
// The section boundary used to be 18 ASCII hyphens: a fifth of the pane wide,
// and invisible as a border. It is now a labelled rule of wide box-drawing
// glyphs that names the region it opens.
//
// This measurement is REAL. `sections.ts` measures with `@evenrealities/pretext`
// — the pixel-accurate LVGL matcher — and only the SDK import is stubbed here, so
// the rule below is drawn at the true render width. The builder appends glyphs
// until one would wrap, so the exact count depends on how wide the LABEL is: an
// all-dash rule stops at 29, and a labelled one squeezes in a few more because
// 'reply ' is narrower than a box glyph.
has('the page opens with a labelled rule', view.text, '── reply ');
const ruleWidth = [...view.text.split('\n')[1]].length;
assert(
  'the rule covers the pane without wrapping',
  ruleWidth >= 29 && ruleWidth <= 36,
  `${ruleWidth} glyphs: ${JSON.stringify(view.text.split('\n')[1])}`,
);
lacks('the old hyphen rule is gone', view.text, '------------------');
assert(
  'the controls are pinned to the bottom line',
  /^(tap R1|2x =|Stop AI)/.test(view.text.split('\n')[9] || ''),
  JSON.stringify(view.text.split('\n')[9]),
);

// The transcript region ends where the session rows begin — that boundary is
// how the caller knows a swipe has moved onto a background run (and should ack
// it) rather than onto another page of the same run.
const start = view.sessionStart;
assert('sessions start after the transcript', start > 0, `sessionStart=${start}`);
const nearEnd = aiView(fakeAi(), opts(start - 1));
assert('the page before the sessions is still transcript', nearEnd.todoCursor < nearEnd.sessionStart, `scroll=${nearEnd.todoCursor} start=${nearEnd.sessionStart}`);
is('the last transcript page can go forward', nearEnd.canNext, true);

const s1 = aiView(fakeAi(), opts(start));
has('strip shows the position', s1.text, 'runs 1/2');
has('strip marks the newest row', s1.text, '> Mail');
has('strip shows status and age', s1.text, 'Mail · running · 0s');
has('strip shows the latest line', s1.text, 'Reading the inbox');
has('the rule names the run region', s1.text, '── runs 1/2 ');
lacks('the transcript is not repeated above the strip', s1.text, '= Started News');
is('the last unit cannot go forward', s1.canNext, true);

const s2 = aiView(fakeAi(), opts(start + 1));
has('scrolling moves the position', s2.text, 'runs 2/2');
has('scrolling moves to the older row', s2.text, '> News');
has('scrolling reaches the badge', s2.text, 'NEW');
lacks('the other row is not repeated', s2.text, '> Mail');
is('the end of the queue', s2.canNext, false);
assert('the strip page fits too', Buffer.byteLength(s2.text, 'utf8') <= 999, `${Buffer.byteLength(s2.text, 'utf8')} bytes`);
// A run unit is its OWN screen: the labelled rule names the region and the row
// block is the only thing under it. Mixing a page of transcript above a run is
// what made the old strip unreadable — there was no telling which half of the
// pane the ring was on.
has('the run unit is named by its rule', s2.text, '── runs 2/2 ');
lacks('a run unit repeats no transcript', s2.text, '── reply ');
lacks('a run unit repeats no answer', s2.text, '= Started News');

// Clamping lives in the view, not the caller, so a stale index left over from a
// longer transcript can never strand the ring on a screen that no longer exists.
is('an over-scroll clamps to the last unit', aiView(fakeAi(), opts(999)).todoCursor, start + 1);
is('an over-scroll cannot go further', aiView(fakeAi(), opts(999)).canNext, false);
is('a negative scroll clamps to the first page', aiView(fakeAi(), opts(-5)).todoCursor, 0);
is('an unset scroll opens on page one', aiView(fakeAi(), { conversing: false, queue: getMonitorView() }).todoCursor, 0);
is('no queue, sessionStart is unset', aiView(fakeAi(), { conversing: false }).sessionStart, -1);

// ── The actual bug: a long run's reasoning must all be REACHABLE ────────────
// The old view kept the last two or three steps and clipped each to 44 chars,
// so most of a run's chain of thought could not be read at any scroll position.
const LONG = fakeAi({
  status: 'done',
  utterance: 'research the port strike',
  steps: [
    { kind: 'focus', text: 'agents', at: Date.now() },
    { kind: 'think', text: 'I should search the web before answering anything.', at: Date.now() },
    { kind: 'call', text: 'web_search · port strike', at: Date.now() },
    { kind: 'ok', text: 'three results', at: Date.now() },
    { kind: 'think', text: 'The budget angle matters most to the wearer.', at: Date.now() },
    { kind: 'call', text: 'web_search · port strike budget', at: Date.now() },
    { kind: 'ok', text: 'five results', at: Date.now() },
    { kind: 'reply', text: 'Drafting the brief now.', at: Date.now() },
    { kind: 'fail', text: 'tavily key missing, fell back', at: Date.now() },
  ],
  result: 'The port strike is about pay.',
});

// Walk the transcript region exactly the way onSwipe does: ask, then move one
// unit from the index the view just handed back.
const walked = [];
for (let i = 0; i < 40; i += 1) {
  const v = aiView(LONG, opts(i));
  if (v.todoCursor !== i) break;
  if (v.sessionStart >= 0 && i >= v.sessionStart) break;
  walked.push(v.text);
}
assert('a long run needs several pages', walked.length > 1, `${walked.length} page(s)`);
const all = walked.join('\n');
has('paging keeps the question', all, 'research the port strike');
has('paging reaches the FIRST thought', all, 'I should search the web before answering anything.');
has('paging reaches the LAST thought', all, 'The budget angle matters most to the wearer.');
has('paging reaches the tool calls', all, 'web_search · port strike budget');
has('paging reaches a failure line', all, '! tavily key missing, fell back');
has('paging reaches the answer', all, 'The port strike is about pay.');
check('every page fits the container', walked.filter((t) => Buffer.byteLength(t, 'utf8') > 999), []);
check('every page is glyph-safe', walked.flatMap((t) => unsafeChars(t)), []);
// The line cap is the guardrail that actually keeps the ring working: an
// overflowing container makes the firmware scroll it and swallow the swipe, so
// a page that is over budget is a page the wearer cannot leave. Bytes alone do
// not catch that — ten wide glyphs of rule are cheap but still ten lines.
check('every page fits the screen', walked.filter((t) => t.split('\n').length > 10), []);
// Newest-first means the answer is the FIRST thing the ring shows, and the
// question it answered is on the LAST page — the reverse of the old order.
has('the newest page carries the answer', walked[0], '= The port strike is about pay.');
has('the oldest page carries the question', walked[walked.length - 1], 'research the port strike');
lacks('the answer is not repeated on the oldest page', walked[walked.length - 1], '= The port strike is about pay.');
assert(
  'every page after the first is labelled as older',
  walked.slice(1).every((t) => t.includes('── older ')),
  walked.slice(1).map((t) => t.split('\n')[1]).join(' | '),
);

const emptyQueue = aiView(fakeAi(), { conversing: false });
lacks('no queue, no strip', emptyQueue.text, 'session');
// Same run, but with the strip gone the transcript gets the three lines back —
// so it fits on one page and the ring has nothing to scroll. The strip is what
// costs the transcript a page.
is('without a queue the same run fits one page', emptyQueue.canNext, false);

const single = aiView(fakeAi(), {
  conversing: false,
  queue: { rows: getMonitorView().rows.slice(0, 1), unread: 1, running: 0 },
  scroll: 2,
});
has('single row reads as a run', single.text, '── run ');
has('single row still reports its state', single.text, '· running ·');
lacks('single row does not advertise position', single.text, 'runs 1/1');
is('a single session unit still pages the transcript first', single.canPrev, true);

const confirming = aiView(
  fakeAi({ status: 'confirm', pending: { title: 'Delete agent', lines: ['News'] } }),
  { conversing: false, queue: getMonitorView() },
);
lacks('a confirm prompt hides the strip', confirming.text, 'sessions');
is('a confirm prompt is a single screen', confirming.canNext, false);

// ── 4b. The LISTENING screen ────────────────────────────────────────────────
// The mic and the feed on ONE canvas. Two things have to hold at once: the words
// being heard are visible while the wearer talks, and the ring still reaches the
// turn underneath. It used to be impossible — the mic screen REPLACED the HUD and
// refused the swipe, so a tap to speak destroyed the reply being read.
//
// The stub's `measureTextWrap` reports one line for everything, but the LISTEN
// layout is measured for real: `sections.ts` wraps with `@evenrealities/pretext`
// directly, so both the live region and the feed below it lay out at the true
// render width here.
console.log('\n── listening screen ──');

const LIVE = 'remind me what the port strike was about';
const listenOpts = (scroll = 0) => ({
  head: '>> Jarvis — listening',
  live: LIVE,
  status: 'Listening…',
  ai: LONG,
  queue: getMonitorView(),
  scroll,
  footer: 'tap R1 = send · Stop AI = end',
});
const listening = listenView(listenOpts());

has('the listening head names Jarvis', listening.text, '>> Jarvis — listening');
has('the listening screen labels the live region', listening.text, '── speech ');
has('the live words are on screen', listening.text, LIVE);
has('the listening screen labels the feed below', listening.text, '── reply ');
has('the listening screen keeps the answer readable', listening.text, '= The port strike is about pay.');
has('the listening footer names the send gesture', listening.text, 'tap R1 = send');
has('the listening footer names the exit', listening.text, 'Stop AI = end');
is('the mic screen is scrollable now', listening.canNext, true);
is('the first listen screen cannot go back', listening.canPrev, false);
lacks('the listening screen never offers to dismiss', listening.text, 'tap R1 = dismiss');
assert(
  'the listening screen fits the canvas',
  listening.text.split('\n').length <= 10,
  `${listening.text.split('\n').length} lines`,
);
assert(
  'the listening footer is the bottom line',
  listening.text.split('\n')[9].startsWith('tap R1 = send'),
  JSON.stringify(listening.text.split('\n')[9]),
);
assert(
  'the listening screen is under the byte cap',
  Buffer.byteLength(listening.text, 'utf8') <= 999,
  `${Buffer.byteLength(listening.text, 'utf8')} bytes`,
);
check('the listening screen is glyph-safe', unsafeChars(listening.text), []);

// The live region takes the TRAILING words when the sentence outgrows the three
// lines it is given: what was just heard is what the wearer is checking, not the
// opening clause. Speech runs through the same wrap the renderer uses, so this is
// a real layout assertion — the utterance below needs five wrapped lines to fit.
const LONG_SPEECH =
  'ok so first please check the news agent and then remind me what the port strike was about and finally mark the mail item done and also tell me whether the tomato plants need water today because the forecast said rain and I do not want to overwater them again this week';
const speaking = listenView({ ...listenOpts(), live: LONG_SPEECH });
has('a long utterance keeps its newest words', speaking.text, 'overwater them again');
is('the live region ends on the newest word', speaking.text.split('\n')[4], 'this week');
lacks('a long utterance drops its opening clause', speaking.text, 'ok so first please');

// Scrolling the feed must reach every unit, including the watched runs — the
// wearer composes the follow-up WHILE the transcript is in front of them.
const listenWalk = [];
for (let i = 0; i < 40; i += 1) {
  const v = listenView(listenOpts(i));
  if (v.todoCursor !== i) break;
  listenWalk.push(v.text);
}
assert('the listen feed pages', listenWalk.length > 1, `${listenWalk.length} unit(s)`);
has('the listen feed reaches the oldest thought', listenWalk.join('\n'), 'I should search the web before answering anything.');
has('the listen feed reaches the runs', listenWalk.join('\n'), '> Mail · running · 0s');
// The transcript region ENDS where the watched runs begin — same boundary as the
// HUD, so a swipe behaves identically on both screens. `sessionStart` is what
// `scrollJarvis` reads to know when a swipe has landed on a run and should ack it.
const lastListen = listenWalk[listenWalk.length - 1];
has('the listen feed ends on the run region', lastListen, '── runs ');
has('the listen feed shows the run row', lastListen, '> ');
check('every listen page fits the screen', listenWalk.filter((t) => t.split('\n').length > 10), []);
check('every listen page fits the container', listenWalk.filter((t) => Buffer.byteLength(t, 'utf8') > 999), []);
assert(
  'the listen screen announces the run region',
  listening.sessionStart > 0,
  `sessionStart=${listening.sessionStart}`,
);

// The live region costs the feed three lines, so the SAME turn pages in shorter
// chunks here than it does on the HUD. That is the whole reason the ring has to
// be resolved against the view actually on screen: move one HUD unit while
// listening and the wearer would be thrown pages past where they were.
const walkUnits = (build) => {
  let n = 0;
  for (let i = 0; i < 40; i += 1) {
    if (build(i).todoCursor !== i) break;
    n += 1;
  }
  return n;
};
const hudUnits = walkUnits((s) => aiView(LONG, opts(s)));
const listenUnits = walkUnits((s) => listenView(listenOpts(s)));
assert(
  'the listen screen pages its feed in shorter chunks',
  listenUnits > hudUnits,
  `listen=${listenUnits} hud=${hudUnits}`,
);
is('an over-scrolled listen screen clamps', listenView(listenOpts(999)).todoCursor, listenUnits - 1);
is('the listen screen ends', listenView(listenOpts(999)).canNext, false);

// Plain dictation has no turn behind it, so the whole pane goes to the live
// region — same borders, same footer slot, no feed and nothing to scroll.
const dictating = listenView({
  head: '>> Dictate',
  live: '',
  status: 'Starting mic…',
  ai: null,
  scroll: 0,
  footer: '● tap R1 = stop',
});
has('plain dictation falls back to the mic status', dictating.text, 'Starting mic…');
has('plain dictation labels the live region', dictating.text, '── speech ');
lacks('plain dictation has no feed to page', dictating.text, '── reply ');
is('plain dictation has nothing to scroll', dictating.canNext, false);
is('plain dictation has no run region', dictating.sessionStart, -1);
assert(
  'plain dictation fits the screen',
  dictating.text.split('\n').length <= 10,
  `${dictating.text.split('\n').length} lines`,
);
has('plain dictation keeps its stop gesture', dictating.text, '● tap R1 = stop');

// ── 5. The HELD answer ──────────────────────────────────────────────────────
// The resting state of a Jarvis conversation: the finished turn stays on screen,
// the mic is CLOSED and no timer is running, so the ring is the wearer's. WHEN it
// holds is owned by the platform layer (main.ts) and is out of reach here — what
// this can prove is that the screen it holds on is the one the footer promises,
// that holding does not take the ring away, and that the promise is LEGIBLE.
console.log('\n── held answer ──');

const held = aiView(LONG, { conversing: true, holding: true, queue: getMonitorView(), scroll: 0 });
has('the held footer offers the mic', held.text, 'tap R1 = speak');
has('the held footer offers the way out', held.text, '2x = read');
lacks('the held footer does not say "end"', held.text, '2x = end');
is('holding does not take the ring away', held.canNext, true);
// The whole point of the hold: the answer is still reachable after the run ends.
const heldAll = [];
for (let i = 0; i < 40; i += 1) {
  const v = aiView(LONG, { conversing: true, holding: true, queue: getMonitorView(), scroll: i });
  if (v.todoCursor !== i) break;
  if (v.sessionStart >= 0 && i >= v.sessionStart) break;
  heldAll.push(v.text);
}
has('a held run still pages to its answer', heldAll.join('\n'), '= The port strike is about pay.');
has('a held run still pages to its first thought', heldAll.join('\n'), 'I should search the web before answering anything.');

const talking = aiView(LONG, { conversing: true, holding: false, queue: getMonitorView(), scroll: 0 });
has('the talking footer still sends', talking.text, 'tap R1 = speak again');
has('the talking footer still ends', talking.text, '2x = end');
lacks('talking is not described as reading', talking.text, '2x = read');

// A mirrored run has no mic to close, so the hold must not leak onto it — the
// phone panel would otherwise advertise a tap that does nothing on that surface.
const mirroredHold = aiView(fakeAi({ mirrored: true }), {
  conversing: true,
  holding: true,
  queue: getMonitorView(),
});
has('a mirrored run keeps its dismiss hint', mirroredHold.text, 'tap = dismiss');
lacks('a mirrored run never offers the mic', mirroredHold.text, 'speak');
lacks('a mirrored run never offers the read exit', mirroredHold.text, '2x = read');

// The controls line sits BELOW a full body of transcript, so one extra rendered
// line pushes the container past the canvas — and the firmware then scrolls it,
// swallowing the ring swipe. That is the exact failure this screen exists to
// avoid, so every footer variant is measured at the real render width rather
// than eyeballed, including the widest page counter the ring can produce.
const INNER_W = 568; // 576 - 2 * paddingLength(4); see sections.ts
const controlsLine = (v) => v.text.split('\n').pop();
const tooWide = (s) => measureTextWrap(s, INNER_W).lineCount > 1;
check(
  'every footer renders on ONE line at 568px',
  [
    controlsLine(held),
    controlsLine(talking),
    // The widest counter: the last page of a long transcript against a 2-row strip.
    controlsLine(aiView(LONG, { conversing: true, holding: true, queue: getMonitorView(), scroll: 99 })),
    controlsLine(aiView(LONG, { conversing: false, queue: getMonitorView(), scroll: 99 })),
  ].filter(tooWide),
  [],
);

// ── verdict ─────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
