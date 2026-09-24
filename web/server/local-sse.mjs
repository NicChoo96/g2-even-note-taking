// Persistent G2 Even Reality Hub relay — ONE always-on process that serves the
// UNIFIED app and the live SSE/state stream. This is the "live always, all
// devices at the same time" backend for Railway/Fly/Render.
//
//   GET  /api/stream?channel=hub  -> SSE stream (the app + glasses connect here)
//   GET  /api/stream?channels=a,b -> the SAME stream, several channels on ONE
//                                     socket (frames tagged with `channel`).
//                                     Preferred: a browser only allows ~6 live
//                                     HTTP/1.1 sockets per origin and an SSE
//                                     response holds its socket forever, so one
//                                     EventSource per channel starves every
//                                     other request — including POST /api/llm.
//   POST /api/stream              -> publish HubState + broadcast to SSE clients
//   GET  /                        -> serves the unified app (glasses-dist): the
//                                     companion web UI in any browser, AND the
//                                     SDK that draws to the G2 in the Even App
//   GET  /app.json                -> app manifest (Even App recognition)
//   GET  /api/config              -> { googleClientId } for the login button
//   POST /api/auth/verify         -> Google ID token -> owner session token
//   POST /api/auth/logout         -> revoke an owner session
//   GET  /api/auth/me             -> is this owner session still valid?
//   POST /api/pair/request        -> device self-registers (returns pair code)
//   GET  /api/pair/status         -> device polls until the owner approves
//   POST /api/pair/approve        -> owner (session) approves a pair code
//   GET  /api/devices             -> owner lists approved devices
//   POST /api/pair/revoke         -> owner revokes a device
//   GET  /api/stt/status          -> is a speech provider configured?
//   POST /api/stt                 -> raw audio bytes -> transcribed text
//                                     (auth required; key stays server-side)
//   GET  /api/agent/status        -> are the LLM + web-search keys configured?
//   POST /api/settings            -> owner sets model / keys (never echoed back)
//   POST /api/llm                 -> OpenRouter/DeepSeek chat-completions proxy (tools ok)
//   POST /api/tool                -> web search (Tavily or Brave) / generic REST proxy
//   GET  /api/files/status        -> is the Jarvis document store configured?
//   GET  /api/files               -> list stored HTML documents (relay-proxied)
//   POST /api/files               -> publish an HTML document
//   GET  /api/files/:id           -> one document's metadata
//   GET  /api/files/:id/html      -> the document BODY (bearer only; see below)
//   DELETE /api/files/:id         -> soft-delete a document
//
// THE DOCUMENT STORE (jarvis-files.mjs) holds its own credential and its own
// session. The BROWSER NEVER TALKS TO IT: the gateway's CORS list is empty, so
// a direct call from the SPA cannot even preflight. Every call therefore comes
// through the /api/files routes above, which is also the only reason the
// credential can stay in this process.
//
// A stored document's body is served with `sandbox allow-scripts` and NO
// `allow-same-origin`, so it runs with an opaque origin: it cannot read this
// app's DOM, its storage or its session, and it cannot call this API. The SPA
// renders it by FETCHING the body (bearer-authenticated) and handing it to a
// sandboxed iframe as `srcdoc` — never by pointing an iframe at a URL, which
// the gateway's own `X-Frame-Options: SAMEORIGIN` would refuse anyway.
//
// SECURITY: /api/stream (GET + POST) requires a valid owner session token OR an
// approved per-device ID. Browsers authenticate via Google SSO; each glasses
// device gets its own unguessable deviceId that the owner approves from a
// logged-in browser. There is NO anonymous read of the stream and NO shared
// device login. /api/stt, /api/llm and /api/tool are protected the same way so
// randos can't spend your provider keys — and those keys live ONLY in this
// process (env or .g2-hub-secrets.json), never in the client bundle.
//
// Env: PORT, STATE_FILE, AUTH_FILE, GOOGLE_CLIENT_ID, ALLOWED_EMAILS
// (comma-separated), OPENAI_API_KEY (Whisper) or DEEPGRAM_API_KEY (Nova-2) for
// voice dictation. Agents LLM: OPENROUTER_API_KEY (+ optional OPENROUTER_MODEL,
// OPENROUTER_REFERER, OPENROUTER_TITLE), or switch the whole LLM backend to
// DeepSeek with LLM_PROVIDER=deepseek + DEEPSEEK_API_KEY (+ optional
// DEEPSEEK_MODEL). Agents web search: TAVILY_API_KEY or BRAVE_SEARCH_API_KEY,
// with SEARCH_PROVIDER=tavily|brave to choose (default: whichever key is set,
// Tavily winning when both are), plus an optional WEB_SEARCH_DEPTH (basic or
// advanced; the legacy TAVILY_SEARCH_DEPTH still works). Agents document store:
// JARVIS_FILE_USER + JARVIS_FILE_PWD (password login, the default path) or
// JARVIS_FILE_API_KEY (a pre-minted `jvk_…` key, which needs no session at all),
// with JARVIS_FILE_URL to point at a gateway other than the default.
// Zero runtime dependencies (node built-ins only). Run:
//   node server/local-sse.mjs          (default port 5174)
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicKey, createVerify, randomBytes, createHash } from 'node:crypto';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// The clock the model never had. Stamps every system prompt with the exact
// date/time a run started and resolves relative phrases in the user prompt
// BEFORE the first tool call (see datetime.mjs).
import { preprocessText, withDateTimeMessages } from './datetime.mjs';
// The run's chat messages, in a module that can be imported without booting the
// server (see wire.mjs — it carries the byte-identity contract for a run that
// has neither a saved task nor a wearer directive).
import { assembleWire } from './wire.mjs';
import { looksLikeToolMarkup, stripToolMarkup } from './tool-markup.mjs';
// Web search — one interface over Tavily and Brave, chosen by SEARCH_PROVIDER
// (see web-search.mjs). Kept out of this file so both providers can be driven
// against a stubbed fetch; importing THIS module starts a server.
import { isWebTool, resolveDepth, searchWeb } from './web-search.mjs';
// Jarvis Content Gateway — the external store for HTML documents an agent or
// Jarvis publishes (see jarvis-files.mjs). Kept out of this file so the whole
// client — login, the single-flight token rotation, the MCP call shape and the
// error envelope — can be driven against a stubbed fetch and asserted. Its
// header records the two things its own docs get wrong.
import {
  createFilesClient,
  extractMedia,
  filesConfig,
  filesToolSchema,
  htmlResponseHeaders,
  isFilesTool,
  renderToolResult as renderFilesResult,
} from './jarvis-files.mjs';
// Jev — the typed-decision model. Builds/validates the question spec and reads
// the answers back. Ships twice (relay + WebView); see the header of jev-spec.mjs.
import {
  buildRequest,
  describeAnswers,
  describeRanking,
  normalizeAnswers,
  rankAnswers,
  specFromToolArgs,
} from './jev-spec.mjs';

// ── Local env file loader (zero dependencies) ────────────────────────────────
// Lets ONE gitignored file hold every key for local development, so nothing has
// to be exported by hand before `npm start`:
//
//   web/.env.local   ← your real keys (gitignored, NEVER committed)
//   web/.env         ← optional shared defaults (also gitignored)
//
// Precedence (highest first): real process env > .env.local > .env.
// That way a host (Railway/Render/Docker) that injects env vars always wins,
// and CI never needs the file at all. Values may be quoted; `export ` prefixes
// and `#` comments are tolerated. Nothing is ever logged.
function loadEnvFiles() {
  const dirs = [process.cwd(), fileURLToPath(new URL('..', import.meta.url))];
  // .env.local is read FIRST so it wins over the shared .env (Vite convention).
  for (const name of ['.env.local', '.env']) {
    for (const dir of dirs) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      let raw;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue; // comment / blank / malformed
        const key = m[1];
        if (process.env[key] !== undefined) continue; // real env always wins
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
          (value.startsWith("'") && value.endsWith("'") && value.length > 1)
        ) {
          value = value.slice(1, -1);
        } else {
          value = value.replace(/\s+#.*$/, '').trim(); // trailing comment
        }
        process.env[key] = value;
      }
      console.log(`[g2-hub] env ← ${name}`);
      break; // first directory that has the file wins
    }
  }
}
loadEnvFiles();

// ── Google ID token verification (RS256, zero dependencies) ──────────────────
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let jwksCache = { keys: [], fetchedAt: 0 };

function b64url(buf) {
  const pad = buf.length % 4 === 0 ? '' : '='.repeat(4 - (buf.length % 4));
  return Buffer.from(buf.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

async function googleJwks() {
  if (Date.now() - jwksCache.fetchedAt < 3600e3 && jwksCache.keys.length) return jwksCache.keys;
  try {
    const res = await fetch(GOOGLE_JWKS_URL);
    const data = await res.json();
    jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
  } catch {
    /* keep stale keys */
  }
  return jwksCache.keys;
}

/** Verify a Google ID token. Returns the JWT payload or null. */
async function verifyGoogleIdToken(idToken, clientId) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header, payload;
  try {
    header = JSON.parse(b64url(h).toString('utf8'));
    payload = JSON.parse(b64url(p).toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== clientId) return null;
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.iat === 'number' && payload.iat > now + 300) return null;
  const keys = await googleJwks();
  const key = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!key) return null;
  try {
    const publicKey = createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    if (!verifier.verify(publicKey, b64url(sig))) return null;
  } catch {
    return null;
  }
  return payload;
}

const PORT = Number(process.env.PORT || 5174);
// Built unified app (companion web UI + glasses) — served at the bare root.
const GLASSES_DIST = fileURLToPath(new URL('../glasses-dist', import.meta.url));
// Last-known state is mirrored to disk so a Railway/Fly/Render restart does not
// wipe the data. Override the path with STATE_FILE for a persistent volume.
const STATE_FILE = process.env.STATE_FILE || join(process.cwd(), '.g2-hub-state.json');
// Auth store (owner sessions + approved devices) — also persisted to disk.
const AUTH_FILE = process.env.AUTH_FILE || join(process.cwd(), '.g2-hub-auth.json');

// ── Auth store: owner sessions + approved devices ────────────────────────────
// sessions: { [token]: { email, createdAt } }
// devices:  { [deviceId]: { deviceId, status, pairCode, email, createdAt, approvedAt } }
const SESSION_TTL_MS = 30 * 24 * 3600e3; // 30 days
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
let authStore = { sessions: {}, devices: {} };

function loadAuthStore() {
  try {
    authStore = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) || authStore;
  } catch {
    /* fresh start */
  }
}

function persistAuthStore() {
  try {
    writeFileSync(AUTH_FILE, JSON.stringify(authStore, null, 2));
  } catch {
    /* read-only host — in-memory auth still works for this process */
  }
}

function randomToken() {
  return randomBytes(24).toString('hex');
}

function randomPairCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += PAIR_ALPHABET[Math.floor(Math.random() * PAIR_ALPHABET.length)];
  return s;
}

function sessionByToken(token) {
  const s = authStore.sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    delete authStore.sessions[token];
    persistAuthStore();
    return null;
  }
  return s;
}

function deviceById(deviceId) {
  return authStore.devices[deviceId] || null;
}

function approvedDeviceByToken(deviceId) {
  const d = deviceById(deviceId);
  return d && d.status === 'approved' ? d : null;
}

/** Map a bearer token (owner session OR approved deviceId) to a principal. */
function principalFromToken(token) {
  if (!token) return null;
  const s = sessionByToken(token);
  if (s) return { kind: 'owner', email: s.email };
  const d = approvedDeviceByToken(token);
  if (d) return { kind: 'device', deviceId: token };
  return null;
}

function readToken(req, url) {
  const q = url.searchParams.get('token');
  if (q) return q;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

function requireOwner(req, url) {
  const p = principalFromToken(readToken(req, url));
  return p && p.kind === 'owner' ? p : null;
}

// Agent runs may be started from EITHER UI: a signed-in owner browser, or an
// owner-APPROVED device (the glasses). The device is already trusted by the
// owner, and the provider keys never leave this process, so a device token is
// enough to run an agent. Settings/key mutation still requires a real owner.
function requirePrincipal(req, url) {
  return principalFromToken(readToken(req, url));
}

// ── Speech-to-text proxy ─────────────────────────────────────────────────────
// The glasses/browser mic audio is POSTed here as raw bytes; this process holds
// the provider API key (never shipped in the client bundle) and returns the
// transcript. OpenAI Whisper (default) or Deepgram Nova-2.
const STT_MAX_BYTES = 25 * 1024 * 1024;

function sttProvider() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.DEEPGRAM_API_KEY) return 'deepgram';
  return null;
}

/** Re-wrap raw audio bytes as a multipart body for OpenAI Whisper. */
function openaiMultipart(audio, contentType) {
  const boundary = '----g2hub' + randomBytes(16).toString('hex');
  const ext = contentType.includes('webm')
    ? 'webm'
    : contentType.includes('mp4')
      ? 'mp4'
      : contentType.includes('mpeg') || contentType.includes('mp3')
        ? 'mp3'
        : 'wav';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
      `--${boundary}--\r\n`,
  );
  return { body: Buffer.concat([head, audio, tail]), boundary };
}

loadAuthStore();

// ── Agents: LLM + tool proxy ─────────────────────────────────────────────────
// The LLM (OpenRouter or DeepSeek) and web-search keys live ONLY here (env vars,
// or a gitignored .g2-hub-secrets.json written by POST /api/settings from the
// owner's browser). They are never sent to a client, never logged, and never
// included in any response body — clients only ever learn the boolean `hasKey`.
//
// LLM_PROVIDER selects the backend: 'openrouter' (default) or 'deepseek'.
// DeepSeek is OpenAI-compatible: POST https://api.deepseek.com/chat/completions
// with `Authorization: Bearer <key>` (no attribution headers required).
const SECRETS_FILE = process.env.SECRETS_FILE || join(process.cwd(), '.g2-hub-secrets.json');
const DEFAULT_MODEL = 'inclusionai/ling-3.0-flash-sante:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';
const LLM_MAX_BYTES = 512 * 1024;
const TOOL_MAX_BYTES = 32 * 1024;

// ── Jev (typed decisions) ────────────────────────────────────────────────────
// Jev is NOT the chat model. It is a separate endpoint that answers narrow,
// typed questions and returns calibrated probabilities, so it has its OWN
// config on purpose: `LLM_PROVIDER` may point the chat proxy at DeepSeek while
// jev still needs the OpenRouter key. Reading llmConfig() here would have sent
// jev's requests to DeepSeek's URL with a DeepSeek key and failed obscurely.
const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Pinned, not user-facing: `~typesafe/jev-latest` is the typed-decision model. */
const JEV_DEFAULT_MODEL = '~typesafe/jev-latest';
const JEV_MAX_BYTES = 64 * 1024;

/** Persisted overrides (model/referer/title/depth + keys) — see loadSecrets(). */
const secrets = {
  openrouterKey: '',
  deepseekKey: '',
  tavilyKey: '',
  braveKey: '',
  model: '',
  referer: '',
  title: '',
  depth: '',
  /** '' = auto (whichever key is present). Only 'tavily' | 'brave' are honoured. */
  searchProvider: '',
  /** Jarvis document store: URL, password login, or a pre-minted API key. */
  filesUrl: '',
  filesUser: '',
  filesPwd: '',
  filesKey: '',
};

/** Per-tool bearer tokens for generic REST tools: { [toolId]: token }. */
const toolTokens = new Map();

function loadSecrets() {
  try {
    const raw = readFileSync(SECRETS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const k of Object.keys(secrets)) {
      if (typeof data?.[k] === 'string' && data[k]) secrets[k] = data[k];
    }
    if (data?.toolTokens && typeof data.toolTokens === 'object') {
      for (const [id, token] of Object.entries(data.toolTokens)) {
        if (typeof token === 'string') toolTokens.set(id, token);
      }
    }
    console.log(`[g2-hub] loaded agent secrets from ${SECRETS_FILE}`);
  } catch {
    /* none yet — env vars or the settings page can provide them */
  }
}

function persistSecrets() {
  try {
    writeFileSync(
      SECRETS_FILE,
      JSON.stringify({ ...secrets, toolTokens: Object.fromEntries(toolTokens) }, null, 2),
      { mode: 0o600 },
    );
  } catch (err) {
    console.warn('[g2-hub] could not persist secrets:', err?.message || err);
  }
}

/**
 * Effective config — a SAVED setting wins over the environment, ONE FIELD AT A
 * TIME, so the Settings page owns every value it shows.
 *
 * WHY THIS WAY ROUND: it used to be environment-first, and that made the page
 * decorative. You could type a model, watch it save, and the relay would go on
 * using the environment's value — the page and the process held two different
 * answers to the same question and nothing said so. The environment is now the
 * FALLBACK, so a host (Railway, Docker, systemd…) can still supply keys with no
 * page visit, while a field the page HAS set is the one that runs. `clear` in a
 * save removes a stored value, which is how a field returns to its fallback;
 * without it a value set once could never be un-set.
 *
 * Precedence is decided per field, so no field's value depends on any other's.
 * `LLM_PROVIDER` picks the backend: 'openrouter' (default) or 'deepseek'.
 * `source` records WHICH layer is serving each field, so the UI can label it
 * honestly. Values themselves are still never echoed to a client.
 */
function llmConfig() {
  const provider = String(process.env.LLM_PROVIDER || 'openrouter').toLowerCase() === 'deepseek'
    ? 'deepseek'
    : 'openrouter';
  const providerFromEnv = Boolean(process.env.LLM_PROVIDER);
  const isDeepseek = provider === 'deepseek';

  const envKey = isDeepseek
    ? process.env.DEEPSEEK_API_KEY || ''
    : process.env.OPENROUTER_API_KEY || '';
  const fileKey = isDeepseek ? secrets.deepseekKey : secrets.openrouterKey;
  const envModel = isDeepseek
    ? process.env.DEEPSEEK_MODEL || ''
    : process.env.OPENROUTER_MODEL || '';
  const fileModel = secrets.model || '';
  const envReferer = process.env.OPENROUTER_REFERER || '';
  const envTitle = process.env.OPENROUTER_TITLE || '';
  const defaultModel = isDeepseek ? DEEPSEEK_DEFAULT_MODEL : DEFAULT_MODEL;
  const openrouterEnvKey = process.env.OPENROUTER_API_KEY || '';
  const deepseekEnvKey = process.env.DEEPSEEK_API_KEY || '';

  return {
    provider,
    url: isDeepseek ? DEEPSEEK_URL : OPENROUTER_URL,
    key: fileKey || envKey || '',
    model: fileModel || envModel || defaultModel,
    referer: secrets.referer || envReferer || '',
    title: secrets.title || envTitle || 'G2 Even Reality Hub',
    source: {
      provider: providerFromEnv ? 'env' : 'default',
      key: fileKey ? 'settings' : envKey ? 'env' : 'none',
      model: fileModel ? 'settings' : envModel ? 'env' : 'default',
      referer: secrets.referer ? 'settings' : envReferer ? 'env' : 'none',
      title: secrets.title ? 'settings' : envTitle ? 'env' : 'default',
      openrouterKey: secrets.openrouterKey ? 'settings' : openrouterEnvKey ? 'env' : 'none',
      deepseekKey: secrets.deepseekKey ? 'settings' : deepseekEnvKey ? 'env' : 'none',
    },
  };
}

/**
 * Jev config — the OpenRouter key, independent of `LLM_PROVIDER`.
 * Decided per field exactly like llmConfig(): a saved setting wins, the
 * environment is the fallback.
 */
function jevConfig() {
  const envKey = process.env.OPENROUTER_API_KEY || '';
  const fileKey = secrets.openrouterKey || '';
  return {
    key: fileKey || envKey || '',
    model: process.env.JEV_MODEL || JEV_DEFAULT_MODEL,
    referer: secrets.referer || process.env.OPENROUTER_REFERER || '',
    title: secrets.title || process.env.OPENROUTER_TITLE || 'G2 Even Reality Hub',
    source: fileKey ? 'settings' : envKey ? 'env' : 'none',
  };
}

/** OpenRouter attribution headers, always required for jev's model routing. */
function jevHeaders(cfg) {
  const h = {
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
  };
  if (cfg.referer) h['HTTP-Referer'] = cfg.referer;
  if (cfg.title) h['X-OpenRouter-Title'] = cfg.title;
  return h;
}

/** Find the answers map in a response whose envelope we do not control. */
function pickAnswers(payload, questions) {
  if (payload?.answers && typeof payload.answers === 'object') return payload.answers;
  const nested = payload?.data?.answers;
  if (nested && typeof nested === 'object') return nested;
  // Some shapes return the name → answer map at the top level.
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const names = Object.keys(questions ?? {});
    if (names.length && names.every((n) => n in payload)) return payload;
  }
  return {};
}

/**
 * One Decisions call. `request` must already be validated by buildRequest().
 * Throws on transport/HTTP failure; the CALLER decides how to report it.
 */
async function jevDecide(request) {
  const cfg = jevConfig();
  if (!cfg.key) throw new Error('Jev not configured — set OPENROUTER_API_KEY');
  const r = await fetch(JEV_URL, {
    method: 'POST',
    headers: jevHeaders(cfg),
    body: JSON.stringify({
      model: request.model || cfg.model,
      state: request.state,
      questions: request.questions,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j?.error?.message || j?.error || `jev ${r.status}`);
  }
  return {
    answers: normalizeAnswers(request.questions, pickAnswers(j, request.questions)),
    model: j?.model || request.model || cfg.model,
    usage: j?.usage ?? null,
  };
}

/**
 * Web-search config — WHICH provider is live, plus the key and depth for it.
 *
 * The search backend became a setting rather than a hardcoded vendor, so this is
 * the one place that decides. Precedence mirrors llmConfig():
 *
 *   1. `searchProvider` in .g2-hub-secrets.json  (the Settings toggle)
 *   2. SEARCH_PROVIDER in the environment  (a host's default)
 *   3. AUTO — Tavily if a Tavily key exists, else Brave if a Brave key exists.
 *      Tavily wins when both are present, so an install with no explicit choice
 *      does not switch provider behind the wearer's back the moment a Brave key
 *      is added.
 *
 * A selected provider with NO key resolves to an empty key on purpose. Falling
 * back to the other provider's key would answer the question that was asked with
 * a result from a vendor the caller did not select — a silently fabricated
 * provenance — so the callers fail loudly and name the missing variable instead.
 */
function webSearchConfig() {
  const envProvider = String(process.env.SEARCH_PROVIDER || '').toLowerCase();
  const fileProvider = String(secrets.searchProvider || '').toLowerCase();
  const picked = (v) => (v === 'tavily' || v === 'brave' ? v : '');
  const chosen = picked(fileProvider) || picked(envProvider);

  const tavilyEnv = process.env.TAVILY_API_KEY || '';
  const tavilyFile = secrets.tavilyKey || '';
  const braveEnv = process.env.BRAVE_SEARCH_API_KEY || '';
  const braveFile = secrets.braveKey || '';
  const tavilyKey = tavilyFile || tavilyEnv || '';
  const braveKey = braveFile || braveEnv || '';

  const provider = chosen || (tavilyKey ? 'tavily' : braveKey ? 'brave' : 'tavily');
  const isBrave = provider === 'brave';
  const envKey = isBrave ? braveEnv : tavilyEnv;
  const fileKey = isBrave ? braveFile : tavilyFile;
  // WEB_SEARCH_DEPTH is the provider-agnostic name; TAVILY_SEARCH_DEPTH is kept
  // working so an existing deployment does not lose its setting on upgrade.
  const envDepth = process.env.WEB_SEARCH_DEPTH || process.env.TAVILY_SEARCH_DEPTH || '';

  return {
    provider,
    /**
     * The SAVED setting — '' means auto. Distinct from `provider`, which is the
     * resolved answer; the page needs the setting to render Auto correctly
     * without pinning it.
     */
    setting: picked(fileProvider),
    key: fileKey || envKey || '',
    depth: secrets.depth || envDepth || 'basic', // default: basic
    /** Which providers have a key at all — the UI needs both, not just the live one. */
    keys: { tavily: Boolean(tavilyKey), brave: Boolean(braveKey) },
    /** `${provider} ${envVarName}` for an error a human can act on. */
    envVar: isBrave ? 'BRAVE_SEARCH_API_KEY' : 'TAVILY_API_KEY',
    label: isBrave ? 'Brave Search' : 'Tavily',
    source: {
      provider:
        picked(fileProvider) === provider
          ? 'settings'
          : picked(envProvider) === provider
            ? 'env'
            : 'default',
      key: fileKey ? 'settings' : envKey ? 'env' : 'none',
      depth: secrets.depth ? 'settings' : envDepth ? 'env' : 'default',
      tavilyKey: tavilyFile ? 'settings' : tavilyEnv ? 'env' : 'none',
      braveKey: braveFile ? 'settings' : braveEnv ? 'env' : 'none',
    },
  };
}

// ── Jarvis document store (agent-authored HTML) ──────────────────────────────
// ONE client for the process, created lazily and REPLACED only when the
// effective config changes. This is not an optimisation. The client owns a
// rotating refresh token, and rotating twice from two live clients would replay
// a consumed token — which the gateway answers by revoking the whole session
// family — so there must never be two of them for one set of credentials.
let filesClientRef = null;
let filesClientKey = '';

/** How many documents a TOOL result lists. The page asks for more than this. */
const FILES_TOOL_LIST_LIMIT = 20;
/**
 * The request cap for a publish, set just above the gateway's own 4 MiB
 * `max_html_bytes`. Being OVER that limit must be reported as a validation
 * failure the caller can act on, so the envelope has to reach the gateway —
 * rejecting it here with a generic "body too large" would hide which limit bit.
 */
const FILES_MAX_BODY_BYTES = 4 * 1024 * 1024 + 64 * 1024;
/** The author recorded when neither the model nor the tool names one. */
const DEFAULT_FILES_AGENT = 'g2-hub';

function filesRuntime() {
  const cfg = filesConfig(process.env, secrets);
  if (!cfg.url) return { cfg, client: null, error: 'JARVIS_FILE_URL is not a valid http(s) URL' };
  if (!cfg.configured) return { cfg, client: null, error: `${cfg.hintVar} is not set` };
  const key = [cfg.url, cfg.apiKey, cfg.username, cfg.password].join('\u0000');
  if (!filesClientRef || filesClientKey !== key) {
    filesClientRef = createFilesClient({
      baseUrl: cfg.url,
      apiKey: cfg.apiKey,
      username: cfg.username,
      password: cfg.password,
    });
    filesClientKey = key;
  }
  return { cfg, client: filesClientRef, error: '' };
}

/**
 * The document store as a TOOL, for the server-side agent loop.
 *
 * Never throws: a gateway that is down, unconfigured or out of scope must
 * report as a `tool error:` line the model can read and route around, exactly
 * like the web-search and jev branches. A tool failure that took the run down
 * would throw away the rest of the agent's work.
 */
async function runFilesTool(tool, args, signal) {
  const { client, error } = filesRuntime();
  if (!client) return `tool error: document store not configured — ${error}`;
  const action = String(args?.action ?? '').toLowerCase();
  try {
    if (action === 'list') {
      return renderFilesResult(
        'list_sessions',
        await client.list({
          q: args?.q,
          agent: args?.agent,
          limit: FILES_TOOL_LIST_LIMIT,
          signal,
        }),
      );
    }
    if (action === 'publish') {
      const doc = await client.create({
        html: args?.html ?? args?.document ?? args?.body,
        title: args?.title,
        agent: args?.agent || DEFAULT_FILES_AGENT,
        tags: args?.tags,
        id: args?.id,
        overwrite: args?.overwrite,
        signal,
      });
      return renderFilesResult('create_session', doc);
    }
    if (action === 'read') {
      const id = String(args?.id ?? '').trim();
      if (!id) return 'tool error: id is required to read a document';
      return renderFilesResult('read_session', await client.read(id, { signal }));
    }
    if (action === 'delete' || action === 'remove') {
      const id = String(args?.id ?? '').trim();
      if (!id) return 'tool error: id is required to delete a document';
      return renderFilesResult('delete_session', await client.remove(id, { signal }));
    }
    return 'tool error: action must be one of publish, list, read, delete';
  } catch (err) {
    const code = err?.code ? `${err.code}: ` : '';
    return `tool error: ${code}${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * The only capability shape any client ever sees: booleans + provenance, never
 * a key value. Shared by /api/agent/status and /api/settings so the two can
 * never disagree about what is configured.
 */
function agentStatusPayload() {
  const llm = llmConfig();
  const ws = webSearchConfig();
  const jev = jevConfig();
  const files = filesRuntime();
  return {
    ok: true,
    provider: llm.provider,
    llm: Boolean(llm.key),
    // Jev is gated on the OPENROUTER key, NOT the chat provider — an app running
    // on DeepSeek chat can still have jev available. Clients use this to hide or
    // disable jev affordances rather than offering a tool that will fail.
    jev: Boolean(jev.key),
    /**
     * The document store. `configured` means a CREDENTIAL is present, not that
     * the gateway answered — probing on every status poll would make the
     * Settings page slow and would turn a momentary blip into a false "not set
     * up". `url` and `hint` are not secrets: the URL is already in a public
     * spec, and the hint names an env var, never a value.
     */
    files: {
      configured: Boolean(files.client),
      mode: files.cfg.apiKey ? 'api_key' : 'password',
      url: files.cfg.url,
      hint: files.error,
    },
    /** The web-search setting: which provider is live, and both key states. */
    search: {
      provider: ws.provider,
      configured: Boolean(ws.key),
      depth: ws.depth,
      keys: ws.keys,
    },
    // DEPRECATED alias, kept for one release: an older client bundle still reads
    // `tavily` and `source.tavily`, and dropping them would make it render a
    // false "key missing" warning on a correctly configured relay. It reports
    // whether the ACTIVE search provider is configured, whatever that is.
    tavily: Boolean(ws.key),
    model: llm.model,
    depth: ws.depth,
    /**
     * Every NON-SECRET setting at its current value, so the page can seed each
     * field with the truth instead of guessing a default and writing it back.
     * Keys are deliberately absent — they stay boolean-only above.
     */
    fields: {
      model: llm.model,
      depth: ws.depth,
      searchProvider: ws.setting,
      referer: llm.referer,
      title: llm.title,
    },
    source: {
      llm: llm.source,
      search: ws.source,
      jev: jev.source,
      tavily: { key: ws.source.key, depth: ws.source.depth },
    },
  };
}

/** Request headers for whichever LLM provider is active. */
function llmHeaders(cfg) {
  const h = {
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
  };
  // OpenRouter free-tier routing needs attribution headers; DeepSeek does not.
  if (cfg.provider === 'openrouter') {
    if (cfg.referer) h['HTTP-Referer'] = cfg.referer;
    if (cfg.title) h['X-OpenRouter-Title'] = cfg.title;
  }
  return h;
}

// ── Server-side agent run engine ─────────────────────────────────────────────
// The agent loop runs HERE, not in the WebView, for three reasons:
//   1. it survives the glasses page being backgrounded (a run is not tied to a
//      UI lifecycle),
//   2. the glasses and the browser watch the SAME transcript live,
//   3. the model/tool keys never leave this process — the client only ever sends
//      the prompt and tool metadata.
// Runs are transient: they are broadcast on the 'agents' channel as
// `{ type: 'run', run }` frames and kept in a small ring for replay. The final
// transcript is persisted by the CLIENTS as a normal session (capped at 5).
const MAX_STEPS = 5;
const MAX_RUNS = 8;
const RUN_TTL_MS = 30 * 60e3; // drop finished runs after 30 min
const RUN_MAX_BYTES = 256 * 1024;
const runs = new Map(); // runId -> run
const runAbort = new Map(); // runId -> AbortController

function pruneRuns() {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (run.status !== 'running' && now - run.updatedAt > RUN_TTL_MS) runs.delete(id);
  }
  while (runs.size > MAX_RUNS) {
    // Never evict an in-flight run.
    const victim = [...runs.values()]
      .filter((r) => r.status !== 'running')
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!victim) break;
    runs.delete(victim.id);
  }
}

function runSnapshot() {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Broadcast a run frame to every agents-channel subscriber (both clients). */
function broadcastRun(run) {
  run.updatedAt = Date.now();
  const frame = { type: 'run', run };
  for (const client of [...getChannel('agents').clients]) send(client, frame, 'agents');
}

/** OpenAI-style tool schema — mirrors the tool shapes in glasses/src/types.ts. */
function toolSchemaFor(t) {
  if (isWebTool(t)) {
    return {
      type: 'function',
      function: {
        name: t.name || 'web_search',
        description: t.description || 'Search the web for current information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            depth: {
              type: 'string',
              enum: ['basic', 'advanced'],
              description:
                'How much to read: basic (fast, a few sources) or advanced (slower, more sources).',
            },
            freshness: {
              type: 'string',
              description:
                'Optional recency filter: pd (past day), pw (past week), pm (past month), py (past year), or a YYYY-MM-DDtoYYYY-MM-DD range.',
            },
          },
          required: ['query'],
        },
      },
    };
  }
  // The Jarvis document store. Its schema is built in jarvis-files.mjs, beside
  // the client that implements it, so the actions the model is offered and the
  // actions actually handled cannot drift apart.
  if (isFilesTool(t)) return filesToolSchema(t);
  // jev — a typed decision. The model supplies a question and an option list,
  // and the STRICT spec is built here from that flat shape: a tool-calling model
  // writes prose well and JSON poorly, so it is never asked to author criteria.
  if (t?.kind === 'jev') {
    return {
      type: 'function',
      function: {
        name: t.name || 'jev_decide',
        description:
          t.description ||
          'Ask a narrow decision question about a piece of text and get a typed answer back instead of prose. Use for routing, ranking and verification. Returns a probability, a chosen option, or a position on a rubric.',
        parameters: {
          type: 'object',
          properties: {
            state: {
              type: 'string',
              description: 'The text or JSON to judge — paste the material, do not summarise it.',
            },
            question: {
              type: 'string',
              description: 'The one decision to make, phrased in plain words.',
            },
            kind: {
              type: 'string',
              enum: ['noul', 'choice', 'score', 'rank'],
              description:
                'noul = yes/no as a probability; choice = pick exactly one option; rank = the same as choice, said explicitly when you want the candidates ORDERED and the leader separated enough to act on; score = position on an ordered rubric. A choice, rank or score answer always comes back with its full ranking attached.',
            },
            options: {
              type: 'string',
              description:
                'Required for choice, rank and score: the options, or the rubric steps ordered low → high, separated by | or commas.',
            },
          },
          required: ['state', 'question', 'kind'],
        },
      },
    };
  }
  return {
    type: 'function',
    function: {
      name: t?.name || 'http_tool',
      description: t?.description || 'Call an external HTTP API.',
      parameters: {
        type: 'object',
        properties: {
          body: { type: 'object', description: 'JSON request body / query parameters.' },
        },
        required: [],
      },
    },
  };
}

/** One chat completion through the active LLM backend (OpenRouter or DeepSeek). */
async function llmOnce(model, messages, tools, signal) {
  const cfg = llmConfig();
  const payload = {
    model: model || cfg.model,
    messages,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
  };
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: llmHeaders(cfg),
    body: JSON.stringify(payload),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `${cfg.provider} ${r.status}`);
  const choice = j?.choices?.[0]?.message ?? {};
  return {
    content: String(choice.content ?? ''),
    toolCalls: Array.isArray(choice.tool_calls) ? choice.tool_calls : [],
  };
}

/** Execute one tool call server-side (web search, or a generic REST endpoint). */
async function runToolOnce(tool, rawArgs, signal) {
  let args = {};
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    /* keep empty */
  }
  if (!tool) return `Unknown tool.`;
  if (tool.kind === 'jev') {
    const jev = jevConfig();
    if (!jev.key) return 'tool error: Jev not configured (no OpenRouter key)';
    const built = specFromToolArgs({
      kind: args.kind,
      question: args.question ?? args.instructions,
      options: args.options,
    });
    if (!built.ok) return `tool error: ${built.error}`;
    const state = String(args.state ?? args.text ?? '').trim();
    if (!state) return 'tool error: state is required — paste the text to judge';
    const req = buildRequest({ state, questions: built.value });
    if (!req.ok) return `tool error: ${req.error}`;
    try {
      const { answers } = await jevDecide(req.value);
      // jev is a RERANKER as well as a tool: the same `choice` answer already
      // carries the whole distribution, so the order is derived here instead of
      // costing a second call. Appended always, not on request — a model that
      // asked for a choice and silently got back only the winner would have no
      // way to tell a separated leader from a coin toss.
      const ranking = Object.values(rankAnswers(built.value, answers)).map(describeRanking);
      const body = [describeAnswers(answers), ...ranking].filter(Boolean).join('\n');
      return clipText(body || 'tool error: empty decision', 4000);
    } catch (err) {
      return `tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (isFilesTool(tool)) return runFilesTool(tool, args, signal);
  if (isWebTool(tool)) {
    const ws = webSearchConfig();
    if (!ws.key) return `tool error: ${ws.label} not configured — set ${ws.envVar} or save it in Settings`;
    const query = String(args.query ?? args.input ?? '').trim();
    if (!query) return 'tool error: query is required';
    try {
      return await searchWeb({
        provider: ws.provider,
        key: ws.key,
        query,
        depth: resolveDepth(args, tool, ws.depth),
        freshness: args.freshness,
        perHit: PER_HIT_CHARS,
        total: TOOL_RESULT_CHARS,
        clip: clipText,
        signal,
      });
    } catch (err) {
      // A provider that is down, rate-limited or has gone quiet must report as a
      // TOOL error the model can read and work around — not take the run down.
      return `tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const target = String(tool.url || '').trim();
  if (!/^https:\/\//i.test(target)) return 'tool error: tool url must be https://';
  const method = tool.method === 'GET' ? 'GET' : 'POST';
  const token = (tool.id && toolTokens.get(tool.id)) || '';
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let url = target;
  const init = { method, headers };
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) qs.set(k, String(v));
    url = `${target}${target.includes('?') ? '&' : '?'}${qs.toString()}`;
  } else {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(args);
  }
  const r = await fetch(url, { ...init, signal });
  const text = await r.text().catch(() => '');
  if (!r.ok) return `tool error: HTTP ${r.status} ${clipText(text, 300)}`;
  return clipText(text, 4000);
}

/**
 * A tool-free view of a run's transcript: the original system + user turn, plus
 * whatever the tools actually returned, as plain text.
 *
 * Handing a model a history full of `tool_calls` and `role: 'tool'` messages
 * while declaring NO tools makes it answer by PRINTING the tool call it wanted
 * to make — DeepSeek emits its native DSML markup (U+FF5C bars around `DSML`)
 * as text, and that markup was landing in `run.messages` as the agent's final
 * answer on the glasses. Re-declaring the tools with `tool_choice: 'none'` does
 * NOT stop it (verified against deepseek-flash), so the scaffolding is removed.
 */
function toolFreeWire(wire, ask) {
  const head = wire.filter((m) => m.role === 'system' || m.role === 'user').slice(0, 2);
  const found = [];
  for (let i = 0; i < wire.length; i++) {
    const m = wire[i];
    if (m.role !== 'tool') continue;
    const name = wire[i - 1]?.tool_calls?.[0]?.function?.name ?? 'result';
    const body = stripToolMarkup(String(m.content ?? ''));
    if (body) found.push(`${name}: ${body}`);
  }
  return [
    ...head,
    ...(found.length
      ? [{ role: 'user', content: `[tool results]\n${clipText(found.join('\n'), 12000)}\n[end tool results]` }]
      : []),
    { role: 'user', content: ask },
  ];
}

/**
 * The text that becomes an agent's final answer. Never machine syntax: a reply
 * that was nothing but a pseudo tool call has to be replaced, not shown.
 */
function answerText(raw) {
  const text = stripToolMarkup(raw);
  if (text) return text;
  return looksLikeToolMarkup(raw)
    ? 'I could not summarise this run. Try a simpler prompt, or add a search tool.'
    : '';
}

/**
 * Run the agent loop and stream every turn to both clients. Never throws: the
 * failure is recorded on the run so the glasses and the browser both show it.
 */
async function executeRun(run) {
  const push = (m) => {
    run.messages.push(m);
    broadcastRun(run);
  };
  // The clock is fixed at trigger time so every step of the loop (including
  // the tools) reasons about the same "now".
  const now = new Date(run.startedAt);
  const resolved = preprocessText(run.prompt, now);
  // Card -> Directives -> Material -> Ask, in one tested place. Extracted
  // because this module starts a server on import and so cannot be unit-tested;
  // `wire.mjs` can, and it asserts that a run with no saved task and no
  // directive produces byte-for-byte the messages the inline version did.
  const wire = assembleWire(run, resolved.text, now);
  // Show the resolutions in the transcript so it is obvious the model was not
  // left to guess. Runs with no relative words gain nothing and stay clean.
  // NOTE: ASCII only — the G2 firmware font has no emoji glyphs, so a clock
  // emoji here would render as a missing-glyph box on the glasses.
  if (resolved.notes.length) {
    run.messages.push({
      role: 'assistant',
      content: `[time] ${resolved.notes.join('; ')}`,
      at: Date.now(),
    });
    broadcastRun(run);
  }
  const schemas = run.tools.map(toolSchemaFor);
  const ac = new AbortController();
  runAbort.set(run.id, ac);
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (run.status === 'stopped') return;
      run.statusText = step === 0 ? 'Thinking…' : 'Reasoning…';
      broadcastRun(run);
      const { content, toolCalls } = await llmOnce(run.model, wire, schemas, ac.signal);

      if (!toolCalls.length) {
        const answer = answerText(content);
        // A reply of nothing but machine syntax means the model wanted a tool it
        // was not offered. Do not end the run on it — fall through to the
        // summariser, which re-asks without any tool scaffolding.
        if (!answer && content.trim()) break;
        run.messages.push({
          role: 'assistant',
          content: answer || '(no answer)',
          at: Date.now(),
        });
        run.status = 'done';
        run.statusText = '';
        broadcastRun(run);
        return;
      }

      wire.push({ role: 'assistant', content, tool_calls: toolCalls });
      for (const call of toolCalls) {
        if (run.status === 'stopped') return;
        const name = call?.function?.name ?? '';
        const rawArgs = call?.function?.arguments ?? '{}';
        push({
          role: 'assistant',
          content: content || `Calling ${name}…`,
          tool: name,
          args: clipText(String(rawArgs).replace(/\s+/g, ' '), ARG_CHARS),
          at: Date.now(),
        });
        run.statusText = `Searching · ${name}…`;
        broadcastRun(run);
        const tool = run.tools.find((t) => t.name === name);
        const result = await runToolOnce(tool, rawArgs, ac.signal);
        wire.push({ role: 'tool', content: result, tool_call_id: call.id });
        // Stored VERBATIM. `result` is already bounded by runToolOnce, so a
        // second clip here only destroyed the record of what the model saw.
        push({ role: 'tool', content: result, tool: name, at: Date.now() });
      }
    }
    // The model kept calling tools instead of answering. Rather than failing the
    // run, ask once more for a summary of what it already gathered. (Small free
    // models loop on tool calls; erroring out here looked to the user like "the
    // relay refused the run".)
    //
    // The ask uses `toolFreeWire`, NOT the live `wire`: a transcript carrying
    // `tool_calls` with no tools declared is exactly what makes DeepSeek answer
    // by printing its DSML tool-call syntax as text, which then became the
    // agent's visible final answer.
    run.statusText = 'Summarising…';
    broadcastRun(run);
    const { content } = await llmOnce(
      run.model,
      toolFreeWire(
        wire,
        'Using ONLY the tool results above, reply with a short plain-text summary for the user (2-3 sentences). '
          + 'Do not call any tools and do not output JSON or any markup.',
      ),
      [],
      ac.signal,
    );
    run.messages.push({
      role: 'assistant',
      content: answerText(content) || 'I gathered results but could not finish the summary. Try a simpler prompt.',
      at: Date.now(),
    });
    run.status = 'done';
    run.statusText = '';
    broadcastRun(run);
  } catch (err) {
    if (run.status === 'stopped') return; // user pressed Stop
    const message = err instanceof Error ? err.message : String(err);
    run.messages.push({ role: 'assistant', content: `⚠️ ${message}`, at: Date.now() });
    run.status = 'error';
    run.error = message;
    run.statusText = '';
    broadcastRun(run);
  } finally {
    runAbort.delete(run.id);
    pruneRuns();
  }
}

async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Keep tool results bounded — they are fed straight back into the model. */
function clipText(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…[truncated]` : t;
}

// ── Tool-result budgets ───────────────────────────────────────────────────
// These bound what the MODEL reads in one step. They were 500/4000, which cut
// the tail off every search hit before the model ever saw it.
//
// The store is deliberately NOT budgeted separately: a run's transcript is the
// record of what actually happened, and clipping it produced sessions that
// could not be read back in full. The old stored copy was clipped to 600 chars
// with a literal "…[truncated]" appended, so a finished session permanently read
// as truncated — and re-reading the run from `run.prompt` meant that clip
// protected nothing. What is stored is now exactly what the model was shown.
const PER_HIT_CHARS = 3000;
const TOOL_RESULT_CHARS = 16000;
/** Tool-call arguments are shown in the transcript too; args can be JSON blobs. */
const ARG_CHARS = 400;

loadSecrets();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// channel -> { name, clients: Set<res>, lastState: object | null }
const channels = new Map();

// Channels whose payload is a LIVE SIGNAL rather than durable state: the Jarvis
// run mirror ('ai') and its directed control frames ('ai-ctl'). A frame on one of
// these must be DELIVERED ONCE and then forgotten. A replayed frame is a finished
// run — or a Stop the user pressed minutes ago — arriving as if it were happening
// now, and on the glasses that means a stale overlay replacing whatever the
// wearer was reading. So they are excluded from the disk snapshot AND from
// `lastState`, which is what the `init` frame hands to every new client.
// Every other channel (hub, agents) is restored and mirrored to disk as before.
const TRANSIENT_CHANNELS = new Set(['ai', 'ai-ctl']);

function getChannel(name) {
  if (!channels.has(name)) channels.set(name, { name, clients: new Set(), lastState: null });
  return channels.get(name);
}

/** Load persisted channel state from disk at boot (best-effort). */
async function loadPersistedState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [name, lastState] of Object.entries(data ?? {})) {
      if (lastState && !TRANSIENT_CHANNELS.has(name)) getChannel(name).lastState = lastState;
    }
    console.log(`[g2-hub] restored ${Object.keys(data ?? {}).length} channel(s) from ${STATE_FILE}`);
  } catch {
    /* no persisted state yet — fresh start */
  }
}

/** Mirror the channel's last state to disk (best-effort, never blocks a reply). */
async function persistState(name, lastState) {
  try {
    const data = {};
    for (const [ch, info] of channels) {
      if (TRANSIENT_CHANNELS.has(ch)) continue;
      data[ch] = info.lastState ?? null;
    }
    await writeFile(STATE_FILE, JSON.stringify(data, null, 2));
  } catch {
    /* disk may be read-only on some hosts — in-memory broadcast still works */
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // `Authorization` MUST be listed: a browser (or a WebView on a different
  // origin than the relay) sends the session/device token as a Bearer header,
  // which makes the request non-simple and triggers a preflight. Omitting it
  // here made the browser block the call with
  //   "Request header field authorization is not allowed by
  //    Access-Control-Allow-Headers in preflight response."
  // — which surfaced in the UI as "relay refused the run".
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

/**
 * Responses that asked for SEVERAL channels at once (`?channels=a,b,c`).
 *
 * WHY THIS EXISTS — browsers keep at most SIX HTTP/1.1 connections per origin,
 * and an SSE response never releases its socket. The app used to open one
 * EventSource per channel (hub, agents, ai, ai-ctl), so a single tab pinned
 * 4 of the 6 sockets forever and a SECOND tab pinned 8 — more than the cap.
 * Every remaining request (notably POST /api/llm) then queued indefinitely:
 * a Jarvis run would sit on its first model turn with the HUD showing no
 * overlay, which looked like a hung provider but was pure socket starvation.
 *
 * Multiplexing fixes that at the root: one socket carries every channel. It
 * also means a NEW channel costs zero extra sockets, so the tool-call /
 * capability layer stays free to grow.
 *
 * A multiplexed client is registered in EVERY channel's `clients` set, so
 * publishing is unchanged; only the frame is tagged with its origin channel
 * (a legacy single-channel subscriber gets the untagged frame it always got).
 */
const MULTIPLEXED = new WeakSet();

function send(client, frame, channelName) {
  // Tag only when the client multiplexes AND the frame does not already name
  // its channel — a single-channel subscriber must keep receiving exactly the
  // frames it received before this change.
  const tag = channelName ?? frame.channel;
  const out = tag && MULTIPLEXED.has(client) ? { ...frame, channel: tag } : frame;
  try {
    client.write(`data: ${JSON.stringify(out)}\n\n`);
  } catch {
    /* client gone */
  }
}

/**
 * Serve a static file from `root` with a safe index.html fallback (SPA routing).
 * `mount` is an optional URL prefix to strip (e.g. '/glasses').
 */
async function serveFrom(root, mount, req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = mount && pathname.startsWith(mount) ? pathname.slice(mount.length) : pathname;
  let filePath = join(root, normalize(rel).replace(/^([/\\])+/, ''));

  // Path-traversal guard: resolved path must stay inside root/.
  if (relative(root, filePath).startsWith('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(root, 'index.html');
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ── Live streaming speech-to-text (WebSocket relay to Deepgram) ─────────────
// The glasses/browser opens a WebSocket to /api/stt/ws and streams raw 16 kHz
// s16le mono PCM; this process relays it to Deepgram's live endpoint (nova-3)
// and streams Results (interim + final) back. The API key stays server-side —
// the client only ever talks to this relay. Uses Node's global WebSocket client
// (Node ≥ 22), so the Docker image must NOT be older than node:22.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAcceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

/** Build a server→client WebSocket frame (never masked). */
function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

/**
 * Incremental client-frame parser. Calls cb(opcode, payload, fin) for every
 * complete frame received on the socket. Handles ping/pong/close internally.
 */
function wsPipe(socket, cb) {
  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = buf.length === 0 ? d : Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const opcode = b0 & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return socket.destroy();
        len = Number(big);
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x8) {
        // close
        try {
          socket.write(wsFrame(0x8, payload.subarray(0, 2)));
        } catch {
          /* socket gone */
        }
        socket.end();
        cb(0x8, payload, true);
        return;
      }
      if (opcode === 0x9) {
        // ping → pong
        try {
          socket.write(wsFrame(0xa, payload));
        } catch {
          /* socket gone */
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) cb(opcode, payload, (b0 & 0x80) !== 0);
      // 0x0 continuation + 0xa pong: ignore
    }
  });
}

/** Deepgram live URL (auth token in the query — Node's WebSocket has no headers). */
function deepgramWsUrl() {
  const p = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || 'nova-3',
    language: process.env.DEEPGRAM_LANG || 'en',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  });
  return `wss://api.deepgram.com/v1/listen?${p.toString()}&token=${process.env.DEEPGRAM_API_KEY}`;
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const channel = getChannel(url.searchParams.get('channel') || 'hub');

  // Publish a HubState snapshot + broadcast to ALL connected devices.
  // Authorized only for an owner session or an approved device ID.
  if (req.method === 'POST' && url.pathname === '/api/stream') {
    const principal = principalFromToken(readToken(req, url));
    if (!principal) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let state;
    try {
      state = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    // Transient channels broadcast and are then DROPPED — see
    // TRANSIENT_CHANNELS. Caching the last `ai` frame here is what made every
    // reconnect replay it: the SSE `init` frame below hands `lastState` to a new
    // client, so a stale run (or a peer's idle frame) was re-delivered minutes
    // later and overwrote the HUD of a wearer who was in the middle of reading.
    if (!TRANSIENT_CHANNELS.has(channel.name)) {
      channel.lastState = state;
      void persistState(channel.name, state);
    }
    const frame = { type: 'state', state };
    for (const client of [...channel.clients]) send(client, frame, channel.name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: channel.clients.size }));
    return;
  }

  // SSE stream (owner browser + approved glasses devices) — long-lived.
  // Authorized only for an owner session or an approved device ID.
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const principal = principalFromToken(readToken(req, url));
    if (!principal) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    // MULTIPLEXED SUBSCRIPTION — `?channels=hub,agents,ai,ai-ctl` rides ONE
    // socket. See MULTIPLEXED above for why: 4 sockets per tab exhausts the
    // browser's per-origin connection pool and starves every other request.
    // A legacy `?channel=X` request keeps the original untagged frame shape.
    const wanted = (url.searchParams.get('channels') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const names = wanted.length ? [...new Set(wanted)] : [channel.name];
    const multi = wanted.length > 0;
    if (multi) MULTIPLEXED.add(res);

    const subs = names.map((n) => getChannel(n));
    for (const sub of subs) sub.clients.add(res);

    // ALWAYS send an init frame per channel — `state: null` means "the server
    // has nothing yet, seed me". Without this a client cannot tell an empty
    // relay from an unreachable one, and its fallback seeding would overwrite a
    // newer snapshot that another device already published.
    for (const sub of subs) send(res, { type: 'init', state: sub.lastState ?? null }, sub.name);

    // Agents channel also replays in-flight/recent runs so a client that just
    // came back from the background can rebuild the live transcript.
    if (subs.some((s) => s.name === 'agents')) {
      const live = runSnapshot().filter((r) => r.status === 'running');
      if (live.length) send(res, { type: 'runInit', runs: live }, 'agents');
    }

    req.on('close', () => {
      for (const sub of subs) sub.clients.delete(res);
    });
    return;
  }

  // Public auth config for the web control app (Google Sign-In).
  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' }));
    return;
  }

  // Verify a Google ID token and check the account against the whitelist.
  if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    const allowed = (process.env.ALLOWED_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!clientId || allowed.length === 0) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'auth not configured' }));
      return;
    }
    try {
      const payload = await verifyGoogleIdToken(parsed.idToken, clientId);
      const email = (payload?.email || '').toLowerCase();
      if (payload && email && allowed.includes(email)) {
        const sessionToken = randomToken();
        authStore.sessions[sessionToken] = { email: payload.email, createdAt: Date.now() };
        persistAuthStore();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, email: payload.email, sessionToken }));
      } else {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: payload ? 'not whitelisted' : 'invalid token' }),
        );
      }
    } catch {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid token' }));
    }
    return;
  }

  // Owner sign-out — revoke the session token.
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = readToken(req, url);
    if (token && authStore.sessions[token]) {
      delete authStore.sessions[token];
      persistAuthStore();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Owner session check — the web UI validates its stored token at boot so a
  // stale token (e.g. the auth store was reset by a redeploy) lands on the
  // login screen instead of a misleading "Offline" state.
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const owner = requireOwner(req, url);
    if (!owner) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, email: owner.email }));
    return;
  }

  // A glasses device self-registers with its unguessable per-device ID. If it
  // is already approved it learns so; otherwise it gets the pairing code the
  // owner must approve from a logged-in browser.
  if (req.method === 'POST' && url.pathname === '/api/pair/request') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const deviceId = String(parsed.deviceId || '').trim();
    if (!deviceId || deviceId.length > 128) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid deviceId' }));
      return;
    }
    let dev = deviceById(deviceId);
    if (dev && dev.status === 'approved') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'approved' }));
      return;
    }
    if (!dev) {
      dev = {
        deviceId,
        status: 'pending',
        pairCode: randomPairCode(),
        createdAt: Date.now(),
      };
      authStore.devices[deviceId] = dev;
      persistAuthStore();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'pending', pairCode: dev.pairCode }));
    return;
  }

  // Device polls until the owner approves its pairing code.
  if (req.method === 'GET' && url.pathname === '/api/pair/status') {
    const deviceId = String(url.searchParams.get('deviceId') || '').trim();
    const dev = deviceId ? deviceById(deviceId) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ ok: true, status: dev && dev.status === 'approved' ? 'approved' : 'pending' }),
    );
    return;
  }

  // Owner (logged-in browser) approves a pending pairing code.
  if (req.method === 'POST' && url.pathname === '/api/pair/approve') {
    const owner = requireOwner(req, url);
    if (!owner) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const code = String(parsed.pairCode || '').trim().toUpperCase();
    const dev = Object.values(authStore.devices).find(
      (d) => d.status === 'pending' && d.pairCode === code,
    );
    if (!dev) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'code not found' }));
      return;
    }
    dev.status = 'approved';
    dev.email = owner.email;
    dev.approvedAt = Date.now();
    persistAuthStore();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deviceId: dev.deviceId }));
    return;
  }

  // Owner lists approved devices (for the web UI's device manager).
  if (req.method === 'GET' && url.pathname === '/api/devices') {
    const owner = requireOwner(req, url);
    if (!owner) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const devices = Object.values(authStore.devices)
      .filter((d) => d.status === 'approved')
      .map((d) => ({
        deviceId: d.deviceId,
        email: d.email,
        approvedAt: d.approvedAt ?? null,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, devices }));
    return;
  }

  // Owner revokes an approved device.
  if (req.method === 'POST' && url.pathname === '/api/pair/revoke') {
    const owner = requireOwner(req, url);
    if (!owner) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const deviceId = String(parsed.deviceId || '');
    if (deviceId && authStore.devices[deviceId]) {
      delete authStore.devices[deviceId];
      persistAuthStore();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // Voice-dictation capability probe (the app hides/short-circuits the mic UI
  // when no provider is configured).
  if (req.method === 'GET' && url.pathname === '/api/stt/status') {
    const provider = sttProvider();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, supported: provider !== null, provider }));
    return;
  }

  // Raw audio bytes → transcribed text. Auth is required (owner session OR an
  // approved device) so nobody can burn your provider quota anonymously.
  if (req.method === 'POST' && url.pathname === '/api/stt') {
    const principal = principalFromToken(readToken(req, url));
    if (!principal) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const provider = sttProvider();
    if (!provider) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: 'Voice server not configured — set OPENAI_API_KEY or DEEPGRAM_API_KEY',
        }),
      );
      return;
    }
    const contentType = String(req.headers['content-type'] || 'audio/wav')
      .split(';')[0]
      .trim();
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > STT_MAX_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'audio too large' }));
        return;
      }
      chunks.push(chunk);
    }
    const audio = Buffer.concat(chunks);
    if (!audio.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'empty audio' }));
      return;
    }
    try {
      let text = '';
      if (provider === 'openai') {
        const mp = openaiMultipart(audio, contentType);
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${mp.boundary}`,
          },
          body: mp.body,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error?.message || `Whisper ${r.status}`);
        text = String(j.text || '').trim();
      } else if (provider === 'deepgram') {
        const dgModel = process.env.DEEPGRAM_MODEL || 'nova-3';
        const dgLang = process.env.DEEPGRAM_LANG || 'en';
        const r = await fetch(
          `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(dgModel)}&language=${encodeURIComponent(dgLang)}&punctuate=true&smart_format=true`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
              'Content-Type': contentType,
            },
            body: audio,
          },
        );
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.err?.message || j?.message || `Deepgram ${r.status}`);
        text = String(j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return;
  }

  // Agents capability probe — the web UI shows setup hints and the glasses app
  // refuses to run an agent when the keys are missing. Unauthenticated on
  // purpose: it exposes only booleans and provenance, never a key.
  if (req.method === 'GET' && url.pathname === '/api/agent/status') {
    json(res, 200, agentStatusPayload());
    return;
  }

  // ── Agent runs (server-side, survives backgrounding) ───────────────────────
  // POST /api/agent/run  -> start a run, returns { ok, runId }
  // POST /api/agent/stop -> cancel a run
  // GET  /api/agent/runs -> replay current runs
  if (url.pathname === '/api/agent/run' && req.method === 'POST') {
    const owner = requirePrincipal(req, url);
    if (!owner) {
      json(res, 401, { ok: false, error: 'sign-in or device pairing required' });
      return;
    }
    const cfg = llmConfig();
    if (!cfg.key) {
      const keyEnv = cfg.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENROUTER_API_KEY';
      json(res, 501, {
        ok: false,
        error: `LLM not configured — set ${keyEnv} or save it in Settings`,
      });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, RUN_MAX_BYTES);
    } catch {
      json(res, 400, { ok: false, error: 'invalid JSON or body too large' });
      return;
    }
    const prompt = String(body?.prompt ?? '').trim();
    const agent = body?.agent ?? {};
    if (!prompt) {
      json(res, 400, { ok: false, error: 'prompt is required' });
      return;
    }
    const tools = Array.isArray(body?.tools)
      ? body.tools.filter((t) => t && typeof t.name === 'string').slice(0, 10)
      : [];
    const run = {
      id: randomBytes(8).toString('hex'),
      agentId: String(agent.id ?? ''),
      agentName: String(agent.name ?? 'Agent'),
      systemPrompt: String(agent.systemPrompt ?? ''),
      // Optional, and absent from older clients. Both are layered INTO the wire
      // rather than replacing anything (see executeRun), and when neither is
      // present the assembled messages are byte-for-byte what they were before
      // these fields existed — which is the property the delta plan rests on.
      savedPrompt: String(body?.savedPrompt ?? ''),
      instructions: String(body?.instructions ?? ''),
      model: String(body?.model || agent.model || cfg.model),
      prompt,
      title: prompt.slice(0, 48),
      tools,
      messages: [{ role: 'user', content: prompt, at: Date.now() }],
      status: 'running',
      statusText: 'Thinking…',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    runs.set(run.id, run);
    pruneRuns();
    json(res, 200, { ok: true, runId: run.id });
    broadcastRun(run);
    void executeRun(run);
    return;
  }

  if (url.pathname === '/api/agent/stop' && req.method === 'POST') {
    const owner = requirePrincipal(req, url);
    if (!owner) {
      json(res, 401, { ok: false, error: 'sign-in or device pairing required' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, 4 * 1024);
    } catch {
      json(res, 400, { ok: false, error: 'invalid JSON' });
      return;
    }
    const run = runs.get(String(body?.runId ?? ''));
    if (!run) {
      json(res, 404, { ok: false, error: 'run not found' });
      return;
    }
    if (run.status === 'running') {
      run.status = 'stopped';
      run.statusText = '';
      runAbort.get(run.id)?.abort();
      broadcastRun(run);
    }
    json(res, 200, { ok: true, runId: run.id, status: run.status });
    return;
  }

  if (url.pathname === '/api/agent/runs' && req.method === 'GET') {
    const owner = requirePrincipal(req, url);
    if (!owner) {
      json(res, 401, { ok: false, error: 'sign-in or device pairing required' });
      return;
    }
    pruneRuns();
    json(res, 200, { ok: true, runs: runSnapshot() });
    return;
  }

  // Owner-only: store the LLM/tool keys + model in .g2-hub-secrets.json.
  // Values are write-only — the response only reports booleans.
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const owner = requireOwner(req, url);
    if (!owner) {
      json(res, 401, { ok: false, error: 'owner sign-in required' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, 8 * 1024);
    } catch {
      json(res, 400, { ok: false, error: 'invalid JSON' });
      return;
    }
    const map = {
      openrouterKey: 'openrouterKey',
      deepseekKey: 'deepseekKey',
      tavilyKey: 'tavilyKey',
      braveKey: 'braveKey',
      model: 'model',
      referer: 'referer',
      title: 'title',
      depth: 'depth',
      // '' means AUTO (whichever provider has a key); anything else is ignored
      // by webSearchConfig(), so a hand-crafted request cannot select a provider
      // that does not exist.
      searchProvider: 'searchProvider',
      // The Jarvis document store. Setting any of these REPLACES the client on
      // the next call (see filesRuntime), which is what makes an edited
      // credential take effect without a restart — and what makes it safe, since
      // the replaced client's rotating refresh token is simply dropped rather
      // than being left alive to replay it.
      filesUrl: 'filesUrl',
      filesUser: 'filesUser',
      filesPwd: 'filesPwd',
      filesKey: 'filesKey',
    };
    let touched = false;
    for (const [field, slot] of Object.entries(map)) {
      if (typeof body[field] === 'string') {
        secrets[slot] = body[field].trim();
        touched = true;
      }
    }
    // Remove a stored value so the field falls back to the environment/its
    // default again. A BLANK STRING cannot mean this: the page never reads a key
    // back, so an empty key box is indistinguishable from "leave it alone", and
    // sending it would delete a working key. Clearing is therefore explicit, and
    // the names are whitelisted against `map` so a crafted request cannot clear
    // anything that is not a settings field.
    if (Array.isArray(body?.clear)) {
      for (const name of body.clear) {
        if (typeof name !== 'string' || !(name in map)) continue;
        secrets[map[name]] = '';
        touched = true;
      }
    }
    // Generic REST tools: store each tool's bearer token keyed by tool id.
    if (body?.toolTokens && typeof body.toolTokens === 'object') {
      for (const [id, token] of Object.entries(body.toolTokens)) {
        if (typeof token !== 'string') continue;
        if (token) toolTokens.set(id, token);
        else toolTokens.delete(id);
        touched = true;
      }
    }
    if (touched) persistSecrets();
    json(res, 200, agentStatusPayload());
    return;
  }

  // LLM chat-completions proxy (OpenRouter or DeepSeek, per LLM_PROVIDER). Auth
  // required; the API key never leaves this process. Supports the OpenAI
  // `tools` / `tool_calls` protocol so the hand-rolled agent loop in
  // glasses/src/agents.ts can do multi-step reasoning.
  if (req.method === 'POST' && url.pathname === '/api/llm') {
    const principal = principalFromToken(readToken(req, url));
    if (!principal) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const cfg = llmConfig();
    if (!cfg.key) {
      const keyEnv = cfg.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENROUTER_API_KEY';
      json(res, 501, {
        ok: false,
        error: `LLM not configured — set ${keyEnv} or save it in Settings`,
      });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, LLM_MAX_BYTES);
    } catch {
      json(res, 400, { ok: false, error: 'invalid or oversized JSON' });
      return;
    }
    if (!Array.isArray(body?.messages) || !body.messages.length) {
      json(res, 400, { ok: false, error: 'messages[] is required' });
      return;
    }
    const payload = {
      model: typeof body.model === 'string' && body.model ? body.model : cfg.model,
      messages: withDateTimeMessages(body.messages, new Date()),
      ...(Array.isArray(body.tools) && body.tools.length
        ? { tools: body.tools, tool_choice: body.tool_choice || 'auto' }
        : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    };
    try {
      const r = await fetch(cfg.url, {
        method: 'POST',
        headers: llmHeaders(cfg),
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        json(res, 502, {
          ok: false,
          error: j?.error?.message || `${cfg.provider} ${r.status}`,
        });
        return;
      }
      const choice = j?.choices?.[0]?.message ?? {};
      // Reasoning ("chain of thought") is a separate field, and providers name
      // it differently: DeepSeek uses `reasoning_content`, OpenRouter `reasoning`.
      // It used to be dropped here, which is why the agent HUD could only ever
      // show its own step labels and never what the model actually thought.
      const reasoning = choice.reasoning_content ?? choice.reasoning;
      json(res, 200, {
        ok: true,
        model: j?.model || payload.model,
        message: {
          role: 'assistant',
          // Scrub machine syntax at the one funnel every model turn passes
          // through. A model that wanted a tool it was not offered answers by
          // PRINTING the call (DeepSeek's DSML markup); nothing downstream
          // filtered it, so it reached the glasses as the agent's answer.
          // See tool-markup.mjs.
          content: stripToolMarkup(String(choice.content ?? '')),
          ...(reasoning ? { reasoning_content: String(reasoning) } : {}),
          ...(Array.isArray(choice.tool_calls) ? { tool_calls: choice.tool_calls } : {}),
        },
        usage: j?.usage ?? null,
      });
    } catch (err) {
      json(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Tool proxy — web search (Tavily or Brave; key + provider + default depth
  // server-side) and any generic REST endpoint with an optional bearer token, so
  // the WebView never hits CORS or needs the URL in the manifest whitelist.
  if (req.method === 'POST' && url.pathname === '/api/tool') {
    const principal = principalFromToken(readToken(req, url));
    if (!principal) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    let body;
    try {
      // Which tool this is can only be read AFTER the body is parsed, so the cap
      // cannot come from the payload. Content-Length is present on every call
      // this app makes, so the document ceiling is used for a body that could
      // BE a document and the small generic cap for everything else — a stored
      // page is routinely hundreds of KB, and rejecting it here would make the
      // Files tool unusable through the very route an in-app agent uses.
      const declared = Number(req.headers['content-length'] || 0);
      const limit = declared > TOOL_MAX_BYTES ? FILES_MAX_BODY_BYTES : TOOL_MAX_BYTES;
      body = await readJsonBody(req, limit);
      if (limit > TOOL_MAX_BYTES && !isFilesTool(body)) {
        json(res, 413, { ok: false, error: 'tool call is too large' });
        return;
      }
    } catch {
      json(res, 400, { ok: false, error: 'invalid or oversized JSON' });
      return;
    }
    const args = body?.args && typeof body.args === 'object' ? body.args : {};
    try {
      if (isFilesTool(body)) {
        const { client, error } = filesRuntime();
        if (!client) {
          json(res, 501, { ok: false, error: `document store not configured — ${error}` });
          return;
        }
        json(res, 200, { ok: true, result: await runFilesTool(body, args) });
        return;
      }
      if (isWebTool(body)) {
        const ws = webSearchConfig();
        if (!ws.key) {
          json(res, 501, {
            ok: false,
            error: `${ws.label} not configured — set ${ws.envVar} or save it in Settings`,
          });
          return;
        }
        const query = preprocessText(String(args.query ?? args.input ?? '').trim(), new Date()).text;
        if (!query) {
          json(res, 400, { ok: false, error: 'query is required' });
          return;
        }
        const result = await searchWeb({
          provider: ws.provider,
          key: ws.key,
          query,
          depth: resolveDepth(args, body, ws.depth),
          freshness: args.freshness,
          perHit: PER_HIT_CHARS,
          total: TOOL_RESULT_CHARS,
          clip: clipText,
        });
        json(res, 200, { ok: true, result });
        return;
      }

      // Generic REST tool: the model supplies the JSON body / query params.
      const target = String(body?.url || '').trim();
      if (!/^https:\/\//i.test(target)) {
        json(res, 400, { ok: false, error: 'tool url must be https://' });
        return;
      }
      const method = body?.method === 'GET' ? 'GET' : 'POST';
      const toolId = typeof body?.toolId === 'string' ? body.toolId : '';
      const token = (toolId && toolTokens.get(toolId)) || '';
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      // Resolve relative dates in the model's own arguments too — a custom
      // REST tool is just as date-sensitive as a web search.
      const now = new Date();
      const resolvedArgs = Object.fromEntries(
        Object.entries(args).map(([k, v]) => [
          k,
          typeof v === 'string' ? preprocessText(v, now).text : v,
        ]),
      );
      let finalUrl = target;
      const init = { method, headers };
      if (method === 'GET') {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(resolvedArgs)) qs.set(k, String(v));
        if ([...qs].length) finalUrl += (target.includes('?') ? '&' : '?') + qs.toString();
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(resolvedArgs);
      }
      const r = await fetch(finalUrl, init);
      const text = await r.text();
      json(res, 200, { ok: r.ok, result: clipText(text, 4000) });
    } catch (err) {
      json(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Jev decisions — a typed-decision proxy. The model is NOT a chat model and
  // the OpenRouter key never leaves this process, so callers send only the
  // state and the question spec and receive typed answers back.
  if (req.method === 'POST' && url.pathname === '/api/decisions') {
    const principal = principalFromToken(readToken(req, url));
    if (!principal) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, JEV_MAX_BYTES);
    } catch {
      json(res, 400, { ok: false, error: 'invalid or oversized JSON' });
      return;
    }
    // Validate BEFORE spending an upstream call — a malformed spec is a 400 that
    // names the field, not an opaque provider error.
    const built = buildRequest(body);
    if (!built.ok) {
      json(res, 400, { ok: false, error: built.error, field: built.field });
      return;
    }
    const cfg = jevConfig();
    if (!cfg.key) {
      json(res, 501, {
        ok: false,
        error: 'Jev not configured — set OPENROUTER_API_KEY or save it in Settings',
      });
      return;
    }
    try {
      const out = await jevDecide(built.value);
      json(res, 200, { ok: true, ...out });
    } catch (err) {
      json(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── Jarvis document store (agent-authored HTML) ────────────────────────────
  // Four reasons every operation is proxied here rather than called from the
  // browser: the gateway's CORS list is empty (a direct call cannot preflight),
  // the credential must never reach a client, the gateway's
  // `X-Frame-Options: SAMEORIGIN` makes its own URL unframeable from any other
  // origin, and re-serving the body through this origin is the only way to hand
  // it to a SANDBOXED frame with an opaque origin.
  if (req.method === 'GET' && url.pathname === '/api/files/status') {
    const principal = requirePrincipal(req, url);
    if (!principal) {
      json(res, 401, { ok: false, error: 'sign-in or device pairing required' });
      return;
    }
    const { cfg, client, error } = filesRuntime();
    // Never a token, and never a probe: `configured` reports the CREDENTIAL, so
    // a slow or briefly unavailable gateway cannot read as "not set up".
    json(res, 200, {
      ok: true,
      configured: Boolean(client),
      mode: cfg.apiKey ? 'api_key' : 'password',
      url: cfg.url,
      hint: client ? '' : error,
    });
    return;
  }

  if (url.pathname === '/api/files' || url.pathname.startsWith('/api/files/')) {
    const principal = requirePrincipal(req, url);
    if (!principal) {
      json(res, 401, { ok: false, error: 'sign-in or device pairing required' });
      return;
    }
    const { client, error } = filesRuntime();
    if (!client) {
      json(res, 501, { ok: false, error: `document store not configured — ${error}` });
      return;
    }
    // A gateway failure is a 502 the app can render — never an unhandled throw
    // that would take the relay's request loop down with it.
    const fail = (err, fallbackStatus = 502) => {
      const status = Number(err?.status) || fallbackStatus;
      json(res, status >= 400 && status < 600 ? status : fallbackStatus, {
        ok: false,
        code: err?.code || 'gateway_error',
        error: err instanceof Error ? err.message : String(err),
      });
    };

    // The document BODY. Fetched BY the relay with its own credential and
    // re-served under a sandbox policy, because the browser cannot fetch it
    // directly from any origin but this one.
    const bodyMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})\/html$/.exec(url.pathname);
    if (req.method === 'GET' && bodyMatch) {
      try {
        const doc = await client.body(bodyMatch[1]);
        // The policy comes from the module that owns it, so the sandbox terms
        // the frame is served under cannot drift from SANDBOX_CSP.
        res.writeHead(200, { ...htmlResponseHeaders(), 'Content-Type': doc.contentType });
        res.end(doc.text);
      } catch (err) {
        fail(err);
      }
      return;
    }

    // The VIDEOS a document points at.
    //
    // Extracted HERE, by the relay, because the client cannot do it: the body is
    // streamed straight into a sandboxed frame with an opaque origin, so nothing
    // in this app can look inside it — not a fetch (CORS is empty upstream), not
    // the parent document (the frame is not same-origin). The relay already
    // holds the credential and already knows how to fetch the bytes, so this is
    // the one place the question can be answered. The list is small and rebuilt
    // from validated ids; see the header of extractMedia for why no URL from the
    // body is ever passed through.
    const mediaMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})\/media$/.exec(url.pathname);
    if (req.method === 'GET' && mediaMatch) {
      try {
        const doc = await client.body(mediaMatch[1]);
        json(res, 200, { ok: true, media: extractMedia(doc.text) });
      } catch (err) {
        fail(err);
      }
      return;
    }

    // UNDO a soft delete. A route of its own rather than a flag on DELETE,
    // because it is a different operation on a different transport: the gateway
    // has no `restore_session` MCP tool, so this is the one files route that
    // calls the gateway's REST surface (see `restore` in jarvis-files.mjs).
    const restoreMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})\/restore$/.exec(url.pathname);
    if (req.method === 'POST' && restoreMatch) {
      try {
        json(res, 200, { ok: true, document: await client.restore(restoreMatch[1]) });
      } catch (err) {
        fail(err);
      }
      return;
    }

    // One document's metadata.
    const oneMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (oneMatch && req.method === 'GET') {
      try {
        json(res, 200, { ok: true, document: await client.read(oneMatch[1]) });
      } catch (err) {
        fail(err);
      }
      return;
    }
    if (oneMatch && req.method === 'DELETE') {
      try {
        const hard = url.searchParams.get('hard') === 'true';
        // FLATTENED deliberately. `client.remove` answers { id, hard, deleted },
        // and nesting it under `deleted` (as this route used to) made the HTTP
        // field `deleted` an OBJECT while the client's own type declared a
        // boolean — so `res.deleted === true` was false for a delete that had
        // in fact succeeded. Every consumer that asked "did it work?" got "no".
        const removed = await client.remove(oneMatch[1], { hard });
        json(res, 200, {
          ok: true,
          id: removed.id,
          hard: removed.hard,
          deleted: removed.deleted,
        });
      } catch (err) {
        fail(err);
      }
      return;
    }

    // Publish. The client derives `content_type: text/plain` for a body that
    // does not look like HTML, because the gateway answers 422 for prose.
    if (req.method === 'POST' && url.pathname === '/api/files') {
      let body = null;
      try {
        body = await readJsonBody(req, FILES_MAX_BODY_BYTES);
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      if (!String(body?.html ?? '').trim()) {
        json(res, 400, { ok: false, error: 'html is required' });
        return;
      }
      try {
        const document = await client.create({
          html: body.html,
          title: body.title,
          agent: body.agent,
          tags: body.tags,
          id: body.id,
          slug: body.slug,
          overwrite: body.overwrite === true,
          contentType: body.contentType,
        });
        json(res, 200, { ok: true, document });
      } catch (err) {
        fail(err);
      }
      return;
    }

    // List. Nothing here is trusted: each parameter is clamped by the client,
    // so a hand-crafted `?limit=100000` cannot ask the gateway for the world.
    if (req.method === 'GET' && url.pathname === '/api/files') {
      try {
        const q = url.searchParams;
        const page = await client.list({
          limit: q.get('limit') ?? undefined,
          offset: q.get('offset') ?? undefined,
          q: q.get('q') || undefined,
          agent: q.get('agent') || undefined,
          tag: q.get('tag') || undefined,
          order: q.get('order') || undefined,
          // Without this the relay silently answered EVERY list with only the
          // live documents, so a soft-deleted one became unreachable by the UI
          // that had just promised it was restorable: invisible to the list, a
          // 404 to a direct read, and still on disk. The flag is what makes the
          // restore list possible at all.
          includeDeleted: q.get('include_deleted') === 'true',
        });
        json(res, 200, { ok: true, items: page.items, total: page.total, hasMore: page.hasMore });
      } catch (err) {
        fail(err);
      }
      return;
    }

    json(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  // The Even App identifies an Even Hub app by its app.json manifest at the
  // BARE ORIGIN ROOT — serve the glasses manifest exactly there.
  if (req.method === 'GET' && url.pathname === '/app.json') {
    try {
      const data = await readFile(join(GLASSES_DIST, 'app.json'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Everything else at the origin root = the G2 GLASSES app (SPA fallback).
  // Scanning the bare main URL loads the glasses app — exactly like the local
  // dev-server flow that already works on real hardware.
  if (req.method === 'GET') {
    await serveFrom(GLASSES_DIST, '', req, res);
    return;
  }

  res.writeHead(405);
  res.end();
});

// ── Live STT WebSocket: /api/stt/ws?token=… ─────────────────────────────────
// Streams raw 16 kHz s16le mono PCM from an authorized client to Deepgram and
// relays Results (interim + final) back as text frames.
server.on('upgrade', (req, socket) => {
  // Never crash the relay on a dead client socket — swallow socket errors.
  socket.on('error', () => {
    /* client went away */
  });
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/api/stt/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const principal = principalFromToken(url.searchParams.get('token'));
  if (!principal) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!process.env.DEEPGRAM_API_KEY || typeof WebSocket !== 'function') {
    socket.write('HTTP/1.1 501 Not Implemented\r\n\r\n');
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAcceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
  );

  let dg = null;
  let clientEnded = false;
  let dgOpened = false;
  const pending = []; // client frames that arrived before Deepgram finished connecting

  const flushPending = () => {
    while (pending.length) {
      const p = pending.shift();
      try {
        dg.send(p.kind === 'text' ? p.data.toString('utf8') : p.data);
      } catch {
        /* noop */
      }
    }
  };

  const closeAll = () => {
    try {
      dg?.close();
    } catch {
      /* noop */
    }
    try {
      socket.end();
    } catch {
      /* noop */
    }
  };

  try {
    dg = new WebSocket(deepgramWsUrl());
  } catch {
    // Log a fixed string only — never the error, which could echo the URL (and
    // its Deepgram token) if the constructor rejects it.
    console.error('[g2-hub] deepgram live: failed to create socket');
    closeAll();
    return;
  }

  // If Deepgram never opens (network/plan issue), don't hang the client — the
  // app falls back to the batch path when the socket closes without results.
  const openTimer = setTimeout(() => {
    if (!dgOpened) {
      console.error('[g2-hub] deepgram live: open timeout');
      clientEnded = true;
      closeAll();
    }
  }, 8000);

  dg.onopen = () => {
    dgOpened = true;
    clearTimeout(openTimer);
    flushPending();
  };
  dg.onmessage = (ev) => {
    if (clientEnded) return;
    try {
      socket.write(wsFrame(0x1, String(ev.data)));
    } catch {
      /* socket gone */
    }
  };
  dg.onerror = () => {
    if (!clientEnded) console.error('[g2-hub] deepgram live: stream error');
    closeAll();
  };
  dg.onclose = (ev) => {
    clearTimeout(openTimer);
    // Log WHY the Deepgram leg closed — code/reason are safe, never the URL.
    // 1006 = Deepgram dropped the TCP connection (network/firewall); 4xxx +
    // reason = Deepgram rejected the request (auth/plan/params).
    if (!clientEnded) {
      const e = ev && typeof ev === 'object' ? (ev || {}) : {};
      const code = 'code' in e ? e.code : '?';
      const reason = 'reason' in e ? String(e.reason || '') : '';
      const clean = 'wasClean' in e ? e.wasClean : '?';
      console.error(`[g2-hub] deepgram live: closed code=${code} reason="${reason}" clean=${clean}`);
    }
    closeAll();
  };

  wsPipe(socket, (opcode, payload) => {
    if (clientEnded) return;
    if (opcode === 0x8) {
      clientEnded = true;
      // Tell Deepgram to flush its final transcript, then shut down.
      try {
        dg?.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* noop */
      }
      setTimeout(closeAll, 1500);
      return;
    }
    const kind = opcode === 0x1 ? 'text' : 'binary';
    if (!dg || dg.readyState !== WebSocket.OPEN) {
      pending.push({ kind, data: payload });
      return;
    }
    try {
      dg.send(kind === 'text' ? payload.toString('utf8') : payload);
    } catch {
      /* noop */
    }
  });
});

await loadPersistedState();

server.listen(PORT, () => {
  console.log(`[g2-hub] relay on http://0.0.0.0:${PORT}`);
  console.log(`[g2-hub]   Web:   GET  http://localhost:${PORT}/`);
  console.log(`[g2-hub]   SSE:   GET  http://localhost:${PORT}/api/stream?channel=hub`);
  console.log(`[g2-hub]   State: POST http://localhost:${PORT}/api/stream`);
});
