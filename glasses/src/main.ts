import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { connectStream } from './stream';
import { sectionText } from './sections';
import { emptyHubState, type HubState } from './types';

// ── Configuration ────────────────────────────────────────────────────────────
// Same-origin by default: when the deployed glasses app is served by the relay
// (at /glasses/ on the same host), this resolves to the live SSE stream next to
// it. Local dev overrides via VITE_HUB_STREAM_URL in .env.local.
const STREAM_URL: string =
  (import.meta.env.VITE_HUB_STREAM_URL as string | undefined) ??
  '/api/stream?channel=hub';
const MAX_UPGRADE_TEXT = 2000;

// Single full-canvas text container — the official template pattern.
const CONTAINER_ID = 1;
const CONTAINER_NAME = 'main';

/** Append a visible line to the WebView status panel (shows on the phone in the Even App browser). */
function setStatus(line: string): void {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = el.textContent ? `${el.textContent}\n${line}` : line;
  }
  console.log('[hub]', line);
}

async function main(): Promise<void> {
  setStatus('⌛ waiting for EvenAppBridge…');
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  setStatus('✅ EvenAppBridge ready');
  console.log('[hub] bridge ready');

  try {
    const dev = await bridge.getDeviceInfo();
    setStatus(
      `👓 device: ${dev ? `${dev.model} · ${dev.status?.connectType ?? 'unknown'}` : 'none detected'}`,
    );
  } catch {
    setStatus('👓 device info unavailable');
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let state: HubState = emptyHubState();
  let started = false; // createStartUpPageContainer called exactly once
  let renderedText = '';

  // ── Rendering ──────────────────────────────────────────────────────────────
  // createStartUpPageContainer is a ONE-SHOT call — a second concurrent call is
  // rejected by the host (returns 1 = invalid). SSE frames can arrive during
  // boot, so coalesce + serialize renders to guarantee create runs exactly once.
  let rendering = false;
  let pendingRender: { force?: boolean } | null = null;

  async function render(opts: { force?: boolean } = {}): Promise<void> {
    if (rendering) {
      pendingRender = opts;
      return;
    }
    rendering = true;
    try {
      await doRender(opts);
    } catch (err) {
      console.error('[hub] render error', err);
      setStatus(`⚠️ render error: ${String(err)}`);
    } finally {
      rendering = false;
      if (pendingRender) {
        const next = pendingRender;
        pendingRender = null;
        await render(next);
      }
    }
  }

  async function doRender(opts: { force?: boolean } = {}): Promise<void> {
    const text = sectionText(state);
    const clipped =
      text.length <= MAX_UPGRADE_TEXT ? text : text.slice(0, MAX_UPGRADE_TEXT - 1) + '…';
    console.log('[hub] render', {
      started,
      section: state.activeSection,
      force: opts.force,
      len: clipped.length,
    });

    if (!started) {
      // ONE full-canvas text container — exactly like the official minimal template.
      const container = new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        isEventCapture: 1,
        content: clipped,
      });
      const res = await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [container] }),
      );
      console.log('[hub] createStartUpPageContainer ->', res);
      setStatus(
        `🖼 createStartUpPageContainer -> ${res}${res === StartUpPageCreateResult.success ? '' : ' (REJECTED — nothing will draw on glasses)'}`,
      );
      started = res === StartUpPageCreateResult.success;
      if (!started) console.log('[hub] WARNING: startup page rejected');
      return;
    }

    // Already created — update the text in place (flicker-free, like text-heavy).
    if (clipped !== renderedText || opts.force) {
      const ok = await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          containerName: CONTAINER_NAME,
          content: clipped,
        }),
      );
      console.log('[hub] textContainerUpgrade ->', ok);
      if (ok || opts.force) renderedText = clipped;
    }
  }

  // ── R1 ring / touchpad input ───────────────────────────────────────────────
  // Ring swipes and presses produce the SAME SDK events as the temple touchpads
  // (textEvent scroll, listEvent selection, sysEvent click/double-click), so
  // hands-free control works with either input. To react differently per device,
  // check `event.sysEvent?.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING`.

  const unsubscribeEvents = bridge.onEvenHubEvent(async (event) => {
    const sysType = event.sysEvent?.eventType;
    console.log('[hub] sys event', sysType);
    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      await bridge.shutDownPageContainer(1);
      return;
    }
    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      await render();
      return;
    }
    if (sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT || sysType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
      unsubscribeEvents();
      closeStream();
    }
  });

  // ── Live stream from the web layer ─────────────────────────────────────────
  const closeStream = connectStream(STREAM_URL, {
    onState: (next) => {
      state = next;
      state.updatedAt = next.updatedAt ?? Date.now();
      void render();
    },
    onStatus: (s) => {
      setStatus(`📡 SSE ${s}`);
    },
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  await render();
}

void main();
