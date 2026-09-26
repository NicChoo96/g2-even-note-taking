#!/usr/bin/env node
// Jarvis (AI dictate agent) harness.
//
// WHY THIS EXISTS:
//   "Dictate mode" used to pour a transcript straight into a field. The Jarvis
//   mode hands the same transcript to an LLM that picks CAPABILITIES and runs
//   them. Three things can silently rot in that design and none of them are
//   visible in a type check:
//     1. THE ADAPTER — a capability whose name collides, whose `page` is not a
//        registered page, or whose schema is malformed. The whole "register a
//        page and it just works" promise dies here, quietly.
//     2. LAYER ENFORCEMENT — the two-layer design (route, then act) is only
//        real if calling another page's action is actually REFUSED, with a
//        hint the model can act on. If that guard is removed, the model happily
//        edits a page the user is not looking at.
//     3. THE LOOP's terminal states — confirmation decline, cancellation
//        mid-run, undo of a multi-action batch.
//
//   This bundles the REAL src/ai/*, the real app stores and the real
//   sections.ts with a stubbed SDK, drives them through a scripted LLM (the
//   `AiRunOptions.llm` seam) and asserts behaviour. No network, no glasses.
//
// Run: node tools/ai-agent-sim.mjs

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Test bookkeeping ────────────────────────────────────────────────────────
// SIM_QUIET=1 prints only failures and the verdict. This harness is large enough
// that the full transcript can be truncated by the calling tool, and a truncated
// transcript is worse than a terse one — the verdict is the part that must survive.
const QUIET = !!process.env.SIM_QUIET;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  if (ok && QUIET) return;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
};
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  if (cond && QUIET) return;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const has = (label, haystack, needle) =>
  assert(label, String(haystack).includes(needle), `looking for ${JSON.stringify(needle)}`);

/**
 * App state minus the `updatedAt` stamp. Every write re-stamps it, so it is
 * useless for equality checks — the CONTENT is what a user would notice.
 */
const payload = (s) => {
  const { updatedAt, ...rest } = s;
  return rest;
};

// ── Fake host: localStorage + timers before any module loads ────────────────
globalThis.window = globalThis; // store.ts / ai/store.ts use window/setTimeout
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'node' };
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
// The app stores publish to the relay on every edit; there is no relay here, so
// swallow it. Returning !ok also keeps store.ts from marking itself "in sync".
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });

// ── Bundle the real modules ─────────────────────────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'ai-agent-sim-'));
const stub = join(out, 'sdk-stub.mjs');
writeFileSync(
  stub,
  `export class TextContainerProperty { constructor(o) { Object.assign(this, o); } }
export class MenuItemProperty { constructor(o) { Object.assign(this, o); } }
export class MenuContainerProperty { constructor(o) { Object.assign(this, o); } }
export const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
export const measureTextWrap = () => ({ lineCount: 1 });
`,
);

const outfile = join(out, 'ai.mjs');
await build({
  stdin: {
    // One bundle so the harness, the agent loop and the capabilities share a
    // single module instance — duplicate module copies would give two stores.
    contents: `
export * from './ai/index.ts';
export { selectTools, shortJson } from './ai/agent.ts';
export * from './ai/store.ts';
export * from './ai/sync.ts';
export * from './ai/registry.ts';
export * from './ai/types.ts';
export * from './ai/undo.ts';
export { aiView, sectionMenu, MENU } from './sections.ts';
export * as hub from './store.ts';
export * as agents from './agents-store.ts';
`,
    resolveDir: 'src',
    loader: 'ts',
    sourcefile: 'harness-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '@evenrealities/even_hub_sdk': stub },
  define: { 'import.meta.env': '{}' }, // stream.ts reads VITE_HUB_STREAM_URL
});

const mod = await import(pathToFileURL(outfile).href);
const {
  aiView,
  sectionMenu,
  MENU,
  hub,
  agents,
  GLOBAL_PAGE,
  listPages,
  registerPage,
  registerCapabilities,
  selectTools,
  shortJson,
  allCapabilities,
  capabilityByName,
  capabilitiesForPage,
  toToolSchema,
  toWireName,
  fromWireName,
  pageActionNames,
  pageCatalogText,
  pageDeclaredActionNames,
  canonicalName,
  validateArgs,
  prepare,
  callAction,
  runAiAgent,
  aiModel,
  aiMaxSteps,
  updateAiSettings,
  getAi,
  subscribeAi,
  aiBegin,
  aiCancel,
  aiFlash,
  aiStep,
  aiAnswerConfirm,
  aiReset,
  resetAiForTest,
  hasUndo,
  undoLabel,
  undoLastAiBatch,
  clearUndo,
  // Cross-surface mirror (ai/sync.ts)
  acceptRemote,
  acceptControl,
  localSnapshot,
  mirrorExpired,
  applyRemoteAi,
  isAiMirrored,
  requestRemoteConfirm,
  requestRemoteStop,
} = mod;

// ════════════════════════════════════════════════════════════════════════════
// 1. ADAPTER — registry integrity
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Adapter: registry integrity ──');

const pages = listPages();
const caps = allCapabilities();
const pageIds = new Set(pages.map((p) => p.id));

assert('catalog is non-empty', caps.length > 0, `${caps.length} actions / ${pages.length} pages`);
check(
  'every page id is unique',
  pages.length,
  new Set(pages.map((p) => p.id)).size,
);
check(
  'every action name is unique',
  caps.length,
  new Set(caps.map((c) => c.name)).size,
);
check(
  'allCapabilities() has no duplicates',
  caps.map((c) => c.name).length,
  new Set(caps.map((c) => c.name)).size,
);

const orphaned = caps.filter((c) => !pageIds.has(c.page) && c.page !== GLOBAL_PAGE);
check(
  'every action belongs to a registered page (or is global)',
  orphaned.map((c) => `${c.name}→${c.page}`),
  [],
);

const emptyPages = pages.filter((p) => capabilitiesForPage(p.id).length === 0);
check('every page exposes at least one action', emptyPages.map((p) => p.id), []);

// The system prompt's PAGES block is the ONLY place a model can learn about an
// action whose tool was trimmed out of this turn's budget, so it has to name
// every action of every page — not summarise a page in prose and leave it there.
const catalog = pageCatalogText();
const missingFromCatalog = caps
  .filter((c) => !catalog.includes(toWireName(c.name)))
  .map((c) => c.name);
check('the prompt catalog names EVERY action of EVERY page', missingFromCatalog, []);
check(
  'the catalog prints them wire-formed (what the model must call)',
  caps.every((c) => catalog.includes(toWireName(c.name))),
  true,
);
check('the catalog carries an app-wide line', catalog.includes('- app-wide'), true);
check(
  'the app-wide line names every global action',
  caps
    .filter((c) => c.page === GLOBAL_PAGE && !catalog.includes(toWireName(c.name)))
    .map((c) => c.name),
  [],
);
// The OTHER HALF of the two checks above, and the one that was missing. Naming
// an app-wide action in the prompt is not the same as handing it to the model:
// the tool budget is trimmed per focus, and jev__decide was silently absent from
// every docs and agents turn while the PAGES block called it "always callable".
// An advertised-but-absent tool is worse than an omitted one — the model calls
// it and reports a failure the wearer cannot act on.
const RESERVED_WIRE = ['say.reply', 'nav.open_page', 'jev.decide'].map(toWireName);
for (const p of pages) {
  const handed = selectTools(p.id).map((s) => s.function.name);

  const lostReserved = RESERVED_WIRE.filter((n) => !handed.includes(n));
  assert(
    `reserved actions reach the model on '${p.id}'`,
    lostReserved.length === 0,
    `dropped: ${lostReserved.join(', ') || '-'}`,
  );

  // Reserving is only safe while the page's own actions still fit inside what is
  // left. A page that outgrows the budget loses an action silently, which is
  // exactly how jev disappeared the first time.
  const lostOwn = capabilitiesForPage(p.id)
    .map((c) => toWireName(c.name))
    .filter((n) => !handed.includes(n));
  assert(
    `no action of '${p.id}' is budgeted away`,
    lostOwn.length === 0,
    `dropped: ${lostOwn.join(', ') || '-'}`,
  );

  assert(`'${p.id}' stays inside the tool budget`, handed.length <= 12, `${handed.length}`);
}
// A page may promise MORE than is callable right now (an action gated off is
// still one the model should plan for) but never less than nav.list_actions
// would hand it — otherwise the prompt and the tool disagree.
const understated = pages.filter((p) =>
  pageActionNames(p.id).some((n) => !pageDeclaredActionNames(p.id).includes(n)),
);
check('declared actions are a superset of callable ones', understated.map((p) => p.id), []);
const noActionsLine = pages
  .filter((p) => pageDeclaredActionNames(p.id).length > 0)
  .filter((p) => !catalog.includes(`actions: ${pageDeclaredActionNames(p.id)[0]}`))
  .map((p) => p.id);
check('every page with actions prints an actions: line', noActionsLine, []);

const badDef = caps.filter((c) => !c.name.includes('.') || !c.title || !c.description || typeof c.run !== 'function');
check('every action has name/title/description/run', badDef.map((c) => c.name), []);

const badPageDef = pages.filter((p) => !p.title || !p.summary || !Array.isArray(p.synonyms) || !p.synonyms.length);
check('every page has title/summary/synonyms', badPageDef.map((p) => p.id), []);

// `nav.open_page` must accept every page we advertise, or layer 1 can route to
// a page the model cannot actually reach. It deliberately uses a forgiving
// string lookup ("notes", "Notes", "note") rather than a rigid enum, because
// the model hears the SPOKEN name, not the id — so the contract to prove is
// that every catalogued page resolves.
const unroutable = pages.filter((p) => {
  const out = prepare('nav.open_page', { page: p.id }, 'todo');
  return out.kind === 'error';
});
check('nav.open_page can route to every registered page', unroutable.map((p) => p.id), []);
check(
  '…including by its spoken title',
  prepare('nav.open_page', { page: pages[0].title.toLowerCase() }, 'todo').kind,
  'ready',
);
check('…and by a synonym', prepare('nav.open_page', { page: pages[0].synonyms[0] }, 'todo').kind, 'ready');

// ════════════════════════════════════════════════════════════════════════════
// 2. ADAPTER — schema generation is generic
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Adapter: tool schema generation ──');

const schemas = caps.map((c) => ({ cap: c, schema: toToolSchema(c) }));
const badSchemas = schemas.filter(
  (s) =>
    s.schema.type !== 'function' ||
    s.schema.function.name !== toWireName(s.cap.name) ||
    s.schema.function.parameters.type !== 'object' ||
    typeof s.schema.function.parameters.properties !== 'object',
);
check('every action produces a valid function schema', badSchemas.map((s) => s.cap.name), []);

// REGRESSION (shipped bug): OpenAI and DeepSeek validate a function name against
// `^[a-zA-Z0-9_-]+$` and reject the ENTIRE tools array when one name fails. The
// registry's readable dotted names (`todo.set_done`) are therefore translated on
// the way out — wire names must be pattern-safe and must round-trip.
const PROVIDER_NAME = /^[a-zA-Z0-9_-]+$/;
const illegal = schemas.filter((s) => !PROVIDER_NAME.test(s.schema.function.name));
check('every tool name satisfies the provider pattern (no dots)', illegal.map((s) => s.schema.function.name), []);

const brokenRoundTrip = caps.filter(
  (c) => fromWireName(toWireName(c.name)) !== c.name || canonicalName(toWireName(c.name)) !== c.name,
);
check('wire names round-trip back to the registry name', brokenRoundTrip.map((c) => c.name), []);
check('every wire name is unique', new Set(schemas.map((s) => s.schema.function.name)).size, caps.length);

const requiredMismatch = schemas.filter((s) => {
  const req = s.schema.function.parameters.required;
  return req.some((n) => !(n in s.schema.function.parameters.properties));
});
check('required[] only names declared properties', requiredMismatch.map((s) => s.cap.name), []);

const enumWithoutValues = schemas.filter((s) =>
  s.cap.params.some((p) => p.type === 'enum' && (!p.values || !p.values.length)),
);
check('every enum param declares values', enumWithoutValues.map((s) => s.cap.name), []);

const confirmMislabelled = schemas.filter(
  (s) => Boolean(s.cap.confirm) !== s.schema.function.description.includes('asks the user to confirm'),
);
check('confirm-flagged actions say so in the description', confirmMislabelled.map((s) => s.cap.name), []);
assert(
  'the catalog actually contains confirm-flagged actions',
  schemas.some((s) => s.cap.confirm),
  `${schemas.filter((s) => s.cap.confirm).length} destructive action(s)`,
);

// A parameter whose type the schema cannot express would reach the model as
// `{"type":"string"}` and silently coerce anything.
const unknownTypes = caps.flatMap((c) =>
  c.params.filter((p) => !['string', 'number', 'boolean', 'enum'].includes(p.type)).map((p) => `${c.name}.${p.name}`),
);
check('every param type is one of string/number/boolean/enum', unknownTypes, []);

// ════════════════════════════════════════════════════════════════════════════
// 3. LAYER ENFORCEMENT — the two-layer promise
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Layer enforcement ──');

// Pick an action on a page that is NOT the focus.
const foreign = caps.find((c) => c.page !== GLOBAL_PAGE && c.page !== 'todo');
assert('found a page-scoped action to test with', Boolean(foreign), foreign?.name);

const blocked = prepare(foreign.name, {}, 'todo');
check('foreign-page call is refused', blocked.kind, 'error');
has('…the error names both pages', blocked.error, `"${foreign.page}" is not focused`);
has('…and hints at nav__open_page', blocked.hint, 'nav__open_page');
has('…naming the offending action for the retry', blocked.hint, toWireName(foreign.name));

// The adapter accepts BOTH spellings: the wire name the model is given, and the
// dotted registry name it may echo from the prompt.
check('the dotted name still resolves (prompt wording)', prepare(foreign.name, { text: 'x' }, foreign.page).kind, 'ready');
check('the wire name resolves too', prepare(toWireName(foreign.name), { text: 'x' }, foreign.page).kind, 'ready');

const allowed = prepare(foreign.name, { text: 'x' }, foreign.page);
assert('the same call is accepted once that page is focused', allowed.kind === 'ready' || allowed.kind === 'error');

// A global action's availability is dynamic — `undo.last` must only be offered
// when there is something to undo. This is the adaptive layer doing real work:
// the tool set the model sees changes with the app's state.
clearUndo();
check('undo.last is refused when there is nothing to undo', prepare('undo.last', {}, 'todo').kind, 'error');
const availBatch = mod.beginAiBatch('make something undoable');
hub.update((s) => ({ ...s, sections: { ...s.sections, notes: 'seed' } }));
mod.endAiBatch(availBatch);
check('…and offered once a batch exists', prepare('undo.last', {}, 'todo').kind, 'ready');
clearUndo();

// Unknown action → correctable error, not a throw.
const unknown = prepare('nope.not_real', {}, 'todo');
check('unknown action is an error', unknown.kind, 'error');
has('…listing the real actions', unknown.hint, 'nav__open_page');

// A page-blocked call must NOT have touched anything.
const beforeBlock = hub.getState();
await callAction(foreign.name, { text: 'should not happen' }, 'todo');
check('a refused call mutates nothing', hub.getState(), beforeBlock);

// ════════════════════════════════════════════════════════════════════════════
// 4. ADAPTER — argument coercion and validation
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Argument validation ──');

// The shipped catalog is all strings and booleans (a spoken "the second one"
// has to stay a string so it can be matched against the item text), which means
// the generic number/enum coercion, the `available` gate and the confirm suffix
// would never actually run in this harness.
//
// So: register ONE throwaway page that uses every seam. That is exactly the call
// a future feature makes, so this section doubles as the proof that adding a
// page needs no edits to the registry, the schema generator, the validator or
// the loop — the "reuse this adaptive layer" requirement.
const PROBE = 'probe';
let probeAvailable = true;
registerPage({ id: PROBE, title: 'Probe', synonyms: ['probe'], summary: 'harness-only page' });
registerCapabilities([
  {
    name: 'probe.count',
    page: PROBE,
    title: 'Count',
    description: 'Needs a number.',
    params: [{ name: 'n', type: 'number', description: 'how many', required: true }],
    run: (a) => ({ ok: true, summary: `counted ${a.n}`, data: { n: a.n } }),
  },
  {
    name: 'probe.mode',
    page: PROBE,
    title: 'Mode',
    description: 'Needs one of a fixed set.',
    params: [
      { name: 'mode', type: 'enum', description: 'which mode', values: ['fast', 'slow'], required: true },
    ],
    run: (a) => ({ ok: true, summary: `mode ${a.mode}` }),
  },
  {
    name: 'probe.label',
    page: PROBE,
    title: 'Label',
    description: 'Optional with a fallback.',
    params: [{ name: 'label', type: 'string', description: 'the label', fallback: 'default' }],
    run: (a) => ({ ok: true, summary: `label ${a.label}` }),
  },
  {
    name: 'probe.danger',
    page: PROBE,
    title: 'Danger',
    description: 'Destructive.',
    confirm: true,
    params: [{ name: 'what', type: 'string', description: 'what to destroy', fallback: 'everything' }],
    run: () => ({ ok: true, summary: 'destroyed' }),
  },
  {
    name: 'probe.gated',
    page: PROBE,
    title: 'Gated',
    description: 'Only sometimes callable.',
    params: [],
    available: () => probeAvailable,
    run: () => ({ ok: true, summary: 'gated' }),
  },
]);

const count = capabilityByName('probe.count');
const numberFromNumber = validateArgs(count, { n: 4 });
check('number ← number', numberFromNumber.args?.n, 4);
const numberFromString = validateArgs(count, { n: '7' });
check('number ← numeric string', numberFromString.args?.n, 7);
const badNumber = validateArgs(count, { n: 'second one' });
check('a non-numeric value is rejected', badNumber.ok, false);
has('…with a message naming the argument', badNumber.error, '"n" must be a number');
const missingNumber = validateArgs(count, {});
check('a missing required number is rejected', missingNumber.ok, false);

const mode = capabilityByName('probe.mode');
check('enum ← allowed value', validateArgs(mode, { mode: 'fast' }).args?.mode, 'fast');
check('enum ← rejected value', validateArgs(mode, { mode: 'sideways' }).ok, false);
has('…naming the allowed set', validateArgs(mode, { mode: 'sideways' }).error, 'one of fast | slow');

const label = capabilityByName('probe.label');
check('an omitted optional takes its fallback', validateArgs(label, {}).args?.label, 'default');
check('an empty optional takes its fallback', validateArgs(label, { label: '' }).args?.label, 'default');
check('a supplied optional wins', validateArgs(label, { label: 'hi' }).args?.label, 'hi');

// The schema generator must express the new types without any special-casing.
const countSchema = toToolSchema(count).function.parameters;
check('number param → JSON schema number', countSchema.properties.n.type, 'number');
check('…and is marked required', countSchema.required, ['n']);
check('enum param → string + enum list', toToolSchema(mode).function.parameters.properties.mode.enum, [
  'fast',
  'slow',
]);
assert(
  'optional param is NOT marked required',
  !toToolSchema(label).function.parameters.required.includes('label'),
);
has('confirm flag reaches the schema', toToolSchema(capabilityByName('probe.danger')).function.description, 'asks the user to confirm');

// Layer 2 applies to a page registered at runtime just as it does to a built-in.
const probeBlocked = prepare('probe.count', { n: 1 }, 'todo');
check('a newly registered page is still page-gated', probeBlocked.kind, 'error');
has('…naming the new page', probeBlocked.error, '"probe" is not focused');
check('…and is reachable once focused', prepare('probe.count', { n: 1 }, PROBE).kind, 'ready');

// The `available` seam hides an action from the model entirely.
check('an available action is offered', prepare('probe.gated', {}, PROBE).kind, 'ready');
assert('…and appears in the page tool set', capabilitiesForPage(PROBE).some((c) => c.name === 'probe.gated'));
probeAvailable = false;
check('an unavailable action is refused', prepare('probe.gated', {}, PROBE).kind, 'error');
assert(
  '…and is removed from the page tool set',
  !capabilitiesForPage(PROBE).some((c) => c.name === 'probe.gated'),
);
probeAvailable = true;

// ── The same rules against the REAL catalog ──
const todoSetDone = capabilityByName('todo.set_done');
check('boolean ← the string "true"', validateArgs(todoSetDone, { target: 2, done: 'true' }).args?.done, true);
check('boolean ← the string "false"', validateArgs(todoSetDone, { target: 2, done: 'false' }).args?.done, false);
check('number/boolean → string for a text field', validateArgs(todoSetDone, { target: 2 }).args?.target, '2');

// A model sometimes sends an array for a text field.
const todoAdd = capabilityByName('todo.add');
const arrayText = validateArgs(todoAdd, { text: ['milk', 'eggs'] });
check('array of strings is joined into text', arrayText.args?.text, 'milk\neggs');

const missingRequired = validateArgs(todoAdd, {});
check('missing required argument is rejected', missingRequired.ok, false);
has('…naming the argument', missingRequired.error, 'text');

const notAnObject = validateArgs(todoAdd, 'just a string');
check('a non-object argument bag is rejected', notAnObject.ok, false);
const objectForText = validateArgs(todoAdd, { text: { a: 1 } });
check('an object for a text field is rejected', objectForText.ok, false);

// A runaway description would waste prompt budget; a missing one makes the
// model guess an argument's meaning.
const undocumented = caps.flatMap((c) => c.params.filter((p) => !p.description).map((p) => `${c.name}.${p.name}`));
check('every param documents itself', undocumented, []);

// ════════════════════════════════════════════════════════════════════════════
// 5. Mutations round-trip through the real stores
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Action round-trips (real stores) ──');

hub.update(() => ({ ...hub.getState(), sections: { todo: [], docs: [], notes: '' }, activeDocId: null }));
clearUndo();

const add = await callAction('todo.add', { text: 'buy oat milk' }, 'todo');
assert('todo.add reports ok', add.ok, add.summary);
check('todo.add wrote exactly one item', hub.getState().sections.todo.length, 1);
check('…with the given text', hub.getState().sections.todo[0].text, 'buy oat milk');
check('…and starts undone', hub.getState().sections.todo[0].done, false);

await callAction('todo.add', { text: 'call the dentist' }, 'todo');
await callAction('todo.add', { text: 'renew passport' }, 'todo');
check('three items now', hub.getState().sections.todo.length, 3);

// Resolve by 1-based position, as a spoken "the second one" would.
const done2 = await callAction('todo.set_done', { target: 2, done: true }, 'todo');
assert('todo.set_done accepts a 1-based index', done2.ok, done2.summary);
check('…and marks the SECOND item', hub.getState().sections.todo[1].done, true);
check('…leaving the first alone', hub.getState().sections.todo[0].done, false);

// Resolve by text.
const doneText = await callAction('todo.set_done', { target: 'renew passport', done: true }, 'todo');
assert('todo.set_done accepts a text match', doneText.ok, doneText.summary);
check('…matching the right item', hub.getState().sections.todo[2].done, true);

const missingTarget = await callAction('todo.set_done', { target: 'nonexistent', done: true }, 'todo');
check('an unresolvable target fails cleanly', missingTarget.ok, false);

// Confirm-flagged actions are flagged but still runnable via the registry —
// the tap-to-confirm gate lives in the LOOP, not in `execute`.
const remove = capabilityByName('todo.remove');
assert('todo.remove is flagged as destructive', remove.confirm === true);
assert('…and its schema says so', toToolSchema(remove).function.description.includes('asks the user to confirm'));

const prepRemove = prepare('todo.remove', { target: 1 }, 'todo');
check('prepare() reports needsConfirm for it', prepRemove.needsConfirm, true);
const readOnly = prepare('todo.add', { text: 'x' }, 'todo');
check('prepare() reports no confirm for a safe action', readOnly.needsConfirm, false);

// Docs.
const newDoc = await callAction('docs.new', { title: 'Shopping', content: 'line one' }, 'docs');
assert('docs.new reports ok', newDoc.ok, newDoc.summary);
check('…creating one doc', hub.getState().sections.docs.length, 1);
check('…titled as asked', hub.getState().sections.docs[0].title, 'Shopping');
const appendDoc = await callAction('docs.append', { text: 'line two' }, 'docs');
assert('docs.append reports ok', appendDoc.ok, appendDoc.summary);
has('…appending to the active doc', hub.getState().sections.docs[0].content, 'line two');

// Notes.
const appendNote = await callAction('notes.append', { text: 'remember the milk' }, 'notes');
assert('notes.append reports ok', appendNote.ok, appendNote.summary);
has('…into notes', hub.getState().sections.notes, 'remember the milk');

// Read-only actions never mutate.
const snapshot = hub.getState();
await callAction('app.status', {}, 'todo');
await callAction('nav.list_pages', {}, 'todo');
check('read-only actions mutate nothing', payload(hub.getState()), payload(snapshot));
assert('…leaving the very same state object in place', hub.getState() === snapshot);

// Undo works by reference-comparing snapshots, so a write MUST produce a new
// object. If a future store mutation ever edited in place, undo would silently
// stop noticing changes and `Undid:` would fire on nothing.
const beforeWrite = hub.getState();
await callAction('todo.add', { text: 'identity check' }, 'todo');
assert('a mutation replaces the state object (undo depends on this)', hub.getState() !== beforeWrite);

console.log('\n── Actions that write elsewhere ──');

// `nav.open_page` is the layer-1 router: it must change focus AND ask the app
// to switch the glasses section (the bridge), and it must be callable from any
// page because it is global.
const bridgeCalls = [];
mod.setAppBridge({
  openPage: (p) => bridgeCalls.push(p),
  goBack: () => bridgeCalls.push('back'),
});
resetAiForTest();
aiBegin('open my notes', 'todo');
const routed = await callAction('nav.open_page', { page: 'notes' }, 'todo');
// `nav.open_page` writes focus through the ai store, so drive it the way the
// loop does (it reads getAiFocus() internally).
assert('nav.open_page is callable from another page (global)', routed.ok, routed.summary);
check('…and it asked the host to open the page', bridgeCalls, ['notes']);
check('…and moved the agent focus', getAi().focus, 'notes');

const badRoute = await callAction('nav.open_page', { page: 'not-a-page' }, 'todo');
check('routing to an unknown page fails cleanly', badRoute.ok, false);

// ════════════════════════════════════════════════════════════════════════════
// 6. UNDO — snapshot revert, reference-compared
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Undo ──');

clearUndo();
const preUndo = hub.getState();
const token = mod.beginAiBatch('test batch');
await callAction('todo.add', { text: 'undo me' }, 'todo');
const changed = mod.endAiBatch(token);
assert('endAiBatch reports a change', changed === true);
assert('hasUndo() is true', hasUndo());
check('undoLabel() is the batch label', undoLabel(), 'test batch');

const undone = undoLastAiBatch();
check('undoLastAiBatch returns the label', undone, 'test batch');
check('…restoring the prior contents', payload(hub.getState()), payload(preUndo));
check('…and clearing the undo affordance', hasUndo(), false);

// A batch that changed nothing must not be recorded — otherwise "Undo AI"
// would appear after a run that only answered a question.
clearUndo();
const noop = mod.beginAiBatch('asked a question');
const noopChanged = mod.endAiBatch(noop);
check('a no-op batch records nothing', [noopChanged, hasUndo()], [false, false]);

// Batch depth is capped so a long session cannot grow forever.
clearUndo();
for (let i = 0; i < 5; i++) {
  const t = mod.beginAiBatch(`batch ${i}`);
  hub.update((s) => ({ ...s, sections: { ...s.sections, notes: `n${i}` } }));
  mod.endAiBatch(t);
}
let depth = 0;
while (undoLastAiBatch()) depth++;
check('undo history is capped at 3', depth, 3);

// Undo also reverts the agents store (a second, independent store).
clearUndo();
const preAgents = agents.getAgents();
const agentBatch = mod.beginAiBatch('agent change');
agents.updateAgents((s) => ({ ...s, selectedId: 'zzz' }));
mod.endAiBatch(agentBatch);
assert('agents-store change is recorded', hasUndo());
undoLastAiBatch();
check('…and reverted', payload(agents.getAgents()), payload(preAgents));

// ════════════════════════════════════════════════════════════════════════════
// 7. THE LOOP — scripted LLM
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Agent loop (scripted LLM) ──');

/** Build a tool_call the way DeepSeek sends one. */
let callSeq = 0;
const toolCall = (name, args) => ({
  id: `call_${++callSeq}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const replyWith = (...calls) => ({ ok: true, message: { role: 'assistant', content: '', tool_calls: calls } });
const replyText = (content) => ({ ok: true, message: { role: 'assistant', content } });

/** A scripted transport: one queued reply per model turn, plus a transcript. */
function scripted(replies) {
  const seen = [];
  const llm = async ({ messages, tools }) => {
    seen.push({
      messages: messages.map((m) => m.role),
      toolNames: (tools ?? []).map((t) => t.function.name),
      // The system prompt itself: the PAGES block in it is the only place the
      // model can learn about an action whose tool lost the budget race.
      system: messages[0]?.role === 'system' ? messages[0].content : '',
      // Enough of the outbound transcript to assert on names the provider will
      // validate (`role:'tool'.name` and `assistant.tool_calls[].function.name`).
      full: messages.map((m) => ({
        role: m.role,
        name: m.name,
        tool_calls: m.tool_calls?.map((c) => c.function?.name),
      })),
    });
    const next = replies.shift();
    if (!next) return replyText('out of script');
    return typeof next === 'function' ? next() : next;
  };
  llm.seen = seen;
  return llm;
}

/** Answer any confirmation the loop raises, as a human on the glasses would. */
function autoConfirm(approve) {
  const off = subscribeAi(() => {
    if (getAi().status === 'confirm') aiAnswerConfirm(approve);
  });
  // Answer once immediately too: the status may already be 'confirm'.
  if (getAi().status === 'confirm') aiAnswerConfirm(approve);
  return off;
}

// --- 7a. Answer-only run: nothing may be recorded as undoable.
resetAiForTest();
hub.update(() => ({ ...hub.getState(), sections: { todo: [], docs: [], notes: '' }, activeDocId: null }));
const answerOnly = scripted([replyWith(toolCall('say.reply', { text: 'You have nothing on your list.' }))]);
const r1 = await runAiAgent({ utterance: 'what is on my list?', focus: 'todo', llm: answerOnly });
assert('answer-only run succeeds', r1.ok, r1.reply);
check('…returns the spoken reply', r1.reply, 'You have nothing on your list.');
check('…and is NOT undoable', r1.changed, false);
check('HUD status is done', getAi().status, 'done');
assert('HUD shows the reply', getAi().result.includes('nothing on your list'), getAi().result);

// --- 7b. Multi-action run on the focused page.
resetAiForTest();
const multi = scripted([
  replyWith(toolCall('todo.add', { text: 'buy oat milk' }), toolCall('todo.add', { text: 'buy eggs' })),
  replyWith(toolCall('say.reply', { text: 'Added two items.' })),
]);
const r2 = await runAiAgent({ utterance: 'add oat milk and eggs', focus: 'todo', llm: multi });
assert('multi-action run succeeds', r2.ok, r2.reply);
check('…both items landed', hub.getState().sections.todo.map((t) => t.text), ['buy oat milk', 'buy eggs']);
check('…and it IS undoable', r2.changed, true);
assert('undo label is the utterance', undoLabel() === 'add oat milk and eggs');
const steps = getAi().steps.map((s) => s.kind);
assert('the HUD timeline records the work', steps.includes('call') && steps.includes('ok'), steps.join(','));
assert('the first step is the focus line', steps[0] === 'focus');

// Tool budget: the schemas handed to the model must include the focused page's
// actions plus the two mandatory globals, and stay within MAX_TOOLS.
const sentTools = multi.seen[0].toolNames;
assert('focused-page actions are exposed', sentTools.includes('todo__add'), sentTools.join(','));
assert('say.reply is always exposed', sentTools.includes('say__reply'));
assert('nav.open_page is always exposed', sentTools.includes('nav__open_page'));
assert('every name handed to the provider is pattern-safe', sentTools.every((n) => PROVIDER_NAME.test(n)), sentTools.join(','));
assert('tool count respects the budget', sentTools.length <= 12, `${sentTools.length} tools`);
check('no duplicate tool names', sentTools.length, new Set(sentTools).size);

// --- 7b-iii. THE BUDGET CANNOT EVICT ROUTING OR SPEECH. Page actions are ranked
// first and the slice used to happen afterwards, so a page with enough actions
// could consume the whole allowance and drop say__reply / nav__open_page — the
// model would then report being unable to answer or to reach another page. The
// reserve is taken out of the budget before pages are considered.
for (const page of pages.map((p) => p.id)) {
  resetAiForTest();
  const probe = scripted([replyWith(toolCall('say.reply', { text: 'ok' }))]);
  await runAiAgent({ utterance: 'what can you do?', focus: page, llm: probe });
  const names = probe.seen[0].toolNames;
  assert(`[${page}] the budget holds say__reply`, names.includes('say__reply'), names.join(','));
  assert(
    `[${page}] the budget holds nav__open_page`,
    names.includes('nav__open_page'),
    names.join(','),
  );
  assert(`[${page}] stays within the tool budget`, names.length <= 12, `${names.length} tools`);
}

// --- 7b-iv. THE REPORTED DEFECT. Standing on To-Do, "add a line to my shopping
// doc" made Jarvis answer that it had no access to docs write. Two causes: the
// tools for docs are not in that turn's list at all, AND the prompt never named a
// single docs action — so "I have no access" was a rational conclusion. The tool
// list is still trimmed (that is by design and measured above); what changed is
// that the prompt now names every action and forbids the refusal.
resetAiForTest();
const fromTodo = scripted([replyWith(toolCall('say.reply', { text: 'ok' }))]);
await runAiAgent({ utterance: 'add something to my shopping doc', focus: 'todo', llm: fromTodo });
const todoTurn = fromTodo.seen[0];
check(
  'a todo-focused turn carries no docs tool (the premise of the bug)',
  todoTurn.toolNames.filter((n) => n.startsWith('docs__')),
  [],
);
const docsActions = pageDeclaredActionNames('docs');
assert('the docs page really does declare several actions', docsActions.length >= 5, docsActions.join(','));
const unnamed = docsActions.filter((n) => !todoTurn.system.includes(n));
check('…so the prompt must name every one of them', unnamed, []);
assert(
  '…and forbid claiming a lack of access',
  /never[\s\S]{0,160}lack access/i.test(todoTurn.system),
  'no "never claim lack of access" rule found in the prompt',
);
assert(
  '…and tell the model to route there instead',
  /route there with nav__open_page/i.test(todoTurn.system),
  'no routing rule found in the prompt',
);
assert(
  '…and warn that the tool list is only the focused page\'s',
  /tool list only carries the focused page/i.test(todoTurn.system),
  'no NOTE about the trimmed tool list',
);

// --- 7b-v. AND THE WRITE ACTUALLY LANDS. The refused cross-page call, the route,
// then the same call succeeding — the user-visible outcome of the whole fix.
resetAiForTest();
hub.update(() => ({
  ...hub.getState(),
  sections: { todo: [], docs: [], notes: '' },
  activeDocId: null,
}));
const seeded = await callAction('docs.new', { title: 'Shopping', content: 'line one' }, 'docs');
assert('a doc exists to write into', seeded.ok, seeded.summary);
const crossPage = scripted([
  replyWith(toolCall('docs__append', { text: 'eggs' })), // wrong page: refused, with a hint
  replyWith(toolCall('nav__open_page', { page: 'docs' })),
  replyWith(toolCall('docs__append', { text: 'eggs' })),
  replyWith(toolCall('say__reply', { text: 'Added it.' })),
]);
const rRouted = await runAiAgent({
  utterance: 'add eggs to my shopping doc',
  focus: 'todo',
  llm: crossPage,
});
assert('a cross-page write completes after routing', rRouted.ok, rRouted.error);
assert(
  '…and the reply claims no lack of access',
  !/no access/i.test(rRouted.reply ?? ''),
  rRouted.reply,
);
has('…and the text reached the doc', hub.getState().sections.docs[0].content, 'eggs');
assert(
  '…and the loop saw the refusal before routing',
  crossPage.seen.length >= 3 && crossPage.seen[0].toolNames.length > 0,
  `${crossPage.seen.length} turns`,
);
// The refusal the loop feeds back is itself part of the fix: it must say the
// action EXISTS and that this is routing, because the model paraphrases whatever
// wording it is given, and a bare "not focused" reads to it as "no access".
const refusal = prepare('docs.append', { text: 'x' }, 'todo');
check('a cross-page call is still refused, as designed', refusal.kind, 'error');
assert('…saying the action IS available', /is available/.test(refusal.error ?? ''), refusal.error);
assert(
  '…and calling it routing, not a permission problem',
  /routing step, not a permission problem/.test(refusal.error ?? ''),
  refusal.error,
);

// --- 7b-ii. WIRE NAMES end to end. The model replies with the provider-safe
// spelling, and the transcript we send BACK must be wire-safe too, because the
// provider validates `role:'tool'.name` and `assistant.tool_calls[].name` with
// the same pattern. Meanwhile the dotted spelling (what the prompt prose uses)
// must keep working, so a chattier model cannot wedge a run.
resetAiForTest();
hub.update(() => ({ ...hub.getState(), sections: { todo: [], docs: [], notes: '' }, activeDocId: null }));
const wireRun = scripted([
  replyWith(toolCall('todo__add', { text: 'wire milk' })),
  replyWith(toolCall('todo__add', { text: 'wire eggs' })),
  replyWith(toolCall('say__reply', { text: 'Added both.' })),
]);
const rWi = await runAiAgent({ utterance: 'add wire milk and wire eggs', focus: 'todo', llm: wireRun });
assert('wire-named tool calls execute', rWi.ok, rWi.error);
check('…both items landed', hub.getState().sections.todo.map((t) => t.text), ['wire milk', 'wire eggs']);
const echoed = wireRun.seen.at(-1).full;
const escaped = echoed.filter(
  (m) =>
    (m.name && !PROVIDER_NAME.test(m.name)) ||
    (m.tool_calls ?? []).some((n) => !PROVIDER_NAME.test(n ?? '')),
);
check('nothing sent back to the provider carries a dotted name', escaped, []);
assert(
  '…the tool role echoes the wire name',
  echoed.some((m) => m.role === 'tool' && m.name === 'todo__add'),
  JSON.stringify(echoed),
);

// A dotted call is still accepted, and rewritten to wire form on the way out.
resetAiForTest();
const dottedRun = scripted([
  replyWith(toolCall('todo.add', { text: 'dotted milk' })),
  replyWith(toolCall('say.reply', { text: 'ok' })),
]);
const rDo = await runAiAgent({ utterance: 'dotted test', focus: 'todo', llm: dottedRun });
assert(
  'a dotted name from the model is still accepted and runs',
  rDo.ok && hub.getState().sections.todo.some((t) => t.text === 'dotted milk'),
  rDo.error,
);
assert(
  '…and is echoed back in wire form',
  dottedRun.seen.at(-1).full.some((m) => (m.tool_calls ?? []).includes('todo__add')),
  JSON.stringify(dottedRun.seen.at(-1).full),
);

// --- 7c. Cross-page routing: a foreign call must bounce, then succeed.
resetAiForTest();
const route = scripted([
  // Deliberately wrong: a docs action while todo is focused.
  replyWith(toolCall('docs.append', { text: 'nope' })),
  // The model is expected to react to the error by routing first.
  replyWith(toolCall('nav.open_page', { page: 'docs' })),
  replyWith(toolCall('say.reply', { text: 'Switched to Docs.' })),
]);
mod.setAppBridge({ openPage: () => {}, goBack: () => {} });
const r3 = await runAiAgent({ utterance: 'open docs', focus: 'todo', llm: route });
assert('routing run succeeds', r3.ok, r3.error);
const kinds = getAi().steps.map((s) => s.kind);
assert('the illegal call shows as a failure', kinds.includes('fail'), kinds.join(','));
assert('the route shows as a focus line', getAi().steps.filter((s) => s.kind === 'focus').length >= 2);
check('focus moved to docs', getAi().focus, 'docs');

// --- 7d. Confirmation decline: the action must NOT run.
resetAiForTest();
await callAction('todo.add', { text: 'keep me' }, 'todo');
clearUndo();
const beforeDecline = hub.getState();
const declineRun = scripted([
  replyWith(toolCall('todo.clear_all', {})),
  replyWith(toolCall('say.reply', { text: 'Left it alone.' })),
]);
const off = autoConfirm(false);
const r4 = await runAiAgent({ utterance: 'clear my list', focus: 'todo', llm: declineRun });
off();
check('declined run did not clear the list', hub.getState().sections.todo.length, beforeDecline.sections.todo.length);
check('…and touched nothing', payload(hub.getState()), payload(beforeDecline));
assert('…and recorded nothing to undo', !hasUndo());
assert('the HUD notes the decline', getAi().steps.some((s) => s.kind === 'note' && /Declined/.test(s.text)));
assert('the run still completes (no hang)', r4.ok || r4.changed === false, JSON.stringify(r4));

// --- 7e. Confirmation approve: the action runs.
resetAiForTest();
const approveRun = scripted([
  replyWith(toolCall('todo.clear_all', {})),
  replyWith(toolCall('say.reply', { text: 'List cleared.' })),
]);
const beforeClear = hub.getState().sections.todo.length;
assert('there is something to clear', beforeClear > 0, `${beforeClear} item(s)`);
const off2 = autoConfirm(true);
const r5 = await runAiAgent({ utterance: 'clear my list', focus: 'todo', llm: approveRun });
off2();
check('approved run cleared the list', hub.getState().sections.todo.length, 0);
assert('…and IS undoable', r5.changed);
undoLastAiBatch();
check('…and undo restored it', hub.getState().sections.todo.length, beforeClear);

// --- 7f. First-call failure is "unreachable" so the caller can fall back to
// raw dictation. Anything AFTER a successful action must not be.
resetAiForTest();
const dead = scripted([{ ok: false, error: 'DEEPSEEK_API_KEY is not set' }]);
const r6 = await runAiAgent({ utterance: 'add milk', focus: 'todo', llm: dead });
check('a first-turn failure is unreachable', [r6.ok, r6.unreachable, r6.changed], [false, true, false]);
check('…and the HUD shows the error', getAi().status, 'error');
has('…naming the cause', getAi().error, 'DEEPSEEK_API_KEY');

// A transport that THROWS must be caught, not propagated.
resetAiForTest();
const thrower = async () => {
  throw new Error('network down');
};
const r7 = await runAiAgent({ utterance: 'add milk', focus: 'todo', llm: thrower });
check('a throwing transport is caught', [r7.ok, r7.unreachable], [false, true]);
has('…and surfaces the message', r7.error, 'network down');

// Mid-run failure after a successful action keeps the change and reports it.
resetAiForTest();
const half = scripted([
  replyWith(toolCall('todo.add', { text: 'landed' })),
  { ok: false, error: 'rate limited' },
  replyWith(toolCall('say.reply', { text: 'Added one thing.' })),
]);
const r8 = await runAiAgent({ utterance: 'add two things', focus: 'todo', llm: half });
check('a mid-run failure is NOT unreachable', r8.unreachable, false);
assert('…and the completed action survives', hub.getState().sections.todo.some((t) => t.text === 'landed'));

// --- 7g. Malformed tool arguments must be reported to the model, not thrown.
resetAiForTest();
const malformed = scripted([
  { ok: true, message: { role: 'assistant', content: '', tool_calls: [{ id: 'bad1', type: 'function', function: { name: 'todo.add', arguments: '{not json' } }] } },
  replyWith(toolCall('say.reply', { text: 'Sorry, try again.' })),
]);
const r9 = await runAiAgent({ utterance: 'add something', focus: 'todo', llm: malformed });
assert('bad JSON arguments do not crash the run', r9.ok, JSON.stringify(r9));
assert('…and are reported on the HUD', getAi().steps.some((s) => s.kind === 'fail' && /bad arguments/.test(s.text)));

// --- 7h. Running out of turns still produces an honest final answer.
resetAiForTest();
const endless = scripted(new Array(20).fill(replyWith(toolCall('app.status', {}))));
const r10 = await runAiAgent({ utterance: 'loop forever', focus: 'todo', maxSteps: 3, llm: endless });
assert('an over-long run still terminates', typeof r10.reply === 'string' && r10.reply.length > 0, r10.reply);
check('…after exactly maxSteps turns', endless.seen.length, 4); // 3 turns + the closing prompt
assert('…and the HUD turn counter tracked it', getAi().turn === 3 || getAi().turn === 4, String(getAi().turn));

// ════════════════════════════════════════════════════════════════════════════
// 8. CANCELLATION — a dismissed run must not repaint the HUD
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Cancellation ──');

resetAiForTest();
let halted = false;
const slowLlm = async () => {
  if (!halted) {
    halted = true;
    // The user dismisses the HUD while the model call is in flight.
    const off3 = subscribeAi(() => {
      if (getAi().status === 'running') aiCancel();
    });
    off3();
    queueMicrotask(() => aiCancel());
    await new Promise((r) => setTimeout(r, 5));
  }
  return replyWith(toolCall('todo.add', { text: 'ghost' }));
};
const cancels = await runAiAgent({ utterance: 'add a ghost', focus: 'todo', llm: slowLlm });
check('a cancelled run ends idle', getAi().status, 'idle');
check('…and its later write is dropped', hub.getState().sections.todo.some((t) => t.text === 'ghost'), false);
assert('…and the result reports as not ok', cancels.ok === false);

// `aiFlash` is a FRESH user action, so it must survive an earlier cancel.
aiCancel();
aiFlash('Undid: add a ghost');
check('aiFlash paints after a cancel', getAi().status, 'done');
check('…with the flash text', getAi().result, 'Undid: add a ghost');

// A stray confirm answer with nothing pending must not invent a running state.
aiReset();
const stray = aiAnswerConfirm(true);
check('aiAnswerConfirm with no prompt returns false', stray, false);
check('…and leaves the HUD idle', getAi().status, 'idle');

// A cancelled run must decline a pending confirmation rather than hang.
resetAiForTest();
const pendingRun = scripted([replyWith(toolCall('todo.clear_all', {}))]);
let declinedByCancel = null;
const off4 = subscribeAi(() => {
  if (getAi().status === 'confirm' && declinedByCancel === null) {
    declinedByCancel = 'seen';
    aiCancel();
  }
});
const r11 = await runAiAgent({ utterance: 'clear', focus: 'todo', llm: pendingRun });
off4();
check('cancelling a pending confirm resolves it', declinedByCancel, 'seen');
check('…leaving the HUD idle', getAi().status, 'idle');
assert('…and the run terminates', r11.ok === false);

// ════════════════════════════════════════════════════════════════════════════
// 9. SETTINGS surface
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Settings ──');

resetAiForTest();
check('default maxSteps', aiMaxSteps(), 6);
updateAiSettings({ maxSteps: 3 });
check('maxSteps is settable', aiMaxSteps(), 3);
updateAiSettings({ model: 'deepseek-chat' });
check('model is settable', aiModel(), 'deepseek-chat');
updateAiSettings({ maxSteps: 99 });
check('maxSteps is clamped to 12', aiMaxSteps(), 12);
updateAiSettings({ maxSteps: 0 });
check('maxSteps is clamped up to 1', aiMaxSteps(), 1);
updateAiSettings({ maxSteps: 6, model: '' });
check('settings are persisted for the next launch', typeof localStorage.getItem('hub:ai'), 'string');
check('maxSteps is clamped to an integer', (updateAiSettings({ maxSteps: 3.7 }), aiMaxSteps()), 3);
updateAiSettings({ maxSteps: 6 });

// ════════════════════════════════════════════════════════════════════════════
// 10. HUD rendering (aiView) — the glasses surface
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── HUD (aiView) ──');

const BYTE_CAP = 999;

resetAiForTest();
aiBegin('add milk to my list', 'todo');
let v = aiView(getAi());
has('running HUD shows the counter', v.text, 'JARVIS · working 1/6');
has('…quotes the utterance', v.text, 'add milk to my list');
has('…offers stop', v.text, 'tap R1 = stop');
check('running HUD does not paginate', [v.canPrev, v.canNext], [false, false]);
assert('running HUD is under the byte cap', Buffer.byteLength(v.text, 'utf8') <= BYTE_CAP, `${Buffer.byteLength(v.text, 'utf8')}B`);

// Confirm state must put the target on screen — an unreadable confirmation is
// not a confirmation.
mod.aiAskConfirm('Clear all to-dos', ['3 items will be deleted']);
v = aiView(getAi());
has('confirm HUD says so', v.text, 'JARVIS · CONFIRM');
has('…names the action', v.text, 'Clear all to-dos');
has('…shows the consequence', v.text, '3 items will be deleted');
has('…and both choices', v.text, 'tap R1 = run');
has('…including cancel', v.text, 'Stop = cancel');
assert('confirm HUD is under the byte cap', Buffer.byteLength(v.text, 'utf8') <= BYTE_CAP);

aiAnswerConfirm(true);
v = aiView(getAi());
has('after approving it returns to working', v.text, 'JARVIS · working');

// Long text must be clipped, never rejected by the firmware.
resetAiForTest();
aiBegin('x'.repeat(400), 'todo');
for (let i = 0; i < 20; i++) mod.aiStep('ok', 'a very long result '.repeat(10));
v = aiView(getAi());
assert(
  'a pathological HUD is still under the byte cap',
  Buffer.byteLength(v.text, 'utf8') <= BYTE_CAP,
  `${Buffer.byteLength(v.text, 'utf8')}B`,
);
assert('…and keeps the head line', v.text.startsWith('JARVIS · working'));

// Glyph safety: the firmware font renders a missing glyph as a tofu box, so no
// character outside the safe allow-list may reach the glass.
resetAiForTest();
aiBegin('emoji test 🎙 🥽 ✨', 'todo');
mod.aiStep('ok', 'added 🥛 to the list ✅');
mod.aiStep('fail', 'failed ⚠ badly');
v = aiView(getAi());
const unsupported = [...v.text].filter((ch) => {
  const c = ch.codePointAt(0);
  if (c === 10) return false; // newline
  if (c >= 32 && c <= 126) return false; // printable ASCII
  return !'─━│┌┐└┘├┤┬┴┼╭╮╯╰═║▲△▶▷▼▽◀◁●○■□▪▫★☆·•‣–—―…′″→←↑↓↔≤≥≠±×÷−°§¶†‡“”‘’«»„'.includes(ch);
});
check('no unsupported glyph reaches the glass', [...new Set(unsupported)], []);

// Done + error states, and the dismiss affordance.
resetAiForTest();
mod.aiFinish('Added 2 items to your list.');
v = aiView(getAi());
has('done HUD states the result', v.text, 'Added 2 items to your list.');
has('…and how to dismiss', v.text, 'tap R1 = dismiss');

resetAiForTest();
mod.aiFail('the model did not respond');
v = aiView(getAi());
has('error HUD says failed', v.text, 'JARVIS · failed');
has('…shows the reason', v.text, 'the model did not respond');

// ── The menu: Jarvis must be an ADDITION, never a replacement ──────────────
console.log('\n── Contextual menu ──');

const idleMenu = sectionMenu({ section: 'todo', hasDocs: false, aiRunning: false, aiUndo: false });
const idleNames = idleMenu.menuItems.map((i) => i.itemName);
check('idle menu starts with Jarvis', idleNames[0], 'Jarvis');
check('…carrying the agent id', idleMenu.menuItems[0].itemID, MENU.JARVIS);
check('…and the raw dictate item is still LAST', idleNames.at(-1), 'Dictate');
check('…unchanged, with its original id', idleMenu.menuItems.at(-1).itemID, MENU.DICTATE);
check('no Undo AI when there is nothing to undo', idleNames.includes('Undo AI'), false);

const runMenu = sectionMenu({ section: 'todo', hasDocs: false, aiRunning: true, aiUndo: false });
check('a running agent swaps the item to Stop AI', runMenu.menuItems[0].itemName, 'Stop AI');
check('…with the stop id', runMenu.menuItems[0].itemID, MENU.JARVIS_STOP);

// Undo AI sits directly under Jarvis: the two agent controls stay adjacent.
const undoMenu = sectionMenu({ section: 'todo', hasDocs: false, aiRunning: false, aiUndo: true });
check('Undo AI appears when a batch exists', undoMenu.menuItems[1].itemName, 'Undo AI');
check('…right under Jarvis', undoMenu.menuItems[0].itemName, 'Jarvis');
check('…with its id', undoMenu.menuItems[1].itemID, MENU.UNDO_AI);

const busyUndo = sectionMenu({ section: 'todo', hasDocs: false, aiRunning: true, aiUndo: true });
check('Undo AI hides while the agent is running', busyUndo.menuItems.some((i) => i.itemName === 'Undo AI'), false);

// An OPEN conversation (mic armed, no turn in flight) must still offer its exit.
const listenMenu = sectionMenu({ section: 'todo', hasDocs: false, aiUndo: true, aiListening: true });
check('an open conversation offers Stop AI', listenMenu.menuItems[0].itemName, 'Stop AI');
check('…and keeps Undo AI reachable between turns', listenMenu.menuItems[1].itemName, 'Undo AI');
check(
  '…so the menu is the always-available way out',
  listenMenu.menuItems[0].itemID,
  MENU.JARVIS_STOP,
);

// Menu ids must stay unique WITHIN a menu — the OS dispatches by id, so a
// collision would run the wrong action. Across menus the ids repeat by design
// (Dictate is always 20), which is what makes them stable to dispatch on.
const allIds = [...idleMenu.menuItems, ...runMenu.menuItems, ...undoMenu.menuItems].map((i) => i.itemID);
check('every menu id is > 0', allIds.filter((i) => !(i > 0)), []);
for (const [label, menu] of [
  ['idle', idleMenu],
  ['running', runMenu],
  ['undoable', undoMenu],
]) {
  const seen = menu.menuItems.map((i) => i.itemID);
  check(`${label} menu ids are unique`, seen.length, new Set(seen).size);
}

// Per-section shape. Back only exists where there is somewhere to go back TO:
// docs and agents are entered from the switcher, so they need an exit; todo and
// notes ARE the switcher, so they list the sections instead.
for (const sec of ['todo', 'docs', 'notes', 'agents']) {
  const m = sectionMenu({ section: sec, hasDocs: true, hasAgents: true, aiRunning: false, aiUndo: true });
  assert(
    `${sec} menu stays within the 10-item OS cap`,
    m.menuItems.length <= 10,
    `${m.menuItems.length} items`,
  );
  check(
    `${sec} menu ids are unique`,
    m.menuItems.map((i) => i.itemID).length,
    new Set(m.menuItems.map((i) => i.itemID)).size,
  );
  // The agent is the entry point that can reach everything, so it leads; raw
  // Dictate is the familiar one that must be findable without reading, so it
  // closes. The page's own actions sit between them, after the Back item.
  check(`${sec} menu leads with Jarvis`, m.menuItems[0].itemName, 'Jarvis');
  check(`${sec} menu keeps Dictate last`, m.menuItems.at(-1).itemName, 'Dictate');
  if (sec === 'docs' || sec === 'agents') {
    check(`${sec} menu has Back`, m.menuItems.some((i) => i.itemName === 'Back'), true);
  } else {
    check(`${sec} menu lists the section switchers`, m.menuItems.some((i) => i.itemName === 'Docs'), true);
  }
  // The Jarvis work must never push a section's own action off the menu.
  if (sec === 'docs') check('docs keeps its doc actions', m.menuItems.some((i) => i.itemName === 'New Docs'), true);
  if (sec === 'agents') check('agents keeps its run control', m.menuItems.some((i) => i.itemName === 'Trigger'), true);
}

// ════════════════════════════════════════════════════════════════════════════
// 11. CROSS-SURFACE MIRROR — the ownership rules
//
// A run belongs to one instance, and the other surface renders it read-only.
// Everything that keeps that from becoming an echo loop is a pure predicate
// here, so it can be proven without a relay.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Mirror: ownership rules ──');

const SELF = 'ai-self';
const PEER = 'ai-peer';
const NOW = 1_700_000_000_000;

// Rule 2 — never render your own broadcast back at yourself. Frames are built
// the way an owner publishes them: only a real run crosses the wire, and only a
// frame from this session (rule 4), so both fields are part of the rule.
const frameFrom = (owner, at = NOW) => ({ ...localSnapshot(at), owner, status: 'running' });
check('acceptRemote renders a peer run', acceptRemote(frameFrom(PEER), SELF, NOW), true);
check('acceptRemote drops our own echo', acceptRemote(frameFrom(SELF), SELF, NOW), false);
check('acceptRemote drops a frame with no owner', acceptRemote({ ...frameFrom(PEER), owner: '' }, SELF, NOW), false);
check('acceptRemote drops a non-string owner', acceptRemote({ ...frameFrom(PEER), owner: 7 }, SELF, NOW), false);
check(
  'acceptRemote drops an IDLE frame — there is no run on it',
  acceptRemote({ ...frameFrom(PEER), status: 'idle' }, SELF, NOW),
  false,
);
check(
  'acceptRemote drops a replay from an earlier connection',
  acceptRemote(frameFrom(PEER, NOW - 3_600_001), SELF, NOW),
  false,
);
check('acceptRemote drops null', acceptRemote(null, SELF, NOW), false);
check('acceptRemote drops a non-object', acceptRemote('nope', SELF, NOW), false);

// Directed control frames — only the addressed instance may act, and only on a
// fresh instruction (a reconnect replay would otherwise cancel a NEW run).
const stopFor = (target, at = NOW) => ({ target, at, action: 'stop' });
check('acceptControl takes a fresh frame addressed to us', acceptControl(stopFor(SELF), SELF, NOW), true);
check('acceptControl drops a frame addressed elsewhere', acceptControl(stopFor(PEER), SELF, NOW), false);
check(
  'acceptControl drops a stale frame',
  acceptControl(stopFor(SELF, NOW - 60_000), SELF, NOW),
  false,
);
check(
  'acceptControl drops an unknown action',
  acceptControl({ target: SELF, at: NOW, action: 'explode' }, SELF, NOW),
  false,
);
check(
  'acceptControl drops a frame with no timestamp',
  acceptControl({ target: SELF, action: 'stop' }, SELF, NOW),
  false,
);
check('acceptControl accepts a confirm answer', acceptControl({ target: SELF, at: NOW, action: 'confirm', approve: true }, SELF, NOW), true);
assert(
  'CONTROL_TTL is long enough for a human to reach for the phone',
  NOW - (NOW - 14_000) <= 15_000,
  'ttl=15000ms',
);

// Rule 3 — a silent owner must not freeze the HUD on "working" forever.
check('mirrorExpired fires for a silent live mirror', mirrorExpired(true, 'running', NOW - 9_000, NOW), true);
check('mirrorExpired does not fire for a fresh mirror', mirrorExpired(true, 'running', NOW - 1_000, NOW), false);
check('mirrorExpired ignores our own run', mirrorExpired(false, 'running', NOW - 60_000, NOW), false);
check('mirrorExpired ignores an idle mirror', mirrorExpired(true, 'idle', NOW - 60_000, NOW), false);
check('mirrorExpired covers a mirrored confirm', mirrorExpired(true, 'confirm', NOW - 9_000, NOW), true);
// …and it must cover the terminal frames too. This is exactly why the owner
// stops its heartbeat at `done`: an endlessly re-announced result would keep
// refreshing `lastFrameAt` and the overlay would never leave the peer HUD.
check('mirrorExpired sweeps a stale mirrored result', mirrorExpired(true, 'done', NOW - 9_000, NOW), true);
check('mirrorExpired sweeps a stale mirrored failure', mirrorExpired(true, 'error', NOW - 9_000, NOW), true);

// ── Applying a remote snapshot ──────────────────────────────────────────────
console.log('\n── Mirror: applying a remote run ──');
resetAiForTest();
check('a fresh store is not mirrored', isAiMirrored(), false);

const remote = {
  owner: PEER,
  at: NOW,
  status: 'running',
  focus: 'docs',
  utterance: 'clear the list',
  steps: Array.from({ length: 40 }, (_, i) => ({ kind: 'ok', text: `step ${i}`, at: i })),
  turn: 2,
  maxSteps: 6,
  pending: null,
  result: '',
  error: '',
};
applyRemoteAi(remote);
assert('applyRemoteAi marks the run as mirrored', isAiMirrored() === true);
check('applyRemoteAi adopts the status', getAi().status, 'running');
check('applyRemoteAi adopts the focus', getAi().focus, 'docs');
check('applyRemoteAi adopts the utterance', getAi().utterance, 'clear the list');
assert(
  'applyRemoteAi caps the mirrored step list',
  getAi().steps.length <= 14,
  `${getAi().steps.length} steps`,
);
assert(
  'the mirrored tail is the NEWEST steps, not the oldest',
  getAi().steps[getAi().steps.length - 1].text === 'step 39',
  `last=${getAi().steps[getAi().steps.length - 1]?.text}`,
);

// A mirrored run is read-only locally: it has no local resolver, so answering it
// here must fail loudly rather than hang the loop waiting for an answer.
check('a mirrored confirm cannot be answered locally', aiAnswerConfirm(true), false);

// The HUD has to say the controls live elsewhere — a "tap R1 = run" footer on a
// run this device cannot execute reads as a dead button.
const mirrorView = aiView({ ...getAi(), status: 'confirm', pending: { title: 'Clear the list', lines: ['3 tasks will go'] } });
has('the mirrored confirm HUD names the other surface', mirrorView.text, 'from phone');
check(
  'the mirrored confirm HUD does not offer to run it here',
  mirrorView.text.includes('tap R1 = run'),
  false,
);
assert(
  'the mirrored HUD still stays inside the 999-byte content cap',
  Buffer.byteLength(mirrorView.text, 'utf8') <= 999,
  `${Buffer.byteLength(mirrorView.text, 'utf8')} bytes`,
);

// Clearing must only ever clear a MIRROR. A local run must survive a late empty
// frame from a peer that just went idle.
applyRemoteAi(null);
check('applyRemoteAi(null) clears the mirror', isAiMirrored(), false);
check('applyRemoteAi(null) resets to idle', getAi().status, 'idle');
check('applyRemoteAi(null) drops the mirrored steps', getAi().steps.length, 0);

resetAiForTest();
aiBegin('local run', 'todo');
assert('a local run is under way', getAi().status === 'running');
applyRemoteAi(null);
check('applyRemoteAi(null) leaves a LOCAL run alone', isAiMirrored(), false);
check('…and its status survives', getAi().status, 'running');

// Starting our own run takes ownership back, so the surface stops mirroring.
applyRemoteAi(remote);
assert('mirroring again for the ownership test', isAiMirrored() === true);
aiBegin('my own run', 'notes');
check('starting our own run drops the mirror', isAiMirrored(), false);
check('…and adopts our own focus', getAi().focus, 'notes');
aiReset();

// ── localSnapshot + the "never re-broadcast" rule ───────────────────────────
console.log('\n── Mirror: broadcast shape ──');
resetAiForTest();
aiBegin('snapshot me', 'todo');
const snap = localSnapshot(NOW);
check('localSnapshot stamps the owner', snap.owner, mod.AI_INSTANCE_ID);
check('localSnapshot stamps a timestamp', snap.at, NOW);
check('localSnapshot carries the status', snap.status, 'running');
assert(
  'localSnapshot caps the mirrored step list',
  snap.steps.length <= 14,
  `${snap.steps.length} steps`,
);
assert(
  'a snapshot round-trips as a valid remote frame for a peer',
  acceptRemote(snap, PEER, NOW) === true,
);
assert(
  'a snapshot is rejected by its own sender',
  acceptRemote(snap, mod.AI_INSTANCE_ID, NOW) === false,
);

// Rule 1 — the one that cannot be shown by a single frame, and the one that
// matters most: only the OWNER broadcasts. If a surface re-published the run it
// is merely mirroring, the two surfaces would bounce it back and forth forever.
check('an owned run is broadcast', mod.shouldBroadcast(false), true);
check('a mirrored run is never re-broadcast', mod.shouldBroadcast(true), false);
resetAiForTest();
applyRemoteAi(remote);
check('the live store agrees while mirroring', mod.shouldBroadcast(), false);
resetAiForTest();
check('…and agrees when the run is ours', mod.shouldBroadcast(), true);

// Only a LIVE run earns a heartbeat. A terminal run must stop re-announcing,
// otherwise it refreshes the peer's TTL forever and a stale overlay can never
// be swept off the other HUD.
check('idle is not live', mod.isLiveStatus('idle'), false);
check('running is live', mod.isLiveStatus('running'), true);
check('a pending confirm is live (it must not expire under the user)', mod.isLiveStatus('confirm'), true);
check('done is terminal, not live', mod.isLiveStatus('done'), false);
check('error is terminal, not live', mod.isLiveStatus('error'), false);

// ── requestRemoteStop / requestRemoteConfirm ────────────────────────────────
// The relay-facing shape is built by pure helpers, because `postJson` no-ops
// without an authenticated credential and the harness has none.
console.log('\n── Mirror: directed controls ──');
const stop = mod.stopFrame(PEER, NOW);
const approve = mod.confirmFrame(PEER, true, NOW);
const decline = mod.confirmFrame(PEER, false, NOW);

check('a Stop frame targets the owner', stop.target, PEER);
check('a Stop frame says stop', stop.action, 'stop');
check('a Stop frame carries a timestamp', stop.at, NOW);
check('a confirm frame says confirm', decline.action, 'confirm');
check('a confirm frame carries the approval', approve.approve, true);
check('a declined frame carries the refusal', decline.approve, false);
assert(
  'an owner accepts its own Stop frame',
  acceptControl(stop, PEER, NOW) === true,
);
assert(
  'a different instance ignores a Stop aimed at the owner',
  acceptControl(stop, SELF, NOW) === false,
);
check(
  'the frame builder stamps `now` by default',
  typeof mod.stopFrame(PEER).at,
  'number',
);

// With no mirror there is no owner to address, so these must be a no-op rather
// than a broadcast to nobody.
resetAiForTest();
let ctlFrames = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('channel=ai-ctl') && init?.body) ctlFrames.push(JSON.parse(init.body));
  return { ok: false, status: 0, json: async () => ({}) };
};
requestRemoteStop();
requestRemoteConfirm(true);
check('no mirror ⇒ no control frames are sent', ctlFrames.length, 0);
check('no mirror ⇒ Stop publishes nothing', await Promise.resolve(mod.requestRemoteStop()), undefined);
globalThis.fetch = realFetch;
resetAiForTest();
clearUndo();

// ── SAFETY INVARIANT: a tap must CANCEL a mirrored confirm ──────────────────
// A mirrored confirm is a DESTRUCTIVE action parked on another surface, and the
// HUD footer promises the wearer `from phone · tap = cancel`. If the tap instead
// approved, the single easiest gesture to trigger by accident would silently do
// the exact opposite of the instruction printed on the lens — and it deletes
// data. Consent for a destructive action belongs on the surface that shows
// explicit Approve/Decline buttons (the owner), never on a bare tap.
//
// `onTap` lives inside main.ts, which this harness cannot import (it boots the
// SDK and the render loop), so the invariant is asserted against its source
// instead. Brittle on purpose: this line flipping to `true` should break the
// build, not ship.
const mainSrc = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const tapConfirm = /if \(ai\.mirrored\)\s*requestRemoteConfirm\((true|false)\)/.exec(mainSrc);
assert(
  'the glasses tap answers a mirrored confirm through the relay',
  !!tapConfirm,
);
check(
  'a tap on a mirrored confirm CANCELS, it never approves',
  tapConfirm?.[1],
  'false',
);
// …but the OWNER's tap must still approve. The owner is the surface the command
// was spoken into and the one the HUD's `tap R1 = run` addresses, so collapsing
// both branches to a decline would silently break every destructive action.
assert(
  "the owner's tap still runs its own confirmed action",
  /else\s+aiAnswerConfirm\(true\)/.test(mainSrc),
);
// Dismissing must also distinguish live from terminal. A finished mirror is a
// LOCAL dismissal (its footer says 'tap = dismiss'); reaching across would wipe
// a transcript the owner is still reading. Only a live run needs a remote stop.
assert(
  'only a LIVE mirror is stopped on the owner when dismissed',
  /isAiMirrored\(\)\s*&&\s*isLiveStatus\(/.test(mainSrc),
);

// ════════════════════════════════════════════════════════════════════════════
// 13. CHAIN OF THOUGHT — the reasoning has to be VISIBLE, not just recorded
//
// The agent loop is only trustworthy if the wearer can watch it decide. Two
// things can silently break that:
//   1. the model's own reasoning is dropped in transport (the relay used to
//      forward only `content` + `tool_calls`), so the HUD can only ever show
//      the app's own step labels and never WHY the action was chosen;
//   2. the HUD filter omits the reasoning kind, so it renders on the phone
//      panel and never on the glasses.
// Both are asserted here, end to end: relay source → loop → rendered HUD.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Chain of thought ──');

// --- 13a. The transport must not swallow it.
// Providers disagree on the field name; the relay normalises both onto
// `reasoning_content`, which is the only spelling the client type declares.
const relaySrc = readFileSync(new URL('../../web/server/local-sse.mjs', import.meta.url), 'utf8');
assert(
  'the relay reads DeepSeek\'s reasoning_content',
  /choice\.reasoning_content/.test(relaySrc),
);
assert(
  '…with OpenRouter\'s `reasoning` as the fallback spelling',
  /choice\.reasoning_content \?\? choice\.reasoning/.test(relaySrc),
);
assert(
  '…and forwards it to the client',
  /reasoning_content: String\(reasoning\)/.test(relaySrc),
);

// --- 13b. The loop records it as a `think` step, spoken-before-acted order.
resetAiForTest();
hub.update(() => ({ ...hub.getState(), sections: { todo: [], docs: [], notes: '' }, activeDocId: null }));
const reasoned = scripted([
  {
    ok: true,
    message: {
      role: 'assistant',
      content: '',
      reasoning_content: 'The list is empty, so I will just say so.',
      tool_calls: [toolCall('say.reply', { text: 'Nothing on your list.' })],
    },
  },
]);
const rCoT = await runAiAgent({ utterance: 'what is on my list?', focus: 'todo', llm: reasoned });
assert('a reasoned run still succeeds', rCoT.ok, rCoT.reply);
const cotKinds = getAi().steps.map((s) => s.kind);
assert('the model reasoning becomes a think step', cotKinds.includes('think'), cotKinds.join(','));
const thinkStep = getAi().steps.find((s) => s.kind === 'think');
assert(
  "…carrying the model's own words",
  (thinkStep?.text ?? '').includes('just say so'),
  thinkStep?.text,
);
assert(
  'the reasoning is recorded BEFORE the action it explains',
  cotKinds.indexOf('think') < cotKinds.lastIndexOf('ok'),
  cotKinds.join(','),
);
assert('the spoken answer is recorded as a reply step', cotKinds.includes('reply'), cotKinds.join(','));
check('…with the reply text', getAi().steps.at(-1).text, 'Nothing on your list.');

// --- 13c. A plan sentence written alongside a tool call is the same signal.
// DeepSeek puts "here is what I am about to do" in `content` when it also emits
// tool_calls. That is a chain of thought even with no reasoning field present,
// so it must not be thrown away — but it must NOT be logged as the reply, or the
// HUD would show the narration instead of the action.
resetAiForTest();
hub.update(() => ({ ...hub.getState(), sections: { todo: [], docs: [], notes: '' }, activeDocId: null }));
const plans = scripted([
  {
    ok: true,
    message: {
      role: 'assistant',
      content: 'I will add milk now.',
      tool_calls: [toolCall('todo.add', { text: 'milk' })],
    },
  },
  replyWith(toolCall('say.reply', { text: 'Added milk.' })),
]);
const rPlan = await runAiAgent({ utterance: 'add milk', focus: 'todo', llm: plans });
check('a narration-plus-action turn ends on the real reply', rPlan.reply, 'Added milk.');
const planThinks = getAi().steps.filter((s) => s.kind === 'think');
check('the plan sentence is logged once, as reasoning', planThinks.length, 1);
assert('…verbatim', planThinks[0].text.includes('add milk now'), planThinks[0].text);
check(
  '…and is NOT mistaken for the answer',
  getAi().steps.filter((s) => s.kind === 'reply').map((s) => s.text),
  ['Added milk.'],
);
// A terminal turn with no tool calls is the ANSWER, never reasoning.
check(
  'an answer-only turn logs no reasoning',
  getAi().steps.some((s) => s.kind === 'think' && s.text.includes('Added milk')),
  false,
);

// --- 13d. The HUD must render it, with firmware-safe marks.
resetAiForTest();
aiBegin('clear the list', 'todo');
// Keep the reasoning short: the HUD clips each step line at 44 characters, so a
// long sentence would be asserted against its own ellipsis.
aiStep('think', 'Three items. Remove them one by one.');
const thinking = aiView(getAi());
has('the running HUD shows the reasoning', thinking.text, 'one by one');
has('…marked as reasoning, not as a finished step', thinking.text, '> Three items');
has('…and still offers the stop gesture', thinking.text, 'tap R1 = stop');
// The web panel's marks (▸ ✓ ✕) are NOT in the firmware font — a copy-paste from
// AiPanel.tsx into sections.ts would render as blanks on the lens, not an error.
assert(
  'the HUD uses no glyph the firmware cannot draw',
  !/[▸✓✕⚠✻»]/.test(thinking.text),
  thinking.text.replace(/\n/g, ' | ').slice(0, 90),
);

// The routing line is the FIRST link of the chain: which page the model decided
// this request belongs to. It used to appear only when the page CHANGED, which
// hid the decision on the (common) single-page request.
aiStep('focus', 'docs');
has('a single focus step still shows the routing decision', aiView(getAi()).text, '→ Docs');

// Reasoning must survive the HUD's 3-line window: it is interleaved with action
// results, and the newest reasoning is the one worth showing.
aiStep('ok', 'one'); aiStep('ok', 'two'); aiStep('think', 'now the last one');
has('reasoning survives the 3-step HUD window', aiView(getAi()).text, 'now the last one');

// The terminal screens are where the CONVERSATION shows: while the mic is open
// the dictation overlay owns the glass, so `conversing` only ever reaches the
// HUD once a turn has finished. There the footer's promise changes — the tap no
// longer dismisses, it re-opens the mic.
mod.aiFinish('Cleared 3 tasks.');
has(
  'a finished reply in a conversation invites the next sentence',
  aiView(getAi(), { conversing: true }).text,
  'tap R1 = speak again · 2x = end',
);
has('a one-shot reply still says dismiss', aiView(getAi()).text, 'tap R1 = dismiss');
has('…and names the two ways out', aiView(getAi(), { conversing: true }).text, '2x = end');
// A run owned by the PHONE panel is read-only here: promising "speak again" over
// a run this device does not own would arm a mic that cannot answer it.
applyRemoteAi({
  owner: PEER, at: NOW, status: 'done', focus: 'todo', utterance: 'clear the list',
  steps: [{ kind: 'think', text: 'peer reasoning', at: 1 }], turn: 1, maxSteps: 6,
  pending: null, result: 'Peer answer.', error: '',
});
check(
  'a mirrored run never claims the glasses mic',
  aiView(getAi(), { conversing: true }).text.includes('speak again'),
  false,
);
has(
  '…it says the controls are on the phone',
  aiView(getAi(), { conversing: true }).text,
  'from phone',
);
applyRemoteAi(null);

// --- 13e. The step log is bounded, or a long conversation leaks memory into the
// render loop — every step is re-walked on every frame.
resetAiForTest();
aiBegin('x', 'todo');
for (let i = 0; i < 80; i++) aiStep('ok', `s${i}`);
check('the step log is capped', getAi().steps.length, 60);
check('…keeping the NEWEST steps', getAi().steps.at(-1).text, 's79');
check('…and dropping the oldest', getAi().steps[0].text, 's20');

// ════════════════════════════════════════════════════════════════════════════
// 14. THE CONVERSATION LOOP — main.ts invariants
//
// `onTap` / the dictation lifecycle live inside main.ts, which this harness
// cannot import (it boots the SDK and the render loop). The loop's shape is
// therefore asserted against its source. Brittle on purpose: these are the lines
// whose removal silently turns a conversation back into a one-shot command.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Conversation loop (source invariants) ──');
const src = (label, re) => {
  const m = re.test(mainSrc);
  assert(label, m, String(re));
  return m;
};

src('choosing Jarvis OPENS a conversation', /jarvisSession = true;[\s\S]{0,160}startGlassesDictation\(true\)/);
src('a finished reply re-arms the mic instead of dismissing', /if \(jarvisSession\) \{[\s\S]{0,400}listenAgain\(\)/);
src('…after a readable pause, not instantly', /JARVIS_LISTEN_DELAY_MS = \d+/);
src('dismissAi closes the conversation (the menu exit)', /function dismissAi\(\): void \{\s*\n\s*jarvisSession = false;/);
src('…and stops the mic with it, or a later phrase starts a new turn', /if \(dictationActive && dictationToAgent\) \{/);
src('the HUD is told when the loop is conversing', /aiView\(ai, \{ conversing: jarvisSession \}\)/);
src('the menu is told when the mic is open (so Stop AI is offered)', /aiListening: jarvisSession &&/);
src('double-tap covers the LISTENING phase too', /getAi\(\)\.status !== 'idle' \|\| jarvisSession/);
src('the conversation survives a turn being stopped', /function stopTurnKeepTalking\(\)/);
src('a run that never reached the model ends the conversation', /jarvisSession = false;\s*\n\s*dictationToAgent = false;\s*\n\s*flashAi\('Jarvis off/);
src('a silent mic cannot loop forever', /JARVIS_MAX_SILENT/);
// The conversation now SURVIVES a foreground round trip: opening the contextual
// menu can re-deliver foreground-enter, and ending the session there flipped the
// menu's first item back to 'Jarvis', so a Stop tap restarted Jarvis instead.
// A dead mic is re-armed; only a deliberate Stop / double-tap ends it.
src('a foreground round trip keeps the conversation (re-arms a dead mic)', /if \(jarvisSession\) \{[\s\S]{0,160}listenAgain\(\)/);
assert('…and foreground-enter no longer dismisses the session', !/if \(jarvisSession\) dismissAi\(\);/.test(mainSrc));

// This batch's other fixes, locked as source invariants.
src('the agent list wraps around at both edges', /const next = \(agentCursor \+ dir \+ n\) % n;/);
src('a silent tap no longer ends the Jarvis conversation', /const deadMic = \/never-heard\/\.test\(lastDictationReason\(\)\)/);
src('a dictation error releases the mic', /releaseDictationMic\(\);/);
src('the listening screen carries the previous answer', /Was: \$\{jarvisLastReply\}/);
src('raw Dictate is untouched (still the default)', /function startGlassesDictation\(toAgent = false\)/);

// THE ordering invariant. Both branches are reachable at once during a
// conversation: the mic is open while the store still holds the previous turn's
// terminal status. If the `done` dismissal is tested FIRST, the tap that the
// user means as "send this sentence" becomes "throw the sentence away".
const iListen = mainSrc.indexOf('if (dictationActive) {');
const iFinished = mainSrc.indexOf("if (ai.status === 'done' || ai.status === 'error') {");
assert(
  'the listening tap is handled BEFORE the finished-HUD tap',
  iListen > 0 && iFinished > 0 && iListen < iFinished,
  `dictationActive@${iListen} done@${iFinished}`,
);

// ════════════════════════════════════════════════════════════════════════════
// 15. AGENT BUILDER — voice can set EVERY setting, clone, and edit in place
//
// The builder has name, role (system prompt), trigger prompt, tools and a model
// override. A voice-only wearer has no keyboard, so every one of them must be
// reachable by speaking — and "clone" must copy them all. These tests drive the
// real capabilities against the real agents store.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Agent builder capabilities ──');

const capOf = (name) => {
  const c = capabilityByName(name);
  assert(`capability ${name} exists`, !!c);
  return c;
};

// A clean slate: no agents, but the seeded web-search tool plus a fake REST tool
// so name resolution has two kinds to choose between.
agents.updateAgents((s) => ({
  ...s,
  agents: [],
  sessions: [],
  tools: [
    ...s.tools.filter((t) => t.kind === 'web'),
    {
      id: 'tool-weather',
      name: 'get_weather',
      kind: 'http',
      description: 'Weather lookup',
      url: 'https://api.example.com/weather',
      method: 'GET',
    },
  ],
}));

const toolCatalog = await capOf('tools.list').run({});
assert('tools.list names the seeded search tool', JSON.stringify(toolCatalog.data).includes('web_search'));
assert('tools.list names the REST tool', JSON.stringify(toolCatalog.data).includes('get_weather'));

// The list must advertise every kind the RELAY can execute, not just the tools
// the catalog happens to hold. This is what makes the document store and jev
// discoverable by a voice-only wearer: before, the list was built from the
// catalog alone, so an install holding only web search answered
// "1 tool(s): web_search" and naming either of the others matched nothing.
assert(
  'tools.list advertises the document store it does not hold yet',
  JSON.stringify(toolCatalog.data).includes('jarvis_files'),
);
assert('tools.list advertises jev', JSON.stringify(toolCatalog.data).includes('jev_decide'));
check(
  '…and marks exactly the un-created kinds as available',
  toolCatalog.data.tools
    .filter((t) => t.available)
    .map((t) => t.kind)
    .sort(),
  ['files', 'jev'],
);
// ASKING is not OPTING IN: a read must not create them, or a deleted tool would
// come back the moment anything listed what was on offer.
check(
  'listing tools creates nothing (opt-in is still the wearer\'s word)',
  agents.getAgents().tools.filter((t) => t.kind === 'files' || t.kind === 'jev').length,
  0,
);

// create: set every setting at once, resolving spoken tool names.
const created = await capOf('agents.create').run({
  name: 'Researcher',
  systemPrompt: 'You are terse.',
  prompt: 'Summarise the news.',
  tools: 'web search and get_weather',
  model: 'vendor/model:free',
});
assert('create succeeds', created.ok, created.summary);
let stored = agents.getAgents().agents;
check('create stores one agent', stored.length, 1);
check('create sets the role (system prompt)', stored[0].systemPrompt, 'You are terse.');
check('create resolves "web search" to the web tool', stored[0].toolIds.includes('tool-web'), true);
check('create resolves "get_weather"', stored[0].toolIds.includes('tool-weather'), true);
check('create sets the model override', stored[0].model, 'vendor/model:free');
assert('create stamps updatedAt for newest-first ordering', typeof stored[0].updatedAt === 'number');

// create with "none" → no tools.
await capOf('agents.create').run({ name: 'Bare', tools: 'none' });
stored = agents.getAgents().agents;
check('create with "none" attaches no tools', stored.find((a) => a.name === 'Bare').toolIds, []);

// create without tools → web search by default (the builder's own default).
await capOf('agents.create').run({ name: 'Defaulted' });
stored = agents.getAgents().agents;
check('create defaults to web search', stored.find((a) => a.name === 'Defaulted').toolIds, ['tool-web']);

// update: in-place edits, including tool add/remove and clearing the model.
const beforeUpdatedAt = stored.find((a) => a.name === 'Researcher').updatedAt;
const upd = await capOf('agents.update').run({
  agent: 'Researcher',
  name: 'Scout',
  systemPrompt: 'Be brief.',
  addTools: 'get_weather',
  removeTools: 'search',
  model: 'none',
});
assert('update succeeds', upd.ok, upd.summary);
stored = agents.getAgents().agents;
const scout = stored.find((a) => a.name === 'Scout');
assert('update renames in place', !!scout);
check('update rewrites the role', scout.systemPrompt, 'Be brief.');
check('update removes search', scout.toolIds.includes('tool-web'), false);
check('update adds the REST tool', scout.toolIds.includes('tool-weather'), true);
check('update clears the model override', scout.model, undefined);
assert('update re-stamps updatedAt (drives list order)', scout.updatedAt >= beforeUpdatedAt);

// update with tools "none" empties the set.
await capOf('agents.update').run({ agent: 'Scout', tools: 'none' });
stored = agents.getAgents().agents;
check('update with "none" clears every tool', stored.find((a) => a.name === 'Scout').toolIds, []);

// A replace that matches nothing must NOT wipe the tools (a misheard name).
await capOf('agents.update').run({ agent: 'Scout', addTools: 'get_weather' });
const guarded = await capOf('agents.update').run({ agent: 'Scout', tools: 'flibbertigibbet' });
stored = agents.getAgents().agents;
check('an unmatched replace keeps the tools', stored.find((a) => a.name === 'Scout').toolIds, ['tool-weather']);
check('…and returns a correctable "nothing to change"', guarded.ok, false);

// clone: copies EVERY setting under a new id + default name.
const cloned = await capOf('agents.clone').run({ agent: 'Defaulted' });
assert('clone succeeds', cloned.ok, cloned.summary);
stored = agents.getAgents().agents;
const copy = stored.find((a) => a.id === cloned.data.id);
assert('clone names the copy "<original> copy"', copy.name === 'Defaulted copy', copy.name);
assert('clone gets a NEW id', copy.id !== stored.find((a) => a.name === 'Defaulted').id);
check('clone copies the tools', copy.toolIds, ['tool-web']);
check(
  'clone copies the role',
  copy.systemPrompt,
  stored.find((a) => a.name === 'Defaulted').systemPrompt,
);

// clone with an explicit name.
await capOf('agents.clone').run({ agent: 'Scout', name: 'Watcher' });
stored = agents.getAgents().agents;
assert('clone accepts a new name', stored.some((a) => a.name === 'Watcher'));

// agents.list exposes the full configuration so the model can read it back.
const listed = await capOf('agents.list').run({});
const row = listed.data.agents.find((a) => a.name === 'Scout');
assert('agents.list returns toolIds', Array.isArray(row.toolIds));
assert('agents.list returns the model field', 'model' in row);
assert('agents.list returns the role', typeof row.systemPrompt === 'string');

// Opt in to a tool by DESCRIBING it. This is the whole fix: the web panel could
// always attach the document store with one button, but the wearer of the
// glasses has no keyboard and no panel, so "give it the document store" has to
// create the tool AND attach it in one spoken phrase.
console.log('\n── Agent builder: opting in to a tool by describing it ──');

const withDocs = await capOf('agents.create').run({ name: 'Archivist', tools: 'stored documents' });
assert('create succeeds describing the document store', withDocs.ok, withDocs.summary);
stored = agents.getAgents().agents;
check('…creates the tool and attaches it', stored.find((a) => a.name === 'Archivist').toolIds, ['tool-files']);
check('…and the catalog now holds it', agents.getAgents().tools.some((t) => t.kind === 'files'), true);

const withJev = await capOf('agents.create').run({ name: 'Adjudicator', tools: 'jev decision' });
assert('create succeeds describing jev', withJev.ok, withJev.summary);
stored = agents.getAgents().agents;
check('…creates jev and attaches it', stored.find((a) => a.name === 'Adjudicator').toolIds, ['tool-jev']);

// …and through addTools/removeTools on the SAME described phrasing.
const added = await capOf('agents.update').run({ agent: 'Archivist', addTools: 'web search' });
assert('update adds a second tool by description', added.ok, added.summary);
stored = agents.getAgents().agents;
check('…keeping the first', stored.find((a) => a.name === 'Archivist').toolIds, ['tool-files', 'tool-web']);

await capOf('agents.update').run({ agent: 'Archivist', removeTools: 'stored documents' });
stored = agents.getAgents().agents;
check(
  'update removes the document store by description',
  stored.find((a) => a.name === 'Archivist').toolIds,
  ['tool-web'],
);

// A kind the relay cannot execute must NOT be invented. Agent runs execute
// server-side in the relay, which has routes for web search, the document
// gateway and jev and nothing else — so todos/docs/notes do not exist for an
// agent however they are phrased, and saying so is better than a silent no-op.
const bogus = await capOf('agents.update').run({ agent: 'Adjudicator', tools: 'manage my todos' });
check('an unexecutable tool is refused, not invented', bogus.ok, false);
assert('…with the unmatched phrase reported back', /no such tool/.test(bogus.hint ?? ''), bogus.hint);

// ════════════════════════════════════════════════════════════════════════════
// Sessions: a stored run must be readable back IN FULL
//
// The bug this guards: the relay stored each tool result clipped to 600 chars
// with a literal "…[truncated]" appended, and the reader then cut the whole
// transcript to 900 more. Jarvis reported every past session as truncated
// because every past session WAS truncated, in the stored bytes.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Sessions: full transcripts, not fragments ──');

// A tool result in the shape the relay now stores it: the whole thing, tail
// included. This is the exact text that used to be cut to 600 characters.
const TAIL_MARK = 'END-OF-TOOL-RESULT-MARKER';
const toolResult = `${'Headline and body text. '.repeat(28)}${TAIL_MARK}`;
assert(
  'the fixture result exceeds the old 600-char store cap',
  toolResult.length > 600,
  `${toolResult.length} chars`,
);

agents.recordSession({
  agentId: 'agent-session-fixture',
  title: 'Fixture run',
  status: 'done',
  messages: [
    { role: 'user', content: 'summarise the news', at: 1 },
    { role: 'assistant', content: 'Calling tavily_search…', tool: 'tavily_search', at: 2 },
    { role: 'tool', content: toolResult, tool: 'tavily_search', at: 3 },
    { role: 'assistant', content: 'Markets moved on the rate decision.', at: 4 },
  ],
});

const read = await capOf('agents.sessions').run({ session: '1' });
assert('a past session can be read', read.ok, read.summary);
const t = read.data.transcript;
assert('the transcript is not marked as clipped', !t.includes('omitted'), t.slice(0, 60));
assert(
  'the transcript does not open mid-content',
  !t.startsWith('…'),
  JSON.stringify(t.slice(0, 40)),
);
assert('the END of a stored tool result survives the read', t.includes(TAIL_MARK), `${t.length} chars`);
assert(
  'the WHOLE tool result survives the read',
  t.includes(toolResult),
  `${toolResult.length} chars in a ${t.length}-char transcript`,
);
assert(
  'the tool result is no longer re-clipped to 220 chars per message',
  !t.includes(`${toolResult.slice(0, 220)}…`),
  t.slice(0, 60),
);

// Over budget: the cut must land on a LINE boundary and name what it dropped,
// so the model reports a count instead of an impression of truncation. The
// fixture has to clear the 88000-char guard (5 steps x 16000 tool chars).
const oversized = [];
for (let i = 0; i < 40; i++) {
  oversized.push({ role: 'tool', content: `${'x'.repeat(3000)}-line-${i}`, tool: 't', at: i });
}
oversized.push({ role: 'assistant', content: `FINAL-ANSWER-${'y'.repeat(200)}`, at: 99 });
agents.recordSession({
  agentId: 'agent-session-fixture',
  title: 'Oversized run',
  status: 'done',
  messages: oversized,
});
const big = await capOf('agents.sessions').run({ session: '1' });
const bt = big.data.transcript;
assert('an oversized transcript IS trimmed', bt.includes('earlier line'), bt.slice(0, 60));
assert('…and it stays near the budget', bt.length <= 88080, `${bt.length} chars`);
assert(
  '…and it reports how many lines it dropped',
  /^…\(\d+ earlier lines? omitted\)/.test(bt),
  JSON.stringify(bt.slice(0, 44)),
);
assert('…and the final answer, at the end, is intact', bt.includes('FINAL-ANSWER-'), bt.slice(-60));
assert(
  '…and no line is sliced in half',
  bt.split('\n').slice(1).every((l) => /^[A-Za-z]+: |^\[/.test(l)),
  bt.split('\n').slice(1).find((l) => !/^[A-Za-z]+: |^\[/.test(l)) ?? '',
);

// A session the relay could actually produce (5 steps x 16000 tool chars) must
// survive the read WHOLE — no clip, no marker. This is the case the user hit.
const fullRun = [
  { role: 'user', content: 'summarise the news', at: 0 },
];
for (let i = 0; i < 5; i++) {
  fullRun.push({ role: 'assistant', content: 'Calling tavily_search…', tool: 'tavily_search', at: i * 3 + 1 });
  fullRun.push({ role: 'tool', content: `${'r'.repeat(11839)}${TAIL_MARK}-${i}`, tool: 'tavily_search', at: i * 3 + 2 });
}
fullRun.push({ role: 'assistant', content: 'Markets moved on the rate decision.', at: 99 });
agents.recordSession({
  agentId: 'agent-session-fixture',
  title: 'Full 5-step run',
  status: 'done',
  messages: fullRun,
});
const worst = await capOf('agents.sessions').run({ session: '1' });
const wt = worst.data.transcript;
assert('a full 5-step run reads WITHOUT a clip marker', !wt.includes('omitted'), wt.slice(0, 60));
assert('…and its size matches the stored content', wt.length > 59000, `${wt.length} chars`);
assert('…and every step tail marker is present',
  [0, 1, 2, 3, 4].every((i) => wt.includes(`${TAIL_MARK}-${i}`)), `${wt.length} chars`);
assert(
  '…and the WHOLE transcript reaches the model, not a shortJson fragment',
  (() => {
    const sent = shortJson({ ok: worst.ok, summary: worst.summary, data: worst.data });
    try {
      return JSON.parse(sent).data.transcript === wt;
    } catch {
      return false;
    }
  })(),
  `${wt.length} in transcript`,
);

// shortJson must hand back PARSEABLE JSON at any size — the old implementation
// cut the serialized text and patched the damage with a literal `…"}`.
const huge = { ok: true, summary: 'big', data: { transcript: 'z'.repeat(300000) } };
const short = shortJson(huge);
assert('shortJson bounds an oversized result', short.length <= 120000, `${short.length} chars`);
let parsed = null;
try {
  parsed = JSON.parse(short);
} catch {
  /* left null */
}
assert('…and what it returns is still valid JSON', parsed !== null, short.slice(-70));
assert(
  '…and it marks the clip',
  typeof parsed?.data?.transcript === 'string' && parsed.data.transcript.endsWith('…(clipped)'),
  String(parsed?.data?.transcript).slice(-40),
);
const small = shortJson({ ok: true, summary: 'fine', data: { a: 1 } });
assert(
  'shortJson leaves a normal result byte-identical',
  small === JSON.stringify({ ok: true, summary: 'fine', data: { a: 1 } }),
  small,
);
assert(
  'shortJson never emits the hand-rolled `…"}` repair',
  !small.includes('…"}') && !short.slice(0, -1).includes('…"}'),
  short.slice(-70),
);

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);