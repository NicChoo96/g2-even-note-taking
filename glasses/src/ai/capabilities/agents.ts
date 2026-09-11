// Agents page capabilities — layer 2.
//
// The Agents tab owns the builder (agents + tools + model) and the run
// transcript. Triggering a run deliberately reuses the SAME relay path the
// manual Trigger button uses, so a run started by voice is indistinguishable
// from one started by hand: it survives backgrounding and both the glasses
// detail pane and the web panel watch the same transcript.
import { getAgents, updateAgents } from '../../agents-store';
import { fetchRuns, startRun, stopRun } from '../../stream';
import { uid, type AgentDef } from '../../types';
import type { Capability } from '../types';
import { resolveAgent, short } from './shared';

function agents(): AgentDef[] {
  return getAgents().agents;
}

function nameOf(id: string): string {
  return getAgents().tools.find((t) => t.id === id)?.name ?? '';
}

export const agentsCapabilities: Capability[] = [
  {
    name: 'agents.list',
    page: 'agents',
    title: 'List agents',
    description: 'List the saved agents with their prompts and tools.',
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
            prompt: a.prompt,
            systemPrompt: a.systemPrompt,
            tools: a.toolIds.map(nameOf).filter(Boolean),
          })),
        },
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
    description: 'Create a new agent with a name, an optional role (system prompt) and a default prompt.',
    params: [
      { name: 'name', type: 'string', description: 'Short agent name.', required: true },
      { name: 'systemPrompt', type: 'string', description: 'The agent\'s role / instructions.' },
      { name: 'prompt', type: 'string', description: 'The default task the agent runs when triggered.' },
    ],
    run: (args) => {
      const name = String(args.name ?? '').trim();
      if (!name) return { ok: false, summary: 'The agent needs a name' };
      const agent: AgentDef = {
        id: uid(),
        name,
        systemPrompt: String(args.systemPrompt ?? '').trim(),
        prompt: String(args.prompt ?? '').trim(),
        // Web search on by default, matching the builder's new-agent default.
        toolIds: ['tool-tavily'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      updateAgents((s) => ({ ...s, agents: [...s.agents, agent] }));
      return { ok: true, summary: `Created agent "${short(name, 20)}"`, data: { id: agent.id } };
    },
  },
  {
    name: 'agents.update',
    page: 'agents',
    title: 'Edit agent',
    description: 'Change an existing agent\'s name, role (system prompt) or default prompt.',
    params: [
      { name: 'agent', type: 'string', description: 'Agent name or number.', required: true },
      { name: 'name', type: 'string', description: 'New name.' },
      { name: 'systemPrompt', type: 'string', description: 'New role / instructions.' },
      { name: 'prompt', type: 'string', description: 'New default prompt.' },
    ],
    run: (args) => {
      const target = resolveAgent(String(args.agent ?? ''), agents());
      if (!target) return { ok: false, summary: `No agent matches "${short(String(args.agent ?? ''), 20)}"` };
      const patch: Partial<AgentDef> = {};
      if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
      if (typeof args.systemPrompt === 'string') patch.systemPrompt = args.systemPrompt.trim();
      if (typeof args.prompt === 'string') patch.prompt = args.prompt.trim();
      if (!Object.keys(patch).length) return { ok: false, summary: 'Nothing to change' };
      updateAgents((s) => ({ ...s, agents: s.agents.map((a) => (a.id === target.id ? { ...a, ...patch } : a)) }));
      return { ok: true, summary: `Updated "${short(target.name, 20)}"`, data: { fields: Object.keys(patch) } };
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
];
