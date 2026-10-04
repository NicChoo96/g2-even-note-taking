// Delegated intents (D2): an agent run asking THIS device to do something.
//
// THE GAP. A run executes on the relay, so nothing it does can touch the app —
// the to-do list, the documents, the scratchpad, the published files, the agent
// catalogue — and it cannot start another agent. The wearer's spoken words reach
// a run as the pre-run prompt and that is the end of the conversation. A briefing
// agent could therefore research a topic, write a report, and have nowhere to put
// it.
//
// HOW IT WORKS, END TO END.
//   1. The client sends its delegable catalogue with the run (see `intentCatalog`
//      and the `capabilities` field on `startRun`). The relay is a FORWARDER: it
//      never holds a list of the app's actions.
//   2. The run gets one extra tool, `jarvis_app`, which PROPOSES a change and
//      records it in its own transcript as an ordinary tool result.
//   3. The client claims those proposals on the run's terminal edge —
//      `ingestMonitoredRuns` already returns exactly that edge, once per run —
//      and writes each one into the ledger as a `pending` `call` entry with
//      `locus:'client'`, which is the ledger's OWN definition of "a proposal this
//      device has not yet dealt with" (see `pendingEntries` in ./ledger).
//   4. `runPendingIntents` drains them through the ordinary path: `prepare`
//      (validation, `available()`, the layer rule), the tap-to-confirm gate for
//      anything `irreversible`, `execute`, and undo. A delegated action is NOT a
//      special kind of action — it is the same capability, reached by a different
//      caller, which is the whole point.
//
// WHY THE DEVICE DECIDES AND NOT THE RELAY. The gate and the undo journal live
// here. A relay that executed directly would be a second write path into the
// wearer's data, one the ledger's safety invariant ("an irreversible entry may
// not succeed without a preceding approved gate") could not even see. So the
// wire carries an ASK, never an instruction, and every effect class is re-derived
// from this process's own registry rather than trusted from the payload.
//
// WHAT THIS MODULE IS NOT. It is not a second agent loop and not a second
// capability table. It has no list of what an agent may do: `delegable()` is a
// RULE over the registry, so a capability added to any page is delegable the
// moment it exists and correct by construction, and one added to Settings is not
// (see tools/intents-sim.mjs, which asserts both directions). It is also not a
// chain builder — agent→agent needs nothing built, because `agents.trigger` is
// itself a capability and therefore delegable like any other, which is what
// docs/agent-architecture.md section 8 asks for when it refuses a bespoke
// orchestrator.
import { GLOBAL_PAGE, effectOf, type Capability } from './types';
import { allCapabilities, capabilityByName, execute, prepare } from './registry';
import {
  ledgerAppend,
  ledgerEntries,
  ledgerResolve,
  pendingEntries,
  type Effect,
  type Entry,
} from './ledger';
import { aiAskConfirm } from './store';
import { confirmCopy } from './confirm';
import type { RunMessage } from '../stream';

/**
 * Globals an agent run may ask for. The ONLY exception the rule below makes, and
 * it is not arbitrary: both are ways a run reaches the wearer rather than
 * changes their data. `nav.open_page` lets a finished run bring the wearer to
 * what it produced instead of describing a location for them to find, and
 * `say.reply` is the spoken line on a run that wants to say something before it
 * is done.
 *
 * `undo.last` is deliberately absent even though it is a `write`: undoing the
 * wearer's OWN last action is not an agent's business, and a run that could
 * reach it could silently erase work it had nothing to do with.
 */
const AGENT_GLOBALS = ['nav.open_page', 'say.reply'];

/**
 * How many intents a run may land, enforced HERE rather than trusted from the
 * relay. The relay has its own budget (`INTENT_MAX_PER_RUN` in server/intents.mjs)
 * for the model's sake; this one is a trust boundary, because the count that
 * arrives on the wire is whatever the wire says it is.
 */
const MAX_INTENTS_PER_RUN = 4;

/**
 * How many intent-started runs may be in flight before the chain guard forgets
 * the oldest. Small because it is a LOOP BRAKE, not a record: the guard only has
 * to outlive a run that is itself still going.
 */
const MAX_CHAIN = 8;

/** Where the proposals are found in a run's transcript. */
const INTENT_SOURCE = 'agent-run';

export interface IntentParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
  values?: string[];
}

/**
 * One capability as the relay is allowed to see it: enough to describe the
 * action to a model and to name its arguments, and nothing else. No `run`, no
 * `available`, no code — this is data crossing a process boundary, and the
 * authority over it stays here.
 */
export interface IntentSpec {
  name: string;
  title: string;
  page: string;
  pageTitle: string;
  effect: Effect;
  description: string;
  params: IntentParam[];
}

/** A proposal as it arrived: the relay's naming plus this app's re-derivation. */
export interface DelegatedIntent {
  key: string;
  action: string;
  title: string;
  args: Record<string, unknown>;
  why: string;
}

/** One claimed proposal, after the device has decided what to do with it. */
export interface IntentOutcome {
  seq: number;
  action: string;
  title: string;
  ok: boolean;
  summary: string;
}

/**
 * May an agent run ask for this capability?
 *
 * A RULE, not a list — that is the whole design. Read it as: does this change
 * something of the wearer's, or is it one of the two ways a run reaches them?
 *   - Settings is out. That page holds the wearer's provider keys, and no
 *     capability on it changes anything of theirs, so the rule needs no special
 *     case for individual actions there.
 *   - `pure` and `read` are out on the merits, not as a policy: a proposal is
 *     FIRE-AND-FORGET. The run has moved on by the time the device runs it, so
 *     an agent that asked to read something would get no answer. Offering it
 *     would be offering a tool that cannot do what its description says.
 *   - Every write on every other page is IN, including the ones that are
 *     irreversible. Those are the interesting ones — gating is what makes them
 *     safe, and the gate is the device's.
 */
export function delegable(cap: Capability): boolean {
  if (cap.page === 'settings') return false;
  if (cap.page === GLOBAL_PAGE) return AGENT_GLOBALS.includes(cap.name);
  const effect = effectOf(cap);
  return effect === 'write' || effect === 'irreversible';
}

export function intentCatalog(): IntentSpec[] {
  return allCapabilities()
    .filter(delegable)
    .map((cap) => ({
      name: cap.name,
      title: cap.title,
      page: cap.page,
      // The page's LABEL, so the model can be told where an action lives without
      // being handed the app's routing internals.
      pageTitle: cap.page === GLOBAL_PAGE ? 'Any page' : cap.page,
      effect: effectOf(cap),
      description: cap.description,
      params: cap.params.map((p) => ({
        name: p.name,
        type: p.type,
        description: p.description,
        required: p.required === true,
        ...(p.values ? { values: p.values.slice(0, 12) } : {}),
      })),
    }));
}

function safeObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Every proposal in a run's transcript, newest last and deduped by the relay's
 * own key.
 *
 * Found by PARSING the tool results rather than by trusting a `tool` name: the
 * transcript is a list of what happened, and the thing that identifies a
 * proposal is the shape of what came back (`data.intent`), not a label the model
 * could not have produced. A result that is not JSON, or JSON without an intent,
 * is simply not one — a run's transcript also carries search results.
 */
export function intentsFromMessages(messages: readonly RunMessage[] | undefined): DelegatedIntent[] {
  const out: DelegatedIntent[] = [];
  const seen = new Set<string>();
  for (const message of messages ?? []) {
    if (!message || message.role !== 'tool' || typeof message.content !== 'string') continue;
    const parsed = safeParse(message.content);
    const data = safeObject(parsed?.data);
    const raw = safeObject(data.intent);
    const action = typeof raw.action === 'string' ? raw.action : '';
    const key = typeof raw.key === 'string' ? raw.key : '';
    if (!action || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      action,
      title: typeof raw.title === 'string' && raw.title ? raw.title : action,
      args: safeObject(raw.args),
      why: typeof raw.why === 'string' ? raw.why : '',
    });
    if (out.length >= MAX_INTENTS_PER_RUN) break;
  }
  return out;
}

/** Ledger keys already claimed, so a replayed transcript cannot propose twice. */
function claimedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const entry of ledgerEntries()) {
    const payload = safeObject(entry.payload);
    if (payload.source !== INTENT_SOURCE) continue;
    if (typeof payload.key === 'string') keys.add(payload.key);
  }
  return keys;
}

/**
 * Claim a finished run's proposals into the ledger. Returns the entries that are
 * NEWLY pending, which is what `runPendingIntents` then drains.
 *
 * CALL THIS ON THE TERMINAL EDGE (`ingestMonitoredRuns` returns exactly the runs
 * that just went from running to terminal, once each). The namespaced key is the
 * second line of defence: a run's transcript is replayed to every client on
 * reconnect, so without it a reconnecting device would re-propose everything a
 * run had ever asked for.
 *
 * The ledger's ceiling means a long session eventually drops the oldest keys and
 * could re-claim a very old run. That is a real bound rather than a hidden one:
 * it takes 400 later entries, and the effect would be a duplicate proposal the
 * wearer can decline.
 */
export function claimIntents(
  run: { id: string; agentId?: string; agentName?: string },
  messages: readonly RunMessage[] | undefined,
): Entry[] {
  const id = String(run?.id ?? '');
  if (!id) return [];
  const who = String(run.agentName ?? '').trim() || 'An agent';
  const claimed = claimedKeys();
  const fresh: Entry[] = [];
  for (const intent of intentsFromMessages(messages)) {
    const key = `${id}:${intent.key}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    const cap = capabilityByName(intent.action);
    // Defence in depth, and it should be unreachable: the relay's schema enum is
    // built from this same catalogue, so an unknown or undelegatable action means
    // the payload did not come from a catalogue this app produced. Recorded as an
    // error rather than dropped — an unexplained silence is worse than a refusal
    // the trace can explain.
    if (!cap || !delegable(cap)) {
      ledgerAppend({
        kind: 'error',
        by: 'system',
        effect: 'read',
        status: 'failed',
        text: `${who} asked for an action this app does not delegate: ${intent.action}`,
        runId: id,
        payload: { key, source: INTENT_SOURCE, action: intent.action },
      });
      continue;
    }
    fresh.push(
      ledgerAppend({
        kind: 'call',
        by: 'agent',
        effect: effectOf(cap),
        status: 'pending',
        locus: 'client',
        // Attributed to the AGENT'S run, not to whatever run is current here: the
        // trace should read as one run's decision, and `ledgerRun(runId)` is how
        // the session view reconstructs it.
        runId: id,
        text: `${who}: ${cap.title}`,
        payload: {
          source: INTENT_SOURCE,
          key,
          agentId: String(run.agentId ?? ''),
          agentName: who,
          intent: { ...intent, action: cap.name, effect: effectOf(cap) },
        },
      }),
    );
  }
  return fresh;
}

/** Runs this module started, so a chain cannot outrun the wearer. */
const chain = new Set<string>();

function noteChain(runId: string): void {
  if (!runId) return;
  chain.add(runId);
  while (chain.size > MAX_CHAIN) chain.delete(chain.values().next().value as string);
}

/** Test/teardown reset. The optional seed is how the chain guard is reachable
 *  from a harness without a relay: the brake is the only behaviour here that
 *  otherwise requires a real run to have started. */
export function resetIntents(seed: readonly string[] = []): void {
  chain.clear();
  for (const id of seed) chain.add(String(id));
}

function isIntentEntry(entry: Entry): boolean {
  return entry.kind === 'call' && safeObject(entry.payload).source === INTENT_SOURCE;
}

/**
 * The proposals this device has claimed but not yet dealt with.
 *
 * NOT just `pendingEntries()`, and the difference is the ledger's design rather
 * than a detail: resolving a proposal is an APPEND (see `ledgerResolve`), so the
 * original stays `pending` forever and a naive queue would replay every intent
 * that had ever run, for as long as the entry survived the 400-entry ceiling.
 * "Dealt with" is therefore a LATER entry that cites it via `refs`, which is the
 * same reading the safety invariant uses (`ungatedIrreversible`).
 */
function pendingIntents(): Entry[] {
  const resolved = new Set<number>();
  for (const entry of ledgerEntries()) {
    if (entry.status === 'pending') continue;
    for (const ref of entry.refs) resolved.add(ref);
  }
  return pendingEntries().filter((e) => isIntentEntry(e) && !resolved.has(e.seq));
}

/** In-flight drain, so two runs landing together cannot run one entry twice. */
let draining: Promise<IntentOutcome[]> | null = null;

/**
 * Run every pending delegated intent, oldest first.
 *
 * Sequential on purpose: two intents from one run are the model's steps in
 * order, and running them concurrently would let a `todo.add` and a
 * `todo.clear_all` race for the same list. The queue is re-derived each pass so
 * an intent claimed while this was draining is picked up rather than stranded.
 *
 * Never throws. A capability that fails is a `failed` entry, not an exception —
 * the ledger is the report, and an intent from a run nobody is watching is
 * normal, so a throw here would be an unhandled rejection with no owner.
 */
export function runPendingIntents(): Promise<IntentOutcome[]> {
  if (draining) return draining;
  const work = drainAll().finally(() => {
    if (draining === work) draining = null;
  });
  draining = work;
  return work;
}

async function drainAll(): Promise<IntentOutcome[]> {
  const done: IntentOutcome[] = [];
  for (;;) {
    const queue = pendingIntents();
    if (!queue.length) return done;
    for (const entry of queue) done.push(await runIntentEntry(entry));
  }
}

async function runIntentEntry(entry: Entry): Promise<IntentOutcome> {
  const payload = safeObject(entry.payload);
  const raw = safeObject(payload.intent);
  const action = String(raw.action ?? '');
  const cap = capabilityByName(action);
  const label = cap?.title ?? action;
  const settle = (
    status: Exclude<Entry['status'], 'pending'>,
    summary: string,
  ): IntentOutcome => {
    ledgerResolve(entry.seq, status, summary);
    return { seq: entry.seq, action, title: label, ok: status === 'ok', summary };
  };

  if (!cap || !delegable(cap)) {
    return settle('skipped', `not delegated: ${action}`);
  }
  // THE CHAIN BRAKE. agent→agent is supported (agents.trigger is a capability
  // like any other) but it terminates: a run that an intent started may not
  // itself start one. Otherwise one ask from the wearer can begin an unbounded
  // chain of runs, each spending the wearer's key, and nothing in the UI would
  // show it as a single action. SKIPPED rather than failed, because nothing went
  // wrong with the action — this device chose not to run it, and the trace should
  // say so rather than imply a defect.
  if (action === 'agents.trigger' && chain.has(entry.runId)) {
    return settle('skipped', 'that run was itself started by an agent');
  }

  // Layer 2 is passed the capability's OWN page. The focus rule exists to stop
  // the MODEL acting on a page it is not looking at; there is no model here, and
  // the wearer's current page is not the intent's business. Validation,
  // `available()` and the argument coercion are the parts that must run, and they
  // do — this is the same call the loop makes, not a bypass of it.
  const outcome = prepare(action, raw.args, cap.page);
  if (outcome.kind === 'error') {
    return settle('failed', outcome.error);
  }

  const { args } = outcome.prepared;
  if (outcome.needsConfirm) {
    const copy = confirmCopy(cap, args);
    const why = String(raw.why ?? '').trim();
    // The GATE. Same prompt, same HUD, same tap as the spoken loop's — which is
    // the point: what the wearer approves must not depend on whether a model on
    // this device or one on the relay asked for it. A headless client has no
    // resolver and answers `false`, which is the safe direction to fail in.
    //
    // `entry.runId` is passed because this is NOT the current run: the asking
    // run finished on the relay, and the wearer may be mid-way through a spoken
    // run of their own. The gate has to belong to the run it is gating, or
    // `isGated` — and with it the `ungatedIrreversible` invariant — cannot see
    // the approval.
    const approved = await aiAskConfirm(copy.title, [
      `An agent asks: ${why || cap.title}`,
      ...copy.lines,
    ], entry.runId);
    if (!approved) {
      return settle('declined', `declined: ${cap.title}`);
    }
  }

  const result = await execute(outcome.prepared);
  if (result.ok && action === 'agents.trigger') {
    const started = safeObject(result.data).runId;
    if (typeof started === 'string') noteChain(started);
  }
  return settle(result.ok ? 'ok' : 'failed', result.summary);
}
