// Browser-side client for the jev decision endpoint.
//
// WHAT THIS IS
//   jev does not write prose. It answers strict typed questions about a `state`
//   you paste in — `noul` (a yes/no probability), `choice` (a pick from options
//   you define) and `score` (a position on an ordered rubric) — so the caller can
//   branch on an answer instead of parsing a paragraph.
//
// THE SECURITY INVARIANT (do not weaken)
//   The relay is the ONLY holder of OPENROUTER_API_KEY. This module never sees a
//   provider key and never talks to openrouter.ai; it posts to the relay, which
//   signs the upstream call. The injectable seam is `{baseUrl, token}` pointing at
//   the RELAY — never at a provider. If a future change needs a provider key in
//   the WebView, that is a design regression, not a refactor.
//
//   jev shares the single OPENROUTER_API_KEY — there is no second credential to
//   obtain. What it does not share is the CHAT CONFIG: `LLM_PROVIDER` can point
//   the chat proxy at DeepSeek, so llmConfig() hands back whichever backend is
//   active. jev is always OpenRouter. Routing it through llmConfig() would post
//   jev's request to the wrong host under the wrong vendor's key.
//
// Validation does not require the network: the spec is checked locally with the
// exact same code the relay runs (src/ai/jev/spec.ts — lockstep-tested against
// web/server/jev-spec.mjs), so a malformed spec fails instantly and identically
// on both sides of the wire.
import { buildRequest, type JevAnswers, type JevQuestions, type JevRequest } from '../ai/jev/spec';
import { getStreamToken } from '../auth-token';
import { API_BASE } from '../stream';

/** A successful decision, or a failure with a machine-usable reason. */
export type JevDecideReply =
  | { ok: true; answers: JevAnswers; model?: string; usage?: unknown }
  | { ok: false; error: string; field?: string };

/**
 * Sends a validated request to the relay. Injectable so harnesses (and future
 * callers) can drive the capability without a live server or a key.
 */
export type JevPoster = (request: JevRequest) => Promise<JevDecideReply>;

function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const token = getStreamToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/**
 * Default transport: POST /api/decisions on the relay. Never throws — a thrown
 * reject would escape the agent loop, which expects a value it can report.
 */
async function defaultJevPost(request: JevRequest): Promise<JevDecideReply> {
  try {
    const res = await fetch(`${API_BASE}/api/decisions`, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(request),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<JevDecideReply> & {
      error?: string;
      field?: string;
    };
    if (!res.ok || body?.ok !== true) {
      return { ok: false, error: body?.error || `HTTP ${res.status}`, field: body?.field };
    }
    return body as JevDecideReply;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ask jev typed questions about `state`.
 *
 * @param state     The material to judge — a string, or any JSON value. Paste the
 *                  real thing rather than a summary; jev only sees what you send.
 * @param questions The question set. Build it with `parseQuestions()` when it
 *                  arrives as a JSON string (a tool argument can only be a string).
 */
export async function jevDecide(
  args: { state: string; questions: JevQuestions; model?: string },
  post: JevPoster = defaultJevPost,
): Promise<JevDecideReply> {
  const built = buildRequest(args);
  if (!built.ok) return { ok: false, error: built.error, field: built.field };
  return post(built.value);
}

/**
 * True when the relay holds an OpenRouter key. jev is opt-in: without a key the
 * capability should say it was skipped rather than answer from a guess.
 */
export async function jevAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/agent/status`, { headers: authHeaders() });
    if (!res.ok) return false;
    const j = (await res.json()) as { jev?: boolean };
    return j?.jev === true;
  } catch {
    return false;
  }
}
