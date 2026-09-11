// Types for the adaptive capability layer (the "Jarvis" AI dictate agent).
//
// Everything the AI can DO in the app is described declaratively as a
// `Capability`. Nothing in the agent loop, the JSON-schema builder, the
// argument validator, the dispatcher, the HUD labels or the web catalog knows
// about any specific capability — they all read this shape. That is what makes
// the layer adaptive: introducing a new page or a new action is a pure
// DATA change (register a PageDef + a list of Capability objects), never a
// change to the machinery.
import type { SectionId } from '../types';

/**
 * A navigable surface.
 *   • a SectionId      → a glasses section (and its web tab)
 *   • 'global'         → cross-page actions (nav / undo / reply)
 *   • 'settings'       → the web-only settings tab
 */
export type PageId = SectionId | 'global' | 'settings';

/**
 * The pseudo-page that always-available actions live on (`nav.*`, `say.reply`,
 * `app.status`, `undo.last`). Typed as the literal — not as `PageId` — so a
 * `page === GLOBAL_PAGE` check still NARROWS `PageId` for callers.
 */
export const GLOBAL_PAGE = 'global';

/** Public description of a page, used by `nav.list_pages` and the web catalog. */
export interface PageDef {
  id: PageId;
  /** Human label: 'To-Do'. Shown on the HUD as the layer-1 routing line. */
  title: string;
  /**
   * Words a user is likely to say instead of the title ('todos', 'tasks',
   * 'checklist'). Given to the model so page routing survives loose phrasing.
   */
  synonyms: string[];
  /** One line describing what lives here. */
  summary: string;
}

export type ParamType = 'string' | 'number' | 'boolean' | 'enum';

/**
 * A single action argument. Declared once and converted to JSON Schema for the
 * model, to a validator at dispatch time, and to the web catalog's help text.
 */
export interface ParamSpec {
  name: string;
  type: ParamType;
  /** LLM-facing description. Be specific: it is the only hint the model gets. */
  description: string;
  required?: boolean;
  /** Allowed values when `type === 'enum'`. */
  values?: string[];
  /** Used when the argument is absent and not required. */
  fallback?: string | number | boolean;
}

/** What a capability reports back to the model (and, summarised, to the HUD). */
export interface CapabilityResult {
  ok: boolean;
  /** ONE short line. Rendered verbatim on the glasses — keep it emoji-free. */
  summary: string;
  /** Structured detail for the model only. Never rendered on the glasses. */
  data?: unknown;
  /** Extra steering for the model's next step (e.g. "call nav.open_page first"). */
  hint?: string;
}

export interface Capability {
  /** Globally unique dotted name: 'todo.add'. */
  name: string;
  /** Which page this action belongs to. Layer-2 routing key. */
  page: PageId;
  /** Short human label for the HUD: 'Add task'. */
  title: string;
  /** LLM-facing description of what it does and when to use it. */
  description: string;
  params: ParamSpec[];
  /**
   * Destructive / irreversible. On the glasses the run pauses and asks for a
   * tap-to-confirm before this runs (destructive-only policy).
   */
  confirm?: boolean;
  /** Declarative gating against live state (e.g. only when a doc is open). */
  available?: () => boolean;
  run: (args: Record<string, unknown>) => CapabilityResult | Promise<CapabilityResult>;
}

/** OpenAI-compatible function tool definition. */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}
