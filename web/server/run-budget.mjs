// How long an agent run may go on, and what actually stops one.
//
// ITS OWN MODULE for the reason the router and the nudge rules have one:
// importing `local-sse.mjs` starts a server, so anything left in there can only
// ever be asserted as text. This is the number the wearer has been fighting —
// twice — so it is worth a real assertion rather than a grep.

/**
 * The hard budget for one run, in model turns.
 *
 * ZERO MEANS NO LIMIT, and zero is the default. This was 5, then 12; both were
 * guesses at how long a job takes, and a guess that is too small does not fail
 * loudly — it stops the run mid-task and the exhaustion path then asks for a
 * summary, so the wearer gets a confident answer about work that was never
 * finished. On a backend where a turn costs a fraction of a cent, the cheaper
 * mistake is the other one: let the run finish.
 *
 * So the real terminator is the progress guard below. `G2_AGENT_MAX_STEPS` sets
 * a budget for anyone who wants one; 0, empty, unparseable and negative all mean
 * unlimited, because the failure to avoid is a MISSING answer, not an extra one.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {number} turns, or 0 for no limit
 */
export function agentStepBudget(env = process.env) {
  const raw = env?.G2_AGENT_MAX_STEPS;
  if (raw === undefined || String(raw).trim() === '') return 0;
  const n = Number(raw);
  // A typo (`12x`, `unlimited`) must not become NaN and silently forbid the run.
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * How many times the same tool call, with the same arguments, may repeat before
 * the run is stopped for going in circles.
 *
 * This is what ends an unlimited run. It is about PROGRESS rather than length: a
 * model calling a tool with byte-identical arguments has learned nothing between
 * calls, so more turns cannot help it and can only cost money. Three rather than
 * two, because one honest retry after a transient failure is a real pattern and
 * repeating it once proves nothing.
 */
export const MAX_IDENTICAL_CALLS = 3;
