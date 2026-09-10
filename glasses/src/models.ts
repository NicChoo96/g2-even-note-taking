// Free OpenRouter models that advertise tool calling.
//
// Single source of truth: the Agents panel, the Settings panel and the glasses
// app all read this list, so the two panels can never drift apart again.
//
// NOTE: a model appearing here does NOT mean your account can call it. Free
// models are frequently blocked by OpenRouter privacy / data-policy guardrails
// ("0 endpoints out of 1 requested are available ... ZDR violation"), and some
// are only reachable through agentic harnesses. Run the probe to see what your
// key can actually reach, then keep the winners at the top:
//
//   node glasses/tools/probe-models.mjs     # writes probe-result.txt
//
// Verified reachable on the current account:
//   inclusionai/ling-3.0-flash-sante:free
//   inclusionai/ling-3.0-flash-fin:free
export const FREE_TOOL_MODELS = [
  // ── verified working with the current key ──────────────────────────────────
  'inclusionai/ling-3.0-flash-sante:free',
  'inclusionai/ling-3.0-flash-fin:free',
  // ── advertised as tool-capable; may need guardrail settings changed ────────
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'cohere/north-mini-code:free',
  'liquid/lfm-2.5-2.6b:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'dots-studio/dots-3-note-preview:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
];

// DeepSeek models (OpenAI-compatible, base URL https://api.deepseek.com).
// Selectable when the relay runs with LLM_PROVIDER=deepseek. `deepseek-chat`
// is the classic general alias and `deepseek-reasoner` the reasoning model;
// the current DeepSeek lineup also exposes `deepseek-flash` (V4.1 Flash, tool
// calling + thinking mode) and `deepseek-v4-pro`.
export const DEEPSEEK_MODELS = [
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-flash',
  'deepseek-v4-pro',
];
