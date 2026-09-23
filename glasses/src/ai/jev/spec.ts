// Jev — the decision spec: build it, validate it, and read the answers back.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE HAS A TWIN: web/server/jev-spec.mjs
// ─────────────────────────────────────────────────────────────────────────────
// The relay is plain Node ESM that is never bundled, and the WebView bundle
// cannot import from outside src/ — so the same logic has to exist twice, exactly
// like tool-markup.ts / tool-markup.mjs. tools/jev-spec-sim.mjs feeds the SAME
// fixtures to both and fails if a single field disagrees. Edit this file and that
// harness tells you what the relay now needs.
//
// WHAT JEV IS
//   Jev is NOT a chat model. It answers narrow, typed questions about a `state`
//   (a string, object or array) and returns CALIBRATED PROBABILITIES instead of
//   prose. Our code owns the workflow and acts on the answers, which is what makes
//   it right for routing, ranking and verification — not conversation. Three
//   question types:
//
//     noul    yes/no, answered as a probability from 0 (no) to 1 (yes)
//     choice  a pick from labelled options, with the full distribution
//     score   a position on an ORDERED rubric (low → high)
//
//   (`noul` is the API's spelling. It is a question type, not a typo for "null".)
//
// THE RESPONSE SHAPE (verified live 200, not inferred from the docs)
//     {"answers":{
//        "is_urgent":  {"type":"noul","noul":0.95},
//        "department": {"type":"choice","choice":"billing",
//                       "probabilities":{"billing":0.88,"technical":0.12},
//                       "confidence":0.81},
//        "frustration":{"type":"score","score":1.05,
//                       "legend":{"0":"Calm","1":"Frustrated","2":"Very angry"},
//                       "probabilities":{"0":0,"1":0.95,"2":0.05}}}}
//
//   THE TWO TRAPS, both handled in `normalizeAnswers`:
//     1. `score` is a 0-BASED, CONTINUOUS float — NOT 1-based, NOT a label. On a
//        3-step rubric 1.05 means "just past Frustrated". Read as 1-based it
//        rounds to 1 → index 0 → "Calm": confidently wrong.
//     2. `probabilities` is keyed by LABEL for `choice` but by INDEX for `score`.
//        Both are returned label-keyed so a caller never has to know which.
//
// STILL TYPE-FREE
//   Nothing here talks to the network. The relay holds the OpenRouter key and
//   exposes POST /api/decisions; ../web/jev-client.ts is what calls it.

/** The only three question types the Decisions API accepts. */
export const QUESTION_TYPES = ['noul', 'choice', 'score'] as const;
export type JevMode = (typeof QUESTION_TYPES)[number];

/** Hard bounds. Everything here exists to keep one request small and honest. */
export const LIMITS = {
  /** Serialised `state` size. Long input is the model's problem, not a feature. */
  MAX_STATE_CHARS: 12000,
  MAX_QUESTIONS: 12,
  MAX_NAME_CHARS: 40,
  MAX_INSTRUCTIONS_CHARS: 400,
  /** A choice label / rubric entry (it is a label, not a sentence). */
  MAX_CRITERIA_LABEL_CHARS: 60,
  /** The one-line explanation attached to a noul side or a choice option. */
  MAX_CRITERIA_DESC_CHARS: 240,
  MAX_CRITERIA_COUNT: 12,
  /** Below two options there is no decision to make. */
  MIN_CRITERIA_COUNT: 2,
} as const;

/**
 * Question names become JSON keys AND are how the caller reads answers back, so
 * they are constrained to lowercase snake — predictable to code, and impossible
 * to confuse with a display label.
 */
export const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Keys of a `noul` criteria object: exactly these two, nothing else. */
export const NOUL_KEYS = ['true', 'false'] as const;

// ── The question spec ───────────────────────────────────────────────────────

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  /** Exactly `true` and `false`: when each answer applies. */
  criteria: { true: string; false: string };
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** label → description. The label is what comes back in `.choice`. */
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** Ordered low → high. ORDER IS THE MEANING, so this is an array. */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

// ── The answers ─────────────────────────────────────────────────────────────

/** `ok: false` carries the unreadable payload so a caller can log or surface it. */
export interface JevAnswerFailure<T extends JevMode = JevMode> {
  type: T;
  ok: false;
  invalid: true;
  raw: unknown;
}

export interface JevNoulAnswer {
  type: 'noul';
  ok: true;
  /** Probability of yes, clamped to 0..1. Threshold it yourself if you have a
   *  better cut than 0.5 — "escalate above 0.8" is a policy, not this module's. */
  value: number;
  /** Convenience cut at 0.5. Prefer `value` when you have a real threshold. */
  yes: boolean;
  confidence: number | null;
}

export interface JevChoiceAnswer {
  type: 'choice';
  ok: true;
  /** Always one of the labels you declared. */
  choice: string;
  /** label → probability, when the responder supplied a distribution. */
  probabilities: Record<string, number> | null;
  confidence: number | null;
}

export interface JevScoreAnswer {
  type: 'score';
  ok: true;
  /** 0-based and CONTINUOUS — 1.05 sits just past the 2nd step. */
  score: number;
  /** The rubric step `score` rounds to. */
  label: string;
  /** Rounded position, 0-based. */
  index: number;
  /** `index + 1`, because "3 of 5" is how a rubric reads to a person. */
  position: number;
  /** How many steps the rubric has, so "2 of 3" is renderable. */
  total: number;
  /** `score` normalised to 0..1 along the rubric, for thresholds and for
   *  comparing rubrics of different lengths. */
  value: number;
  probabilities: Record<string, number> | null;
  confidence: number | null;
}

export type JevAnswer =
  | JevNoulAnswer
  | JevChoiceAnswer
  | JevScoreAnswer
  | JevAnswerFailure;

export type JevAnswers = Record<string, JevAnswer>;

/** A validated question spec is only ever obtained through validateQuestions. */
export interface JevRequest {
  state: string;
  questions: JevQuestions;
  model?: string;
}

export type JevResult<T> = { ok: true; value: T } | JevFailure;
export interface JevFailure {
  ok: false;
  error: string;
  /** Dotted path of the offending field, e.g. `questions.urgency.criteria.true`. */
  field?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** One short, quotable reason — never a stack trace or an object dump. */
function fail(error: string, field?: string): JevFailure {
  return field ? { ok: false, error, field } : { ok: false, error };
}

/**
 * Validate ONE question. Returns `{ ok: true }` or a failure naming the field.
 * Split out from the batch validator so a caller can point at a single field.
 */
export function validateQuestion(name: string, q: unknown): JevResult<JevQuestion> {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > LIMITS.MAX_NAME_CHARS) {
    return fail(
      `question key "${String(name)}" must be lowercase snake_case ` +
        `(a-z, 0-9, _), start with a letter, and be at most ${LIMITS.MAX_NAME_CHARS} chars`,
      'questions',
    );
  }
  if (!isPlainObject(q)) return fail(`question "${name}" must be an object`, `questions.${name}`);
  const type = q.type;
  if (typeof type !== 'string' || !(QUESTION_TYPES as readonly string[]).includes(type)) {
    return fail(
      `question "${name}" has type "${String(type)}" — must be one of: ${QUESTION_TYPES.join(', ')}`,
      `questions.${name}.type`,
    );
  }
  const instructions = typeof q.instructions === 'string' ? q.instructions.trim() : '';
  if (!instructions) {
    return fail(`question "${name}" needs non-empty instructions`, `questions.${name}.instructions`);
  }
  if (instructions.length > LIMITS.MAX_INSTRUCTIONS_CHARS) {
    return fail(
      `question "${name}" instructions exceed ${LIMITS.MAX_INSTRUCTIONS_CHARS} chars`,
      `questions.${name}.instructions`,
    );
  }

  if (type === 'noul') {
    if (!isPlainObject(q.criteria)) {
      return fail(
        `question "${name}" (noul) criteria must be an object with "true" and "false" keys`,
        `questions.${name}.criteria`,
      );
    }
    const stray = Object.keys(q.criteria).filter(
      (k) => !(NOUL_KEYS as readonly string[]).includes(k),
    );
    if (stray.length) {
      return fail(
        `question "${name}" (noul) criteria has unexpected key(s): ${stray.join(', ')} — only "true" and "false" are allowed`,
        `questions.${name}.criteria`,
      );
    }
    for (const k of NOUL_KEYS) {
      const v = q.criteria[k];
      if (typeof v !== 'string' || !v.trim()) {
        return fail(
          `question "${name}" (noul) criteria.${k} must be a non-empty string describing when that answer applies`,
          `questions.${name}.criteria.${k}`,
        );
      }
      if (v.length > LIMITS.MAX_CRITERIA_DESC_CHARS) {
        return fail(
          `question "${name}" (noul) criteria.${k} exceeds ${LIMITS.MAX_CRITERIA_DESC_CHARS} chars`,
          `questions.${name}.criteria.${k}`,
        );
      }
    }
    return {
      ok: true,
      value: {
        type: 'noul',
        instructions,
        criteria: {
          true: String(q.criteria['true']).trim(),
          false: String(q.criteria['false']).trim(),
        },
      },
    };
  }

  if (type === 'choice') {
    if (!isPlainObject(q.criteria)) {
      return fail(
        `question "${name}" (choice) criteria must be an object of label → description`,
        `questions.${name}.criteria`,
      );
    }
    const labels = Object.keys(q.criteria);
    if (labels.length < LIMITS.MIN_CRITERIA_COUNT) {
      return fail(
        `question "${name}" (choice) needs at least ${LIMITS.MIN_CRITERIA_COUNT} options`,
        `questions.${name}.criteria`,
      );
    }
    if (labels.length > LIMITS.MAX_CRITERIA_COUNT) {
      return fail(
        `question "${name}" (choice) has ${labels.length} options — at most ${LIMITS.MAX_CRITERIA_COUNT}`,
        `questions.${name}.criteria`,
      );
    }
    const criteria: Record<string, string> = {};
    for (const label of labels) {
      // A label is returned verbatim as `answers[name].choice`, so it has to be
      // a label a caller can compare against — not whitespace, not a paragraph.
      if (!label.trim() || label.length > LIMITS.MAX_CRITERIA_LABEL_CHARS) {
        return fail(
          `question "${name}" (choice) option "${label}" must be 1..${LIMITS.MAX_CRITERIA_LABEL_CHARS} chars`,
          `questions.${name}.criteria`,
        );
      }
      const desc = q.criteria[label];
      if (typeof desc !== 'string' || !desc.trim()) {
        return fail(
          `question "${name}" (choice) option "${label}" needs a non-empty description`,
          `questions.${name}.criteria.${label}`,
        );
      }
      if (desc.length > LIMITS.MAX_CRITERIA_DESC_CHARS) {
        return fail(
          `question "${name}" (choice) option "${label}" description exceeds ${LIMITS.MAX_CRITERIA_DESC_CHARS} chars`,
          `questions.${name}.criteria.${label}`,
        );
      }
      criteria[label.trim()] = desc.trim();
    }
    return { ok: true, value: { type: 'choice', instructions, criteria } };
  }

  // score — an ORDERED rubric. Order is the meaning, so it must be an array.
  if (!Array.isArray(q.criteria)) {
    return fail(
      `question "${name}" (score) criteria must be an ARRAY ordered low → high (order is the scale)`,
      `questions.${name}.criteria`,
    );
  }
  if (q.criteria.length < LIMITS.MIN_CRITERIA_COUNT) {
    return fail(
      `question "${name}" (score) rubric needs at least ${LIMITS.MIN_CRITERIA_COUNT} steps`,
      `questions.${name}.criteria`,
    );
  }
  if (q.criteria.length > LIMITS.MAX_CRITERIA_COUNT) {
    return fail(
      `question "${name}" (score) rubric has ${q.criteria.length} steps — at most ${LIMITS.MAX_CRITERIA_COUNT}`,
      `questions.${name}.criteria`,
    );
  }
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const step of q.criteria) {
    if (
      typeof step !== 'string' ||
      !step.trim() ||
      step.length > LIMITS.MAX_CRITERIA_LABEL_CHARS
    ) {
      return fail(
        `question "${name}" (score) every rubric step must be a non-empty string of at most ${LIMITS.MAX_CRITERIA_LABEL_CHARS} chars`,
        `questions.${name}.criteria`,
      );
    }
    // A duplicate step makes "position on the rubric" ambiguous, and the answer
    // comes back resolved against these labels — two identical ones cannot be
    // told apart.
    const key = step.trim().toLowerCase();
    if (seen.has(key)) {
      return fail(
        `question "${name}" (score) rubric step "${step}" is duplicated — steps must be distinct`,
        `questions.${name}.criteria`,
      );
    }
    seen.add(key);
    steps.push(step.trim());
  }
  return { ok: true, value: { type: 'score', instructions, criteria: steps } };
}

/** Validate the whole `questions` map, returning a normalised copy. */
export function validateQuestions(questions: unknown): JevResult<JevQuestions> {
  if (!isPlainObject(questions)) {
    return fail('questions must be an object of name → question spec', 'questions');
  }
  const names = Object.keys(questions);
  if (!names.length) return fail('questions must not be empty', 'questions');
  if (names.length > LIMITS.MAX_QUESTIONS) {
    return fail(`too many questions: ${names.length} (at most ${LIMITS.MAX_QUESTIONS})`, 'questions');
  }
  const out: JevQuestions = {};
  for (const name of names) {
    const res = validateQuestion(name, questions[name]);
    if (!res.ok) return res;
    out[name] = res.value;
  }
  return { ok: true, value: out };
}

/**
 * `state` is what the model reasons over. The API takes a string, object or
 * array; non-strings are serialised so the size bound is measurable and the
 * payload shape is constant.
 */
export function stateText(state: unknown): string {
  if (typeof state === 'string') return state;
  if (state === null || state === undefined) return '';
  try {
    return JSON.stringify(state, null, 2);
  } catch {
    return String(state);
  }
}

/** Validate + normalise a whole Decisions request. */
export function buildRequest(body: unknown): JevResult<JevRequest> {
  const src = isPlainObject(body) ? body : {};
  const state = stateText(src.state);
  if (!state.trim()) {
    return fail('state is required — the model has nothing to judge', 'state');
  }
  if (state.length > LIMITS.MAX_STATE_CHARS) {
    return fail(`state is ${state.length} chars — at most ${LIMITS.MAX_STATE_CHARS}`, 'state');
  }
  const vq = validateQuestions(src.questions);
  if (!vq.ok) return vq;
  const out: JevRequest = { state, questions: vq.value };
  const model = typeof src.model === 'string' ? src.model.trim() : '';
  if (model) out.model = model;
  return { ok: true, value: out };
}

/**
 * Parse a question spec that arrived as a JSON string.
 *
 * WHY THIS EXISTS: the capability layer's `ParamSpec.type` supports only
 * `'string' | 'number' | 'boolean' | 'enum'`, so a model calling `jev.decide`
 * can only pass the question set as an encoded string. Parsing is separated from
 * validation so a JSON syntax error reports as a syntax error, not as a shape
 * error that sends the caller hunting through a spec that was never read.
 */
export function parseQuestions(raw: unknown): JevResult<JevQuestions> {
  if (typeof raw === 'object' && raw !== null) return validateQuestions(raw);
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fail('questions is required', 'questions');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail(
      `questions is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      'questions',
    );
  }
  return validateQuestions(parsed);
}

// ── Reading the answers ─────────────────────────────────────────────────────
// Deliberately FORGIVING where the request side is strict. We did not write the
// responder, so no client should crash on a shape we did not foresee. Anything
// unreadable comes back as `{ ok: false, invalid: true, raw }` and is never
// silently coerced into a confident wrong answer.

/**
 * Keep only finite numbers from a probabilities bag, clamped to 0..1.
 *
 * `relabel` swaps numeric keys for their rubric LABEL. Needed because the live
 * API is inconsistent: a `choice` answer keys its distribution by label, but a
 * `score` answer keys it by index (`{"0":0,"1":0.95,"2":0.05}`). Callers should
 * never have to know which they got, so both come back label-keyed.
 */
function probabilities(raw: unknown, relabel: string[] | null = null): Record<string, number> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) continue;
    const key = relabel && /^\d+$/.test(k) ? (relabel[Number(k)] ?? k) : k;
    out[key] = Math.min(1, Math.max(0, n));
  }
  return Object.keys(out).length ? out : null;
}

/** Case-insensitive match of an answer against the declared labels. */
function matchLabel(value: unknown, labels: string[]): string | null {
  if (typeof value !== 'string') return null;
  const want = value.trim().toLowerCase();
  if (!want) return null;
  return labels.find((l) => l.toLowerCase() === want) ?? null;
}

/** The highest-probability label, or null. Ties resolve to declaration order. */
function argmax(probs: Record<string, number> | null, labels: string[]): string | null {
  if (!probs) return null;
  let best: string | null = null;
  let bestP = -1;
  for (const label of labels) {
    const p = probs[label];
    if (typeof p === 'number' && p > bestP) {
      bestP = p;
      best = label;
    }
  }
  return best;
}

function confidenceOf(raw: Record<string, unknown> | null): number | null {
  const c = raw?.confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** Read one answer against the question that produced it. */
function normalizeOne(_name: string, spec: JevQuestion, rawUnknown: unknown): JevAnswer {
  const raw = isPlainObject(rawUnknown) ? rawUnknown : null;
  const bare = typeof rawUnknown === 'number' ? rawUnknown : undefined;
  const p = probabilities(raw?.probabilities);

  if (spec.type === 'noul') {
    // Accept the documented field, a bare number, or the obvious aliases — the
    // contract is "a probability from 0 to 1", so read that intent, then clamp.
    const candidate = [raw?.noul, bare, raw?.value, raw?.probability, raw?.yes, raw?.p].find(
      (v) => v !== undefined && v !== null,
    );
    const n = typeof candidate === 'number' ? candidate : Number(candidate);
    if (!Number.isFinite(n)) {
      return { type: 'noul', ok: false, invalid: true, raw: rawUnknown ?? null };
    }
    const value = Math.min(1, Math.max(0, n));
    return { type: 'noul', ok: true, value, yes: value >= 0.5, confidence: confidenceOf(raw) };
  }

  if (spec.type === 'choice') {
    const labels = Object.keys(spec.criteria);
    const chosen = matchLabel(raw?.choice ?? raw?.label ?? raw?.value, labels) ?? argmax(p, labels);
    if (!chosen) {
      return { type: 'choice', ok: false, invalid: true, raw: rawUnknown ?? null };
    }
    return { type: 'choice', ok: true, choice: chosen, probabilities: p, confidence: confidenceOf(raw) };
  }

  // score — VERIFIED shape: `score` is a **0-based, CONTINUOUS** position on the
  // rubric, with a `legend` naming the steps. A 3-step rubric answering 1.05
  // means "just past the 2nd step", i.e. "Frustrated" — NOT 1-based, and not a
  // label. Reading it as a 1-based integer would round 1.05 → 1 → index 0 →
  // "Calm": a confidently wrong answer. The index is therefore clamped, never
  // shifted.
  const rubric = spec.criteria;
  const pIndexed = probabilities(raw?.probabilities, rubric);
  const rawScore = raw?.score ?? raw?.label ?? raw?.value ?? bare;
  let exact = Number.NaN;
  if (typeof rawScore === 'number' && Number.isFinite(rawScore)) {
    exact = rawScore;
  } else {
    const matched = matchLabel(rawScore, rubric);
    if (matched) exact = rubric.indexOf(matched);
  }
  if (!Number.isFinite(exact)) {
    const best = argmax(pIndexed, rubric);
    if (best) exact = rubric.indexOf(best);
  }
  if (!Number.isFinite(exact)) {
    return { type: 'score', ok: false, invalid: true, raw: rawUnknown ?? null };
  }
  // A continuous value is MORE useful than a rounded label — "escalate above
  // 1.5" is expressible, "above Frustrated" is not — so both are returned.
  const clamped = Math.min(rubric.length - 1, Math.max(0, exact));
  const index = Math.round(clamped);
  return {
    type: 'score',
    ok: true,
    score: clamped,
    label: rubric[index],
    index,
    position: index + 1,
    total: rubric.length,
    value: rubric.length > 1 ? clamped / (rubric.length - 1) : 0,
    probabilities: pIndexed,
    confidence: confidenceOf(raw),
  };
}

/**
 * Turn the API's `answers` into typed results keyed by question name.
 * A question with no readable answer is present as `ok: false` — never missing,
 * so the caller can always iterate the keys it asked for.
 */
export function normalizeAnswers(questions: JevQuestions, rawAnswers: unknown): JevAnswers {
  const src = isPlainObject(rawAnswers) ? rawAnswers : {};
  const out: JevAnswers = {};
  for (const [name, spec] of Object.entries(questions)) {
    out[name] = normalizeOne(name, spec, src[name]);
  }
  return out;
}

/** Two decimals, trailing zeros trimmed — '0.95', '0.5', '0'. */
const r2 = (x: number): string => String(Math.round(x * 100) / 100);

/** A distribution as readable text, most likely first. */
function spread(dist: Record<string, number> | null): string {
  if (!dist) return '';
  const top = Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .map(([label, p]) => `${label} ${r2(p)}`);
  return top.length ? ` [${top.join(', ')}]` : '';
}

/**
 * Render answers as plain text for a model or a log — one line per question.
 *
 * This lives in the spec, not at each call site, because the relay's agent loop
 * and the Jarvis capability both need it and a second copy would drift. It is
 * also the only place that decides how a probability is spelled out.
 */
export function describeAnswers(answers: JevAnswers): string {
  const lines: string[] = [];
  for (const [name, a] of Object.entries(answers)) {
    if (a.ok === false) {
      lines.push(`${name}: (no readable answer)`);
      continue;
    }
    if (a.type === 'noul') {
      lines.push(`${name}: ${a.yes ? 'yes' : 'no'} (${r2(a.value)} likely true)`);
      continue;
    }
    if (a.type === 'choice') {
      lines.push(`${name}: ${a.choice}${spread(a.probabilities)}`);
      continue;
    }
    lines.push(`${name}: ${a.label} (step ${a.position} of ${a.total}, score ${r2(a.score)})`);
  }
  return lines.join('\n');
}

/**
 * Build a question spec from the flat shape a TOOL CALL can express.
 *
 * A tool-calling model writes prose well and JSON poorly, so no tool asks it to
 * author a criteria object: it supplies a question, an optional option list, and
 * the strict spec is built here. This is the whole point of Jev — the model
 * answers, our code owns the shape.
 */
export function specFromToolArgs(args: {
  kind?: unknown;
  question?: unknown;
  options?: unknown;
}): JevResult<JevQuestions> {
  const kind = String(args?.kind ?? '').trim();
  if (!(QUESTION_TYPES as readonly string[]).includes(kind)) {
    return fail(`kind must be one of: ${QUESTION_TYPES.join(', ')}`, 'kind');
  }
  const instructions = String(args?.question ?? '').trim();
  const list = (
    Array.isArray(args?.options) ? args.options : String(args?.options ?? '').split(/[|,\n]/)
  )
    .map((o) => String(o).trim())
    .filter(Boolean);

  if (kind === 'noul') {
    return validateQuestions({
      answer: {
        type: 'noul',
        instructions,
        criteria: {
          true: 'The statement is true of the state',
          false: 'The statement is not true of the state',
        },
      },
    });
  }
  if (list.length < LIMITS.MIN_CRITERIA_COUNT) {
    return fail(
      `kind "${kind}" needs at least ${LIMITS.MIN_CRITERIA_COUNT} options (got ${list.length})`,
      'options',
    );
  }
  if (kind === 'choice') {
    return validateQuestions({
      answer: {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(list.map((l) => [l, `The state matches "${l}"`])),
      },
    });
  }
  return validateQuestions({ answer: { type: 'score', instructions, criteria: list } });
}
