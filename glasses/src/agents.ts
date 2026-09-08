// Agent runtime — a small, dependency-free tool-calling loop over OpenRouter.
//
// Why hand-rolled instead of LangChain: OpenRouter speaks the OpenAI chat
// completions protocol (`tools` / `tool_calls`), so the whole loop is ~100 lines
// with ZERO dependencies — LangChain would add hundreds of KB to a bundle that
// has to boot inside the Even App WebView and gain us nothing here.
//
// The loop (matches the user's requirement):
//   1. send the prompt + the agent's system prompt + its tool schemas
//   2. model answers, optionally requesting tool calls
//   3. we execute each call (Tavily web search / any REST API)
//   4. feed the results back as `role: "tool"` messages
//   5. repeat until the model answers in plain text (or we hit the step cap)
//
// SECURITY: the OpenRouter + Tavily keys are NEVER handled here. Both calls go
// through the relay (web/server/local-sse.mjs) which holds the keys server-side
// — exactly like the existing /api/stt speech proxy. The browser/WebView only
// ever sends the prompt + tool metadata.
import { API_BASE } from './stream';
import { getStreamToken } from './auth-token';
import type { AgentDef, AgentMessage, ToolDef } from './types';

/** Safety cap on tool-call rounds — keeps a looping model from burning quota. */
const MAX_STEPS = 5;

export interface AgentRunHooks {
  /** A new turn was appended (user prompt, tool call, tool result, answer). */
  onMessage?(m: AgentMessage): void;
  /** Short status line for the glasses overlay. */
  onStatus?(s: string): void;
}

export interface AgentRunResult {
  ok: boolean;
  answer: string;
  messages: AgentMessage[];
  error?: string;
}

/** OpenAI-style tool schema exposed to the model. */
interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function toolSchema(t: ToolDef): ToolSchema {
  if (t.kind === 'tavily') {
    return {
      type: 'function',
      function: {
        name: t.name || 'tavily_search',
        description: t.description || 'Search the web for current information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
          },
          required: ['query'],
        },
      },
    };
  }
  // Generic REST tool: the model supplies the JSON body.
  return {
    type: 'function',
    function: {
      name: t.name || 'http_tool',
      description: t.description || 'Call an external HTTP API.',
      parameters: {
        type: 'object',
        properties: {
          body: {
            type: 'object',
            description: 'JSON request body / query parameters for the API.',
          },
        },
        required: [],
      },
    },
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = getStreamToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Ask the relay to run one chat completion (the key stays server-side). */
async function chat(
  model: string,
  messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string; name?: string }[],
  tools: ToolSchema[],
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${API_BASE}/api/llm`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: { content?: string; tool_calls?: ToolCall[] };
  };
  if (!res.ok || j.ok === false) throw new Error(j.error || `LLM request failed (${res.status})`);
  return {
    content: String(j.message?.content ?? ''),
    toolCalls: Array.isArray(j.message?.tool_calls) ? j.message!.tool_calls! : [],
  };
}

interface ToolCall {
  id: string;
  function: { name: string; arguments?: string };
}

/** Run one tool through the relay (Tavily search, or a generic REST call). */
async function runTool(tool: ToolDef, args: string): Promise<string> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(args || '{}') as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  const res = await fetch(`${API_BASE}/api/tool`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      kind: tool.kind,
      toolId: tool.id,
      url: tool.url,
      method: tool.method,
      searchDepth: tool.searchDepth,
      args: parsed,
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: string; error?: string };
  if (!res.ok || j.ok === false) return `tool error: ${j.error || res.status}`;
  return String(j.result ?? '');
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Run an agent against a prompt. Returns the final answer plus the full
 * transcript (which the caller stores as a session).
 */
export async function runAgent(
  agent: AgentDef,
  tools: ToolDef[],
  model: string,
  prompt: string,
  hooks: AgentRunHooks = {},
): Promise<AgentRunResult> {
  const transcript: AgentMessage[] = [];
  const push = (m: AgentMessage) => {
    transcript.push(m);
    hooks.onMessage?.(m);
  };
  const now = () => Date.now();

  push({ role: 'user', content: prompt, at: now() });

  const schemas = tools.map(toolSchema);
  // Wire format sent to the model (OpenAI shape) — kept in sync with transcript.
  const wire: {
    role: string;
    content: string;
    tool_calls?: unknown;
    tool_call_id?: string;
    name?: string;
  }[] = [
    { role: 'system', content: agent.systemPrompt || 'You are a helpful assistant.' },
    { role: 'user', content: prompt },
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      hooks.onStatus?.(step === 0 ? 'Thinking…' : 'Reasoning…');
      const { content, toolCalls } = await chat(model, wire, schemas);

      if (toolCalls.length === 0) {
        const answer = content.trim() || '(no answer)';
        push({ role: 'assistant', content: answer, at: now() });
        hooks.onStatus?.('');
        return { ok: true, answer, messages: transcript };
      }

      // The model asked for tools — record the assistant turn, then run each.
      wire.push({ role: 'assistant', content, tool_calls: toolCalls });
      for (const call of toolCalls) {
        const name = call.function?.name ?? '';
        const args = call.function?.arguments ?? '{}';
        const tool = tools.find((t) => t.name === name);
        push({
          role: 'assistant',
          content: content || `Calling ${name}…`,
          tool: name,
          args: truncate(args, 160),
          at: now(),
        });
        if (!tool) {
          const msg = `Unknown tool "${name}".`;
          wire.push({ role: 'tool', content: msg, tool_call_id: call.id });
          push({ role: 'tool', content: msg, tool: name, at: now() });
          continue;
        }
        hooks.onStatus?.(`Searching · ${name}…`);
        const result = await runTool(tool, args);
        wire.push({ role: 'tool', content: result, tool_call_id: call.id });
        push({ role: 'tool', content: truncate(result, 600), tool: name, at: now() });
      }
    }
    // Ran out of steps — return what we have rather than looping forever.
    const answer = 'Stopped after too many tool calls. Try a simpler prompt.';
    push({ role: 'assistant', content: answer, at: now() });
    return { ok: false, answer, messages: transcript, error: 'max steps' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    push({ role: 'assistant', content: `⚠️ ${message}`, at: now() });
    return { ok: false, answer: message, messages: transcript, error: message };
  }
}
