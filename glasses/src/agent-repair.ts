// Which agents cannot do their job — the PURE half of the fleet repair.
//
// Split out of `agents-store` for one reason: this decision has to be assertable
// without a browser, a hub, or a React tree. The applying half (`repairAgentTools`)
// stays in the store, where the `If-Match` write path lives.
//
// THE RULE, AND WHY IT IS THIS NARROW
//   `jev` is a RANKER: it answers a question about text you hand it. It cannot
//   obtain that text. So an agent holding only `jev` is an agent whose prompt
//   says "search for X" and whose tools make that impossible — which is the state
//   twelve agents on the live hub were in, and it looked exactly like an agent
//   that had nothing to say.
//
//   A repair therefore fires only when an agent has NO tool that can fetch
//   something. An agent with `http`, `files`, `docs`, `todo`, `notes`, `location`
//   or `web` already has a way out and is never touched. Nothing is ever
//   DETACHED — this only adds, so it cannot make working agent worse.
//
//   A tool id with no row in the catalogue is a dangling reference, not a
//   capability, so it does not exempt an agent. That is deliberate: a broken
//   reference is exactly the case that looks fine on screen and fails at run time.

import type { AgentDef, ToolDef } from './types';

/** One agent that needs a tool, and why. */
export interface ToolRepair {
  agentId: string;
  name: string;
  /** Tool ids to add. Never a replacement. */
  add: string[];
  reason: string;
}

/**
 * Agents that hold no fetching tool.
 *
 * Returns `[]` when the catalogue has nothing to offer — an empty plan reads as
 * "nothing to fix", which is honest: there is no repair available, rather than a
 * repair that would attach a tool that does not exist.
 */
export function planToolRepair(agents: AgentDef[], tools: ToolDef[]): ToolRepair[] {
  const byId = new Map(tools.map((t) => [t.id, t]));
  // Web search is what the research prompts already describe; any non-jev tool is
  // the fallback. Never jev itself — attaching the ranker twice is not a repair.
  const pick = tools.find((t) => t.kind === 'web') ?? tools.find((t) => t.kind !== 'jev');
  if (!pick) return [];
  const out: ToolRepair[] = [];
  for (const agent of agents) {
    const ids = agent.toolIds ?? [];
    if (ids.includes(pick.id)) continue;
    const held = ids
      .map((id) => byId.get(id))
      .filter((t): t is ToolDef => Boolean(t))
      .filter((t) => t.kind !== 'jev');
    if (held.length) continue;
    out.push({
      agentId: agent.id,
      name: agent.name,
      add: [pick.id],
      reason: `${ids.length ? 'holds only jev' : 'holds no tools'} — it can judge text but not obtain it`,
    });
  }
  return out;
}
