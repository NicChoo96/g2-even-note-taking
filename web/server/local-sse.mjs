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
//   GET  /api/files/status        -> is the document store configured?
//   GET  /api/files                -> list stored HTML documents  (SUPERSEDED)
//   POST /api/files                -> publish an HTML document    (SUPERSEDED)
//   GET  /api/files/:id            -> one document's metadata     (SUPERSEDED)
//   DELETE /api/files/:id          -> soft-delete a document      (SUPERSEDED)
//   GET  /api/files/:id/revisions  -> a document's history        (SUPERSEDED)
//   GET  /api/files/:id/text      -> the document BODY as readable text, windowed
//   GET  /api/files/:id/html      -> the document BODY (bearer only; see below)
//   PATCH /api/files/:id          -> rename / retag a document
//   GET  /api/files/:id/media     -> the assets a document refers to, rebuilt
//   POST /api/files/:id/ticket    -> a signed URL that frames the body
//   GET  /api/files/:id/revisions/:n         -> one past revision
//   POST /api/files/:id/revisions/:n/restore -> reinstate a past revision
//
// WHERE A DOCUMENT IS RECORDED NOW: the backend hub owns the REGISTRY, and the
// app reaches it through the /api/hub/* prefix below (see hub-api.mjs). List,
// metadata, totals, publish, delete, restore and the revision LIST all live
// there -- write-serialised against `rev`, with an `Idempotency-Key`. The
// /api/files routes marked SUPERSEDED are kept only as this process's own
// fallback and are no longer the app's data path.
//
// WHAT COULD NOT MOVE, and why: the hub answers a document's RAW HTML and
// ignores `limit`/`offset` on /text, so the readable prose Jarvis is given has
// to be windowed here (htmlToText + bodyWindow). The hub's /media returns bare
// references, so player URLs have to be rebuilt here from a validated id -- a
// stored document is untrusted code and a `javascript:` URL must never reach an
// embed. The hub has no PATCH for a file, and no per-revision read or restore.
// And the gateway sends `X-Frame-Options: SAMEORIGIN`, so framing a body at all
// needs a ticket and an origin of our own (doc-origin.mjs).
//
// THE DOCUMENT STORE (jarvis-files.mjs) holds its own credential and its own
// session. The BROWSER NEVER TALKS TO THE GATEWAY DIRECTLY: its CORS list is
// empty, so a direct call from the SPA cannot even preflight. Every call comes
// through the routes above, which is also the only reason the credential can
// stay in this process.
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
  htmlToText,
  isFilesTool,
  bodyWindow,
  renderToolResult as renderFilesResult,
  renderToolBody as renderFilesBody,
} from './jarvis-files.mjs';
// The DOCUMENT ORIGIN — where untrusted, agent-authored pages are framed from
// when that must not be this app's own origin. See its header for why a sandbox
// on this origin can be neither relaxed, circumvented from inside, nor avoided
// any other way, and why the content gateway is deliberately left untouched.
import {
  DOC_TICKET_TTL_MS,
  docFrameUrl,
  docResponseHeaders,
  docTicketFromPath,
  newDocSecret,
  normalizeDocOrigin,
  signDocTicket,
  verifyDocTicket,
} from './doc-origin.mjs';
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
// The MCP tool layer. `mcp-tools.mjs` makes a server's OWN `tools/list` the
// source of truth for the schemas we hand the model, so adding a server is a
// transport rather than a hand-written schema; `mcp-router.mjs` uses JEV as a
// reranker to decide which of that catalogue a turn is actually offered. Both
// are split out because importing THIS module starts a server, so neither could
// be asserted against a stub if it lived here.
import { normalizeCatalogue, foldDrift } from './mcp-tools.mjs';
import { describeRoute, routeTools } from './mcp-router.mjs';
// Generic REST tools. The schema the model is offered and the body actually sent
// are built together, so they cannot drift into the mismatch they once had (the
// schema advertised `{ body: { ... } }` while the executor sent the args flat).
import { httpRequestArgs, httpToolSchema } from './http-tool.mjs';
// The hub's OWN stores (todo list, document library, notes). The schema and the
// reducer are pure and live together in hub-tools.mjs; nothing here knows how an
// action reaches the store.
import { hubToolSchema, isHubTool } from './hub-tools.mjs';
// …and the half that DOES need a socket. A hub tool call is applied to the hub
// itself, over the same API the app writes through, because the relay's copy of
// the hub state is a BOOTSTRAP and never an authority (see hub-write.mjs).
import { applyHubTool, HUB_TOOL_COLLECTION } from './hub-write.mjs';
import { isLocationTool, locationToolSchema, runLocationTool } from './location-tool.mjs';
// The hub API (everything the app persists) rides the SAME session as the
// document store, so this only needs the wrapper — never a second client.
import { createHubClient, forwardedHeaders, HUB_MAX_BODY_BYTES } from './hub-api.mjs';
// The `hub-changed` nudge (§2.2): when another device writes a collection, every
// OTHER device is told to refetch just that one. The rules are pure and live in
// their own module because importing THIS file starts a server, so anything left
// here could only ever be asserted as text.
import { collectionPath, hubChangedFrame, isOwnEcho, revOf, shouldNudge } from './hub-nudge.mjs';
// The auth store's durability rules (§2.1): the SHA-256 re-keying that keeps
// everyone signed in across the change, and the sweep that keeps the blob
// bounded. Pure for the same reason as the nudge above.
import { digestToken, normaliseAuthBlob, SESSION_TTL_MS } from './relay-auth.mjs';
// …and the conversation with the hub that mirrors that store there, so it
// survives a redeploy. Injected dependencies: nothing in it reaches a socket
// directly, so it can be driven against a stub instead of a live gateway.
import { createAuthStoreSync } from './relay-auth-sync.mjs';
import {
  HUB_MCP_AGENT_NAMES,
  HUB_MCP_AGENT_TOOLS,
  hubMcpToolSchema,
  isHubMcpTool,
  runHubMcpTool,
} from './hub-mcp-tools.mjs';
// Delegated intents: the app's own capabilities, offered to a run as a tool that
// PROPOSES a change for the device to run. Built per run from the catalogue the
// CLIENT sends, held in a side table, and kept out of the router — see ./intents.
import {
  INTENT_TOOL_NAME,
  intentToolFor,
  intentToolSchema,
  isIntentTool,
  runIntentTool,
} from './intents.mjs';

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

// ── The DOCUMENT ORIGIN (optional) ───────────────────────────────────────────
// Where a stored document is FRAMED FROM, when that is not this app's origin.
// The sandbox that protects our origin is also the thing that stops a document
// playing its own videos, and a second host is the only fix that does not put
// agent-authored HTML on our origin. See doc-origin.mjs for the live evidence.
//
//   DOCS_ORIGIN=http://localhost:5199   base URL a browser reaches it on
//   DOC_LISTEN_PORT=5199                ALSO serve it from this process
//   DOC_FRAME_ANCESTOR=…                who may embed a document (default: app)
//   DOC_TICKET_SECRET=…                 shared HMAC key; REQUIRED when the
//                                       document origin is a SECOND process
//
// Unset — the default — changes nothing at all: documents keep being served
// from this origin under SANDBOX_CSP, and the app keeps playing videos beside
// the page. The feature is opt-in in both directions, so a deployment that does
// not configure it cannot regress.
const DOCS_ORIGIN = normalizeDocOrigin(process.env.DOCS_ORIGIN);
const DOC_LISTEN_PORT = Number(process.env.DOC_LISTEN_PORT || 0);
const DOC_FRAME_ANCESTOR =
  String(process.env.DOC_FRAME_ANCESTOR || '').trim() ||
  [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].join(' ');
const DOC_TICKET_SECRET = String(process.env.DOC_TICKET_SECRET || '').trim() || newDocSecret();
// A second process serving documents must share THIS process's HMAC key, or every
// ticket minted here fails its signature over there and the frame comes up blank
// — the exact symptom this feature removes. Cheaper to say so at boot than to
// rediscover it from a blank frame, so name the misconfiguration outright.
if (DOCS_ORIGIN && DOC_LISTEN_PORT === 0 && !process.env.DOC_TICKET_SECRET) {
  console.warn(
    '[g2-hub] DOCS_ORIGIN is set, this process is NOT serving it, and DOC_TICKET_SECRET is unset: ' +
      'tickets minted here cannot be verified by that host — set DOC_TICKET_SECRET on both.',
  );
}

// ── Auth store: owner sessions + approved devices ────────────────────────────
// sessions: { [sha256(token)]: { email, createdAt } }
// devices:  { [deviceId]: { deviceId, status, pairCode, email, createdAt, approvedAt } }
//
// The session map is keyed by the DIGEST of the token, never the token, so a copy
// of this file — or of the hub blob it is now mirrored to — is not a working key
// ring. A legacy file is keyed by the token itself; `normaliseAuthBlob` re-keys
// those entries in place on load, so a user who is signed in now stays signed in
// across the upgrade instead of being logged out by the change meant to protect
// their session.
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
let authStore = { sessions: {}, devices: {} };

function loadAuthStore() {
  try {
    authStore = normaliseAuthBlob(JSON.parse(readFileSync(AUTH_FILE, 'utf8'))).value;
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
  const key = digestToken(token);
  const s = authStore.sessions[key];
  if (!s) return null;
  if (Date.now() - Number(s.createdAt) > SESSION_TTL_MS) {
    delete authStore.sessions[key];
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

// ── Hub API client (todo, docs, notes, files, agents, tools, sessions) ────────
// ONE client for the process, and it is the SAME client the document store uses:
// same origin, same credential, same rotating refresh family. `filesRuntime()`
// already creates and caches that session, so wrapping it adds only prefix
// resolution. Building a second client here would give the one account two
// rotating refresh tokens — they would rotate against each other and the loser's
// next refresh would be `refresh_token_reuse`, revoking the whole family and
// signing every surface out. See the header of hub-api.mjs.
let hubClientRef = null;
let hubClientKey = '';

function hubRuntime() {
  const { cfg, client, error } = filesRuntime();
  if (!client) return { client: null, error };
  // Re-wrap whenever the underlying session is replaced, or the wrapper would
  // keep calling into a discarded client whose token has stopped rotating.
  const key = [cfg.url, cfg.apiKey, cfg.username, cfg.password].join('\u0000');
  if (!hubClientRef || hubClientKey !== key) {
    hubClientRef = createHubClient(client);
    hubClientKey = key;
  }
  return { client: hubClientRef, error: '' };
}

// ── Auth store ↔ the hub (§2.1) ──────────────────────────────────────────────
// The auth file lives on the container's EPHEMERAL filesystem, so every redeploy
// wiped every owner session AND every approved device — the app then 401'd
// everywhere and signed the user out, and the Settings device list came back
// empty. The blob is mirrored to the hub now, which is durable.
//
// The FILE STAYS the working copy and the fallback. A hub that is down,
// unconfigured, or (today) refusing the route must never break sign-in, because
// that would be worse than the bug being fixed.
const authSync = createAuthStoreSync({
  call: (method, path, opts) => {
    let client = null;
    try {
      client = hubRuntime().client;
    } catch {
      client = null;
    }
    // A status of 0 is "no answer", which every caller already treats as "keep
    // running from the file" — so an unconfigured hub is not a special case.
    if (!client) return Promise.resolve({ status: 0, ok: false, headers: {}, text: '' });
    return client.call(method, path, opts);
  },
  getStore: () => authStore,
  setStore: (next) => {
    authStore = next;
  },
  save: persistAuthStore,
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
});

/**
 * The ONLY way a mutation to the auth store is persisted.
 *
 * The file goes first and synchronously — it is the fallback, so it has to be
 * current the instant anything reads it — and the hub mirror rides behind a
 * debounce. Deliberately not awaited by any caller: sign-in worked before the
 * hub existed and must keep working when the hub does not answer.
 */
function markAuthChanged() {
  authSync.markChanged();
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
          tag: args?.tag,
          order: args?.order,
          // Carried through so "what did I delete" is answerable — a soft-deleted
          // document is invisible to every other query, which is what made it
          // unreachable rather than merely omitted.
          includeDeleted: args?.include_deleted === true,
          limit: FILES_TOOL_LIST_LIMIT,
          signal,
        }),
      );
    }
    if (action === 'search') {
      const term = String(args?.q ?? '').trim();
      if (!term) return 'tool error: q is required to search';
      return renderFilesResult(
        'search_sessions',
        await client.search({ q: term, limit: FILES_TOOL_LIST_LIMIT, signal }),
      );
    }
    if (action === 'stats') {
      return renderFilesResult('session_stats', await client.stats({ signal }));
    }
    if (action === 'publish') {
      const doc = await client.create({
        html: args?.html ?? args?.document ?? args?.body,
        title: args?.title,
        agent: args?.agent || DEFAULT_FILES_AGENT,
        tags: args?.tags,
        id: args?.id,
        overwrite: args?.overwrite,
        slug: args?.slug,
        contentType: args?.content_type ?? args?.contentType,
        signal,
      });
      return renderFilesResult('create_session', doc);
    }
    if (action === 'read') {
      const id = String(args?.id ?? '').trim();
      if (!id) return 'tool error: id is required to read a document';
      // THE BODY IS READABLE, AND ONLY WHEN ASKED FOR.
      //
      // `include_html` used to be declared in the schema and then dropped right
      // here: the model could send a parameter that nothing acted on, so a
      // stored report was metadata and nothing else — "it can only read
      // metadata" was this line, one layer down. It is now forwarded, and what
      // comes back is TEXT (htmlToText + bodyWindow) — the WHOLE document by
      // default, so the model can quote it or rewrite it, and only a document
      // past the module's ceiling arrives in a window. Never the markup, either
      // way, and never more than that ceiling. See renderToolBody.
      const wantBody = args?.include_html === true;
      const doc = await client.read(id, { includeHtml: wantBody, signal });
      if (!wantBody) return renderFilesResult('read_session', doc);
      return renderFilesBody(doc, { offset: args?.offset, limit: args?.limit });
    }
    if (action === 'update') {
      const id = String(args?.id ?? '').trim();
      if (!id) return 'tool error: id is required to update a document';
      return renderFilesResult(
        'update_session',
        await client.update(id, {
          html: args?.html ?? args?.document ?? args?.body,
          title: args?.title,
          tags: args?.tags,
          agent: args?.agent,
          contentType: args?.content_type ?? args?.contentType,
          ifVersion: args?.if_version ?? args?.ifVersion,
          signal,
        }),
      );
    }
    if (action === 'delete' || action === 'remove') {
      const id = String(args?.id ?? '').trim();
      if (!id) return 'tool error: id is required to delete a document';
      // `hard` defaults to false HERE, so an unqualified delete stays the
      // recoverable one. The hard form is the destructive path and the model has
      // to name it (see the schema's description of `hard`).
      return renderFilesResult(
        'delete_session',
        await client.remove(id, {
          hard: args?.hard === true,
          reason: args?.reason,
          signal,
        }),
      );
    }
    if (action === 'history' || action === 'revisions') {
      return renderFilesResult(
        'list_revisions',
        // No id is not an error: the gateway answers the WHOLE ARCHIVE's history
        // in that case, which is how the model answers "what changed lately"
        // without having to name a document first.
        await client.revisions({
          id: args?.id,
          change: args?.change,
          subject: args?.subject,
          agent: args?.agent,
          order: args?.order,
          limit: args?.limit ?? FILES_TOOL_LIST_LIMIT,
          offset: args?.offset,
          signal,
        }),
      );
    }
    if (action === 'revision') {
      const id = String(args?.id ?? '').trim();
      if (!id) return 'tool error: id is required to read a revision';
      // Same contract as read, for the same reason: a revision is how a wearer
      // asks "what did it say BEFORE this edit", and metadata alone cannot
      // answer that either.
      const wantBody = args?.include_html === true;
      const rev = await client.revision(id, args?.revision, { includeHtml: wantBody, signal });
      if (!wantBody) return renderFilesResult('read_revision', rev);
      return renderFilesBody(rev, { offset: args?.offset, limit: args?.limit });
    }
    if (action === 'revert' || action === 'restore_revision') {
      const id = String(args?.id ?? '').trim();
      if (!id) return 'tool error: id is required to revert a document';
      return renderFilesResult(
        'restore_revision',
        await client.restoreRevision(id, args?.revision, {
          restoreMetadata: args?.restore_metadata !== false,
          ifVersion: args?.if_version ?? args?.ifVersion,
          subject: args?.subject,
          signal,
        }),
      );
    }
    if (action === 'revision_stats') {
      return renderFilesResult('revision_stats', await client.revisionStats(args?.id, { signal }));
    }
    return (
      'tool error: action must be one of publish, list, search, stats, read, update, delete, '
      + 'history, revision, revert, revision_stats'
    );
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
// How many of an agent's tools one turn is offered once the catalogue is big
// enough to be worth ranking (see offerTools). Deliberately small: MAX_STEPS is
// the loop's other budget, and a shortlist wider than the loop can use would
// spend the model's attention without buying a step.
const ROUTE_TOP = 4;
const MAX_RUNS = 8;
const RUN_TTL_MS = 30 * 60e3; // drop finished runs after 30 min
const RUN_MAX_BYTES = 256 * 1024;
const runs = new Map(); // runId -> run
const runAbort = new Map(); // runId -> AbortController

/**
 * The location snapshot a run was triggered with, keyed by run id.
 *
 * A SIDE TABLE rather than a field on the run, on purpose. `runSnapshot()` and
 * `broadcastRun` hand the run object to clients verbatim, so a field there would
 * put the wearer's coordinates on the wire — into the agents SSE feed, the
 * stored session and durable storage — where they would outlive the one tool
 * call that ever needed them. Beside the run, the default is that a position
 * never leaves this process at all, and the peer tables are pruned together
 * (see pruneRuns).
 */
const runLocations = new Map(); // runId -> snapshot

/**
 * A run's delegated-intent state, keyed by run id: the installed tool plus the
 * list of proposals it has recorded.
 *
 * A SIDE TABLE for a different reason than `runLocations`, and worth stating.
 *   - The TOOL is not on `run.tools` because the router would then be free to
 *     rank it away. Routing answers "which servers does this turn need"; asking
 *     the device what it can do is not one of the choices, it is the alternative
 *     to them, and a turn that dropped it would be a turn where an agent with a
 *     document to file silently could not file it.
 *   - The LIST is how a proposal gets a stable identity that does not repeat if
 *     the run's transcript is replayed to a client on reconnect (see
 *     `intent.key`). Nothing here is serialized; the proposal itself travels as
 *     the ordinary tool message, which is what makes it visible in the run the
 *     wearer is reading.
 */
const runIntents = new Map(); // runId -> { tool, list }

function pruneRuns() {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (run.status !== 'running' && now - run.updatedAt > RUN_TTL_MS) {
      runs.delete(id);
      runLocations.delete(id);
      runIntents.delete(id);
    }
  }
  while (runs.size > MAX_RUNS) {
    // Never evict an in-flight run.
    const victim = [...runs.values()]
      .filter((r) => r.status !== 'running')
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!victim) break;
    runs.delete(victim.id);
    runLocations.delete(victim.id);
    runIntents.delete(victim.id);
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

/**
 * Run one hub tool call and make the change TRUE on the hub.
 *
 * ⚠ WHAT WAS HERE BEFORE WAS THE BUG. This used to read the relay channel's own
 * `lastState`, run the reducer over that snapshot and publish the result. That
 * snapshot is a BOOTSTRAP copy — a git-ignored disk file locally, an ephemeral
 * filesystem in the container — so "have my agent add a task" changed the relay's
 * copy of the list, told the wearer it had worked, and reached neither the hub nor
 * any other device. Meanwhile the wearer's OWN tap went to the hub, which is why
 * only the assistant path lost writes.
 *
 * `getChannel('hub').lastState` is deliberately absent here. `applyHubTool` reads
 * the hub, runs the same pure reducer over what it read, and writes only the
 * difference through the same routes the app itself uses (see hub-write.mjs).
 *
 * The nudge is the half that needs this process's sockets, and it carries NO
 * STATE on purpose. Re-broadcasting a snapshot the relay assembled would re-serve
 * whatever it happened to hold — the stale frame the hub migration existed to end,
 * and the one way a device that had just written its own list could have it rolled
 * back underneath it. Naming the collection lets each client refetch just that one.
 *
 * A refused write is NOT nudged: nothing changed, so sending every other device
 * after identical bytes is the refetch storm the hub's `rev` rules exist to stop.
 */
async function runHubToolOnce(tool, args, signal) {
  const client = (() => {
    try {
      return hubRuntime().client;
    } catch {
      return null;
    }
  })();
  const applied = await applyHubTool(tool, args, { call: client?.call?.bind(client), signal });
  if (applied.ok && applied.writes > 0) {
    nudgeHubChanged(HUB_TOOL_COLLECTION[tool.kind], applied.rev, undefined);
  }
  return applied;
}

/** `JSON.parse` that answers null instead of throwing. */
function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Tell the OTHER devices that a hub collection changed (§2.2).
 *
 * The hub has no push route and the app now fetches every collection from it, so
 * without this a write on one device stayed invisible on the other until a
 * reload. The relay is the one component both devices already hold a connection
 * to, so it fans a small frame out along the `hub` channel.
 *
 * The frame carries NO state. The relay's cached copy is a BOOTSTRAP, not the
 * authority (see `applyRemote()` in the app's store), so re-broadcasting it would
 * re-serve a snapshot another device has already superseded — which is the stale
 * frame the hub migration existed to end. The frame names a collection and each
 * client refetches just that one from the hub.
 *
 * `rev` is passed through ONLY when the upstream response really had one, and
 * `hubChangedFrame` enforces it: sessions, memory, the ledger and settings do not
 * move `rev`, so a frame that invented one would announce a to-do change on a
 * routine session write.
 */
function nudgeHubChanged(path, rev, origin) {
  const channel = getChannel('hub');
  // Nobody to tell. Deliberately before the frame is built, so a single-device
  // deployment does no work at all for a nudge it cannot deliver.
  if (channel.clients.size === 0) return;
  const frame = hubChangedFrame(path, rev, origin);
  for (const client of [...channel.clients]) {
    // The author already has the new state — it wrote it — and a refetch under
    // its own cursor would fight whoever is typing in the document it just
    // saved. `client.g2Origin` is set when the SSE subscription is registered.
    if (isOwnEcho(frame, client.g2Origin)) continue;
    send(client, frame, channel.name);
  }
}

/**
 * ⚠ `publishHubState()` USED TO LIVE HERE, AND IT WAS THE ONLY REASON THIS
 * PROCESS COULD CACHE A HUB STATE IT HAD NOT RECEIVED. It took a state an agent
 * tool had assembled from the relay's own bootstrap copy and cached, persisted
 * and fanned it out — so a write that reached the hub nowhere looked, to every
 * device, exactly like one that had. Deleting it makes the rule `nudgeHubChanged`
 * already states true BY CONSTRUCTION: the relay's cached copy is a bootstrap,
 * and the only thing that may write it is `POST /api/stream` — a client sending
 * the state it actually holds.
 *
 * Nothing replaced it. A hub tool call now writes to the hub and nudges; the
 * fan-out for "here is a state a client just published" is the stream route's own
 * code above, which is where it belongs.
 */

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
  // The hub's own stores. One tool per area, each with an `action` enum, built
  // in hub-tools.mjs beside the reducer that implements those actions — so the
  // enum the model is offered and the switch that handles it cannot drift.
  if (isHubTool(t)) {
    const schema = hubToolSchema(t);
    if (schema) return schema;
  }
  // Jarvis's own memory and session history, over the hub's MCP. Built in rather
  // than stored, because the hub's tool kinds are a CLOSED vocabulary of nine
  // and none of them is a memory kind — probed live, `kind:'memory'` is refused.
  // Checking BEFORE the generic REST fallback, which would otherwise hand the
  // model a free-form request body for a tool that has a real schema.
  if (isHubMcpTool(t)) {
    const schema = hubMcpToolSchema(t);
    if (schema) return schema;
  }
  // The device's own capabilities, as a tool the run may PROPOSE through. Its
  // `action` enum is built from the catalogue the client sent with this run, so
  // there is no list of app actions anywhere in this process to drift. A
  // proposal is not an effect — see runIntentTool — it is an ask the device
  // answers by running the action through its own gate.
  if (isIntentTool(t)) return intentToolSchema(t);
  // Where the wearer is. Unlike every other kind this one has nothing to
  // configure and no arguments: the position is a SNAPSHOT taken on the device
  // when the run started and sent with it, because the relay cannot reach the
  // phone and a run has no way to ask mid-flight.
  if (isLocationTool(t)) return locationToolSchema(t);
  // Anything left is a generic REST tool: a tool with no body template offers a
  // free-form `body`, one with a template offers exactly its authored keys.
  return httpToolSchema(t);
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

/**
 * Execute one tool call server-side (web search, a hub store, or REST).
 *
 * `ctx` carries what a tool needs from beyond the relay's own reach, and today
 * that is one thing: the location snapshot the client sent with the run. It
 * arrives as an ARGUMENT rather than a module-level lookup because it belongs to
 * the run being executed — two runs in flight must never see each other's
 * position — and because a default keeps every caller that has nothing to pass
 * (the /api/tool proxy, the harnesses) working unchanged.
 */
async function runToolOnce(tool, rawArgs, signal, ctx = {}) {
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
  if (isHubTool(tool)) {
    const applied = await runHubToolOnce(tool, args, signal);
    return applied.text;
  }
  // Jarvis's faculties, over the hub's MCP rather than a store. It reads no hub
  // channel, so it cannot race a wearer's own edit, and like every branch here
  // it reports a refusal as text instead of throwing — a hub that is down must
  // cost the model one tool call, not the whole run.
  if (isHubMcpTool(tool)) {
    return runHubMcpTool(tool, args, { mcp: hubRuntime().client, signal });
  }
  // The device's own capabilities, as a proposal. Placed last among the
  // built-ins because it is the only branch that reaches nothing at all — no hub
  // read, no key, no network. It records the ask on the run and returns; the
  // DEVICE decides whether to run it, and gates it there if it cannot be undone.
  if (isIntentTool(tool)) {
    return runIntentTool(tool, args, { runId: ctx.runId, list: ctx.intents?.list });
  }
  // No hub read needed and no key to check — but no second source either. A run
  // that carried no snapshot gets a refusal that says so, never coordinates.
  if (isLocationTool(tool)) return runLocationTool(tool, args, ctx.location).text;
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
  // The template's defaults under the model's arguments — see http-tool.mjs for
  // why the schema and this merge must be built from the same description.
  const payload = httpRequestArgs(tool, args);
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(payload)) qs.set(k, String(v));
    url = `${target}${target.includes('?') ? '&' : '?'}${qs.toString()}`;
  } else {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload);
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
 * JEV, shaped the way the router wants it: a built request in, the answers out.
 *
 * Returns null when no ranker is configured, which `routeTools` reads as "no
 * ranker configured" and fails open on — so a relay with no OpenRouter key keeps
 * behaving exactly as it did, without a branch here to keep in sync.
 */
function jevResponder() {
  if (!jevConfig().key) return null;
  return async (request) => (await jevDecide(request)).answers;
}

/**
 * WHICH of a run's tools this turn is offered, and why.
 *
 * `run.tools` is the relay's own agent catalogue — web search, the document
 * store, jev, a generic REST tool — so today it is small and `routeTools`
 * declines to rank it ("the catalogue already fits") and returns every tool
 * unchanged. That is the correct outcome rather than a no-op: routing exists so
 * that the catalogue can GROW. Add a fifth server and this is the line that
 * stops the model being handed six descriptions that do not apply to the turn.
 *
 * It also means the common run spends NO extra request: `respond` is only
 * reached once the catalogue is bigger than the shortlist.
 */
async function offerTools(run, ask) {
  const catalogue = run.tools.map((t) => ({
    name: String(t?.name ?? ''),
    serverName: String(t?.name ?? ''),
    description: String(t?.description ?? ''),
  }));
  return routeTools({ ask, catalogue, top: ROUTE_TOP, respond: jevResponder() });
}

/**
 * The one fault a toolset can have that is worth REFUSING a run over: two tools
 * under one name.
 *
 * A provider answers a duplicate function name by rejecting the whole request, so
 * the run dies before the first prompt lands and the wearer is left looking at a
 * run that never arrived rather than one that failed. Catching it here is what
 * turns that into a sentence naming the collision.
 *
 * Answers the message to show, or null when the toolset is usable. Every OTHER
 * fault is the model's to route around — a thin description, a tool the router
 * then drops — and must not be allowed to block a run.
 */
function toolSetFault(tools) {
  const seen = new Set();
  for (const t of tools) {
    const name = String(t?.name ?? '').trim();
    if (!name) return 'a tool arrived with no name';
    if (seen.has(name)) return `two tools are both named "${name}"`;
    seen.add(name);
  }
  return null;
}

/**
 * The other fault worth REFUSING a run over: a model the configured backend
 * cannot serve.
 *
 * `cfg.model` is the relay's own choice and is provider-correct by construction,
 * but the other two layers are not. An agent saved while this relay ran
 * OpenRouter still carries a `vendor/model` id, and the provider answers an id it
 * does not serve by rejecting the whole request — the same shape of death as a
 * duplicate tool name, at the same moment, before the first prompt lands. Probe
 * against the live backend: one `jarvis_app` returns 200 and two return
 * "Tool names must be unique."; a model name it does not serve returns "The
 * supported API model names are …, but you passed …".
 *
 * The provider is the only one who can rule on this and the relay cannot reach it
 * to ask, so the check is deliberately narrow: DeepSeek's own model names carry
 * no vendor prefix, so an id containing a `/` cannot be one of theirs. Refusing on
 * anything more would be guessing at a provider's catalogue.
 *
 * Answers the message to show, or null when the model is at least plausibly
 * servable. An EMPTY model is a fault too — it would reach the provider as a
 * missing field, which reads to the wearer as nothing at all.
 */
function modelProviderFault(model, provider) {
  const id = String(model ?? '').trim();
  if (!id) return 'no model is configured — set one in Settings';
  if (provider === 'deepseek' && id.includes('/')) {
    return (
      `the deepseek backend cannot serve "${id}" — DeepSeek's models are named ` +
      'without a vendor prefix, so this looks like a model saved for OpenRouter'
    );
  }
  return null;
}

/**
 * Record a failure ON the run instead of letting it escape.
 *
 * Every path that can fail once the run exists funnels through here: a throw
 * inside the agent loop, a throw while the turn's offer is being built (both are
 * inside executeRun's own guard), and — via the `.catch` on the launch in the run
 * route — a throw BEFORE that guard, in the preprocessor or the wire assembly.
 *
 * That last one is why this is a named function rather than a catch block.
 * `void executeRun(run)` turned an early throw into an unhandled rejection:
 * nothing was recorded, the run stayed `running` until its TTL expired, and a
 * client watching the queue saw a run that simply never landed. A guard that can
 * only be reached from inside the function it protects is not a guard.
 *
 * Idempotent for a run that already finished, so the net at the launch site
 * cannot overwrite a real answer with a late bookkeeping error.
 */
function failRun(run, err) {
  if (run.status === 'done' || run.status === 'stopped') return;
  const message = err instanceof Error ? err.message : String(err);
  run.messages.push({ role: 'assistant', content: `⚠️ ${message}`, at: Date.now() });
  run.status = 'error';
  run.error = message;
  run.statusText = '';
  broadcastRun(run);
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
  const ac = new AbortController();
  runAbort.set(run.id, ac);
  try {
    // ── The turn's offer, built INSIDE the guard ────────────────────────────
    // It used to be built ABOVE the try, which made any throw here an unhandled
    // rejection: `void executeRun(run)` discarded it, nothing was recorded, and
    // the run sat `running` until its TTL ran out. Ranking reaches a model
    // (`jevResponder`), so a bad toolset or an upstream blip can fail right here
    // — and the wearer's only symptom was a run that never landed.
    //
    // Which of the agent's tools THIS turn is offered. Ranked against the request
    // itself, and it FAILS OPEN in every unhappy case — see the router's header.
    // The rule being protected: a turn with too many tools is degraded, a turn
    // with NO tools is broken, because the model then tells the wearer it has no
    // access to something it does have.
    const route = await offerTools(run, resolved.text);
    const keptNames = new Set(route.chosen.map((c) => c.name));
    // The intent tool joins the offer AFTER the router, never inside it. Routing
    // answers "which of this run's servers does this turn need", and the device's
    // capabilities are not one of the choices — they are the alternative to them.
    // Ranked, a run that had a document to file would lose the ability to file it
    // on any turn where the ask happened to read as a search.
    //
    // `some` rather than an unconditional push, because the property that matters
    // is not "the intent tool is offered" but "it is offered EXACTLY ONCE". Two
    // functions under one name is refused by the provider before the first prompt
    // lands, which is not a run that failed — it is a run that never arrived. The
    // route keeps it off `run.tools` (see the side table's header) so the two
    // cannot collide; this guard is what makes that collision impossible rather
    // than merely absent.
    const intentState = runIntents.get(run.id);
    const offered = run.tools.filter((t) => keptNames.has(t.name));
    if (intentState && !offered.some((t) => t.name === intentState.tool.name)) {
      offered.push(intentState.tool);
    }
    const schemas = offered.map(toolSchemaFor);
    if (run.tools.length > 1) console.log(`[g2-hub] agent run: ${describeRoute(route)}`);
    // Recorded ONLY when the toolset was actually narrowed. A fail-open line would
    // be noise on every ordinary run, while a narrowed one is the missing
    // explanation for a model that went looking for a tool it could not see.
    if (route.routed) {
      push({
        role: 'assistant',
        content:
          `[tools] offered ${schemas.length} of ${run.tools.length + (intentState ? 1 : 0)}: ` +
          `${schemas.map((s) => s.function.name).join(', ')}` +
          `${route.unresolved ? ' (order unresolved)' : ''}`,
        at: Date.now(),
      });
    }
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
        const tool = offered.find((t) => t.name === name);
        // A tool the router did NOT OFFER is not an unknown tool, and saying so
        // would send the model hunting for a typo instead of recovering. Naming
        // what is actually callable lets it retry in one step.
        const result = tool
          ? await runToolOnce(tool, rawArgs, ac.signal, {
              location: runLocations.get(run.id),
              runId: run.id,
              intents: runIntents.get(run.id),
            })
          : `tool error: ${name} is not available for this request. Call one of: `
            + `${schemas.map((s) => s.function.name).join(', ') || '(no tools)'}`;
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
    failRun(run, err);
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
  //
  // The hub adds two more, and both are REQUIRED rather than optional:
  //   Idempotency-Key — every hub write carries one. Blocked at the preflight,
  //                     a retry silently loses its dedupe and a dropped response
  //                     can apply the same write twice.
  //   If-Match        — the agents/docs concurrency guard. Losing it turns an
  //                     optimistic write into a 412 the app cannot distinguish
  //                     from a real conflict.
  //   X-Client-Id     — the WRITER's own id, so the relay can skip that one
  //                     client when it fans a `hub-changed` nudge out (§2.2).
  //                     Losing it does not break sync: every client then just
  //                     refetches its own write, costing one round trip.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, Idempotency-Key, X-Client-Id');
  // Response headers the app must READ. Neither is CORS-safelisted, so a
  // cross-origin caller sees them as undefined unless they are exposed here:
  //   ETag      — the value it has to send back as `If-Match` on the next write.
  //   Duplicate — `true` when a replayed Idempotency-Key already landed. That is
  //               a SUCCESS the caller has to be able to detect.
  res.setHeader('Access-Control-Expose-Headers', 'ETag, Duplicate, Idempotency-Key');
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
    // ⚠ THE RELAY MUST NOT MOVE BACKWARDS EITHER. `updatedAt` is the app's
    // tie-break everywhere else, so honour it here too. A device that reconnects,
    // was backgrounded, or published while this process was restarting can send
    // an OLDER snapshot than the one already cached; accepting it caches,
    // persists and fans out the rollback, and every other device then adopts it.
    // That is how a to-do list empties itself with nobody having deleted
    // anything — one stale publisher was enough to roll back the whole hub.
    //
    // Guarded only when BOTH sides carry a numeric stamp, so the transient
    // channels and any future non-`updatedAt` payload keep the old behaviour.
    const cachedStamp = Number.isFinite(channel.lastState?.updatedAt)
      ? channel.lastState.updatedAt
      : null;
    const incomingStamp = Number.isFinite(state?.updatedAt) ? state.updatedAt : null;
    if (
      !TRANSIENT_CHANNELS.has(channel.name) &&
      cachedStamp !== null &&
      incomingStamp !== null &&
      incomingStamp < cachedStamp
    ) {
      // Re-broadcast what we already hold. The stale publisher's own SSE socket
      // is in `channel.clients` (its publish was a separate fetch), so it learns
      // the current copy and catches up instead of diverging silently.
      const current = { type: 'state', state: channel.lastState };
      for (const client of [...channel.clients]) send(client, current, channel.name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stale: true, clients: channel.clients.size }));
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

    // The subscriber's OWN id, so the `hub-changed` fan-out can skip this socket
    // when it is the one that wrote. ABSENT is fine — the client then refetches
    // its own write, costing one round trip and nothing else. Held as a private
    // property on `res`: the frame shape is pinned by stream-mux-sim.mjs, so
    // nothing may be added to what is SENT.
    res.g2Origin = String(url.searchParams.get('origin') || '');

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
        // Keyed by the DIGEST of the token, so neither this file nor the hub blob
        // it is mirrored to is a working key ring if it leaks.
        authStore.sessions[digestToken(sessionToken)] = { email: payload.email, createdAt: Date.now() };
        markAuthChanged();
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
    // The map is keyed by digest, so the presented token is hashed to find it.
    const key = token ? digestToken(token) : '';
    if (key && authStore.sessions[key]) {
      delete authStore.sessions[key];
      markAuthChanged();
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
      markAuthChanged();
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
    markAuthChanged();
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
      markAuthChanged();
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
    // The device's own capabilities, described by the device. Null when it sent
    // none, which is how an older client keeps its old toolset rather than
    // getting a tool with an empty enum that can only refuse.
    //
    // Built BEFORE the wearer's tools, because whether this built-in exists is
    // what decides whether an authored tool may keep that name (see below).
    const intentTool = intentToolFor(body?.capabilities);
    // Cap the wearer's own tools FIRST, then append Jarvis's own faculties after
    // it, so a run that already sits at the cap cannot lose the memory tools.
    // Deduped by name with the built-in winning: a stored row called
    // `jarvis_memory` is a different tool wearing a name we own, and letting
    // both through would hand the model two schemas for one name — whichever
    // the router happened to keep would decide what that name meant.
    //
    // `jarvis_app` is the exception, because the built-in only exists when the
    // device sent a catalogue: the name is given up ONLY when the built-in is
    // actually there to take it. Dropping it unconditionally — which this did —
    // discarded the wearer's own tool for every older client that sends no
    // capabilities, leaving the slot empty and saying nothing about it.
    const authored = Array.isArray(body?.tools)
      ? body.tools
          .filter(
            (t) =>
              t &&
              typeof t.name === 'string' &&
              !HUB_MCP_AGENT_NAMES.has(t.name) &&
              !(intentTool && t.name === INTENT_TOOL_NAME),
          )
          .slice(0, 10)
      : [];
    // A tool that was handed over, not silently lost: the caller offered one
    // wearing our name and the built-in exists to take its place. Worth a line in
    // the log, because the alternative is a wearer wondering where their tool
    // went.
    const gaveUpName =
      Boolean(intentTool) &&
      Array.isArray(body?.tools) &&
      body.tools.some((t) => t?.name === INTENT_TOOL_NAME);
    // The intent tool is deliberately NOT on `tools`. It lives in the side table
    // the executor reads (see runIntents), and the header there says exactly why:
    // on the list, the router would be free to rank it away, and a turn with a
    // document to file would silently lose the ability to file it.
    //
    // ⚠ LISTING IT HERE WAS ALSO THE BUG. With the tool in this array AND in the
    // side table, the executor offered it twice — once through the router's
    // shortlist and once by appending the side table's copy — so the request
    // carried two functions named `jarvis_app`. The provider refuses that, so the
    // run died before the first prompt landed and the queue showed a run that
    // never arrived. Two homes for one tool was the whole fault; the side table is
    // now the only one.
    const tools = [...authored, ...HUB_MCP_AGENT_TOOLS];
    // A toolset that cannot reach the model is refused HERE, while the caller is
    // still listening and before the run exists, so the answer can name the fault.
    // The alternative is what the duplicate above produced: a run that was
    // accepted, broadcast, and then quietly died with nothing on it to say why.
    const fault = toolSetFault(intentTool ? [...tools, intentTool] : tools);
    if (fault) {
      json(res, 400, { ok: false, error: `cannot start this run — ${fault}` });
      return;
    }
    // Which model this run will use, resolved once, out loud.
    //
    // The AGENT's own model wins: an agent is a SAVED configuration, so a run of
    // that agent is expected to use the model it was saved with.
    //
    // The CALLER's model does NOT, and that was the second way these runs died.
    // `body.model` is the device's session model — by default an OpenRouter id
    // (`emptyLlmSettings`) until a visit to Settings syncs it from this relay — so
    // an agent with no model of its own could be launched on a model the relay's
    // backend does not serve, and the provider killed the request before the first
    // prompt landed. The relay's OWN configured model is the right fallback: it is
    // the model this relay was told to use, provider-correct by construction, and a
    // model set in Settings is written to the RELAY — so the caller's copy is a
    // mirror that can only go stale. The field is still read here, and reported
    // below when it disagrees, because an older client goes on sending it.
    const agentModel = String(agent.model ?? '').trim();
    const callerModel = String(body?.model ?? '').trim();
    const runModel = String(agentModel || cfg.model);
    const modelSource = agentModel ? 'agent' : 'relay';
    const modelFault = modelProviderFault(runModel, cfg.provider);
    if (modelFault) {
      json(res, 400, { ok: false, error: `cannot start this run — ${modelFault}` });
      return;
    }
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
      model: runModel,
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
    // Installed AFTER the run exists, because the key is the run's own id, and
    // BEFORE pruneRuns so an eviction in this same tick can still see and clear
    // it. Absent is the normal case for a client that delegates nothing.
    if (intentTool) runIntents.set(run.id, { tool: intentTool, list: [] });
    // The wearer's position, captured on the device when the run was triggered —
    // there is no route from here to the phone, and no client round trip mid-run
    // to add one. Kept BESIDE the run and never ON it: a field would be
    // serialized to every client by runSnapshot/broadcastRun, outliving the one
    // tool call that needs it. Absent is a normal case, and a location tool that
    // reads an absent snapshot REFUSES (see location-tool.mjs) rather than
    // falling back to anything.
    if (body?.location) runLocations.set(run.id, body.location);
    pruneRuns();
    // The answer to "which model is my agent actually running on" exists nowhere
    // else: the run object is broadcast verbatim to both clients, so a bookkeeping
    // field on it would ride into every stored session, and the wearer's own log
    // is the right place for a configuration fact. Model ids only — no key, no
    // token, and nothing the caller sent beyond the model it asked for.
    // A caller mirror that AGREES is not news, so it is mentioned only when it
    // disagrees — the one case where a reader needs to know it was read and
    // deliberately not used.
    const callerNote =
      callerModel && callerModel !== run.model ? `, ignoring the caller's ${callerModel}` : '';
    const nameNote = gaveUpName ? `, the caller's ${INTENT_TOOL_NAME} given up for the built-in` : '';
    console.log(
      `[g2-hub] agent run ${run.id}: model=${run.model} (from ${modelSource}), ` +
        `tools=${tools.length}${intentTool ? ' + intent' : ''}${nameNote}${callerNote}`,
    );
    json(res, 200, { ok: true, runId: run.id });
    broadcastRun(run);
    // A net UNDER the loop's own guard. executeRun covers everything from the
    // offer onwards, so this is what catches a throw BEFORE it — the preprocessor
    // or the wire assembly — which would otherwise be an unhandled rejection on a
    // run the client is already watching.
    void executeRun(run).catch((err) => failRun(run, err));
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
      // The hub's own stores, over the same proxy — and through the same
      // `runHubToolOnce` as the agent executor, rather than a second dispatch of
      // its own. A second one is what let this route and the executor drift, and
      // `ok` now comes from whether the HUB took the write: the old `result.ok`
      // reported the reducer's opinion of an action that had not been saved
      // anywhere, so a dropped write came back as a success.
      if (isHubTool(body)) {
        const applied = await runHubToolOnce(body, args, undefined);
        json(res, 200, { ok: applied.ok, result: applied.text, writes: applied.writes });
        return;
      }

      // Jarvis's faculties over the hub's MCP. Present here for the reason the
      // comment above the hub branch gives: without it this route would be a
      // second, DIVERGENT dispatcher, and a built-in arriving here would fall
      // through to the generic REST path and be told "tool url must be https://"
      // — a message describing a tool it is not. `runHubMcpTool` returns text
      // rather than throwing, so `ok` is decided by whether that text is an
      // error line, which is the only signal it emits.
      if (isHubMcpTool(body)) {
        const text = await runHubMcpTool(body, args, { mcp: hubRuntime().client });
        json(res, 200, { ok: !String(text).startsWith('tool error:'), result: text });
        return;
      }

      // Location, over the proxy. Without this branch a location tool would fall
      // through to the generic REST path below and be told "tool url must be
      // https://", which describes a tool it is not. The snapshot is whatever the
      // caller sent — this route never reads a device either.
      if (isLocationTool(body)) {
        const result = runLocationTool(body, args, body?.location);
        json(res, 200, { ok: result.ok, result: result.text });
        return;
      }

      // A delegated intent, over the proxy. REFUSED here rather than handled,
      // and the refusal is the point: a proposal belongs to a RUN — it is a
      // record in that run's transcript that the device later claims and gates.
      // This route serves a single tool call from the spoken loop, by a caller
      // that has no run, so a proposal posted here would be an ask with no owner:
      // recorded nowhere, gated by nobody. Falling through instead would be
      // worse than either — the generic REST path would report "tool url must be
      // https://" for a tool that is not an HTTP tool at all.
      if (isIntentTool(body)) {
        json(res, 200, {
          ok: false,
          result:
            'tool error: app actions can only be asked for from a run, not through the tool proxy',
        });
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
      // REST tool is just as date-sensitive as a web search. The tool's authored
      // template is layered UNDER those arguments here, so this proxy sends the
      // same object the agent executor does (see http-tool.mjs).
      const now = new Date();
      const resolvedArgs = Object.fromEntries(
        Object.entries(httpRequestArgs(body, args)).map(([k, v]) => [
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
  // ── Hub API — every collection the app persists ───────────────────────────
  // One authenticated passthrough to `<base>/hub/*`. The browser cannot reach
  // the hub itself (its CORS list is empty, verified live) and must never hold
  // the credential, so every data path in the app comes through here.
  //
  // This adds exactly three things: the hub prefix from /config, the bearer, and
  // ONE retry on a 401. It does NOT reinterpret the contract — `rev`, the
  // `Idempotency-Key` replay, `If-Match`, the bodiless `204` and the
  // `{ok:false,error,code}` envelope all belong to the browser client
  // (glasses/src/web/hub-client.ts), where the user action that produced them
  // lives. Doing it twice would let the two copies drift.
  if (url.pathname === '/api/hub/config') {
    const principal = requirePrincipal(req, url);
    if (!principal) {
      json(res, 401, { ok: false, error: 'sign-in or device pairing required' });
      return;
    }
    const { client, error } = hubRuntime();
    if (!client) {
      json(res, 501, { ok: false, error: `hub not configured — ${error}` });
      return;
    }
    json(res, 200, { ok: true, hubPrefix: await client.prefix() });
    return;
  }

  if (url.pathname === '/api/hub' || url.pathname.startsWith('/api/hub/')) {
    const principal = requirePrincipal(req, url);
    if (!principal) {
      json(res, 401, { ok: false, error: 'sign-in or device pairing required' });
      return;
    }
    const { client, error } = hubRuntime();
    if (!client) {
      json(res, 501, { ok: false, error: `hub not configured — ${error}` });
      return;
    }

    // `/api/hub/todos/1?limit=5` -> `/todos/1?limit=5`. The QUERY is part of the
    // path on purpose: the hub pages with `limit`/`cursor`, sequences with
    // `since`/`sinceSeq`, and files filter with `include`/`hard`. Dropping it
    // would silently return the unfiltered first page instead of an error.
    const hubPath = `${url.pathname.slice('/api/hub'.length) || '/'}${url.search}`;

    // A body only exists when the caller said so. A bodiless DELETE must stay
    // bodiless: sending `{}` would add a Content-Type the hub does not expect.
    let hubBody;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > 0) {
        try {
          hubBody = await readJsonBody(req, HUB_MAX_BODY_BYTES);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'invalid request body';
          const tooLarge = /too large/i.test(msg);
          json(res, tooLarge ? 413 : 400, {
            ok: false,
            error: msg,
            code: tooLarge ? 'TOO_LARGE' : 'VALIDATION_ERROR',
          });
          return;
        }
      }
    }

    // Only these two client headers mean anything to the hub, and they are the
    // only two the app sets. Everything else is DROPPED rather than forwarded —
    // `Authorization` above all, since the relay injects its own and a client
    // that could supply one would bypass the credential boundary entirely.
    const hubHeaders = {};
    if (req.headers['idempotency-key']) hubHeaders['Idempotency-Key'] = String(req.headers['idempotency-key']);
    if (req.headers['if-match']) hubHeaders['If-Match'] = String(req.headers['if-match']);

    let upstream;
    try {
      upstream = await client.call(req.method, hubPath, { body: hubBody, headers: hubHeaders });
    } catch (err) {
      // A hub failure is a 502 the app can render, never a thrown error that
      // would take the relay's request loop down with it.
      json(res, 502, {
        ok: false,
        code: err?.code || 'gateway_error',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Byte-for-byte passthrough, INCLUDING the status and an empty body. A 204
    // must stay bodiless — substituting `{}` would turn "no content" into a
    // parseable object the client would mistake for a payload.
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...forwardedHeaders(upstream),
    });
    res.end(upstream.text ?? '');

    // ── The `hub-changed` nudge (§2.2) ────────────────────────────────────────
    // ONLY a 2xx on a mutating method: a read changed nothing and a FAILED write
    // changed nothing, so nudging either would send every other device off to
    // refetch identical bytes. The rules themselves live in hub-nudge.mjs —
    // importing THIS file starts a server, so they cannot be asserted here.
    if (shouldNudge(req.method, upstream.status)) {
      // The writer's own id, echoed onto the frame so its socket can be skipped.
      const origin = String(req.headers['x-client-id'] || '');
      // `rev` is read off the response only when the body is small enough to be a
      // metadata reply. A document PUT echoes the whole document, and parsing
      // megabytes to learn one integer is worse than doing without it: the client
      // adopts the rev from the refetch this nudge already asks for.
      const rev =
        typeof upstream.text === 'string' && upstream.text.length <= 64 * 1024
          ? revOf(parseJsonOrNull(upstream.text))
          : null;
      nudgeHubChanged(collectionPath(hubPath), rev, origin);
    }
    return;
  }

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
      // Where a document can be framed from WITHOUT a sandbox, or '' when there
      // is no second origin. The app reads this to decide one thing only:
      // whether to ask for a ticket and drop `sandbox` on the frame. Empty is
      // the fully-sandboxed, unchanged behaviour.
      docOrigin: DOCS_ORIGIN,
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

    // The document BODY as TEXT — the readable view of a stored page.
    //
    // A route of its own beside /media, and for the same reason that one exists:
    // the body is fetched by the RELAY with the credential the app does not have,
    // and what goes back is a DERIVED value rather than the bytes, so the app's
    // model can read what a page says without a 4 MiB HTML document ever
    // entering a tool message. The raw body stays on /html, which is served
    // under the sandbox policy and read by a frame, not by a model.
    //
    // Callers that pass no `limit` get the WHOLE text, which is the ordinary
    // read: the app has to be able to hand its model a complete page to edit.
    const textMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})\/text$/.exec(url.pathname);
    if (req.method === 'GET' && textMatch) {
      try {
        const doc = await client.body(textMatch[1]);
        // Windowed EXACTLY as the tool path windows it, off the same helper, so
        // the app's model and the relay's agent cannot disagree about what a
        // given offset means or about which offset continues a split read.
        const w = bodyWindow(htmlToText(doc.text), {
          offset: url.searchParams.get('offset'),
          limit: url.searchParams.get('limit'),
        });
        json(res, 200, { ok: true, text: w.text, offset: w.offset, total: w.total, next: w.next, more: w.more });
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

    // A FRAME TICKET — proof that THIS relay authorised ONE document to be
    // framed, for ~2 minutes, for a caller that has already proved it is signed
    // in (requirePrincipal above ran before this branch).
    //
    // The frame URL must not carry the session token: the document can read
    // `location`, so putting the owner credential in the src would hand
    // agent-authored code the key to the whole store. The token never leaves
    // this process; the ticket is the only thing the browser sees.
    //
    // The document is NOT pre-checked against the gateway here. A ticket is
    // harmless on its own — the document origin re-reads the body through the
    // same credential and answers 502 for one that is gone — and a pre-check
    // would add a gateway round trip to every frame render.
    const ticketMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})\/ticket$/.exec(url.pathname);
    if (req.method === 'POST' && ticketMatch) {
      if (!DOCS_ORIGIN) {
        json(res, 501, {
          ok: false,
          code: 'no_doc_origin',
          error: 'no document origin is configured (set DOCS_ORIGIN)',
        });
        return;
      }
      json(res, 200, {
        ok: true,
        url: docFrameUrl(DOCS_ORIGIN, signDocTicket(ticketMatch[1], { secret: DOC_TICKET_SECRET })),
        ttlMs: DOC_TICKET_TTL_MS,
      });
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

    // ── Revision history ─────────────────────────────────────────────
    //
    // Three routes, because the gateway exposes three MCP tools here and NONE
    // had any way through the relay before: the app could publish a new version,
    // and could not see, read or return to an older one. The routes are ordered
    // most-specific-first so `/…/revisions/3/restore` is never parsed as a read
    // of revision 3.

    // Make an old REVISION current. This is NOT the same operation as the
    // `/restore` route above, and the two must not be merged: that one UNDOES a
    // soft delete through the gateway's REST surface, while this one is a real
    // MCP call that appends a `revert` revision. A revert therefore stays
    // undoable, which is why it is served here rather than behind a warning.
    const revertMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})\/revisions\/(\d{1,9})\/restore$/.exec(url.pathname);
    if (req.method === 'POST' && revertMatch) {
      let body = {};
      try {
        body = (await readJsonBody(req, 64 * 1024)) ?? {};
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      try {
        json(res, 200, {
          ok: true,
          document: await client.restoreRevision(revertMatch[1], Number(revertMatch[2]), {
            // Absent means TRUE, matching the gateway's own default: a revert is
            // normally a revert of the whole document, not just its pixels.
            restoreMetadata: body.restoreMetadata !== false,
            ifVersion: body.ifVersion,
          }),
        });
      } catch (err) {
        fail(err);
      }
      return;
    }

    // One revision's metadata. The body is deliberately NOT returned even though
    // the gateway can supply it: a stored document is code written by a model,
    // and the relay serves that code in exactly one place — the sandboxed /html
    // route above — never as a JSON field a client would then have to be careful
    // with. The frame already shows the wearer any revision they want to see.
    const oneRevMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})\/revisions\/(\d{1,9})$/.exec(url.pathname);
    if (req.method === 'GET' && oneRevMatch) {
      try {
        json(res, 200, {
          ok: true,
          revision: await client.revision(oneRevMatch[1], Number(oneRevMatch[2])),
        });
      } catch (err) {
        fail(err);
      }
      return;
    }

    // A document's change log. `change` filters by kind, so "what did an agent
    // DELETE" is one call rather than a scan the client would have to do.
    const historyMatch = /^\/api\/files\/([A-Za-z0-9_-]{1,64})\/revisions$/.exec(url.pathname);
    if (req.method === 'GET' && historyMatch) {
      try {
        const q = url.searchParams;
        const page = await client.revisions({
          id: historyMatch[1],
          change: q.get('change') || undefined,
          subject: q.get('subject') || undefined,
          order: q.get('order') || undefined,
          limit: q.get('limit') ?? undefined,
          offset: q.get('offset') ?? undefined,
        });
        json(res, 200, { ok: true, items: page.items, total: page.total, hasMore: page.hasMore });
      } catch (err) {
        fail(err);
      }
      return;
    }

    // Library totals, or one document's revision totals.
    //
    // THIS BRANCH MUST STAY ABOVE THE `:id` MATCH BELOW. `stats` is a perfectly
    // valid document id as far as that pattern is concerned, so putting this
    // after it would silently turn every stats request into a read of a document
    // called "stats" — a 404, not an error anyone would connect to route order.
    //
    // One route for two gateway tools, because they answer one question: with no
    // id the archive's totals are wanted (only `session_stats` knows those), and
    // with one, that document's revision totals (`revision_stats`). `revision_stats`
    // also reports archive-wide numbers, so the two overlap rather than conflict.
    if (req.method === 'GET' && url.pathname === '/api/files/stats') {
      try {
        const id = url.searchParams.get('id');
        json(res, 200, { ok: true, ...(await (id ? client.revisionStats(id) : client.stats())) });
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

    // EDIT a stored document in place.
    //
    // A PATCH on the single-document route rather than another POST, so it
    // cannot be confused with publish: publish mints a version from a
    // REPLACEMENT body, while this one can change the title or the tags alone
    // and leave the stored bytes exactly as they were. The gateway treats those
    // as different tools for that reason, and so does this.
    //
    // `ifVersion` is forwarded when the caller sends it, so an editor that read
    // a version can fail instead of clobbering a newer one.
    if (oneMatch && req.method === 'PATCH') {
      let body = null;
      try {
        body = await readJsonBody(req, FILES_MAX_BODY_BYTES);
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      try {
        const document = await client.update(oneMatch[1], {
          html: body?.html,
          title: body?.title,
          tags: body?.tags,
          agent: body?.agent,
          contentType: body?.contentType,
          ifVersion: body?.ifVersion,
        });
        json(res, 200, { ok: true, document });
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

// ── The document origin's own server ─────────────────────────────────────────
// Started only when DOC_LISTEN_PORT is set. It serves exactly ONE route and
// holds no session: the ticket in the path IS the whole authorisation, which is
// why this can sit on a host the app does not control — and why it sets no
// cookie, so the document it serves has no ambient authority to spend.
//
// A deployment on a host that exposes one port per process (Railway, Fly) runs
// this same file a second time with DOCS_ORIGIN set to its own public URL and
// DOC_LISTEN_PORT set to its own port. The two processes never share a listener;
// they share DOC_TICKET_SECRET, which is the only state the ticket needs.
function startDocServer(port) {
  const docServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const ticket = docTicketFromPath(url.pathname);
    if (ticket === null) {
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const verdict = verifyDocTicket(ticket, { secret: DOC_TICKET_SECRET });
    if (!verdict.ok) {
      // 410 for a ticket that was right but has aged out, so a reader can tell
      // "ask for another" apart from "that was never valid".
      json(res, verdict.reason === 'expired' ? 410 : 403, {
        ok: false,
        code: `ticket_${verdict.reason}`,
        error: `frame ticket ${verdict.reason}`,
      });
      return;
    }
    const { client, error } = filesRuntime();
    if (!client) {
      json(res, 501, { ok: false, error: `document store not configured — ${error}` });
      return;
    }
    try {
      const doc = await client.body(verdict.id);
      res.writeHead(200, docResponseHeaders(DOC_FRAME_ANCESTOR, doc.contentType));
      res.end(doc.text);
    } catch (err) {
      json(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  docServer.listen(port, () => {
    console.log(`[g2-hub]   Docs:  GET  ${DOCS_ORIGIN}/d/<ticket>`);
    console.log(`[g2-hub]          frame-ancestors: ${DOC_FRAME_ANCESTOR}`);
  });
  return docServer;
}

/**
 * The gateway operations the ONE `jarvis_files` tool folds into its `action`
 * enum, each mapped to the server tool that implements it.
 *
 * This map IS the contract between `filesToolSchema()` (what the model is told)
 * and the client that carries the call out — and it is exactly where the drift
 * lived: the schema offered `id` for delete while the client sent
 * `{ id, hard, reason }`, and the gateway accepted both. Nothing compared them,
 * because nothing had ever read the gateway's own catalogue.
 *
 * ALL ELEVEN, deliberately. The first version folded four, which left seven of
 * the gateway's tools with no schema at all: editing a document, its version
 * history, reading a past revision, reverting to one, searching, and both stats
 * calls were capabilities the model could not express. `checkFilesSchemaDrift()`
 * reports that as `unusedTools`, and it is now empty by construction.
 */
const FILES_FOLD = {
  publish: 'create_session',
  list: 'list_sessions',
  search: 'search_sessions',
  stats: 'session_stats',
  read: 'read_session',
  update: 'update_session',
  delete: 'delete_session',
  history: 'list_revisions',
  revision: 'read_revision',
  revert: 'restore_revision',
  revision_stats: 'revision_stats',
};

/**
 * The check the hand-written schema never had, run ONCE at boot.
 *
 * It reports in the two directions `diffParams` separates, because only one of
 * them is dangerous:
 *   • `missingOnServer` — we advertise a parameter the gateway does not define,
 *     so the model sends it and EVERY such call fails. That is a lie, and it is
 *     logged as an error.
 *   • `missingLocally` — the gateway defines a parameter we never offer. No call
 *     fails; a capability is merely UNREACHABLE. This is the `hard` case, and it
 *     is logged as a note.
 *
 * It also names the gateway tools the fold does not reference at all, which is a
 * capability that does not exist as far as the model is concerned.
 *
 * NEVER throws and never blocks boot: a gateway that is down, unconfigured or
 * out of scope must not stop the relay serving the app. Its whole output is the
 * log — which is more than the previous version produced, since it asked nothing.
 */
async function checkFilesSchemaDrift() {
  const { client } = filesRuntime();
  if (!client) return;
  try {
    // `catalogue()` unwraps `result.tools`; normalizeCatalogue() expects the
    // `{ tools }` envelope, so it is re-wrapped rather than second-guessed here.
    const remote = normalizeCatalogue({ tools: await client.catalogue() });
    if (!remote.length) {
      console.log('[g2-hub] jarvis_files schema check: the gateway listed no tools');
      return;
    }
    const { missingOnServer, missingLocally, unknownFoldedTools, unusedTools } = foldDrift({
      localProperties: filesToolSchema({}).function.parameters.properties,
      fold: FILES_FOLD,
      catalogue: remote,
    });
    // The one that is a LIE, so it is the one that shouts.
    if (missingOnServer.length) {
      console.error(
        '[g2-hub] jarvis_files SCHEMA LIE: the model is told to send '
          + `${missingOnServer.join(', ')}, which the gateway does not accept, so every such call fails`,
      );
    }
    if (unknownFoldedTools.length) {
      console.error(`[g2-hub] jarvis_files FOLD STALE: ${unknownFoldedTools.join(', ')} no longer exist on the gateway`);
    }
    if (missingLocally.length) {
      console.log(`[g2-hub] jarvis_files unreachable params: ${missingLocally.join(', ')}`);
    }
    if (unusedTools.length) {
      console.log(`[g2-hub] gateway tools with no schema here: ${unusedTools.join(', ')}`);
    }
    if (!missingOnServer.length && !missingLocally.length && !unknownFoldedTools.length && !unusedTools.length) {
      console.log(`[g2-hub] jarvis_files schema agrees with the gateway (${remote.length} tools)`);
    }
  } catch (err) {
    console.log(`[g2-hub] jarvis_files schema check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await loadPersistedState();

// Reconcile the auth store with the hub BEFORE the listener accepts anything.
// The file is ephemeral and this container may be brand new, so without this a
// perfectly valid token would 401 for a moment at boot — and the app's
// `onAuthRejected` path would sign the user straight out, which is the bug this
// change fixes, re-entering as a startup race. Bounded (5s), never throws, and
// it degrades to the file, so a hub that is down cannot break sign-in.
await authSync.reconcile();

server.listen(PORT, () => {
  console.log(`[g2-hub] relay on http://0.0.0.0:${PORT}`);
  console.log(`[g2-hub]   Web:   GET  http://localhost:${PORT}/`);
  console.log(`[g2-hub]   SSE:   GET  http://localhost:${PORT}/api/stream?channel=hub`);
  console.log(`[g2-hub]   State: POST http://localhost:${PORT}/api/stream`);
  if (DOC_LISTEN_PORT > 0) startDocServer(DOC_LISTEN_PORT);
  // Fire-and-forget: the drift check must never delay or fail the boot.
  void checkFilesSchemaDrift();
});
