// The Jarvis agent loop.
//
// Runs CLIENT-side over /api/llm rather than the relay's /api/agent/run, because
// the thing being operated is the app's own state, which lives here. The relay's
// agent runs exist for user-authored agents whose tools are server-side draws.
//
// Deliberately store-aware but not store-coupled: it drives ai/store (so the HUD
// and the web panel can render) while keeping the loop itself a plain async
// function that a node harness can drive with a stubbed LLM.
import { GLOBAL_PAGE, type Capability, type CapabilityResult, type PageId, type ToolSchema } from './types';
import { llmChat, type WireMessage, type LlmReply, type WireToolCall } from '../web/agents-client';
import { appSnapshotText } from './context';
import {
  canonicalName,
  capabilitiesForPage,
  execute,
  pageCatalogText,
  pageTitle,
  prepare,
  toToolSchemas,
  toWireName,
} from './registry';
import {
  aiAskConfirm,
  aiBegin,
  aiFail,
  aiFinish,
  aiMaxSteps,
  aiModel,
  aiSetTurn,
  aiStep,
  getAiFocus,
  isAiAborted,
} from './store';
import { memoryMessages, memoryPromptText, rememberExchange } from './memory';
import { conversePromptText, isConversational } from './converse';
import { beginAiBatch, endAiBatch } from './undo';
import { stripToolMarkup } from './tool-markup';

/** DeepSeek tolerates more, but a tight tool set measurably improves selection. */
const MAX_TOOLS = 12;

/**
 * Provider-safe name for anything that crosses the wire. `prepare` accepts both
 * forms, but the transcript we send back must only ever contain the form the
 * provider validated, or the API rejects the whole request as a bad tool name.
 */
function wireName(name: string): string {
  return toWireName(canonicalName(name));
}
/** Tool results are fed back verbatim; keep the context bounded. */
const MAX_RESULT_CHARS = 1500;
const MAX_REPLY_CHARS = 240;
/**
 * How long a CONVERSATIONAL answer may be (see ./converse). A command earns one
 * short sentence because the wearer is waiting on an action; a chat needs the
 * shape of a reply, so it gets two or three.
 *
 * This used to be 480 — barely above the ~450 the model is told it may write, so
 * a merely verbose reply came back from the loop already clipped, and the wearer
 * saw an ellipsis where the second half of the answer should have been. The cap
 * existed because the HUD could only show one screenful; it PAGES now and the
 * listening screen shows that same feed, so the canvas is no longer the binding
 * limit. 720 leaves real headroom over the model's own instruction while still
 * stopping an essay, and a cut is still marked with an ellipsis.
 */
const MAX_CHAT_CHARS = 720;

/**
 * Tool budget, highest value first. Page actions sit above the introspection
 * helpers on purpose: the system prompt already lists every page and action, so
 * nav.list_* are a convenience, not a requirement, and they are the first to go
 * when a page is action-heavy.
 */
const PRIORITY = [
  'say.reply',
  'nav.open_page',
  'undo.last',
  'app.status',
  'nav.list_pages',
  'nav.list_actions',
  'nav.back',
];

function selectTools(focused: PageId): ToolSchema[] {
  const pageCaps = capabilitiesForPage(focused);
  const pageNames = new Set(pageCaps.map((c) => c.name));
  const global = capabilitiesForPage(GLOBAL_PAGE).filter((c) => !pageNames.has(c.name));

  const ranked: Capability[] = [];
  // 1. page actions — the reason this turn exists
  ranked.push(...pageCaps);
  // 2. the two mandatory globals, in the order the model should reach for them
  for (const name of ['say.reply', 'nav.open_page']) {
    const cap = global.find((c) => c.name === name);
    if (cap) ranked.push(cap);
  }
  // 3. everything else, by priority then registration order
  const rest = global.filter((c) => !['say.reply', 'nav.open_page'].includes(c.name));
  rest.sort((a, b) => {
    const ai = PRIORITY.indexOf(a.name);
    const bi = PRIORITY.indexOf(b.name);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  ranked.push(...rest);

  return toToolSchemas(ranked.slice(0, MAX_TOOLS));
}

function systemPrompt(converse = false): string {
  const focus = getAiFocus();
  // Everything the wearer said before, folded into a digest plus the last few
  // turns (see ./memory). Empty until the first exchange, in which case the
  // prompt is byte-for-byte what it was before memory existed.
  const mem = memoryPromptText();
  // Action names below are written in WIRE form (`page__action`) because that is
  // exactly how they appear in this turn's tool list; the registry also accepts
  // the dotted form, so either spelling resolves.
  return [
    'You are Jarvis, the voice assistant inside a pair of smart glasses and its companion web app.',
    'You turn ONE spoken sentence into app actions, or into one short answer.',
    '',
    'TWO LAYERS — follow this order strictly',
    '1. ROUTING. Decide which page the request is about. Actions only run on the FOCUSED page;',
    '   calling another page\'s action returns an error that tells you to route first.',
    '   Change focus with nav__open_page, then call that page\'s actions.',
    '2. ACTION. Run the focused page\'s actions — several in a row if needed, navigating on if the',
    '   request genuinely spans pages.',
    '',
    `FOCUSED PAGE RIGHT NOW: ${focus}`,
    '',
    'RULES',
    '- Resolve "it", "the second one", "my shopping list" from the live state below BEFORE acting.',
    '- Never invent ids, titles or positions. Read first (app__status, a *__list or *__read action) if unsure.',
    '- Prefer one action over many, and matching an existing item over creating a duplicate.',
    '- If the user asked a QUESTION, call say__reply and change nothing. Answer in ONE short sentence.',
    '- If nothing fits, call say__reply with one honest short sentence. Never narrate.',
    '- Destructive actions pause for a tap-to-confirm on their own. Call them directly; do not ask in words.',
    '- Write data the way the user will want to read it: keep their wording, no emoji, keep it short.',
    '- The Jarvis agent queue lists background runs YOU started. If one is finished AND marked [NEW],',
    '  say so in your one short sentence — the wearer cannot otherwise tell that it landed.',
    '- Read a finished run with agents__sessions (newest first, so a fresh run is session "1").',
    '- "Earlier I said", "what did I tell you", "you remember…" refer to the MEMORY block below. Answer',
    '  from it in one sentence; never read the whole block back.',
    '',
    // Placed AFTER the rules so it wins over "answer in ONE short sentence",
    // and only ever for a turn that named nothing in the app (see ./converse for
    // why a wrong guess here is guaranteed to be cheap).
    ...(converse ? [conversePromptText(), ''] : []),
    ...(mem ? [mem, ''] : []),
    'LIVE APP STATE',
    appSnapshotText(),
    '',
    'PAGES (route here — ids are what nav__open_page takes)',
    pageCatalogText(),
  ].join('\n');
}

function shortJson(result: CapabilityResult): string {
  const payload = {
    ok: result.ok,
    summary: result.summary,
    ...(result.hint ? { hint: result.hint } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  };
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = JSON.stringify({ ok: result.ok, summary: result.summary });
  }
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…"}` : text;
}

/** Human-readable HUD copy for the tap-to-confirm prompt. */
function confirmCopy(cap: Capability, args: Record<string, unknown>): { title: string; lines: string[] } {
  const lines: string[] = [];
  // Show the arguments that describe WHAT is about to be destroyed.
  for (const p of cap.params) {
    const v = args[p.name];
    if (v === undefined || v === '') continue;
    const text = String(v).replace(/\s+/g, ' ');
    lines.push(`${p.name}: ${text.length > 48 ? `${text.slice(0, 48)}…` : text}`);
    if (lines.length >= 2) break;
  }
  if (!lines.length) lines.push(cap.description);
  return { title: cap.title, lines };
}

function clean(text: string, max = MAX_REPLY_CHARS): string {
  // Scrub BEFORE flattening: a model that wants a tool it was not offered answers
  // by PRINTING the call instead of making one (see ./tool-markup), and that
  // machine syntax used to fill the HUD container.
  const flat = stripToolMarkup(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A tool-free view of the transcript: the original system + user turn, plus
 * whatever the tools actually returned, as plain text.
 *
 * Handing a model a history full of `tool_calls` while declaring NO tools makes
 * it answer by PRINTING the tool call it wanted to make — DeepSeek emits its
 * native DSML markup as text, and that became the final answer on the glasses.
 * Re-declaring the tools with `tool_choice: 'none'` does not stop it (verified
 * against deepseek-flash), so the scaffolding has to be removed instead.
 */
function toolFreeTurn(messages: WireMessage[], ask: string, keep = 2): WireMessage[] {
  // `keep` is the transcript PREFIX that existed before the first model turn —
  // the system prompt plus whatever conversation memory supplied. Everything
  // after it is this run's own scaffolding and must not reach the model.
  const head = messages
    .slice(0, keep)
    .map((m) => ({ role: m.role, content: stripToolMarkup(String(m.content ?? '')) }))
    .filter((m) => m.content);
  const found: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const name = messages[i - 1]?.tool_calls?.[0]?.function?.name ?? 'result';
    const body = stripToolMarkup(String(m.content ?? ''));
    if (body) found.push(`${name}: ${body}`);
  }
  return [
    ...head,
    ...(found.length ? [{ role: 'user' as const, content: `[tool results]\n${found.join('\n')}\n[end tool results]` }] : []),
    { role: 'user', content: ask },
  ];
}

export interface AiRunOptions {
  utterance: string;
  /** Which page the run starts on. */
  focus: PageId;
  maxSteps?: number;
  model?: string;
  /** Test seam: replace the transport with a scripted stub. */
  llm?: (args: { model: string; messages: WireMessage[]; tools?: ToolSchema[] }) => Promise<LlmReply>;
}

export interface AiRunResult {
  ok: boolean;
  reply: string;
  error?: string;
  /** Whether the run mutated app state (used to decide if undo is offered). */
  changed: boolean;
  /** True when the run never got off the ground, so the caller may fall back. */
  unreachable: boolean;
}

/**
 * Run one spoken command to completion.
 * Reactivity (HUD + web panel) comes from ai/store; this returns the summary.
 *
 * The run OWNS its HUD lifecycle: it opens the run itself so the store's
 * `cancelled` latch from a previous run can never strand this one, and so a
 * caller that forgets `aiBegin` still gets a working counter and Stop button.
 * Callers may call `aiBegin` first to paint the HUD a frame earlier — that is
 * harmless, because opening a run is idempotent.
 */
export async function runAiAgent(opts: AiRunOptions): Promise<AiRunResult> {
  const send = opts.llm ?? llmChat;
  const maxSteps = Math.max(1, opts.maxSteps ?? aiMaxSteps());
  const model = opts.model ?? aiModel();
  // One decision, made once, from the words themselves — a pure function of the
  // utterance, so the prompt and the reply budget below can never disagree about
  // which kind of turn this is.
  const converse = isConversational(opts.utterance);

  aiBegin(opts.utterance, opts.focus);

  const batch = beginAiBatch(opts.utterance);
  // Replay the tail of previous conversations as real turns. This is what makes
  // "make it the second one" or "and the other list" resolvable at all: the
  // store's `jarvisLastReply` is display-only and never reached the model, so
  // before this the transcript was ALWAYS a single system + user pair.
  const history: WireMessage[] = memoryMessages().map((t) => ({
    role: t.role,
    content: t.text,
  }));
  // Prefix the closing tool-free turn must preserve verbatim.
  const keep = 1 + history.length + 1;
  const messages: WireMessage[] = [
    { role: 'system', content: systemPrompt(converse) },
    ...history,
    { role: 'user', content: opts.utterance },
  ];

  let answer = '';
  let lastOk = '';
  let touched = false;

  const finishRun = (reply: string, ok = true): AiRunResult => {
    // Scrub here too, not only in clean(): THIS is the string the caller speaks,
    // and a spoken DSML blob is the bug this guards against. A conversational
    // turn is allowed the longer budget — the answer IS the whole result.
    const spoken = clean(reply, converse ? MAX_CHAT_CHARS : MAX_REPLY_CHARS);
    const changed = endAiBatch(batch);
    touched = changed;
    // The answer is NOT pushed as a step. It is printed in full under the
    // transcript as `= …`, so a step here would put the same sentence on the
    // glasses twice, and a `say__reply` call used to make it three times. On a
    // conversational turn that sentence is the entire message.
    // Persist the exchange so the NEXT turn (and the next launch) can see it.
    // Only a run that actually answered is worth remembering: an aborted or
    // failed one would teach the model that the wearer asked something for
    // nothing, and it would answer the retry as if it had already replied.
    if (ok && spoken) rememberExchange(opts.utterance, spoken);
    if (ok) aiFinish(spoken || 'Done');
    return { ok, reply: spoken, changed, unreachable: false };
  };

  for (let step = 0; step < maxSteps; step++) {
    // The user may have dismissed the HUD (tap / Stop AI / double-tap / leaving
    // the page) while the previous turn was in flight. Bail BEFORE spending
    // another model turn on an abandoned run.
    if (isAiAborted()) return finishRun('', false);

    aiSetTurn(step + 1);
    let res: LlmReply;
    try {
      res = await send({ model, messages, tools: selectTools(getAiFocus()) });
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!res.ok || !res.message) {
      const error = res.error || 'the model did not respond';
      // Nothing has happened yet → let the caller fall back to raw dictation.
      if (!touched && !lastOk) {
        endAiBatch(batch);
        aiFail(error);
        return { ok: false, reply: '', error, changed: false, unreachable: true };
      }
      return finishRun(lastOk || 'Stopped early', false);
    }

    const calls: WireToolCall[] = res.message.tool_calls ?? [];
    const content = (res.message.content ?? '').trim();
    const reasoning = (res.message.reasoning_content ?? '').trim();

    // Cancelled DURING the model call: stop here rather than executing the
    // queued actions. Anything already applied is still undoable, so close the
    // batch and report.
    if (isAiAborted()) return finishRun('', false);

    // CHAIN OF THOUGHT — the model's own words, captured BEFORE anything runs so
    // the HUD shows the reasoning that led to the action rather than only its
    // result. Providers disagree on the field name (`reasoning_content` on
    // DeepSeek, `reasoning` on OpenRouter); a plan sentence written alongside a
    // tool call carries the same signal, so fall back to it. `aiStep` drops the
    // write when the run was cancelled while the model was thinking.
    if (reasoning) aiStep('think', clean(reasoning));
    else if (content && calls.length) aiStep('think', clean(content));

    // No tool call → the model has answered. A reply that is nothing BUT machine
    // syntax means it wanted a tool it was not offered; ignoring it lets the
    // closing turn produce a real sentence instead of echoing markup.
    if (!calls.length) {
      const text = stripToolMarkup(content);
      if (text) return finishRun(text);
      break;
    }

    messages.push({
      role: 'assistant',
      content: res.message.content ?? '',
      tool_calls: calls.map((c) => ({
        ...c,
        function: { ...c.function, name: wireName(c.function?.name ?? '') },
      })),
    });

    for (const call of calls) {
      // One call per turn may be slow; re-check between them so a batch of
      // destructive actions cannot finish after the user pressed stop.
      if (isAiAborted()) return finishRun('', false);

      const name = call.function?.name ?? '';
      let rawArgs: unknown = {};
      if (call.function?.arguments) {
        try {
          rawArgs = JSON.parse(call.function.arguments);
        } catch {
          aiStep('fail', `${wireName(name) || 'action'}: bad arguments`);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: wireName(name) || 'unknown',
            content: JSON.stringify({ ok: false, summary: 'arguments were not valid JSON' }),
          });
          continue;
        }
      }

      const outcome = prepare(name, rawArgs, getAiFocus());
      if (outcome.kind === 'error') {
        aiStep('fail', outcome.error);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: wireName(name) || 'unknown',
          content: JSON.stringify({ ok: false, summary: outcome.error, hint: outcome.hint }),
        });
        continue;
      }

      const { cap, args } = outcome.prepared;

      if (outcome.needsConfirm) {
        const copy = confirmCopy(cap, args);
        const approved = await aiAskConfirm(copy.title, copy.lines);
        if (!approved) {
          aiStep('note', `Declined: ${cap.title}`);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toWireName(cap.name),
            content: JSON.stringify({ ok: false, summary: 'The user declined this action. Do not retry it.' }),
          });
          continue;
        }
      }

      aiStep('call', cap.title);
      const result = await execute(outcome.prepared);
      // EXCEPT say__reply: its entire result IS the sentence, and that sentence
      // already gets the `= …` line below the transcript. Echoing it as a step
      // too would double it on the HUD, which is exactly what a chat cannot
      // afford — there it is the whole message rather than a footnote.
      if (cap.name !== 'say.reply') aiStep(result.ok ? 'ok' : 'fail', result.summary);

      if (cap.name === 'nav.open_page') {
        // The routing line on the HUD.
        aiStep('focus', pageTitle(args.page as PageId));
      }
      if (cap.name === 'say.reply' && result.ok) answer = result.summary;
      if (result.ok && cap.name !== 'say.reply' && cap.name !== 'app.status' && !cap.name.includes('.read')) {
        lastOk = result.summary;
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: toWireName(cap.name),
        content: shortJson(result),
      });
    }

    if (answer) return finishRun(answer);
  }

  // Ran out of turns (or the model went quiet) without a spoken reply.
  if (answer) return finishRun(answer);
  if (lastOk) return finishRun(lastOk);
  if (isAiAborted()) return finishRun('', false);

  // One final, tool-free turn for a sentence — cheap and keeps the HUD honest.
  //
  // `toolFreeTurn` drops the `tool_calls` / `role: 'tool'` scaffolding first,
  // because a transcript that references tools the request does not declare is
  // exactly what makes the model print DSML markup instead of words.
  try {
    const closing = await send({
      model,
      messages: toolFreeTurn(
        messages,
        'Using ONLY the results above, reply with ONE short sentence saying what you did or found. Do not call any tools.',
        keep,
      ),
    });
    const text = stripToolMarkup(closing.message?.content ?? '');
    if (text) return finishRun(text);
  } catch {
    /* fall through */
  }
  return finishRun(clean(lastOk || 'Nothing to do'), false);
}
