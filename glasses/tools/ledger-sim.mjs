// Verifies the LEDGER and the EFFECT CLASSIFICATION, by bundling the real
// sources (no re-implementations) and asserting every rule the module claims.
//
// Run: node tools/ledger-sim.mjs
//
// What this is for: the ledger is now the substrate for context, tracing, human
// gates and undo, and the effect classes are what keep an irreversible action
// from running unapproved. Both are cheap to get subtly wrong and impossible to
// notice by eye, so each invariant below is asserted directly — including the
// negative cases, so the checks can actually FAIL rather than merely pass.
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'ledger-sim-'));

const buildOne = async (entry, name) => {
  const outfile = join(out, `${name}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    // `stream.ts` reads import.meta.env for the relay URLs; a plain object keeps
    // it on the same-origin default rather than needing a real Vite env.
    define: { 'import.meta.env': '{}' },
  });
  return import(pathToFileURL(outfile).href);
};

const L = await buildOne('src/ai/ledger.ts', 'ledger');
const T = await buildOne('src/ai/types.ts', 'types');
const S = await buildOne('src/stream.ts', 'stream');

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

// ── 1. Append-only, sequenced, bounded ──────────────────────────────────────
L.resetLedger();
check('a reset ledger is empty', L.ledgerSize(), 0);
L.ledgerBegin('r1');
const a1 = L.ledgerAppend({ kind: 'ask', by: 'wearer', text: 'add milk' });
const a2 = L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'todo.add', effect: 'write' });
const a3 = L.ledgerAppend({ kind: 'result', by: 'jarvis', text: 'Added milk', effect: 'write' });
check('seq is monotonic from 1', [a1.seq, a2.seq, a3.seq], [1, 2, 3]);
check('entries are attributed to the current run', L.ledgerRunId(), 'r1');
check('ledgerRun scopes by run', L.ledgerRun('r1').length, 3);
check('an unknown run reads empty', L.ledgerRun('nope'), []);
check('kind/by/effect/status defaults', [a1.kind, a1.by, a1.effect, a1.status], ['ask', 'wearer', 'pure', 'ok']);
check('refs defaults to empty', a1.refs, []);

// APPEND-ONLY: a reader holding a snapshot must never see it change underneath.
const held = L.ledgerSnapshot();
const heldLen = held.length;
L.ledgerAppend({ kind: 'note', by: 'jarvis', text: 'thinking' });
check('appending does not mutate a held snapshot', held.length, heldLen);
check('…but the snapshot is refreshed for the next reader', L.ledgerSnapshot().length, 4);

// Snapshot identity is cached, which is what makes useSyncExternalStore safe:
// a render that re-reads between writes must get the SAME array, or React loops.
const s1 = L.ledgerSnapshot();
check('snapshot identity is stable between writes', L.ledgerSnapshot(), s1);
L.ledgerAppend({ kind: 'note', by: 'jarvis', text: 'more' });
const s3 = L.ledgerSnapshot();
assert('…and a new identity after a write', s3 !== s1);
check('…reflecting the new entry', s3.length, s1.length + 1);

// Subscribers.
let fired = 0;
const unsub = L.subscribeLedger(() => {
  fired++;
});
L.ledgerAppend({ kind: 'note', by: 'jarvis', text: 'sub' });
check('a subscriber is notified on append', fired, 1);
unsub();
L.ledgerAppend({ kind: 'note', by: 'jarvis', text: 'sub2' });
check('…and stops after unsubscribe', fired, 1);

// Text hygiene: the firmware font has no emoji glyph, and an unsupported code
// point costs bytes while drawing as an empty box.
const dirty = L.ledgerAppend({
  kind: 'note',
  by: 'jarvis',
  text: '  📅  Added\t two\nlines  ',
});
check('emoji are stripped, whitespace collapsed, trimmed', dirty.text, 'Added two lines');
assert('ledger text is printable ASCII', /^[\x20-\x7E]*$/.test(dirty.text), dirty.text);
const long = L.ledgerAppend({ kind: 'note', by: 'jarvis', text: 'x'.repeat(500) });
check('ledger text is capped', long.text.length, 120);

// Bounded, and the retained window is the NEWEST entries.
L.resetLedger();
L.ledgerBegin('rbound');
for (let i = 0; i < 450; i++) L.ledgerAppend({ kind: 'note', by: 'jarvis', text: `n${i}` });
check('the ledger is bounded', L.ledgerSize(), 400);
check('…keeping the newest 400', L.ledgerEntries()[0].seq, 51);
check('…and the very last entry', L.ledgerEntries().at(-1).text, 'n449');
check('ledgerLast returns an oldest-first tail', L.ledgerLast(3).map((e) => e.text), ['n447', 'n448', 'n449']);

L.resetLedger();
L.ledgerBegin('r2');
const afterReset = L.ledgerAppend({ kind: 'ask', by: 'wearer', text: 'hi' });
check('reset clears the sequence counter too', afterReset.seq, 1);

// ── 2. The safety invariant ─────────────────────────────────────────────────
check('effect order', L.EFFECT_ORDER, ['pure', 'read', 'write', 'irreversible']);
check('only irreversible needs a gate', L.EFFECT_ORDER.map((e) => L.needsGate(e)), [false, false, false, true]);
check('atLeast ordering', [
  L.atLeast('write', 'read'),
  L.atLeast('read', 'write'),
  L.atLeast('write', 'write'),
  L.atLeast('irreversible', 'write'),
], [true, false, true, true]);

// POSITIVE CONTROL: the check must be able to fail. If `ungatedIrreversible`
// returned [] unconditionally the feature would be decorative, so we first
// prove it reports a real violation.
L.resetLedger();
L.ledgerBegin('rungated');
const wrecked = L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'docs.delete', effect: 'irreversible', status: 'ok' });
check('an unapproved irreversible success IS reported', L.ungatedIrreversible().length, 1);
check('…and it is the entry we made', L.ungatedIrreversible()[0].seq, wrecked.seq);

// A PENDING gate is a proposal, not an approval. This is the point of the whole
// mechanism, so it gets its own assertion.
L.resetLedger();
L.ledgerBegin('rpending');
L.ledgerAppend({ kind: 'gate', by: 'jarvis', text: 'Delete 3 docs?', effect: 'irreversible', status: 'pending' });
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'docs.delete', effect: 'irreversible', status: 'ok' });
check('a pending gate does NOT approve', L.ungatedIrreversible().length, 1);

// An approved one does — and the approval must be resolve-able, not just
// appended-and-silently-ok (that is the difference `ledgerResolve` encodes).
L.resetLedger();
L.ledgerBegin('rok');
const gate = L.ledgerAppend({ kind: 'gate', by: 'jarvis', text: 'Delete 3 docs?', effect: 'irreversible', status: 'pending' });
L.ledgerResolve(gate.seq, 'ok');
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'docs.delete', effect: 'irreversible', status: 'ok' });
check('an approved gate clears the violation', L.ungatedIrreversible(), []);
// The approval must not report ITSELF. It inherits effect:irreversible from the
// prompt it answers and carries status:ok, so a naive filter flags it and the
// invariant becomes non-empty on every *correct* run — which is how a safety
// check quietly becomes noise. Found by this harness.
check('the approval is not itself a violation', L.ungatedIrreversible().filter((e) => e.kind === 'gate'), []);
check('the approval is a new entry, not an edit', L.ledgerRun('rok').filter((e) => e.kind === 'gate').length, 2);
check('…and it points back at the prompt', L.ledgerRun('rok').at(-2).refs, [gate.seq]);
check('a resolved gate keeps its origin text', L.ledgerRun('rok').at(-2).text, 'Delete 3 docs?');

// A DECLINED irreversible attempt is not a violation — nothing happened.
L.resetLedger();
L.ledgerBegin('rdeclined');
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'docs.delete', effect: 'irreversible', status: 'declined' });
check('a declined irreversible action is not a violation', L.ungatedIrreversible(), []);

// A UNDOABLE write is deliberately NOT gated: gating it would train the wearer
// to approve without reading, which is how a gate that matters gets ignored.
L.resetLedger();
L.ledgerBegin('rwrite');
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'notes.append', effect: 'write', status: 'ok' });
check('an ungated write is fine by design', L.ungatedIrreversible(), []);

// Gates do not leak across runs.
L.resetLedger();
L.ledgerBegin('g1');
const crossGate = L.ledgerAppend({ kind: 'gate', by: 'jarvis', text: 'ok?', status: 'pending' });
L.ledgerResolve(crossGate.seq, 'ok');
L.ledgerBegin('g2');
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'docs.delete', effect: 'irreversible', status: 'ok' });
check('a gate in another run does not approve this one', L.ungatedIrreversible().length, 1);
check('isGated is scoped per run', [L.isGated('g1', 999), L.isGated('g2', 999)], [true, false]);

// A gate must PRECEDE the action it authorises; a later approval cannot
// retroactively bless what already ran.
L.resetLedger();
L.ledgerBegin('rlate');
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'docs.delete', effect: 'irreversible', status: 'ok' });
L.ledgerAppend({ kind: 'gate', by: 'jarvis', text: 'ok?', status: 'ok' });
check('a LATER gate does not retroactively approve', L.ungatedIrreversible().length, 1);

// ── 3. Projections ──────────────────────────────────────────────────────────
L.resetLedger();
L.ledgerBegin('rp');
L.ledgerAppend({ kind: 'ask', by: 'wearer', text: 'summarise my notes' });
L.ledgerAppend({ kind: 'delta', by: 'wearer', text: 'in French' });
L.ledgerAppend({ kind: 'delta', by: 'wearer', text: 'keep it under 5 lines' });
L.ledgerAppend({ kind: 'result', by: 'jarvis', text: 'Found 12 notes', effect: 'read', status: 'ok' });
L.ledgerAppend({ kind: 'decision', by: 'jev', text: 'route=notes p=0.81', effect: 'pure', status: 'ok' });
L.ledgerAppend({ kind: 'result', by: 'jarvis', text: 'this one failed', status: 'failed' });
L.ledgerAppend({ kind: 'note', by: 'jarvis', text: 'a private thought' });
check('ledgerDeltas reads only deltas', L.ledgerDeltas('rp'), ['in French', 'keep it under 5 lines']);
check('deltaBlock joins them for a system message', L.deltaBlock('rp'), 'in French; keep it under 5 lines');
check('a run with no deltas has no block', L.deltaBlock('rnone'), '');

const material = L.ledgerMaterial('rp');
assert('ledgerMaterial takes results and decisions', material.includes('Found 12 notes') && material.includes('route=notes'), material);
assert('…only the successful ones', !material.includes('this one failed'));
assert('…and not private notes', !material.includes('private thought'));
const clipped = L.ledgerMaterial('rp', 10);
check('ledgerMaterial clips to the TAIL of the budget', clipped, material.slice(-10));

L.resetLedger();
L.ledgerBegin('rt');
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'ok step' });
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'bad step', status: 'failed' });
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'no step', status: 'declined' });
L.ledgerAppend({ kind: 'call', by: 'jarvis', text: 'maybe step', status: 'pending' });
check('ledgerTrace marks each outcome', L.ledgerTrace('rt'), ['> ok step', '! bad step', 'x no step', '? maybe step']);
check('ledgerTrace is bounded', L.ledgerTrace('rt', 2), ['x no step', '? maybe step']);
assert('ledgerTrace is ASCII-only', L.ledgerTrace('rt').every((l) => /^[\x20-\x7E]*$/.test(l)));

// A proposal from an agent nobody is watching: pending, client-side, and not a
// read. Those are the entries the next connected client has to pick up.
L.resetLedger();
L.ledgerBegin('rpend');
L.ledgerAppend({ kind: 'call', by: 'agent', text: 'todo.add', effect: 'write', status: 'pending', locus: 'client' });
L.ledgerAppend({ kind: 'call', by: 'agent', text: 'nav.list', effect: 'read', status: 'pending', locus: 'client' });
L.ledgerAppend({ kind: 'call', by: 'agent', text: 'notes.set', effect: 'write', status: 'pending', locus: 'relay' });
L.ledgerAppend({ kind: 'call', by: 'agent', text: 'todo.add', effect: 'write', status: 'ok', locus: 'client' });
check('pendingEntries is pending + client + not-a-read', L.pendingEntries().map((e) => e.text), ['todo.add']);
check('…and scopes by run', L.pendingEntries('other'), []);

// `ledgerResolve` on an unknown seq is a no-op, not a crash.
check('resolving an unknown seq returns undefined', L.ledgerResolve(99999, 'ok'), undefined);

// ── 4. Effect classification (the fallback that protects old tools) ─────────
check('a bare capability reads as "read"', T.effectOf({}), 'read');
check('confirm:true without a class is irreversible', T.effectOf({ confirm: true }), 'irreversible');
check('an explicit class wins', T.effectOf({ confirm: true, effect: 'write' }), 'write');
check('pure is preserved', T.effectOf({ effect: 'pure' }), 'pure');
check('read is preserved', T.effectOf({ effect: 'read' }), 'read');

// The two rules must compose: whatever a capability declares, "asks first" can
// never disagree with the gate the ledger will enforce.
const asksFirst = (cap) => Boolean(cap.confirm) || L.needsGate(T.effectOf(cap));
for (const cap of [
  { effect: 'irreversible' },
  { confirm: true },
  { effect: 'write' },
  { effect: 'read' },
  {},
]) {
  const gate = L.needsGate(T.effectOf(cap));
  assert(
    `asks-first and gated agree for ${JSON.stringify(cap)}`,
    !gate || asksFirst(cap),
  );
}

// ── 5. The declared classes match the real capability sources ───────────────
// Parsed rather than imported: the capability modules pull in the stores, the
// SDK and the DOM, and a regex over the declarations is enough to catch the
// failure that matters — a class that is present but contradicts its confirm
// flag. The minimum count guards the regex itself: if the shape changes so much
// that nothing matches, this fails loudly instead of silently passing zero.
const capDir = 'src/ai/capabilities';
const declared = [];
for (const file of readdirSync(capDir).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(capDir, file), 'utf8');
  // Each registration begins with `    name: 'page.action',`; splitting on that
  // boundary gives one chunk per capability, so an `effect:` can be attributed
  // to the capability it is declared on rather than to the file.
  for (const part of src.split(/(?=\n {4}name: ')/)) {
    const nm = part.match(/^\s*name:\s*'([a-z]+\.[a-z_]+)'/);
    if (!nm) continue;
    const eff = part.match(/\beffect:\s*'(\w+)'/);
    declared.push({
      file,
      name: nm[1],
      effect: eff ? eff[1] : null,
      confirm: /\bconfirm:\s*true\b/.test(part),
    });
  }
}
assert('the capability scan found the registry', declared.length >= 30, `${declared.length} capabilities`);
const irreversibles = declared.filter((d) => d.effect === 'irreversible');
assert('irreversible capabilities were found', irreversibles.length >= 6, irreversibles.map((d) => d.name).join(', '));
check('every declared class is a real one', declared.filter((d) => d.effect && !L.EFFECT_ORDER.includes(d.effect)).map((d) => `${d.name}=${d.effect}`), []);

// A confirm on a read is a contradiction: confirm exists specifically to gate
// damage, so asking to confirm something with no effect is a bug in the table.
const contradictory = declared.filter(
  (d) => d.confirm && (d.effect === 'read' || d.effect === 'pure'),
);
check('nothing asks to confirm a harmless action', contradictory.map((d) => `${d.name}=${d.effect}`), []);

// Every irreversible capability must be gated, whatever its confirm flag says.
const ungated = irreversibles.filter((d) => !asksFirst({ effect: 'irreversible', confirm: d.confirm }));
check('every irreversible capability asks first', ungated.map((d) => d.name), []);

// ── 6. The delta wire: the client sends nothing new unless it means to ──────
// This is the promise the whole "an agent keeps its saved task" feature rests
// on: a caller that passes neither new field must produce the exact request it
// produced before those fields existed.
const captured = [];
globalThis.fetch = async (url, init) => {
  captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, runId: 'run-1' }),
  };
};

await S.startRun({
  agent: { id: 'a', name: 'A', systemPrompt: 'S' },
  tools: [],
  prompt: 'p',
  model: 'm',
});
check('an unchanged caller sends exactly the old keys', Object.keys(captured[0].body), ['agent', 'tools', 'prompt', 'model']);

await S.startRun({
  agent: { id: 'a', name: 'A', systemPrompt: 'S' },
  tools: [],
  prompt: 'p',
  savedPrompt: undefined,
  instructions: undefined,
  model: 'm',
});
check('…and undefined new fields are dropped, not sent as null', Object.keys(captured[1].body), ['agent', 'tools', 'prompt', 'model']);

await S.startRun({
  agent: { id: 'a', name: 'A', systemPrompt: 'S' },
  tools: [],
  prompt: 'p',
  savedPrompt: 'the saved task',
  instructions: 'in French',
  model: 'm',
});
check('a caller that means it sends both', captured[2].body.savedPrompt, 'the saved task');
check('…to the agent-run route', captured[2].url.endsWith('/api/agent/run'), true);

// ── 7. The relay half of the wire: byte-identity in the assembled messages ──
// `local-sse.mjs` boots a server on import, so the assembly lives in
// `web/server/wire.mjs` purely so this can be asserted for real.
const { assembleWire } = await import(
  pathToFileURL(join(process.cwd(), '..', 'web', 'server', 'wire.mjs')).href
);
const NOW = new Date('2026-01-02T03:04:05Z');
const base = assembleWire({ systemPrompt: 'You are a summariser.' }, 'summarise this', NOW);

// The pre-existing construction, reproduced literally. If `assembleWire` ever
// stops being byte-identical to this, the assertion below fails.
const { withDateTime } = await import(
  pathToFileURL(join(process.cwd(), '..', 'web', 'server', 'datetime.mjs')).href
);
const legacy = [
  { role: 'system', content: withDateTime('You are a summariser.', NOW) },
  { role: 'user', content: 'summarise this' },
];
check('no saved task and no directive is byte-identical to before', base, legacy);

check(
  'an empty-string saved task is treated as absent',
  assembleWire({ systemPrompt: 'S', savedPrompt: '', instructions: '' }, 'ask', NOW)[1].content,
  'ask',
);
check(
  'a missing system prompt still falls back',
  assembleWire({}, 'ask', NOW)[0].content,
  withDateTime('You are a helpful assistant.', NOW),
);
const withSaved = assembleWire({ systemPrompt: 'S', savedPrompt: 'the saved task' }, 'the ask', NOW);
check('the saved task precedes the ask as material', withSaved[1].content, 'the saved task\n\nthe ask');
assert('…and the ask is still the last thing read', withSaved[1].content.endsWith('the ask'));
const withDir = assembleWire({ systemPrompt: 'S', instructions: 'in French' }, 'the ask', NOW);
assert('a directive is APPENDED to the card, never replacing it', withDir[0].content.startsWith(withDateTime('S', NOW)));
assert('…and is labelled as an addition', withDir[0].content.includes('does not replace it') && withDir[0].content.endsWith('in French'));
check('an unset system prompt is not overwritten by a directive', assembleWire({ instructions: 'x' }, 'a', NOW)[1].content, 'a');
const both = assembleWire({ systemPrompt: 'S', savedPrompt: 'saved', instructions: 'dir' }, 'ask', NOW);
check('both fields go where they belong', [both[0].content.endsWith('dir'), both[1].content], [true, 'saved\n\nask']);
check('never more than one system + one user message', both.map((m) => m.role), ['system', 'user']);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
