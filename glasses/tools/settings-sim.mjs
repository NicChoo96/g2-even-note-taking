#!/usr/bin/env node
// Settings-panel harness.
//
// WHY THIS EXISTS — two reported bugs, one shared cause:
//
//   1. "when I click the web-search provider to Brave Search, why does it also
//      switch my LLM model to ling?" It did. One POST carried two settings that
//      have nothing to do with each other:
//        • `save()` sent `model` whenever the relay's environment did not own
//          it, so the model rode along with EVERY save. Its displayed value is
//          the EFFECTIVE model whenever the wearer has not typed anything, so
//          "the model" on the wire was whatever the field happened to show —
//          including DEFAULT_MODEL (`…ling…`) before the first status fetch.
//        • the same save then wrote that value into the SYNCED agents store,
//          which is the half the glasses feel, because a run sends the STORE's
//          model.
//
//   2. "each field should be decoupled … the fields in settings should reside
//      [prevail]." They were not: a field the environment supplied was rendered
//      as a LOCKED row instead of an input, so the environment was the single
//      source of truth and the page was decorative for half its own fields.
//
//   A React component hides that class of bug: the coupling is spread across a
//   state hook, an effect, an async fetch and a click handler, and it only shows
//   up as a value changing on hardware. So the decision now lives in a pure
//   function (`buildSettingsSave`) and this asserts INDEPENDENCE exhaustively:
//   for every field, changing it must add exactly its own key to the patch and
//   nothing else's.
//
// Run: node tools/settings-sim.mjs
//
// §10 additionally reads the relay source, because the page's precedence is only
// real if the process that stores the value agrees with it.

import { readFileSync } from 'node:fs';
import { buildSettingsSave, settingsBody } from '../src/web/settings-patch.ts';

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const has = (label, hay, needle) => assert(label, hay.includes(needle), needle);
const lacks = (label, hay, needle) => assert(label, !hay.includes(needle), needle);

const panelSrc = readFileSync(new URL('../src/web/SettingsPanel.tsx', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('../src/web/agents-client.ts', import.meta.url), 'utf8');
const relaySrc = readFileSync(new URL('../../web/server/local-sse.mjs', import.meta.url), 'utf8');

/** Every field at rest: nothing typed, nothing saved. */
const resting = () => ({
  model: { value: '', touched: false },
  depth: { value: 'basic' },
  title: { value: '' },
  openrouterKey: { value: '' },
  deepseekKey: { value: '' },
  tavilyKey: { value: '' },
  braveKey: { value: '' },
  searchProvider: { value: '' },
  referer: { value: '' },
});

const keys = (o) => Object.keys(o).sort();

/** Fields that are always sent, because a blank value IS their value. */
const ALWAYS = ['depth', 'title', 'searchProvider', 'referer'];
const BASE_KEYS = keys(buildSettingsSave(resting()).patch);

/** One override per field, and the value it should land as. */
const OVERRIDES = {
  depth: { value: 'advanced' },
  title: { value: 'My Title' },
  searchProvider: { value: 'brave' },
  referer: { value: 'https://x.example' },
  openrouterKey: { value: 'sk-or-v1-aaaa' },
  deepseekKey: { value: 'sk-ds-aaaa' },
  tavilyKey: { value: 'tvly-aaaa' },
  braveKey: { value: 'BSAaaaa' },
  model: { value: 'deepseek-chat', touched: true },
};

// ── 1. The builder is the single decision point ──────────────────────────────
console.log('\n§1  patch builder');
{
  const save = buildSettingsSave(resting());
  assert('resting state sends the four fields whose blank value is meaningful', keys(save.patch).join(',') === ALWAYS.slice().sort().join(','), keys(save.patch).join(','));
  lacks('resting state sends no model', JSON.stringify(save.patch), '"model"');
  lacks('resting state sends no API key', JSON.stringify(save.patch), 'Key"');
  assert('resting state clears nothing', save.clear.length === 0, JSON.stringify(save.clear));
  assert('the builder is the only source of the body', settingsBody(save).depth === 'basic');
}

// ── 2. THE FIRST BUG: one field must never move another ──────────────────────
console.log('\n§2  the reported coupling');
{
  const i = resting();
  i.searchProvider = { value: 'brave' };
  const save = buildSettingsSave(i);
  assert('switching to Brave sends searchProvider', save.patch.searchProvider === 'brave', JSON.stringify(save.patch));
  lacks('switching to Brave does NOT send a model', JSON.stringify(save.patch), '"model"');
}
{
  // The exact reported shape: the field is showing a model nobody chose, because
  // the status fetch has not landed yet. It must not be sent as an edit.
  const i = resting();
  i.model = { value: 'inclusionai/ling-3.0-flash-sante:free', touched: false };
  i.searchProvider = { value: 'brave' };
  const save = buildSettingsSave(i);
  assert('an UNTOUCHED ling value is not an edit', !('model' in save.patch), JSON.stringify(save.patch));
  assert('and the provider still moves', save.patch.searchProvider === 'brave');
  assert('and nothing is cleared', save.clear.length === 0);
}
{
  const i = resting();
  i.searchProvider = { value: 'tavily' };
  lacks('switching to Tavily does NOT send a model', JSON.stringify(buildSettingsSave(i).patch), '"model"');
}
{
  const i = resting();
  i.depth = { value: 'advanced' };
  i.tavilyKey = { value: 'tvly-aaaa' };
  i.title = { value: 'Hub' };
  lacks('a depth+key+title save does NOT send a model', JSON.stringify(buildSettingsSave(i).patch), '"model"');
}

// ── 3. …while an EDITED model still works ───────────────────────────────────
console.log('\n§3  an edited model still moves');
{
  const i = resting();
  i.model = { value: 'deepseek-chat', touched: true };
  const save = buildSettingsSave(i);
  assert('an edited model is sent', save.patch.model === 'deepseek-chat', JSON.stringify(save.patch));
  assert('editing the model leaves the provider alone', save.patch.searchProvider === '', JSON.stringify(save.patch));
}
{
  const i = resting();
  i.model = { value: '  ', touched: true };
  const save = buildSettingsSave(i);
  lacks('blanking the model does not store an empty string', JSON.stringify(save.patch), '"model"');
  has('blanking the model clears it instead', JSON.stringify(save.clear), '"model"');
}
{
  const i = resting();
  i.model = { value: 'deepseek-chat', touched: true };
  i.depth = { value: 'advanced' };
  const save = buildSettingsSave(i);
  assert('model and depth travel together when both are edited', save.patch.model === 'deepseek-chat' && save.patch.depth === 'advanced');
}

// ── 4. EXHAUSTIVE DECOUPLING: one field in, one key out ─────────────────────
console.log('\n§4  every field is decoupled from every other');
for (const [name, override] of Object.entries(OVERRIDES)) {
  const i = resting();
  i[name] = { ...i[name], ...override };
  const save = buildSettingsSave(i);
  const added = keys(save.patch).filter((k) => !BASE_KEYS.includes(k));
  const expected = BASE_KEYS.includes(name) ? [] : [name];
  assert(
    `${name} adds only its own key`,
    added.join(',') === expected.join(','),
    `added=[${added.join(',')}] expected=[${expected.join(',')}]`,
  );
  assert(
    `${name} lands at its own value`,
    save.patch[name] === override.value,
    `${save.patch[name]}`,
  );
  assert(`${name} clears nothing`, save.clear.length === 0, JSON.stringify(save.clear));
}
{
  // And the same statement from the other side: change EVERY field at once and
  // the patch must be exactly the fields that were set, no more and no fewer.
  const i = resting();
  for (const [name, override] of Object.entries(OVERRIDES)) i[name] = { ...i[name], ...override };
  const save = buildSettingsSave(i);
  assert(
    'all nine fields set => exactly nine keys, nothing extra',
    keys(save.patch).join(',') === Object.keys(OVERRIDES).sort().join(','),
    keys(save.patch).join(','),
  );
}

// ── 5. A blank key is not an edit, but IS a clear when asked ────────────────
console.log('\n§5  write-only fields');
{
  const i = resting();
  i.tavilyKey = { value: '   ' };
  const save = buildSettingsSave(i);
  lacks('a blank key is not sent', JSON.stringify(save.patch), 'tavilyKey');
  assert('a blank key is not silently a clear', save.clear.length === 0, JSON.stringify(save.clear));
}
{
  const i = resting();
  i.braveKey = { value: '  BSAaaaa  ' };
  assert('a typed key is trimmed and sent', buildSettingsSave(i).patch.braveKey === 'BSAaaaa');
}
{
  const save = buildSettingsSave(resting());
  assert('an empty clear list is omitted from the body', !('clear' in settingsBody(save)));
  const withClear = { ...save, clear: ['tavilyKey'] };
  assert('a non-empty clear list is carried', JSON.stringify(settingsBody(withClear).clear) === '["tavilyKey"]');
}

// ── 6. The panel wires the builder and seeds itself from the relay ──────────
console.log('\n§6  panel wiring');
has('the panel calls buildSettingsSave', panelSrc, 'buildSettingsSave({');
has('the panel sends the folded body', panelSrc, 'settingsBody(save) as SettingsPatch');
has('the model tracks an explicit edit', panelSrc, 'touched: modelTouched');
has('an edited model updates the synced store', panelSrc, 'llm: { ...s.llm, model: edited }');
has('the store write is gated on the edit', panelSrc, 'if (modelTouched) {');
has('the model box shows the effective value', panelSrc, 'value={shownModel}');
has('typing in the model box marks it edited', panelSrc, 'setModelTouched(true)');
has('the depth field is seeded from the relay value', panelSrc, 's.fields?.depth ??');
// Anchored on single lines: the panel file is CRLF, so an anchor spanning a
// line break will not match the LF form no matter how exact it looks.
has('the provider field reads the SAVED setting', panelSrc, '? s.fields.searchProvider');
has('the provider field falls back for an older relay', panelSrc, ': s.source?.search?.provider === ');
has('the referer field is seeded from the relay', panelSrc, "setReferer(s.fields?.referer ?? '')");
has('the title field is seeded from the relay', panelSrc, "setTitle(s.fields?.title ?? 'G2 Even Reality Hub')");
has('a saved value can be removed explicitly', panelSrc, 'toggleClear');
has('the clear list joins the save', panelSrc, 'for (const name of clearFields)');
has('a note explains each field\'s fallback', panelSrc, '<FieldNote');
has('the page says nothing is locked', panelSrc, 'Nothing here is locked');
has('the model suggestions lead with the active provider', panelSrc, "provider === 'deepseek' ? [...DEEPSEEK_MODELS, ...FREE_TOOL_MODELS]");
has('a saved model the provider cannot serve is flagged', panelSrc, "!effectiveModel.toLowerCase().startsWith('deepseek')");

// ── 7. Every field is an EDITABLE control ──────────────────────────────────
console.log('\n§7  no field is locked by the environment');
lacks('no key is replaced by a lock notice', panelSrc, 'locked-field');
lacks('no provider select is disabled by env', panelSrc, 'disabled={searchProviderFromEnv}');
lacks('no depth select is disabled by env', panelSrc, 'disabled={depthFromEnv}');
lacks('no title input is disabled by env', panelSrc, 'disabled={titleFromEnv}');
lacks('no model input is disabled by env', panelSrc, 'disabled={modelFromEnv}');
lacks('the env lock flags are gone', panelSrc, 'openrouterFromEnv');
lacks('the "environment always wins" banner is gone', panelSrc, 'the environment always wins');
has('the provider select is still gated on relay CAPABILITY', panelSrc, 'disabled={!relaySupportsProvider}');
{
  // Each of the four keys must render a real password input.
  const inputs = panelSrc.match(/type="password"/g) ?? [];
  assert('all four API keys are real inputs', inputs.length === 4, `${inputs.length}`);
}

// ── 8. The buggy shapes stay gone ──────────────────────────────────────────
console.log('\n§8  the old shapes do not come back');
lacks('the patch is not built inline from `model`', panelSrc, 'patch.model = model');
lacks('the model is not guarded by env ownership', panelSrc, '!modelFromEnv) patch.model');
lacks('the model state is not seeded with the default', panelSrc, 'useState(DEFAULT_MODEL)');
lacks('the model is not re-seeded from the relay slot into the draft', panelSrc, 'setModel(s.model || DEFAULT_MODEL)');
lacks('the store subscription does not feed the model box', panelSrc, 'subscribeAgents(() => setModel(');
lacks('an unedited model is not written to the store', panelSrc, 'llm: { ...s.llm, model }');
lacks('no save-everything model key', panelSrc, 'model: { value: model, touched: false');
lacks('the relay does not let the environment win the model', relaySrc, 'model: envModel || fileModel');
lacks('the relay does not let the environment win the key', relaySrc, 'key: envKey || fileKey');
lacks('the relay does not pick the provider from the env first', relaySrc, 'picked(envProvider) || picked(fileProvider)');

// ── 9. A stale relay is distinguished from a broken one ────────────────────
console.log('\n§9  older-relay guards');
has('a missing search block is detected as capability', panelSrc, 'relaySupportsProvider = search !== undefined');
has('and explained rather than acted on', panelSrc, '!relaySupportsProvider');
has('a relay too old to report keys is not read as "no keys"', panelSrc, 'searchKeysKnown');
has('the missing-key warning requires the report', panelSrc, 'searchKeysKnown &&');

// ── 10. The relay agrees: settings first, per field ───────────────────────
console.log('\n§10  relay precedence and the new routes');
has('the relay reports the non-secret field values', relaySrc, 'fields: {');
has('it reports the SAVED provider', relaySrc, 'searchProvider: ws.setting');
has('it accepts an explicit clear list', relaySrc, 'Array.isArray(body?.clear)');
has('clear is whitelisted against the known fields', relaySrc, '!(name in map)');
has('the model prefers the saved value', relaySrc, 'model: fileModel || envModel || defaultModel');
has('the key prefers the saved value', relaySrc, 'key: fileKey || envKey || \'\'');
has('the provider prefers the saved value', relaySrc, 'const chosen = picked(fileProvider) || picked(envProvider);');
has('the depth prefers the saved value', relaySrc, 'depth: secrets.depth || envDepth || \'basic\'');
has('the tavily key prefers the saved value', relaySrc, "tavilyKey: tavilyFile ? 'settings' : tavilyEnv ? 'env' : 'none'");
has('the referer prefers the saved value', relaySrc, "referer: secrets.referer || envReferer || ''");
has('the title prefers the saved value', relaySrc, "title: secrets.title || envTitle || 'G2 Even Reality Hub'");
has('the client contract carries the field values', clientSrc, 'fields?: {');
has('the client contract carries the clear list', clientSrc, 'clear?: string[]');
lacks('the client no longer claims env locks an input', clientSrc, 'so the UI can lock env-managed inputs');
has('the client says env is a fallback', clientSrc, 'does NOT lock its input');

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}`);
process.exitCode = fail === 0 ? 0 : 1;
