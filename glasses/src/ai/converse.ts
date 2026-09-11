// The conversational lane — when Jarvis should TALK instead of act.
//
// Jarvis was built to turn ONE spoken sentence into app actions, and a sentence
// that named no page and no action still had to come back as "one honest short
// sentence". That is the wrong shape for a person who just wants to talk to the
// thing sitting on their face: "how are you" got a status report, and "what do
// you think of this idea" got a status report.
//
// The trigger is deliberately ONE-SIDED, and that asymmetry is the entire safety
// argument. This module only ever decides whether to RELAX a turn:
//
//   • it adds a conversation clause to the system prompt, and
//   • it raises the reply length budget.
//
// It never removes a tool, never reorders the tool list, and never skips the
// app. So:
//   • a FALSE NEGATIVE costs NOTHING — the turn behaves exactly as it did before
//     this file existed, because "act, or answer in one sentence" is the default;
//   • a FALSE POSITIVE costs at most a chattier answer, because every action is
//     still on the table and the clause itself tells the model to ignore it the
//     moment the sentence turns out to refer to the app.
//
// "Could Jarvis miss an agentic command?" is therefore not a risk this module
// carries; the worst case is that a command gets a friendlier preamble. Erring
// towards "that was a command" is the cheap mistake, and every list below is
// tuned that way on purpose.
//
// TWO INDEPENDENT GATES plus a shape check must all agree:
//   A. no page vocabulary — ids, titles and synonyms read LIVE from the registry,
//      so a new page extends this without an edit here;
//   B. no action vocabulary — the verbs that turn a remark into an order;
//   C. a plausible spoken sentence.
import { listPages } from './registry';

/**
 * Words that are conversational filler even though a page may legitimately claim
 * them. This list exists for ONE collision: the registry contributes page
 * TITLES as well as ids, "To-Do" splits into "to" and "do", and those words
 * appear in half of everything a person says — without this filter "what do you
 * think" would read as a command. Most entries are defensive.
 *
 * It must never contain a page id, title or synonym: 'list', 'notes', 'docs',
 * 'todo', 'tasks', 'settings', 'agents', 'document' and 'library' are all app
 * vocabulary and have to keep biting.
 */
const FILLER = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but',
  'all', 'any', 'can', 'could', 'will', 'would', 'its', 'our', 'their', 'his', 'her', 'them',
  'they', 'this', 'that', 'with', 'from', 'into', 'out', 'off', 'one', 'two', 'new', 'own', 'use',
  'see', 'say', 'get', 'got', 'let', 'may', 'might', 'must', 'also', 'just', 'only', 'more',
  'most', 'some', 'such', 'than', 'then', 'there', 'here', 'what', 'when', 'where', 'which',
  'while', 'who', 'why', 'how', 'quick', 'my', 'me', 'is', 'it', 'be', 'as', 'at', 'on', 'in',
  'of', 'or', 'so', 'if', 'no', 'yes', 'ok', 'okay', 'well', 'like', 'want', 'need', 'think',
  'know', 'feel', 'good', 'bad', 'time', 'today', 'now', 'really', 'very', 'much', 'about',
  'after', 'before', 'again',
]);

/**
 * The verb families that make a sentence an ORDER rather than a remark. These are
 * the follow-ups that name the app nowhere and still mean "do it": "make it the
 * second one", "go back", "put it in notes", "and the other list".
 *
 * Over-inclusion is free (it only means "behave as you did before this file
 * existed"); under-inclusion is the only mistake that could ever cost a command.
 * The GENERATIVE verbs are deliberately absent — 'write', 'draft', 'rewrite',
 * 'summarise', 'shorten', 'expand' — because "write me a poem" and "summarise
 * this for me" are exactly the conversational requests this lane is for, and
 * every app edit that needs one of them names a target ('the doc', 'my notes')
 * which gate A already catches.
 */
const ACTION_WORDS = new Set([
  // routing — "go back", "the other one", "switch to agents"
  'open', 'go', 'back', 'next', 'previous', 'first', 'second', 'third', 'fourth', 'fifth', 'last',
  'other', 'another', 'both', 'switch', 'navigate', 'instead', 'again',
  // mutation — "add milk", "tick the second one", "clear it"
  'add', 'create', 'delete', 'remove', 'clear', 'rename', 'edit', 'update', 'change', 'move',
  'archive', 'restore', 'tick', 'untick', 'uncheck', 'check', 'mark', 'complete', 'done', 'set',
  'put', 'enable', 'disable',
  // reading — "show me", "search for", "anything in my list"
  'show', 'read', 'find', 'search', 'filter', 'sort', 'list', 'save',
  // running — "run the news agent", "stop"
  'run', 'launch', 'trigger', 'start', 'stop', 'pause', 'resume', 'send', 'execute',
  // remembering — "remember I park in bay 12"
  'remind', 'remember', 'forget', 'schedule',
  // reverting
  'undo', 'redo', 'cancel', 'confirm', 'approve', 'decline',
  // transcript surgery — app edits, not creative writing
  'append', 'prepend', 'copy',
]);

/**
 * Longer than this and it is a dictation or a dictated command, not chit-chat.
 * Generous on purpose: the shape check is here to catch a machine-ish blob, not
 * to police how much a person says.
 */
const MAX_CHAT_WORDS = 60;

/** Split a sentence the way an unknown-word check wants: lower-case tokens. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The app's vocabulary is plural ('tasks', 'docs', 'agents') and a person says
 * "the agent", not "the agents". Without this, "what did the agent say" would
 * read as conversation. Crude on purpose — a wrong stem can only ever make more
 * sentences look like commands, which is the cheap direction.
 */
function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/**
 * Page ids, titles and synonyms as a word set, built fresh on every call.
 *
 * Not cached: pages register at import time and a later `registerPage` must not
 * be frozen out of the vocabulary. Rebuilding a set from five short strings once
 * per spoken sentence is free.
 */
function appWords(): Set<string> {
  const words = new Set<string>();
  const add = (word: string): void => {
    if (word.length < 3 || FILLER.has(word)) return;
    words.add(word);
    const one = singular(word);
    if (one !== word && !FILLER.has(one)) words.add(one);
  };
  for (const page of listPages()) {
    for (const source of [page.id, page.title, ...page.synonyms]) {
      const lower = String(source).toLowerCase();
      // The squashed form too, so "To-Do" contributes "todo" and not just the
      // two fragments every sentence in the world contains.
      add(lower.replace(/[^a-z0-9]/g, ''));
      for (const token of tokenise(lower)) add(token);
    }
  }
  return words;
}

/**
 * True when the sentence carries no sign of the app or of an order, so the
 * wearer is probably just talking.
 *
 * Callers use this to RELAX a turn (see the header) — never to restrict one. If
 * the answer is used to take anything away, this function's whole safety
 * argument is void.
 */
export function isConversational(utterance: string): boolean {
  const text = String(utterance ?? '').trim();
  if (!text) return false;

  const tokens = tokenise(text);
  if (!tokens.length || tokens.length > MAX_CHAT_WORDS) return false;

  const app = appWords();
  // No pages registered means the catalog never loaded, which would make every
  // sentence in the world look conversational. Fail towards ACTING instead.
  if (!app.size) return false;
  for (const token of tokens) {
    // Gate A — it names part of the app.
    if (app.has(token)) return false;
    // Gate B — it is phrased as an order.
    if (ACTION_WORDS.has(token)) return false;
  }
  return true;
}

/**
 * The prompt clause spliced in when `isConversational` said yes.
 *
 * It is placed AFTER the RULES block so it wins over the "act, never narrate"
 * default, and its last line deliberately hands the turn back: a heuristic that
 * guesses wrong must be overrulable BY THE MODEL, or a false positive really
 * would swallow a command.
 *
 * It does NOT shorten the answer any more. It used to ask for "two or three
 * sentences", which made the PROMPT the thing that cut the reply — the loop's
 * cap was only ever chasing it. The glasses page a long answer, so the only
 * length instruction left is "do not pad".
 */
export function conversePromptText(): string {
  return [
    'CONVERSATION — this sentence names nothing in the app',
    'The wearer is probably just talking to you, not asking for anything to change. Answer them.',
    '- Reply in your OWN words, the way a helpful person would talk, and take as much room as the',
    '  answer needs: there is no length limit and the glasses page a long reply. Do not pad, and do',
    '  not cut yourself short either.',
    '  This is the one turn where "never narrate" does not apply to the ANSWER itself.',
    '- It is fine to ask a short question back.',
    '- Still change NOTHING: do not open a page, do not call an action, do not invent one.',
    '- If they asked for something this app cannot do, say so in one plain sentence and offer',
    '  what you CAN do instead.',
    '- THIS PARAGRAPH LOSES TO THE APP. If the sentence does turn out to name a page, an item or',
    '  an action, ignore everything above and act on it exactly as you normally would.',
  ].join('\n');
}
