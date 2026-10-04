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
import { connectAgentsStream, connectStream, startRun, stopRun, type AgentRun, type HubChanged } from './stream';
import { isOwnEcho } from './client-id';
import { snapshotForRun } from './location/run';
import { probeLocation } from './location/probe';
import { getRuns, isAgentRunning, latestRunFor, subscribeRuns } from './agent-runs';
import {
  agentsMasterDetailView,
  agentsStatusLine,
  aiView,
  clipBytes,
  docsPanelView,
  docPickerView,
  listenView,
  MAX_CONTENT_BYTES,
  MENU,
  PANEL_LAYOUT,
  sectionByMenuId,
  sectionMenu,
  sectionView,
  signInView,
  type PanelLevel,
  type SectionView,
} from './sections';
import {
  addDoc,
  addTask,
  appendDoc,
  appendNote,
  applyRemote,
  getState,
  hubReady,
  loadHub,
  noteServerHandshake,
  refreshSection,
  removeDoc,
  seedIfEmpty,
  selectDoc,
  selectSection,
  setConnStatus,
  setTaskDone,
  startHubLiveSync,
  subscribe,
  update,
} from './store';
import {
  applyRemoteAgents,
  getAgents,
  hydrateAgentsDurable,
  hydrateHubSessions,
  loadAgents,
  recordSession,
  setAgentsConn,
  subscribeAgents,
} from './agents-store';
import { getStreamToken, onStreamToken } from './auth-token';
import { getPairCode, onPairCode } from './pair-code';
import {
  getDurableBridge,
  loadDocsDurable,
  saveDocsDurable,
  setDurableBridge,
  setStartupReady,
} from './durable-docs';
import {
  activeDoc,
  orderedAgents,
  type AgentDef,
  type DocEntry,
  type SectionId,
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
import { startLedgerMirror } from './ai/ledger-sync';
import { mountUi } from './web/ui';

// ── Configuration ────────────────────────────────────────────────────────────
// G2 OS hard content cap: 999 UTF-8 bytes for BOTH createStartUpPageContainer
// and textContainerUpgrade (verified empirically — >999 bytes and the page is
// REJECTED, which is what "stopped sending" on big pastes). Every payload is
// byte-clipped to stay under it.
const CONTAINER_ID = 1;
const CONTAINER_NAME = 'main';

// The page shown while no credential is active is `signInView(code)` in
// sections.ts, next to the line/byte limits it has to respect. It is a function
// rather than a constant here because it carries the LIVE pending pairing code:
// signing in is the normal path on every surface (including the Even App
// WebView), pairing is the opt-in fallback — and while it is pending the code has
// to be legible on the lens, which is the whole point of it being there.

/** Diagnostic logging only — the phone screen stays clean (just the web UI). */
function setStatus(line: string): void {
  console.log('[hub]', line);
}

/**
 * A PEER device changed a hub collection (§2.4).
 *
 * OUR OWN WRITE COMES BACK TOO. The relay fans the frame out over the `hub`
 * channel without being able to ask "which of these sockets is the writer?", so
 * it echoes the writer's client id on the frame instead and the drop happens
 * here. Ignoring our own echo is what keeps a save from costing its author a
 * pointless round trip — and, for a document, from repainting the body
 * underneath the cursor that is still typing in it.
 *
 * An ABSENT origin is NOT a match: it means the relay could not say who wrote,
 * and delivering the refresh is far better than silently missing a peer's edit.
 *
 * Agents are the one collection this crosses over for, because they live in
 * `agents-store.ts` rather than in `store.ts`; everything else goes to
 * `refreshSection`, which knows which collections the hub state actually owns.
 */
function onPeerHubChange(changed: HubChanged): void {
  if (isOwnEcho(changed.origin)) return;
  if (changed.path === '/agents') {
    void loadAgents();
    return;
  }
  refreshSection(changed.path);
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
  // Catch up whenever this page comes back to the foreground: a nudge can only
  // arrive while the stream is open, and the relay replays nothing. Idempotent.
  startHubLiveSync();
  // The app opens on the AGENT page: one redirect, fired once the hub's first
  // load has settled.
  //
  // It cannot be a default in `emptyHubState()` — the hub snapshot is
  // authoritative for `activeSection` (`adopt()` replaces local state
  // wholesale), so a default would be overwritten by the very first snapshot and
  // would also fight the web companion, which legitimately writes the document
  // it is reading into that same field. A one-shot redirect after the load is
  // authoritative regardless of what the server stored.
  let bootRedirected = false;
  function bootRedirect(): void {
    if (bootRedirected) return;
    bootRedirected = true;
    if (getState().activeSection !== 'agents') switchSection('agents');
  }
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
      onHubChanged: (changed) => onPeerHubChange(changed),
      onStatus: (s) => {
        setStatus(`📡 SSE ${s}`);
        setConnStatus(s);
      },
      // A handshake with `state: null` means the relay is empty — only then may
      // this client seed it from its local copy.
      onHandshake: (hasSnapshot) => noteServerHandshake(hasSnapshot),
    });
    // Agents ride a SEPARATE channel so agent/session payloads never bloat the
    // HubState frame (and API keys never ride either). It carries SESSIONS only
    // now — the agent and tool catalogue is read from the hub like every other
    // collection — and it is on the way out for the same reason.
    closeAgentsStream = connectAgentsStream({
      onState: (next) => applyRemoteAgents(next),
      onStatus: (s) => setAgentsConn(s),
    });
    // Jarvis runs mirror across surfaces on their own channel PAIR: the run
    // snapshot out, directed Stop/confirm frames back. Started before the bridge
    // check on purpose — the browser panel needs to mirror a glasses-driven run
    // just as much as the glasses need to mirror a phone-driven one.
    closeAiMirror = startAiMirror();
    // Live agent runs are TRANSIENT frames on the same channel: a run executes
    // in the relay, so the detail pane streams even if this page was
    // backgrounded mid-run. `subscribeRuns` (below) owns that connection.
    //
    // BOOT READS, once the credential exists — the relay refuses an
    // unauthenticated principal, so these cannot run earlier. Each is ONE
    // request and neither is ever polled: `GET /hub` inlines every document's
    // complete body (~63 KB in this deployment) and `GET /hub/agents` carries
    // the agents, the tools AND the llm block together. A second pairing
    // re-enters here, which is what makes a re-credentialed device resync.
    void loadHub();
    void loadAgents();
    // …plus a fallback, so an unreachable relay still opens on Agents instead of
    // stranding the wearer on whatever section the local cache happened to hold.
    window.setTimeout(() => bootRedirect(), 2500);
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

  // A one-shot location DIAGNOSTIC, reachable as `__hubGeoProbe()` from the
  // phone app's dev console (Developer Mode) and by the Settings tab's "Run
  // location check" button in the companion UI. It is installed BEFORE the
  // early return below so it also exists in the web-UI-only case, which is
  // exactly when the answer is most confusing.
  //
  // Deliberately NOT a contextual-menu item and NOT a gesture: the glasses menu
  // is full, its order is asserted by harnesses (menu-sim / ai-agent-sim), and a
  // new tap target would sit in the middle of the input path that dictation
  // depends on. It reports the two routes and touches no app state, so it can
  // never be mistaken for a real fix. Remove this block and probe.ts together.
  (window as unknown as { __hubGeoProbe?: () => Promise<unknown> }).__hubGeoProbe = async () => {
    const report = await probeLocation({ hub: getDurableBridge() });
    console.log('[geo] sdk:', report.hub.detail);
    console.log('[geo] web:', report.browser.detail);
    // On the glasses the console is invisible, so the same answer goes on the
    // lens through the existing one-off flash (it fades on its own).
    if (getDurableBridge()) flashAi(report.summary);
    return report;
  };

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
      // CACHE-RESTORE ONLY, and only before the hub has answered. Once it has,
      // the hub is the authority: painting a device-local copy over it would
      // resurrect docs deleted elsewhere — and since nothing writes this frame
      // back to the hub, the resurrected list would silently never save.
      if (!hubReady() && saved && saved.length && getState().sections.docs.length === 0) {
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
  // …and then the hub, which is the authority for WHICH sessions exist. It runs
  // after the durable read so the local cache is already in place to merge into.
  void hydrateHubSessions();
  // Jarvis conversation memory. Hydrated here, next to the bridge call, because
  // the prompt build reads it SYNCHRONOUSLY on the first turn — a later load
  // would make the wearer's first question of a session forget the last one,
  // which is exactly the bug this exists to fix.
  void hydrateMemory();
  // The run ledger is the one thing here that is written BACK rather than read:
  // it is transient in-memory state, so without this every run's record died
  // with the tab. Not awaited — it mirrors on its own schedule, and a slow first
  // flush must never delay the first frame. It also never throws, so there is
  // nothing to catch, and it is started once for the lifetime of the app: the
  // stop handle exists for tests, not for a boot path that has no counterpart.
  startLedgerMirror();

  let started = false; // createStartUpPageContainer called exactly once
  let renderedText = '';
  // Signature of the contextual menu currently installed on the page. The OS
  // menu is swapped wholesale via rebuildPageContainer, so we rebuild ONLY when
  // this changes (entering/leaving Docs, or docs count crossing 0) — ordinary
  // content updates still use flicker-free textContainerUpgrade.
  let appliedMenuSig = '';
  /**
   * Signature of the pane layout currently installed on the page.
   *
   *   'single'  one container, a plain page (todo / notes / sign-in / HUD)
   *   'dual'    the level-2 split of a panel — list + detail
   *   'pane'    a panel showing ONE of its panes full-canvas (levels 1 and 3)
   *
   * The three are distinct because the container COUNT differs, and a page's
   * container count can only change through rebuildPageContainer.
   */
  let appliedLayout: 'single' | 'dual' | 'pane' = 'single';
  /** Focus+cursor+border signature of the panel pane layout. */
  let appliedPanelSig = '';
  let todoCursor = 0; // selected todo row
  let docPage = 0; // current page of the docs/notes body
  // Docs tab — the same three-level panel as Agents (see PanelLevel). The list
  // cursor IS the open document: the ring highlights a title and `selectDoc`
  // makes it the hub's activeDocId, so the level-2 preview and the level-3 body
  // always describe the document the wearer is actually looking at.
  let docLevel: PanelLevel = 1;
  let docCursor = 0;
  /** Pages the last docs render produced — bounds the level-3 paging swipes. */
  let docPages = 1;
  // Ring position on the Files page. Separate from docPage because Files is a
  // cursor window over a list, not a page-flip body — and it is reset on every
  // section change, since the list is refreshed from outside and an index from
  // a previous visit could point past the end.
  let filesCursor = 0;
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

  // Agents tab — the same three-level panel as Docs (see PanelLevel): a list,
  // the list plus the selected agent's output, then that output alone. ONE ring
  // tap steps in, one double tap steps back, and at level 1 a double tap has
  // nowhere left to go so it exits. Only ONE container may be isEventCapture:1,
  // so the ring is routed by the LEVEL, never by which container got the event.
  let agentLevel: PanelLevel = 1;
  let agentCursor = 0;
  /**
   * A LOCAL note about the LAST trigger, for one agent only:
   *   • the optimistic "Thinking…" between asking for a run and the relay's
   *     first run frame for it, and
   *   • a trigger that never became a run at all (offline, 401, no API key).
   *
   * Nothing else about run state is held here. Whether an agent is running, its
   * status text and its error all come from the run store, resolved per agent.
   * This page used to keep ONE `agentRunning`/`agentStatus`/`agentError` triple
   * for the whole tab, which is what let the detail pane keep streaming one
   * agent's run while another one was highlighted — and what stopped a second
   * agent from being triggered at all while the first was in flight.
   */
  let agentNotice: { agentId: string; status?: string; error?: string } | null = null;
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

  // A pending pairing code is drawn ON the sign-in page, so a change to it is a
  // reason to repaint. Registered here rather than up with the other
  // subscriptions because a render is what this wakes, and both `renderGlasses`
  // and the render lock it reads only exist once the bridge has resolved.
  onPairCode(() => {
    void renderGlasses();
  });

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
   * One pane of a panel. `focused` gives it the 2px selection frame AND the
   * event capture — exactly one container on a page may be isEventCapture:1, so
   * these two facts are never allowed to drift apart.
   *
   * `framed` is false for the levels where the pane is the whole canvas: a frame
   * there would only take width from the text inside it, and there is no second
   * pane left to be told apart from.
   */
  function pane(
    id: number,
    name: string,
    x: number,
    width: number,
    content: string,
    focused: boolean,
    framed: boolean,
  ): TextContainerProperty {
    return new TextContainerProperty({
      xPosition: x,
      yPosition: 0,
      width,
      height: PANEL_LAYOUT.height,
      borderWidth: framed && focused ? 2 : 0,
      borderColor: 5,
      borderRadius: 0,
      paddingLength: 4,
      containerID: id,
      containerName: name,
      isEventCapture: focused ? 1 : 0,
      content: clipBytes(content, MAX_CONTENT_BYTES),
    });
  }

  /**
   * Pane for one side of the level-2 split: left x0 w200, right x208 w368, a 4px
   * gutter either side of the right pane.
   */
  function splitPanes(master: string, detail: string): TextContainerProperty[] {
    return [
      pane(1, 'master', PANEL_LAYOUT.splitMasterX, PANEL_LAYOUT.splitMasterW, master, true, true),
      pane(2, 'detail', PANEL_LAYOUT.splitDetailX, PANEL_LAYOUT.splitDetailW, detail, false, true),
    ];
  }

  /**
   * The panes the Agents panel shows at `agentLevel`:
   *   1  the agent list ALONE, full canvas
   *   2  list + output pane side by side
   *   3  the output ALONE, full canvas
   *
   * The ring is on the list at levels 1–2 and on the output at level 3, so the
   * event-capturing pane follows the level. Levels 1 and 3 are a single
   * container: the layout is rebuilt whenever the level changes, because a
   * page's container count is only settable through rebuildPageContainer.
   */
  function agentContainers(): TextContainerProperty[] {
    const a = getAgents();
    // Newest-updated agent first; the cursor indexes THIS order, so the render,
    // agentSelected() and the web panel always agree on who is highlighted.
    const list = orderedAgents(a.agents);
    // Clamp BEFORE reading the selection. The renderer clamps too, but reading
    // `list[agentCursor]` unclamped picked the wrong agent's run whenever the
    // cursor outlived the list it pointed at (an agent deleted on the phone, a
    // list that shrank after a sync).
    const cur = list.length ? Math.min(list.length - 1, Math.max(0, agentCursor)) : 0;
    const selected = list[cur] ?? null;
    // Resolve the run PER AGENT — never "the newest run anywhere". That fallback
    // was the leak: moving the master cursor to a second agent left the right
    // pane painting the first agent's live transcript, because the lookup fell
    // back to whichever run this client last started.
    const live = latestRunFor(selected?.id);
    const notice = agentNotice && agentNotice.agentId === selected?.id ? agentNotice : null;
    const view = agentsMasterDetailView(
      {
        agents: list,
        sessions: a.sessions,
        cursor: agentCursor,
        level: agentLevel,
        sessionCursor: agentSessionCursor,
        detailPage: agentDetailPage,
        // Precedence: a local note (the gap before the relay's first frame, or a
        // trigger that never ran) > the run's own status text > nothing.
        status: notice
          ? notice.status || agentsStatusLine(false, notice.error)
          : live && live.status === 'running'
            ? live.statusText || 'Thinking…'
            : '',
        run: live,
        // Every agent with a run in flight, so a run that keeps going while you
        // browse a neighbour is visible in the master list instead of only in
        // the pane your cursor happens to be parked on.
        runningAgentIds: getRuns()
          .filter((r) => r.status === 'running')
          .map((r) => r.agentId),
      },
      (id) => a.tools.find((t) => t.id === id)?.name ?? id,
    );
    agentCursor = view.cursor;
    agentSessionCursor = view.sessionCursor;
    agentDetailPage = view.detailPage;
    agentDetailPages = view.detailPages;
    if (agentLevel === 3) {
      return [pane(1, 'detail', PANEL_LAYOUT.fullX, PANEL_LAYOUT.fullW, view.detail, true, false)];
    }
    if (agentLevel === 1) {
      return [pane(1, 'master', PANEL_LAYOUT.fullX, PANEL_LAYOUT.fullW, view.master, true, false)];
    }
    return splitPanes(view.master, view.detail);
  }

  /**
   * The panes the Docs panel shows at `docLevel` — the same three states as the
   * Agents panel: the document list alone, list + body, then the body alone.
   *
   * The list cursor IS the open document (`selectDoc` commits it), so the body
   * this pane shows is always the one the highlighted title names. An empty
   * bookshelf has nothing to split, so it stays one pane however deep the level
   * says we are.
   */
  function docContainers(): TextContainerProperty[] {
    const view = docsPanelView(getState(), docCursor, docPage, docLevel);
    docCursor = view.cursor;
    docPage = view.page;
    docPages = view.pages;
    const list = pane(1, 'master', PANEL_LAYOUT.fullX, PANEL_LAYOUT.fullW, view.master, true, false);
    if (!view.hasDoc || docLevel === 1) return [list];
    if (docLevel === 3) {
      return [pane(1, 'detail', PANEL_LAYOUT.fullX, PANEL_LAYOUT.fullW, view.detail, true, false)];
    }
    return splitPanes(view.master, view.detail);
  }

  /**
   * The panes to paint for the section on screen, or null when it is an
   * ordinary single-container page. Calling this is what clamps and stores the
   * panel cursors, so the render path only ever gets them from here.
   *
   * An overlay (HUD, dictation, picker, diagnostics) owns the whole canvas, so
   * it never goes through this — and its panes are not built, because building
   * them would move a cursor that is not on screen.
   */
  function panelPanes(section: SectionId): TextContainerProperty[] | null {
    if (section === 'agents') return agentContainers();
    if (section === 'docs') return docContainers();
    return null;
  }

  /** Contextual menu for the current state (docs/agents actions in their tabs). */
  function currentSectionMenu(): MenuContainerProperty {
    const st = getState();
    const ai = getAi();
    return sectionMenu({
      section: st.activeSection,
      hasDocs: st.sections.docs.length > 0,
      hasAgents: getAgents().agents.length > 0,
      agentRunning: isAgentRunning(agentSelected()?.id),
      // 'confirm' counts as running: the menu must keep offering a way OUT of
      // the HUD, since "Stop AI" is also how a destructive action is refused.
      aiRunning: ai.status === 'running' || ai.status === 'confirm',
      // A conversation with NO turn in flight (the Jarvis mic is open, or the
      // last reply is still on screen). The menu then shows 'Stop AI' instead of
      // 'Jarvis' so the exit is always one long-press away, while 'Undo AI' stays
      // reachable between turns — that is the whole point of the flag being
      // separate from `aiRunning`.
      //
      // Derived from what is actually ON SCREEN, not from the session flag alone.
      // Left as `jarvisSession && !running` it advertised 'Stop AI' over a plain
      // section page whenever the store fell to `idle` underneath a live session
      // flag (a cross-surface frame overwriting the HUD, say): the wearer tapped
      // Stop, nothing happened, and the only way back to the page was a
      // double-tap. A phantom session now reads as plain 'Jarvis', and tapping
      // that ends it through the defensive branch in the menu handler.
      aiListening: jarvisSession && (
        (dictationActive && dictationToAgent) ||
        ai.status === 'done' ||
        ai.status === 'error'
      ),
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
   * Identity of a panel layout: each pane's name, geometry, capture flag and
   * rendered text. A change means the page must be rebuilt — the border that
   * marks the focused pane, the pane COUNT and the container names are all only
   * settable on create/rebuild.
   */
  function panelSignature(containers: TextContainerProperty[]): string {
    return containers
      .map(
        (c) =>
          `${c.containerID}:${c.containerName}:${c.xPosition}:${c.width}:${c.borderWidth}:${c.isEventCapture}:${c.content ?? ''}`,
      )
      .join('|');
  }

  /** Which level the panel on screen is showing (both panels share one model). */
  function panelLevel(): PanelLevel {
    return getState().activeSection === 'docs' ? docLevel : agentLevel;
  }

  /**
   * First frame only. `panes` are the panel's containers when the tab that is
   * showing is a panel, and null for every ordinary single-container page — the
   * caller has already built them, so this must not build them a second time.
   */
  async function createPage(
    content: string,
    panes: TextContainerProperty[] | null = null,
  ): Promise<StartUpPageCreateResult> {
    const menu = currentSectionMenu();
    const containers = panes ?? [textContainer(content)];
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
      appliedLayout = panes ? (panes.length === 2 ? 'dual' : 'pane') : 'single';
      appliedPanelSig = panes ? panelSignature(containers) : '';
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
      addTask(text);
      return;
    }
    if (st.activeSection === 'notes') {
      appendNote(text);
      return;
    }
    if (st.activeSection === 'files') {
      // Files holds REMOTE references (id + URL), so there is nothing here the
      // glasses can append to. Without this branch the fall-through below would
      // quietly stuff the utterance into whichever Doc is open — a write to a
      // page the wearer is not looking at. Notes is the app's free-text
      // scratchpad, so that is where unsolicited speech is kept instead.
      appendNote(text);
      console.log('[hub] dictation on Files kept in Notes (remote refs are not editable here)');
      return;
    }
    // Docs — append to the open doc, or create one titled from the first line.
    const cur = activeDoc(st);
    if (cur) {
      appendDoc(cur.id, text);
      return;
    }
    const firstLine = text.split('\n')[0].trim().slice(0, 28) || 'Voice note';
    addDoc(firstLine, text);
  }

  async function doRender(): Promise<void> {
    // Before anyone signs in (and with no pairing token), the glasses show
    // onboarding instead of an empty pasteboard.
    if (!getStreamToken()) {
      const text = signInView(getPairCode());
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
    // pagination at page 1 and moves the panel highlight onto it.
    if (!pickerActive) {
      const curDocId = getState().activeSection === 'docs' ? getState().activeDocId : null;
      if (curDocId !== lastActiveDocId) {
        lastActiveDocId = curDocId;
        docPage = 0;
        // The list cursor IS the open document on this panel, so a doc opened
        // from anywhere else (web companion, long-press picker, or dictation
        // creating one) has to move the highlight with it — otherwise the ring's
        // next step would re-open the document that is already on screen.
        const idx = getState().sections.docs.findIndex((d) => d.id === curDocId);
        if (idx >= 0) docCursor = idx;
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
    // Docs and Agents paint their own panes. Built here, once per render, so the
    // cursors they clamp are stored exactly once and the same containers are
    // reused for the startup page and for every rebuild below. Null while an
    // overlay is up: an overlay is one container, and moving a panel cursor
    // behind it would move the ring on a screen that is not showing.
    const panes = overlayActive ? null : panelPanes(getState().activeSection);
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
              : sectionView(getState(), todoCursor, docPage, filesCursor);
    lastView = view;
    if (pickerActive) pickerCursor = view.todoCursor;
    else if (!overlayActive) {
      // The view clamps its own cursor (a list can shrink under the ring), so
      // its answer wins. It is ONE cursor per view though, and the Files page
      // keeps its position in that same field, so route it back to the page
      // that actually owns it — otherwise walking the file list would drag the
      // To-Do selection along with it.
      if (getState().activeSection === 'files') filesCursor = view.todoCursor;
      else if (!panes) todoCursor = view.todoCursor;
    }
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
      const res = await createPage(text, panes);
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

    // A panel tab (Docs or Agents) paints its own panes. The pane BORDERS encode
    // which pane owns the ring, and a border — like the pane COUNT, which differs
    // between levels 1/3 (one full-canvas container) and level 2 (two) — is only
    // settable through rebuildPageContainer, so any level or cursor change is a
    // rebuild. Skipped while an overlay is up: those render as one container.
    if (panes) {
      const psig = panelSignature(panes);
      const want = panes.length === 2 ? 'dual' : 'pane';
      if (appliedLayout !== want || psig !== appliedPanelSig || sig !== appliedMenuSig) {
        const ok = await b.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: panes.length,
            textObject: panes,
            menuObject: menu,
          }),
        );
        // The signature carries every pane's content — log enough of it to see
        // what the panes actually show, and the level, when debugging.
        console.log(
          '[hub] rebuildPageContainer (panel) ->',
          ok,
          getState().activeSection,
          panelLevel(),
          psig.slice(0, 240),
        );
        if (ok) {
          appliedLayout = want;
          appliedPanelSig = psig;
          appliedMenuSig = sig;
          renderedText = text;
        }
      }
      return;
    }

    // Left the panel tab (or a non-panel view is showing) — the page must go
    // back to ONE container named 'main' before the single-container update path
    // can run, both because the count differs and because that path addresses the
    // container by name.
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
        appliedPanelSig = '';
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
    if (!agent) return;
    // Guarded per AGENT, not per page. Runs execute server-side and up to eight
    // can be in flight, so firing a SECOND agent while the first is thinking is
    // allowed on purpose — that is what lets you scroll the master list between
    // agents and watch each one's pane live. Only re-firing the SAME agent while
    // its run is in flight is refused.
    if (isAgentRunning(agent.id)) return;
    if (!agent.prompt.trim()) {
      agentNotice = { agentId: agent.id, error: 'no saved prompt' };
      agentLevel = 3;
      void renderGlasses();
      return;
    }
    const st = getAgents();
    const tools = st.tools.filter((t) => agent.toolIds.includes(t.id));
    // Optimistic: the relay's first run frame replaces this within a round trip.
    agentNotice = { agentId: agent.id, status: 'Thinking…' };
    // Go straight to level 3: the wearer asked for a run, and the run's output is
    // what they asked to see. The list is one double-tap back.
    agentLevel = 3;
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
      // Read only when this agent actually has the location tool: the read can
      // raise a permission prompt in a browser, so an agent that never asks
      // where anyone is must not cause one. Resolved BEFORE the call because a
      // run's snapshot is taken at trigger time by definition — the relay has no
      // way to ask for one afterwards.
      location: await snapshotForRun(tools),
      model: agent.model || st.llm.model,
    });
    if (!started.runId) {
      // No run was created, so no frame is coming to correct the pane — the
      // note IS the error channel, and it belongs to the agent just fired.
      agentNotice = { agentId: agent.id, error: started.error || 'relay refused the run' };
      void renderGlasses();
      return;
    }
  }

  /** Contextual menu → "Stop": cancel the in-flight run for the agent on screen. */
  async function agentsStop(): Promise<void> {
    // Scoped to the agent the menu is being read against. This used to stop
    // "the newest running run anywhere", which with concurrent runs means the
    // wearer stops a run they are not looking at while their own keeps going.
    const active = latestRunFor(agentSelected()?.id);
    if (!active || active.status !== 'running') return;
    agentNotice = { agentId: active.agentId, status: 'Stopping…' };
    void renderGlasses();
    await stopRun(active.id);
  }

  /**
   * A finished run becomes a session. The RUN id is the session id, so the
   * browser and the glasses converge on ONE entry (and re-recording is a no-op
   * once it exists, which stops the store→SSE→store feedback loop).
   */
  function settleRun(run: AgentRun): void {
    if (run.status === 'running') return;
    // This agent's run has landed, so any local note about it is superseded —
    // including when the OTHER surface recorded the session first and the
    // early return below skips the rest of this function.
    if (agentNotice?.agentId === run.agentId) agentNotice = null;
    if (getAgents().sessions.some((s) => s.id === run.id)) return;
    // Reset the pane only when the agent ON SCREEN settled. Runs for several
    // agents can be in flight, and a neighbour finishing must not yank the
    // session/page the wearer is reading out from under them.
    const selected = agentSelected();
    const mine = !!selected && selected.id === run.agentId;
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
    if (mine) {
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
    // Panel navigation is per-visit; reset so each entry starts at the list, the
    // outermost level, with a clean cursor. That matters for Docs specifically:
    // the wearer arrives from another tab expecting to CHOOSE a document, and the
    // list is the only screen that can do it. Only NAVIGATION is reset here — a
    // run in flight is not this page's to drop, and clearing it (as the old
    // global status flags did) is how a live run lost its status line the moment
    // the wearer switched tabs and back.
    agentLevel = 1;
    agentCursor = 0;
    agentSessionCursor = 0;
    agentDetailPage = 0;
    agentNotice = null;
    docLevel = 1;
    // Highlight the document that is actually open, so entering Docs does not
    // silently re-target the next open at whatever happens to be first.
    docCursor = Math.max(
      0,
      getState().sections.docs.findIndex((d) => d.id === getState().activeDocId),
    );
    selectSection(next);
  }

  /** Menu → "Back": Docs returns to the previous tab, Agents to the first tab. */
  function goBack(): void {
    const cur = getState().activeSection;
    if (cur === 'agents') switchSection('todo');
    else switchSection(lastNonDocsSection);
  }

  function newDoc(): void {
    addDoc('Untitled');
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
      removeDoc(target.id);
      // Stay in the picker so more docs can be removed; cursor clamps on render.
      pickerCursor = Math.min(pickerCursor, Math.max(0, ds.length - 2));
      return;
    }
    // Open the highlighted doc.
    pickerActive = false;
    pickerCursor = 0;
    // Both control fields, so the pair collapses into ONE `PATCH /hub` under the
    // store's shared control timer instead of two racy writes.
    selectSection('docs');
    selectDoc(target.id);
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
    // Agents — the ring walks the list at levels 1–2 and pages the output at 3,
    // which is exactly where each one is drawn.
    if (getState().activeSection === 'agents') {
      if (agentLevel !== 3) {
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
    // Files — the ring walks the document list, exactly like To-Do. There is
    // nothing to PAGE: one row is all the glasses can ever show of a document
    // (the body is HTML, and this canvas is 576×288 4-bit), so the swipe is
    // purely selection and the reading happens on the web page.
    if (getState().activeSection === 'files') {
      const refs = getState().sections.files;
      if (!refs.length) return;
      const next = Math.min(refs.length - 1, Math.max(0, filesCursor + dir));
      if (next !== filesCursor) {
        filesCursor = next;
        void renderGlasses();
      }
      return;
    }
    // Docs — the ring walks the document list at levels 1–2 and pages the open
    // body at 3, the same split as Agents.
    if (getState().activeSection === 'docs') {
      if (docLevel !== 3) {
        const docs = getState().sections.docs;
        if (!docs.length) return;
        const next = Math.min(docs.length - 1, Math.max(0, docCursor + dir));
        if (next === docCursor) return;
        docCursor = next;
        docPage = 0;
        // Moving the ring OPENS the highlighted document. The level-2 preview and
        // the level-3 body must describe the document the ring is on, and this is
        // the same `activeDocId` the web companion follows, so the two surfaces
        // never disagree about which document is open.
        selectDoc(docs[next].id);
        void renderGlasses();
        return;
      }
      // Level 3 is the body alone: the swipe pages it. `docPages` is the paging
      // state the panel itself produced, so the bound is the pane's, not a guess
      // derived from a differently-paged view.
      if (dir === -1 && docPage > 0) {
        docPage -= 1;
        void renderGlasses();
      } else if (dir === 1 && docPage < docPages - 1) {
        docPage += 1;
        void renderGlasses();
      }
      return;
    }
    // notes — flip pages.
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
    // Agents: a tap steps IN one level — list → list + output → output alone.
    if (getState().activeSection === 'agents') {
      if (agentLevel < 3 && agentSelected()) {
        // Entering the output pane starts at its newest page and newest session,
        // the same as opening it from the menu.
        if (agentLevel === 1) {
          agentSessionCursor = 0;
          agentDetailPage = 0;
        }
        agentLevel = (agentLevel + 1) as PanelLevel;
        void renderGlasses();
      }
      return;
    }
    // Docs: the same step, and the level-2 step OPENS the highlighted document so
    // the preview and the body cannot describe two different documents.
    if (getState().activeSection === 'docs') {
      if (docLevel < 3 && getState().sections.docs.length) {
        if (docLevel === 1) {
          docPage = 0;
          const doc = getState().sections.docs[docCursor];
          if (doc) selectDoc(doc.id);
        }
        docLevel = (docLevel + 1) as PanelLevel;
        void renderGlasses();
      }
      return;
    }
    if (getState().activeSection !== 'todo') return;
    const items = getState().sections.todo;
    if (!items.length || todoCursor >= items.length) return;
    const id = items[todoCursor].id;
    setTaskDone(id, !items[todoCursor].done);
  }

  // Any state change (UI edit, remote frame, or a ring tap) re-renders and
  // mirrors the docs library into durable storage (debounced).
  subscribe(() => {
    // The first hub snapshot names its own section; override it ONCE so the app
    // opens on Agents (see bootRedirect).
    if (hubReady()) bootRedirect();
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
    // The relay OWNS the status of an agent it is executing, so a local note
    // about that agent is stale — but only about THAT agent, and only once the
    // run is actually live: clearing on any remembered run would drop the
    // optimistic "Thinking…" the moment a frame for a neighbour arrived.
    const note = agentNotice;
    if (note && isAgentRunning(note.agentId)) agentNotice = null;
    // Every finished run becomes a session, whoever started it: the relay's run
    // store is shared, so a run the phone began lands in the same history.
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
      // Double-tap is a BACK gesture first: it pops the panel one level — body
      // (3) → list + body (2) → list alone (1). Only at the root, where there is
      // nowhere left to go back to, does it shut the page down.
      if (getState().activeSection === 'agents' && agentLevel > 1) {
        agentLevel = (agentLevel - 1) as PanelLevel;
        void renderGlasses();
        return;
      }
      if (getState().activeSection === 'docs' && docLevel > 1) {
        docLevel = (docLevel - 1) as PanelLevel;
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
    // The Docs panel starts at its list again — a re-credentialed device should
    // not land mid-document in a panel it did not choose.
    docLevel = 1;
    docCursor = 0;
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
