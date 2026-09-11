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
 *   3. The HUD strip. `aiView` cannot page (canPrev/canNext are false), so the
 *      queue scrolls by ring through `onSwipe`. The strip must also not break the
 *      999-byte container cap or draw unsupported glyphs.
 *
 * So this harness drives the real modules with plain objects and asserts the
 * behaviours above. It is the only place the queue's edge-triggering and the
 * session merge are pinned down.
 *
 * Run: node tools/jarvis-monitor-sim.mjs        (SIM_QUIET=1 for the tally only)
 */
import { build } from 'esbuild';
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
      "export { aiView } from './sections.ts';",
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
  moveMonitorCursor,
  removeMonitoredRun,
  resetMonitor,
  runAiAgent,
  aiView,
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
check('empty view', getMonitorView(), { rows: [], cursor: 0, unread: 0, running: 0 });

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

is('one row cannot scroll', moveMonitorCursor(1), false);

// Newest first, and a fresh enqueue puts the ring at the top.
// Explicit timestamps: two enqueues inside the same millisecond tie on
// `startedAt`, and the tie-break (most recently updated) is not what this
// assertion is about.
resetMonitor();
const base = Date.now() - 10000;
enqueueMonitoredRun({ runId: 'r1', agentId: A1, agentName: 'News', at: base });
const row2 = enqueueMonitoredRun({ runId: 'r2', agentId: A2, agentName: 'Mail', at: base + 1000 });
assert('second enqueue returns a row', row2 !== null);
check('rows newest first', getMonitorView().rows.map((r) => r.runId), ['r2', 'r1']);
is('new enqueue resets the cursor', getMonitorView().cursor, 0);

is('scroll forward', moveMonitorCursor(1), true);
is('cursor at older row', getMonitorView().cursor, 1);
is('scroll backward', moveMonitorCursor(1), true);
is('cursor wraps to newest', getMonitorView().cursor, 0);
is('scroll backward from newest wraps to oldest', moveMonitorCursor(-1), true);
is('cursor wrapped to oldest', getMonitorView().cursor, 1);

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

const view = aiView(fakeAi(), { conversing: false, queue: getMonitorView() });
has('strip shows the position', view.text, 'sessions 1/2');
has('strip marks the cursor row', view.text, '> Mail');
has('strip shows status and age', view.text, 'Mail · running · 0s');
has('strip shows the latest line', view.text, 'Reading the inbox');
has('hint teaches the scroll', view.text, 'scroll = sessions');is('jarvis hud still cannot page', view.canNext, false);
assert('hud under the byte cap', Buffer.byteLength(view.text, 'utf8') <= 999, `${Buffer.byteLength(view.text, 'utf8')} bytes`);
check('hud has no unsupported glyphs', unsafeChars(view.text), []);

moveMonitorCursor(1);
const older = aiView(fakeAi(), { conversing: false, queue: getMonitorView() });
has('scrolling moves the position', older.text, 'sessions 2/2');
has('scrolling moves the cursor row', older.text, '> News');
has('scrolling reaches the badge', older.text, 'NEW');
lacks('cursor row is not repeated', older.text, '> Mail');

const quiet = aiView(fakeAi(), { conversing: false });
lacks('no queue, no strip', quiet.text, 'session');

const single = aiView(fakeAi(), { conversing: false, queue: { rows: getMonitorView().rows.slice(0, 1), cursor: 0, unread: 1, running: 0 } });
has('single row reads as a session', single.text, 'session · new');
lacks('single row does not advertise scrolling', single.text, 'sessions 1/1');

const confirming = aiView(
  fakeAi({ status: 'confirm', pending: { title: 'Delete agent', lines: ['News'] } }),
  { conversing: false, queue: getMonitorView() },
);
lacks('a confirm prompt hides the strip', confirming.text, 'sessions');

// ── verdict ─────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
