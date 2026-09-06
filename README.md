# 🥽 G2 Even Reality Hub

A personal live-sync viewport for **Even Realities G2 smart glasses**.
Paste/docs/voice text once on the web → it is categorized into sections → streams
**live into your glasses** via SSE → you control everything hands-free with the
**R1 ring** (and can dictate with your voice).

```
Web/voice  →  categorize (To-Do / Docs / Notes)  →  SSE stream  →  glasses  →  R1 ring control
```

> **ONE unified app.** The same codebase and the same URL serve BOTH the companion
> web UI (any browser) **and** the G2 glasses renderer (when opened inside the
> Even App). One persistent Node relay hosts everything — no serverless split.

## Repository Layout

```
g2-even-reality-hub/
├── AGENTS.md              # Copilot project instructions + G2 skill pointers
├── README.md
├── docs/
│   └── architecture.md    # Architecture + data-flow diagram
├── glasses/               # THE app — Vite + TS + @evenrealities/even_hub_sdk
│   │                       #   → web UI lives in glasses/src/web/ (App.tsx)
│   │                       #   → glasses renderer in glasses/src/main.ts
│   └── dist/              # built output (web UI + glasses, app.json copied in)
├── web/
│   ├── server/local-sse.mjs   # the relay — zero-dependency Node server
│   └── glasses-dist/          # staging of glasses/dist served by the relay
├── Dockerfile             # root deploy target → Railway / Render / Fly.io
└── render.yaml            # Render blueprint (same Dockerfile)
```

The deployable artifact is the **glasses build**. `web/` only provides the relay
server that serves it plus the SSE/state/auth/STT APIs. (Older `web/`-only Vercel
files — `web/api`, `web/src`, `vercel.json` — still exist in the tree but are
**not used anymore**.)

## Features

| # | Feature | Where |
|---|---|---|
| 1 | To-Do list (add / edit / remove / toggle) | web + glasses |
| 2 | **Multi-doc library** (named docs, auto-saved, pickable on glasses) | web + glasses |
| 3 | Notes double-sync box (bi-directional web ↔ glasses) | web + glasses |
| 4 | Live SSE stream (docs/notes stream into the glasses) | web + glasses |
| 5 | **Voice dictation** on any text box (browser speech + glasses/phone mic) | web + glasses |
| 6 | Contextual menu + in-app picker (switch / new / select / delete doc) | glasses |
| 7 | R1 ring: scroll, cursor nav, toggle, confirm | glasses |
| 8 | Auto-categorization tags (To-Do / Docs / Notes) | web |
| 9 | Full-screen paging on the glasses (LVGL-accurate pagination) | glasses |
| 10 | Per-device pairing + owner Google Sign-In (no anonymous access) | web + glasses |

## Quick Start (local full-stack dev)

The whole app is built from `glasses/` and served by the relay in `web/`.

```bash
# 1) Install + build the app (builds dist/ and copies app.json into it)
cd glasses
npm install
npm run build:deploy

# 2) Stage the build where the relay serves it
cd ../web
rm -rf glasses-dist && cp -r ../glasses/dist ./glasses-dist

# 3) Run the relay (serves the UI + /api/stream + auth + STT on one origin)
PORT=5198 node server/local-sse.mjs
#    → open http://127.0.0.1:5198/ in a browser (owner dashboard)
```

Optionally point the build at a specific stream origin with `glasses/.env.local`:

```env
# Local relay / simulator:
VITE_HUB_STREAM_URL=http://127.0.0.1:5198/api/stream?channel=hub
# Production (your Railway app):
# VITE_HUB_STREAM_URL=https://<your-app>.up.railway.app/api/stream?channel=hub
```

If `VITE_HUB_STREAM_URL` is unset, the app defaults to the **same-origin**
`/api/stream?channel=hub`, which is correct when the relay serves the app — so
production builds need no `.env.local` at all.

### Even Hub simulator (no glasses needed)

```bash
cd glasses
npx evenhub-simulator --automation-port 9898 http://127.0.0.1:5198/
```

The simulator loads the same URL as the phone's Even App. Authorize a "device"
from the web dashboard's **Devices** panel (paste the pairing code shown on the
simulator), then the glasses viewport and the R1-ring inputs work against the
local relay.

## Deploying to Railway (recommended)

Railway auto-detects the **root `Dockerfile`** (builds `glasses/`, serves it with
`web/server/local-sse.mjs`). No serverless, no Vercel.

1. Push this repo to GitHub.
2. On Railway: **New Project → Deploy from GitHub repo** → select the repo → done
   (it reads the root `Dockerfile`; no root-directory override needed).
3. Set the variables below.
4. Deploy → you get `https://<your-app>.up.railway.app` — the web dashboard **and**
   the glasses stream live on that one origin.

> Node 22+ is required (the relay's live-STT path uses Node's global WebSocket
> client). The Dockerfile already uses `node:22-alpine`.

### Environment variables (Railway → Variables)

| Variable | Required | Value |
|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | `xxxx.apps.googleusercontent.com` (see Auth section) |
| `ALLOWED_EMAILS` | ✅ | your Google email(s), comma-separated |
| `AUTH_FILE` | ⚠️ recommended | **path on a persistent volume**, e.g. `/data/.g2-hub-auth.json` |
| `STATE_FILE` | ⚠️ recommended | **path on a persistent volume**, e.g. `/data/.g2-hub-state.json` |
| `DEEPGRAM_API_KEY` | for glasses voice | live + batch STT (Nova-3) |
| `OPENAI_API_KEY` | alternative for voice | Whisper batch STT if no Deepgram |
| `DEEPGRAM_MODEL` | no | default `nova-3` |
| `DEEPGRAM_LANG` | no | default `en` |

> **Important:** mount a **Railway Volume** and set `AUTH_FILE` (+ `STATE_FILE`) to a
> path on it. Without that, owner sessions and approved devices live on the
> container's ephemeral disk and **reset on every redeploy** (you would have to sign
> in and re-approve glasses each time). The web UI now detects a stale session and
> sends you back to the login screen instead of a misleading "Offline" state.

### Other hosts

The root `Dockerfile` + `render.yaml` also work on **Render** (New Blueprint) and
**Fly.io** (`fly launch`). Everything below assumes a Railway-style `https://<app>`
origin.

## Pointing the glasses (Even App) at your deployment

The glasses app is a normal Even Hub web app: open your deployed URL inside the
**Even App**, or sideload the packaged `.ehpk` (below). The `network` permission
`whitelist` in `glasses/app.json` already includes the Railway domain, a Vercel
domain, and local hosts — add your own domain if you deploy elsewhere.

## Packaging the Glasses App (.ehpk)

The build already drops `app.json` into `dist/`, so packaging is:

```bash
cd glasses
npm run build:deploy                       # tsc + vite build (bakes app.json)
npx evenhub pack app.json dist -o reality-hub.ehpk --sdk-ver 0.0.14
```

- The pack step stamps the app version/SDK (`min_app_version 2.2.9` for SDK
  0.0.14) and validates `app.json`.
- Keep `glasses/app.json` `version` in sync (currently `0.1.2`).
- For personal use, load via QR / the Even Hub portal; submit the `.ehpk` to the
  Even Hub developer portal for wider distribution.

## Voice Dictation (speech-to-text)

A reusable `<MicButton>` sits next to every text box (paste box, todo adder, doc
editor, notes). It picks the right mic and engine automatically:

- **Browser (PC or phone web)** — requests the browser mic (`getUserMedia`) and
  prefers the free built-in **Web Speech API**; if the browser speech service is
  unavailable it falls back to server transcription. Mobile (iOS) is handled by
  requesting permission inside the tap gesture.
- **G2 glasses (Even App)** — uses the **glasses mic** via the SDK bridge
  (`audioControl`, needs the startup page created), falling back to the **phone
  mic**, then the WebView mic. Deepgram gets **live streaming** (interim words as
  you speak); otherwise a record-then-upload batch path is used.
- **Keys stay server-side** (`DEEPGRAM_API_KEY` / `OPENAI_API_KEY`) — nothing is
  shipped in the client bundle. Mic permissions are declared in `glasses/app.json`
  (`g2-microphone`, `phone-microphone`).

## Authentication (Google Sign-In + per-device pairing)

There is **no anonymous access**. Both ends must be authorized:

- **Web control app (browser)** — Google Sign-In restricted to your whitelisted
  email. The relay issues a per-session token the browser sends with every request.
  `GET /api/auth/me` lets the app validate a stored session at boot.
- **Glasses device (Even App WebView)** — generates its own per-device ID, shows a
  6-char **pairing code**, and the owner approves it from the logged-in web app.
  Each device is individually approved — no shared device login; unpaired or
  revoked devices get `401`.

### 1. Create a Google OAuth Client ID

1. https://console.cloud.google.com → create/select a project.
2. **APIs & Services → OAuth consent screen** → External → app name + your email.
   Add your Google account as a **Test user** (or publish).
3. **Credentials → + Create Credentials → OAuth client ID → Web application**.
4. **Authorized JavaScript origins** (exact origin, no trailing slash):
   - `https://<your-app>.up.railway.app`
   - `http://127.0.0.1:5198` and `http://localhost:5175` (local dev)
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

### 2. Local dev env

```bash
GOOGLE_CLIENT_ID="xxxx.apps.googleusercontent.com" \
ALLOWED_EMAILS="you@gmail.com" \
node web/server/local-sse.mjs
```

Owner sessions and approved devices are stored in `.g2-hub-auth.json`
(git-ignored) unless `AUTH_FILE` points elsewhere.

### 3. Pairing flow

1. Open the hub URL in the **Even App** on your phone → the device shows a
   6-character code on the phone screen.
2. Open the same URL in a **browser**, sign in with your Google account.
3. In the **Devices** panel, enter the code and press **Approve**.
4. The device connects and starts drawing to the glasses.

Both the browser and every approved glasses device see the same live stream.

## Copilot Skills

The **everything-evenhub** skill set (13 skills) is installed globally at
`~/.copilot/skills/`. Use `/glasses-ui`, `/handle-input`, `/sdk-reference`,
`/test-with-simulator`, `/build-and-deploy`, `/device-features`, etc. while
working on `glasses/`. See `AGENTS.md`.
