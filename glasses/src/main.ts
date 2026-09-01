import {
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { connectStream } from './stream';
import { buildPage, buildStartupPage, CONTENT_ID, CONTENT_NAME, SECTIONS } from './sections';
import { emptyHubState, type HubState, type SectionId } from './types';

// ── Configuration ────────────────────────────────────────────────────────────
const STREAM_URL: string =
  (import.meta.env.VITE_HUB_STREAM_URL as string | undefined) ??
  'http://localhost:5174/api/stream?channel=hub';
const STATE_API = STREAM_URL.replace('/api/stream', '/api/state');
const LS_KEY = 'hub:state';
const MAX_UPGRADE_TEXT = 2000;

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
  let renderedSection: SectionId | null = null;
  let renderedText = '';

  // ── Persistence (companion app local storage) ──────────────────────────────
  async function cacheState(): Promise<void> {
    try {
      await bridge.setLocalStorage(LS_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

  async function restoreState(): Promise<void> {
    try {
      const raw = await bridge.getLocalStorage(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<HubState>;
      if (parsed?.sections) state = { ...emptyHubState(), ...parsed };
    } catch {
      /* ignore */
    }
  }

  // ── Double-sync: glasses -> web ────────────────────────────────────────────
  async function pushState(): Promise<void> {
    try {
      await fetch(STATE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch {
      /* offline — the web layer will re-push on the next SSE update */
    }
  }

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
    const section = state.activeSection;
    const isTextSection = section !== 'todo';
    console.log('[hub] render', { section, started, isTextSection, force: opts.force });

    // Live in-place text update while staying on the same text section.
    if (!opts.force && started && renderedSection === section && isTextSection) {
      const text = section === 'docs' ? state.sections.docs : state.sections.notes;
      const clipped =
        text.length <= MAX_UPGRADE_TEXT ? text : text.slice(0, MAX_UPGRADE_TEXT - 1) + '…';
      if (clipped !== renderedText) {
        const ok = await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: CONTENT_ID,
            containerName: CONTENT_NAME,
            content: clipped,
          }),
        );
        if (ok) {
          renderedText = clipped;
          return;
        }
        // fall through to a full rebuild on failure
      } else {
        return;
      }
    }

    if (!started) {
      const res = await bridge.createStartUpPageContainer(buildStartupPage(state));
      console.log('[hub] createStartUpPageContainer ->', res);
      setStatus(
        `🖼 createStartUpPageContainer -> ${res}${res === StartUpPageCreateResult.success ? '' : ' (REJECTED — nothing will draw on glasses)'}`,
      );
      started = res === StartUpPageCreateResult.success;
      if (!started) console.log('[hub] WARNING: startup page rejected');
    } else {
      const ok = await bridge.rebuildPageContainer(buildPage(state));
      console.log('[hub] rebuildPageContainer ->', ok);
      setStatus(`🔁 rebuild -> ${ok}`);
    }
    renderedSection = section;
    renderedText = section === 'docs' ? state.sections.docs : state.sections.notes;
  }

  // ── R1 ring / touchpad input ───────────────────────────────────────────────
  // Ring swipes and presses produce the SAME SDK events as the temple touchpads
  // (textEvent scroll, listEvent selection, sysEvent click/double-click), so
  // hands-free control works with either input. To react differently per device,
  // check `event.sysEvent?.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING`.

  const unsubscribeEvents = bridge.onEvenHubEvent(async (event) => {
    console.log('[hub] event', {
      sys: event.sysEvent?.eventType,
      list: event.listEvent?.eventType,
      text: event.textEvent?.eventType,
      menu: event.menuItemClickEvent?.itemID,
    });
    // 1) OS contextual menu item selected -> switch section
    if (event.menuItemClickEvent) {
      const def = SECTIONS.find((s) => s.menuId === event.menuItemClickEvent?.itemID);
      if (def) {
        state.activeSection = def.id;
        state.updatedAt = Date.now();
        await render({ force: true });
      }
      return;
    }

    // 2) List selection (single press on To-Do list) -> toggle done, double-sync
    if (event.listEvent) {
      if (state.activeSection === 'todo') {
        const idx = event.listEvent.currentSelectItemIndex ?? 0;
        const item = state.sections.todo[idx];
        if (item) {
          item.done = !item.done;
          state.updatedAt = Date.now();
          await pushState();
          await cacheState();
          await render({ force: true }); // lists require a full page rebuild
        }
      }
      return;
    }

    // 3) System events
    if (event.sysEvent) {
      const type = event.sysEvent.eventType;
      switch (type) {
        case OsEventTypeList.CLICK_EVENT:
          // single press on a text container: no-op (scrolling is native).
          break;

        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          // Canonical exit: show the system exit confirmation dialog.
          await bridge.shutDownPageContainer(1);
          break;

        case OsEventTypeList.FOREGROUND_ENTER_EVENT:
          await render();
          break;

        case OsEventTypeList.FOREGROUND_EXIT_EVENT:
          await cacheState();
          break;

        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        case OsEventTypeList.SYSTEM_EXIT_EVENT:
          await cacheState();
          unsubscribeEvents();
          closeStream();
          break;
      }
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
  await restoreState();
  await render();
}

void main();
