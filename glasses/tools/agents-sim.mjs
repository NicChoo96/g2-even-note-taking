// Verifies the hand-rolled agent tool-calling loop (src/agents.ts) headlessly.
// Run: node tools/agents-sim.mjs
//
// Stubs the relay endpoints so we can assert the exact protocol the loop speaks:
//   1. chat with tool schemas  →  model asks for a tool
//   2. tool proxy call         →  result fed back as role:"tool"
//   3. chat again              →  plain-text answer, loop ends
// plus the MAX_STEPS guard and the unknown-tool path.
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(join(tmpdir(), 'agents-sim-'));

const streamStub = join(out, 'stream.mjs');
writeFileSync(streamStub, `export const API_BASE = 'http://relay.test';\n`);
const tokenStub = join(out, 'auth-token.mjs');
writeFileSync(tokenStub, `export const getStreamToken = () => 'tok-123';\n`);

const outfile = join(out, 'agents.mjs');
const typesfile = join(out, 'types.mjs');
const stubPlugin = {
  name: 'stub-env',
  setup(b) {
    b.onResolve({ filter: /^\.\/stream$/ }, () => ({ path: streamStub }));
    b.onResolve({ filter: /^\.\/auth-token$/ }, () => ({ path: tokenStub }));
  },
};
const common = { bundle: true, format: 'esm', platform: 'node', plugins: [stubPlugin] };
await build({ ...common, entryPoints: ['src/agents.ts'], outfile });
await build({ ...common, entryPoints: ['src/types.ts'], outfile: typesfile });

let fail = 0;
const assert = (label, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// ── Fake relay ──────────────────────────────────────────────────────────────
const calls = [];
function installFetch(script) {
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body, headers: init?.headers });
    const next = script(String(url), body, calls.length);
    return {
      ok: next.status ? next.status < 400 : true,
      status: next.status ?? 200,
      json: async () => next.json,
    };
  };
}

const { runAgent } = await import(pathToFileURL(outfile).href);

const agent = {
  id: 'a1',
  name: 'Researcher',
  systemPrompt: 'You research things.',
  toolIds: ['tool-tavily'],
  createdAt: 0,
};
const tavily = {
  id: 'tool-tavily',
  name: 'tavily_search',
  kind: 'tavily',
  description: 'Search the web.',
  searchDepth: 'basic',
};

// ── Scenario 1: tool call → answer ──────────────────────────────────────────
calls.length = 0;
installFetch((url, body) => {
  if (url.endsWith('/api/llm')) {
    const isSecond = body.messages.some((m) => m.role === 'tool');
    if (!isSecond) {
      return {
        json: {
          ok: true,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'tavily_search', arguments: '{"query":"g2 glasses"}' },
              },
            ],
          },
        },
      };
    }
    return { json: { ok: true, message: { role: 'assistant', content: 'G2 is a smart glasses line.' } } };
  }
  if (url.endsWith('/api/tool')) {
    return { json: { ok: true, result: '1. Even Realities\nhttps://evenrealities.com\nG2 glasses.' } };
  }
  return { status: 404, json: { ok: false, error: 'nope' } };
});

const statuses = [];
const res = await runAgent(agent, [tavily], 'nvidia/nemotron-3.5-lightning:free', 'What is G2?', {
  onStatus: (s) => statuses.push(s),
});

assert('run succeeded', res.ok === true, res.error ?? '');
assert('final answer captured', res.answer === 'G2 is a smart glasses line.', res.answer);

const llmCalls = calls.filter((c) => c.url.endsWith('/api/llm'));
const toolCalls = calls.filter((c) => c.url.endsWith('/api/tool'));
assert('two chat completions', llmCalls.length === 2, `(${llmCalls.length})`);
assert('one tool execution', toolCalls.length === 1, `(${toolCalls.length})`);

const firstReq = llmCalls[0].body;
assert('model forwarded', firstReq.model === 'nvidia/nemotron-3.5-lightning:free');
assert(
  'system prompt forwarded',
  firstReq.messages[0].role === 'system' && firstReq.messages[0].content === 'You research things.',
);
assert('tool schema exposed', firstReq.tools?.[0]?.function?.name === 'tavily_search');
assert(
  'tool schema declares query',
  firstReq.tools[0].function.parameters.required?.[0] === 'query',
);
assert('tool schema omits apiKey', !JSON.stringify(firstReq).includes('apiKey'));
assert(
  'auth header sent',
  calls.every((c) => c.headers?.Authorization === 'Bearer tok-123'),
);

const toolReq = toolCalls[0].body;
assert('tool kind forwarded', toolReq.kind === 'tavily');
assert('tool id forwarded (server resolves the key)', toolReq.toolId === 'tool-tavily');
assert('search depth forwarded', toolReq.searchDepth === 'basic');
assert('tool args parsed', toolReq.args?.query === 'g2 glasses');

const secondReq = llmCalls[1].body;
const toolMsg = secondReq.messages.find((m) => m.role === 'tool');
assert('tool result fed back', Boolean(toolMsg?.content.includes('Even Realities')));
assert('tool_call_id matched', toolMsg?.tool_call_id === 'call_1');
assert('assistant tool_calls echoed', secondReq.messages.some((m) => m.tool_calls));

// Transcript shape (drives the glasses detail pane + history).
assert('transcript starts with user', res.messages[0].role === 'user');
assert('transcript ends with assistant', res.messages.at(-1).role === 'assistant');
assert('transcript records the tool', res.messages.some((m) => m.role === 'tool' && m.tool === 'tavily_search'));
assert('status hook fired', statuses.some((s) => s.includes('Searching')));

// ── Scenario 2: MAX_STEPS guard ─────────────────────────────────────────────
calls.length = 0;
installFetch((url) => {
  if (url.endsWith('/api/llm')) {
    return {
      json: {
        ok: true,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c', type: 'function', function: { name: 'tavily_search', arguments: '{}' } },
          ],
        },
      },
    };
  }
  return { json: { ok: true, result: 'again' } };
});

const looped = await runAgent(agent, [tavily], 'm', 'loop', {});
assert('step cap stops the loop', looped.ok === false && looped.error === 'max steps', looped.error);
assert(
  'step cap bounded the calls',
  calls.filter((c) => c.url.endsWith('/api/llm')).length === 5,
  `(${calls.filter((c) => c.url.endsWith('/api/llm')).length})`,
);

// ── Scenario 3: unknown tool + LLM error ────────────────────────────────────
calls.length = 0;
installFetch((url, body) => {
  if (url.endsWith('/api/llm')) {
    const seen = body.messages.some((m) => m.role === 'tool');
    if (!seen) {
      return {
        json: {
          ok: true,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'x', type: 'function', function: { name: 'ghost_tool', arguments: '{}' } },
            ],
          },
        },
      };
    }
    return { json: { ok: true, message: { role: 'assistant', content: 'Recovered.' } } };
  }
  return { status: 500, json: { ok: false, error: 'unreachable' } };
});
const ghost = await runAgent(agent, [tavily], 'm', 'hi', {});
assert('unknown tool is reported, not fatal', ghost.ok === true && ghost.answer === 'Recovered.');
assert(
  'unknown tool never hit the proxy',
  !calls.some((c) => c.url.endsWith('/api/tool')),
);

calls.length = 0;
installFetch(() => ({ status: 502, json: { ok: false, error: 'OpenRouter 502' } }));
const failed = await runAgent(agent, [tavily], 'm', 'hi', {});
assert('LLM failure is surfaced', failed.ok === false && failed.error === 'OpenRouter 502', failed.error);
assert('failure recorded in transcript', failed.messages.at(-1).content.includes('OpenRouter 502'));

// ── Scenario 4: 5-session cap (per-agent history) ───────────────────────────
const { pruneSessions, MAX_SESSIONS, sessionsForAgent, latestSession } = await import(
  pathToFileURL(join(out, 'types.mjs')).href
).catch(() => ({}));
if (pruneSessions) {
  const mk = (i, agentId = 'a1') => ({
    id: `s${i}`,
    agentId,
    title: `t${i}`,
    messages: [],
    status: 'done',
    createdAt: i,
    updatedAt: i,
  });
  const many = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6), mk(7), mk(8)];
  const pruned = pruneSessions(many);
  assert('cap holds', pruned.length === MAX_SESSIONS, `(${pruned.length})`);
  assert('newest kept first', pruned[0].id === 's8' && pruned.at(-1).id === 's4', pruned.map((s) => s.id).join(','));
  assert('oldest dropped', !pruned.some((s) => s.id === 's1' || s.id === 's3'));
  const mixed = [...many, mk(9, 'a2'), mk(10, 'a2')];
  const perAgent = sessionsForAgent({ sessions: pruneSessions(mixed) }, 'a2');
  assert('cap is global (per-agent view filters)', perAgent.length === 2, `(${perAgent.length})`);
  assert('latestSession picks newest', latestSession({ sessions: mixed }, 'a1')?.id === 's8');
} else {
  assert('types.mjs available for prune check', false, 'bundle missing');
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
