// The tap-to-confirm copy, for every path that can gate an action.
//
// WHY THIS IS ITS OWN MODULE: there are now two callers and they must say the
// same thing. The spoken loop (./agent) pauses before an `irreversible`
// capability, and so does a delegated intent (./intents) — an agent run asking
// the device to delete a document raises the exact same prompt on the exact same
// HUD. Two copies of "which arguments do I show the wearer" is how one of them
// quietly starts showing the wrong field, and a confirmation that describes the
// wrong thing is worse than no confirmation.
//
// It takes the CAPABILITY rather than the action name because the params ARE the
// thing being described: `cap.params` is what says which arguments exist, in the
// order the model was told about them.
//
// Pure and dependency-free on purpose — it imports a type and nothing else, so
// either caller can use it without dragging the loop in.
import type { Capability } from './types';

/** How much of one argument value fits on a HUD line. */
const MAX_VALUE_CHARS = 48;
/** How many arguments the prompt shows. Beyond two it stops being a summary. */
const MAX_LINES = 2;

/**
 * Human-readable HUD copy for the tap-to-confirm prompt: the action's own label
 * as the title, and the arguments that describe WHAT is about to be destroyed.
 *
 * The fallback matters more than it looks. A destructive action whose arguments
 * are all optional can legitimately arrive with nothing to show, and a prompt
 * with an empty body reads as a rendering bug — so the description stands in
 * rather than the wearer approving a blank.
 */
export function confirmCopy(
  cap: Capability,
  args: Record<string, unknown>,
): { title: string; lines: string[] } {
  const lines: string[] = [];
  for (const p of cap.params) {
    const v = args[p.name];
    if (v === undefined || v === '') continue;
    const text = String(v).replace(/\s+/g, ' ');
    lines.push(`${p.name}: ${text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text}`);
    if (lines.length >= MAX_LINES) break;
  }
  if (!lines.length) lines.push(cap.description);
  return { title: cap.title, lines };
}
