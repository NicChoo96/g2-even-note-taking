#!/usr/bin/env node
// Pseudo tool-call markup scrubber harness — and the LOCKSTEP test.
//
// WHY THIS EXISTS
//   Agents whose runs used all of their steps ended with machine syntax as their
//   FINAL ANSWER on the glasses:
//
//     <|DSML|tool_calls> <|DSML|invoke name="tavily_search">
//     <|DSML|parameter name="query" string="true">top headlines</|DSML|parameter>
//
//   DeepSeek emits its native tool-call grammar as PLAIN TEXT when the model
//   wants a tool but the request declared none. The relay's "Summarising…" turn
//   did exactly that: `tools: []` over a transcript that still held `tool_calls`.
//   `tool_choice: 'none'` does NOT stop it — that was probed live against
//   deepseek-flash and it leaked anyway, so the transcript is rebuilt without
//   tool scaffolding at every such call site and this scrubber catches the rest.
//
// TWO IMPLEMENTATIONS, ONE TRUTH
//   The scrubber ships twice — web/server/tool-markup.mjs (zero-build Node ESM,
//   used by the relay) and src/ai/tool-markup.ts (bundled into the WebView).
//   They cannot share a module: the deploy image only copies glasses/, and the
//   relay is never bundled. So this harness feeds the SAME fixtures to BOTH and
//   fails if a single byte differs. Edit one, and this harness tells you.
//
// The fixtures use the REAL byte sequence captured from the API: U+FF5C
// (FULLWIDTH VERTICAL LINE) doubled around a literal `DSML`. They are written as
// escapes so this file stays ASCII and no editor can fold them into pipe glyphs.
//
// Run: node tools/tool-markup-sim.mjs

import { build } from 'esbuild';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const QUIET = !!process.env.SIM_QUIET;
let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  if (cond && QUIET) return;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  if (ok && QUIET) return;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};

// ── The real machine syntax, built from escapes ─────────────────────────────
// Byte-for-byte what the API returned: `<` U+FF5C U+FF5C `DSML` U+FF5C U+FF5C
// ` ` name `>`. Only the name varies.
const B = '\uFF5C\uFF5C';
const D = (rest) => `<${B}DSML${B} ${rest}>`;
const DC = (rest) => `</${B}DSML${B} ${rest}>`;
const PCLOSE = DC('parameter'); // the value ends with `</|DSML| parameter>`

/** Fixture: a full DSML call block, exactly as deepseek-flash printed it. */
const DSML_BLOCK = [
  D('tool_calls'),
  D('invoke name="tavily_search"'),
  D('parameter name="query" string="true"') + 'top headlines today' + PCLOSE,
  D('invoke name="tavily_search"'),
  D('parameter name="query" string="true"') + 'latest breaking news' + PCLOSE,
  DC('invoke'),
  DC('tool_calls'),
].join('\n');

const FIXTURES = [
  {
    name: 'real capture: prose then a DSML block',
    input: 'The search returned a placeholder result, so let me try again with more specific queries.\n\n' + DSML_BLOCK,
    want: 'The search returned a placeholder result, so let me try again with more specific queries.',
    markup: true,
  },
  {
    name: 'DSML only — no prose to keep',
    input: DSML_BLOCK,
    want: '',
    markup: true,
  },
  {
    name: 'streamed/truncated DSML (no closing token)',
    input: 'Searching now.\n' + D('tool_calls') + '\n' + D('invoke name="tavily_search"'),
    want: 'Searching now.',
    markup: true,
  },
  {
    name: 'prose AFTER the block is kept too',
    input: DSML_BLOCK + '\n\nSorry, I could not reach the web.',
    want: 'Sorry, I could not reach the web.',
    markup: true,
  },
  {
    name: 'legacy ASCII <tool_call> block',
    input:
      'I\'ll search for the latest headlines right now.\n\n<tool_call>\n{"name": "tavily_search", "arguments": {"query": "top news headlines today"}}\n</tool_call>',
    want: "I'll search for the latest headlines right now.",
    markup: true,
  },
  {
    name: 'legacy ASCII-pipe DSML (<|tool▁calls▁begin|>)',
    input:
      'Let me look that up.\n<|tool\u2581calls\u2581begin|>\n<|invoke name="tavily_search"|>\n<|parameter name="query"|>news<|parameter|>\n<|invoke|>\n<|tool\u2581calls\u2581end|>',
    want: 'Let me look that up.',
    markup: true,
  },
  {
    name: 'ASCII pipe wrapping the DSML word (<|DSML| tool_calls|>)',
    input: 'One moment.\n<|DSML| tool_calls|>\n<|DSML| invoke name="tavily_search"|>',
    want: 'One moment.',
    markup: true,
  },
  {
    name: 'a bare call body whose tags were lost',
    input: '{"name":"tavily_search","arguments":{"query":"news"}}',
    want: '',
    markup: true,
  },
  { name: 'plain prose is untouched', input: 'Added milk to your shopping list.', want: 'Added milk to your shopping list.', markup: false },
  {
    name: 'ordinary comparison operators are not markup',
    input: 'Cost is < 5 USD and 3 > 2. See https://example.com/a?b=1&c=2.',
    want: 'Cost is < 5 USD and 3 > 2. See https://example.com/a?b=1&c=2.',
    markup: false,
  },
  { name: 'empty and null inputs are safe', input: '', want: '', markup: false },
  {
    name: 'runs of blank lines collapse',
    input: 'First line.\n\n\n\n   Second line.   ',
    want: 'First line.\nSecond line.',
    markup: false,
  },
];

// ── Load the WebView build (bundled on the fly) ─────────────────────────────
const out = mkdtempSync(join(tmpdir(), 'tool-markup-sim-'));
const outfile = join(out, 'tool-markup.mjs');
await build({
  stdin: { contents: `export * from './ai/tool-markup.ts';`, resolveDir: 'src', loader: 'ts', sourcefile: 'entry.ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
});
const web = await import(pathToFileURL(outfile).href);
const server = await import(pathToFileURL(resolve('..', 'web/server/tool-markup.mjs')).href);

console.log('── 1. the two implementations agree, fixture by fixture ──');
for (const f of FIXTURES) {
  let a, b, err = '';
  try {
    a = web.stripToolMarkup(f.input);
  } catch (e) {
    err = `web threw: ${e.message}`;
  }
  try {
    b = server.stripToolMarkup(f.input);
  } catch (e) {
    err = `server threw: ${e.message}`;
  }
  assert(`[${f.name}] both agree${err ? ` — ${err}` : ''}`, !err && a === b, `web=${JSON.stringify(a)} server=${JSON.stringify(b)}`);
}

console.log('\n── 2. the scrubber does the right thing (WebView build) ──');
for (const f of FIXTURES) {
  check(`[${f.name}] output`, web.stripToolMarkup(f.input), f.want);
  check(`[${f.name}] detection`, web.looksLikeToolMarkup(f.input), f.markup);
}

console.log('\n── 3. no leftover machine syntax in ANY output ──');
for (const f of FIXTURES) {
  const kept = web.stripToolMarkup(f.input);
  assert(
    `[${f.name}] no bars / tags / call body survive`,
    !/[\uFF5C]/.test(kept) && !/<\|/.test(kept) && !/<tool_calls?/i.test(kept) && !/<\/?(invoke|parameter)\b/i.test(kept) && !/"arguments"\s*:/.test(kept),
    JSON.stringify(kept),
  );
}

console.log('\n── 4. stripping is idempotent ──');
for (const f of FIXTURES) {
  const once = web.stripToolMarkup(f.input);
  check(`[${f.name}] strip(strip(x))`, web.stripToolMarkup(once), once);
}

console.log('\n── 5. the call sites actually use it (source) ──');
const relay = readFileSync(resolve('..', 'web/server/local-sse.mjs'), 'utf8');
const agent = readFileSync(resolve('src/ai/agent.ts'), 'utf8');
assert('relay imports the scrubber', /from '\.\/tool-markup\.mjs'/.test(relay));
assert('relay scrubs the /api/llm reply at the funnel', /content: stripToolMarkup\(String\(choice\.content/.test(relay));
assert('relay rebuilds the summary ask without tool scaffolding', /toolFreeWire\(/.test(relay));
assert(
  'the summarise turn no longer replays raw tool_calls',
  !/llmOnce\(\s*run\.model,\s*wire,\s*\[\]/.test(relay),
);
assert('relay sanitises the final answer', /answerText\(content\)/.test(relay));
assert('Jarvis imports the scrubber', /from '\.\/tool-markup'/.test(agent));
assert('Jarvis scrubs before it flattens', /stripToolMarkup\(text\)\.replace/.test(agent));
assert('Jarvis rebuilds the closing turn without tool scaffolding', /toolFreeTurn\(/.test(agent));

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
