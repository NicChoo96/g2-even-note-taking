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
  aiView,
  clipBytes,
  docPickerView,
  listenView,
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
  orderedAgents,
  uid,
  upsertDoc,
  type AgentDef,
  type DocEntry,
  type SectionId,
  type TodoItem,
} from './types';
import {
  cancelDictation,
  dictationSnapshot,
  dictationText,
  isDictating,
  lastDictationLog,
  lastDictationReason,
  onDictationSnapshot,
  releaseDictationMic,
  startDictation,
  stopDictation,
} from './dictate';
import {
  GLOBAL_PAGE,
  ackMonitor,
  aiAnswerConfirm,
  aiBegin,
  aiCancel,
  aiFlash,
  aiStep,
  getAi,
  getMonitorView,
  hasUndo,
  hydrateMemory,
  ingestMonitoredRuns,
  isAiMirrored,
  requestWebTab,
  runAiAgent,
  setAppBridge,
  subscribeAi,
  subscribeMonitor,
  undoLastAiBatch,
} from './ai';
import { isLiveStatus, requestRemoteConfirm, requestRemoteStop, startAiMirror } from './ai/sync';
import { mountUi } from './web/ui';

// ── Configuration ────────────────────────────────────────────────────────────
// G2 OS hard content cap: 999 UTF-8 bytes for BOTH createStartUpPageContainer
// and textContainerUpgrade (verified empirically — >999 bytes and the page is
// REJECTED, which is what "stopped sending" on big pastes). Every payload is
// byte-clipped to stay under it.
const CONTAINER_ID = 1;
const CONTAINER_NAME = 'main';

// Shown on the glasses while no credential is active — nobody has signed in and
// this device holds no pairing token. Signing in is the normal path on EVERY
// surface (including the Even App WebView); pairing is the opt-in fallback for a
// device that cannot sign in.
const SIGNIN_TEXT =
  'Sign in to start\n\nOpen the hub and sign in\nwith your Google account.\nOne account, every device.\n\nPairing is only for a device\nthat cannot sign in.\n\nControl with your R1 ring.';

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
  let closeAiMirror: (() => void) | null = null;
  let lastStreamToken: string | null = null;
  onStreamToken((token) => {
    if (token === lastStreamToken) return; // idempotent
    lastStreamToken = token;
    closeStream?.();
    closeStream = null;
    closeAgentsStream?.();
    closeAgentsStream = null;
    closeAiMirror?.();
    closeAiMirror = null;
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
    // Jarvis runs mirror across surfaces on their own channel PAIR: the run
    // snapshot out, directed Stop/confirm frames back. Started before the bridge
    // check on purpose — the browser panel needs to mirror a glasses-driven run
    // just as much as the glasses need to mirror a phone-driven one.
    closeAiMirror = startAiMirror();
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
  // Jarvis conversation memory. Hydrated here, next to the bridge call, because
  // the prompt build reads it SYNCHRONOUSLY on the first turn — a later load
  // would make the wearer's first question of a session forget the last one,
  // which is exactly the bug this exists to fix.
  void hydrateMemory();

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
  // Ring position of the Jarvis HUD, in the HUD's own scroll units: transcript
  // pages first, then one watched-session row each (see aiView). Clamped by the
  // view on every render, so it can never strand the ring past the last page.
  let aiScroll = 0;
  // While following, the HUD shows the NEWEST page — the point of a live run is
  // watching it think. The first ▲/▼ releases the pin and the position becomes
  // the wearer's: text must never scroll out from under a finger that is reading
  // it. Only `aiScroll` matters once this is false.
  let aiFollow = true;
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

  // ── Jarvis (AI dictation-agent mode) ──────────────────────────────────────
  // Same trigger, same speech engine, same listen-then-act flow as Dictate —
  // the ONLY difference is where the finished sentence goes. A plain Dictate
  // writes the words into the active section; Jarvis hands them to the model,
  // which then drives the app through the capability registry instead.
  //
  // Because both modes share one dictation session, the destination is a flag
  // captured when the session STARTS, not when it ends: the user can trigger
  // Stop AI mid-sentence and the utterance must not silently become a to-do.
  let dictationToAgent = false;
  /** Auto-hide timer for the terminal HUD states (done / error / undo flash). */
  let aiDismissTimer: number | null = null;

  // ── The Jarvis conversation (back-and-forth with the agent) ────────────────
  //
  // Talking to an assistant is a LOOP, not a transaction: ask, watch it think
  // and act, hear the answer, ask the follow-up. Without this the user has to
  // walk back to the contextual menu between every sentence, which is exactly
  // the friction that makes voice on glasses useless.
  //
  // So a Jarvis session stays OPEN. When a turn finishes the reply is HELD on
  // screen — the whole transcript, paged by the ring — and the mic is closed
  // until the wearer asks for it. Nothing is ever taken away mid-read.
  //
  // The exits are deliberate and few, so a session can never become a trap:
  //   • `Stop AI` (menu item #1, always present while a session is open) — ends
  //     the conversation AND cancels whatever the turn is doing.
  //   • double-tap — same, without a menu trip. It lands on the page underneath,
  //     which is what "go back to reading" means.
  // A single tap NEVER ends it — it TOGGLES: on a held answer it opens the mic,
  // while listening it sends, and a listening screen that heard nothing falls
  // back to the answer instead of re-opening the mic into silence.
  let jarvisSession = false;
  /**
   * True while a finished turn is HELD on screen: the reply and its whole
   * transcript are up, the mic is CLOSED, and no timer is running.
   *
   * This is what replaced the 2.4s auto re-arm. That pause was long enough to
   * glance at an answer and nowhere near long enough to read a run's transcript,
   * and because the listening screen replaces the HUD outright, the reply and
   * every step behind it were destroyed while the wearer was still reading.
   * Holding also makes the gestures unambiguous: tap toggles answer <-> mic, and
   * only a double-tap leaves the session.
   */
  let jarvisHolding = false;
  /** Consecutive turns that heard nothing, so a dead mic cannot loop forever. */
  let jarvisSilentTurns = 0;
  /** Give up re-arming after this many empty turns and explain why instead. */
  const JARVIS_MAX_SILENT = 2;

  /**
   * Hand the finished utterance to whichever mode started the session.
   * This is the single seam between "speech" and "what the words mean", and it
   * is deliberately the ONLY place the two modes diverge.
   */
  function deliverTranscript(text: string): void {
    if (dictationToAgent) void startAiRun(text);
    else commitSpeechToSection(text);
  }

  /**
   * Re-open the mic for the next sentence of the conversation.
   *
   * `jarvisHolding` is the flag that says whether the turn is parked (mic closed,
   * transcript up) or live; the listen screen plays the previous turn's feed in
   * both cases now, so clearing it here is what lets the live speech region take
   * the room it needs at the top instead of leaving half the pane to a reading
   * view nobody asked for.
   */
  function listenAgain(): void {
    if (!jarvisSession || isDictating()) return;
    jarvisHolding = false;
    startGlassesDictation(true);
  }

  /**
   * Put the finished turn back on screen with the mic CLOSED and no timer set.
   *
   * This is the resting state of a Jarvis conversation, and the reason a long
   * run is finally readable: the transcript stays up, the ring pages it, and
   * nothing happens until the wearer acts. It is also where a tap that heard
   * NOTHING lands (see the dictation idle handler), so a silent tap can never
   * turn the mic into a loop that talks to itself.
   */
  function holdReply(): void {
    clearAiTimer();
    jarvisHolding = true;
    void renderGlasses();
  }

  /** Stop the auto-hide timer for a terminal HUD state. */
  function clearAiTimer(): void {
    if (aiDismissTimer !== null) {
      window.clearTimeout(aiDismissTimer);
      aiDismissTimer = null;
    }
  }

  /**
   * Hide the Jarvis HUD and stop repainting it, whatever phase it is in.
   *
   * A run owned by the phone panel has to be stopped THERE: clearing only the
   * local mirror would blank the HUD while the loop on the other surface went on
   * executing tool calls the user thought they had just cancelled.
   *
   * Only a LIVE run needs telling, though. A finished mirror is dismissed
   * locally, because that is what its HUD footer promises ('tap = dismiss' — a
   * local act) and because cancelling on the owner would wipe a transcript and
   * reply the person holding the other surface may still be reading. A terminal
   * mirror evaporates on its own within MIRROR_TTL_MS anyway, so nothing is left
   * hanging by not reaching across.
   *
   * This is also one of the TWO ways a Jarvis conversation ends (the other is a
   * double-tap), so it always closes the session — a dismissal that left the
   * session open would re-arm the mic behind a HUD the user just dismissed.
   */
  function dismissAi(): void {
    jarvisSession = false;
    jarvisHolding = false;
    jarvisSilentTurns = 0;
    // The next run opens on its own newest page, not wherever this one was left.
    aiFollow = true;
    aiScroll = 0;
    clearAiTimer();
    // A conversation can be ended mid-sentence (Stop AI on the listening
    // screen). The mic must go with it — leaving it open would let the next
    // stray phrase start a fresh turn after the user thought they were done.
    // `dictationTapStop` marks this as a deliberate stop so the idle handler
    // does not follow up with the "heard nothing" diagnostics screen.
    if (dictationActive && dictationToAgent) {
      dictationTapStop = true;
      cancelDictation();
    }
    if (isAiMirrored() && isLiveStatus(getAi().status)) requestRemoteStop();
    aiCancel();
    void renderGlasses();
  }

  /**
   * Abandon the turn in flight but KEEP the conversation open (a tap on the
   * 'working' HUD). The user is stopping one action, not leaving — so the mic
   * comes straight back. The in-flight /api/llm request cannot be aborted, so
   * its later writes are dropped by aiCancel instead.
   */
  function stopTurnKeepTalking(): void {
    clearAiTimer();
    if (isAiMirrored() && isLiveStatus(getAi().status)) requestRemoteStop();
    aiCancel();
    void renderGlasses();
    listenAgain();
  }

  /** Put a one-off line on the HUD (undo confirmation) and fade it out. */
  function flashAi(text: string): void {
    aiFlash(text);
    clearAiTimer();
    aiDismissTimer = window.setTimeout(() => {
      aiDismissTimer = null;
      dismissAi();
    }, 5000);
    void renderGlasses();
  }

  /**
   * Run one Jarvis turn: focus follows the visible page, the agent loop drives
   * the registry, and the HUD mirrors every step.
   *
   * `unreachable: true` means the very first model call failed and NOTHING was
   * touched — the model may simply be misconfigured or offline. In that case we
   * fall back to plain dictation so the utterance still lands in the section
   * instead of vanishing: voice must never dead-end because the AI was down.
   */
  async function startAiRun(utterance: string): Promise<void> {
    clearAiTimer();
    pickerActive = false;
    aiFollow = true;
    const focus = getState().activeSection;
    aiBegin(utterance, focus);
    void renderGlasses();
    const res = await runAiAgent({ utterance, focus });
    // A dismissed/cancelled run must not repaint the HUD.
    if (getAi().status === 'idle') return;

    if (!res.ok && res.unreachable) {
      // Nothing at all happened and the model never answered (relay down, no
      // key, no network). The user already spoke a full sentence, so fall back
      // to plain dictation rather than throwing their words away — and clear
      // the agent flag so those words still travel the ONE write path.
      aiCancel();
      dictationToAgent = false;
      jarvisSession = false;
      deliverTranscript(utterance);
      void renderGlasses();
      return;
    }

    const status = getAi().status;
    if (status === 'done') {
      jarvisSilentTurns = 0;
      if (jarvisSession) {
        // HOLD the finished turn — see `jarvisHolding`. Nothing moves on its own
        // from here: the transcript stays up and the ring pages it. Re-arming the
        // mic on a timer is what used to wipe the reply mid-read.
        holdReply();
      } else {
        aiDismissTimer = window.setTimeout(() => {
          aiDismissTimer = null;
          dismissAi();
        }, 6000);
      }
    } else if (status === 'error') {
      // A failed turn is HELD for the same reason a good one is — the wearer has
      // to be able to read WHY — and holding is what makes retrying safe: the mic
      // no longer re-arms by itself into a relay that is still broken.
      if (jarvisSession) {
        holdReply();
      } else {
        aiDismissTimer = window.setTimeout(() => {
          aiDismissTimer = null;
          dismissAi();
        }, 6000);
      }
    }
    // A pending confirmation waits for the user indefinitely — tap to run the
    // action, or long-press → "Stop AI" to refuse it.
    void renderGlasses();
  }

  // The capability registry talks to the app through this bridge only, so it
  // never reaches into renderer internals (and the web panel can inject its own
  // bridge when there is no glasses bridge at all).
  setAppBridge({
    openPage: (page) => {
      if (page === GLOBAL_PAGE) return;
      if (page === 'settings') {
        // Settings is companion-UI only: API keys must never be reachable by
        // voice. Ask the web panel to surface it and leave the page alone.
        requestWebTab('settings');
        return;
      }
      requestWebTab(page);
      switchSection(page);
    },
    goBack: () => goBack(),
  });

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
    // Newest-updated agent first; the cursor indexes THIS order, so the render,
    // agentSelected() and the web panel always agree on who is highlighted.
    const list = orderedAgents(a.agents);
    const view = agentsMasterDetailView(
      {
        agents: list,
        sessions: a.sessions,
        cursor: agentCursor,
        focus: agentFocus,
        sessionCursor: agentSessionCursor,
        detailPage: agentDetailPage,
        status: agentStatus || agentsStatusLine(agentRunning, agentError),
        run: liveRunFor(list[agentCursor]?.id),
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
    const ai = getAi();
    return sectionMenu({
      section: st.activeSection,
      hasDocs: st.sections.docs.length > 0,
      hasAgents: getAgents().agents.length > 0,
      agentRunning: getRuns().some((r) => r.status === 'running'),
      // 'confirm' counts as running: the menu must keep offering a way OUT of
      // the HUD, since "Stop AI" is also how a destructive action is refused.
      aiRunning: ai.status === 'running' || ai.status === 'confirm',
      // A conversation with NO turn in flight (the mic is open, or the last reply
      // is still on screen). The menu then shows 'Stop AI' instead of 'Jarvis' so
      // the exit is always one long-press away, while 'Undo AI' stays reachable
      // between turns — that is the whole point of the flag being separate from
      // `aiRunning`.
      aiListening: jarvisSession && ai.status !== 'running' && ai.status !== 'confirm',
      aiUndo: hasUndo(),
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

  // R1-ring dictation: live speech pinned at the TOP of the canvas with the turn
  // behind it still readable underneath. Jarvis reuses this exact screen — same
  // trigger, same speech engine, same stop gesture — and only the head, the feed
  // and the footer change, so the user is never asked to learn a second voice
  // flow.
  //
  // The two halves used to be separate screens taking turns: opening the mic
  // REPLACED the HUD, which deleted the reply the wearer was still reading and
  // left the ring doing nothing at all, because a non-scrollable overlay
  // swallows the swipe. `listenView` puts both on one canvas under one cursor.
  function dictationView(): SectionView {
    if (dictationToAgent) return jarvisListenView();
    // Plain dictation has no feed, so it gets the same borders with the whole
    // pane given to the live transcript.
    return listenView({
      head: '>> Dictate',
      live: dictationInterim,
      status: dictationStatus || 'Starting mic…',
      ai: null,
      scroll: 0,
      footer: '● tap R1 = stop',
    });
  }

  /**
   * The Jarvis conversation screen. `scroll` overrides the ring position; left
   * undefined it resolves `aiFollow` the way every other render does.
   *
   * `dictationStatus` carries the mic instruction ("…· tap R1 to stop") because
   * it also feeds the plain-dictation screen. The footer here owns that
   * instruction, so the suffix is stripped rather than printed twice inside one
   * ten-line pane.
   */
  function jarvisListenView(scroll?: number): SectionView {
    return listenView({
      head: '>> Jarvis — listening',
      live: dictationInterim,
      status: dictationStatus.replace(/\s*·?\s*tap R1 to stop\s*$/i, '').trim() || 'Listening…',
      ai: getAi(),
      queue: getMonitorView(),
      // `aiFollow` means "track the newest", and the newest page is now unit 0.
      scroll: scroll ?? (aiFollow ? 0 : aiScroll),
      footer: 'tap R1 = send · Stop AI = end',
    });
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
    if (draft) deliverTranscript(draft);
    void renderGlasses();
  }

  /** Backstop watchdog: if a stop (R1 tap / Stop button) was requested but the
   *  engine hasn't finished within 18s, force-end so the user is never stuck.
   *  Dictation is tap-to-stop — no silence auto-stop. */
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
      // within 18s — the user must never be stuck in dictation. This has to
      // exceed the engine's own stop-flush budget (it waits up to 16s for an
      // in-flight Deepgram response), otherwise this backstop would commit
      // before the last phrase arrived and silently drop it.
      if (dictationStopAt && now - dictationStopAt > 18000) {
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

  /**
   * Contextual menu → Dictate / Jarvis: turn on the glasses/phone mic and show
   * live text. `toAgent` decides where the finished sentence goes — this is the
   * only behavioural difference between the two menu items.
   */
  function startGlassesDictation(toAgent = false): void {
    if (isDictating()) return; // already capturing
    pickerActive = false;
    pickerCursor = 0;
    dictationActive = true;
    dictationToAgent = toAgent;
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
          if (had) deliverTranscript(had);
          // A failed session must LET GO of the mic. Leaving the capture (or
          // `dictationActive`) alive here held the host mic open and blocked
          // every later trigger. Reset the overlay, close any session and
          // force the SDK mic off before showing the reason.
          dictationActive = false;
          dictationToAgent = false;
          jarvisSession = false;
          dictationStopAfter = 0;
          if (dictationTimer !== null) {
            window.clearInterval(dictationTimer);
            dictationTimer = null;
          }
          releaseDictationMic();
          dictationStatus = detail || 'Voice unavailable';
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
            deliverTranscript(draft);
          } else if (jarvisSession && dictationToAgent) {
            // The user tapped "send" (or the cap fired) but the engine heard
            // nothing. In a conversation that tap still means "I'm done, carry
            // on", so re-arm rather than dead-end on a diagnostics screen.
            //
            // A silent tap must NOT end the conversation: opening the
            // contextual menu can re-deliver presses as taps, and counting
            // those used to trip the "no audio" cut-off while the menu was
            // open — which flipped the menu item from 'Stop AI' back to
            // 'Jarvis', so the user's Stop tap restarted Jarvis instead. Only a
            // mic that has genuinely never heard anything (the engine's 90s
            // never-heard watchdog), repeatedly, gives up.
            jarvisSilentTurns += 1;
            const deadMic = /never-heard/.test(lastDictationReason());
            const prev = getAi().status;
            if (deadMic && jarvisSilentTurns > JARVIS_MAX_SILENT) {
              jarvisSession = false;
              dictationToAgent = false;
              flashAi('Jarvis off · no audio');
            } else if (prev === 'done' || prev === 'error') {
              // The tap heard nothing, and the previous turn is still in the
              // store: land back on it instead of re-opening the mic into
              // silence. An empty tap means "never mind", and the answer they
              // were reading is a better place to be than a live mic.
              holdReply();
            } else {
              listenAgain();
            }
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
    // Before anyone signs in (and with no pairing token), the glasses show
    // onboarding instead of an empty pasteboard.
    if (!getStreamToken()) {
      const text = SIGNIN_TEXT;
      if (!started) {
        const res = await createPage(text);
        started = res === StartUpPageCreateResult.success;
        if (started) setStartupReady();
        renderedText = text;
        if (!started) console.log('[hub] WARNING: startup page rejected (sign-in)');
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
    // the Jarvis agent HUD, or the normal renderer.
    const foreignActive = !dictationActive && !dictationDiagText && dictationSnapshot().active;
    const ai = getAi();
    const aiActive = ai.status !== 'idle';
    // Any of these takes over the WHOLE screen, so it must bypass the Agents
    // dual-pane renderer below (which otherwise wins and hides the overlay).
    // Priority matters: listening to the user outranks showing them the agent,
    // and a sticky diagnostic outranks everything.
    const overlayActive =
      pickerActive || dictationActive || !!dictationDiagText || foreignActive || aiActive;
    const view = pickerActive
      ? docPickerView(getState().sections.docs, pickerCursor, pickerIntent)
      : dictationActive
        ? dictationView()
        : dictationDiagText
          ? dictationDiagView()
          : foreignActive
            ? dictationForeignView()
            : aiActive
              ? aiView(ai, {
                  conversing: jarvisSession,
                  holding: jarvisHolding,
                  queue: getMonitorView(),
                  // `aiFollow` means "track the newest" — and the newest page is
                  // unit 0 now that the feed reads newest-first.
                  scroll: aiFollow ? 0 : aiScroll,
                })
              : sectionView(getState(), todoCursor, docPage);
    lastView = view;
    if (pickerActive) pickerCursor = view.todoCursor;
    else if (!overlayActive) todoCursor = view.todoCursor;
    // The HUD clamps its own scroll, so its answer wins: a transcript that grew
    // a page (or a queue that drained a row) would otherwise leave the stored
    // index pointing at a screen that no longer exists.
    if (aiActive) aiScroll = view.todoCursor;
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
    // Same ordered list the master pane renders — the cursor is an index into
    // it, not into the raw store array.
    const list = orderedAgents(getAgents().agents);
    if (!list.length) return null;
    return list[Math.min(list.length - 1, Math.max(0, agentCursor))];
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

  /**
   * Move the ring one scroll unit through the Jarvis feed, on whichever of the
   * two screens is currently showing it.
   *
   * The listen screen has a SHORTER body than the HUD (its top three lines are
   * live speech), so its pages are its own: the ring has to be resolved against
   * the view that is actually on screen, or one swipe in the HUD's units would
   * skip pages on the listen screen and land the wearer somewhere they did not
   * ask to be. Both views share `aiScroll`, so the position survives the switch
   * between them — and to a `confirm` prompt, which is the one screen with a job
   * and no spare attention.
   */
  function scrollJarvis(dir: -1 | 1): void {
    const ai = getAi();
    if (ai.status === 'idle' || ai.status === 'confirm') return;
    const q = getMonitorView();
    const listening = dictationActive && dictationToAgent;
    const build = (scroll: number): SectionView =>
      listening
        ? jarvisListenView(scroll)
        : aiView(ai, { conversing: jarvisSession, holding: jarvisHolding, queue: q, scroll });
    // Resolve where the ring ACTUALLY is first — while following the newest page
    // the stored index is stale by design — then move one unit from there. Asking
    // the VIEW rather than clamping here is what keeps this honest: only it knows
    // how many pages its own body produced, and a swipe at either end must be a
    // no-op instead of a redraw (a redraw costs a flicker).
    const here = build(aiFollow ? 0 : aiScroll);
    const view = build(here.todoCursor + dir);
    if (view.todoCursor === here.todoCursor) return;
    aiFollow = false;
    aiScroll = view.todoCursor;
    // Landing on a finished run IS the acknowledgement: there is no room on a
    // 10-line canvas for a separate dismiss, and a badge nobody can clear is a
    // badge that gets ignored.
    const start = view.sessionStart ?? -1;
    if (start >= 0 && aiScroll >= start) {
      const row = q.rows[aiScroll - start];
      if (row) ackMonitor(row.runId);
    }
    void renderGlasses();
  }

  function onSwipe(dir: -1 | 1): void {
    // The Jarvis listen screen IS scrollable. The mic owns the top of the canvas
    // but the reply underneath is still the wearer's to read while they compose
    // the next sentence, and refusing the swipe there was what made the two
    // halves feel like unrelated screens. Plain dictation has no feed behind it,
    // so its swipe is still swallowed — letting it through would scroll the page
    // under a screen the wearer is not looking at. The sticky diagnostic and the
    // phone-started mirror are non-scrollable by construction.
    if (dictationActive) {
      if (dictationToAgent) scrollJarvis(dir);
      return;
    }
    if (dictationDiagText || dictationSnapshot().active) return;
    if (getAi().status !== 'idle') {
      // …but the HUD is not opaque to the ring: its transcript is PAGED, and the
      // watched-run rows at the bottom of it belong to the wearer, so checking on
      // a background run mid-conversation must not cost them the conversation.
      scrollJarvis(dir);
      return;
    }
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
        // Wrap around: ▲ at the top cycles to the bottom and ▼ at the bottom
        // cycles to the top, so the list never dead-ends at an edge.
        const next = (agentCursor + dir + n) % n;
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
    // The Jarvis HUD owns the screen while a run is live, so it gets first
    // refusal on the tap. Three distinct meanings, all discoverable from the
    // footer the HUD prints:
    //   confirm → run the destructive action (the HUD shows the target first)
    //   running → stop; the in-flight request can't be aborted, so its later
    //             writes are dropped instead (see aiCancel)
    //   done/error → dismiss
    //
    // A MIRRORED run (started on another surface) answers through the relay in
    // every one of those cases — this device has no loop to run or cancel, so a
    // local answer would either do nothing or blank a run that is still going.
    //
    // A mirrored CONFIRM cancels (approve === false), it does NOT approve. Two
    // reasons: the owner is holding a screen that shows explicit Approve/Decline
    // buttons, so consent for a destructive action belongs there; and a tap is
    // the easiest gesture to trigger by accident, which must never be what
    // deletes data. This is exactly what the HUD footer promises the wearer:
    // `from phone · tap = cancel`. Approving here would silently do the
    // opposite of the instruction printed on the lens.
    const ai = getAi();
    if (ai.status === 'confirm') {
      if (ai.mirrored) requestRemoteConfirm(false);
      else aiAnswerConfirm(true);
      void renderGlasses();
      return;
    }
    if (ai.status === 'running') {
      // In a conversation, stopping the ACTION is not leaving the conversation:
      // the mic comes straight back so the user can rephrase. Only Stop AI and
      // a double-tap end the session.
      if (jarvisSession) stopTurnKeepTalking();
      else dismissAi();
      return;
    }
    // Dictation owns the tap whenever the mic is open — INCLUDING the Jarvis
    // conversation's listening phase, where the store still holds the previous
    // turn's terminal status. Checking `done`/`error` first would turn the
    // "send this sentence" tap into "dismiss the HUD" and silently drop the
    // command the user just spoke.
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
    // A tap dismisses the sticky dictation diagnostics screen.
    if (dictationDiagText) {
      dictationDiagText = '';
      void renderGlasses();
      return;
    }
    // A dictation started elsewhere (web/phone MicButton) is active — the R1
    // ring tap stops it.
    if (!dictationActive && !dictationDiagText && dictationSnapshot().active) {
      void stopDictation();
      return;
    }
    if (ai.status === 'done' || ai.status === 'error') {
      // A tap on a HELD answer opens the mic again. It is the exact pair to the
      // tap that sent the sentence, so a conversation toggles between "read
      // this" and "say the next thing" with no menu trip — and leaving is the
      // double-tap (or Stop AI), never the same gesture as speaking. `error` is
      // included so a failed turn can be retried by hand rather than stranding
      // the wearer on a dead HUD.
      if (jarvisSession) listenAgain();
      else dismissAi();
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

  // Every Jarvis step (routing, action, result, confirm prompt) repaints the
  // HUD. Renders are coalesced serially in renderGlasses(), so a burst of
  // steps can never overlap a create/rebuild.
  subscribeAi(() => {
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
    // The runs Jarvis itself asked for are being WATCHED: keep their HUD rows
    // current, and when one lands, tell the model. This handler is the only
    // place a run's terminal frame reaches the queue, so it is also the only
    // place the wearer can be told — and the notification is a line in the next
    // turn's context, not a tool call, because there is nothing to decide.
    for (const done of ingestMonitoredRuns(getRuns())) {
      const line = `${done.agentName} ${done.status}`;
      // Mid-turn: drop it into the step list so the HUD (and the model's own
      // memory of what happened) carries it. Idle: nothing is drawn, so the
      // queue flag alone is the channel — the next sentence will say it.
      if (getAi().status !== 'idle') aiStep('note', line);
      console.log('[hub] watched run settled', { run: done.runId, line });
    }
    void renderGlasses();
  });

  // The queue repaints the HUD on its own: a run can be enqueued or settle while
  // no run frame and no AI step is in flight (an agent started from the phone
  // panel, say), and a badge the wearer cannot see is not a notification.
  subscribeMonitor(() => {
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
      // Jarvis — same mic, same stop gesture, different destination. Kept as a
      // SEPARATE menu item so plain Dictate can never change behaviour under a
      // user who only ever wanted their words typed into the section.
      //
      // Choosing Jarvis opens a CONVERSATION rather than a one-shot command: the
      // session flag is what makes startAiRun re-arm the mic after each reply, so
      // the follow-up question needs no menu trip. Only this entry point sets it
      // — a Jarvis run started from the phone panel stays a single turn here.
      if (itemID === MENU.JARVIS) {
        // Defensive: if a session or run is somehow still live (the OS may
        // re-render the menu), treat this as Stop rather than stacking a second
        // Jarvis on top of the one the user was trying to end.
        if (jarvisSession || getAi().status !== 'idle') {
          dismissAi();
          return;
        }
        jarvisSession = true;
        jarvisHolding = false;
        jarvisSilentTurns = 0;
        startGlassesDictation(true);
        return;
      }
      if (itemID === MENU.JARVIS_STOP) {
        // Also serves as the "no" answer to a pending destructive action, which
        // is why it is offered during the confirm phase too. And because it
        // clears the conversation flag it is the menu exit from a live Jarvis
        // conversation — the HUD footer also offers it as `Stop = cancel`.
        dismissAi();
        return;
      }
      if (itemID === MENU.UNDO_AI) {
        const label = undoLastAiBatch();
        flashAi(label ? `Undid: ${label}` : 'Nothing to undo');
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

    // Only a REAL system event may drive input handling. `CLICK_EVENT` is 0,
    // so defaulting a missing `sysEvent` to 0 (as this used to) misreads EVERY
    // non-system event — most importantly each audio frame while dictating —
    // as a tap. That fired onTap() ~10x/second, which stopped the mic about
    // 1.7s in (once the tap-grace window expired) and looked like dictation
    // "self-stopping after 2 seconds". Audio frames carry only `audioEvent`.
    const sys = event.sysEvent;
    if (!sys) return;
    // A single press is documented as arriving as a sysEvent whose `eventType`
    // is undefined, so `?? 0` is correct HERE — inside a real sysEvent — but
    // never for the event as a whole.
    const sysType = sys.eventType ?? OsEventTypeList.CLICK_EVENT;
    if (sysType === OsEventTypeList.CLICK_EVENT) {
      onTap();
      return;
    }
    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      // While the Jarvis HUD is up, double-tap means "get me out of here" —
      // NOT shut the page down. Exiting mid-run would tear down the JS context
      // that is driving the action loop, leaving the model's work half applied
      // with no HUD to explain it.
      //
      // From a HELD answer this is the "back to reading" gesture the HUD footer
      // promises (`2x = read`): the session closes and the page underneath comes
      // straight back. It has to cover the listening phase too — `dictationActive`
      // is false while holding, and during the toggling the store may still be
      // `done` from the previous turn, so neither flag alone is enough; a
      // double-tap would otherwise shut the whole app down mid-conversation.
      if (getAi().status !== 'idle' || jarvisSession) {
        dismissAi();
        return;
      }
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
      // A run that was mid-flight when the app went to the background cannot be
      // trusted to still be alive (the WebView may have been torn down), and a
      // HUD frozen on "working 2/6" forever is worse than losing the turn. The
      // capability writes it already made are durable and revertible via
      // "Undo AI", so nothing is silently lost.
      //
      // A Jarvis CONVERSATION must SURVIVE a brief round trip: opening the
      // contextual menu can re-deliver a foreground-enter, and dismissing here
      // was what ended Jarvis "by itself" while the menu was open — flipping the
      // first item back to 'Jarvis' so the Stop tap restarted it. Keep the
      // session; if the mic did die with the page, re-arm it instead.
      if (jarvisSession) {
        // A HELD answer survives the round trip: opening the contextual menu is
        // a look, not a "carry on", and re-arming the mic would replace the
        // transcript the wearer came back to read with a listening screen.
        if (!jarvisHolding && !dictationActive && !dictationSnapshot().active) listenAgain();
      } else if (getAi().status === 'running') {
        aiCancel();
      }
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
