// The one place a run's location snapshot is decided.
//
// THREE surfaces trigger an agent run — the HUD (main.ts), the companion web
// panel (web/AgentsPanel.tsx) and the spoken path (ai/capabilities/agents.ts) —
// and all three go through `startRun`. They must agree about this, because
// getting it wrong is invisible in the best case and expensive in the worst:
//
//   • not asking when the agent HAS a location tool leaves the run to answer
//     "no position was available" for a wearer whose phone knew perfectly well
//     where they were;
//   • asking when it does NOT is worse than useless — in a browser the read
//     raises a PERMISSION PROMPT, so an agent that never touches location would
//     pop a dialog for nothing, which is exactly the kind of thing that trains a
//     wearer to refuse.
//
// So the question "does this run need a fix?" and the reading itself live
// together, in one function, and every trigger site calls it. tools/location-sim
// asserts that no `startRun({...})` call site in src/ omits the snapshot, because
// a new caller forgetting to ask is the one failure mode a shared helper cannot
// prevent on its own.

import { getCurrentFix } from './source';
import type { LocationFix } from './spec';

/** The kind whose data the SERVER cannot fetch for itself. */
export const LOCATION_KIND = 'location';

/**
 * Does this toolset contain the location tool?
 *
 * Structurally typed on purpose: the caller may be holding `ToolDef`s from the
 * store, plain objects off a wire payload, or the relay's own descriptors, and
 * all this needs is the `kind`.
 */
export function needsLocation(tools: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((t) => Boolean(t) && typeof t === 'object' && (t as { kind?: unknown }).kind === LOCATION_KIND);
}

/**
 * The fix to send with this run, or undefined.
 *
 * undefined rather than null because it goes straight into a JSON body, and the
 * relay treats "absent" and "nothing usable" identically — which is what keeps a
 * run without a location tool byte-for-byte the payload it was before the field
 * existed.
 */
export async function snapshotForRun(tools: readonly unknown[] | undefined): Promise<LocationFix | undefined> {
  if (!needsLocation(tools)) return undefined;
  const { fix } = await getCurrentFix();
  return fix ?? undefined;
}
