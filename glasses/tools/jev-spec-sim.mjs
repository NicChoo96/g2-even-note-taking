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

assert('ToolKind admits the jev kind', /'tavily' \| 'http' \| 'jev'/.test(typesSrc));
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
export { capabilityByName, toToolSchema, toWireName, callAction } from './ai/registry.ts';
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
check('both arguments are required', schema.function.parameters.required, ['state', 'questions']);
check(
  'both arguments are strings (jev needs a JSON-encoded question set)',
  Object.values(schema.function.parameters.properties).map((p) => p.type),
  ['string', 'string'],
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

globalThis.fetch = realFetch;

console.log(fail ? `\n${fail} FAILURE(S) of ${total}` : `\nALL PASS (${total} assertions)`);
process.exit(fail ? 1 : 0);