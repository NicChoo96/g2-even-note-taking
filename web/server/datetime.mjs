// Relative-date resolution for agent runs — the relay's clock.
//
// WHY THIS EXISTS
//   The model has no clock. "What is new in AI this week?" was answered from the
//   model's training data because NOTHING in the prompt said what "this week"
//   means. The fix is two-part and both parts happen BEFORE the first tool call:
//
//     1. dateTimeBlock() is appended to the system prompt of every run, so the
//        model always knows the exact date/time it is answering "as of".
//     2. preprocessText() rewrites common relative phrases ("today", "last
//        week", "past 1 year", "the past 3 months", …) into exact date ranges
//        appended to the user prompt, so the model does not have to infer them.
//
//   Everything is derived from the DEVICE clock at trigger time (the relay's
//   `run.startedAt`), never from the model. Zero dependencies; `now` is injected
//   so tools/datetime-sim.mjs can pin the clock and assert the arithmetic.

export const TIME_MARKER = '## Current date and time';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');

// ── Clock primitives ────────────────────────────────────────────────────────

/** Local wall-clock parts of an instant (what the user's phone shows). */
export function localParts(now = new Date()) {
  return {
    y: now.getFullYear(),
    m: now.getMonth() + 1,
    d: now.getDate(),
    hh: now.getHours(),
    mm: now.getMinutes(),
    ss: now.getSeconds(),
    wd: now.getDay(),
    ms: now.getTime(),
  };
}

export function tzOffsetMinutes(now = new Date()) {
  return -now.getTimezoneOffset();
}

/** 'UTC+08:00' — the honest label, always available. */
export function tzOffsetLabel(now = new Date()) {
  const off = tzOffsetMinutes(now);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 'Asia/Kuala_Lumpur' when the runtime can name it, else the offset label. */
export function tzName(now = new Date()) {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || tzOffsetLabel(now);
  } catch {
    return tzOffsetLabel(now);
  }
}

// ── Calendar arithmetic (all in UTC on local parts, so DST can't drift a day) ─

const fromParts = (p) => new Date(Date.UTC(p.y, p.m - 1, p.d));
const toParts = (dt) => ({
  y: dt.getUTCFullYear(),
  m: dt.getUTCMonth() + 1,
  d: dt.getUTCDate(),
  wd: dt.getUTCDay(),
});

export const iso = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
/** 'Wed 2026-09-09' — compact enough for a prompt line. */
export const fmt = (p) => `${WD[p.wd]} ${iso(p)}`;
export const fmtLong = (p) => `${WD_FULL[p.wd]}, ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;

export function addDays(p, n) {
  return toParts(new Date(fromParts(p).getTime() + n * DAY_MS));
}

export function addMonths(p, n) {
  const y = p.y + Math.floor((p.m - 1 + n) / 12);
  const m = ((((p.m - 1 + n) % 12) + 12) % 12) + 1;
  const d = Math.min(p.d, daysInMonth(y, m));
  return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

export function addYears(p, n) {
  return addMonths(p, n * 12);
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Monday-based start of the week containing `p`. */
export function startOfWeek(p) {
  return addDays(p, -((p.wd + 6) % 7));
}

export function startOfMonth(p) {
  return { y: p.y, m: p.m, d: 1, wd: new Date(Date.UTC(p.y, p.m - 1, 1)).getUTCDay() };
}

export function endOfMonth(p) {
  return toParts(new Date(Date.UTC(p.y, p.m, 0)));
}

export function startOfYear(p) {
  return { y: p.y, m: 1, d: 1, wd: new Date(Date.UTC(p.y, 0, 1)).getUTCDay() };
}

export function endOfYear(p) {
  return { y: p.y, m: 12, d: 31, wd: new Date(Date.UTC(p.y, 11, 31)).getUTCDay() };
}

export const quarterOf = (p) => Math.floor((p.m - 1) / 3) + 1;

export function startOfQuarter(p) {
  const m = (quarterOf(p) - 1) * 3 + 1;
  return { y: p.y, m, d: 1, wd: new Date(Date.UTC(p.y, m - 1, 1)).getUTCDay() };
}

export function endOfQuarter(p) {
  const m = quarterOf(p) * 3;
  return toParts(new Date(Date.UTC(p.y, m, 0)));
}

/** Saturday of the week containing `p` (paired with +1 day for the Sunday). */
const weekendStart = (p) => addDays(startOfWeek(p), 5);

function ctxFor(now) {
  const p = localParts(now);
  return { now, p, today: p };
}

// ── Relative-reference resolvers ────────────────────────────────────────────
// Order matters: more specific patterns first, because a match whose span is
// already claimed is skipped (so "last week" is not also read as "last 1 week").

const WEEKDAYS = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const UNITS = 'hours?|days?|weeks?|months?|years?';

const RESOLVERS = [
  // today / tonight / this morning …
  {
    re: /\b(today|tonight|this\s+(?:morning|afternoon|evening)|as\s+of\s+(?:today|now))\b/gi,
    note: (_m, c) => `today = ${fmt(c.today)}`,
  },
  {
    re: /\b(yesterday|tomorrow)\b/gi,
    note: (m, c) => {
      const w = m[0].toLowerCase();
      return `${w} = ${fmt(addDays(c.today, w === 'yesterday' ? -1 : 1))}`;
    },
  },
  // this / last / next + week | month | year
  {
    re: /\b(this|last|next)\s+(week|month|year)\b/gi,
    note: (m, c) => {
      const which = m[1].toLowerCase();
      const unit = m[2].toLowerCase();
      if (unit === 'week') {
        const base = which === 'this' ? startOfWeek(c.today) : addDays(startOfWeek(c.today), which === 'last' ? -7 : 7);
        // "this week" runs from Monday up to NOW — there is no news from the
        // future. "last"/"next" cover the full Mon→Sun calendar week.
        const end = which === 'this' ? c.today : addDays(base, 6);
        return `${which} week = ${fmt(base)} to ${fmt(end)}`;
      }
      if (unit === 'month') {
        const base = which === 'this' ? c.today : addMonths(c.today, which === 'last' ? -1 : 1);
        return `${which} month = ${MONTHS[base.m - 1]} ${base.y} (${iso(startOfMonth(base))} to ${iso(endOfMonth(base))})`;
      }
      const base = which === 'this' ? c.today : addYears(c.today, which === 'last' ? -1 : 1);
      return `${which} year = ${base.y} (${iso(startOfYear(base))} to ${iso(endOfYear(base))})`;
    },
  },
  // this / last / next weekend
  {
    re: /\b(this|last|next)\s+weekend\b/gi,
    note: (m, c) => {
      const which = m[1].toLowerCase();
      const sat =
        which === 'this'
          ? weekendStart(c.today)
          : addDays(weekendStart(c.today), which === 'last' ? -7 : 7);
      return `${which} weekend = ${fmt(sat)} to ${fmt(addDays(sat, 1))}`;
    },
  },
  // this / last / next + weekday name
  {
    re: new RegExp(`\\b(this|last|next)\\s+${WEEKDAYS}\\b`, 'gi'),
    note: (m, c) => {
      const which = m[1].toLowerCase();
      const target = WD_FULL.indexOf(cap(m[2]));
      const back = (c.today.wd - target + 7) % 7;
      const fwd = (target - c.today.wd + 7) % 7 || 7;
      const day =
        which === 'last'
          ? addDays(c.today, -back || -7)
          : which === 'next'
            ? addDays(c.today, fwd)
            : addDays(c.today, back);
      return `${which} ${m[2].toLowerCase()} = ${fmt(day)}`;
    },
  },
  // this / last / next quarter
  {
    re: /\b(this|last|next)\s+quarter\b/gi,
    note: (m, c) => {
      const which = m[1].toLowerCase();
      const base = which === 'this' ? c.today : addMonths(c.today, which === 'last' ? -3 : 3);
      const q = quarterOf(base);
      return `${which} quarter = Q${q} ${base.y} (${iso(startOfQuarter(base))} to ${iso(endOfQuarter(base))})`;
    },
  },
  // year to date
  {
    re: /\b(ytd|year[\s-]to[\s-]date)\b/gi,
    note: (_m, c) => `year to date = ${iso(startOfYear(c.today))} to ${fmt(c.today)}`,
  },
  // last / past / previous N units  — "past 1 year", "the past 3 months", "last 7 days"
  {
    re: new RegExp(
      `\\b(?:the\\s+)?(last|past|previous|trailing|rolling)\\s+(\\d{1,4})\\s+(${UNITS})\\b`,
      'gi',
    ),
    note: (m, c) => span(c.today, m[1], Number(m[2]), m[3], -1),
  },
  // next N units
  {
    re: new RegExp(`\\bnext\\s+(\\d{1,4})\\s+(${UNITS})\\b`, 'gi'),
    note: (m, c) => span(c.today, 'next', Number(m[1]), m[2], 1),
  },
  // bare last/past/previous unit — "last week" handled above; this catches
  // "the past month", "last year" is handled above too. Kept for "past hour".
  {
    re: /\b(?:the\s+)?(last|past|previous)\s+(hour|day|week|month|year)\b/gi,
    note: (m, c) => span(c.today, m[1], 1, m[2], -1),
  },
];

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase();

/** Build the "from → to" note for a relative window (always chronological). */
function span(today, _which, n, unitRaw, dir) {
  const unit = unitRaw.toLowerCase().replace(/s$/, '');
  const label = `${dir < 0 ? 'past' : 'next'} ${n} ${unit}${n === 1 ? '' : 's'}`;
  if (unit === 'hour') {
    const at = new Date(today.ms + dir * n * 3600000);
    const p = localParts(at);
    return `${label} = since ${fmt(p)} ${pad2(p.hh)}:${pad2(p.mm)}`;
  }
  let other;
  if (unit === 'month') other = addMonths(today, dir * n);
  else if (unit === 'year') other = addYears(today, dir * n);
  else other = addDays(today, dir * n * (unit === 'week' ? 7 : 1));
  const from = dir < 0 ? other : today;
  const to = dir < 0 ? today : other;
  return `${label} = ${iso(from)} to ${fmt(to)}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Rewrite common relative time phrases into exact ranges, APPENDED to the text
 * so the user's own wording is preserved. Idempotent per input; returns
 * `{ text, notes }` where `notes` are the resolutions that were found.
 */
export function preprocessText(text, now = new Date()) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { text: raw, notes: [] };
  // Idempotent: drop any resolutions line added by an earlier pass so running
  // this twice (or re-running a stored prompt) never stacks duplicates.
  const s = raw.replace(/\n*\[Resolved time references \(device clock\):[^\]]*\]\s*$/i, '').trimEnd();
  if (!s) return { text: raw, notes: [] };
  const c = ctxFor(now);
  const claimed = [];
  const found = [];
  for (const r of RESOLVERS) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(s)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) {
        r.re.lastIndex++;
        continue;
      }
      if (claimed.some(([a, b]) => start < b && end > a)) continue;
      const note = r.note(m, c);
      if (!note) continue;
      claimed.push([start, end]);
      found.push({ start, note });
    }
  }
  if (!found.length) return { text: s, notes: [] };
  found.sort((a, b) => a.start - b.start);
  const notes = [];
  for (const f of found) if (!notes.includes(f.note)) notes.push(f.note);
  const line = `[Resolved time references (device clock): ${notes.join('; ')}]`;
  return { text: `${s.trimEnd()}\n\n${line}`, notes };
}

/** The block appended to every system prompt. */
export function dateTimeBlock(now = new Date()) {
  const p = localParts(now);
  return [
    TIME_MARKER,
    `- Local time: ${fmtLong(p)}, ${pad2(p.hh)}:${pad2(p.mm)} (${tzName(now)}, ${tzOffsetLabel(now)})`,
    `- Date: ${iso(p)}`,
    `- This week: ${fmt(startOfWeek(p))} to ${fmt(p)}`,
    `- Yesterday: ${fmt(addDays(p, -1))} · Tomorrow: ${fmt(addDays(p, 1))}`,
    '',
    'Relative periods ("today", "this week", "last week", "the past 3 months")',
    'mean the exact dates above — they come from the device clock at the moment',
    'this run started. Put the resolved range in your search query (for example',
    '"AI news September 2026"). Never guess the current date, and never assume',
    'your training cutoff is now.',
  ].join('\n');
}

/** Idempotent: appending twice leaves exactly one block. */
export function withDateTime(systemPrompt, now = new Date()) {
  const base = String(systemPrompt ?? '').trim();
  if (base.includes(TIME_MARKER)) return base;
  const block = dateTimeBlock(now);
  return base ? `${base}\n\n${block}` : block;
}

/**
 * Inject the clock into an OpenAI-style message list: stamp the system message
 * (creating one if needed) and resolve relative phrases in the last user turn.
 */
export function withDateTimeMessages(messages, now = new Date()) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  if (list.length && list[0]?.role === 'system') {
    list[0].content = withDateTime(list[0].content, now);
  } else {
    list.unshift({ role: 'system', content: withDateTime('', now) });
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user' && typeof list[i].content === 'string') {
      list[i].content = preprocessText(list[i].content, now).text;
      break;
    }
  }
  return list;
}
