// Agents page capabilities — layer 2.
//
// The Agents tab owns the builder (agents + tools + model) and the run
// transcript. Triggering a run deliberately reuses the SAME relay path the
// manual Trigger button uses, so a run started by voice is indistinguishable
// from one started by hand: it survives backgrounding and both the glasses
// detail pane and the web panel watch the same transcript.
import { getAgents, updateAgents } from '../../agents-store';
import { fetchRuns, startRun, stopRun } from '../../stream';
import { tavilyTool, uid, type AgentDef, type ToolDef } from '../../types';
import type { Capability, CapabilityResult } from '../types';
import { resolveAgent, short } from './shared';

function agents(): AgentDef[] {
  return getAgents().agents;
}

/** Resolve a stored tool id back to its spoken name (for summaries + data). */
function nameOf(id: string): string {
  return getAgents().tools.find((t) => t.id === id)?.name ?? id;
}

function agentNames(): string {
  return agents().map((a) => a.name).join(', ');
}

// ── Tool resolution ─────────────────────────────────────────────────────────
// The model hears tool names, never ids. These helpers turn a spoken phrase
// ("web search", "my weather tool", "search and stocks") into the ids the
// builder stores, forgivingly — and never silently drop the agent's tools when
// the phrase matches nothing.

/** Phrases that mean "no tools at all". */
const NO_TOOLS = /^(none|no tools?|nothing|off|clear|empty|remove all|all off|disable all)$/i;
/** Phrases that clearly mean the seeded web-search tool. */
const SEARCH_WORDS = /(search|web|internet|online|tavily|google)/i;

/** Forgiving tool lookup: id → exact name → substring → kind keyword. */
function findTool(part: string, tools: ToolDef[]): ToolDef | null {
  const t = part.trim().toLowerCase();
  if (!t) return null;
  return (
    tools.find((x) => x.id.toLowerCase() === t) ??
    tools.find((x) => x.name.toLowerCase() === t) ??
    tools.find((x) => x.name.toLowerCase().includes(t) || x.id.toLowerCase().includes(t)) ??
    (SEARCH_WORDS.test(t) ? tools.find((x) => x.kind === 'tavily') ?? null : null)
  );
}

/**
 * The seeded Tavily tool is the builder's invariant (see agents-store.ts), but a
 * user can remove it from the catalog. Re-seed it before resolving a spoken
 * name, so "add web search" always works.
 */
function toolsWithTavily(): ToolDef[] {
  const st = getAgents();
  if (st.tools.some((t) => t.kind === 'tavily')) return st.tools;
  const tool = tavilyTool();
  updateAgents((s) => ({ ...s, tools: [tool, ...s.tools] }));
  return [tool, ...st.tools];
}

interface ToolParse {
  ids: string[];
  unknown: string[];
  /** The phrase was an explicit "none" — the agent should end up with no tools. */
  cleared: boolean;
}

/** Parse a spoken tool phrase into stored tool ids. */
function parseTools(raw: unknown): ToolParse {
  const text = String(raw ?? '').trim();
  if (!text) return { ids: [], unknown: [], cleared: false };
  if (NO_TOOLS.test(text)) return { ids: [], unknown: [], cleared: true };
  const tools = toolsWithTavily();
  const parts = text
    .split(/,|;|\n|\band\b|\bplus\b/gi)
    .map((p) => p.trim())
    .filter(Boolean);
  const ids: string[] = [];
  const unknown: string[] = [];
  let cleared = false;
  for (const part of parts) {
    if (NO_TOOLS.test(part)) {
      cleared = true;
      continue;
    }
    const tool = findTool(part, tools);
    if (tool) {
      if (!ids.includes(tool.id)) ids.push(tool.id);
    } else {
      unknown.push(part);
    }
  }
  return { ids, unknown, cleared };
}

/** A short, HUD-safe line naming the tools an agent now has. */
function toolSummary(ids: string[]): string {
  if (!ids.length) return 'no tools';
  return ids.map(nameOf).join(', ');
}

export const agentsCapabilities: Capability[] = [
  {
    name: 'agents.list',
    page: 'agents',
    title: 'List agents',
    description:
      'List the saved agents with their role (system prompt), prompts, tools and model. ' +
      'Call tools.list to see every tool you can attach.',
    params: [],
    run: () => {
      const list = agents();
      if (!list.length) return { ok: true, summary: 'No agents saved yet', data: { agents: [] } };
      return {
        ok: true,
        summary: `${list.length} agent(s): ${list.map((a) => a.name).join(', ')}`,
        data: {
          agents: list.map((a) => ({
            id: a.id,
            name: a.name,
            systemPrompt: a.systemPrompt,
            prompt: a.prompt,
            toolIds: a.toolIds,
            tools: a.toolIds.map(nameOf).filter(Boolean),
            model: a.model ?? '',
          })),
        },
        hint: 'use tools.list for the full tool catalog',
      };
    },
  },
  {
    name: 'agents.trigger',
    page: 'agents',
    title: 'Run an agent',
    description:
      'Start a saved agent running on a prompt. Defaults to the agent\'s saved prompt. The run continues in ' +
      'the background and its transcript appears in the Agents page.',
    params: [
      { name: 'agent', type: 'string', description: 'Agent name or number. Omit for the first agent.' },
      { name: 'prompt', type: 'string', description: 'What to ask. Omit to use the agent\'s saved prompt.' },
    ],
    available: () => agents().length > 0,
    run: async (args) => {
      const st = getAgents();
      const agent = resolveAgent(String(args.agent ?? ''), st.agents);
      if (!agent) return { ok: false, summary: 'No agent matches that name', hint: `agents: ${st.agents.map((a) => a.name).join(', ')}` };
      const prompt = (String(args.prompt ?? '').trim() || agent.prompt || '').trim();
      if (!prompt) return { ok: false, summary: `${short(agent.name, 20)} has no saved prompt`, hint: 'pass a "prompt" argument' };
      const tools = st.tools.filter((t) => agent.toolIds.includes(t.id));
      const started = await startRun({
        agent: { id: agent.id, name: agent.name, systemPrompt: agent.systemPrompt, model: agent.model },
        tools,
        prompt,
        model: agent.model || st.llm.model,
      });
      if (!started.runId) return { ok: false, summary: `Could not start ${short(agent.name, 20)}`, hint: started.error };
      return { ok: true, summary: `Started ${short(agent.name, 20)}`, data: { runId: started.runId, prompt } };
    },
  },
  {
    name: 'agents.stop',
    page: 'agents',
    title: 'Stop a running agent',
    description: 'Stop the agent run that is currently in progress.',
    params: [{ name: 'agent', type: 'string', description: 'Agent name or number. Omit to stop whichever run is active.' }],
    run: async (args) => {
      const runs = await fetchRuns();
      const active = runs.filter((r) => r.status === 'running');
      if (!active.length) return { ok: false, summary: 'No agent is running' };
      const want = String(args.agent ?? '').trim().toLowerCase();
      const target = want
        ? active.find((r) => r.agentName.toLowerCase().includes(want)) ?? active[0]
        : active[0];
      const ok = await stopRun(target.id);
      return ok
        ? { ok: true, summary: `Stopped ${short(target.agentName, 20)}`, data: { runId: target.id } }
        : { ok: false, summary: 'Could not stop the run' };
    },
  },
  {
    name: 'agents.create',
    page: 'agents',
    title: 'Create agent',
    description:
      'Create a new agent. Can set every setting at once: name, role (system prompt), default prompt, tools ' +
      'and a model override. Tools default to web search.',
    params: [
      { name: 'name', type: 'string', description: 'Short agent name.', required: true },
      { name: 'systemPrompt', type: 'string', description: 'The agent\'s role / instructions.' },
      { name: 'prompt', type: 'string', description: 'The default task the agent runs when triggered.' },
      {
        name: 'tools',
        type: 'string',
        description:
          'Comma-separated tool names to enable (e.g. "web search"). Defaults to web search. ' +
          'Use "none" for no tools. See tools.list for names.',
      },
      { name: 'model', type: 'string', description: 'Optional model override. Omit to use the global model.' },
    ],
    run: (args): CapabilityResult => {
      const name = String(args.name ?? '').trim();
      if (!name) return { ok: false, summary: 'The agent needs a name' };
      // No `tools` argument → web search on, matching the builder's new-agent
      // default. An explicit "none" → no tools.
      const parsed = typeof args.tools === 'string' ? parseTools(args.tools) : null;
      const toolIds = parsed ? parsed.ids : ['tool-tavily'];
      if (!parsed) toolsWithTavily();
      const model = String(args.model ?? '').trim();
      const agent: AgentDef = {
        id: uid(),
        name,
        systemPrompt: String(args.systemPrompt ?? '').trim(),
        prompt: String(args.prompt ?? '').trim(),
        toolIds,
        ...(model ? { model } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      updateAgents((s) => ({ ...s, agents: [...s.agents, agent] }));
      const unknown = parsed?.unknown ?? [];
      return {
        ok: true,
        summary: `Created "${short(name, 20)}" (${toolSummary(toolIds)})`,
        data: { id: agent.id, tools: toolIds.map(nameOf) },
        ...(unknown.length ? { hint: `no such tool(s): ${unknown.join(', ')}` } : {}),
      };
    },
  },
  {
    name: 'agents.update',
    page: 'agents',
    title: 'Edit agent',
    description:
      'Change ANY setting of an existing agent IN PLACE: name, role (system prompt), default prompt, tools ' +
      'and model. Only the fields you pass change.',
    params: [
      { name: 'agent', type: 'string', description: 'Agent name or number.', required: true },
      { name: 'name', type: 'string', description: 'New name.' },
      { name: 'systemPrompt', type: 'string', description: 'New role / instructions.' },
      { name: 'prompt', type: 'string', description: 'New default prompt.' },
      {
        name: 'tools',
        type: 'string',
        description:
          'Replace the whole tool set with these comma-separated names. Use "none" to remove all tools.',
      },
      { name: 'addTools', type: 'string', description: 'Comma-separated tools to ADD, keeping the others.' },
      { name: 'removeTools', type: 'string', description: 'Comma-separated tools to REMOVE, keeping the others.' },
      { name: 'model', type: 'string', description: 'New model override. Pass "none" or "default" to clear it.' },
    ],
    run: (args): CapabilityResult => {
      const target = resolveAgent(String(args.agent ?? ''), agents());
      if (!target) {
        return { ok: false, summary: `No agent matches "${short(String(args.agent ?? ''), 20)}"`, hint: `agents: ${agentNames()}` };
      }

      const patch: Partial<AgentDef> = {};
      if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
      if (typeof args.systemPrompt === 'string') patch.systemPrompt = args.systemPrompt.trim();
      if (typeof args.prompt === 'string') patch.prompt = args.prompt.trim();
      if (typeof args.model === 'string') {
        const m = args.model.trim();
        patch.model = /^(none|default|global|clear)$/i.test(m) ? undefined : m || undefined;
      }

      // Tools: `tools` replaces, then addTools/removeTools adjust the result, so
      // a single call can do "clear the list then add search".
      const unknown: string[] = [];
      let toolIds = [...target.toolIds];
      if (typeof args.tools === 'string') {
        const parsed = parseTools(args.tools);
        // A replace that matched NOTHING (and was not an explicit "none") is far
        // more likely a misheard tool name than an intent to wipe every tool, so
        // leave the set alone and report the names back.
        if (parsed.cleared || parsed.ids.length) toolIds = parsed.ids;
        else unknown.push(...parsed.unknown);
      }
      if (typeof args.addTools === 'string') {
        const parsed = parseTools(args.addTools);
        toolIds = [...new Set([...toolIds, ...parsed.ids])];
        unknown.push(...parsed.unknown);
      }
      if (typeof args.removeTools === 'string') {
        const parsed = parseTools(args.removeTools);
        const drop = new Set(parsed.ids);
        toolIds = toolIds.filter((id) => !drop.has(id));
        unknown.push(...parsed.unknown);
      }
      if (toolIds.join('\u0000') !== target.toolIds.join('\u0000')) patch.toolIds = toolIds;

      const fields = Object.keys(patch);
      if (!fields.length) {
        const hint = unknown.length
          ? `no such tool(s): ${unknown.join(', ')} — try tools.list`
          : `agents: ${agentNames()}`;
        return { ok: false, summary: 'Nothing to change', hint };
      }
      updateAgents((s) => ({
        ...s,
        agents: s.agents.map((a) => (a.id === target.id ? { ...a, ...patch, updatedAt: Date.now() } : a)),
      }));
      const result: CapabilityResult = {
        ok: true,
        summary: `Updated "${short(patch.name ?? target.name, 20)}" (${fields.join(', ')})`,
        data: { id: target.id, fields, tools: (patch.toolIds ?? target.toolIds).map(nameOf) },
      };
      if (unknown.length) result.hint = `no such tool(s): ${unknown.join(', ')}`;
      return result;
    },
  },
  {
    name: 'agents.clone',
    page: 'agents',
    title: 'Clone agent',
    description:
      'Copy an existing agent with ALL of its settings — role, prompt, tools and model. The copy starts with ' +
      'no run history, so the original transcript is untouched.',
    params: [
      { name: 'agent', type: 'string', description: 'Agent name or number to copy.', required: true },
      { name: 'name', type: 'string', description: 'Name for the copy. Defaults to "<original> copy".' },
    ],
    run: (args): CapabilityResult => {
      const src = resolveAgent(String(args.agent ?? ''), agents());
      if (!src) {
        return { ok: false, summary: `No agent matches "${short(String(args.agent ?? ''), 20)}"`, hint: `agents: ${agentNames()}` };
      }
      const name = (String(args.name ?? '').trim() || `${src.name} copy`).slice(0, 60);
      const copy: AgentDef = {
        ...src,
        id: uid(),
        name,
        toolIds: [...src.toolIds],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      updateAgents((s) => ({ ...s, agents: [...s.agents, copy] }));
      return {
        ok: true,
        summary: `Cloned to "${short(name, 20)}"`,
        data: { id: copy.id, from: src.id, tools: copy.toolIds.map(nameOf) },
      };
    },
  },
  {
    name: 'agents.delete',
    page: 'agents',
    title: 'Delete agent',
    description: 'Delete an agent permanently. Its saved sessions remain until they age out.',
    params: [{ name: 'agent', type: 'string', description: 'Agent name or number.', required: true }],
    confirm: true,
    run: (args) => {
      const target = resolveAgent(String(args.agent ?? ''), agents());
      if (!target) return { ok: false, summary: `No agent matches "${short(String(args.agent ?? ''), 20)}"` };
      updateAgents((s) => ({ ...s, agents: s.agents.filter((a) => a.id !== target.id) }));
      return { ok: true, summary: `Deleted "${short(target.name, 20)}"`, data: { id: target.id } };
    },
  },
  {
    name: 'tools.list',
    page: 'agents',
    title: 'List tools',
    description:
      'List every tool that can be attached to an agent, with the exact names agents.create and agents.update ' +
      'accept. Call this before setting tools so the names are right.',
    params: [],
    run: () => {
      const tools = toolsWithTavily();
      if (!tools.length) return { ok: true, summary: 'No tools available', data: { tools: [] } };
      return {
        ok: true,
        summary: `${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`,
        data: {
          tools: tools.map((t) => ({
            id: t.id,
            name: t.name,
            kind: t.kind,
            description: t.description,
            ...(t.kind === 'http' ? { url: t.url ?? '', method: t.method ?? 'POST' } : {}),
            ...(t.kind === 'tavily' ? { searchDepth: t.searchDepth ?? 'basic' } : {}),
          })),
        },
        hint: 'pass these names to agents.create "tools" or agents.update "tools"/"addTools"/"removeTools"',
      };
    },
  },
];
