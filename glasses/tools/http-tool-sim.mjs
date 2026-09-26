#!/usr/bin/env node
// Generic REST tool harness.
//
// WHY THIS EXISTS:
//   A REST tool has two halves that used to live on opposite sides of the relay:
//   the schema the model is OFFERED, and the body the executor SENDS. They
//   disagreed — the schema advertised `{ body: { ... } }` while the executor sent
//   the arguments flat — so a model that followed the schema faithfully produced
//   a request one level too deep for any endpoint that wanted the properties at
//   the top. Nothing failed loudly; the endpoint just got `{"body":{...}}`.
//
//   Then there was the second half of the problem: with no way to describe a
//   tool's parameters, the model had to invent them. `bodyTemplate` is that
//   description, and its keys are the contract.
//
//   So this asserts the two halves are derived from ONE description (`http-tool.mjs`)
//   and cannot drift again, that an authored template becomes exactly the
//   parameters it names (with empty values marked required and filled values
//   carried as defaults), that the old wrapped shape is still unwrapped, that a
//   garbage template degrades instead of throwing, and that the relay does not
//   quietly rebuild either half by hand.
//
// Run: node tools/http-tool-sim.mjs

import { readFileSync } from 'node:fs';
import { httpRequestArgs, httpToolSchema, parseBodyTemplate } from '../../web/server/http-tool.mjs';

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  assert(
    label,
    got === want,
    got === want ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
  );
const deepEq = (label, got, want) =>
  eq(label, JSON.stringify(got), JSON.stringify(want));

const relaySrc = readFileSync(new URL('../../web/server/local-sse.mjs', import.meta.url), 'utf8');
const panelSrc = readFileSync(new URL('../src/web/AgentsPanel.tsx', import.meta.url), 'utf8');
const typesSrc = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

const httpTool = (bodyTemplate) => ({
  id: 'tool-x',
  name: 'weather',
  description: 'Look up the weather.',
  kind: 'http',
  url: 'https://api.example.com/weather',
  method: 'POST',
  bodyTemplate,
});

// ── 1. The template parser is total ─────────────────────────────────────────
console.log('\n§1  parseBodyTemplate never throws');
deepEq('a missing tool is no template', parseBodyTemplate(undefined), {});
deepEq('no bodyTemplate is no template', parseBodyTemplate({ kind: 'http' }), {});
deepEq('blank string is no template', parseBodyTemplate({ bodyTemplate: '   ' }), {});
deepEq('non-string is no template', parseBodyTemplate({ bodyTemplate: 42 }), {});
deepEq('unparseable JSON degrades to {}', parseBodyTemplate({ bodyTemplate: '{ "a": ' }), {});
deepEq('an array is not a body', parseBodyTemplate({ bodyTemplate: '[1,2]' }), {});
deepEq('a scalar is not a body', parseBodyTemplate({ bodyTemplate: '"hello"' }), {});
deepEq('null literal is not a body', parseBodyTemplate({ bodyTemplate: 'null' }), {});
deepEq('a real object parses', parseBodyTemplate({ bodyTemplate: '{"query": ""}' }), { query: '' });

// ── 2. No template → the legacy free-form body ──────────────────────────────
console.log('\n§2  no template keeps the free-form `body`');
const bare = httpToolSchema(httpTool(undefined));
eq('schema is a function schema', bare.type, 'function');
eq('name comes from the tool', bare.function.name, 'weather');
eq('description comes from the tool', bare.function.description, 'Look up the weather.');
deepEq('offers exactly one `body` property', Object.keys(bare.function.parameters.properties), ['body']);
eq('`body` is an object', bare.function.parameters.properties.body.type, 'object');
deepEq('nothing is required', bare.function.parameters.required, []);
eq('unnamed tool falls back to http_tool', httpToolSchema({ kind: 'http' }).function.name, 'http_tool');
eq(
  'undescribed tool falls back to the generic blurb',
  httpToolSchema({ kind: 'http' }).function.description,
  'Call an external HTTP API.',
);

// ── 3. A template IS the parameter list ─────────────────────────────────────
console.log('\n§3  a template becomes the model-facing parameters');
const tpl = httpTool('{"query": "", "limit": 5, "exact": true, "tags": [], "opts": {}, "ratio": 1.5}');
const schema = httpToolSchema(tpl);
const props = schema.function.parameters.properties;
deepEq(
  'one property per template key, in authored order',
  Object.keys(props),
  ['query', 'limit', 'exact', 'tags', 'opts', 'ratio'],
);
eq('an empty string is a string', props.query.type, 'string');
eq('an integer default is an integer', props.limit.type, 'integer');
eq('a boolean default is a boolean', props.exact.type, 'boolean');
eq('an array default is an array', props.tags.type, 'array');
eq('an object default is an object', props.opts.type, 'object');
eq('a fractional default is a number', props.ratio.type, 'number');
assert(
  'an empty value is described as required of the model',
  props.query.description.includes('must supply "query"'),
  props.query.description,
);
assert(
  'a filled value is described as an overridable default',
  props.limit.description.includes('omit to use the configured default'),
  props.limit.description,
);
deepEq('an empty value lands in required', schema.function.parameters.required, ['query']);
assert(
  'a filled value does not land in required',
  !schema.function.parameters.required.includes('limit'),
);

// null means the same thing as "" — the model must decide.
deepEq(
  'a null default is required too',
  httpToolSchema(httpTool('{"a": null}')).function.parameters.required,
  ['a'],
);

// ── 4. Defaults layer UNDER the model's arguments ───────────────────────────
console.log('\n§4  httpRequestArgs merges template under arguments');
deepEq(
  'the template survives when the model sends nothing',
  httpRequestArgs(tpl, {}),
  { query: '', limit: 5, exact: true, tags: [], opts: {}, ratio: 1.5 },
);
deepEq(
  'the model overrides a default',
  httpRequestArgs(tpl, { limit: 20 }),
  { query: '', limit: 20, exact: true, tags: [], opts: {}, ratio: 1.5 },
);
deepEq(
  'the model cannot add a key the template did not name',
  Object.keys(httpRequestArgs(httpTool('{"query": ""}'), { query: 'x', evil: 1 })),
  ['query', 'evil'],
);
deepEq(
  'an unnamed template passes the arguments straight through',
  httpRequestArgs(httpTool(undefined), { a: 1 }),
  { a: 1 },
);
deepEq('null arguments are safe', httpRequestArgs(tpl, null), { query: '', limit: 5, exact: true, tags: [], opts: {}, ratio: 1.5 });
deepEq('array arguments are ignored', httpRequestArgs(httpTool(undefined), [1, 2]), {});

// ── 5. The legacy wrapped shape is unwrapped ────────────────────────────────
console.log('\n§5  the old `{ body: { ... } }` shape still works');
deepEq(
  'a wrapped body is flattened',
  httpRequestArgs(httpTool(undefined), { body: { a: 1 } }),
  { a: 1 },
);
deepEq(
  'the template still layers under a wrapped body',
  httpRequestArgs(httpTool('{"limit": 5}'), { body: { limit: 20 } }),
  { limit: 20 },
);
deepEq(
  'a non-object body is not treated as a wrapper',
  httpRequestArgs(httpTool(undefined), { body: 'text' }),
  { body: 'text' },
);
deepEq(
  'an array body is not treated as a wrapper',
  httpRequestArgs(httpTool(undefined), { body: [1] }),
  { body: [1] },
);

// ── 6. Schema and executor cannot drift ─────────────────────────────────────
console.log('\n§6  both halves come from this module');
assert(
  'toolSchemaFor delegates instead of rebuilding the schema',
  /return httpToolSchema\(t\);/.test(relaySrc),
);
assert(
  'the hand-rolled `body` schema is gone from the relay',
  !/JSON request body \/ query parameters/.test(relaySrc),
);
assert('runToolOnce merges through httpRequestArgs', /httpRequestArgs\(tool, args\)/.test(relaySrc));
assert('the /api/tool proxy merges through httpRequestArgs', /httpRequestArgs\(body, args\)/.test(relaySrc));
assert(
  'the relay imports both helpers',
  /import \{ httpRequestArgs, httpToolSchema \} from '\.\/http-tool\.mjs'/.test(relaySrc),
);
assert(
  'the executor still refuses a non-https url',
  /tool url must be https:\/\//.test(relaySrc),
);

// ── 7. The UI can author one ────────────────────────────────────────────────
console.log('\n§7  the panel can describe the tool');
assert('ToolDef carries a body template', /bodyTemplate\?: string/.test(typesSrc));
assert('the editor writes it', /patch\(\{ bodyTemplate: e\.target\.value \}\)/.test(panelSrc));
assert('the editor validates it live', /is not valid JSON/.test(panelSrc));
assert(
  'the editor tells the truth about an unparseable template',
  /must be a JSON object, e\.g\./.test(panelSrc),
);
assert('GET is labelled as query parameters', /Query parameters \(JSON\)/.test(panelSrc));
assert('POST is labelled as a request body', /Request body \(JSON\)/.test(panelSrc));

// ── 8. ONE chip row, not two selectors ──────────────────────────────────────
console.log('\n§8  the two chip sets are one');
const chipRowCount = (panelSrc.match(/className="chip-row"/g) || []).length;
assert('the agent editor renders a chip row', chipRowCount >= 1, `count=${chipRowCount}`);
assert(
  'the seed kinds are chips in that row, not a second button row',
  /\+ \{s\.label\}/.test(panelSrc),
);
assert('the jev seed is still reachable by name', /addJevToAgent/.test(panelSrc));
assert('the jev option survives in the kind select', /<option value="jev">/.test(panelSrc));
assert(
  'the jev readiness sentence survives',
  /reports that it was skipped rather than guessing/.test(panelSrc),
);
assert(
  'a kind the catalogue already holds is not offered again as a seed',
  /seedChips\.filter\(\(s\) => !state\.tools\.some\(\(t\) => t\.kind === s\.kind\)\)/.test(panelSrc),
);
const docsActionRows = (panelSrc.match(/className="docs-actions"/g) || []).length;
assert('action rows elsewhere are untouched', docsActionRows >= 1, `count=${docsActionRows}`);
// The agent editor itself is the thing that had two selectors. Slice it out and
// assert it now holds exactly one chip row and no button row of its own.
const editorSrc = panelSrc.slice(
  panelSrc.indexOf('function AgentEditor'),
  panelSrc.indexOf('function ToolEditor'),
);
eq('the agent editor has one chip row', (editorSrc.match(/className="chip-row"/g) || []).length, 1);
eq('the agent editor has no second tool button row', (editorSrc.match(/className="docs-actions"/g) || []).length, 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
