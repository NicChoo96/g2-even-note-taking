// Verifies the EXPOSURE POLICY: that an agent's own words and the tools it can
// reach are compared at all, by bundling the real source (no re-implementation).
//
// Run: node tools/exposure-sim.mjs
//
// WHY THIS EXISTS:
//   The bug behind it is a DATA failure that reads as a MODEL failure. An agent's
//   prompt promises "run 4 to 6 web searches", the agent holds no web tool, the
//   run starts, and the model is told to search with nothing to search with — so
//   it skips the step and the transcript looks like the model declined. Nothing in
//   the app could notice, because nothing compared the two lists.
//
//   The policy is a detector, and a detector is exactly the kind of code that
//   passes review and then quietly stops working: widen a seed's vocabulary and
//   every mention becomes a promise; tighten a commit rule and every promise
//   disappears. Both failures look like "no gaps found", which is the answer that
//   means the feature is OFF. So every rule below is asserted in BOTH directions —
//   the phrase that must be caught, and the near-miss that must not — and the
//   fixtures are the phrasings the gap report actually describes.
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'exposure-sim-'));
const outfile = join(out, 'exposure.mjs');
await build({
  entryPoints: ['src/ai/exposure.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  define: { 'import.meta.env': '{}' },
});
const X = await import(pathToFileURL(outfile).href);

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`,
  );
};
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

// ── The real seed table, read out of the capability module ──────────────────
// Sliced rather than imported: capabilities/agents.ts pulls in the agents store,
// the stream client and the hub client, none of which a pure policy module should
// need — and importing them would make this harness test the wiring instead of
// the rules. The block boundaries are the `};` that ends each seed, so a doc
// comment moved above a seed cannot be mistaken for its body.
const capSrc = readFileSync(new URL('../src/ai/capabilities/agents.ts', import.meta.url), 'utf8');
const seedBlock = (name) => {
  const start = capSrc.indexOf(`const ${name}: SeedTool = {`);
  if (start < 0) return '';
  return capSrc.slice(start, capSrc.indexOf('};', start) + 2);
};
const SEEDS = [
  'AGENT_SEED',
  'WEB_SEED',
  'TODO_SEED',
  'DOCS_SEED',
  'NOTES_SEED',
  'LOCATION_SEED',
  'FILES_SEED',
  'JEV_SEED',
].map(
  (name) => {
    const block = seedBlock(name);
    const kind = (/kind:\s*'([a-z]+)'/.exec(block) ?? [])[1];
    const m = /words:\s*(\/[\s\S]*?\/[a-z]*)/.exec(block);
    let words = null;
    if (m) {
      const last = m[1].lastIndexOf('/');
      words = new RegExp(m[1].slice(1, last), m[1].slice(last + 1));
    }
    return { name, kind, words, source: m ? m[1] : '' };
  },
);

const missingBlock = SEEDS.filter((s) => !s.kind || !s.words);
check('every seed block was found and parsed', missingBlock.map((s) => s.name), []);
check('…and there are eight of them', SEEDS.length, 8);

const RULES = X.promiseRules(SEEDS);

// ── 1. Coverage: one rule per seed kind, and it cannot drift ────────────────
// This is the enforcement mechanism, not a smoke test. A new tool kind arrives as
// a new seed; promiseRules derives its rule FROM that seed, so the kind is
// covered on the day it exists — and the assertions below fail if anyone replaces
// that derivation with a second, hand-maintained list.
check('a rule per seed', RULES.length, SEEDS.length);
check('rule kinds in seed order', RULES.map((r) => r.kind), SEEDS.map((s) => s.kind));
assert('an empty seed table yields no rules', X.promiseRules([]).length === 0);

// The vocabulary is BORROWED. For a kind with no override, the rule's names ARE
// the seed's words — same source string, not a regex that happens to look alike.
const BORROWED = ['jev', 'todo', 'docs', 'notes'];
check(
  'un-overridden kinds borrow the seed vocabulary verbatim',
  BORROWED.map((kind) => {
    const seed = SEEDS.find((s) => s.kind === kind);
    const rule = RULES.find((r) => r.kind === kind);
    return rule.names.source === seed.words.source;
  }),
  [true, true, true, true],
);
// And the overrides are a NAMED, FINITE set. Pinned exactly, because an override
// is a claim that speech and prose disagree, and a fifth one added in passing is
// the beginning of a second vocabulary.
check(
  'exactly the four kinds whose prose differs from speech are overridden',
  RULES.filter((r) => r.names.source !== SEEDS.find((s) => s.kind === r.kind).words.source).map((r) => r.kind).sort(),
  ['agent', 'files', 'location', 'web'],
);
assert(
  'every rule says where its reading came from',
  RULES.every((r) => typeof r.why === 'string' && r.why.length > 10),
);
// The check above compares VOCABULARIES, so a kind that overrides only its
// commitment verbs is invisible to it — and the agent kind is exactly that shape.
// `notes` is the witness that has no override at all, so its commitment rule IS
// the borrowed one; anything differing from it is overridden. One kind, pinned,
// for the same reason as above: this is a claim, not a default.
const baseCommit = RULES.find((r) => r.kind === 'notes').commit.source;
check(
  'only the agent kind needs its own commitment verbs',
  RULES.filter((r) => r.commit.source !== baseCommit).map((r) => r.kind).sort(),
  ['agent'],
);
// The claim is not "the agent rule contains a word" — it is that the borrowed
// verbs CANNOT read an orchestrator's instructions while the agent rule's own can.
// Tested as behaviour, on the phrasings the bug report uses, because a substring
// check would pass on a rule that names the verb and never matches it.
const baseCommitRe = RULES.find((r) => r.kind === 'notes').commit;
const agentCommit = RULES.find((r) => r.kind === 'agent').commit;
const ORCHESTRATOR_PHRASINGS = [
  'Ask each of the six daily agents for their report.',
  'Gather what the agents return.',
  'Compile the agents\u2019 answers into one page.',
];
check(
  'the borrowed commitment verbs cannot read an orchestrator\u2019s instructions',
  ORCHESTRATOR_PHRASINGS.map((s) => baseCommitRe.test(s)),
  [false, false, false],
);
check(
  '  ...and the agent kind\u2019s own verbs can',
  ORCHESTRATOR_PHRASINGS.map((s) => agentCommit.test(s)),
  [true, true, true],
);

// ── 2. What a rule does with a sentence ────────────────────────────────────
const read = (text) => X.readExposure(text, RULES);
const promised = (text) => read(text).promised.map((f) => f.kind).sort();
const refused = (text) => read(text).withdrawn.map((f) => f.kind).sort();

// POSITIVE CONTROLS FIRST: the detector has to be able to say yes, or every
// "must not" below would pass on a module that returns nothing at all.
check('"Run 4 to 6 web searches" promises web', promised('Run 4 to 6 web searches and synthesise.'), ['web']);
check(
  "the report's limit phrasing is a promise, not a denial",
  promised('You may only web search up to 6 times max.'),
  ['web'],
);
check("today's headlines promise web", promised("Find today's gaming headlines."), ['web']);
check(
  'searching for news promises web',
  promised('Search the news for model releases and pricing.'),
  ['web'],
);
check('a to-do instruction promises todo', promised('Add each finding to my to-do list.'), ['todo']);
check('publishing a report promises the gateway', promised('Publish the report when the run finishes.'), ['files']);
check('storing output promises the gateway', promised('Store the finished page so I can open it later.'), ['files']);
check('a decision promises jev', promised('Use jev to score each candidate.'), ['jev']);
check('a third-person run prompt can promise location', promised('Find places near a location the wearer gives you.'), ['location']);
check('the scratchpad promises notes', promised('Write it to the scratchpad.'), ['notes']);

// ── 3. The withdrawal guard — the half that must not over-reach ─────────────
// THE CASE FROM THE REPORT: AI Model Tracker's own prompt tells the model it has
// no Docs or Files tools and must never claim to have saved anything. Whatever the
// mechanism, the outcome is what matters — nothing in that sentence may be read
// as a request for the tools it denies.
const tracker =
  'You have no Docs or Files tools and must never claim to have saved anything.';
check('the denying prompt promises neither docs nor files', promised(tracker), []);
check('a plain denial of web is a withdrawal', refused('You have no internet access.'), ['web']);
check('denying the gateway is a withdrawal', refused('Never publish to the document store.'), ['files']);
check('a denial with a promise in the other clause keeps the promise', promised('Do not publish anything else, but do save the report.'), ['files']);

// THE CLAUSE RULE. A negation governs its own clause, so an instruction to retry
// must not read as a refusal to search.
check(
  'a negator in a previous clause does not withdraw',
  { promised: promised('If the results do not cover the question, run another search.'), refused: refused('If the results do not cover the question, run another search.') },
  { promised: ['web'], refused: [] },
);
// THE IDIOM. "Do not forget to X" is an instruction to do X, and it is a very
// common way to write these prompts.
check(
  '"do not forget to" is an instruction, not a denial',
  { promised: promised('Do not forget to search the web before answering.'), refused: refused('Do not forget to search the web before answering.') },
  { promised: ['web'], refused: [] },
);
check(
  '"never hesitate to" is an instruction, not a denial',
  refused('Never hesitate to search the web.'),
  [],
);
// THE SCOPE RULE. A restriction on an act and a statement about capability are
// not the same sentence, and the two failures below are what treating them alike
// costs — one of them silently drops a capability the agent was just told to use,
// the other hands an agent a tool its own prompt says is unavailable.
check(
  'a restriction in one clause does not withdraw a promise in the next',
  promised('Do not publish anything else, but do save the report.'),
  ['files'],
);
check(
  'a capability denial overrules a promise in another clause',
  { promised: promised('Search the web.\nYou have no internet access.'), refused: refused('Search the web.\nYou have no internet access.') },
  { promised: [], refused: ['web'] },
);
// The restriction still disowns what it governs — and it reaches two kinds here,
// because "draft" is in the docs vocabulary and "publish" is in the gateway's.
// That overlap is real: one sentence can promise or disown more than one tool, and
// the kinds are not meant to be mutually exclusive.
check(
  'a local restriction still denies the kind it governs',
  refused('Do not publish the draft.'),
  ['docs', 'files'],
);

// ── 4. The commitment gate ─────────────────────────────────────────────────
// A mention is not a request. Without this, every prompt that says the word
// "documents" or "tasks" would be given the tool that shares its noun.
check('naming a noun is not a commitment', promised('Read the documents you are given and summarise them.'), []);
check('describing the input is not a commitment', promised("Today's tasks are listed below for context."), []);
check('a modal about the output is not a commitment', promised('These reports must be under 300 words.'), []);
check('…but the same noun with an act is', promised('File each report you produce.'), ['files']);

// ── 4b. The orchestrator case ──────────────────────────────────────────────
// THE GAP THIS KIND WAS ADDED FOR. An orchestrator whose prompt instructs it to
// run the other agents and compile what they found, holding no tool that can run
// one — so the run has nothing to compile and re-reads an older page instead. The
// phrasings are the bug report's own ("calls the six daily agents", "reads their
// results", "compiles them into ... a page").
check(
  'running the daily agents promises the agent tool',
  promised('Call the six daily agents, read their results, and compile them into one page.'),
  ['agent'],
);
check(
  '  ...and so does naming them without a verb in the store vocabulary',
  promised('Ask each of the six daily agents what they found, then fold it in.'),
  ['agent'],
);
check(
  'a multi-agent instruction promises the agent tool',
  promised('Orchestrate the other agents and gather what they return.'),
  ['agent'],
);
// THE NEAR-MISS, and the reason this kind carries an override. "Digest" is the
// thing this kind of prompt PRODUCES — the word sits in its own output
// instructions next to a commitment verb, and reading that as a request to run
// other agents would propose a tool to an agent that already is one. A proposal
// the wearer declines is worse than no proposal: it teaches them to decline.
check(
  'describing your own digest is not a promise',
  promised('Send the digest as plain text under 200 words.'),
  [],
);
check(
  'a digest of headlines is a web promise, not an agent one',
  promised('Search the news and write a headline digest.'),
  ['web'],
);
check(
  'naming a person is not naming an agent',
  promised('The agentic era of assistants is the subject.'),
  [],
);

// ── 5. "No tools at all" ───────────────────────────────────────────────────
check('a toolless agent is recognised', read('You have no tools, work from the prompt alone.').toolless, true);
// POSITIVE CONTROL: this is the same shape as the report's sentence, and reading
// it as toolless would withdraw all eight kinds from an agent that only lacks two.
check('a denial of TWO kinds is not a toolless agent', read(tracker).toolless, false);

// ── 6. Assembling the gap ──────────────────────────────────────────────────
const agent = (over = {}) => ({
  id: 'a1',
  name: 'AI Model Tracker',
  systemPrompt: 'Run 4 to 6 web searches about model releases.',
  prompt: '',
  toolIds: [],
  ...over,
});
const tool = (id, kind) => ({ id, name: `${kind}_tool`, kind, description: '' });
const gaps = (agents, tools = []) => X.exposureGaps({ agents, tools }, RULES);

check('a promised tool that is absent is a gap', gaps([agent()]).map((g) => [g.agentId, g.missing]), [['a1', ['web']]]);
check('an agent that already holds it is not a gap', gaps([agent({ toolIds: ['t-web'] })], [tool('t-web', 'web')]), []);
check(
  'a tool id that resolves to another kind is not a gap either',
  gaps([agent({ toolIds: ['t-jev'] })], [tool('t-jev', 'jev')]).map((g) => [g.agentId, g.missing]),
  [['a1', ['web']]],
);
check('an empty prompt is not a gap', gaps([agent({ systemPrompt: '', prompt: '' })]), []);
check('the saved task prompt is read too', gaps([agent({ systemPrompt: '', prompt: 'Search the news for NVDA.' })]).map((g) => g.missing), [['web']]);
check(
  'a toolless agent is left alone',
  gaps([agent({ systemPrompt: 'You have no tools. Run 4 to 6 web searches.' })]),
  [],
);
// A denial beats a promise for the SAME kind, and the refusal is still reported:
// silently dropping it would hide a prompt that contradicts itself.
const conflicted = gaps([agent({ systemPrompt: 'Search the web.\nYou have no internet access.' })]);
check('a denial removes the kind from the gap', conflicted.map((g) => g.missing), [[]]);
check('…and is reported rather than hidden', conflicted.map((g) => g.denied), [['web']]);
check(
  'only the agents with something missing are returned',
  gaps([
    agent({ id: 'a1', systemPrompt: 'Search the web.' }),
    agent({ id: 'a2', systemPrompt: 'Summarise this text.' }),
    agent({ id: 'a3', systemPrompt: 'Add it to my to-do list.' }),
  ]).map((g) => [g.agentId, g.missing]),
  [['a1', ['web']], ['a3', ['todo']]],
);
check('attached kinds are reported for the reviewer', gaps([agent({ toolIds: ['t-web'] })], [tool('t-web', 'web')]), []);
check(
  'attached kinds show up on a gapped agent',
  gaps([agent({ toolIds: ['t-jev'], systemPrompt: 'Use jev to rank, then search the web.' })], [tool('t-jev', 'jev')]).map(
    (g) => [g.attached, g.missing],
  ),
  [[['jev'], ['web']]],
);
check('the deciding sentence is kept as the audit trail', /web searches/.test(gaps([agent()])[0].because.web), true);

// ── 7. The proposal ────────────────────────────────────────────────────────
const gap = gaps([agent()])[0];
const proposal = X.proposalOf(gap);
assert('a gap produces a proposal', Boolean(proposal));
check('the proposal names the kinds to add', proposal.add, ['web']);
assert('the question names the agent', proposal.text.includes('AI Model Tracker'), proposal.text);
assert('the question names the tool', proposal.text.includes('web search'), proposal.text);
assert('the question is speakable', proposal.text.length <= 118, `${proposal.text.length} chars`);
assert('the question is printable ASCII', /^[\x20-\x7E]*$/.test(proposal.text), proposal.text);

// Idempotent by construction: detection runs on EVERY load, so the key has to be
// derived from the gap rather than from the clock or a counter.
check('the key is stable across passes', X.proposalOf(gaps([agent()])[0]).key, proposal.key);
check('the key names the agent and the kinds', proposal.key, 'expose:a1:web');
check(
  'a different kind set is a different key',
  X.proposalOf(gaps([agent({ systemPrompt: 'Search the web. Add it to my to-do list.' })])[0]).key,
  'expose:a1:web+todo',
);
check('nothing missing means nothing to propose', X.proposalOf({ agentId: 'a', agentName: 'A', missing: [], denied: [], because: {}, attached: [] }), null);
const long = X.proposalOf({ ...gap, agentName: 'A very long agent name that goes on and on and on for a while' });
assert('a long name is clipped, not spilled', long.text.length <= 118, `${long.text.length} chars`);
const unicode = X.proposalOf({ ...gap, agentName: 'Caf\u00e9 \u2014 Tr\u00e8s Long' });
assert('a non-ASCII name cannot reach the ledger', /^[\x20-\x7E]*$/.test(unicode.text), unicode.text);
check('kind labels are spoken words, not enum values', ['web', 'files', 'docs', 'notes', 'todo', 'location', 'jev', 'agent'].map((k) => X.kindLabel(k)), [
  'web search',
  'the document store',
  'saved docs',
  'notes',
  'the to-do list',
  'location',
  'the decision tool',
  'another agent',
]);

console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exitCode = fail ? 1 : 0;
