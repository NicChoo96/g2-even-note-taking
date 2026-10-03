// Verifies the DATA EXPORT, by bundling the real module (no re-implementation)
// and asserting the mapping the backend seed depends on.
//
// Run: node tools/export-sim.mjs   (from `glasses/`)
//
// Why this is worth a harness: the export is a TRANSLATION between two shapes
// that live in different documents — the client's stores here, the Postgres
// tables in docs/data-platform/BACKEND-BUILD-SPEC.md. A translation is exactly
// the kind of code that looks right and is wrong: an ordinal read from the wrong
// array, a `seq` that is off by one, or a secret VALUE that quietly rode along.
// Each of those is invisible by eye, so every rule the module claims is asserted
// directly, negative cases included.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'export-sim-'));
const outfile = join(out, 'export-data.mjs');
await build({
  entryPoints: ['src/web/export-data.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
});
const E = await import(pathToFileURL(outfile).href);

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

// ── Fixtures ────────────────────────────────────────────────────────────────
const hub = {
  activeSection: 'docs',
  activeDocId: 'd2',
  sections: {
    todo: [
      { id: 't1', text: 'milk', done: false },
      { id: 't2', text: 'eggs', done: true },
    ],
    docs: [
      { id: 'd1', title: 'First', content: 'aaa', updatedAt: 1 },
      { id: 'd2', title: 'Second', content: 'bbb', updatedAt: 2 },
    ],
    files: [
      { id: 'f1', title: 'Report', agent: 'g2-hub', url: 'http://x/y', size: 10, updatedAt: 3 },
    ],
    notes: 'a note',
  },
  updatedAt: 99,
};

const agents = {
  tools: [
    { id: 'tool-web', name: 'web_search', kind: 'web', description: 'search', hasToken: false },
    { id: 'tool-http', name: 'crm', kind: 'http', description: 'x', hasToken: true, url: 'http://c' },
  ],
  agents: [
    { id: 'a1', name: 'A', systemPrompt: 's', prompt: 'p', toolIds: ['tool-web', 'tool-http'], createdAt: 5 },
  ],
  llm: { provider: 'openrouter', model: 'store-model', referer: 'store-ref', title: 'store-title', hasKey: true },
  sessions: [
    {
      id: 's1',
      agentId: 'a1',
      title: 'hello',
      status: 'done',
      createdAt: 10,
      updatedAt: 12,
      messages: [
        { role: 'user', content: 'hi', at: 10 },
        { role: 'assistant', content: 'yo', tool: 'web_search', args: '{"q":1}', at: 11 },
      ],
    },
  ],
  sessionsClearedAt: { a1: 7 },
  updatedAt: 12,
};

const ai = { settings: { enabled: true, model: 'ai-model', maxSteps: 9 } };
const memory = {
  version: 1,
  digest: 'DIG',
  digestAt: 77,
  folded: 4,
  turns: [
    { role: 'user', text: 'u', at: 1 },
    { role: 'assistant', text: 'a', at: 2 },
  ],
  updatedAt: 88,
};

const status = {
  ok: true,
  provider: 'deepseek',
  llm: true,
  tavily: true,
  search: { provider: 'brave', configured: true, depth: 'advanced', keys: { tavily: true, brave: false } },
  jev: true,
  files: { configured: true, mode: 'api_key', url: 'http://167.172.77.136', hint: 'set GATEWAY_USER' },
  model: 'resolved-model',
  depth: 'basic',
  fields: { model: 'saved-model', depth: 'advanced', searchProvider: 'brave', referer: 'saved-ref', title: 'saved-title' },
  source: {
    llm: { key: 'settings', openrouterKey: 'env', deepseekKey: 'none' },
    search: { tavilyKey: 'settings', braveKey: 'none' },
    jev: { key: 'env' },
  },
};

const base = {
  hub,
  agents,
  ai,
  memory,
  status,
  email: 'me@example.com',
  deviceId: 'dev-1',
  appVersion: '0.3.40',
  origin: 'http://127.0.0.1:5174',
};

const ledgerRows = [
  {
    seq: 1,
    runId: 'r1',
    at: 3,
    kind: 'ask',
    by: 'wearer',
    effect: 'pure',
    status: 'ok',
    text: 'add milk',
    refs: [],
  },
  {
    seq: 2,
    runId: 'r1',
    at: 4,
    kind: 'call',
    by: 'jarvis',
    effect: 'write',
    status: 'ok',
    text: 'todo.add',
    refs: [1],
    locus: 'client',
    payload: { id: 't1' },
  },
];

const B = E.buildExportBundle({ ...base, includeOwnerCredential: null });

// ── 1. File envelope ────────────────────────────────────────────────────────
check('format tag', B.$format, 'g2-hub-seed');
check('version', B.$version, 1);
check('meta carries the app version', B.meta.appVersion, '0.3.40');
check('meta cites the spec', B.meta.spec.includes('BACKEND-BUILD-SPEC'), true);
assert('meta.generatedAt is ISO', /^\d{4}-\d{2}-\d{2}T/.test(B.meta.generatedAt), B.meta.generatedAt);
check('the file declares itself twice (top level + meta)', [B.meta.format, B.meta.version], ['g2-hub-seed', 1]);

// ── 2. Identity — the token is opt-in and OFF by default ────────────────────
check('email is exported', B.identity.email, 'me@example.com');
check('deviceId is exported', B.identity.deviceId, 'dev-1');
assert('ownerToken is ABSENT by default', !('ownerToken' in B.identity), JSON.stringify(B.identity));
const withTok = E.buildExportBundle({ ...base, includeOwnerCredential: 'deadbeef' });
check('ownerToken appears only when asked for', withTok.identity.ownerToken, 'deadbeef');

// ── 3. Ordinals come from ARRAY POSITION, not from created_at ──────────────
check('todo ordinals', B.collections.todo_item.map((r) => r.ordinal), [0, 1]);
check('document ordinals', B.collections.document.map((r) => r.ordinal), [0, 1]);
check('file_ref ordinals', B.collections.file_ref.map((r) => r.ordinal), [0]);
check('agent_tool ordinals follow toolIds order', B.collections.agent_tool, [
  { agent_id: 'a1', tool_id: 'tool-web', ordinal: 0 },
  { agent_id: 'a1', tool_id: 'tool-http', ordinal: 1 },
]);
check('memory_turn ordinals', B.collections.memory_turn.map((r) => r.ordinal), [0, 1]);

// ── 4. session_message.seq is the index, and messages belong to the session ─
check('one session row', B.collections.jarvis_session.length, 1);
check('seq counts from zero, in order', B.collections.session_message.map((m) => m.seq), [0, 1]);
check(
  'every message points at its session',
  B.collections.session_message.every((m) => m.session_id === 's1'),
  true,
);
check('the tool call survives', [B.collections.session_message[1].tool, B.collections.session_message[1].args], [
  'web_search',
  '{"q":1}',
]);
check('a missing tool/args is null, not undefined (jsonb wants a value)', B.collections.session_message[0].tool, null);
check('turn_count matches the message count', B.collections.jarvis_session[0].turn_count, 2);
check('session kind is agent — the client has no other kind', B.collections.jarvis_session[0].kind, 'agent');
check('sessionsClearedAt becomes a tombstone', B.collections.session_tombstone, [
  { agent_id: 'a1', cleared_at_ms: 7 },
]);
check(
  'status is carried verbatim (the projection normalises stopped, not the seed)',
  B.collections.jarvis_session[0].status,
  'done',
);

// ── 5. Secrets are a MANIFEST — never a value ──────────────────────────────
assert(
  'EVERY app_secret row has value: null',
  B.collections.app_secret.every((s) => s.value === null),
  JSON.stringify(B.collections.app_secret.filter((s) => s.value !== null)),
);
const byKey = Object.fromEntries(B.collections.app_secret.map((s) => [s.key, s]));
check('the active llm key is reported present', byKey['llm'].present, true);
check('its provenance is carried', byKey['llm'].source, 'settings');
check('openrouter is present via its own source', byKey['llm:openrouter'].present, true);
check('deepseek is ABSENT, and says so from its own source', byKey['llm:deepseek'].present, false);
check('brave is absent while tavily is present — both reported, not just the active one', [
  byKey['search:tavily'].present,
  byKey['search:brave'].present,
], [true, false]);
check('the gateway credential is reported', byKey['gateway'].present, true);
check('…with its hint, not its value', byKey['gateway'].hint, 'set GATEWAY_USER');
const toolS = B.collections.app_secret.filter((s) => s.key.startsWith('tool:'));
check('only the tool that EXPECTS a token gets a manifest row', toolS.map((s) => s.key), ['tool:tool-http']);
check('a per-tool token is unknown, never absent', toolS[0].present, null);

// ── 6. The HARD RULE: file_ref is a reference, never a body ────────────────
assert(
  'no file_ref row carries a body/content field',
  B.collections.file_ref.every((r) => !('body' in r) && !('content' in r) && !('html' in r)),
  JSON.stringify(B.collections.file_ref),
);
check('a file_ref row is exactly the reference columns', Object.keys(B.collections.file_ref[0]), [
  'id',
  'title',
  'agent',
  'url',
  'size',
  'updated_at_ms',
  'ordinal',
]);

// ── 7. app_setting reads the SAVED values, never the resolved ones ─────────
const setting = Object.fromEntries(B.collections.app_setting.map((s) => [s.key, s.value]));
check('model is the SAVED model, not the relay-resolved one', setting.model, 'saved-model');
check('depth is the saved depth', setting.depth, 'advanced');
check('the saved searchProvider is preserved (so auto is not frozen into a pin)', setting.searchProvider, 'brave');
check('an empty value is omitted rather than written as blank', 'nothing' in setting, false);
check('llm_settings.provider is the ACTIVE provider', B.collections.llm_settings.provider, 'deepseek');
check('llm_settings.model is the saved model too', B.collections.llm_settings.model, 'saved-model');

// ── 8. The client-local AI settings are NOT server settings ────────────────
check('ai settings are exported under client_local', B.client_local.ai_settings, ai.settings);
check(
  '…and do not leak into app_setting',
  B.collections.app_setting.some((s) => s.key === 'maxSteps' || s.key === 'enabled'),
  false,
);

// ── 9. Memory: every turn, plus a v1 digest ────────────────────────────────
check('all memory turns are exported', B.collections.memory_turn.map((t) => t.text), ['u', 'a']);
check('the digest is versioned v1', B.collections.memory_digest, [
  { version: 1, digest: 'DIG', at_ms: 77 },
]);

// ── 10. The ledger is OPT-IN and its absence is stated ─────────────────────
check('ledger_entry is empty when not requested', B.collections.ledger_entry, []);
assert(
  'the file says WHY it is empty',
  B.warnings.some((w) => w.startsWith('ledger_entry is EMPTY because it was not requested')),
  B.warnings.join(' | '),
);
const withLedger = E.buildExportBundle({ ...base, ledger: ledgerRows });
check('ledger rows are exported when asked for', withLedger.collections.ledger_entry.length, 2);
check('a ledger row keeps its causal parents', withLedger.collections.ledger_entry[1].refs, [1]);
check('…and its payload', withLedger.collections.ledger_entry[1].payload, { id: 't1' });
check('…and its locus', withLedger.collections.ledger_entry[1].locus, 'client');
check('an absent locus is null, not undefined', withLedger.collections.ledger_entry[0].locus, null);
assert(
  'and the file says the ledger is transient',
  withLedger.warnings.some((w) => w.includes('TRANSIENT')),
  withLedger.warnings.join(' | '),
);

// ── 11. An unreachable relay is REPORTED, not hidden ───────────────────────
const offline = E.buildExportBundle({ ...base, status: null });
check(
  'with no relay, presence is unknown rather than absent',
  offline.collections.app_secret.find((s) => s.key === 'llm').present,
  null,
);
assert(
  'and the file says so',
  offline.warnings.some((w) => w.includes('relay did not answer')),
  offline.warnings.join(' | '),
);
assert('a null status still exports the hub data', offline.collections.document.length === 2);

// ── 12. A fresh install exports an empty seed, not an error ────────────────
const empty = E.buildExportBundle({
  hub: { activeSection: 'todo', activeDocId: null, sections: { todo: [], docs: [], files: [], notes: '' }, updatedAt: 0 },
  agents: { tools: [], agents: [], llm: { provider: 'openrouter', model: '' }, sessions: [], updatedAt: 0 },
  ai: { settings: { enabled: true, model: '', maxSteps: 6 } },
  memory: { version: 1, digest: '', digestAt: 0, folded: 0, turns: [], updatedAt: 0 },
  status: null,
  email: null,
  deviceId: null,
  appVersion: null,
  origin: 'http://x',
});
check('no email means no app_user row', empty.collections.app_user, []);
check('empty collections are empty arrays', [
  empty.collections.document.length,
  empty.collections.tool.length,
  empty.collections.session_message.length,
], [0, 0, 0]);
check('the note row still exists (it is a singleton)', typeof empty.collections.note.content, 'string');
check('hub_state is still one row', empty.counts.hub_state, 1);
assert('nothing threw', true);

// ── 13. Counts describe the collections they claim to ─────────────────────
check('session_message count matches the rows', B.counts.session_message, B.collections.session_message.length);
check('memory_turn count matches the rows', B.counts.memory_turn, B.collections.memory_turn.length);
check('app_secret count includes the per-tool rows', B.counts.app_secret, B.collections.app_secret.length);
assert(
  'every collection is counted',
  Object.keys(B.collections).every((k) => typeof B.counts[k] === 'number'),
  Object.keys(B.collections).filter((k) => typeof B.counts[k] !== 'number').join(','),
);

// ── 14. The import notes the backend will read ─────────────────────────────
assert('the non-UUID id hazard is stated', B.warnings.some((w) => w.includes('NOT UUIDs')));
assert('the secret gap is stated', B.warnings.some((w) => w.includes('MANIFEST')));
assert('the no-body rule is stated', B.warnings.some((w) => w.includes('REFERENCES only')));
assert('the session cap is stated', B.warnings.some((w) => w.includes('MAX_SESSIONS')));
assert('the ms-epoch rule is stated', B.warnings.some((w) => w.includes('ms-epoch')));

// ── 15. Naming, sizing, and the download failure path ──────────────────────
const name = E.exportFilename(new Date('2026-09-30T14:12:07').getTime());
check('filename is sortable and zero-padded', name, 'g2-hub-seed-2026-09-30-141207.json');
check('bytes', [E.formatBytes(512), E.formatBytes(2048), E.formatBytes(3 * 1024 * 1024)], [
  '512 B',
  '2.0 kB',
  '3.0 MB',
]);
const text = E.serializeBundle(B);
assert('the serialisation is indented, readable JSON', text.startsWith('{\n  "'), text.slice(0, 12));
assert('…and round-trips', JSON.parse(text).$format === 'g2-hub-seed');
// No DOM here, so the download must FAIL LOUDLY (null) rather than silently
// claiming success — that is what makes the panel offer the clipboard instead.
check('downloadJson returns null when the WebView cannot download', E.downloadJson('x.json', text), null);

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);
