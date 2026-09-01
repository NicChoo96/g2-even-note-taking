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
//
// Zero runtime dependencies (node built-ins only). Run:
//   node server/local-sse.mjs          (default port 5174)
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 5174);
// Built unified app (companion web UI + glasses) — served at the bare root.
const GLASSES_DIST = fileURLToPath(new URL('../glasses-dist', import.meta.url));
// Last-known state is mirrored to disk so a Railway/Fly/Render restart does not
// wipe the data. Override the path with STATE_FILE for a persistent volume.
const STATE_FILE = process.env.STATE_FILE || join(process.cwd(), '.g2-hub-state.json');

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

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const channel = getChannel(url.searchParams.get('channel') || 'hub');

  // SSE stream (glasses app / any device subscriber) — long-lived.
  if (req.method === 'GET' && url.pathname === '/api/stream') {
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

  // Publish a HubState snapshot + broadcast to ALL connected devices.
  if (req.method === 'POST' && url.pathname === '/api/stream') {
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

await loadPersistedState();

server.listen(PORT, () => {
  console.log(`[g2-hub] relay on http://0.0.0.0:${PORT}`);
  console.log(`[g2-hub]   Web:   GET  http://localhost:${PORT}/`);
  console.log(`[g2-hub]   SSE:   GET  http://localhost:${PORT}/api/stream?channel=hub`);
  console.log(`[g2-hub]   State: POST http://localhost:${PORT}/api/stream`);
});
