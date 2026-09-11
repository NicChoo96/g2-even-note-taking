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
export { GLOBAL_PAGE, type Capability, type PageId } from './types';
