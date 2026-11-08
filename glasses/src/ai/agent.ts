// The Jarvis agent loop.
//
// Runs CLIENT-side over /api/llm rather than the relay's /api/agent/run, because
// the thing being operated is the app's own state, which lives here. The relay's
// agent runs exist for user-authored agents whose tools are server-side draws.
//
// Deliberately store-aware but not store-coupled: it drives ai/store (so the HUD
// and the web panel can render) while keeping the loop itself a plain async
// function that a node harness can drive with a stubbed LLM.
import { GLOBAL_PAGE, effectOf, type Capability, type CapabilityResult, type PageId, type ToolSchema } from './types';
import { confirmCopy } from './confirm';
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

/**
 * A CEILING on the tool list — not a budget to spend.
 *
 * This used to be a budget: the reserve was taken out first, then the focused
 * page's actions, and whatever was left went to the remaining globals, with a
 * final `slice(0, MAX_TOOLS)`. That arithmetic had one failure mode and it hit
 * every time — a page declaring enough of its OWN actions consumed the whole
 * list, and every remaining global was silently sliced off. `agents` declares
 * 10 and the reserve was 5, so at a cap of 15 exactly ZERO globals survived on
 * that page, while `pageCatalogText()` went on telling the model that nav__back,
 * undo__last, app__status, nav__list_pages and nav__list_actions were all
 * "always callable". The model called them, got an unknown tool, and reported a
 * failure the wearer could not act on. An advertised-but-absent tool is worse
 * than an omitted one, because the prompt is what sends the model to it.
 *
 * So nothing is trimmed any more: `selectTools` hands over every app-wide action
 * plus the focused page's own actions. MAX_TOOLS is asserted against the real
 * selection per page rather than spent, and it is the sum of the two things that
 * actually bound the list — the 10 app-wide actions and the busiest page's 10.
 * Grow a page past this and a harness fails, which is the signal to make a
 * deliberate decision; a tool disappearing with no error is not.
 *
 * The count is also within what the provider accepts: the relay's own agent path
 * sends at most 12 authored tools beside its built-ins, and DeepSeek's tool limit
 * is well above 20. Export kept because a harness that hardcodes 12 stops testing
 * anything the moment this changes.
 */
export const MAX_TOOLS = 20;

/**
 * Provider-safe name for anything that crosses the wire. `prepare` accepts both
 * forms, but the transcript we send back must only ever contain the form the
 * provider validated, or the API rejects the whole request as a bad tool name.
 */
function wireName(name: string): string {
  return toWireName(canonicalName(name));
}
/**
 * How much of a tool result comes back to the model. Tool results ARE fed back
 * verbatim, so this is the one place a large payload is still bounded.
 *
 * Sized from what the relay can actually store, not picked by feel. A run is at
 * most MAX_STEPS = 5 tool calls, each bounded at TOOL_RESULT_CHARS = 16000, so a
 * session's tool content tops out at 80000 chars — and a session read is the
 * largest result any capability can return. The ceiling sits above that, so it
 * is a RUNAWAY GUARD rather than a second clip the model has to work around.
 *
 * It was 1500, which could not hold a single `agents.sessions` transcript even
 * after the capability had already trimmed it: a past session read back as a
 * fragment of a fragment, and the model correctly reported it as truncated.
 */
const MAX_RESULT_CHARS = 120000;
/**
 * Step text: the model's chain of thought, and this loop's label for what it
 * did. ONE line on the HUD, deliberately short — a 400-character reasoning
 * paragraph would push the answer off the page it exists to introduce.
 */
const MAX_STEP_CHARS = 240;
/**
 * How long an ANSWER may be. This is a runaway guard, NOT a writing budget, and
 * the distinction is the whole point.
 *
 * It used to be a budget, picked per lane (240 for a command, then 480, then 720
 * for a conversation), and every raise was chasing the model: the prompt said
 * "one short sentence", the capability said "~450 in a conversation", and the
 * loop cut at 480 — so a merely verbose reply came back ALREADY clipped and the
 * wearer saw an ellipsis where the rest of the answer should have been. Worse,
 * the lane was GUESSED from the sentence, so "what did the agent say?" named the
 * app, counted as a command, and had its answer cut at 240.
 *
 * The HUD pages now and the listening screen pages the same feed, so length
 * costs the wearer ring swipes rather than words. Nothing here shortens a reply
 * to fit a screen, or a guess about what kind of turn it was. The only cut left
 * is against an answer so long that something has clearly gone wrong, and it is
 * set above DeepSeek's own ceiling for a spoken turn — so in practice it is
 * never reached, and if it ever is, the cut is marked with an ellipsis and every
 * page before it is intact.
 */
const MAX_ANSWER_CHARS = 8000;

/**
 * How many times the same action, with the same arguments, may repeat before the
 * run is stopped for going in circles.
 *
 * This is what ends an unlimited run. It is about PROGRESS rather than length: a
 * model calling the same capability with byte-identical arguments has learned
 * nothing between calls, so more turns cannot help it and can only cost money.
 * Three rather than two, because one honest retry after a transient failure is a
 * real pattern and repeating it once proves nothing.
 */
const MAX_IDENTICAL_CALLS = 3;


/**
 * Actions this loop cannot function without. They lead the list, so an answer and
 * a way to another page are always the first two tools the model reads.
 *
 * They USED to be reserved out of a fixed budget, which is what made the budget
 * dangerous: the reserve was satisfied by taking slots away from the page, and
 * the page's own actions then took slots away from the globals, silently. See
 * MAX_TOOLS above — nothing is trimmed now, and this list only decides ORDER.
 */
const MANDATORY = ['say.reply', 'nav.open_page'];

/**
 * App-wide actions that `pageCatalogText()` advertises on EVERY turn, so they must
 * also be handed over on every turn. When the list was a budget, `rest` ranked by
 * PRIORITY and then truncated at the end — the remainder was eaten before these
 * were reached on any action-heavy page, and jev__decide disappeared from every
 * Docs and Agents turn that way. Listing them here keeps them at the FRONT, so a
 * future change to the ceiling can never push them off the end.
 *
 * location.get is also here because, as a page action, it would have to be
 * ROUTED to, and "where am I?" must not change the page the wearer is looking at
 * in order to answer a question about the world.
 *
 * web.search is the one the assistant is least able to substitute for: the system
 * prompt tells the model never to answer a current-events question from memory,
 * so a turn without this global is a turn where the model is told to search and
 * given no way to.
 */
const ALWAYS_AVAILABLE = ['jev.decide', 'location.get', 'web.search'];

/** Everything that leads the list: the actions this loop and the prompt assume. */
export const RESERVED: string[] = [...MANDATORY, ...ALWAYS_AVAILABLE];

/**
 * Order for the remainder, highest value first. Page actions sit above the
 * introspection helpers on purpose: the system prompt's PAGES block lists every
 * page and every action, so nav.list_* are a convenience, not a requirement.
 *
 * This is now an ORDER and not a cut-off. A name absent from this list sorts to
 * the end rather than out of the request.
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

/**
 * The tool list handed to the model for one focus.
 *
 * THE INVARIANT: everything the prompt advertises for this turn is here. The
 * PAGES block names every page's actions, and it is allowed to name an action on
 * a page you are NOT focused on — that is what routing is for, and the prompt
 * says so. What it may never do is name an APP-WIDE action as "always callable"
 * while this function has quietly dropped it, which is exactly what the old
 * budget did on the busiest page.
 *
 * Exported because the budget, not the registry, used to decide whether a
 * capability was reachable: a registered action that fell off the end might as
 * well not exist, and the prompt still advertised it. Only a real per-page
 * selection can test that, and tools/jev-spec-sim.mjs does it for every page and
 * every global.
 */
export function selectTools(focused: PageId): ToolSchema[] {
  const pageCaps = capabilitiesForPage(focused);
  const pageNames = new Set(pageCaps.map((c) => c.name));
  const globals = capabilitiesForPage(GLOBAL_PAGE).filter((c) => !pageNames.has(c.name));
  const rank = (name: string) => {
    const i = PRIORITY.indexOf(name);
    return i < 0 ? 99 : i;
  };
  const reserved = globals.filter((c) => RESERVED.includes(c.name)).sort((a, b) => rank(a.name) - rank(b.name));
  const rest = globals.filter((c) => !RESERVED.includes(c.name)).sort((a, b) => rank(a.name) - rank(b.name));

  // Reserved globals, the focused page's own actions, then the remaining
  // app-wide helpers. NOTHING is dropped here; the slice is a runaway guard that
  // the per-page assertions keep unreachable.
  const ordered: Capability[] = [...reserved, ...pageCaps, ...rest];

  return toToolSchemas(ordered).slice(0, MAX_TOOLS);
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
    // The tool list is a BUDGET (see selectTools), so it carries the focused
    // page's actions plus the globals that survived. Saying so, and pointing at
    // the PAGES block, is what stops a model from reading an absent tool as an
    // absent permission and telling the wearer it has no access.
    'NOTE: your tool list only carries the focused page\'s actions. The PAGES block below always',
    'lists EVERY page\'s actions, so an action you cannot see as a tool most likely still exists —',
    'route to its page and it becomes callable.',
    '',
    'RULES',
    '- Resolve "it", "the second one", "my shopping list" from the live state below BEFORE acting.',
    '- Never invent ids, titles or positions. Read first (app__status, a *__list or *__read action) if unsure.',
    '- If the request belongs to another page, route there with nav__open_page and do the work. Never',
    '  tell the user you lack access, and never claim a write is unsupported — check the PAGES block',
    '  first, then route.',
    '- Prefer one action over many, and matching an existing item over creating a duplicate.',
    // The answer is not length-limited by the HUD any more — it pages — so the
    // prompt must not be the thing that shortens it. "Short" survives only as a
    // style note: padding is bad, but brevity that loses the answer is worse.
    '- If the user asked a QUESTION, call say__reply and change nothing. Answer it in full, in as',
    '  many sentences as it genuinely needs.',
    '- If nothing fits, call say__reply with one honest short sentence. Never narrate.',
    '- Destructive actions pause for a tap-to-confirm on their own. Call them directly; do not ask in words.',
    '- Write data the way the user will want to read it: keep their wording, no emoji, keep it short.',
    '- The Jarvis agent queue lists background runs YOU started. If one is finished AND marked [NEW],',
    '  say so in your one short sentence — the wearer cannot otherwise tell that it landed.',
    '- Read a finished run with agents__sessions (newest first, so a fresh run is session "1").',
    '- "Earlier I said", "what did I tell you", "you remember…" refer to the MEMORY block below. Answer',
    '  from it in one sentence; never read the whole block back.',
    '',
    // Placed AFTER the rules so it wins over the "act, never narrate" default,
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

/**
 * The JSON handed back to the model after a capability runs. Exported because
 * `MAX_RESULT_CHARS` decides what a capability is able to SAY: a transcript the
 * model cannot fit in a result is a transcript it never reads, and only a real
 * call through this function can show where the boundary now falls.
 */
export function shortJson(result: CapabilityResult): string {
  const payload: Record<string, unknown> = {
    ok: result.ok,
    summary: result.summary,
    ...(result.hint ? { hint: result.hint } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  };
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    return JSON.stringify({ ok: result.ok, summary: result.summary });
  }
  if (text.length <= MAX_RESULT_CHARS) return text;
  // Over budget. Clip the STRING LEAVES, never the serialized text: a raw slice
  // of a JSON string can land inside an escape sequence or a key, so the model
  // receives something it cannot parse. (The old code patched the cut with a
  // literal `…"}` — a hand-rolled repair for exactly that damage.) Re-serializing
  // after each clip is what keeps the payload valid JSON at every size.
  const leaves: Array<{ holder: Record<string, unknown>; key: string }> = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    const holder = value as Record<string, unknown>;
    for (const key of Object.keys(holder)) {
      if (typeof holder[key] === 'string') leaves.push({ holder, key });
      else collect(holder[key], depth + 1);
    }
  };
  collect(payload, 0);
  // Longest first, so the fewest fields are touched.
  leaves.sort((a, b) => String(b.holder[b.key]).length - String(a.holder[a.key]).length);
  const MARK = '…(clipped)';
  for (const leaf of leaves) {
    text = JSON.stringify(payload);
    if (text.length <= MAX_RESULT_CHARS) break;
    // Escaping grows a string (`"` -> `\"`, newline -> `\n`), so leave headroom.
    const over = text.length - MAX_RESULT_CHARS + 64;
    const current = String(leaf.holder[leaf.key]);
    const keep = Math.max(0, current.length - over - MARK.length);
    leaf.holder[leaf.key] = keep > 0 ? `${current.slice(0, keep)}${MARK}` : MARK;
  }
  text = JSON.stringify(payload);
  // Pathological payload (huge non-string leaves): a valid stub beats a cut
  // string the model cannot parse.
  if (text.length > MAX_RESULT_CHARS) {
    return JSON.stringify({
      ok: result.ok,
      summary: `${String(result.summary).slice(0, 400)}${MARK}`,
      hint: 'result too large; ask for a narrower slice',
    });
  }
  return text;
}

function clean(text: string, max = MAX_STEP_CHARS): string {
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
  // 0 or below means NO limit — see MAX_STEPS_DEFAULT in ./store. The loop is
  // ended by an answer, by the wearer's Stop, by a failure, or by the progress
  // guard below; never by a count of turns alone.
  const maxSteps = Math.floor(opts.maxSteps ?? aiMaxSteps());
  const unlimited = !(maxSteps > 0);
  const turnLimit = unlimited ? Number.POSITIVE_INFINITY : maxSteps;
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
    // and a spoken DSML blob is the bug this guards against.
    //
    // One budget for both lanes, and it is a backstop rather than a size the
    // reply is written to fit. It used to be picked from `converse`, which meant
    // a question that happened to name the app had its answer chopped short for
    // no reason the wearer could see. Length is the HUD's problem — it pages.
    const spoken = clean(reply, MAX_ANSWER_CHARS);
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

  // Counted rather than inferred from `maxSteps`: the loop can also end on a
  // `break`, and only a run that really consumed its last turn should be told it
  // ran out of budget.
  let stepsUsed = 0;
  let lastCallSig = '';
  let repeatCalls = 0;
  let stalled = false;
  for (let step = 0; step < turnLimit; step++) {
    // The user may have dismissed the HUD (tap / Stop AI / double-tap / leaving
    // the page) while the previous turn was in flight. Bail BEFORE spending
    // another model turn on an abandoned run.
    if (isAiAborted()) return finishRun('', false);

    stepsUsed = step + 1;
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
          aiStep('note', `Declined: ${cap.title}`, { effect: effectOf(cap) });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toWireName(cap.name),
            content: JSON.stringify({ ok: false, summary: 'The user declined this action. Do not retry it.' }),
          });
          continue;
        }
      }

      // The effect is declared by the capability, not guessed from whether it
      // happened to be flagged destructive. That distinction is what lets an
      // undoable write be recorded as a write instead of being lumped in with
      // a deletion — and it is what `ungatedIrreversible()` audits.
      const effect = effectOf(cap);
      aiStep('call', cap.title, { effect });
      const result = await execute(outcome.prepared);
      // EXCEPT say__reply: its entire result IS the sentence, and that sentence
      // already gets the `= …` line below the transcript. Echoing it as a step
      // too would double it on the HUD, which is exactly what a chat cannot
      // afford — there it is the whole message rather than a footnote.
      if (cap.name !== 'say.reply') {
        aiStep(result.ok ? 'ok' : 'fail', result.summary, {
          effect,
          status: result.ok ? 'ok' : 'failed',
          locus: 'client',
        });
      }

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

    // The progress guard, which is what actually ends an unlimited run early.
    // The same action with the same arguments cannot produce a different result
    // on the next turn, so three in a row is a model going in circles — stopping
    // there costs the wearer nothing they would have gained by continuing.
    const sig = calls
      .map((c) => `${c.function?.name ?? ''}\u0000${c.function?.arguments ?? ''}`)
      .join('\u0001');
    if (sig === lastCallSig) repeatCalls += 1;
    else {
      lastCallSig = sig;
      repeatCalls = 1;
    }
    if (repeatCalls >= MAX_IDENTICAL_CALLS) {
      stalled = true;
      break;
    }
  }

  // Ran out of turns (or the model went quiet) without a spoken reply.
  if (answer) return finishRun(answer);
  if (isAiAborted()) return finishRun('', false);

  // Say so on the HUD when something OTHER than the model ended the run.
  // `lastOk` used to be returned here, BEFORE the closing turn — so a command
  // that ran out of steps reported its last successful action as the answer and
  // looked finished. The closing turn now gets the chance to say what is still
  // missing; `lastOk` is only the fallback for when it cannot answer at all.
  if (stalled) {
    aiStep('note', `Stopped: the same action was repeated ${repeatCalls} times`);
  } else if (!unlimited && stepsUsed >= maxSteps) {
    aiStep('note', `Step budget reached (${maxSteps}) - the answer below may be incomplete`);
  }

  // One final, tool-free turn for the answer — cheap and keeps the HUD honest.
  //
  // `toolFreeTurn` drops the `tool_calls` / `role: 'tool'` scaffolding first,
  // because a transcript that references tools the request does not declare is
  // exactly what makes the model print DSML markup instead of words.
  try {
    const closing = await send({
      model,
      messages: toolFreeTurn(
        messages,
        'Using ONLY the results above, reply for the user with the complete answer the work supports, '
          + 'in plain words, and as long as it needs to be. If the task is unfinished, say exactly what is '
          + 'still missing instead of sounding finished. Do not call any tools.',
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
