// The `agent` tool as the RELAY sees it.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
// The Daily Run Orchestrator is written to call six other agents, read what they
// found and compile one page out of it. It holds the document store and web
// search, so it can publish. What it could not do is RUN an agent or READ one, so
// a run asked to compile six results compiled none — and what the wearer saw was
// an older page, re-read and presented as today's digest. That is the
// false-success pattern: a run reporting work it never did, with nothing in the
// app in a position to notice.
//
// ── WHY THE RELAY AND NOT AN INTENT ─────────────────────────────────────────
// An agent can ALREADY ask the device to trigger another agent: `agents.trigger`
// is a capability, so it is delegable (src/ai/intents.ts, and the chain brake
// there bounds agent->agent to one level). That path is fire-and-forget on
// purpose and has to be. The intent executor lives on the CLIENT, it settles its
// ledger entry with an outcome, and there is no route from the device back into a
// relay run that is still in flight. So triggering was never the missing half.
//
// READING THE RESULT BACK was. A result can only be handed to the model that
// asked for it by something that started the child and waited for it, and the
// only thing in the system that can wait is this process.
//
// ── WHAT MAKES IT HONEST ────────────────────────────────────────────────────
// The value returned to the parent is the child's OWN final answer, read off the
// finished child run. Never a summary written here, and never a placeholder when
// the child failed: a child that errored, was stopped, timed out or said nothing
// produces a REFUSAL that names which of those happened, in the same discipline
// as location-tool.mjs's NO_FIX_TEXT. A plausible-looking result manufactured in
// this file would be indistinguishable, to the model reading it, from one the
// child actually produced — and that is precisely the failure this tool exists to
// end, so it must not be re-created one layer down.
//
// Everything here is pure and takes its data as an argument rather than reaching
// for it, for the reason hub-tools.mjs and location-tool.mjs do the same: a
// harness imports this file directly and asserts the semantics, and nothing in
// here knows what a socket is. local-sse.mjs owns the run lifecycle; this module
// owns only what the model is told and what it gets back.

/** The only kind this file handles. */
export const AGENT_KIND = 'agent';

/** Model-facing tool names, so relay dispatch and the schema agree by name. */
export const AGENT_TOOL_NAMES = { agent: 'jarvis_agent' };

/** Does this tool run another agent and hand back its answer? */
export function isAgentTool(t) {
  return t?.kind === AGENT_KIND;
}

/**
 * How deep a chain may go, counted from a run the WEARER started.
 *
 * 1 means: a run may start children, and a child may not start children of its
 * own. Depth is carried on the run rather than inferred from the call stack,
 * because the write to refuse is at the START of the grandchild — refusing it
 * there names the fault, while letting it begin and cutting it off later gives the
 * model a child it cannot see the end of.
 *
 * One level is the whole requirement: the digest orchestrator calls six agents,
 * and none of those six is meant to call anyone. A deeper chain is not forbidden
 * because it is dangerous — it is unbounded work multiplied by unbounded work, and
 * there is no budget anywhere in this process that can pay for it.
 */
export const MAX_AGENT_DEPTH = 1;

/** How many children one parent run may start. Bounds a fan-out, not the depth. */
export const MAX_CHILDREN_PER_RUN = 8;

/**
 * Wall-clock ceiling for ONE child run.
 *
 * A child is a full agent loop — up to MAX_STEPS model turns with web searches in
 * between — and the parent is BLOCKED on it, so an unresponsive child would hold
 * the parent's turn open until the run TTL expired. Four minutes is generous for
 * one agent and still far inside that TTL.
 */
export const CHILD_TIMEOUT_MS = 240000;

/** Model-facing tool name, for the refusal sentences below. */
const TOOL = AGENT_TOOL_NAMES.agent;

/**
 * What the model is told this tool does.
 *
 * The description carries two rules the model would otherwise have no way to
 * infer, and both are load-bearing:
 *
 *   • The answer comes back as TEXT, in the child's words. A model that assumes
 *     a call is fire-and-forget reports the child's findings before it has any.
 *   • A call that did not return a result is NOT a result. The last line is the
 *     prohibition stated where the model reads it, not only where the failure is
 *     written, because the failure text arrives after the model has already
 *     decided what it intended to do.
 *
 * `name` is deliberately NOT required. An empty name is the roster call, which is
 * what lets the model discover the names that actually exist instead of inventing
 * one — and an invented name gets a refusal that lists the real ones, so the
 * recovery is one step either way.
 */
export function agentToolSchema(t) {
  return {
    type: 'function',
    function: {
      name: AGENT_TOOL_NAMES.agent,
      description:
        'Run one of the wearer\u2019s saved agents and get its finished answer back as text. Use it ' +
        'when the job is another agent\u2019s own speciality, or when a report asks you to gather ' +
        'several agents\u2019 findings: call this once per agent, in turn, then compile what came ' +
        'back. The answer is that agent\u2019s own words. Call it with no name to be given the list ' +
        'of agents that exist. Never write down a result this tool did not return to you \u2014 a ' +
        'call that failed says so, and a failure is not a finding.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The exact name of the saved agent to run, as it appears on the Agents page. Leave ' +
              'this empty to be given the list of agents that exist.',
          },
          ask: {
            type: 'string',
            description:
              'Optional. One extra instruction for this run of that agent, on top of its own ' +
              'saved prompt \u2014 for example a time window or a focus to narrow it to.',
          },
        },
        required: [],
      },
    },
  };
}

/** ASCII, single-spaced, bounded — this text lands in a transcript and a ledger. */
function clip(text, max) {
  const one = String(text ?? '')
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

/**
 * The hub's agent list, as this module needs it.
 *
 * Range-checked into a shape rather than trusted off the wire, and it accepts
 * either the `{ agents: [...] }` envelope or a bare array, because the payload
 * crosses a hub boundary this file does not control. Rows with no name are
 * dropped rather than repaired: a nameless agent cannot be asked for by name, so
 * keeping it would only pad the roster the model reads.
 */
export function parseAgents(payload) {
  const raw = Array.isArray(payload) ? payload : payload?.agents;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    out.push({
      id: typeof row.id === 'string' ? row.id : '',
      name,
      systemPrompt: typeof row.systemPrompt === 'string' ? row.systemPrompt : '',
      prompt: typeof row.prompt === 'string' ? row.prompt : '',
      toolIds: Array.isArray(row.toolIds) ? row.toolIds.filter((x) => typeof x === 'string') : [],
    });
  }
  return out;
}

/**
 * Find one agent by name.
 *
 * Exact first, then case-insensitive — a model told to run "singapore weather"
 * means the agent called "Singapore Weather", and refusing that would be a
 * spelling pedant standing between the wearer and their own agent. Anything
 * looser than that is a GUESS about which of two agents was meant, which is the
 * one thing a resolver must never do.
 */
export function findAgent(agents, name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) return null;
  return (
    agents.find((a) => a.name === wanted) ??
    agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase()) ??
    null
  );
}

/** The roster, as the model reads it. Never a silent empty list. */
export function formatRoster(agents) {
  if (!agents.length) {
    return (
      'There are no agents saved on this account yet, so there is nothing to run. Do not invent an ' +
      'agent name and do not describe a result you did not receive.'
    );
  }
  const names = agents.map((a) => clip(a.name, 60)).join(', ');
  return (
    `${agents.length === 1 ? '1 agent exists' : `${agents.length} agents exist`} and can be run by ` +
    `name: ${names}. Call this tool again with the exact name you want.`
  );
}

/** The refusal for a name that is not one of them — the roster, so recovery is one step. */
export function unknownAgentText(name, agents) {
  return (
    `tool error: there is no agent called "${clip(name, 60)}". ${formatRoster(agents)}`
  );
}

/**
 * The refusal for a run that is itself a child.
 *
 * It says WHAT the chain limit is and WHY, because the model's next move depends
 * on it: this is not a transient failure to retry, it is a boundary to work
 * within, and it should report what it has and say the rest could not be reached.
 */
export function depthRefusalText(agentName, depth) {
  return (
    `tool error: this run was itself started by another agent, so it cannot start one of its own ` +
    `(chains are limited to ${MAX_AGENT_DEPTH} level). "${clip(agentName, 60)}" was NOT run and ` +
    'no result exists for it. Report what you found from the tools you called yourself, and say ' +
    'plainly that the further agent could not be reached \u2014 do not write down any result for it.'
  );
}

/** The refusal for a parent that has spent its fan-out. */
export function budgetRefusalText(agentName, used) {
  return (
    `tool error: this run has already started ${used} agents, which is the limit of ` +
    `${MAX_CHILDREN_PER_RUN}. "${clip(agentName, 60)}" was NOT run and no result exists for it. ` +
    'Compile the results you already have and say plainly which agents you did not reach.'
  );
}

/** The refusal for a child that stopped or ran long. Bounded and named, never vague. */
export function timedOutText(agentName, ms) {
  const minutes = Math.round(ms / 60000);
  return (
    `tool error: "${clip(agentName, 60)}" did not finish within about ${minutes} minute` +
    `${minutes === 1 ? '' : 's'}, so it was stopped. It produced no answer and NOTHING is known ` +
    'about what it found. Do not state or guess a result for it.'
  );
}

/**
 * The child's own final answer, or the honest reason there is not one.
 *
 * The answer is read off the child's TRANSCRIPT rather than from a field set on
 * the run. A field would be a second place the answer lives, and the two could
 * disagree — the transcript is the record of what actually happened, and the last
 * assistant turn that is not a tool call is what the child finally said.
 *
 * Every branch that is not a real answer says which condition it was, because the
 * model has to be able to tell "it failed" from "it said nothing", and a generic
 * "no result" reads as an invitation to fill the gap.
 */
export function readChildResult(child) {
  if (!child) return { ok: false, reason: 'the run could not be found after it started' };
  if (child.status === 'stopped') {
    return { ok: false, reason: 'it was stopped before it answered' };
  }
  if (child.status === 'error') {
    return { ok: false, reason: `it failed \u2014 ${clip(child.error || 'no reason was recorded', 200)}` };
  }
  if (child.status !== 'done') return { ok: false, reason: 'it had not finished' };
  for (let i = child.messages.length - 1; i >= 0; i--) {
    const m = child.messages[i];
    if (!m || m.role !== 'assistant' || m.tool) continue;
    const text = String(m.content ?? '').trim();
    if (text) return { ok: true, text };
    break;
  }
  return { ok: false, reason: 'it finished without saying anything' };
}

/**
 * The tool result the PARENT reads.
 *
 * The header names the child and its run id, and gives a duration, so the model
 * can attribute what follows and the wearer can look the run up afterwards. The
 * footer is the anti-invention instruction, repeated at the point of use: a run
 * that gathered three of six results must compile three and say so, and the text
 * here is the only thing that tells it that compiling is not licence to fill.
 */
export function formatChildResult(agentName, runId, result, elapsedMs) {
  const header = `[agent "${clip(agentName, 60)}" \u2014 run ${runId}, ${
    result.ok ? 'finished' : 'did NOT finish'
  }, ${Math.max(0, Math.round(elapsedMs / 1000))}s]`;
  if (!result.ok) {
    return (
      `${header}\n${clip(agentName, 60)} produced no result: ${result.reason}.\n` +
      'This is a FAILURE, not a finding. Do not report anything on its behalf \u2014 say that it ' +
      'did not return a result.'
    );
  }
  return (
    `${header}\n${result.text}\n\n` +
    '[end of that agent\u2019s answer. The text above is what it said, in its own words \u2014 quote ' +
    'or compile it, and do not add anything it did not say.]'
  );
}
