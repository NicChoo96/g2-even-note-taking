#!/usr/bin/env node
// Jev decision spec harness — and the LOCKSTEP test.
//
// WHY THIS EXISTS
//   A decision spec is the only structured thing we hand upstream, so a malformed
//   one is not a soft failure: it is an opaque 4xx that tells the caller nothing.
//   Meanwhile the ANSWER side is not ours at all — the responder is a model we do
//   not control — so reading it back has to be forgiving without ever inventing a
//   confident wrong answer.
//
// TWO IMPLEMENTATIONS, ONE TRUTH
//   The spec logic ships twice — web/server/jev-spec.mjs (zero-build Node ESM,
//   used by the relay) and src/ai/jev/spec.ts (bundled into the WebView). They
//   cannot share a module: the deploy image only copies glasses/, and the relay is
//   never bundled. So this harness feeds the SAME fixtures to BOTH and fails if a
//   single field differs. Edit one, and this harness tells you.
//
// The fixtures marked REAL are the live 200 response captured from
// `~typesafe/jev-latest` — not inferred from the docs. That capture is why the
// two traps below are tested at all:
//   • `score` is a 0-BASED CONTINUOUS float (1.05 on a 3-step rubric means "just
//     past Frustrated"), so reading it as 1-based silently answers "Calm".
//   • `probabilities` is label-keyed for `choice` but INDEX-keyed for `score`.
//
// Run: cd glasses && node tools/jev-spec-sim.mjs

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const QUIET = !!process.env.SIM_QUIET;
let fail = 0;
let total = 0;
const assert = (label, cond, detail = '') => {
  total++;
  if (!cond) fail++;
  if (cond && QUIET) return;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const check = (label, got, want) => {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  if (ok && QUIET) return;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
};

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A valid spec using all three question types. */
const Q_VALID = {
  is_urgent: {
    type: 'noul',
    instructions: 'Does this message convey urgency?',
    criteria: { true: 'Explicitly time-sensitive', false: 'No urgency expressed' },
  },
  department: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: {
      billing: 'Payments, invoicing, refunds',
      technical: 'Bugs, outages, integrations',
      sales: 'Pricing, upgrades, new accounts',
    },
  },
  frustration: {
    type: 'score',
    instructions: 'How frustrated is the customer?',
    criteria: ['Calm', 'Frustrated', 'Very angry'],
  },
};

/** REAL: the live 200 body's `answers`, captured verbatim. */
const REAL_ANSWERS = {
  is_urgent: { type: 'noul', noul: 0.95 },
  department: {
    type: 'choice',
    choice: 'billing',
    probabilities: { technical: 0.12, billing: 0.88, sales: 0 },
    confidence: 0.81,
  },
  frustration: {
    type: 'score',
    score: 1.05,
    legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' },
    probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
    confidence: 0.93,
  },
};

/** Specs that MUST be rejected, with the field the error should name. */
const BAD_QUESTIONS = [
  { name: 'not an object', input: 'nope', field: 'questions' },
  { name: 'empty map', input: {}, field: 'questions' },
  { name: 'unknown type', input: { q: { type: 'likert', instructions: 'x', criteria: [] } }, field: 'questions.q.type' },
  { name: 'missing instructions', input: { q: { type: 'noul', criteria: { true: 'a', false: 'b' } } }, field: 'questions.q.instructions' },
  { name: 'blank instructions', input: { q: { type: 'noul', instructions: '   ', criteria: { true: 'a', false: 'b' } } }, field: 'questions.q.instructions' },
  {
    name: 'noul missing "false"',
    input: { q: { type: 'noul', instructions: 'x', criteria: { true: 'a' } } },
    field: 'questions.q.criteria.false',
  },
  {
    name: 'noul with a stray key',
    input: { q: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b', maybe: 'c' } } },
    field: 'questions.q.criteria',
  },
  {
    name: 'noul criteria is an array',
    input: { q: { type: 'noul', instructions: 'x', criteria: ['a', 'b'] } },
    field: 'questions.q.criteria',
  },
  { name: 'choice with no options', input: { q: { type: 'choice', instructions: 'x', criteria: {} } }, field: 'questions.q.criteria' },
  { name: 'choice with one option', input: { q: { type: 'choice', instructions: 'x', criteria: { only: 'd' } } }, field: 'questions.q.criteria' },
  {
    name: 'choice option with a blank description',
    input: { q: { type: 'choice', instructions: 'x', criteria: { a: '  ', b: 'd' } } },
    field: 'questions.q.criteria.a',
  },
  { name: 'score is not an array', input: { q: { type: 'score', instructions: 'x', criteria: { a: 'd', b: 'e' } } }, field: 'questions.q.criteria' },
  { name: 'score with one step', input: { q: { type: 'score', instructions: 'x', criteria: ['Calm'] } }, field: 'questions.q.criteria' },
  { name: 'score with duplicate steps', input: { q: { type: 'score', instructions: 'x', criteria: ['Calm', 'Calm'] } }, field: 'questions.q.criteria' },
  { name: 'score step is not a string', input: { q: { type: 'score', instructions: 'x', criteria: ['Calm', 3] } }, field: 'questions.q.criteria' },
  { name: 'question key is not snake_case', input: { IsUrgent: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }, field: 'questions' },
  { name: 'question key starts with a digit', input: { '1q': { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }, field: 'questions' },
];

/** Answer payloads that must never throw and must never invent an answer. */
const JUNK_ANSWERS = [null, undefined, 'a string', 42, [], {}, { is_urgent: null }, { is_urgent: {} }];

// ── Load both implementations ───────────────────────────────────────────────

const out = mkdtempSync(join(tmpdir(), 'jev-spec-sim-'));
const outfile = join(out, 'jev-spec.mjs');
await build({
  stdin: {
    contents: `export * from './ai/jev/spec.ts';`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
});
const web = await import(pathToFileURL(outfile).href);
const server = await import(pathToFileURL(resolve('..', 'web/server/jev-spec.mjs')).href);

// ── 1. The two implementations agree, fixture by fixture ────────────────────

console.log('── 1. the two implementations agree on validation ──');
const VALIDATE_CASES = [Q_VALID, ...BAD_QUESTIONS.map((c) => c.input)];
for (const [i, input] of VALIDATE_CASES.entries()) {
  const label = i === 0 ? 'the valid three-mode spec' : BAD_QUESTIONS[i - 1].name;
  let a, b, err = '';
  try {
    a = web.validateQuestions(input);
  } catch (e) {
    err = `web threw: ${e.message}`;
  }
  try {
    b = server.validateQuestions(input);
  } catch (e) {
    err = `server threw: ${e.message}`;
  }
  assert(`[${label}] both agree${err ? ` — ${err}` : ''}`, !err && JSON.stringify(a) === JSON.stringify(b),
    `web=${JSON.stringify(a)} server=${JSON.stringify(b)}`);
}

console.log('\n── 2. the two implementations agree on normalization ──');
const normalizeCases = [
  ['REAL live response', Q_VALID, REAL_ANSWERS],
  ['empty answers (every question unanswered)', Q_VALID, {}],
  ['junk answer payloads', Q_VALID, { is_urgent: 'junk', department: 7, frustration: false }],
];
for (const [label, q, raw] of normalizeCases) {
  const a = web.normalizeAnswers(q, raw);
  const b = server.normalizeAnswers(q, raw);
  assert(`[${label}] both agree`, JSON.stringify(a) === JSON.stringify(b),
    `web=${JSON.stringify(a)} server=${JSON.stringify(b)}`);
}

console.log('\n── 3. the two implementations agree on buildRequest ──');
for (const body of [
  { state: 'hello', questions: Q_VALID },
  { state: 'hello', questions: Q_VALID, model: '~typesafe/jev-latest' },
  { state: '   ', questions: Q_VALID },
  { state: 'hello', questions: {} },
  { state: { nested: ['a', 1, true] }, questions: Q_VALID },
  { questions: Q_VALID },
]) {
  const a = web.buildRequest(body);
  const b = server.buildRequest(body);
  assert(`[state=${JSON.stringify(body.state ?? null)}] both agree`, JSON.stringify(a) === JSON.stringify(b),
    `web=${JSON.stringify(a)} server=${JSON.stringify(b)}`);
}

console.log('\n── 4. the two implementations agree on tool-arg spec building ──');
for (const args of [
  { kind: 'noul', question: 'Is this urgent?' },
  { kind: 'choice', question: 'Which team?', options: 'billing|technical|sales' },
  { kind: 'choice', question: 'Which team?', options: 'solo' },
  { kind: 'score', question: 'How angry?', options: ['Calm', 'Frustrated', 'Very angry'] },
  { kind: 'score', question: 'How angry?', options: 'Calm, Frustrated, Very angry' },
  { kind: 'score', question: 'How angry?' },
  { kind: 'likert', question: 'Which?' },
  { kind: 'noul' },
]) {
  const a = web.specFromToolArgs(args);
  const b = server.specFromToolArgs(args);
  assert(`[${args.kind}/${JSON.stringify(args.options ?? null)}] both agree`,
    JSON.stringify(a) === JSON.stringify(b),
    `web=${JSON.stringify(a)} server=${JSON.stringify(b)}`);
}

// ── 5. Strictness — every malformed spec is rejected, naming the field ──────

console.log('\n── 5. malformed specs are rejected and name the field ──');
check('a valid three-mode spec is accepted', web.validateQuestions(Q_VALID).ok, true);
for (const c of BAD_QUESTIONS) {
  const res = web.validateQuestions(c.input);
  assert(`[${c.name}] rejected`, res.ok === false, JSON.stringify(res));
  if (res.ok === false) check(`[${c.name}] field`, res.field, c.field);
}
{
  const many = {};
  for (let i = 0; i < 13; i++) many[`q${i}`] = Q_VALID.is_urgent;
  const res = web.validateQuestions(many);
  assert('[13 questions] rejected', res.ok === false, JSON.stringify(res));
  check('[13 questions] field', res.field, 'questions');
}
{
  const long = { q: { ...Q_VALID.is_urgent, instructions: 'x'.repeat(401) } };
  assert('[instructions over 400 chars] rejected', web.validateQuestions(long).ok === false);
}
{
  const longLabel = { q: { type: 'choice', instructions: 'x', criteria: { ['l'.repeat(61)]: 'd', b: 'd' } } };
  assert('[choice label over 60 chars] rejected', web.validateQuestions(longLabel).ok === false);
}

// ── 6. The normalizer reads the real shape the right way ────────────────────

console.log('\n── 6. the REAL response is read correctly ──');
{
  const a = web.normalizeAnswers(Q_VALID, REAL_ANSWERS);
  check('[noul] probability kept as-is', a.is_urgent.value, 0.95);
  check('[noul] yes at 0.5', a.is_urgent.yes, true);
  check('[choice] the declared label', a.department.choice, 'billing');
  check('[choice] distribution preserved', a.department.probabilities, { technical: 0.12, billing: 0.88, sales: 0 });
  check('[choice] confidence surfaced', a.department.confidence, 0.81);
  // THE TRAP: 1.05 is 0-based and continuous → index 1, NOT index 0.
  check('[score] 1.05 does NOT round down to the first step', a.frustration.label, 'Frustrated');
  check('[score] continuous value preserved', a.frustration.score, 1.05);
  check('[score] 0-based index', a.frustration.index, 1);
  check('[score] 1-based position', a.frustration.position, 2);
  check('[score] rubric length carried', a.frustration.total, 3);
  check('[score] normalized 0..1 along the rubric', a.frustration.value, 0.525);
  // THE OTHER TRAP: index-keyed probabilities come back label-keyed.
  check('[score] index-keyed probabilities remapped to labels', a.frustration.probabilities, {
    Calm: 0,
    Frustrated: 0.95,
    'Very angry': 0.05,
  });
}

console.log('\n── 7. tolerances and clamps ──');
{
  const q1 = (v) => web.normalizeAnswers({ q: Q_VALID.is_urgent }, { q: v }).q;
  check('bare number accepted', q1(0.3).value, 0.3);
  check('above 1 clamps to 1', q1(1.7).value, 1);
  check('below 0 clamps to 0', q1(-0.4).value, 0);
  check('0.499 is not yes', q1(0.499).yes, false);
  check('0.5 is yes', q1(0.5).yes, true);
  check('unreadable noul is invalid, not zero', q1('abc').ok, false);

  const q3 = (v) => web.normalizeAnswers({ q: Q_VALID.frustration }, { q: v }).q;
  check('label form accepted', q3({ score: 'Frustrated' }).index, 1);
  check('0 is the first step', q3({ score: 0 }).label, 'Calm');
  check('out-of-range high clamps to the last step', q3({ score: 99 }).label, 'Very angry');
  check('out-of-range low clamps to the first step', q3({ score: -3 }).label, 'Calm');
  check('distribution alone resolves the step', q3({ probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } }).label, 'Very angry');
  check('unreadable score is invalid', q3({ score: 'nonsense' }).ok, false);

  const q2 = (v) => web.normalizeAnswers({ q: Q_VALID.department }, { q: v }).q;
  check('distribution alone resolves the choice', q2({ probabilities: { billing: 0.1, sales: 0.9, technical: 0 } }).choice, 'sales');
  check('a label not in the spec is invalid, not guessed', q2({ choice: 'legal' }).ok, false);
}

console.log('\n── 8. junk never throws and never drops a question ──');for (const junk of JUNK_ANSWERS) {
  let res, err = '';
  try {
    res = web.normalizeAnswers(Q_VALID, junk);
  } catch (e) {
    err = e.message;
  }
  if (err) {
    assert(`[${JSON.stringify(junk)}] did not throw`, false, err);
    continue;
  }
  const keys = Object.keys(res).sort();
  assert(
    `[${JSON.stringify(junk)}] every declared question is present`,
    JSON.stringify(keys) === JSON.stringify(Object.keys(Q_VALID).sort()),
    JSON.stringify(keys),
  );
  const allInvalid = Object.values(res).every((a) => a.ok === false && a.invalid === true);
  assert(`[${JSON.stringify(junk)}] all invalid, none fabricated`, allInvalid, JSON.stringify(res));
}

// ── 9. The relay actually uses this module, on its own key ──────────────────

console.log('\n── 8b. answer rendering is shared and readable ──');
{
  const a = web.normalizeAnswers(Q_VALID, REAL_ANSWERS);
  check('both implementations render identically', server.describeAnswers(a), web.describeAnswers(a));
  check(
    'the REAL response renders as three plain lines',
    web.describeAnswers(a),
    'is_urgent: yes (0.95 likely true)\n' +
      'department: billing [billing 0.88, technical 0.12, sales 0]\n' +
      'frustration: Frustrated (step 2 of 3, score 1.05)',
  );
  check(
    'an unreadable answer renders as such, never as a value',
    web.describeAnswers(web.normalizeAnswers(Q_VALID, {})),
    'is_urgent: (no readable answer)\n' +
      'department: (no readable answer)\n' +
      'frustration: (no readable answer)',
  );
  check('renders nothing for an empty answer set', web.describeAnswers({}), '');
  assert(
    'rendering is ASCII-only (glasses font is emoji-free)',
    [...web.describeAnswers(a)].every((c) => c.codePointAt(0) < 128),
    JSON.stringify(web.describeAnswers(a)),
  );
}

// ── 9. The relay actually uses this module, on its own key ──────────────────

console.log('\n── 9. relay wiring (source) ──');
const relay = readFileSync(resolve('..', 'web/server/local-sse.mjs'), 'utf8');
assert('relay imports the spec module', /from '\.\/jev-spec\.mjs'/.test(relay));
assert('relay exposes POST /api/decisions', /url\.pathname === '\/api\/decisions'/.test(relay));
assert('relay pins the typed-decision model', /JEV_DEFAULT_MODEL = '~typesafe\/jev-latest'/.test(relay));
assert(
  'relay reads the OpenRouter key for jev, NOT the chat provider',
  /function jevConfig\(\)[\s\S]{0,400}process\.env\.OPENROUTER_API_KEY/.test(relay),
);
assert(
  'jev config does not route through llmConfig()',
  !/function jevConfig\(\)[\s\S]{0,400}llmConfig\(\)/.test(relay),
);
assert('relay validates before spending a call', /const built = buildRequest\(body\)/.test(relay));
assert('relay reports a 400 for a malformed spec', /json\(res, 400, \{ ok: false, error: built\.error, field: built\.field \}\)/.test(relay));
assert('relay reports 501 when unconfigured', /Jev not configured — set OPENROUTER_API_KEY/.test(relay));
assert('relay advertises jev availability to clients', /jev: Boolean\(jev\.key\)/.test(relay));
assert('the agent engine has a jev tool branch', /tool\.kind === 'jev'/.test(relay));
assert('toolSchemaFor has a jev branch', /t\?\.kind === 'jev'/.test(relay));
assert(
  'the jev agent tool demands the state it judges',
  /required: \['state', 'question', 'kind'\]/.test(relay),
);

// jev is a reranker as well as a tool. The relay DERIVES the ranking from the
// answer it already has rather than spending a second call, and it advertises
// the `rank` intent so a model can say what it is doing.
assert('the relay derives a ranking from the jev answer', /rankAnswers\(built\.value, answers\)/.test(relay));
assert('the relay renders that ranking into the tool result', /describeRanking/.test(relay));
assert(
  'the jev agent schema offers the rank intent',
  /enum: \['noul', 'choice', 'score', 'rank'\]/.test(relay),
);
// Adding a capability would shrink the page budget and evict a page action (the
// bug fixed in 0.3.28), so the reserve must still hold exactly one entry.
const agentSrc = readFileSync(resolve('src', 'ai', 'agent.ts'), 'utf8');
assert(
  'the always-available reserve still holds exactly one tool',
  /const ALWAYS_AVAILABLE = \['jev\.decide'\];/.test(agentSrc),
);

// ── 10. the Agents tool side (source invariants) ────────────────────────────
//
// jev has to appear in two places a new capability does not: the capability
// catalog (for Jarvis) AND the Agents builder, which serialises ToolDefs into
// provider schemas and runs them server-side in the relay.

console.log('\n── 10. agents tool wiring (source) ──');
const typesSrc = readFileSync(resolve('src', 'types.ts'), 'utf8');
const panelSrc = readFileSync(resolve('src', 'web', 'AgentsPanel.tsx'), 'utf8');
const pagesSrc = readFileSync(resolve('src', 'ai', 'pages.ts'), 'utf8');
const capSrc = readFileSync(resolve('src', 'ai', 'capabilities', 'jev.ts'), 'utf8');
const clientSrc = readFileSync(resolve('src', 'web', 'jev-client.ts'), 'utf8');
const storeSrc = readFileSync(resolve('src', 'agents-store.ts'), 'utf8');
const settingsSrc = readFileSync(resolve('src', 'web', 'SettingsPanel.tsx'), 'utf8');

assert('ToolKind admits the jev kind alongside web', /'web' \| 'http' \| 'jev'/.test(typesSrc));
assert('ToolKind still admits the legacy tavily kind', /'tavily'/.test(typesSrc));
assert('types.ts exports a jev tool seeder', /export function jevTool\(\): ToolDef/.test(typesSrc));
assert('the panel can seed jev onto an agent', /addJevToAgent/.test(panelSrc));
assert('the panel offers jev as a tool kind', /<option value="jev">/.test(panelSrc));
assert(
  'the panel tells the truth when jev has no key',
  /reports that it was skipped rather than guessing/.test(panelSrc),
);
assert('pages.ts registers the jev capability', /jevCapabilities/.test(pagesSrc));
assert('the settings panel reports jev readiness', /Jev ready/.test(settingsSrc));

// Credential hygiene: the capability and the browser client must never hold or
// name a provider key/host. Only the relay does (see section 9). Comments may
// discuss the invariant, so only the executable text is checked.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const capCode = stripComments(capSrc);
const clientCode = stripComments(clientSrc);
assert('the capability owns no credential', !/OPENROUTER_API_KEY/.test(capCode));
assert('the capability never names a provider host', !/openrouter\.ai/.test(capCode));
assert('the browser client never names a provider host', !/openrouter\.ai/.test(clientCode));
assert('the browser client holds no provider key', !/sk-or-v1|OPENROUTER_API_KEY/.test(clientCode));
assert('the browser client only ever posts to the relay', /API_BASE}\/api\/decisions/.test(clientCode));
assert('the not-set-up path tells the model not to guess', /do not guess/.test(capSrc));

// jev is opt-in. Seeding it must stay a user action, and the Tavily-style
// "always keep it" invariant must NOT be extended to jev — that would resurrect
// a deliberately deleted tool on every reload.
assert(
  'jev is not auto-resurrected after a delete (opt-in preserved)',
  !/kind === 'jev'/.test(storeSrc),
);

// ── 11. the registry ships a legal tool name and a described schema ─────────
//
// A single illegal function name makes the provider reject the ENTIRE tools
// array with a 400, so "jev.decide" must reach the wire as "jev__decide".

console.log('\n── 11. registry tool schema ──');

// Fake host first: these modules touch window/localStorage at import time, and
// stream.ts reads import.meta.env.
globalThis.window = globalThis;
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const outDir = mkdtempSync(join(tmpdir(), 'jev-ui-sim-'));
const sdkStub = join(outDir, 'sdk-stub.mjs');
writeFileSync(
  sdkStub,
  `export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }
export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }
export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }
export const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
export const measureTextWrap = () => ({ lineCount: 1 });
`,
);
const uiBundle = join(outDir, 'jev-ui.mjs');
await build({
  stdin: {
    contents: `
// Side effect and helper come from different modules on purpose: pages.ts is the
// file that REGISTERS the catalog, registry.ts is where the helpers live.
import './ai/pages.ts';
export { capabilityByName, allCapabilities, capabilitiesForPage, listPages, toToolSchema, toWireName, callAction } from './ai/registry.ts';
export { selectTools } from './ai/agent.ts';
export { emptyAgentsState, jevTool } from './types.ts';
export { GLOBAL_PAGE } from './ai/types.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'jev-ui-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: uiBundle,
  alias: { '@evenrealities/even_hub_sdk': sdkStub },
  define: { 'import.meta.env': '{}' },
});
const ui = await import(pathToFileURL(uiBundle).href);

const cap = ui.capabilityByName('jev.decide');
assert('the catalog exposes jev.decide', !!cap);
assert('it is global, not tied to one page', cap?.page === ui.GLOBAL_PAGE, String(cap?.page));
const wire = ui.toWireName('jev.decide');
assert('the wire name is legal for tool-calling APIs', /^[a-zA-Z0-9_-]+$/.test(wire), wire);

const schema = ui.toToolSchema(cap);
check('the tool is a function', schema.type, 'function');
check('the dotted name is translated for the wire', schema.function.name, 'jev__decide');
check('the two structured arguments are required', schema.function.parameters.required, ['state', 'questions']);
check(
  'both structured arguments are strings (jev needs a JSON-encoded question set)',
  ['state', 'questions'].map((n) => schema.function.parameters.properties[n].type),
  ['string', 'string'],
);
// `rank` was added to this schema, so the shape is asserted explicitly rather
// than by counting properties. It must be OFFERED and never REQUIRED: a caller
// that omits it must get the pre-reranker behaviour byte for byte.
check('the rank intent is offered as a boolean', schema.function.parameters.properties.rank?.type, 'boolean');
assert('the rank intent is not required', !schema.function.parameters.required.includes('rank'));
assert(
  'the rank intent is described well enough for the model to decide',
  (schema.function.parameters.properties.rank?.description ?? '').length > 40,
);
assert(
  'every jev argument is described well enough for the model to fill it',
  cap.params.every((p) => typeof p.description === 'string' && p.description.length > 40),
);

// The Agents seeder is a well-formed ToolDef, and a FRESH install is offered it
// without being pre-attached (opt-in).
const seeder = ui.jevTool();
check('the seeder names the tool', seeder.name, 'jev_decide');
check('the seeder kind matches ToolKind', seeder.kind, 'jev');
assert('the seeder needs no token', seeder.hasToken === false);
assert(
  'the seeder says when to reach for it, and that the answer is not prose',
  /routing/.test(seeder.description) && /prose/.test(seeder.description),
);
check(
  'a fresh install is not handed a jev tool it never asked for',
  ui.emptyAgentsState().tools.some((t) => t.kind === 'jev'),
  false,
);

// Registering a capability is NOT the same as handing it to the model. The loop
// sends one TRIMMED tool list per focus, and jev.decide was registered and
// advertised by the PAGES block as "always callable" while being absent from
// the list on every docs and agents turn — so Jarvis called a tool that was not
// there and reported a failure the wearer could not act on. Only the real
// selection per page proves exposure.
for (const pid of ui.listPages().map((p) => p.id)) {
  const handed = ui.selectTools(pid).map((s) => s.function.name);
  assert(
    `Jarvis can actually call jev from '${pid}'`,
    handed.includes('jev__decide'),
    `handed: ${handed.join(', ')}`,
  );
}

// ── 12. the capability answers honestly, and only from real data ────────────
//
// Driven through the real client over a stubbed fetch, so the whole path
// (capability → local validation → client → parse → summary) is exercised.

console.log('\n── 12. the capability answers honestly ──');

const realFetch = globalThis.fetch;
const replyWith = (status, body) => {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
};
const STATE = 'Third time I have been charged for the same order. Please fix this.';
const ask = (questions) =>
  ui.callAction('jev.decide', { state: STATE, questions }, ui.GLOBAL_PAGE);

replyWith(200, {
  ok: true,
  model: 'typesafe/jev-1.13-20260917',
  // What the RELAY returns: normalized answers, not the raw upstream body. The
  // client must never be handed an un-normalized shape, so the fixture is built
  // with the same normalizer the relay uses.
  answers: web.normalizeAnswers(Q_VALID, REAL_ANSWERS),
});
const good = await ask(JSON.stringify(Q_VALID));
assert('a decision succeeds', good.ok === true, good.summary);
assert('the glasses line is a single line', !/[\r\n]/.test(good.summary), JSON.stringify(good.summary));
assert('the glasses line fits the cap', good.summary.length <= 48, String(good.summary.length));
assert(
  'the glasses line is renderable (ASCII, bar a possible ellipsis)',
  /^[\x20-\x7e\u2026]*$/.test(good.summary),
  JSON.stringify(good.summary),
);
assert('the headline is the first answer', /^is_urgent/.test(good.summary), good.summary);
assert('the full answer set is kept for the model', /department: billing/.test(good.data?.text ?? ''));
assert('the hint points the model at the detail', /data\.text/.test(good.hint ?? ''));
assert('the raw answers survive for branching', good.data?.answers?.frustration?.label === 'Frustrated');

// 501 → the key is missing. This is the failure mode that must never be papered
// over with a plausible-looking default.
replyWith(501, { ok: false, error: 'Jev not configured — set OPENROUTER_API_KEY or save it in Settings' });
const unset = await ask(JSON.stringify(Q_VALID));
assert('a missing key is reported as not set up', unset.summary === 'Jev is not set up', unset.summary);
assert('a missing key is flagged skipped', unset.ok === false && unset.data?.skipped === true);
assert('a missing key produces no answers', unset.data?.answers === undefined);
assert('a missing key tells the model not to guess', /do not guess/.test(unset.hint ?? ''));

// 502 → transient. Also never invented.
replyWith(502, { ok: false, error: 'upstream 502' });
const broken = await ask(JSON.stringify(Q_VALID));
assert('a provider failure is reported, not guessed', broken.summary === 'Jev could not decide', broken.summary);
assert('a provider failure produces no answers', broken.data?.answers === undefined);
assert('a provider failure is not marked skipped', broken.data?.skipped !== true);

// Rejected locally, before a cent is spent upstream.
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls++;
  return { ok: true, status: 200, json: async () => ({ ok: true, answers: {} }) };
};
const noState = await ui.callAction('jev.decide', { state: '   ', questions: JSON.stringify(Q_VALID) }, ui.GLOBAL_PAGE);
assert('an empty state is refused', noState.summary === 'Nothing to judge', noState.summary);
const badSpec = await ask('{not json');
assert('a malformed question spec is refused', badSpec.summary === 'Bad question spec', badSpec.summary);
const wrongShape = await ask(JSON.stringify({ dept: { type: 'nope' } }));
assert('an unknown question type is refused', wrongShape.summary === 'Bad question spec', wrongShape.summary);
const hugeState = await ask(JSON.stringify(Q_VALID));
assert('a state within limits is not rejected for size', hugeState.ok === true);
check('local validation spends no upstream call', networkCalls, 1);

// `rank: true` re-leads the result with the leader. The default path above is
// asserted unchanged, so this is additive by construction, not by claim.
replyWith(200, { ok: true, answers: web.normalizeAnswers(Q_VALID, REAL_ANSWERS) });
const ranked = await ui.callAction(
  'jev.decide',
  { state: STATE, questions: JSON.stringify(Q_VALID), rank: true },
  ui.GLOBAL_PAGE,
);
assert('asking for a ranking succeeds', ranked.ok === true, ranked.summary);
assert('the ranked headline is the leader, not the first question', /billing/.test(ranked.summary), ranked.summary);
assert('the ranked headline still fits the cap', ranked.summary.length <= 48, String(ranked.summary.length));
assert('the raw answers are still there when ranking', ranked.data?.answers?.department?.choice === 'billing');
assert('the ranking is kept for the model to branch on', ranked.data?.ranking?.department?.top === 'billing');
assert(
  'the hint spells out the whole order',
  /billing 0\.88 > technical 0\.12 > sales 0/.test(ranked.hint ?? ''),
  ranked.hint,
);

// A near-tie must not reach the glasses as a decision either.
const TIE_Q = { pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } } };
replyWith(200, {
  ok: true,
  answers: web.normalizeAnswers(TIE_Q, {
    pick: { type: 'choice', choice: 'a', probabilities: { a: 0.52, b: 0.48 } },
  }),
});
const tied = await ui.callAction(
  'jev.decide',
  { state: STATE, questions: JSON.stringify(TIE_Q), rank: true },
  ui.GLOBAL_PAGE,
);
assert('an unresolved ranking is marked on the glasses line', /^\? /.test(tied.summary), tied.summary);
assert('an unresolved ranking names no winner in data', tied.data?.ranking?.pick?.top === null);
assert('an unresolved ranking says why', /within/.test(tied.hint ?? ''), tied.hint);

globalThis.fetch = realFetch;

// ── 13. jev as a RERANKER ──────────────────────────────────────────────────
//
// A `choice` answer already carries the whole distribution and a confidence, so
// jev has always been a reranker that nobody read as one. This section pins the
// READER: it turns a distribution into an order, and — more importantly — it
// refuses to invent one when the evidence does not separate the candidates.
//
// It is the same underlying call. "Tool" and "reranker" are two ways of reading
// one answer, not two features.

console.log('\n── 13. jev as a reranker ──');

const normalized = web.normalizeAnswers(Q_VALID, REAL_ANSWERS);
const webRank = web.rankAnswers(Q_VALID, normalized);
const serverRank = server.rankAnswers(Q_VALID, server.normalizeAnswers(Q_VALID, REAL_ANSWERS));

check('both implementations rank identically', webRank, serverRank);
check(
  'both implementations render the ranking identically',
  Object.values(webRank).map(web.describeRanking),
  Object.values(serverRank).map(server.describeRanking),
);

// The REAL distribution is {technical 0.12, billing 0.88, sales 0}. The declared
// order is billing, technical, sales — so a reader that merely echoed the spec
// would still look right on the headline. The full order is what proves it
// actually sorted.
check('the REAL distribution is ordered by probability', webRank.department.ranked, [
  { label: 'billing', p: 0.88, rank: 1 },
  { label: 'technical', p: 0.12, rank: 2 },
  { label: 'sales', p: 0, rank: 3 },
]);
check('a separated leader is named as the answer', webRank.department.top, 'billing');
check('a separated leader is not flagged unresolved', webRank.department.unresolved, false);
check('the margin that separated it is carried through', webRank.department.confidence, 0.81);
check('there is nothing to explain when the order held', webRank.department.reason, null);
check(
  'the rubric is ranked too, with index-keyed probabilities remapped',
  webRank.frustration.ranked,
  [
    { label: 'Frustrated', p: 0.95, rank: 1 },
    { label: 'Very angry', p: 0.05, rank: 2 },
    { label: 'Calm', p: 0, rank: 3 },
  ],
);
check(
  'a yes/no answer is not ranked: it is a value, not an order',
  Object.keys(webRank),
  ['department', 'frustration'],
);
check(
  'the rendered ranking reads as an order, winner first',
  web.describeRanking(webRank.department),
  'department: billing 0.88 > technical 0.12 > sales 0',
);
assert(
  'a rendered ranking is ASCII-only (glasses font is emoji-free)',
  [...Object.values(webRank).map(web.describeRanking).join('\n')].every((c) => c.codePointAt(0) < 128),
);

// A near-tie is a coin toss. Naming a winner here would be exactly the
// confident-but-wrong answer the whole module exists to prevent.
const tieOf = (probabilities, choice = 'a') =>
  web.rankAnswers(TIE_Q, { pick: { type: 'choice', choice, probabilities } }).pick;

const tie = tieOf({ a: 0.52, b: 0.48 });
check('a near-tie names no winner', tie.top, null);
check('a near-tie is flagged unresolved', tie.unresolved, true);
assert('a near-tie explains itself', /within/.test(tie.reason ?? ''), String(tie.reason));
check('a near-tie still exposes the raw leader for a caller that wants it', tie.ranked[0].label, 'a');

check('exactly one margin apart IS separated', tieOf({ a: 0.6, b: 0.4 }).top, 'a');
check('exactly one margin apart is not flagged', tieOf({ a: 0.6, b: 0.4 }).unresolved, false);
check('a dead heat keeps declaration order', tieOf({ a: 0.5, b: 0.5 }).ranked.map((r) => r.label), ['a', 'b']);
check('a dead heat names no winner', tieOf({ a: 0.5, b: 0.5 }).top, null);

// `confidence: null` means "no gate available", never "high confidence".
check('a missing confidence is null, not a stand-in for certainty', tieOf({ a: 0.9, b: 0.1 }).confidence, null);
check('a missing confidence does not block a clearly separated order', tieOf({ a: 0.9, b: 0.1 }).top, 'a');

// No distribution at all: the model did pick, so the claim leads, but the order
// around it is the declared order and the result says so rather than dressing it
// up as a ranking.
const bare = web.rankAnswers(Q_VALID, web.normalizeAnswers(Q_VALID, { department: { type: 'choice', choice: 'billing' } })).department;
check('a pick with no distribution claims no ranking', bare.top, null);
check('a pick with no distribution is unresolved', bare.unresolved, true);
check('the claimed option leads the fallback order', bare.ranked.map((r) => r.label), ['billing', 'technical', 'sales']);
check('no probability is invented to fill the gap', bare.ranked.map((r) => r.p), [null, null, null]);
check(
  'an unsupported order is labelled as such on the wire',
  web.describeRanking(bare),
  'department: billing > technical > sales (unresolved: no probabilities were returned, so the order is the declared order)',
);

// Unreadable: the producer's own order, never an invention.
const junkRank = web.rankAnswers(Q_VALID, web.normalizeAnswers(Q_VALID, { department: 'junk' })).department;
check('an unreadable answer ranks nothing', junkRank.top, null);
check('an unreadable answer falls back to declaration order', junkRank.ranked.map((r) => r.label), ['billing', 'technical', 'sales']);
assert('an unreadable answer says why', /no readable answer/.test(junkRank.reason ?? ''), String(junkRank.reason));

// A distribution that does not cover a candidate cannot compare it, so a
// missing value must never be read as "low" and lose the leader its place.
const partial = tieOf({ a: 0.9 });
check('a partial distribution names no winner from a missing value', partial.top, null);
check('a partial distribution is unresolved', partial.unresolved, true);
assert('a partial distribution explains itself', /does not cover/.test(partial.reason ?? ''), String(partial.reason));

// The honesty paths are the ones most likely to drift between the two copies.
for (const [label, q, a] of [
  ['the REAL body', Q_VALID, normalized],
  ['a near-tie', TIE_Q, { pick: { type: 'choice', choice: 'a', probabilities: { a: 0.52, b: 0.48 } } }],
  ['a dead beat', TIE_Q, { pick: { type: 'choice', choice: 'a', probabilities: { a: 0.5, b: 0.5 } } }],
  ['a bare pick', Q_VALID, web.normalizeAnswers(Q_VALID, { department: { type: 'choice', choice: 'billing' } })],
  ['junk', Q_VALID, web.normalizeAnswers(Q_VALID, { department: 'junk' })],
  ['a partial distribution', TIE_Q, { pick: { type: 'choice', choice: 'a', probabilities: { a: 0.9 } } }],
]) {
  check(`lockstep on ${label}`, web.rankAnswers(q, a), server.rankAnswers(q, a));
}

// `rank` is a shape ALIAS, not a fourth question type: it must build exactly the
// spec `choice` builds, so a model that says "rank" and a model that says
// "choice" ask the provider the same question.
{
  const mk = (kind) => ({ kind, question: 'Which result is most relevant?', options: 'hit_1|hit_2|hit_3' });
  const asRank = web.specFromToolArgs(mk('rank'));
  const asChoice = web.specFromToolArgs(mk('choice'));
  check('kind "rank" is accepted', asRank.ok, true);
  check('kind "rank" builds exactly the choice spec', asRank, asChoice);
  check('lockstep: the server builds the same rank spec', server.specFromToolArgs(mk('rank')), asRank);
  check(
    'the built question is a choice over the given shortlist',
    Object.keys(asRank.value.answer.criteria),
    ['hit_1', 'hit_2', 'hit_3'],
  );
  check('kind "rank" needs options, exactly as choice does', web.specFromToolArgs({ kind: 'rank', question: 'x' }).ok, false);
  check(
    'an unknown kind still names every legal one',
    web.specFromToolArgs({ kind: 'likert', question: 'x' }).error,
    'kind must be one of: noul, choice, score, rank',
  );
}

// The capability must expose the reader, and must NOT have grown the catalog:
// extra global capabilities eat the per-page tool budget (see 0.3.28).
assert('the jev capability offers an optional rank switch to Jarvis', /name: 'rank',\s*\n\s*type: 'boolean'/.test(capSrc));
assert('the capability derives a ranking from the decision', /rankAnswers\(parsed\.value, reply\.answers\)/.test(capSrc));
check(
  'the reranker added no capability — the global count is unchanged',
  ui.allCapabilities().filter((c) => c.page === ui.GLOBAL_PAGE).length,
  8,
);

// The invariant behind the 0.3.28 bug, stated as a test rather than a comment:
// the reserve is taken out BEFORE page actions, so every page must still be
// handed all of its own actions, and the list must still fit MAX_TOOLS.
for (const pid of ui.listPages().map((p) => p.id)) {
  const handed = ui.selectTools(pid).map((s) => s.function.name);
  const own = ui.capabilitiesForPage(pid).map((c) => ui.toWireName(c.name));
  const missing = own.filter((n) => !handed.includes(n));
  assert(`no page loses its own action to the reserve on '${pid}'`, missing.length === 0, missing.join(', '));
  assert(`the tool list stays within the cap on '${pid}'`, handed.length <= 12, String(handed.length));
}

console.log(fail ? `\n${fail} FAILURE(S) of ${total}` : `\nALL PASS (${total} assertions)`);
process.exit(fail ? 1 : 0);