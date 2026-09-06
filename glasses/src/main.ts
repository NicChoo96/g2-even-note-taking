import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type MenuContainerProperty,
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
import { loadDocsDurable, saveDocsDurable, setDurableBridge, setStartupReady } from './durable-docs';
import {
  activeDoc,
  emptyDoc,
  uid,
  upsertDoc,
  type DocEntry,
  type TodoItem,
} from './types';
import {
  isDictating,
  lastDictationLog,
  lastDictationReason,
  startDictation,
  stopDictation,
} from './dictate';
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
  //    If the credential changes (device re-paired or revoked), the stream is
  //    torn down and re-created so a kicked device can't keep streaming.
  mountUi();
  let closeStream: (() => void) | null = null;
  let lastStreamToken: string | null = null;
  onStreamToken((token) => {
    if (token === lastStreamToken) return; // idempotent
    lastStreamToken = token;
    closeStream?.();
    closeStream = null;
    if (!token) return; // kicked / not authenticated — no stream
    closeStream = connectStream({
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
  // Signature of the contextual menu currently installed on the page. The OS
  // menu is swapped wholesale via rebuildPageContainer, so we rebuild ONLY when
  // this changes (entering/leaving Docs, or docs count crossing 0) — ordinary
  // content updates still use flicker-free textContainerUpgrade.
  let appliedMenuSig = '';
  let todoCursor = 0; // selected todo row
  let docPage = 0; // current docs/notes page
  let lastView: SectionView | null = null;
  let lastActiveDocId: string | null = null; // reset pagination when doc changes

  // In-app doc picker (long-press → Select/Delete Doc). While active the ring
  // moves over the doc list and a tap opens/deletes the highlighted doc.
  let pickerActive = false;
  let pickerIntent: 'open' | 'delete' = 'open';
  let pickerCursor = 0;

  // R1-ring dictation overlay (contextual menu → Dictate). While active the
  // glasses show a live status/interim view and a tap stops + commits.
  let dictationActive = false;
  let dictationStatus = '';
  let dictationInterim = '';
  let dictationStartedAt = 0;
  let dictationGotFinal = false;
  let dictationTapStop = false;
  // Accumulates per-phrase commits during a session; committed as ONE block at
  // the end so todo stays a single task and notes/docs read as flowing text.
  let dictationDraft = '';
  // Sticky diagnostics shown when a dictation session stops ITSELF (no tap).
  let dictationDiagText = '';
  // Ignore taps until this time. The single-press that CONFIRMS the 'Dictate'
  // menu item is often re-delivered to the page as a normal CLICK once the OS
  // menu closes — without a grace period that press instantly stops the mic.
  let dictationStopAfter = 0;

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

  /** The G2 page text container — exactly one, event-capturing, byte-clipped. */
  function textContainer(content: string): TextContainerProperty {
    return new TextContainerProperty({
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
  }

  /** Contextual menu for the current state (docs actions only in the Docs tab). */
  function currentSectionMenu(): MenuContainerProperty {
    const st = getState();
    return sectionMenu({
      section: st.activeSection,
      hasDocs: st.sections.docs.length > 0,
    });
  }

  /** Cheap identity of the installed menu, so we only rebuild when it changes. */
  function menuSignature(menu: MenuContainerProperty): string {
    return (menu.menuItems ?? [])
      .map((i) => `${i.itemID ?? 0}:${i.itemName ?? ''}`)
      .join('|');
  }

  async function createPage(content: string): Promise<StartUpPageCreateResult> {
    const menu = currentSectionMenu();
    const res = await b.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [textContainer(content)],
        // OS contextual menu — state-aware: docs actions only in the Docs tab.
        menuObject: menu,
      }),
    );
    if (res === StartUpPageCreateResult.success) appliedMenuSig = menuSignature(menu);
    return res;
  }

  // R1-ring dictation: a compact full-screen overlay (status + live interim).
  function dictationView(): SectionView {
    const status = dictationStatus || 'Starting mic…';
    const interim = dictationInterim.trim();
    const body = interim ? `${status}\n\n${clipBytes(interim, 460)}` : status;
    return { text: `>> Dictate\n\n${body}`, todoCursor: 0, canPrev: false, canNext: false };
  }

  /** R1-ring dictation diagnostics screen (sticky — tap to dismiss). */
  function dictationDiagView(): SectionView {
    return { text: dictationDiagText, todoCursor: 0, canPrev: false, canNext: false };
  }

  /** Sticky diagnostics screen shown after a dictation session stops ITSELF. */
  function showDictationDiag(detail?: string): void {
    dictationActive = false;
    dictationInterim = '';
    const why = lastDictationReason();
    const age = dictationStartedAt ? `${((Date.now() - dictationStartedAt) / 1000).toFixed(1)}s` : '?';
    const lines: string[] = [
      detail ? `>> Dictate — ${detail.slice(0, 44)}` : '>> Dictate — stopped itself',
      `why: ${why} · age ${age} · text ${dictationGotFinal ? 'yes' : 'no'}`, // 'text no' means it ended before committing anything
      '',
      ...lastDictationLog().slice(-6),
      '',
      'tap to dismiss',
    ];
    dictationDiagText = clipBytes(lines.join('\n'), MAX_CONTENT_BYTES);
    void renderGlasses();
  }

  /** Contextual menu → Dictate: turn on the glasses/phone mic and show live text. */
  function startGlassesDictation(): void {
    if (isDictating()) return; // already capturing
    pickerActive = false;
    pickerCursor = 0;
    dictationActive = true;
    dictationStatus = 'Starting mic…';
    dictationInterim = '';
    dictationStartedAt = Date.now();
    dictationGotFinal = false;
    dictationTapStop = false;
    dictationDraft = '';
    dictationDiagText = '';
    // Grace from the very start: the press that confirmed the menu item can be
    // re-delivered as a CLICK before the engine even reports 'listening'.
    dictationStopAfter = Date.now() + 1200;
    void renderGlasses();
    void startDictation({
      onState: (s, detail) => {
        if (!dictationActive) return;
        if (s === 'listening') {
          dictationStatus = detail || 'Listening… tap to stop';
          dictationInterim = '';
          // Extend the grace window to swallow the menu-confirm CLICK.
          dictationStopAfter = Date.now() + 1200;
        } else if (s === 'transcribing') {
          dictationStatus = 'Transcribing…';
          dictationStopAfter = Date.now() + 60000; // don't stop mid-transcribe
        } else if (s === 'error' || s === 'unsupported') {
          // Commit whatever phrases were already heard, then show the reason.
          const had = dictationDraft.trim();
          dictationDraft = '';
          if (had) commitSpeechToSection(had);
          dictationStatus = detail || 'Voice unavailable';
          dictationStopAfter = 0;
          // Persist the reason + session log on the glasses until the user taps.
          showDictationDiag(detail);
        } else if (s === 'idle') {
          // Continuous streaming ended: explicit tap, ~5s of real silence, or a
          // cap. Commit the whole draft once as a single block, then leave.
          const draft = dictationDraft.trim();
          dictationDraft = '';
          dictationInterim = '';
          dictationActive = false;
          if (draft) commitSpeechToSection(draft);
          if (!draft && !dictationTapStop) {
            // Stopped by itself without hearing anything — surface why.
            showDictationDiag();
          } else {
            void renderGlasses();
          }
        } else {
          void renderGlasses();
        }
      },
      onPartial: (t) => {
        if (dictationActive) {
          dictationStatus = 'Listening… tap to stop';
          dictationInterim = t;
          void renderGlasses();
        }
      },
      onFinal: (t) => {
        // Per-phrase commit (continuous streaming) — keep the session listening.
        const text = (t || '').trim();
        if (!text) return;
        dictationGotFinal = true;
        dictationDraft = dictationDraft ? `${dictationDraft} ${text}` : text;
        void renderGlasses();
      },
    });
  }

  /** Drop a transcript into whatever section is active (To-Do → new task, etc.). */
  function commitSpeechToSection(text: string): void {
    const st = getState();
    if (st.activeSection === 'todo') {
      const item: TodoItem = { id: uid(), text, done: false };
      update((s) => ({ ...s, sections: { ...s.sections, todo: [...s.sections.todo, item] } }));
      return;
    }
    if (st.activeSection === 'notes') {
      update((s) => ({
        ...s,
        sections: {
          ...s.sections,
          notes: s.sections.notes ? `${s.sections.notes.replace(/\s+$/, '')}\n${text}` : text,
        },
      }));
      return;
    }
    // Docs — append to the open doc, or create one titled from the first line.
    const cur = activeDoc(st);
    if (cur) {
      update((s) => ({
        ...s,
        sections: {
          ...s.sections,
          docs: s.sections.docs.map((d) =>
            d.id === cur.id
              ? {
                  ...d,
                  content: d.content ? `${d.content.replace(/\s+$/, '')}\n${text}` : text,
                  updatedAt: Date.now(),
                }
              : d,
          ),
        },
      }));
      return;
    }
    const firstLine = text.split('\n')[0].trim().slice(0, 28) || 'Voice note';
    const doc = emptyDoc(firstLine);
    update((s) => {
      const { docs, activeDocId } = upsertDoc(s, { ...doc, content: text });
      return { ...s, activeSection: 'docs', activeDocId, sections: { ...s.sections, docs } };
    });
  }

  async function doRender(): Promise<void> {
    // Before the device is paired (no credential), the glasses show onboarding.
    if (!getStreamToken()) {
      const text = PAIRING_TEXT;
      if (!started) {
        const res = await createPage(text);
        started = res === StartUpPageCreateResult.success;
        if (started) setStartupReady();
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

    // In-app doc picker (open/delete), the R1-ring dictation overlay, a sticky
    // diagnostics screen after a dictation auto-exit, or the normal renderer.
    const view = pickerActive
      ? docPickerView(getState().sections.docs, pickerCursor, pickerIntent)
      : dictationActive
        ? dictationView()
        : dictationDiagText
          ? dictationDiagView()
          : sectionView(getState(), todoCursor, docPage);
    lastView = view;
    if (pickerActive) pickerCursor = view.todoCursor;
    else if (!dictationActive && !dictationDiagText) todoCursor = view.todoCursor;
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
      if (started) setStartupReady();
      if (!started) {
        console.log('[hub] WARNING: startup page rejected');
        return;
      }
      renderedText = text;
      return;
    }

    // Already created — if the contextual menu needs to change (entered/left
    // the Docs tab, or the docs count crossed zero), REBUILD the page with the
    // new menuObject. menuObject is replaced wholesale on rebuild (never merged),
    // so we always pass the fresh menu for the current section.
    const menu = currentSectionMenu();
    const sig = menuSignature(menu);
    if (sig !== appliedMenuSig) {
      const ok = await b.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: 1,
          textObject: [textContainer(text)],
          menuObject: menu,
        }),
      );
      console.log('[hub] rebuildPageContainer (menu) ->', ok);
      if (ok) {
        appliedMenuSig = sig;
        renderedText = text;
        return;
      }
      // Rebuild failed (e.g. simulator has no page rebuild) — keep the old menu
      // but still refresh the content below so the screen isn't stuck.
    }

    // Menu unchanged (or rebuild failed) — update in place (flicker-free).
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
    if (dictationActive || dictationDiagText) return; // ignore swipes while dictating / diag
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
    // A tap dismisses the sticky dictation diagnostics screen.
    if (dictationDiagText) {
      dictationDiagText = '';
      void renderGlasses();
      return;
    }
    if (dictationActive) {
      // A tap while dictating = stop + commit what was heard. But ignore taps
      // inside the grace window — the press that confirmed the 'Dictate' menu
      // item can arrive as a CLICK right after the menu closes, which would
      // otherwise stop the mic the instant it started.
      if (Date.now() < dictationStopAfter) return;
      dictationTapStop = true;
      void stopDictation();
      return;
    }
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
      if (itemID === MENU.DICTATE) {
        startGlassesDictation();
        return;
      }
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

  // When the credential changes (pairing completes OR the device is revoked),
  // reset navigation and re-render — a kick shows the pairing/onboarding text
  // again instead of leaving stale content on the glasses.
  onStreamToken(() => {
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
