// Jarvis conversation memory — the layer the agent loop never had.
//
// `runAiAgent` (./agent) is deliberately STATELESS: every turn sends a fresh
// [system, user] pair, so Jarvis could not answer "what did I just ask you?" and
// forgot the whole conversation the moment the HUD closed. This module is the
// missing layer — an append-only log of (wearer, Jarvis) turns that is replayed
// into each turn's transcript AND persisted, so the next Jarvis session reads
// back what the last one learned.
//
// Size control is the point, not an afterthought. The log may grow to
// MEMORY_MAX_WORDS; the first turn past that folds everything except the newest
// KEEP_TURNS into ONE model-written summary of ~DIGEST_WORDS words and drops the
// turns it covered. The store therefore stays bounded (and small enough to live
// in localStorage through a Flutter WebView) while the model keeps a running
// gist of everything that was ever said.
//
// Pure data + one optional LLM call: no SSE, no app stores. `agent.ts` records
// turns and reads the log back; `main.ts` hydrates it once at boot.
import { loadMemoryRaw, saveMemoryRaw, clearMemoryRaw } from '../durable-docs';
import { llmChat, type WireMessage } from '../web/agents-client';
import { aiModel } from './store';
import { stripToolMarkup } from './tool-markup';

export interface MemoryTurn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface JarvisMemory {
  version: number;
  /** Model-written gist of every turn folded away so far ('' until the first). */
  digest: string;
  digestAt: number;
  /** How many turns have been folded into `digest`. */
  folded: number;
  /** Verbatim turns, oldest → newest. */
  turns: MemoryTurn[];
  updatedAt: number;
}

/**
 * Words allowed to accumulate before the log is compacted. "Words" is the unit
 * the wearer asked for (whitespace-separated tokens), not provider tokens: it is
 * the only unit a user can reason about. 100k words is roughly a 600 KB JSON
 * blob — well inside a localStorage quota, and far more than a voice assistant
 * will ever produce in one sitting.
 */
export const MEMORY_MAX_WORDS = 100_000;
/** What a compaction leaves behind, in words. */
export const MEMORY_DIGEST_WORDS = 400;
/** Newest turns a compaction never folds away — the recent conversation. */
const MEMORY_KEEP_TURNS = 20;
/** Verbatim turns pasted into a turn's transcript. */
const MEMORY_PROMPT_TURNS = 6;
/** Char budget for that verbatim block (the digest is separate). */
const MEMORY_PROMPT_CHARS = 1400;
/** One spoken/dictated turn can be long; keep the log sane. */
const MEMORY_TURN_CHARS = 2000;
/**
 * Chars the log may hold before it is compacted, as a STORAGE guard rather than
 * a policy: persistence is a WebView bridge round-trip, and a blob past a few
 * tens of KB is a write that can fail without ever saying so. Crossing it folds
 * the old end into the digest EARLY — it never discards anything — so the word
 * cap above stays the promise the wearer was given and this stays the floor that
 * keeps the promise actually keepable.
 */
const MEMORY_MAX_CHARS = 60_000;
const MEMORY_VERSION = 1;

function empty(): JarvisMemory {
  return {
    version: MEMORY_VERSION,
    digest: '',
    digestAt: 0,
    folded: 0,
    turns: [],
    updatedAt: 0,
  };
}

let memory: JarvisMemory = empty();
let hydrated = false;
let compacting = false;
let cachedView: MemoryView | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  cachedView = null;
  for (const fn of listeners) fn();
}

/** Words in the whole log — the number the cap is measured against. */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function words(m: JarvisMemory): number {
  let n = countWords(m.digest);
  for (const t of m.turns) n += countWords(t.text);
  return n;
}

/** Rough size of the persisted log — a proxy for the JSON, not a byte count. */
function chars(m: JarvisMemory): number {
  let n = m.digest.length;
  for (const t of m.turns) n += t.text.length;
  return n;
}

/** Trim prose to `max` words without splitting the last one in half. */
function limitWords(text: string, max: number): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length <= max ? parts.join(' ') : parts.slice(0, max).join(' ');
}

function sanitize(raw: unknown): JarvisMemory | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<JarvisMemory>;
  const turns: MemoryTurn[] = [];
  if (Array.isArray(o.turns)) {
    for (const t of o.turns) {
      if (!t || typeof t.text !== 'string') continue;
      const role = t.role === 'assistant' ? 'assistant' : 'user';
      turns.push({ role, text: t.text, at: typeof t.at === 'number' ? t.at : 0 });
    }
  }
  return {
    version: MEMORY_VERSION,
    digest: typeof o.digest === 'string' ? o.digest : '',
    digestAt: typeof o.digestAt === 'number' ? o.digestAt : 0,
    folded: typeof o.folded === 'number' ? o.folded : 0,
    turns,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  };
}

function persist(): void {
  try {
    // `.catch` and not just try/catch: the write is ASYNC, so a rejection would
    // otherwise surface as an unhandled rejection in the WebView console.
    void saveMemoryRaw(JSON.stringify(memory)).catch(() => {
      /* storage full or unavailable — memory still works for this session */
    });
  } catch {
    /* JSON failed or storage unavailable — memory still works for this session */
  }
}

// ── Read side ────────────────────────────────────────────────────────────────

/** Flattened view for the web panel (cached identity for useSyncExternalStore). */
export interface MemoryView {
  turns: number;
  folded: number;
  words: number;
  capWords: number;
  digestWords: number;
  digest: string;
  updatedAt: number;
}

export function getMemoryView(): MemoryView {
  if (!cachedView) {
    cachedView = {
      turns: memory.turns.length,
      folded: memory.folded,
      words: words(memory),
      capWords: MEMORY_MAX_WORDS,
      digestWords: MEMORY_DIGEST_WORDS,
      digest: memory.digest,
      updatedAt: memory.updatedAt,
    };
  }
  return cachedView;
}

export function subscribeMemory(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function isCompacting(): boolean {
  return compacting;
}

/**
 * The newest turns to replay into a turn's transcript, oldest first. Capped by
 * count AND characters, and it refuses to drop the newest turn even when that
 * turn alone is over budget — losing the immediately preceding exchange is
 * exactly the failure this module exists to fix.
 */
export function memoryMessages(maxTurns = MEMORY_PROMPT_TURNS): MemoryTurn[] {
  const out: MemoryTurn[] = [];
  let chars = 0;
  for (let i = memory.turns.length - 1; i >= 0 && out.length < maxTurns; i--) {
    const t = memory.turns[i];
    if (!t.text) continue;
    if (out.length && chars + t.text.length > MEMORY_PROMPT_CHARS) break;
    out.unshift(t);
    chars += t.text.length;
  }
  return out;
}

/** The MEMORY section of the system prompt ('' when nothing is remembered). */
export function memoryPromptText(): string {
  if (!memory.digest && !memory.turns.length) return '';
  const lines = [
    'MEMORY (earlier conversations with this wearer — use it as background; never recite it)',
  ];
  lines.push(memory.digest || '(nothing has been summarised yet)');
  lines.push(
    `Remembered: ${memory.turns.length} recent turn(s)` +
      (memory.folded ? `, plus a summary of ${memory.folded} older turn(s)` : '') +
      '.',
  );
  return lines.join('\n');
}

// ── Write side ───────────────────────────────────────────────────────────────

function rememberTurn(role: MemoryTurn['role'], text: string, at: number): void {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  memory.turns.push({ role, text: clean.slice(0, MEMORY_TURN_CHARS), at });
  memory.updatedAt = at;
  persist();
  emit();
  // Over EITHER budget → fold the old end away. Fire-and-forget: a turn must
  // never wait on a summarisation call, and a failure just leaves the log long.
  if (words(memory) >= MEMORY_MAX_WORDS || chars(memory) >= MEMORY_MAX_CHARS) {
    void compactMemory();
  }
}

/** Record one completed exchange. The assistant turn orders after the request. */
export function rememberExchange(you: string, jarvis: string, at = Date.now()): void {
  rememberTurn('user', you, at);
  if (jarvis) rememberTurn('assistant', jarvis, at + 1);
}

/** Record a bare user turn (a run that produced no spoken answer). */
export function rememberSpoken(text: string, at = Date.now()): void {
  rememberTurn('user', text, at);
}

export type MemoryAsk = (prompt: string) => Promise<string>;

async function defaultAsk(prompt: string): Promise<string> {
  const messages: WireMessage[] = [{ role: 'user', content: prompt }];
  // No `tools` on purpose: a tool-free request is the one shape DeepSeek will
  // answer in prose (see ./tool-markup for what happens otherwise).
  const res = await llmChat({ model: aiModel(), messages });
  if (!res.ok) throw new Error(res.error || 'compaction failed');
  return String(res.message?.content ?? '');
}

export function compactionPrompt(m: JarvisMemory, older: MemoryTurn[]): string {
  const transcript = older
    .map((t) => `${t.role === 'user' ? 'Wearer' : 'Jarvis'}: ${t.text}`)
    .join('\n');
  return [
    'You maintain the long-term memory of a voice assistant inside a pair of smart glasses.',
    `Rewrite the record below into ONE factual summary of at most ${MEMORY_DIGEST_WORDS} words.`,
    'Keep: names, dates, preferences, decisions, outstanding tasks, and anything the wearer asked to be remembered.',
    'Drop: pleasantries, failed attempts, repeated commands, and anything with no lasting value.',
    'Write plain prose in the third person ("The wearer asked…"). No markdown, no lists, no emoji.',
    'Merge the existing summary with the new transcript — do not restart it.',
    '',
    '[existing summary]',
    m.digest || '(none)',
    '',
    '[new transcript]',
    transcript,
  ].join('\n');
}

/**
 * Fold every turn except the newest KEEP_TURNS into the digest. Returns true
 * when the log actually shrank. Safe to call at any time — the harness drives
 * it directly with a stubbed `ask`.
 */
export async function compactMemory(ask?: MemoryAsk): Promise<boolean> {
  if (compacting) return false;
  const older = memory.turns.slice(0, Math.max(0, memory.turns.length - MEMORY_KEEP_TURNS));
  if (!older.length) return false;
  compacting = true;
  try {
    const raw = await (ask ?? defaultAsk)(compactionPrompt(memory, older));
    const digest = limitWords(stripToolMarkup(raw).replace(/\s+/g, ' '), MEMORY_DIGEST_WORDS);
    if (!digest) return false;
    memory = {
      ...memory,
      digest,
      digestAt: Date.now(),
      folded: memory.folded + older.length,
      turns: memory.turns.slice(older.length),
      updatedAt: Date.now(),
    };
    persist();
    emit();
    return true;
  } catch {
    // Keep the verbatim log: a relay that is down must not cost history.
    return false;
  } finally {
    compacting = false;
  }
}

/** Load the log from durable storage. Idempotent; call once per boot. */
export async function hydrateMemory(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await loadMemoryRaw();
    if (!raw) return;
    const parsed = sanitize(JSON.parse(raw));
    if (!parsed) return;
    memory = parsed;
    emit();
  } catch {
    /* corrupt or unavailable — start empty rather than refuse to run */
  }
}

/** Forget everything, here and in durable storage. */
export function resetMemory(): void {
  memory = empty();
  hydrated = true; // a late hydrate must not refill what the wearer just cleared
  emit();
  try {
    void clearMemoryRaw();
  } catch {
    /* ignore */
  }
}
