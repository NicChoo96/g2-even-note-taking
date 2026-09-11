// Public surface of the AI layer.
//
// The renderer and the companion panel import from here and nothing deeper, so
// the internals (registry, undo, capabilities) can be reorganised without
// touching the UI. Importing this module also registers the default catalog.
import './pages';

export { runAiAgent, type AiRunOptions, type AiRunResult } from './agent';
export { aiModel, aiMaxSteps, updateAiSettings, type AiSettings } from './store';
export { appSnapshotText, openDocText } from './context';
export {
  allCapabilities,
  canonicalName,
  capabilitiesForPage,
  fromWireName,
  listPages,
  pageActionNames,
  pageTitle,
  toWireName,
} from './registry';
export { hasUndo, clearUndo, subscribeUndo, undoLabel, undoLastAiBatch } from './undo';
export { setAppBridge, type AppBridge } from './bridge';
export {
  aiAnswerConfirm,
  aiBegin,
  aiCancel,
  aiFail,
  aiFinish,
  aiFlash,
  aiReset,
  aiSetTurn,
  aiStep,
  consumeWebTab,
  getAi,
  getAiFocus,
  isAiAborted,
  isAiMirrored,
  requestWebTab,
  setAiFocus,
  subscribeAi,
  type AiControl,
  type AiSnapshot,
  type AiState,
  type AiStatus,
  type AiStep,
  type AiStepKind,
} from './store';
export { requestRemoteConfirm, requestRemoteStop } from './sync';
/**
 * The watched-run queue is part of the public surface because the HUD (sections)
 * and the platform layer (main) both draw and drive it — but the AGENT LOOP is
 * not its owner and must not read it: a run the loop started is watched by
 * whoever asked for it, and the prompt gets its view through ./context.
 */
export {
  ackMonitor,
  enqueueMonitoredRun,
  getMonitored,
  getMonitorView,
  ingestMonitoredRuns,
  monitorAge,
  moveMonitorCursor,
  removeMonitoredRun,
  resetMonitor,
  subscribeMonitor,
  type MonitoredRun,
  type MonitorRow,
  type MonitorStatus,
  type MonitorView,
  type WatchedRun,
} from './monitor';
export { GLOBAL_PAGE, type Capability, type PageId } from './types';
