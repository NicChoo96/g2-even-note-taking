// Jev — typed decisions for the assistant.
//
// WHAT THIS IS FOR
//   Some things a person asks are not questions to be answered in prose but
//   decisions to be MADE: "should this go to billing or engineering", "is this
//   urgent", "how angry is this customer". Asking a chat model for a paragraph
//   then parsing it is guesswork. Jev is asked a typed question and returns a
//   probability, so the assistant can branch on a number and say what it did.
//
//   It is a GLOBAL action, not an Agents-page feature: any page can face a
//   routing/ranking/verification call, and `jev.decide` only inspects text the
//   caller hands it — it never touches the user's data itself.
//
// FAILING HONESTLY
//   jev and the chat proxy draw on the SAME OpenRouter key, but "an API key is
//   set" does not mean jev works: LLM_PROVIDER may be DeepSeek, in which case
//   the key actually in play belongs to a different vendor. jev therefore reads
//   the OpenRouter key on its own path, and when none is present the whole point
//   is to say so.
//   This capability NEVER returns a default, a prior, or a "probably" — a
//   fabricated probability is worse than no answer, because the model downstream
//   cannot tell it apart from a real one.
import { describeAnswers, parseQuestions, buildRequest } from '../jev/spec';
import { jevDecide } from '../../web/jev-client';
import { GLOBAL_PAGE, type Capability } from '../types';
import { short } from './shared';

export const jevCapabilities: Capability[] = [
  {
    name: 'jev.decide',
    page: GLOBAL_PAGE,
    title: 'Ask jev',
    description:
      'Make a STRUCTURED decision about a piece of text instead of asking for prose. Ask a yes/no ' +
      'question (a probability comes back), a pick-one question (a label from options you define), or ' +
      'an ordered-rubric question (a position on a scale). Use it for routing ("which page/tool should ' +
      'handle this"), ranking, or verifying that a condition holds — then act on the answer. ' +
      'Put the REAL text in `state`; jev only judges what you send it.',
    params: [
      {
        name: 'state',
        type: 'string',
        required: true,
        description:
          'The material to judge — the user\'s message, a task, a draft, a list. Paste it as-is; do ' +
          'not summarise it, because whatever you leave out cannot be judged.',
      },
      {
        name: 'questions',
        type: 'string',
        required: true,
        description:
          'A JSON object of questions, keyed by a short snake_case name. Each value looks like ' +
          '{"type":"noul","instructions":"Is this urgent?","criteria":{"true":"...","false":"..."}}, ' +
          '{"type":"choice","instructions":"Which team?","criteria":{"billing":"...","technical":"..."}} ' +
          '(2-12 options), or {"type":"score","instructions":"How angry?","criteria":["Calm","Angry"]} ' +
          '(an ORDERED array, low to high, 2-12 steps).',
      },
    ],
    run: async (args) => {
      const state = String(args.state ?? '').trim();
      if (!state) {
        return {
          ok: false,
          summary: 'Nothing to judge',
          hint: 'put the text to be judged in the `state` argument',
        };
      }

      const parsed = parseQuestions(args.questions);
      if (!parsed.ok) {
        return {
          ok: false,
          summary: 'Bad question spec',
          hint: `${parsed.error} — questions must be a JSON object of typed questions`,
        };
      }

      // Validate the state too (length, envelope) so an oversized paste is
      // rejected here with a clear reason rather than upstream as a 4xx.
      const built = buildRequest({ state, questions: parsed.value });
      if (!built.ok) return { ok: false, summary: 'State too large', hint: built.error };

      const reply = await jevDecide({ state, questions: parsed.value });
      if (!reply.ok) {
        // Distinguish "no key configured" from a transient failure: the first is
        // the user's to fix, the second is worth retrying.
        const unset = /not configured/i.test(reply.error);
        return {
          ok: false,
          summary: unset ? 'Jev is not set up' : 'Jev could not decide',
          data: { error: reply.error, field: reply.field, skipped: unset },
          hint: unset
            ? 'no OpenRouter key on the server, so the decision was skipped — tell the user, do not guess'
            : reply.error,
        };
      }

      const text = describeAnswers(reply.answers);
      const lines = text.split('\n');
      return {
        ok: true,
        // ONE line on the glasses: the first answer is the headline. The rest,
        // with full probabilities, is in `data` for the model.
        summary: short(lines[0] ?? '', 48),
        data: {
          text,
          answers: reply.answers,
          ...(reply.model ? { model: reply.model } : {}),
          ...(reply.usage ? { usage: reply.usage } : {}),
        },
        hint: lines.length > 1 ? 'every answer, with probabilities, is in data.text' : undefined,
      };
    },
  },
];
