# 🥽 G2 Even Reality Hub

A personal live-sync viewport for **Even Realities G2 smart glasses**.
Paste text/docs once on the web → it gets categorized into sections → streams **live into
your glasses** via SSE → you control everything hands-free with the **R1 ring**.

```
Paste on web  →  categorize (To-Do / Docs / Notes)  →  SSE stream  →  glasses  →  R1 ring control
```

## Repository Layout

```
g2-even-reality-hub/
├── AGENTS.md              # Copilot project instructions + G2 skill pointers
├── README.md
├── docs/
│   └── architecture.md    # Architecture + data-flow diagram
├── glasses/               # G2 glasses app (Even Hub WebView) — Vite + TS + SDK
└── web/                   # Vercel web layer — React + Vite + SSE
```

## Quick Start

### 1. Web layer (Vercel)

```bash
cd web
npm install

# Local full-stack dev (SSE server + Vite frontend, no Vercel needed)
npm run dev:full          # -> http://localhost:5173

# Or use Vercel CLI
npx vercel dev
```

### 2. Glasses app

```bash
cd glasses
npm install
npm run simulate          # desktop Even Hub simulator
npm run dev               # Vite dev server (for real glasses via QR)
npx @evenrealities/evenhub-cli qr --url http://<your-ip>:5173
```

Set the SSE endpoint in `glasses/.env.local`:

```env
VITE_HUB_STREAM_URL=https://<your-vercel-app>.vercel.app/api/stream?channel=hub
```

For local testing point it at your local SSE server (see `web/server/local-sse.mjs`).

## Features

| # | Feature | Where |
|---|---|---|
| 1 | To-Do list (add / edit / remove / toggle) | `web/`, `glasses/` |
| 2 | Live Docs stream (paste → scrollable text) | `web/`, `glasses/` |
| 3 | Contextual menu (switch sections) | `glasses/` |
| 4 | Double-sync text box (bi-directional web ↔ glasses) | `web/`, `glasses/` |
| 5 | R1 ring: scroll, switch sections, confirm | `glasses/` |
| 6 | Auto-categorization tags (To-Do / Docs / Notes) | `web/` |
| 7 | localStorage persistence | `web/` |

## Deploying to Vercel (git-based)

The **web layer** (`web/`) is what deploys to Vercel. The `glasses/` app is a separate Even Hub
package (`.ehpk`) and is **not** deployed to Vercel — but it connects to your deployed
`/api/stream` endpoint for live sync.

### 1. Push this repo to GitHub

```bash
# create an empty repo on github.com first (e.g. "g2-even-reality-hub"), then:
git remote add origin https://github.com/<you>/g2-even-reality-hub.git
git push -u origin master
```

### 2. Import into Vercel

1. Open https://vercel.com/new and **Import** the GitHub repo.
2. In **Root Directory**, select **`web`** — this is the deployable app
   (the `glasses/`, `docs/`, `AGENTS.md` etc. stay in the repo but aren't deployed).
3. Vercel auto-detects **Vite** → framework preset. Build command stays `npm run build`
   (runs `tsc --noEmit && vite build`), output dir `dist`.
4. **Deploy.** The serverless function `web/api/stream.mjs` is picked up automatically.

After deploy you get `https://<your-app>.vercel.app`.

### 3. Point the glasses app at it

```bash
cd glasses
cp .env.example .env.local   # then set:
#   VITE_HUB_STREAM_URL=https://<your-app>.vercel.app/api/stream?channel=hub
```

Also add your deployed URL to the `network` permission `whitelist` in `glasses/app.json`
so the packaged app is allowed to reach it.

> ⚠️ **SSE on serverless:** Vercel serverless functions have a max duration (10s on Hobby,
> 60s on Pro). Long-lived SSE connections get cut off periodically, but the glasses app's
> `EventSource` auto-reconnects and re-receives the latest state — so it degrades to
> ~near-polling rather than breaking. For always-on streaming, host `web/server/local-sse.mjs`
> on a persistent runtime, or add Upstash Redis (`REDIS_REST_URL` + `REDIS_REST_TOKEN`) and
> extend the function duration.

### Alternative: Vercel CLI (no GitHub needed)

```bash
cd web
npx vercel --prod
```

### What the web layer deploys

- `api/stream.mjs` — single serverless function: `GET` = SSE stream (glasses app subscribes),
  `POST` = publish `HubState` + broadcast to connected clients (CORS enabled)
- React + Vite frontend (pasteboard UI, localStorage source of truth)
- Optional persistence: Upstash Redis via `REDIS_REST_URL` / `REDIS_REST_TOKEN` (for
  multi-device/collab sync across serverless instances)

## Persistent Relay — true live sync on all devices (recommended)

Vercel serverless is ephemeral, so "live on all devices **at the same time**" is more reliable
from a **single always-on process** that serves the web UI **and** the SSE stream together.

`web/server/local-sse.mjs` is that process (zero runtime dependencies). It serves:
- the built web app from `web/dist/` (SPA fallback), and
- `/api/stream` (GET = SSE, POST = state broadcast) on the same origin.

### Run it locally

```bash
cd web
npm run build        # produce dist/
npm start            # → http://localhost:5174  (web UI + live stream together)
```

### Deploy it (pick one free host)

| Host | Steps |
|---|---|
| **Railway** | New Project → Deploy from GitHub repo → set Root Directory `web` → Railway reads the `Procfile`/`Dockerfile` and starts `node server/local-sse.mjs`. |
| **Render** | New Web Service → repo → Root Directory `web` → Build `npm run build` → Start `node server/local-sse.mjs`. |
| **Fly.io** | `cd web && fly launch` (uses the included `Dockerfile`). |

All three give you a stable `https://<your-app>.up.railway.app`-style URL.

### Point the glasses at the relay

```bash
cd glasses
# .env.local:
#   VITE_HUB_STREAM_URL=https://<your-relay-host>/api/stream?channel=hub
```
And add the relay domain to the `network` whitelist in `glasses/app.json`.

Now every device — phone browser, desktop, and the glasses (via the Even App WebView) — connects
to the **same live stream**, so edits appear on all of them simultaneously.

## Packaging the Glasses App

```bash
cd glasses
npm run build
npx evenhub pack app.json dist -o g2-even-reality-hub.ehpk
```

Submit the `.ehpk` to the Even Hub developer portal, or load via QR for personal use.

## Copilot Skills

The **everything-evenhub** skill set (13 skills) is installed globally at `~/.copilot/skills/`.
Use `/glasses-ui`, `/handle-input`, `/sdk-reference`, `/test-with-simulator`, `/build-and-deploy`,
etc. while working on `glasses/`. See `AGENTS.md`.
