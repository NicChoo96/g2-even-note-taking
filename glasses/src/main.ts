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
import { connectAgentsStream, connectStream, startRun, stopRun, type AgentRun } from './stream';
import { getRuns, subscribeRuns } from './agent-runs';
import {
  AGENT_LAYOUT,
  agentsMasterDetailView,
  agentsStatusLine,
  clipBytes,
  docPickerView,
  MAX_CONTENT_BYTES,
  MENU,
  sectionByMenuId,
  sectionMenu,
  sectionView,
  type AgentFocus,
  type SectionView,
} from './sections';
import {
  applyRemote,
  getState,
  noteServerHandshake,
  seedIfEmpty,
  setConnStatus,
  subscribe,
  update,
} from './store';
import {
  applyRemoteAgents,
  getAgents,
  hydrateAgentsDurable,
  noteAgentsHandshake,
  recordSession,
  seedAgentsIfEmpty,
  setAgentsConn,
  subscribeAgents,
} from './agents-store';
import { getStreamToken, onStreamToken } from './auth-token';
import { loadDocsDurable, saveDocsDurable, setDurableBridge, setStartupReady } from './durable-docs';
import {
  activeDoc,
  emptyDoc,
  uid,
  upsertDoc,
  type AgentDef,
  type DocEntry,
  type SectionId,
  type TodoItem,
} from './types';
import {
  dictationSnapshot,
  dictationText,
  isDictating,
  lastDictationLog,
  lastDictationReason,
  onDictationSnapshot,
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
  let closeAgentsStream: (() => void) | null = null;
  let lastStreamToken: string | null = null;
  onStreamToken((token) => {
    if (token === lastStreamToken) return; // idempotent
    lastStreamToken = token;
    closeStream?.();
    closeStream = null;
    closeAgentsStream?.();
    closeAgentsStream = null;
    if (!token) return; // kicked / not authenticated — no stream
    closeStream = connectStream({
      onState: (next) => applyRemote(next),
      onStatus: (s) => {
        setStatus(`📡 SSE ${s}`);
        setConnStatus(s);
      },
      // A handshake with `state: null` means the relay is empty — only then may
      // this client seed it from its local copy.
      onHandshake: (hasSnapshot) => noteServerHandshake(hasSnapshot),
    });
    // Agents ride a SEPARATE channel so agent/session payloads never bloat the
    // HubState frame (and API keys never ride either).
    closeAgentsStream = connectAgentsStream({
      onState: (next) => applyRemoteAgents(next),
      onStatus: (s) => setAgentsConn(s),
      onHandshake: (hasSnapshot) => noteAgentsHandshake(hasSnapshot),
    });
    // Live agent runs are TRANSIENT frames on the same channel: a run executes
    // in the relay, so the detail pane streams even if this page was
    // backgrounded mid-run. `subscribeRuns` (below) owns that connection.
    // Seed the relay from local data if the server has none yet.
    window.setTimeout(() => seedIfEmpty(), 1000);
    window.setTimeout(() => seedAgentsIfEmpty(), 1200);
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
  // Agent definitions/tools/settings + the last 5 sessions are also mirrored to
  // the host storage (the WebView can be torn down at any moment).
  void hydrateAgentsDurable();

  let started = false; // createStartUpPageContainer called exactly once
  let renderedText = '';
  // Signature of the contextual menu currently installed on the page. The OS
  // menu is swapped wholesale via rebuildPageContainer, so we rebuild ONLY when
  // this changes (entering/leaving Docs, or docs count crossing 0) — ordinary
  // content updates still use flicker-free textContainerUpgrade.
  let appliedMenuSig = '';
  /** 'single' = one full-canvas text container; 'dual' = the Agents panes. */
  let appliedLayout: 'single' | 'dual' = 'single';
  /** Focus+cursor+border signature of the dual pane layout. */
  let appliedAgentSig = '';
  let todoCursor = 0; // selected todo row
  let docPage = 0; // current docs/notes page
  let lastView: SectionView | null = null;
  let lastActiveDocId: string | null = null; // reset pagination when doc changes
  // Last non-Docs tab, so the Docs tab's "Back" menu item can return there
  // (the Docs menu hides the To-Do/Notes switchers to stay short).
  let lastNonDocsSection: SectionId = 'todo';

  // In-app doc picker (long-press → Select/Delete Doc). While active the ring
  // moves over the doc list and a tap opens/deletes the highlighted doc.
  let pickerActive = false;
  let pickerIntent: 'open' | 'delete' = 'open';
  let pickerCursor = 0;

  // Agents tab — master–detail. The contextual menu moves R1 control between
  // the left agent list (focus 'master') and the right output pane ('detail'):
  // "Select Agents" → master, picking an agent → detail. Only ONE container may
  // be isEventCapture:1, so the ring is routed by this flag, not by the event.
  let agentFocus: AgentFocus = 'master';
  let agentCursor = 0;
  let agentRunning = false;
  let agentStatus = '';
  let agentError = '';
  /** Relay run id we started, until its transcript is saved as a session. */
  let agentRunId: string | null = null;
  /** Which of the (max 5) stored sessions the detail pane is showing. */
  let agentSessionCursor = 0;
  /** Page of the detail pane's transcript (0 = newest content). */
  let agentDetailPage = 0;
  /** Pages the last detail render produced — bounds the paging swipes. */
  let agentDetailPages = 1;

  // R1-ring dictation overlay (contextual menu → Dictate). While active the
  // glasses show a live status + running transcript and a tap stops + commits.
  let dictationActive = false;
  let dictationStatus = '';
  // Running transcript for DISPLAY. Nothing is written to the active section
  // until the session ends — a field write re-renders the page, and a page
  // write while the mic is open makes the host drop the audio stream.
  let dictationInterim = '';
  let dictationStartedAt = 0;
  let dictationGotFinal = false;
  let dictationTapStop = false;
  // Main-side watchdog: guarantees a requested stop (R1 tap) is delivered even
  // if the engine is busy; dictation itself is tap-to-stop (no auto-stop).
  let dictationTimer: number | null = null;
  let dictationStopAt = 0;
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

  /** The G2 page text container — event-capturing, byte-clipped. */
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

  /**
   * Master–detail panes for the Agents tab. Two containers, 4px gutters:
   *   • left  x0   w200 — the agent list (event-capturing while focus='master')
   *   • right x208 w368 — the selected agent's output (event-capturing otherwise)
   * Exactly one container may be isEventCapture:1, so R1 input is routed by
   * `agentFocus` rather than by which container was touched. The focused pane
   * gets a 2px border as the documented selection highlight.
   */
  function agentContainers(): TextContainerProperty[] {
    const a = getAgents();
    const view = agentsMasterDetailView(
      {
        agents: a.agents,
        sessions: a.sessions,
        cursor: agentCursor,
        focus: agentFocus,
        sessionCursor: agentSessionCursor,
        detailPage: agentDetailPage,
        status: agentStatus || agentsStatusLine(agentRunning, agentError),
        run: liveRunFor(a.agents[agentCursor]?.id),
      },
      (id) => a.tools.find((t) => t.id === id)?.name ?? id,
    );
    agentCursor = view.cursor;
    agentSessionCursor = view.sessionCursor;
    agentDetailPage = view.detailPage;
    agentDetailPages = view.detailPages;
    const masterFocus = agentFocus === 'master';
    return [
      new TextContainerProperty({
        xPosition: AGENT_LAYOUT.masterX,
        yPosition: 0,
        width: AGENT_LAYOUT.masterW,
        height: AGENT_LAYOUT.height,
        borderWidth: masterFocus ? 2 : 0,
        borderColor: 5,
        borderRadius: 0,
        paddingLength: 4,
        containerID: 1,
        containerName: 'master',
        isEventCapture: masterFocus ? 1 : 0,
        content: clipBytes(view.master, MAX_CONTENT_BYTES),
      }),
      new TextContainerProperty({
        xPosition: AGENT_LAYOUT.detailX,
        yPosition: 0,
        width: AGENT_LAYOUT.detailW,
        height: AGENT_LAYOUT.height,
        borderWidth: masterFocus ? 0 : 2,
        borderColor: 5,
        borderRadius: 0,
        paddingLength: 4,
        containerID: 2,
        containerName: 'detail',
        isEventCapture: masterFocus ? 0 : 1,
        content: clipBytes(view.detail, MAX_CONTENT_BYTES),
      }),
    ];
  }

  /** Contextual menu for the current state (docs/agents actions in their tabs). */
  function currentSectionMenu(): MenuContainerProperty {
    const st = getState();
    return sectionMenu({
      section: st.activeSection,
      hasDocs: st.sections.docs.length > 0,
      hasAgents: getAgents().agents.length > 0,
      agentRunning: getRuns().some((r) => r.status === 'running'),
    });
  }

  /** Cheap identity of the installed menu, so we only rebuild when it changes. */
  function menuSignature(menu: MenuContainerProperty): string {
    return (menu.menuItems ?? [])
      .map((i) => `${i.itemID ?? 0}:${i.itemName ?? ''}`)
      .join('|');
  }

  /**
   * Identity of the dual-pane layout: geometry + which pane captures events +
   * the rendered text. A change means the page must be rebuilt (the border that
   * highlights the focused pane is only settable on create/rebuild).
   */
  function agentSignature(containers: TextContainerProperty[]): string {
    return containers
      .map(
        (c) =>
          `${c.containerID}:${c.xPosition}:${c.width}:${c.borderWidth}:${c.isEventCapture}:${c.content ?? ''}`,
      )
      .join('|');
  }

  async function createPage(content: string): Promise<StartUpPageCreateResult> {
    const menu = currentSectionMenu();
    const agents = getState().activeSection === 'agents';
    const containers = agents ? agentContainers() : [textContainer(content)];
    const res = await b.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: containers.length,
        textObject: containers,
        // OS contextual menu — state-aware: docs/agents actions only in their tab.
        menuObject: menu,
      }),
    );
    if (res === StartUpPageCreateResult.success) {
      appliedMenuSig = menuSignature(menu);
      appliedLayout = agents ? 'dual' : 'single';
      appliedAgentSig = agents ? agentSignature(containers) : '';
    }
    return res;
  }

  // R1-ring dictation: a compact full-screen overlay (status + running text).
  function dictationView(): SectionView {
    const status = dictationStatus || 'Starting mic…';
    const interim = dictationInterim.trim();
    const body = interim ? `${status}\n\n${clipBytes(interim, 380)}` : status;
    // Footer hint is always present so the stop gesture stays visible.
    return {
      text: `>> Dictate\n${body}\n\n● Tap R1 = stop`,
      todoCursor: 0,
      canPrev: false,
      canNext: false,
    };
  }

  /** Mirror a dictation started elsewhere (web/phone MicButton) on the glasses
   *  so the user sees live text + the R1 stop hint even when not started from
   *  the contextual menu. */
  function dictationForeignView(): SectionView {
    const s = dictationSnapshot();
    const status = s.detail ? `${s.detail} · tap R1 to stop` : 'Listening… tap R1 to stop';
    const interim = (s.text || s.interim || '').trim();
    const body = interim ? `${status}\n\n${clipBytes(interim, 380)}` : status;
    return { text: `>> Dictate\n${body}`, todoCursor: 0, canPrev: false, canNext: false };
  }

  /** R1-ring dictation diagnostics screen (sticky — tap to dismiss). */
  function dictationDiagView(): SectionView {
    return { text: dictationDiagText, todoCursor: 0, canPrev: false, canNext: false };
  }

  /** Force-end the dictation overlay + commit whatever was heard. */
  function endDictationForced(): void {
    if (dictationTimer !== null) {
      window.clearInterval(dictationTimer);
      dictationTimer = null;
    }
    if (!dictationActive) return;
    // The user DID stop (this only runs after a requested stop), so the running
    // transcript is written — the engine may still be flushing its last phrase.
    const draft = dictationText().trim();
    dictationInterim = '';
    dictationActive = false;
    if (draft) commitSpeechToSection(draft);
    void renderGlasses();
  }

  /** Backstop watchdog: if a stop (R1 tap / Stop button) was requested but the
   *  engine hasn't finished within a couple of seconds, force-end so the user
   *  is never stuck. Dictation is tap-to-stop — no silence auto-stop. */
  function startDictationGuard(): void {
    if (dictationTimer !== null) return;
    dictationTimer = window.setInterval(() => {
      if (!dictationActive) {
        if (dictationTimer !== null) {
          window.clearInterval(dictationTimer);
          dictationTimer = null;
        }
        return;
      }
      const now = Date.now();
      // Force-end if a stop was requested but the engine hasn't delivered idle
      // within 2.5s — the user must never be stuck in dictation.
      if (dictationStopAt && now - dictationStopAt > 2500) {
        endDictationForced();
      }
    }, 500);
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
    dictationDiagText = '';
    dictationStopAt = 0;
    // Grace from the very start: the press that confirmed the menu item can be
    // re-delivered as a CLICK before the engine even reports 'listening'.
    dictationStopAfter = Date.now() + 1200;
    startDictationGuard();
    void renderGlasses();
    void startDictation({
      onState: (s, detail) => {
        if (!dictationActive) return;
        if (s === 'listening') {
          dictationStatus = detail ? `${detail} · tap R1 to stop` : 'Listening… tap R1 to stop';
          dictationInterim = '';
          // Extend the grace window to swallow the menu-confirm CLICK.
          dictationStopAfter = Date.now() + 1200;
        } else if (s === 'transcribing') {
          dictationStatus = 'Transcribing…';
          dictationStopAfter = Date.now() + 60000; // don't stop mid-transcribe
        } else if (s === 'error' || s === 'unsupported') {
          // Commit whatever was heard before the failure, then show the reason.
          // (The engine only publishes the transcript at the end; read the
          // snapshot so a partial utterance is not lost.)
          const had = dictationText().trim();
          if (had) commitSpeechToSection(had);
          dictationStatus = detail || 'Voice unavailable';
          dictationStopAfter = 0;
          // Persist the reason + session log on the glasses until the user taps.
          showDictationDiag(detail);
        } else if (s === 'idle') {
          // The session is over (explicit stop or a cap). THIS is the only place
          // the utterance is written to the active section — committing per
          // phrase would re-render the page and kill the live mic.
          const snap = dictationSnapshot();
          const draft = snap.commit ? snap.text.trim() : '';
          dictationInterim = '';
          dictationActive = false;
          if (dictationTimer !== null) {
            window.clearInterval(dictationTimer);
            dictationTimer = null;
          }
          if (draft) {
            dictationGotFinal = true;
            commitSpeechToSection(draft);
          } else if (!dictationTapStop) {
            // Ended without hearing anything — surface why.
            showDictationDiag();
          } else {
            void renderGlasses();
          }
        } else {
          void renderGlasses();
        }
      },
      onPartial: (t) => {
        if (!dictationActive) return;
        dictationStatus = 'Listening… tap R1 to stop';
        dictationInterim = t;
        void renderGlasses();
      },
      onText: (full) => {
        // Running transcript — DISPLAY ONLY. The section is written once, in the
        // idle handler above, so no field/page write happens while the mic is
        // open (that is what used to drop the audio stream mid-utterance).
        if (!dictationActive) return;
        dictationInterim = full;
        if (full.trim()) dictationGotFinal = true;
        void renderGlasses();
      },
    });
  }

  /**
   * Drop a transcript into the active section (To-Do → new task, etc.).
   * Dictation is never used to prompt an agent — the Agents tab uses the
   * agent's saved prompt via the Trigger menu item.
   */
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

    // Remember the last non-Docs tab we actually showed, whichever path put us
    // here (menu switcher, web UI tab, new doc, picker) — "Back" restores it.
    if (getState().activeSection !== 'docs') lastNonDocsSection = getState().activeSection;

    // In-app doc picker, the R1-ring dictation overlay, a sticky diagnostics
    // screen, a mirror of a dictation started elsewhere (web/phone MicButton),
    // or the normal renderer.
    const foreignActive = !dictationActive && !dictationDiagText && dictationSnapshot().active;
    // Any of these takes over the WHOLE screen, so it must bypass the Agents
    // dual-pane renderer below (which otherwise wins and hides the overlay).
    const overlayActive = pickerActive || dictationActive || !!dictationDiagText || foreignActive;
    const view = pickerActive
      ? docPickerView(getState().sections.docs, pickerCursor, pickerIntent)
      : dictationActive
        ? dictationView()
        : dictationDiagText
          ? dictationDiagView()
          : foreignActive
            ? dictationForeignView()
            : sectionView(getState(), todoCursor, docPage);
    lastView = view;
    if (pickerActive) pickerCursor = view.todoCursor;
    else if (!overlayActive) todoCursor = view.todoCursor;
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
      if (started) setStartupReady(); // createPage() already recorded the layout signature
      if (!started) {
        console.log('[hub] WARNING: startup page rejected');
        return;
      }
      renderedText = text;
      return;
    }

    const menu = currentSectionMenu();
    const sig = menuSignature(menu);
    const agentsTab = getState().activeSection === 'agents' && !overlayActive;

    // Agents tab: two panes whose BORDERS encode the focused pane, so any focus
    // or cursor change needs a rebuild. The master list and the output pane are
    // independent containers; the menu is replaced at the same time.
    // Skipped while an overlay is up — those render as a single container.
    if (agentsTab) {
      const containers = agentContainers();
      const asig = agentSignature(containers);
      if (appliedLayout !== 'dual' || asig !== appliedAgentSig || sig !== appliedMenuSig) {
        const ok = await b.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: 2,
            textObject: containers,
            menuObject: menu,
          }),
        );
        // The signature carries both pane contents (master | detail) — log enough
        // of it to see what the panes actually show when debugging.
        console.log('[hub] rebuildPageContainer (agents) ->', ok, agentFocus, asig.slice(0, 240));
        if (ok) {
          appliedLayout = 'dual';
          appliedAgentSig = asig;
          appliedMenuSig = sig;
          renderedText = text;
        }
      }
      return;
    }

    // Left the Agents tab (or a non-agents view is showing) — the page must go
    // back to ONE container before the single-container update path can run.
    if (appliedLayout !== 'single') {
      const ok = await b.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: 1,
          textObject: [textContainer(text)],
          menuObject: menu,
        }),
      );
      console.log('[hub] rebuildPageContainer (single) ->', ok);
      if (ok) {
        appliedLayout = 'single';
        appliedAgentSig = '';
        appliedMenuSig = sig;
        renderedText = text;
      }
      return;
    }

    // Already created — if the contextual menu needs to change (entered/left
    // the Docs/Agents tab, or a collection count crossed zero), REBUILD the page
    // with the new menuObject. menuObject is replaced wholesale on rebuild
    // (never merged), so we always pass the fresh menu for the current section.
    if (sig !== appliedMenuSig) {
      const ok = await b.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: 1,
          textObject: [textContainer(text)],
          menuObject: menu,
        }),
      );
      console.log('[hub] rebuildPageContainer (menu) ->', ok, sig);
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

  // ── Agents actions ─────────────────────────────────────────────────────────
  /** The agent currently under the master-panel cursor. */
  function agentSelected(): AgentDef | null {
    const a = getAgents();
    if (!a.agents.length) return null;
    return a.agents[Math.min(a.agents.length - 1, Math.max(0, agentCursor))];
  }

  /**
   * Contextual menu → "Trigger": run the highlighted agent's SAVED prompt.
   *
   * The run itself executes SERVER-SIDE in the relay, so it keeps going when the
   * glasses page is backgrounded, and BOTH the detail pane here and the browser
   * companion UI watch the same transcript stream in (see connectRuns).
   */
  async function agentsTrigger(): Promise<void> {
    const agent = agentSelected();
    if (!agent || agentRunning) return;
    if (!agent.prompt.trim()) {
      agentError = 'no saved prompt';
      agentFocus = 'detail';
      void renderGlasses();
      return;
    }
    const st = getAgents();
    const tools = st.tools.filter((t) => agent.toolIds.includes(t.id));
    agentRunning = true;
    agentError = '';
    agentStatus = 'Thinking…';
    agentFocus = 'detail';
    agentSessionCursor = 0;
    agentDetailPage = 0;
    void renderGlasses();
    const started = await startRun({
      agent: {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        model: agent.model,
      },
      tools,
      prompt: agent.prompt.trim(),
      model: agent.model || st.llm.model,
    });
    if (!started.runId) {
      agentRunning = false;
      agentStatus = '';
      agentError = started.error || 'relay refused the run';
      void renderGlasses();
      return;
    }
    agentRunId = started.runId;
  }

  /** Contextual menu → "Stop": cancel the in-flight run. */
  async function agentsStop(): Promise<void> {
    const active = getRuns().find((r) => r.status === 'running');
    if (!active) return;
    agentStatus = 'Stopping…';
    void renderGlasses();
    await stopRun(active.id);
  }

  /**
   * The live run for an agent, if the relay is still executing one. Read by the
   * detail pane so the transcript streams in turn by turn.
   */
  function liveRunFor(agentId: string | undefined): AgentRun | null {
    if (!agentId) return null;
    return (
      getRuns().find((r) => r.agentId === agentId && r.status === 'running') ??
      (agentRunId ? (getRuns().find((r) => r.id === agentRunId) ?? null) : null)
    );
  }

  /**
   * A finished run becomes a session. The RUN id is the session id, so the
   * browser and the glasses converge on ONE entry (and re-recording is a no-op
   * once it exists, which stops the store→SSE→store feedback loop).
   */
  function settleRun(run: AgentRun): void {
    if (run.status === 'running') return;
    const already = getAgents().sessions.some((s) => s.id === run.id);
    if (already) {
      if (run.id === agentRunId) agentRunId = null;
      return;
    }
    const selected = agentSelected();
    const mine = run.id === agentRunId || (!!selected && selected.id === run.agentId);
    recordSession({
      id: run.id,
      agentId: run.agentId,
      title: run.title || run.prompt.slice(0, 48) || 'Session',
      messages: run.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool: m.tool,
        args: m.args,
        at: m.at,
      })),
      status: run.status === 'done' ? 'done' : 'error',
    });
    if (run.id === agentRunId) agentRunId = null;
    if (mine && selected?.id === run.agentId) {
      agentRunning = false;
      agentStatus = '';
      agentError = run.status === 'error' ? (run.error ?? 'failed') : '';
      // The finished transcript just became session 0 — show its newest page
      // instead of leaving the pane on an older page/session.
      agentSessionCursor = 0;
      agentDetailPage = 0;
    }
  }

  /**
   * Reusable tab switch: resets navigation state so the new section starts at
   * its first item/page, and remembers the last non-Docs tab so the Docs
   * menu's "Back" item can restore it.
   */
  function switchSection(next: SectionId): void {
    if (getState().activeSection === next) return;
    if (next === 'docs') lastNonDocsSection = getState().activeSection;
    pickerActive = false;
    pickerCursor = 0;
    todoCursor = 0;
    docPage = 0;
    lastView = null;
    // Agents pane navigation is per-visit; reset so each entry starts clean.
    agentFocus = 'master';
    agentCursor = 0;
    agentSessionCursor = 0;
    agentDetailPage = 0;
    agentStatus = '';
    agentError = '';
    update((s) => ({ ...s, activeSection: next }));
  }

  /** Menu → "Back": Docs returns to the previous tab, Agents to the first tab. */
  function goBack(): void {
    const cur = getState().activeSection;
    if (cur === 'agents') switchSection('todo');
    else switchSection(lastNonDocsSection);
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
    if (dictationActive || dictationDiagText || dictationSnapshot().active) return; // ignore swipes while dictating / diag
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
    // Agents — master cursor moves the selection; detail browses stored sessions.
    if (getState().activeSection === 'agents') {
      if (agentFocus === 'master') {
        const n = getAgents().agents.length;
        if (!n) return;
        const next = Math.min(n - 1, Math.max(0, agentCursor + dir));
        if (next !== agentCursor) {
          agentCursor = next;
          agentSessionCursor = 0;
          agentDetailPage = 0;
          void renderGlasses();
        }
      } else {
        // Detail pane: ▼ (dir 1) pages FORWARD through the transcript and ▲
        // (dir -1) pages back. Page 0 is the newest turn and higher pages are
        // older turns, so this reads like the docs pager (newest first) and the
        // user lands on the answer when the pane opens.
        // Paging WRAPS across sessions: running past either end moves to the
        // older/newer stored session, so the whole history is reachable with
        // one gesture instead of needing a separate "browse sessions" mode.
        const agent = agentSelected();
        const n = agent
          ? getAgents().sessions.filter((s) => s.agentId === agent.id).length
          : 0;
        const next = agentDetailPage + dir;
        if (next >= 0 && next < agentDetailPages) {
          agentDetailPage = next;
          void renderGlasses();
          return;
        }
        if (n <= 1) return;
        const sNext = Math.min(n - 1, Math.max(0, agentSessionCursor + dir));
        if (sNext === agentSessionCursor) return;
        agentSessionCursor = sNext;
        // Enter the new session from the end the gesture came from.
        agentDetailPage = dir === 1 ? 0 : Number.MAX_SAFE_INTEGER;
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
      dictationStopAt = Date.now();
      void stopDictation();
      return;
    }
    // A dictation started elsewhere (web/phone MicButton) is active — the R1
    // ring tap stops it.
    if (!dictationActive && !dictationDiagText && dictationSnapshot().active) {
      void stopDictation();
      return;
    }
    if (pickerActive) {
      onPickerTap();
      return;
    }
    // Agents: tapping the master list moves control to the detail pane.
    if (getState().activeSection === 'agents') {
      if (agentFocus === 'master' && agentSelected()) {
        agentFocus = 'detail';
        agentSessionCursor = 0;
        agentDetailPage = 0;
        void renderGlasses();
      }
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

  // Any agents change (glasses edit, web edit, remote frame) re-renders.
  subscribeAgents(() => {
    void renderGlasses();
  });

  // Live run frames (server-side execution) re-render the detail pane so each
  // turn appears as it is produced, and settle the run into a session once.
  subscribeRuns(() => {
    const active = getRuns().find((r) => r.status === 'running');
    if (active && active.agentId === agentSelected()?.id) {
      agentRunning = true;
      agentStatus = active.statusText || 'Thinking…';
    }
    for (const run of getRuns()) settleRun(run);
    void renderGlasses();
  });

  // R1 ring / G2 touchpad: swipe up/down moves the todo cursor (or flips a
  // docs/notes page, or moves the doc picker), single tap toggles/opens, and
  // double-tap steps BACK (detail pane → master list) or, from the master
  // pane / any other tab, exits the app.
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
      if (itemID === MENU.BACK) {
        goBack();
        return;
      }
      if (itemID === MENU.AGENT_TRIGGER) {
        void agentsTrigger();
        return;
      }
      if (itemID === MENU.AGENT_STOP) {
        void agentsStop();
        return;
      }
      // Section switchers (To-Do / Docs / Notes / Agents) also cancel any picker.
      const def = sectionByMenuId(itemID);
      if (def) switchSection(def.id);
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
      // Double-tap is a BACK gesture first: while the Agents detail pane holds
      // the ring, return to the master list so the agent selection is
      // reachable again. Only when there is nowhere to go back to (master pane,
      // or any non-agents tab) does it shut the page down.
      if (getState().activeSection === 'agents' && agentFocus === 'detail') {
        agentFocus = 'master';
        void renderGlasses();
        return;
      }
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

  // When a dictation session starts from the web/phone UI, mirror it live on
  // the glasses (status + running text + R1 stop hint) until it ends.
  onDictationSnapshot(() => {
    const s = dictationSnapshot();
    if (s.active && !dictationActive && !dictationDiagText) void renderGlasses();
  });

  // Boot render (pairing screen or live state).
  await renderGlasses();
}

void main();
