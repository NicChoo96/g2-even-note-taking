// Persistent G2 Even Reality Hub relay — ONE always-on process that serves the
// UNIFIED app and the live SSE/state stream. This is the "live always, all
// devices at the same time" backend for Railway/Fly/Render.
//
//   GET  /api/stream?channel=hub  -> SSE stream (the app + glasses connect here)
//   POST /api/stream              -> publish HubState + broadcast to SSE clients
//   GET  /                        -> serves the unified app (glasses-dist): the
//                                     companion web UI in any browser, AND the
//                                     SDK that draws to the G2 in the Even App
//   GET  /app.json                -> app manifest (Even App recognition)
//   GET  /api/config              -> { googleClientId } for the login button
//   POST /api/auth/verify         -> Google ID token -> owner session token
//   POST /api/auth/logout         -> revoke an owner session
//   POST /api/pair/request        -> device self-registers (returns pair code)
//   GET  /api/pair/status         -> device polls until the owner approves
//   POST /api/pair/approve        -> owner (session) approves a pair code
//   GET  /api/devices             -> owner lists approved devices
//   POST /api/pair/revoke         -> owner revokes a device
//   GET  /api/stt/status          -> is a speech provider configured?
//   POST /api/stt                 -> raw audio bytes -> transcribed text
//                                     (auth required; key stays server-side)
//
// SECURITY: /api/stream (GET + POST) requires a valid owner session token OR an
// approved per-device ID. Browsers authenticate via Google SSO; each glasses
// device gets its own unguessable deviceId that the owner approves from a
// logged-in browser. There is NO anonymous read of the stream and NO shared
// device login. /api/stt is protected the same way so randos can't spend your
// speech-provider key.
//
// Env: PORT, STATE_FILE, AUTH_FILE, GOOGLE_CLIENT_ID, ALLOWED_EMAILS
// (comma-separated), OPENAI_API_KEY (Whisper) or DEEPGRAM_API_KEY (Nova-2) for
// voice dictation. Zero runtime dependencies (node built-ins only). Run:
//   node server/local-sse.mjs          (default port 5174)
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicKey, createVerify, randomBytes, createHash } from 'node:crypto';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      if (lastState) getChannel(name).lastState = lastState;
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
    for (const [ch, info] of channels) data[ch] = info.lastState ?? null;
    await writeFile(STATE_FILE, JSON.stringify(data, null, 2));
  } catch {
    /* disk may be read-only on some hosts — in-memory broadcast still works */
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(client, frame) {
  try {
    client.write(`data: ${JSON.stringify(frame)}\n\n`);
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
    channel.lastState = state;
    void persistState(channel.name, state);
    const frame = { type: 'state', state };
    for (const client of [...channel.clients]) send(client, frame);
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
    channel.clients.add(res);
    if (channel.lastState) send(res, { type: 'init', state: channel.lastState });
    req.on('close', () => channel.clients.delete(res));
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
  } catch (err) {
    console.error('[g2-hub] deepgram ws error:', err);
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
    console.log('[g2-hub] deepgram live: open');
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
    console.log(`[g2-hub] deepgram live: closed (code=${ev?.code ?? '?'})`);
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
