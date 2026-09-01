// Local full-stack SSE + state server — no Vercel needed for development.
//
//   GET  /api/stream?channel=hub  -> SSE stream (the glasses app connects here)
//   POST /api/stream              -> publish HubState + broadcast to SSE clients
//
// Run standalone:  node server/local-sse.mjs   (default port 5174)
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 5174);

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

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const channel = getChannel(url.searchParams.get('channel') || 'hub');

  // SSE stream (glasses app / any subscriber)
  if (req.method === 'GET') {
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

  // Publish a HubState snapshot and broadcast to all SSE clients
  if (req.method === 'POST') {
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

  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[g2-hub] SSE + state server on http://localhost:${PORT}`);
  console.log(`[g2-hub]   SSE:   GET  http://localhost:${PORT}/api/stream?channel=hub`);
  console.log(`[g2-hub]   State: POST http://localhost:${PORT}/api/stream`);
});
