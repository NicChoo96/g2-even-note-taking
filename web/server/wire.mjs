// The agent-run message wire, extracted so it can be tested in isolation.
//
// `executeRun` lives inside a ~2500-line module that starts listening on import,
// so nothing it builds can be imported by a harness. But the messages it
// assembles are the product's actual behaviour, and the whole "an agent keeps
// its saved task even when the wearer speaks over it" feature rests on that
// assembly being exactly right — so it belongs here, where `wire-sim.mjs` can
// call it directly instead of trusting a re-implementation.
//
// MERGE ORDER: Card -> Directives -> Material -> Ask.
//   card        the agent's configured system prompt. Never displaced: a
//               directive is a LENS on the card, not a substitute for it.
//   directives  the wearer's one-off instruction for this run.
//   material    the agent's SAVED task, carried along when a caller substituted
//               its own task instead of silently discarding the card.
//   ask         what was actually said, after `preprocessText`.
import { withDateTime } from './datetime.mjs';

const DEFAULT_SYSTEM = 'You are a helpful assistant.';

/**
 * Assemble the chat messages for an agent run.
 *
 * BYTE-IDENTITY CONTRACT: when `instructions` and `savedPrompt` are both empty
 * this returns exactly what the pre-existing inline construction returned —
 * `content` is the raw `withDateTime(systemPrompt)` string and the user content
 * is the raw `resolvedText` (not a one-element join, not a trimmed copy). That
 * is what makes both fields safe to add: a caller that passes neither produces
 * the identical request it produced before they existed. `wire-sim.mjs` asserts
 * this rather than assuming it.
 *
 * @param {{ systemPrompt?: string, savedPrompt?: string, instructions?: string }} run
 * @param {string} resolvedText `preprocessText(run.prompt, now).text`
 * @param {Date} now
 * @returns {Array<{ role: string, content: string }>}
 */
export function assembleWire(run, resolvedText, now) {
  const card = withDateTime(run?.systemPrompt || DEFAULT_SYSTEM, now);
  const instructions = String(run?.instructions ?? '').trim();
  const saved = String(run?.savedPrompt ?? '').trim();
  const system = instructions
    ? `${card}\n\nINSTRUCTION FROM THE WEARER FOR THIS RUN (it modifies the task above; it does not replace it)\n${instructions}`
    : card;
  const text = String(resolvedText ?? '');
  const user = saved ? `${saved}\n\n${text}` : text;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
