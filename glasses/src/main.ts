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
import {
  clipBytes,
  docPickerView,
  MAX_CONTENT_BYTES,
  MENU,
  sectionByMenuId,
  sectionMenu,
  sectionView,
  type SectionView,
} from './sections';
import { applyRemote, getState, seedIfEmpty, setConnStatus, subscribe, update } from './store';
import { getStreamToken, onStreamToken } from './auth-token';
import { loadDocsDurable, saveDocsDurable, setDurableBridge } from './durable-docs';
import { emptyDoc, upsertDoc, type DocEntry } from './types';
import { mountUi } from './web/ui';

// ── Configuration ────────────────────────────────────────────────────────────
// G2 OS hard content cap: 999 UTF-8 bytes for BOTH createStartUpPageContainer
// and textContainerUpgrade (verified empirically — >999 bytes and the page is
// REJECTED, which is what "stopped sending" on big pastes). Every payload is
// byte-clipped to stay under it.
const CONTAINER_ID = 1;
const CONTAINER_NAME = 'main';

// Shown on the glasses before the device has been paired/approved.
const PAIRING_TEXT =
  'Pair this device\n\nOpen the hub URL in\na browser, sign in, and\napprove this device.\n\nPaste & edit on the\nweb app, control with\nyour R1 ring.';

/** Diagnostic logging only — the phone screen stays clean (just the web UI). */
function setStatus(line: string): void {
  console.log('[hub]', line);
}

async function main(): Promise<void> {
  // ONE app, ONE URL: render the companion web UI in any browser (including the
  // Even App WebView), then draw to the glasses via the SDK when the bridge is
  // available. The shared store keeps the UI and the glasses in sync.

  // 1) The stream is driven by a credential, NOT the SDK bridge: a browser gets
  //    an owner session token after Google Sign-In; the Even App gets an
  //    approved per-device ID. Until one exists the relay refuses connections.
  mountUi();
  let streamConnected = false;
  onStreamToken((token) => {
    if (streamConnected || !token) return;
    streamConnected = true;
    connectStream({
      onState: (next) => applyRemote(next),
      onStatus: (s) => {
        setStatus(`📡 SSE ${s}`);
        setConnStatus(s);
      },
    });
    // Seed the relay from local data if the server has none yet.
    window.setTimeout(() => seedIfEmpty(), 1000);
  });

  // 2) Glasses rendering only runs inside the Even App (bridge injected). In a
  //    plain browser there is no bridge — time out instead of hanging forever.
  let bridge: EvenAppBridge | null = null;
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
  } catch {
    bridge = null;
  }
  if (!bridge) {
    console.log('[hub] no EvenAppBridge — running as web UI only');
    return;
  }
  const b: EvenAppBridge = bridge;
  console.log('[hub] bridge ready');
  try {
    const dev = await b.getDeviceInfo();
    setStatus(
      `👓 device: ${dev ? `${dev.model} · ${dev.status?.connectType ?? 'unknown'}` : 'none detected'}`,
    );
  } catch {
    setStatus('👓 device info unavailable');
  }

  // Mirror the docs library to the host's reliable storage (Even App WebView
  // browser-localStorage does not survive restarts — see device-features skill).
  setDurableBridge(b);
  void (async () => {
    try {
      const saved = await loadDocsDurable();
      if (saved && saved.length && getState().sections.docs.length === 0) {
        update((s) => ({
          ...s,
          sections: { ...s.sections, docs: saved },
          activeDocId: saved[0].id,
        }));
      }
    } catch {
      /* ignore */
    }
  })();

  let started = false; // createStartUpPageContainer called exactly once
  let renderedText = '';
  let todoCursor = 0; // selected todo row
  let docPage = 0; // current docs/notes page
  let lastView: SectionView | null = null;
  let lastActiveDocId: string | null = null; // reset pagination when doc changes

  // In-app doc picker (long-press → Select/Delete Doc). While active the ring
  // moves over the doc list and a tap opens/deletes the highlighted doc.
  let pickerActive = false;
  let pickerIntent: 'open' | 'delete' = 'open';
  let pickerCursor = 0;

  // Durable docs writes are debounced (bridge.setLocalStorage shares the BLE hop).
  let saveDocsTimer: number | null = null;

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

  async function createPage(content: string): Promise<StartUpPageCreateResult> {
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
      content: clipBytes(content, MAX_CONTENT_BYTES),
    });
    return b.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [container],
        // OS contextual menu (To-Do / Docs / Notes) — lives for the page's
        // lifetime; selections arrive as menuItemClickEvent.
        menuObject: sectionMenu(),
      }),
    );
  }

  async function doRender(): Promise<void> {
    // Before the device is paired (no credential), the glasses show onboarding.
    if (!getStreamToken()) {
      const text = PAIRING_TEXT;
      if (!started) {
        const res = await createPage(text);
        started = res === StartUpPageCreateResult.success;
        renderedText = text;
        if (!started) console.log('[hub] WARNING: startup page rejected (pairing)');
        return;
      }
      if (text !== renderedText) {
        const ok = await b.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: CONTAINER_ID,
            containerName: CONTAINER_NAME,
            content: clipBytes(text, MAX_CONTENT_BYTES),
          }),
        );
        if (ok) renderedText = text;
      }
      return;
    }

    // Switching to a different doc (web UI or the glasses picker) restarts its
    // pagination at page 1.
    if (!pickerActive) {
      const curDocId = getState().activeSection === 'docs' ? getState().activeDocId : null;
      if (curDocId !== lastActiveDocId) {
        lastActiveDocId = curDocId;
        docPage = 0;
      }
    }

    // In-app doc picker (open/delete) OR the normal section renderer.
    const view = pickerActive
      ? docPickerView(getState().sections.docs, pickerCursor, pickerIntent)
      : sectionView(getState(), todoCursor, docPage);
    lastView = view;
    if (pickerActive) pickerCursor = view.todoCursor;
    else todoCursor = view.todoCursor;
    const text = view.text;
    console.log('[hub] render', {
      started,
      section: getState().activeSection,
      len: text.length,
      picker: pickerActive ? pickerIntent : false,
      cursor: pickerActive ? pickerCursor : todoCursor,
    });

    if (!started) {
      const res = await createPage(text);
      console.log('[hub] createStartUpPageContainer ->', res);
      setStatus(
        `🖼 createStartUpPageContainer -> ${res}${res === StartUpPageCreateResult.success ? '' : ' (REJECTED — nothing will draw on glasses)'}`,
      );
      started = res === StartUpPageCreateResult.success;
      if (!started) {
        console.log('[hub] WARNING: startup page rejected');
        return;
      }
      renderedText = text;
      return;
    }

    // Already created — update in place (flicker-free).
    if (text !== renderedText) {
      const ok = await b.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          containerName: CONTAINER_NAME,
          content: clipBytes(text, MAX_CONTENT_BYTES),
        }),
      );
      console.log('[hub] textContainerUpgrade ->', ok);
      if (ok) renderedText = text;
    }
  }

  function enterPicker(intent: 'open' | 'delete'): void {
    if (getState().sections.docs.length === 0) return;
    pickerIntent = intent;
    pickerCursor = 0;
    pickerActive = true;
    void renderGlasses();
  }

  function newDoc(): void {
    const doc = emptyDoc('Untitled');
    update((s) => {
      const { docs, activeDocId } = upsertDoc(s, doc);
      return { ...s, activeSection: 'docs', activeDocId, sections: { ...s.sections, docs } };
    });
  }

  function onPickerSwipe(dir: -1 | 1): void {
    const ds = getState().sections.docs;
    if (!ds.length) return;
    const next = Math.min(ds.length - 1, Math.max(0, pickerCursor + dir));
    if (next !== pickerCursor) {
      pickerCursor = next;
      void renderGlasses();
    }
  }

  function onPickerTap(): void {
    const ds = getState().sections.docs;
    if (!ds.length) return;
    const target: DocEntry = ds[Math.min(ds.length - 1, Math.max(0, pickerCursor))];
    if (pickerIntent === 'delete') {
      update((s) => {
        const remaining = s.sections.docs.filter((d) => d.id !== target.id);
        return {
          ...s,
          sections: { ...s.sections, docs: remaining },
          activeDocId:
            remaining.length > 0
              ? s.activeDocId === target.id
                ? remaining[0].id
                : s.activeDocId
              : null,
        };
      });
      // Stay in the picker so more docs can be removed; cursor clamps on render.
      pickerCursor = Math.min(pickerCursor, Math.max(0, ds.length - 2));
      return;
    }
    // Open the highlighted doc.
    pickerActive = false;
    pickerCursor = 0;
    update((s) => ({ ...s, activeSection: 'docs', activeDocId: target.id }));
  }

  function onSwipe(dir: -1 | 1): void {
    if (pickerActive) {
      onPickerSwipe(dir);
      return;
    }
    if (getState().activeSection === 'todo') {
      const items = getState().sections.todo;
      if (!items.length) return;
      const next = Math.min(items.length - 1, Math.max(0, todoCursor + dir));
      if (next !== todoCursor) {
        todoCursor = next;
        void renderGlasses();
      }
      return;
    }
    // docs / notes — flip pages.
    if (!lastView) return;
    if (dir === -1 && lastView.canPrev) {
      docPage = Math.max(0, docPage - 1);
      void renderGlasses();
    } else if (dir === 1 && lastView.canNext) {
      docPage += 1;
      void renderGlasses();
    }
  }

  function onTap(): void {
    if (pickerActive) {
      onPickerTap();
      return;
    }
    if (getState().activeSection !== 'todo') return;
    const items = getState().sections.todo;
    if (!items.length || todoCursor >= items.length) return;
    const id = items[todoCursor].id;
    update((s) => ({
      ...s,
      sections: {
        ...s.sections,
        todo: s.sections.todo.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
      },
    }));
  }

  // Any state change (UI edit, remote frame, or a ring tap) re-renders and
  // mirrors the docs library into durable storage (debounced).
  subscribe(() => {
    void renderGlasses();
    if (saveDocsTimer !== null) window.clearTimeout(saveDocsTimer);
    saveDocsTimer = window.setTimeout(() => {
      saveDocsTimer = null;
      void saveDocsDurable(getState().sections.docs);
    }, 400);
  });

  // R1 ring / G2 touchpad: swipe up/down moves the todo cursor (or flips a
  // docs/notes page, or moves the doc picker), single tap toggles/opens, and
  // double-tap exits.
  const unsubscribeEvents = b.onEvenHubEvent(async (event) => {
    // OS contextual menu selections arrive even while a picker is showing.
    if (event.menuItemClickEvent) {
      const itemID = event.menuItemClickEvent.itemID ?? 0;
      console.log('[hub] menu item', itemID);
      if (itemID === MENU.DOC_NEW) {
        pickerActive = false;
        newDoc();
        return;
      }
      if (itemID === MENU.DOC_SELECT) {
        enterPicker('open');
        return;
      }
      if (itemID === MENU.DOC_DELETE) {
        enterPicker('delete');
        return;
      }
      // Section switchers (To-Do / Docs / Notes) also cancel any picker.
      const def = sectionByMenuId(itemID);
      if (def) {
        pickerActive = false;
        pickerCursor = 0;
        todoCursor = 0;
        docPage = 0;
        lastView = null;
        update((s) => ({ ...s, activeSection: def.id }));
      }
      return;
    }

    // Text container: swipes arrive here — use them for navigation instead of
    // the OS scrolling the whole section.
    if (event.textEvent) {
      const type = event.textEvent.eventType ?? 0;
      if (type === OsEventTypeList.SCROLL_TOP_EVENT) onSwipe(-1);
      else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) onSwipe(1);
      return;
    }

    const sysType = event.sysEvent?.eventType ?? 0;
    if (sysType === OsEventTypeList.CLICK_EVENT) {
      onTap();
      return;
    }
    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      await b.shutDownPageContainer(1);
      return;
    }
    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      pickerActive = false;
      pickerCursor = 0;
      void renderGlasses();
      return;
    }
    if (sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT || sysType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
      unsubscribeEvents();
    }
  });

  // When pairing completes (credential arrives), drop onboarding and draw live.
  onStreamToken((token) => {
    if (!token) return;
    pickerActive = false;
    pickerCursor = 0;
    todoCursor = 0;
    docPage = 0;
    lastView = null;
    void renderGlasses();
  });

  // Boot render (pairing screen or live state).
  await renderGlasses();
}

void main();
