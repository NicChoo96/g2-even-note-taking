// Persistent G2 Even Reality Hub relay — ONE always-on process that serves BOTH
// the built web app (from dist/) and the live SSE/state stream. This is the
// "live always, all devices at the same time" backend for Railway/Fly/Render.
//
//   GET  /api/stream?channel=hub  -> SSE stream (the glasses app connects here)
//   POST /api/stream              -> publish HubState + broadcast to SSE clients
//   GET  /                        -> serves the built web app (SPA fallback)
//
// Zero runtime dependencies (node built-ins only). Run:
//   node server/local-sse.mjs          (default port 5174)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 5174);
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

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

// channel -> { clients: Set<res>, lastState: object | null }
const channels = new Map();

function getChannel(name) {
  if (!channels.has(name)) channels.set(name, { clients: new Set(), lastState: null });
  return channels.get(name);
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

/** Serve a file from dist/ with a safe index.html fallback (SPA routing). */
async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let filePath = join(DIST, normalize(pathname).replace(/^([/\\])+/, ''));

  // Path-traversal guard: resolved path must stay inside dist/.
  if (relative(DIST, filePath).startsWith('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST, 'index.html');
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
    const frame = { type: 'state', state };
    for (const client of [...channel.clients]) send(client, frame);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: channel.clients.size }));
    return;
  }

  // Everything else: serve the built web app (SPA fallback to index.html).
  if (req.method === 'GET') {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[g2-hub] relay on http://0.0.0.0:${PORT}`);
  console.log(`[g2-hub]   Web:   GET  http://localhost:${PORT}/`);
  console.log(`[g2-hub]   SSE:   GET  http://localhost:${PORT}/api/stream?channel=hub`);
  console.log(`[g2-hub]   State: POST http://localhost:${PORT}/api/stream`);
});
