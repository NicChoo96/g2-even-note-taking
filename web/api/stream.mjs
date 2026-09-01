// Vercel serverless function — a single function serves both roles so the
// in-process state and SSE clients share memory within one warm instance:
//
//   GET  /api/stream?channel=hub  -> SSE stream (the glasses app connects here)
//   POST /api/stream              -> publish HubState + broadcast to SSE clients
//
// Notes:
//  - Works out of the box for a personal single-user hub (single warm instance).
//  - Serverless functions have a max duration (10s on Hobby, 60s on Pro/Team),
//    so long-lived SSE connections may be cut off. EventSource auto-reconnects
//    and receives an `init` snapshot, so the app degrades gracefully to polling.
//    For always-on streaming, use web/server/local-sse.mjs or a persistent host.
//  - For multi-instance / collaboration, wire channel.lastState to Upstash Redis
//    (REDIS_REST_URL + REDIS_REST_TOKEN) instead of the in-memory map below.

const channels = new Map(); // channel -> { clients: Set<res>, lastState: object | null }

function getChannel(name) {
  if (!channels.has(name)) channels.set(name, { clients: new Set(), lastState: null });
  return channels.get(name);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const url = new URL(req.url, 'http://x');
  const channel = getChannel(url.searchParams.get('channel') || 'hub');

  // SSE stream
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    channel.clients.add(res);
    if (channel.lastState) {
      res.write(`data: ${JSON.stringify({ type: 'init', state: channel.lastState })}\n\n`);
    }
    req.on('close', () => channel.clients.delete(res));
    return;
  }

  // Publish a HubState snapshot + broadcast
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let state;
    try {
      state = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'invalid JSON' });
      return;
    }
    channel.lastState = state;
    const frame = `data: ${JSON.stringify({ type: 'state', state })}\n\n`;
    for (const client of [...channel.clients]) {
      try {
        client.write(frame);
      } catch {
        channel.clients.delete(client);
      }
    }
    res.status(200).json({ ok: true, clients: channel.clients.size });
    return;
  }

  res.status(405).end();
}
