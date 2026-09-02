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
import { sectionByMenuId, sectionMenu, sectionText } from './sections';
import { applyRemote, getState, seedIfEmpty, setConnStatus, subscribe, update } from './store';
import { mountUi } from './web/ui';

// ── Configuration ────────────────────────────────────────────────────────────
const MAX_UPGRADE_TEXT = 2000;
// Single full-canvas text container — the official template pattern.
const CONTAINER_ID = 1;
const CONTAINER_NAME = 'main';

/** Diagnostic logging only — the phone screen stays clean (just the web UI). */
function setStatus(line: string): void {
  console.log('[hub]', line);
}

async function main(): Promise<void> {
  // ONE app, ONE URL: render the companion web UI in any browser (including the
  // Even App WebView), then draw to the glasses via the SDK when the bridge is
  // available. The shared store keeps the UI and the glasses in sync.
  mountUi();

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

  let started = false; // createStartUpPageContainer called exactly once
  let renderedText = '';

  // createStartUpPageContainer is a ONE-SHOT call — coalesce + serialize renders
  // so create runs exactly once no matter how fast state changes arrive.
  let rendering = false;
  let pendingRender = false;

  async function renderGlasses(): Promise<void> {
    if (rendering) {
      pendingRender = true;
      return;
    }
    rendering = true;
    try {
      await doRender();
    } catch (err) {
      console.error('[hub] render error', err);
      setStatus(`⚠️ render error: ${String(err)}`);
    } finally {
      rendering = false;
      if (pendingRender) {
        pendingRender = false;
        await renderGlasses();
      }
    }
  }

  async function doRender(): Promise<void> {
    const text = sectionText(getState());
    const clipped =
      text.length <= MAX_UPGRADE_TEXT ? text : text.slice(0, MAX_UPGRADE_TEXT - 1) + '…';
    console.log('[hub] render', { started, section: getState().activeSection, len: clipped.length });

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
        new CreateStartUpPageContainer({
          containerTotalNum: 1,
          textObject: [container],
          // OS contextual menu (To-Do / Docs / Notes) — lives for the page's
          // lifetime; selections arrive as menuItemClickEvent.
          menuObject: sectionMenu(),
        }),
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
    if (clipped !== renderedText) {
      const ok = await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          containerName: CONTAINER_NAME,
          content: clipped,
        }),
      );
      console.log('[hub] textContainerUpgrade ->', ok);
      if (ok) renderedText = clipped;
    }
  }

  // Any state change (UI edit or remote frame) re-renders the glasses.
  subscribe(() => {
    void renderGlasses();
  });

  // R1 ring / touchpad: double-tap exits; foreground re-renders.
  const unsubscribeEvents = bridge.onEvenHubEvent(async (event) => {
    // OS contextual menu selection -> switch section (UI + glasses + all devices).
    if (event.menuItemClickEvent) {
      const def = sectionByMenuId(event.menuItemClickEvent.itemID ?? 0);
      if (def) {
        console.log('[hub] menu ->', def.id);
        update((s) => ({ ...s, activeSection: def.id }));
      }
      return;
    }

    const sysType = event.sysEvent?.eventType;
    console.log('[hub] sys event', sysType);
    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      await bridge.shutDownPageContainer(1);
      return;
    }
    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      void renderGlasses();
      return;
    }
    if (sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT || sysType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
      unsubscribeEvents();
      closeStream();
    }
  });

  // Live stream: the source of truth shared by the UI and the glasses.
  const closeStream = connectStream({
    onState: (next) => applyRemote(next),
    onStatus: (s) => {
      setStatus(`📡 SSE ${s}`);
      setConnStatus(s);
    },
  });

  // Boot render + seed the server from local data if it's empty.
  await renderGlasses();
  window.setTimeout(() => seedIfEmpty(), 2000);
}

void main();
