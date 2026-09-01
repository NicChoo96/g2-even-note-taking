# G2 Even Reality Hub — Copilot Instructions

## Project Overview

**G2 Even Reality Hub** is a personal live-sync viewport for Even Realities **G2 smart glasses**.
Paste text/docs once on a **Vercel-hosted web app** → it is categorized into sections
(To-Do / Docs / Notes) → streamed **live into the glasses** over SSE → controlled with the
**R1 ring**.

There are two deployables in this repo:

| Folder | What it is | Stack |
|---|---|---|
| `web/` | Pasteboard web layer hosted on Vercel | React + Vite + TS, SSE broadcast, serverless API |
| `glasses/` | G2 glasses app loaded in the Even Hub WebView | Vite + TS + `@evenrealities/even_hub_sdk` |

## Everywhere-available G2 skills (installed globally)

The **everything-evenhub** skill set (13 skills) is installed personally at `~/.copilot/skills/`,
so it is available in every VS Code workspace. To make the skills travel with this repo instead
(or as well), copy the 13 skill folders from `~/.copilot/skills/` into `.github/skills/`.
Use them when working on the `glasses/` app:

| Skill | Invoke | Use for |
|---|---|---|
| quickstart | `/quickstart` | Scaffold a fresh G2 app |
| template | `/template` | Scaffold from a curated starter |
| glasses-ui | `/glasses-ui` | Building display UI on the 576×288 canvas |
| handle-input | `/handle-input` | Touchpad / R1 ring gestures & lifecycle |
| device-features | `/device-features` | Mic, IMU, storage, device info |
| test-with-simulator | `/test-with-simulator` | Run/debug in the desktop simulator |
| simulator-automation | `/simulator-automation` | Automate the simulator via HTTP API |
| font-measurement | `/font-measurement` | Pixel-accurate text sizing (LVGL) |
| background-state | `/background-state` | Persist state across background/foreground |
| sdk-reference | `/sdk-reference` | Look up SDK APIs/types |
| cli-reference | `/cli-reference` | evenhub CLI commands |
| build-and-deploy | `/build-and-deploy` | Package `.ehpk` & submit |
| design-guidelines | `/design-guidelines` | G2 UI/UX constraints |

These also auto-load when the model detects the relevant task (their `description` drives discovery).

## G2 Hardware Constraints (must always respect)

- Display: **576 × 288 px**, 4-bit greyscale (16 shades of green, `0`=off, `15`=brightest).
- No camera, no speaker. Connectivity via Bluetooth to the Even companion app (phone).
- Input: temple touchpads + optional **R1 ring** (same gesture set; detect via `sysEvent.eventSource`).
- Max **12 containers/page** (max 8 text/list, max 4 image). Exactly **one** container with `isEventCapture: 1`.
- Text container content limits: 1000 chars on create, 2000 chars via `textContainerUpgrade`.
- List items: max 20, max 64 chars each; lists rebuild the whole page to update.
- App manifest: `app.json` with `edition: "202601"`, `min_sdk_version: "0.0.12"`, `permissions` array.
- `network` permission requires a `whitelist` of allowed URLs — must include the SSE endpoint.

## Architecture & Data Flow

```
Web (Vercel)  --POST /api/state-->  [Vercel Serverless state store]
                                     |  broadcasts
                                     v
Glasses app (Even Hub WebView)  <--SSE /api/stream-->  EventSource
                                     |
                     EvenAppBridge (SDK) <-> Even companion app <-> G2 glasses
```

- Web app holds the single source of truth (`HubState`), persists to `localStorage` (and
  optionally Upstash Redis via env).
- Glasses app opens an `EventSource` to `/api/stream?channel=hub`, receives `state` events,
  and renders the active section.
- R1 ring → `sysEvent` with `eventSource === 2`; scroll gestures fire `textEvent`, presses fire `sysEvent`.
- Double-sync: web edits stream to glasses; glasses confirmations POST back to `/api/state`.

## Shared Protocol

```ts
type SectionId = 'todo' | 'docs' | 'notes';

interface TodoItem { id: string; text: string; done: boolean; }

interface HubState {
  activeSection: SectionId;
  sections: {
    todo: TodoItem[];
    docs: string;   // lightweight markdown-ish text
    notes: string;
  };
  updatedAt: number;
}
```

SSE event frames (JSON, `data:`):
- `{ "type": "init", "state": HubState }` — sent on connect
- `{ "type": "state", "state": HubState }` — full snapshot on every change

## R1 Ring Gesture Map (glasses app)

The contextual menu (SDK 0.0.14+ / Even App 2.2.9+) is the section switcher. The OS opens
it on **tap then long press** (it owns that gesture — your app never sees it); selections
arrive as `event.menuItemClickEvent` with the `itemID` you declared, **ignoring `isEventCapture`**.

| Gesture | Event | Action |
|---|---|---|
| Swipe up / down | `textEvent` 1 / 2 | Scroll active content (native) |
| Single press | `sysEvent` type 0 / `listEvent` | Select list item / confirm (To-Do toggle) |
| Double press | `sysEvent` type 3 | System exit dialog (canonical — not the menu) |
| Tap then long press | OS-owned | Opens the contextual menu (items: To-Do / Docs / Notes) |
| Menu selection | `menuItemClickEvent.itemID` | Switch section (fire-and-forget; menu closes) |

## Commands

- `web/`: `npm run dev` (Vite), `npm run dev:full` (local SSE + Vite), `npm run build`
- `glasses/`: `npm run dev`, `npm run simulate`, `npm run build`
- Deploy web: `vercel --prod` from `web/`; glasses: `npx @evenrealities/evenhub-cli qr --url <url>`

## Requirements Checklist (from spec)

- [x] Vercel frontend hosting (React)
- [x] SSE live data push (api/stream.mjs + local server)
- [x] Even Hub SDK integration in `glasses/`
- [x] Paste text → categorize into To-Do / Docs / Notes
- [x] Live stream to glasses
- [x] R1 ring: scroll, switch sections, confirm
- [x] Contextual menu (switch sections), expandable section registry
- [x] Bi-directional sync (web ↔ glasses)
- [x] Lightweight localStorage persistence
- [ ] Optional: cloud DB (Upstash Redis) for multi-device sync
- [ ] Optional: lightweight user auth
