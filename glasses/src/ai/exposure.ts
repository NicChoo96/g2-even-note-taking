// Exposure policy: does an agent's own words match the tools it can reach?
//
// THE FAILURE THIS EXISTS TO CATCH
//   `agent.toolIds` is the ONLY thing that decides what an agent can reach —
//   `agents.trigger` filters the catalogue by it — and until now NOTHING compared
//   that list to what the agent's prompt says it will do. So an agent whose
//   prompt promises "run 4 to 6 web searches" could hold no web tool at all: the
//   run started, the model was handed a prompt telling it to search, no such tool
//   was in the request, and it either skipped the step or wrote around it. The
//   transcript then reads as a MODEL failure. It is a DATA failure, and no code
//   anywhere was in a position to notice it.
//
// WHAT THIS MODULE IS NOT
//   It is not a second capability list, and the difference is the design. A rule
//   here cannot reach a tool: no id, no factory, no attach path — it only
//   classifies text. Reaching a tool is still one function, `ensureSeedTool` in
//   capabilities/agents.ts, called from one capability. (This is the shape that
//   satisfies docs/agent-architecture.md section 8's refusal of "a second
//   capability list for agents" rather than breaking it.)
//
// THE VOCABULARY IS BORROWED, NOT RESTATED
//   `promiseRules(seeds)` takes the seed table as an argument and uses each
//   seed's own `words` as the promise vocabulary by default. So there is one
//   table of what these things are CALLED, and a new seed kind is covered the day
//   it is added rather than the day someone remembers to extend this file.
//   Only the two kinds where PROSE reads differently from SPEECH get an override,
//   and each carries the reason. tools/exposure-sim.mjs asserts one rule per seed
//   kind, so a kind added without one fails the sweep instead of quietly
//   defaulting to "an agent can never promise this".
//
// WHY A DENIAL IS THE LOUD HALF
//   The asymmetry is deliberate. A missed promise leaves the gap open — the bug
//   this file was written for. A false promise is a proposal the wearer declines.
//   But attaching a tool to an agent whose prompt says it does NOT have one is
//   neither: it changes what the agent can do in a way the agent will contradict
//   out loud. So promise detection stays broad and the withdrawal guard stays
//   conservative and explicit — see `withdrawn`, which is the rule that stops
//   "never claim to have saved a document" from being read as a request for the
//   document store.
import type { AgentDef, ToolDef, ToolKind } from '../types';

/**
 * What a seed contributes to a rule. Structural on purpose: the caller passes
 * the real SEED_TOOLS and this file never imports the capability module, so the
 * policy stays a leaf and a harness can drive it with two lines of fixture.
 */
export interface SeedLike {
  kind: ToolKind;
  words: RegExp;
}

/**
 * How much text before a mention can still take it away.
 *
 * A denial has to be ABOUT the mention to count, so this is a window rather than
 * the whole sentence, and a clause break inside the window ends the search (see
 * `withdrawn`). 30 characters is roughly "have no ", "never claim to have
 * saved" — long enough for every real negation of these nouns, short enough that
 * a negator belonging to a previous clause does not reach across.
 */
const NEG_WINDOW = 30;

/**
 * Words that take a capability away.
 *
 * NOT in here: "only", "solely", "merely", "exclusively". Those RESTRICT a
 * capability rather than removing it — "only web search, up to 6 times" is an
 * agent that has web search and is being told to use it sparingly, and reading it
 * as a denial would be exactly backwards.
 */
const NEGATOR = /\b(?:no|not|never|nor|without|none|cannot|can'?t|do(?:es)?n'?t|didn'?t|isn'?t|aren'?t|won'?t|unable|incapable|lacks?|lacking|missing|absent)\b/i;

/**
 * Negations that are not negations.
 *
 * "Do not forget to run a search" contains a negator and a promise, and reads as
 * a denial to anything that looks for the word "not" — but it is the opposite:
 * an instruction emphasised. It is a very common way to write these prompts, and
 * getting it backwards silently withdraws the capability the prompt is insisting
 * on. Removed before the negator test rather than added to NEGATOR's exceptions,
 * so the idiom cannot leak into any other check.
 */
const NOT_A_DENIAL = /\b(?:do(?:es)?\s+n'?o?t|don'?t|never)\s+(?:forget|fail|hesitate)\b/gi;

/**
 * Ends the negator's reach.
 *
 * A negation governs ITS OWN clause. "the results do not cover the question, run
 * another search" is a promise to search again, and the "not" belongs to the
 * clause that ended at the comma — so the naive version of this guard turned
 * every "if that does not work, search again" instruction into a denial.
 */
const CLAUSE_BREAK = /[,;:.!?]|\b(?:but|however|though|although|yet|instead|otherwise|then)\b/i;

/**
 * What turns a mention into a commitment the agent makes about its own run.
 *
 * Three families, and the third is why this exists at all: a directive ("use
 * web search"), a possession ("you have access to the document store"), and a
 * bare capability admission ("web search is available"). Without it, any prompt
 * that MENTIONS a concept — "the reports you receive", "today's tasks" — would
 * read as a request for the tool that shares its noun.
 *
 * NOT in here, deliberately: must, should, need, may, will. Those are the modal
 * verbs a prompt uses to describe an OUTPUT ("these reports must be under 300
 * words", "the summary will be short"), so including them made every mention of
 * the noun a request for the tool. A real commitment is an act — call, use,
 * find, publish, save — or a plain statement of possession.
 */
const COMMIT = /\b(?:use[sd]?|using|call(?:s|ed|ing)?|invoke[sd]?|run(?:s|ning)?|check(?:s|ed|ing)?|pull(?:s|ed|ing)?|fetch(?:es|ed|ing)?|find(?:s|ing)?|look(?:s|ed|ing)?\s+up|search(?:es|ed|ing)?|browse[sd]?|browsing|save[sd]?|saving|stor(?:e|es|ed|ing)|publish(?:es|ed|ing)?|writ(?:e|es|ten|ing)|append(?:s|ed|ing)?|creat(?:e|es|ed|ing)|add(?:s|ed|ing)?|record(?:s|ed|ing)?|log(?:s|ged|ging)?|read(?:s|ing)?|retriev(?:e|es|ed|ing)|access|availabl(?:e|ility)|have|has|had|can|provide[sd]?|give[s]?|send(?:s|t)?|file[sd]?)\b/i;

/**
 * "You have no tools at all."
 *
 * A single sentence that withdraws EVERY kind, and it has to be matched tightly
 * or it does real damage: "you have no Docs or Files tools" is a denial of two
 * kinds, not of all seven, and the optional groups here cannot absorb "Docs or
 * Files" — which is the whole reason it is written as `(?:any )?(?:external )?`
 * and not as a wildcard.
 */
const TOOLLESS = /\b(?:no|without|zero|none of the)\s+(?:any\s+)?(?:external\s+|other\s+)?tools?\b/i;

/**
 * The two kinds whose promise reading is NOT their voice reading.
 *
 * Deliberately a short, explicit list rather than a general mechanism: an
 * override is a claim that speech and prose disagree here, and each one has to
 * argue its case in `why`.
 */
interface RuleOverride {
  names?: RegExp;
  commit?: RegExp;
  why: string;
}

const OVERRIDES: Partial<Record<ToolKind, RuleOverride>> = {
  // Speech: "search" is nearly always the web, and the seed word is deliberately
  // loose. Prose: a search of the agent's OWN material is not a web request, so
  // the bare word is too wide to use alone — but it is still kept, because an
  // agent told to "run 4 to 6 searches" over current events is asking for the
  // web, and MISSING that promise is the bug this file exists for. Recall wins
  // on the promise side (see the header); the withdrawal guard protects the rest.
  //
  // The additions are the ways these prompts describe the web WITHOUT saying
  // "web": "today's gaming headlines", "news and social signals". A word the
  // prompt uses for the thing it is told to fetch is evidence, and leaving it out
  // would recreate the gap for the agents the report actually lists.
  web: {
    names:
      /\b(?:web ?search|web[- ]?search(?:es)?|online|internet|tavily|brave|google|headlines?|news|social signals?|real[- ]?time|current (?:information|events|news|data|prices|weather|conditions|scores|standings)|latest (?:news|headlines|information|data|results)|breaking news|search(?:es|ing)?)\b/i,
    why: 'prose says "search" for its own material too, so this keeps the bare verb (recall) and relies on COMMIT plus the withdrawal guard for precision',
  },
  // Speech: FILES_SEED's vocabulary is the loosest in the table on purpose — it
  // owns "docs", "documents", "store", "library" so those phrases reach the
  // gateway. Prose: that same looseness would read every mention of the word
  // "documents" as a request to publish one, which is the single most common
  // false positive available here ("read the documents you are given"). The
  // override narrows it to the gateway's DISTINGUISHING acts — and keeps
  // `store` and `report`, because those ARE how these prompts say "file it".
  files: {
    names:
      /\b(?:document store|stor(?:e|es|ed|ing)|publish(?:es|ed|ing)?|html (?:page|file|report|document|artifact)|deliverable|briefing(?:s)?|report(?:s)?|web ?page|a link (?:the wearer|they|you) can open)\b/i,
    why: "the gateway's own words are loosest of all, and prose mentions 'documents' constantly without meaning to publish anything",
  },
  // Speech: "where am I" is the whole vocabulary, because a wearer asking about
  // location is standing somewhere and asking about now. Prose: these prompts
  // never speak in the first person — they describe the RUN ("places near a
  // location", "the wearer's position") — so the seed's voice words are close to
  // useless for the two agents the report calls location-dependent.
  location: {
    names:
      /(?:\blocat|whereabouts|where (?:am i|are we|i am|we are)|\bgps\b|\bcoords?\b|coordinates?|latitude|longitude|\bnear ?(?:me|by|us)\b|\bmy (?:position|coordinates|location)\b|geolocation|\bwearer'?s (?:position|location|coordinates)\b|near a location|places near)/i,
    why: 'a run prompt describes the wearer in the third person, so the first-person voice vocabulary alone never fires',
  },
};

/** One kind's promise grammar, resolved. */
export interface PromiseRule {
  kind: ToolKind;
  /** What names the capability. */
  names: RegExp;
  /** What makes naming it a commitment. */
  commit: RegExp;
  /** Where the promise reading came from — the reviewer's note. */
  why: string;
}

/**
 * Build one rule per seed. THIS is the coverage mechanism: the kinds come from
 * the seed table, so coverage cannot drift from the tools that exist.
 */
export function promiseRules(seeds: readonly SeedLike[]): PromiseRule[] {
  return seeds.map((seed) => {
    const override = OVERRIDES[seed.kind];
    return {
      kind: seed.kind,
      names: override?.names ?? seed.words,
      commit: override?.commit ?? COMMIT,
      why: override?.why ?? 'no override: for this kind, prose reads the same as speech',
    };
  });
}

/** Every occurrence of `re` in `text`, whether or not the caller's regex is global. */
function mentions(re: RegExp, text: string): { text: string; index: number }[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: { text: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (m[0]) out.push({ text: m[0], index: m.index });
    else g.lastIndex += 1;
  }
  return out;
}

/**
 * Does something in the last `NEG_WINDOW` characters take this mention away, and
 * how far does it reach?
 *
 * Only the text since the most recent clause break counts, and the break itself
 * is included so "no, never use search" is still caught.
 *
 * `local` — a restriction on an act within its clause ("do not publish THIS,
 * but do save the report"). It governs the mention it sits next to and nothing
 * more, so a committed mention elsewhere in the prompt still stands.
 *
 * `global` — a statement about the run's capability ("you have no internet
 * access", "search is not available"). It is about the whole agent, so it
 * overrules a promise made in another bullet.
 *
 * The distinction is the difference between the two prompts this file has to get
 * right: a restriction is a legitimate sentence that must not withdraw a
 * capability mentioned elsewhere, and a capability denial is the reason the
 * report's AI Model Tracker must never be handed the tools its prompt disowns.
 * Treating them alike got one of the two cases wrong whichever way it was
 * resolved.
 */
const CAPABILITY_SCOPE =
  /\b(?:have|has|had|get|gets|got|access|available|availability|connect|connected|connection|enabled|support(?:s|ed)?|granted|permitted|allowed)\b/i;
function denial(sentence: string, at: number): 'none' | 'local' | 'global' {
  const before = sentence.slice(Math.max(0, at - NEG_WINDOW), at).replace(NOT_A_DENIAL, ' ');
  const cut = before.search(CLAUSE_BREAK);
  const clause = cut === -1 ? before : before.slice(cut);
  if (!NEGATOR.test(clause)) return 'none';
  return CAPABILITY_SCOPE.test(clause) ? 'global' : 'local';
}

/**
 * Split prose into the units a negation is scoped to.
 *
 * Newlines matter as much as full stops: these prompts are bullet lists, and a
 * bullet is a clause. Splitting on `.` alone ran two bullets together and let the
 * "Never" of the second govern the first.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** What one agent's words say about one kind. */
interface Verdict {
  promise: string | null;
  withdrawn: string | null;
  /** The refusal was a statement about the run's capability, not a local restriction. */
  capability: boolean;
}

/** The sentence that decides it, and which way. */
export interface ExposureFinding {
  kind: ToolKind;
  /** true = the agent promises this capability; false = it explicitly refuses it. */
  promise: boolean;
  /** The sentence that decided it, verbatim — the audit trail. */
  because: string;
}

/** Per-agent reading, before it is compared to what is attached. */
export interface AgentExposure {
  /** Kinds the agent's words promise. */
  promised: ExposureFinding[];
  /** Kinds the agent's words refuse. Wins over a promise in the same text. */
  withdrawn: ExposureFinding[];
  /** The agent declares it has no tools at all. */
  toolless: boolean;
}

/**
 * Read one agent's words. Pure: no catalogue, no store, no network.
 *
 * A denial beats a promise for the same kind, unless the denial is only a local
 * restriction — see `denial` for why those two are not the same thing. The
 * ordering is not a tie-break for convenience: a prompt that both promises and
 * disowns a capability is a bug in the prompt, and the safe reading of it is the
 * one that does not hand the agent something it was told it cannot use.
 */
export function readExposure(text: string, rules: readonly PromiseRule[]): AgentExposure {
  const lines = sentences(text);
  const toolless = lines.some((line) => TOOLLESS.test(line));
  const verdicts = new Map<ToolKind, Verdict>();

  for (const line of lines) {
    for (const rule of rules) {
      const hits = mentions(rule.names, line);
      if (!hits.length) continue;
      const verdict = verdicts.get(rule.kind) ?? { promise: null, withdrawn: null, capability: false };
      const commits = rule.commit.test(line);
      for (const hit of hits) {
        const how = denial(line, hit.index);
        if (how !== 'none') {
          verdict.withdrawn = verdict.withdrawn ?? line;
          if (how === 'global') verdict.capability = true;
        } else if (commits) {
          verdict.promise = verdict.promise ?? line;
        }
      }
      verdicts.set(rule.kind, verdict);
    }
  }

  const promised: ExposureFinding[] = [];
  const withdrawnKinds: ExposureFinding[] = [];
  for (const [kind, verdict] of verdicts) {
    const disowned = verdict.withdrawn !== null && (verdict.promise === null || verdict.capability);
    if (disowned) withdrawnKinds.push({ kind, promise: false, because: verdict.withdrawn as string });
    else if (verdict.promise) promised.push({ kind, promise: true, because: verdict.promise });
  }
  return { promised, withdrawn: withdrawnKinds, toolless };
}

/** One agent, its words, and the gap between the two. */
export interface ExposureGap {
  agentId: string;
  agentName: string;
  /** Promised by the words, absent from `toolIds` — this is what a proposal is for. */
  missing: ToolKind[];
  /** Mentioned and refused. Never proposed; reported so the sweep can see it. */
  denied: ToolKind[];
  /** kind -> the deciding sentence, for the proposal text. */
  because: Partial<Record<ToolKind, string>>;
  /** Every kind the agent already holds. */
  attached: ToolKind[];
}

/** The parts of app state this policy reads. Structural, so a harness needs no store. */
export interface ExposureInput {
  agents: readonly AgentDef[];
  tools: readonly ToolDef[];
}

/** The kinds an agent already holds, resolved through the catalogue it points at. */
function attachedKinds(agent: AgentDef, tools: readonly ToolDef[]): ToolKind[] {
  const byId = new Map(tools.map((t) => [t.id, t.kind]));
  const out: ToolKind[] = [];
  for (const id of agent.toolIds ?? []) {
    const kind = byId.get(id);
    if (kind && !out.includes(kind)) out.push(kind);
  }
  return out;
}

/**
 * Every agent whose words and tools disagree.
 *
 * An agent with nothing missing and nothing disowned is omitted, so an empty
 * result is the healthy state and a caller can treat any row as something to say
 * out loud. An agent that declares itself toolless is skipped: it is not a gap, it
 * is a deliberate design, and proposing six tools to it would be the app arguing
 * with the wearer.
 *
 * A row with an empty `missing` but a non-empty `denied` is a contradiction — the
 * prompt both asks for a capability and says it is unavailable. It is returned so
 * the wearer can be told, and it is inert: `proposalOf` refuses it, so surfacing a
 * contradiction can never turn into an attachment.
 */
export function exposureGaps(input: ExposureInput, rules: readonly PromiseRule[]): ExposureGap[] {
  const gaps: ExposureGap[] = [];
  for (const agent of input.agents) {
    const words = [agent.systemPrompt ?? '', agent.prompt ?? ''].join('\n').trim();
    if (!words) continue;
    const read = readExposure(words, rules);
    if (read.toolless) continue;

    const attached = attachedKinds(agent, input.tools);
    const denied = read.withdrawn.map((f) => f.kind);
    const missing = read.promised
      .filter((f) => !denied.includes(f.kind) && !attached.includes(f.kind))
      .map((f) => f.kind);
    if (!missing.length && !denied.length) continue;

    const because: Partial<Record<ToolKind, string>> = {};
    for (const finding of read.promised) {
      if (missing.includes(finding.kind)) because[finding.kind] = finding.because;
    }
    gaps.push({ agentId: agent.id, agentName: agent.name, missing, denied, because, attached });
  }
  return gaps;
}

/** A spoken label for a kind. Not the seed's `name` — that is the tool row's. */
const KIND_LABEL: Partial<Record<ToolKind, string>> = {
  web: 'web search',
  http: 'the http tool',
  jev: 'the decision tool',
  files: 'the document store',
  todo: 'the to-do list',
  docs: 'saved docs',
  notes: 'notes',
  location: 'location',
};

export function kindLabel(kind: ToolKind): string {
  return KIND_LABEL[kind] ?? String(kind);
}

/**
 * One line, ASCII, for the HUD and the ledger.
 *
 * The ASCII filter is not cosmetic. This text becomes a ledger entry's `text`, and
 * the ledger clips it to MAX_TEXT_CHARS and strips it to printable ASCII — so a
 * name with a curly quote or an accent in it would arrive as something the wearer
 * never saw written. Filtering here means what is built is what lands, and the
 * `...` is ASCII because an ellipsis character is exactly the kind of thing the
 * ledger's strip would eat.
 */
function clip(text: string, max: number): string {
  const one = text
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

/** What a proposal says and what it carries. */
export interface ExposureProposal {
  /** The question, ready to speak. */
  text: string;
  /** Idempotency key — one open proposal per agent and kind set. */
  key: string;
  /** The kinds to add. */
  add: ToolKind[];
  /** kind -> the sentence that promised it. */
  because: Partial<Record<ToolKind, string>>;
}

/**
 * Turn a gap into ONE thing to say, or nothing.
 *
 * Idempotent by construction: the key is derived from the agent and the exact set
 * of kinds it is missing, so a detection pass that runs on every load re-derives
 * the SAME key instead of stacking a second proposal on top of the first. A
 * proposal the wearer declines re-appears only if its evidence changed.
 *
 * The sentence is bounded because it becomes the ledger entry's text, and the
 * ledger clips at MAX_TEXT_CHARS and strips to printable ASCII — a proposal cut
 * mid-word reads as a bug, so the clip happens here where the words still are.
 */
export function proposalOf(gap: ExposureGap): ExposureProposal | null {
  if (!gap.missing.length) return null;
  const names = gap.missing.map(kindLabel);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const because = clip(gap.because[gap.missing[0]] ?? '', 48);
  return {
    text: clip(`Give ${clip(gap.agentName, 32)} ${list}? It says: ${because}`, 118),
    key: `expose:${gap.agentId}:${gap.missing.join('+')}`,
    add: gap.missing,
    because: gap.because,
  };
}
