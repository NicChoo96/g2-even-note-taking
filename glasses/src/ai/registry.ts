// The capability registry — the ADAPTER LAYER.
//
// One place that knows how to turn a declarative `Capability` into
//   • a JSON Schema the model can call,
//   • a validated argument bag,
//   • a guarded, executable action.
//
// Any page or feature registers itself here and immediately gets: LLM tool
// exposure, argument validation, page-layer enforcement, HUD labels, web
// catalog entries and (via ai/undo) undo support. No other file changes.
import {
  GLOBAL_PAGE,
  effectOf,
  type Capability,
  type CapabilityResult,
  type PageDef,
  type PageId,
  type ParamSpec,
  type ToolSchema,
} from './types';
import { needsGate } from './ledger';

/**
 * The ONE place that decides whether an action pauses for a tap.
 *
 * Both the confirm gate and the model-visible tool description read it, because
 * they must never disagree: a description that promises a confirmation the loop
 * does not ask for (or vice versa) is how a model learns to attempt destructive
 * things casually.
 *
 * The `||` is a safety net, not a behaviour change. `effectOf` derives
 * `irreversible` from `confirm` when no `effect` is declared, so for every
 * capability that existed before effect classes this is exactly
 * `Boolean(cap.confirm)`. What it adds is that a capability declaring
 * `effect: 'irreversible'` can no longer FORGET to set `confirm: true` — the
 * gate follows from the classification instead of from remembering a flag.
 */
export function asksToConfirm(cap: Capability): boolean {
  return Boolean(cap.confirm) || needsGate(effectOf(cap));
}

const pages = new Map<PageId, PageDef>();
const caps = new Map<string, Capability>();
/** Registration order per page, so menus/catalogs stay stable. */
const order: string[] = [];

// ── Registration ────────────────────────────────────────────────────────────

export function registerPage(def: PageDef): void {
  pages.set(def.id, def);
}

/** Register a batch of actions for one page. The only call a new page needs. */
export function registerCapabilities(list: Capability[]): void {
  for (const cap of list) {
    if (!caps.has(cap.name)) order.push(cap.name);
    caps.set(cap.name, cap);
  }
}

// ── Lookup ──────────────────────────────────────────────────────────────────

export function getPage(id: PageId): PageDef | undefined {
  return pages.get(id);
}

export function listPages(): PageDef[] {
  return [...pages.values()];
}

export function allCapabilities(): Capability[] {
  return order.map((n) => caps.get(n)).filter((c): c is Capability => Boolean(c));
}

export function capabilityByName(name: string): Capability | undefined {
  return caps.get(name) ?? caps.get(fromWireName(name));
}

// ── Wire names ──────────────────────────────────────────────────────────────
// The registry speaks dotted names (`todo.set_done`) because they read well in
// menus, logs, the web catalog and the system prompt. Tool-calling APIs are
// stricter: OpenAI and DeepSeek only accept `^[a-zA-Z0-9_-]+$` for a function
// name, and ONE bad name rejects the WHOLE tools array with a 400. So the
// adapter translates at the wire boundary and nowhere else — every capability,
// present and future, keeps its dotted name and no call site has to know.
const WIRE_SEP = '__';

/** `todo.set_done` → `todo__set_done` (provider-safe). */
export function toWireName(name: string): string {
  return name.replace(/\./g, WIRE_SEP);
}

/** `todo__set_done` → `todo.set_done`. Names without the separator pass through. */
export function fromWireName(name: string): string {
  return name.includes(WIRE_SEP) ? name.split(WIRE_SEP).join('.') : name;
}

/** The canonical dotted name for a name in EITHER form (unknown names unchanged). */
export function canonicalName(name: string): string {
  return capabilityByName(name)?.name ?? name;
}

/**
 * Layer 2 of the tool exposure: the actions belonging to ONE page. This is what
 * the agent loop hands the model once a page is focused.
 */
export function capabilitiesForPage(page: PageId): Capability[] {
  return allCapabilities().filter((c) => c.page === page && isAvailable(c));
}

/** Actions that are always callable regardless of which page is focused. */
export function globalCapabilities(): Capability[] {
  return capabilitiesForPage(GLOBAL_PAGE);
}

function isAvailable(cap: Capability): boolean {
  if (!cap.available) return true;
  try {
    return cap.available();
  } catch {
    return false;
  }
}

// ── Schema generation ───────────────────────────────────────────────────────

function paramToSchema(p: ParamSpec): Record<string, unknown> {
  if (p.type === 'enum') {
    return { type: 'string', description: p.description, enum: p.values ?? [] };
  }
  if (p.type === 'number') {
    return { type: 'number', description: p.description };
  }
  if (p.type === 'boolean') {
    return { type: 'boolean', description: p.description };
  }
  return { type: 'string', description: p.description };
}

/**
 * Generic Capability → tool schema. Works for ANY capability, including ones
 * registered long after this file was written — which is the whole point.
 */
export function toToolSchema(cap: Capability): ToolSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of cap.params) {
    properties[p.name] = paramToSchema(p);
    if (p.required) required.push(p.name);
  }
  return {
    type: 'function',
    function: {
      // Wire form: providers reject a dot in a function name.
      name: toWireName(cap.name),
      description: asksToConfirm(cap) ? `${cap.description} (asks the user to confirm)` : cap.description,
      parameters: { type: 'object', properties, required },
    },
  };
}

export function toToolSchemas(list: Capability[]): ToolSchema[] {
  return list.map(toToolSchema);
}

// ── Validation ──────────────────────────────────────────────────────────────

export type Validated =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

function coerce(p: ParamSpec, raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (p.type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      return { ok: true, value: Number(raw) };
    }
    return { ok: false };
  }
  if (p.type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  if (typeof raw !== 'string') {
    // A model occasionally sends an array/object for a text field.
    if (Array.isArray(raw) && raw.every((x) => typeof x === 'string')) {
      return { ok: true, value: raw.join('\n') };
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: String(raw) };
    return { ok: false };
  }
  const value = raw.trim();
  if (p.type === 'enum') {
    const allowed = p.values ?? [];
    if (!allowed.includes(value)) return { ok: false };
    return { ok: true, value };
  }
  return { ok: true, value };
}

/**
 * Generic validator. Never throws: the caller feeds the returned error straight
 * back to the model as a tool result, which lets it retry instead of failing the
 * whole run.
 */
export function validateArgs(cap: Capability, raw: unknown): Validated {
  const bag = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const args: Record<string, unknown> = {};

  for (const p of cap.params) {
    const present = Object.prototype.hasOwnProperty.call(bag, p.name) && bag[p.name] !== null;
    if (!present) {
      if (p.required) return { ok: false, error: `missing required argument "${p.name}" (${p.description})` };
      if (p.fallback !== undefined) args[p.name] = p.fallback;
      continue;
    }
    const value = bag[p.name];
    // An explicitly empty string counts as absent, so the fallback still applies.
    if (value === '' && !p.required) {
      if (p.fallback !== undefined) args[p.name] = p.fallback;
      continue;
    }
    const c = coerce(p, value);
    if (!c.ok) {
      const expect = p.type === 'enum' ? `one of ${(p.values ?? []).join(' | ')}` : `a ${p.type}`;
      return { ok: false, error: `argument "${p.name}" must be ${expect}` };
    }
    args[p.name] = c.value;
  }

  return { ok: true, args };
}

// ── Dispatch (layer enforcement lives here) ─────────────────────────────────

export interface Prepared {
  cap: Capability;
  args: Record<string, unknown>;
}

export type PrepareOutcome =
  | { kind: 'ready'; prepared: Prepared; needsConfirm: boolean }
  | { kind: 'error'; error: string; hint?: string };

/**
 * Resolve + validate + guard a tool call WITHOUT running it, so the caller can
 * pause for confirmation first.
 *
 * LAYER ENFORCEMENT: a page's action can only run while that page is focused.
 * A violation is returned as a correctable error (with a hint) rather than
 * thrown, so the model can call `nav.open_page` and carry on. This is what
 * makes the two-layer design real instead of a prompt suggestion.
 */
export function prepare(name: string, rawArgs: unknown, focused: PageId): PrepareOutcome {
  // Forgiving lookup: accepts the wire name the model was given (`todo__add`)
  // AND the dotted registry name, so a model that reuses the prompt's wording
  // still works instead of burning a turn on a name mismatch.
  const cap = capabilityByName(name);
  if (!cap) {
    const names = allCapabilities().map((c) => toWireName(c.name)).join(', ');
    return { kind: 'error', error: `unknown action "${name}"`, hint: `available actions: ${names}` };
  }
  const wire = toWireName(cap.name);
  if (!isAvailable(cap)) {
    return { kind: 'error', error: `action "${wire}" is not available right now` };
  }
  if (cap.page !== GLOBAL_PAGE && cap.page !== focused) {
    return {
      kind: 'error',
      // Say outright that the action EXISTS and is permitted. The tool list is
      // trimmed to a budget, so a model focused elsewhere often has no tool for
      // this action and only the prompt's action list to go on; a bare refusal
      // reads to it as "I have no access", which it then tells the user.
      error:
        `page "${cap.page}" is not focused (currently on "${focused}") — ${wire} is available, ` +
        `this is a routing step, not a permission problem`,
      hint: `call ${toWireName('nav.open_page')} with {"page":"${cap.page}"} first, then retry ${wire}`,
    };
  }
  const validated = validateArgs(cap, rawArgs);
  if (!validated.ok) {
    return { kind: 'error', error: `invalid arguments for ${wire}: ${validated.error}` };
  }
  return { kind: 'ready', prepared: { cap, args: validated.args }, needsConfirm: asksToConfirm(cap) };
}

/** Run a prepared capability. Errors are returned, never thrown. */
export async function execute(prepared: Prepared): Promise<CapabilityResult> {
  try {
    return await prepared.cap.run(prepared.args);
  } catch (err) {
    return { ok: false, summary: `${prepared.cap.title} failed`, hint: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Convenience for the web UI / harnesses: prepare + run in one call.
 * The glasses use prepare/execute separately so confirmation can interleave.
 */
export async function callAction(name: string, rawArgs: unknown, focused: PageId): Promise<CapabilityResult> {
  const outcome = prepare(name, rawArgs, focused);
  if (outcome.kind === 'error') {
    return { ok: false, summary: outcome.error, hint: outcome.hint };
  }
  return execute(outcome.prepared);
}

// ── Derived catalog text ────────────────────────────────────────────────────
// These live here (not in a capability module) so nothing has to import the
// capability graph just to label a page — keeps the module graph acyclic.

/**
 * Live page table for the system prompt — always reflects current registration.
 *
 * Every page's action names are listed. This is the ONLY place the model can
 * learn about an action whose tool got trimmed out of this turn's tool budget:
 * `selectTools` only carries the focused page's actions, so without this a
 * model asked to write a doc from the To-Do page had neither the tool nor any
 * mention of `docs__append`, and correctly concluded it had no access.
 */
export function pageCatalogText(): string {
  const lines = listPages().map((p) => {
    const line = `- ${p.id} — ${p.title}: ${p.summary} (user may say: ${p.synonyms.join(', ')})`;
    const actions = pageDeclaredActionNames(p.id);
    return actions.length ? `${line}\n  actions: ${actions.join(', ')}` : line;
  });
  // The app-wide actions belong to no page (there is no page to route to), and
  // the budget can still trim nav__back / nav__list_actions / undo__last out of a
  // given turn's tool list, so name them here rather than leaving them unknown.
  const appWide = pageDeclaredActionNames(GLOBAL_PAGE);
  if (appWide.length) {
    lines.push(
      `- app-wide (always callable, no routing needed): ${appWide.join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** Human label for a page id, used by the HUD's layer-1 routing line. */
export function pageTitle(id: PageId): string {
  if (id === GLOBAL_PAGE) return 'App';
  return pages.get(id)?.title ?? String(id);
}

/**
 * Every action a page DECLARES, in wire form, regardless of the `available`
 * gate. Used by the system prompt, which must tell the model that a capability
 * exists — an action gated off right now is still one the model should plan for
 * (e.g. `notes.clear` with no notes yet) rather than believe it cannot do.
 *
 * Distinct from `pageActionNames`, which is what `nav.list_actions` returns and
 * must therefore only ever name something actually callable this instant.
 */
export function pageDeclaredActionNames(page: PageId): string[] {
  return allCapabilities()
    .filter((c) => c.page === page)
    .map((c) => toWireName(c.name));
}

/**
 * The callable (wire) names of one page's actions — what `nav.list_actions`
 * hands the model, so it can only ever read back a name it may actually call.
 */
export function pageActionNames(page: PageId): string[] {
  return capabilitiesForPage(page).map((c) => toWireName(c.name));
}
