// Pseudo tool-call syntax that a model spills into `content` as PLAIN TEXT.
//
// WHY THIS EXISTS
//   DeepSeek writes its native tool-call grammar inline as text when the model
//   decides it wants a tool but the request declared none. The Jarvis loop ends
//   with exactly that shape — a transcript full of `tool_calls`, followed by a
//   final turn that deliberately offers no tools — so the closing sentence the
//   wearer hears could arrive as machine syntax:
//
//     <|DSML|tool_calls> <|DSML|invoke name="agents__list"> ...
//
//   `clean()` below it only collapsed whitespace, so nothing stopped it. The
//   same bug was live on the relay (web/server/tool-markup.mjs) where it filled
//   the whole final answer of every agent that used all of its steps.
//
// NOTES FOR THE NEXT READER
//   * The characters are real, not display artefacts. The bars are U+FF5C
//     (FULLWIDTH VERTICAL LINE), doubled around a literal `DSML`, then a space
//     and the tag name; `\uFF5C` is spelled as an escape so this file stays
//     pure ASCII. Older builds emit `<|tool\u2581calls|>` (ASCII pipes, U+2581
//     between the words) or the plain `<tool_call>` family. All three are
//     handled.
//   * The bar-marked form is matched by "any angle-bracket token containing
//     U+FF5C". That is a safe test: no prose in any language contains
//     `<...\uFF5C...>`, so an over-eager strip costs nothing a wearer would
//     miss, while a miss puts machine syntax on the lens.
//   * `tool_choice: 'none'` does NOT suppress this. Verified against
//     deepseek-flash: it leaked anyway. The cure is to not send a tool-using
//     transcript with no tools (done at the call sites); this scrubber is
//     defence in depth.
//   * Keep this in sync with web/server/tool-markup.mjs. They cannot share code
//     — that one is a zero-build Node ESM file, this one is bundled into the
//     WebView — so tools/tool-markup-sim.mjs feeds the SAME fixtures to both and
//     fails if they ever disagree.

/**
 * One control token. Two shapes:
 *   bar-marked  <\uFF5C\uFF5CDSML\uFF5C\uFF5C tool_calls>   (the observed leak)
 *   ascii-pipe  <|tool\u2581calls\u2581begin|> / <|parameter name="q"|>
 * Built as a string so the escapes stay readable and this file stays ASCII.
 */
const CONTROL_TOKEN_SRC = [
  '<[^<>\\n]*\\uFF5C[^<>\\n]*>',
  '<\\|[^<>\\n]*\\|>',
].join('|');

/** Non-global on purpose: a `g` flag makes `lastIndex` stateful and `.test()` lie. */
const ANY_CONTROL_TOKEN = new RegExp(CONTROL_TOKEN_SRC);
const ALL_CONTROL_TOKENS = new RegExp(CONTROL_TOKEN_SRC, 'g');

/** The ASCII pseudo-call family, tag form. */
const ASCII_TAG = /<tool_calls?|<\/?invoke\b[^<>\n]*>|<\/?parameter\b[^<>\n]*>/i;
const ASCII_TAG_ALL =
  /<tool_calls?>[\s\S]*?<\/tool_calls?>|<\/?tool_calls?>|<\/?invoke\b[^<>\n]*>|<\/?parameter\b[^<>\n]*>/gi;

/**
 * A tool call body whose tags were lost on the way. Anchored to the end of the
 * string: the arguments object cannot be matched atomically without a parser,
 * and anything trailing it would be prose we cannot re-join anyway.
 */
const BARE_CALL = /\{\s*"name"\s*:\s*"[^"]{1,64}"\s*,\s*"arguments"\s*:[\s\S]*$/;

/**
 * Would this text show machine syntax to a wearer?
 * Used to refuse a markup-only answer instead of speaking it.
 */
export function looksLikeToolMarkup(text: string): boolean {
  const s = String(text ?? '');
  return ANY_CONTROL_TOKEN.test(s) || ASCII_TAG.test(s) || BARE_CALL.test(s);
}

/**
 * Strip pseudo tool-call markup, keeping whatever real prose surrounded it.
 *
 * The control block runs from the FIRST such token to the LAST one, so the
 * parameter bodies in between go with it. Prose written before the call survives
 * — often that sentence is the only honest thing in the reply. A block whose
 * closing token never arrived (streamed, truncated, or garbled — a closer with no
 * slash, e.g. `<|DSML| calls>`, is a real observed variant) is removed to the end.
 */
export function stripToolMarkup(text: string): string {
  let s = String(text ?? '');
  if (!looksLikeToolMarkup(s)) return collapse(s);

  // 1. ASCII blocks first, body included: <tool_call>{...}</tool_call>
  s = s.replace(ASCII_TAG_ALL, ' ');

  // 2. One whole bar/pipe control block, body included: first token -> last.
  const first = s.search(ANY_CONTROL_TOKEN);
  if (first >= 0) {
    let end = -1;
    ALL_CONTROL_TOKENS.lastIndex = first;
    for (let m = ALL_CONTROL_TOKENS.exec(s); m; m = ALL_CONTROL_TOKENS.exec(s)) {
      end = m.index + m[0].length;
    }
    s = `${s.slice(0, first)} ${end < 0 ? '' : s.slice(end)}`;
  }

  // 3. A call body left behind by either branch above.
  s = s.replace(BARE_CALL, ' ');
  return collapse(s);
}

/** Collapse the whitespace the removals leave behind. */
function collapse(s: string): string {
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[ \t]*\n[ \t\n]*/g, '\n')
    .trim();
}
