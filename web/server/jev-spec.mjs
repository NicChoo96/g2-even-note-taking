// Jev — the decision spec: build it, validate it, and read the answers back.
//
// WHAT JEV IS
//   Jev is NOT a chat model. It answers narrow, typed questions about a `state`
//   (a string, object or array) and returns CALIBRATED PROBABILITIES rather than
//   prose. Your code owns the workflow and acts on the answers, which is what
//   makes it the right tool for routing, ranking and verification. Three
//   question types:
//
//     noul    yes/no, answered as a probability from 0 (no) to 1 (yes)
//     choice  a pick from labelled options you define, with a full distribution
//     score   a position on an ORDERED rubric you define (low → high)
//
//   (`noul` is the API's own spelling. It is one question type, not a typo for
//   "null" — treat it as "no/yes as a probability".)
//
// TWO IMPLEMENTATIONS, ONE TRUTH
//   This file ships twice, exactly like tool-markup.mjs:
//     • web/server/jev-spec.mjs  — zero-build Node ESM, used by the relay
//     • src/ai/jev/spec.ts       — bundled into the WebView
//   They cannot share a module (the deploy image copies only glasses/, and the
//   relay is never bundled), so tools/jev-spec-sim.mjs feeds the SAME fixtures
//   to BOTH and fails if they disagree. Edit one, and that harness tells you.
//
// WHY VALIDATION IS STRICT HERE
//   The question spec is the only structured thing we hand upstream, and a
//   malformed spec is not a soft failure — it is an opaque 4xx that tells the
//   caller nothing. So every rule is checked locally, first, and a rejection
//   names the exact field. The response side is the opposite: we did not write
//   the responder, so `normalizeAnswers` is deliberately forgiving and reports
//   `invalid: true` rather than inventing an answer.
//
// THE RESPONSE SHAPE (verified live 200, not inferred from the docs)
//   Every answer echoes its `type`, and each type carries an optional
//   `confidence`:
//
//     {"model":"typesafe/jev-1.13-20260917",
//      "answers":{
//        "is_urgent":  {"type":"noul","noul":0.95},
//        "department": {"type":"choice","choice":"billing",
//                       "probabilities":{"technical":0.12,"billing":0.88,"sales":0},
//                       "confidence":0.81},
//        "frustration":{"type":"score","score":1.05,
//                       "legend":{"0":"Calm","1":"Frustrated","2":"Very angry"},
//                       "probabilities":{"0":0,"1":0.95,"2":0.05},
//                       "confidence":0.93}},
//      "usage":{...},"id":"gen-dec-...","provider":"TypeSafe"}
//
//   THE TWO TRAPS, both handled below:
//     1. `score` is a 0-BASED, CONTINUOUS float — NOT 1-based, NOT a label.
//        A 3-step rubric answering 1.05 means "just past Frustrated". Reading it
//        as 1-based would round it to 1 → index 0 → "Calm": confidently wrong.
//     2. `probabilities` is keyed by LABEL for `choice` but by INDEX for `score`
//        (`{"0":0,"1":0.95}`). Both are returned label-keyed so a caller never
//        has to know which it got.

/** The only three question types the Decisions API accepts. */
export const QUESTION_TYPES = ['noul', 'choice', 'score'];

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
};

/**
 * Question names become JSON keys AND are how the caller reads answers back, so
 * they are constrained to lowercase snake — predictable to code, and impossible
 * to confuse with a display label.
 */
export const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Keys of a `noul` criteria object: exactly these two, nothing else. */
export const NOUL_KEYS = ['true', 'false'];

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** One short, quotable reason — never a stack trace or an object dump. */
function fail(error, field) {
  return field ? { ok: false, error, field } : { ok: false, error };
}

/**
 * Validate ONE question. Returns `{ ok: true }` or `{ ok: false, error, field }`.
 * Split out from the batch validator so a caller can point at a single field.
 */
export function validateQuestion(name, q) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > LIMITS.MAX_NAME_CHARS) {
    return fail(
      `question key "${String(name)}" must be lowercase snake_case ` +
        `(a-z, 0-9, _), start with a letter, and be at most ${LIMITS.MAX_NAME_CHARS} chars`,
      'questions',
    );
  }
  if (!isPlainObject(q)) return fail(`question "${name}" must be an object`, `questions.${name}`);
  if (!QUESTION_TYPES.includes(q.type)) {
    return fail(
      `question "${name}" has type "${String(q.type)}" — must be one of: ${QUESTION_TYPES.join(', ')}`,
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

  if (q.type === 'noul') {
    if (!isPlainObject(q.criteria)) {
      return fail(
        `question "${name}" (noul) criteria must be an object with "true" and "false" keys`,
        `questions.${name}.criteria`,
      );
    }
    const keys = Object.keys(q.criteria);
    const stray = keys.filter((k) => !NOUL_KEYS.includes(k));
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
        criteria: { true: q.criteria.true.trim(), false: q.criteria.false.trim() },
      },
    };
  }

  if (q.type === 'choice') {
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
    const criteria = {};
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
  const steps = [];
  const seen = new Set();
  for (const step of q.criteria) {
    if (typeof step !== 'string' || !step.trim() || step.length > LIMITS.MAX_CRITERIA_LABEL_CHARS) {
      return fail(
        `question "${name}" (score) every rubric step must be a non-empty string of at most ${LIMITS.MAX_CRITERIA_LABEL_CHARS} chars`,
        `questions.${name}.criteria`,
      );
    }
    // A duplicate step makes "position on the rubric" ambiguous, and the answer
    // comes back as a label — two identical labels cannot be told apart.
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

/** Validate the whole `questions` map. Returns the normalised map on success. */
export function validateQuestions(questions) {
  if (!isPlainObject(questions)) {
    return fail('questions must be an object of name → question spec', 'questions');
  }
  const names = Object.keys(questions);
  if (!names.length) return fail('questions must not be empty', 'questions');
  if (names.length > LIMITS.MAX_QUESTIONS) {
    return fail(
      `too many questions: ${names.length} (at most ${LIMITS.MAX_QUESTIONS})`,
      'questions',
    );
  }
  const out = {};
  for (const name of names) {
    const res = validateQuestion(name, questions[name]);
    if (!res.ok) return res;
    out[name] = res.value;
  }
  return { ok: true, value: out };
}

/**
 * `state` is what the model reasons over. The API takes a string, object or
 * array; we serialise non-strings so the size bound is measurable and the
 * payload shape is constant.
 */
export function stateText(state) {
  if (typeof state === 'string') return state;
  if (state === null || state === undefined) return '';
  try {
    return JSON.stringify(state, null, 2);
  } catch {
    return String(state);
  }
}

/** Validate + normalise a whole Decisions request. */
export function buildRequest(body) {
  const state = stateText(body?.state);
  if (!state.trim()) {
    return fail('state is required — the model has nothing to judge', 'state');
  }
  if (state.length > LIMITS.MAX_STATE_CHARS) {
    return fail(
      `state is ${state.length} chars — at most ${LIMITS.MAX_STATE_CHARS}`,
      'state',
    );
  }
  const vq = validateQuestions(body?.questions);
  if (!vq.ok) return vq;
  const out = { state, questions: vq.value };
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  if (model) out.model = model;
  return { ok: true, value: out };
}

// ── The answer side ─────────────────────────────────────────────────────────
// Deliberately FORGIVING where the request side is strict. We did not write the
// responder, and no client should crash on a shape we did not foresee. Anything
// unreadable comes back as `{ ok: false, invalid: true, raw }`, so the caller
// can decide — never silently coerced into a confident wrong answer.
//
// Every answer is `{ type, ok, ... }`. The `type` is echoed from the question,
// and `ok` narrows a discriminated union that is IDENTICAL on both sides of the
// wire (see the JevAnswer type in src/ai/jev/spec.ts) — so the client can send
// these straight to a `switch` with no remapping layer in between.

/**
 * Keep only finite numbers from a probabilities bag, clamped to 0..1.
 *
 * `relabel` swaps numeric keys for their rubric LABEL. This is needed because
 * the live API is inconsistent about it (VERIFIED 200-response): a `choice`
 * answer keys its distribution by label, but a `score` answer keys it by index
 * (`{"0":0,"1":0.95,"2":0.05}`). Callers should never have to know which they
 * got, so both come back label-keyed.
 */
function probabilities(raw, relabel = null) {
  if (!isPlainObject(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) continue;
    const key = relabel && /^\d+$/.test(k) ? relabel[Number(k)] ?? k : k;
    out[key] = Math.min(1, Math.max(0, n));
  }
  return Object.keys(out).length ? out : null;
}

/** Case-insensitive match of an answer against the declared labels. */
function matchLabel(value, labels) {
  if (typeof value !== 'string') return null;
  const want = value.trim().toLowerCase();
  if (!want) return null;
  return labels.find((l) => l.toLowerCase() === want) ?? null;
}

/** The highest-probability label, or null. Ties resolve to declaration order. */
function argmax(probs, labels) {
  if (!probs) return null;
  let best = null;
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

/** Read one answer against the question that produced it. */
function normalizeOne(name, spec, raw) {
  const p = probabilities(raw?.probabilities);

  if (spec.type === 'noul') {
    // Accept the documented field, a bare number, or the obvious aliases — the
    // contract is "a probability from 0 to 1", read that intent, then clamp.
    const candidate = [
      raw?.noul,
      typeof raw === 'number' ? raw : undefined,
      raw?.value,
      raw?.probability,
      raw?.yes,
      raw?.p,
    ].find((v) => v !== undefined && v !== null);
    const n = typeof candidate === 'number' ? candidate : Number(candidate);
    if (!Number.isFinite(n)) {
      return { type: 'noul', ok: false, invalid: true, raw: raw ?? null };
    }
    const value = Math.min(1, Math.max(0, n));
    return {
      type: 'noul',
      ok: true,
      value,
      // 0.5 is the only defensible cut without a caller-supplied threshold, and
      // it is reported ALONGSIDE the raw value so a caller with a better
      // threshold ("escalate above 0.8") can apply it instead.
      yes: value >= 0.5,
      confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
    };
  }

  if (spec.type === 'choice') {
    const labels = Object.keys(spec.criteria);
    const chosen = matchLabel(raw?.choice ?? raw?.label ?? raw?.value, labels) ?? argmax(p, labels);
    if (!chosen) {
      return { type: 'choice', ok: false, invalid: true, raw: raw ?? null };
    }
    return {
      type: 'choice',
      ok: true,
      choice: chosen,
      probabilities: p,
      confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
    };
  }

  // score — VERIFIED shape: `score` is a **0-based, CONTINUOUS** position on the
  // rubric, with a `legend` naming the steps. A 3-step rubric answering 1.05
  // means "just past the 2nd step", i.e. "Frustrated" — NOT 1-based, and not a
  // label. Reading it as 1-based integer would round 1.05 → 1 → index 0 →
  // "Calm", a confidently wrong answer, so the index is clamped not shifted.
  const rubric = spec.criteria;
  const pIndexed = probabilities(raw?.probabilities, rubric);
  const rawScore = raw?.score ?? raw?.label ?? raw?.value;
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
    return { type: 'score', ok: false, invalid: true, raw: raw ?? null };
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
    // 1-based position, because "3 of 5" is how a rubric reads to a person.
    position: index + 1,
    // How many steps there are, so "2 of 3" is renderable without the caller
    // having to carry the question spec around with the answer.
    total: rubric.length,
    // Normalised 0..1 along the rubric, so rubrics of different lengths can be
    // compared and thresholded. Guarded because a 1-step rubric would divide by
    // zero (and is impossible anyway — the validator requires at least 2).
    value: rubric.length > 1 ? clamped / (rubric.length - 1) : 0,
    probabilities: pIndexed,
    confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
  };
}

/**
 * Turn the API's `answers` into typed results keyed by question name.
 * A question with no readable answer is present with `invalid: true` — never
 * missing, so a caller can always `Object.keys` the result.
 */
export function normalizeAnswers(questions, rawAnswers) {
  const src = isPlainObject(rawAnswers) ? rawAnswers : {};
  const out = {};
  for (const [name, spec] of Object.entries(questions ?? {})) {
    out[name] = normalizeOne(name, spec, src[name]);
  }
  return out;
}

/** Two decimals, trailing zeros trimmed — '0.95', '0.5', '0'. */
const r2 = (x) => String(Math.round(x * 100) / 100);

/** A distribution as readable text, most likely first. */
function spread(dist) {
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
export function describeAnswers(answers) {
  const lines = [];
  for (const [name, a] of Object.entries(answers ?? {})) {
    if (!a || a.ok === false) {
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
 * A JSON Schema for the answer shape these questions should produce. Exposed so
 * a caller can document or assert the contract; the responder itself is told the
 * shape by the question spec, not by this.
 */
export function answersJsonSchema(questions) {
  const props = {};
  for (const [name, spec] of Object.entries(questions ?? {})) {
    if (spec.type === 'noul') {
      props[name] = {
        type: 'object',
        properties: {
          type: { const: 'noul' },
          noul: { type: 'number', minimum: 0, maximum: 1 },
          confidence: { type: 'number' },
        },
        required: ['noul'],
        additionalProperties: true,
      };
    } else if (spec.type === 'choice') {
      props[name] = {
        type: 'object',
        properties: {
          type: { const: 'choice' },
          choice: { type: 'string', enum: Object.keys(spec.criteria) },
          probabilities: {
            type: 'object',
            properties: Object.fromEntries(
              Object.keys(spec.criteria).map((l) => [l, { type: 'number' }]),
            ),
          },
          confidence: { type: 'number' },
        },
        required: ['choice'],
        additionalProperties: true,
      };
    } else {
      props[name] = {
        type: 'object',
        properties: {
          type: { const: 'score' },
          score: {
            type: 'number',
            minimum: 0,
            maximum: spec.criteria.length - 1,
            description:
              'Position on the rubric: 0-based and CONTINUOUS, so 1.05 sits just past the 2nd step.',
          },
          legend: { type: 'object' },
          probabilities: { type: 'object' },
          confidence: { type: 'number' },
        },
        required: ['score'],
        additionalProperties: true,
      };
    }
  }
  return { type: 'object', properties: props, required: Object.keys(props) };
}

/**
 * Build a spec from the flat shape a TOOL CALL can express.
 *
 * A tool-calling model writes prose well and JSON poorly, so no tool asks it to
 * author a criteria object: it supplies a question, an optional option list, and
 * we build the strict spec here. This is the whole point of Jev — the model
 * answers, our code owns the shape.
 */
export function specFromToolArgs({ kind, question, options } = {}) {
  const instructions = String(question ?? '').trim();
  if (!QUESTION_TYPES.includes(kind)) {
    return fail(`kind must be one of: ${QUESTION_TYPES.join(', ')}`, 'kind');
  }
  const list = (Array.isArray(options) ? options : String(options ?? '').split(/[|,\n]/))
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
