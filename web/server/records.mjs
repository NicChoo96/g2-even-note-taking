// RECORDS: rows whose COLUMNS are stored as data.
//
// WHY THIS IS BESIDE THE METRIC STORE RATHER THAN INSIDE IT.
//   A series is one value at one time. That is enough for a share price and
//   useless for a launch, which is five facts about one thing: a date, a flat
//   type, a project, an estate and a price. The metric store's answer was five
//   SIBLING SERIES joined by slot — a convention the writer had to remember and
//   the store could not check. A record is the row itself: one identity, a JSON
//   body, and a schema that lives in another table so it can be widened by a
//   write instead of by a migration.
//
// WHAT THE HUB OWNS, AND WHAT THIS MIRRORS.
//   The authoritative implementation is Python (`jarviscs/hub/records.py`,
//   `repository/records.py`, `routes/records.py`). This module is the RELAY's
//   half: the same rules as pure functions, plus a local store for the mode
//   where no hub is configured. It mirrors rather than invents — the field key
//   regex, the record key alphabet, the caps, the inference table and the `ts`
//   derivation are the hub's, because a relay that disagreed with the store
//   would teach a model one shape and punish it for the other.
//
// THE ONE RULE THAT MAKES SOFT MODE SAFE.
//   An unknown field is INFERRED and the schema grows — that is what makes "the
//   AI builds the schema as it goes" work. The cost is that a typo becomes a
//   column, so every write reports exactly what it added (`addedFields`), and
//   `nearDuplicate` finds a new name that is one slip away from an existing one
//   so the caller can be told by name. Strictness is per object for the tables
//   a human cares about.
//
// Zero dependencies, pure except for `createLocalRecords`, which mutates the
// document it is handed and nothing else.

import { SERIES_KEY_RE, slotInstant } from './metrics.mjs';

/** What a field may hold. Fixed once the field exists. */
export const RECORD_TYPES = ['text', 'number', 'bool', 'date'];

/** A field key is a column name: no dots — the object key carries the namespace. */
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * A record key is the row's identity and is compared as a STRING, never
 * normalised: `2023-10-15` and `2023-10-15T00:00` are two different rows.
 */
export const RECORD_KEY_RE = /^[A-Za-z0-9:._ -]{1,64}$/;

export const MAX_FIELDS = 40;
export const MAX_RECORDS_PER_WRITE = 32;
export const BODY_MAX_BYTES = 8192;
export const TEXT_MAX = 500;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const SORTS = ['ts', 'key', 'created', 'updated'];
export const ORDERS = ['asc', 'desc'];
export const DEFAULT_PRECISION = 2;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The instant a date-shaped value names, plus the form to store it in.
 *
 * `2023-10-15`, `2023-10`, `2023-10-15 13:00` and `2023-10-15T13:00` come from
 * `slotInstant`, which already refuses the impossible ones (31 February rolls
 * over in `Date.UTC` and would otherwise be invented rather than rejected).
 * Anything else has to look like a date at the front — `Date.parse('March')`
 * succeeds, and "March" is a label, not a moment.
 */
export function dateValue(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const simple = slotInstant(text);
  if (simple !== null) return { text: text.replace(' ', 'T'), ms: simple };
  // THE FALLBACK IS FOR A FULL ISO INSTANT ONLY, never for a plain date.
  // `Date.parse('2023-02-31')` does not throw and does not return NaN — V8 rolls
  // it into 3 March. So `slotInstant` (which checks the day against the month) is
  // the only authority for a bare date; the parser is allowed in only when there
  // is a time and a zone the slot shape does not model.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return { text: text.slice(0, 16).replace(' ', 'T'), ms };
}

/**
 * `(type, stored)` for a value the schema has never seen — the inference table.
 *
 * ORDER IS LOAD-BEARING, exactly as on the hub: `bool` before number (because
 * `typeof true` is not 'number' but a JSON `true` in a numeric column would be
 * stored as 1), and a date before text (because `2026-03-14` is a string and
 * only the order decides whether it sorts as a date or as an opaque label).
 */
export function inferValue(raw, field = 'value') {
  if (typeof raw === 'boolean') return { ok: true, type: 'bool', value: raw };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: `${field} must be a finite number` };
    return { ok: true, type: 'number', value: raw };
  }
  if (typeof raw === 'string') {
    const date = dateValue(raw);
    if (date) return { ok: true, type: 'date', value: date.text };
    if (raw.length > TEXT_MAX) {
      return { ok: false, error: `${field} is ${raw.length} characters — the limit is ${TEXT_MAX}` };
    }
    return { ok: true, type: 'text', value: raw };
  }
  return {
    ok: false,
    error: `${field} must be a string, number or boolean (a nested object or array is a document, not a cell)`,
  };
}

/**
 * Fit a value to a DECLARED type, or say why not.
 *
 * `null` never reaches here: a null means "I have nothing for this", so it
 * creates no field and leaves an existing one alone. Blank is not zero —
 * `Number('')` is 0 and that turns a missing reading into a real one.
 */
export function coerceValue(raw, type, field = 'value') {
  if (type === 'number') {
    const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    const n = typeof raw === 'number' ? raw : blank ? Number.NaN : Number(String(raw).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) {
      return { ok: false, error: `${field} must be a number — this field is declared as number` };
    }
    return { ok: true, value: n };
  }
  if (type === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const text = String(raw ?? '').trim().toLowerCase();
    if (text === 'true' || text === 'yes' || text === '1') return { ok: true, value: true };
    if (text === 'false' || text === 'no' || text === '0') return { ok: true, value: false };
    return { ok: false, error: `${field} must be true or false — this field is declared as bool` };
  }
  if (type === 'date') {
    const date = dateValue(raw);
    if (!date) return { ok: false, error: `${field} must be a date like 2023-10-15 — this field is declared as date` };
    return { ok: true, value: date.text };
  }
  // text: numbers are stringified rather than refused — "290000" in a text
  // column is a fact, not an error.
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (text.length > TEXT_MAX) {
    return { ok: false, error: `${field} is ${text.length} characters — the limit is ${TEXT_MAX}` };
  }
  return { ok: true, value: text };
}

/** `field key -> type`, in schema order. */
export function typesOf(fields) {
  const out = {};
  for (const f of Array.isArray(fields) ? fields : []) {
    if (f && typeof f.key === 'string') out[f.key] = String(f.type ?? 'text');
  }
  return out;
}

/**
 * The record's instant, or `null` — and `null` is a legitimate answer.
 *
 * 1. a `date`-typed field (schema order decides, so it is deterministic);
 * 2. else the record key, when it is a date (`2023-10-15` keyed by its launch);
 * 3. else nothing, and the row sorts by `createdAt`.
 *
 * Rule 3 is why non-time-series rows work at all: a phone number in a contacts
 * table has no place on a time axis, and inventing "now" would plot it there.
 */
export function deriveTs(values, fields, recKey = '') {
  const map = values && typeof values === 'object' ? values : {};
  for (const f of Array.isArray(fields) ? fields : []) {
    if (f?.type !== 'date') continue;
    const stored = map[f.key];
    if (typeof stored !== 'string') continue;
    const date = dateValue(stored);
    if (date) return date.ms;
  }
  if (recKey) {
    const date = dateValue(recKey);
    if (date) return date.ms;
  }
  return null;
}

/** One field descriptor, or a sentence. */
export function normaliseField(raw, field = 'field') {
  if (!isPlainObject(raw)) return { ok: false, error: `${field} must be an object` };
  const unknown = Object.keys(raw).filter((k) => !['key', 'label', 'type', 'unit', 'precision'].includes(k));
  if (unknown.length) {
    return {
      ok: false,
      error: `${field} has unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.join(', ')} — allowed: key, label, type, unit, precision`,
    };
  }
  const key = String(raw.key ?? '').trim();
  if (!FIELD_KEY_RE.test(key)) {
    return { ok: false, error: `${field}.key "${key}" must be lowercase letters, digits and underscores, starting with a letter (e.g. price, launch_date)` };
  }
  const type = String(raw.type ?? '').trim().toLowerCase();
  if (!RECORD_TYPES.includes(type)) {
    // A missing type is NOT defaulted to text: a field declared text by accident
    // stores every later number as a string and no read will say so.
    return { ok: false, error: `${field}.type must be one of ${RECORD_TYPES.join(', ')} — got "${raw.type ?? ''}"` };
  }
  const precision = Number(raw.precision);
  return {
    ok: true,
    field: {
      key,
      label: String(raw.label ?? '').trim().slice(0, 120) || key,
      type,
      unit: String(raw.unit ?? '').trim().slice(0, 32),
      precision: Number.isFinite(precision) ? Math.max(0, Math.min(6, Math.floor(precision))) : DEFAULT_PRECISION,
    },
  };
}

/** An object declaration: key, label, strict flag, field list. */
export function normaliseObject(input) {
  if (!isPlainObject(input)) return { ok: false, error: 'an object must be an object' };
  const unknown = Object.keys(input).filter((k) => !['key', 'series', 'label', 'strict', 'fields'].includes(k));
  if (unknown.length) {
    return { ok: false, error: `unknown ${unknown.length === 1 ? 'field' : 'fields'} ${unknown.join(', ')} — allowed: key, label, strict, fields` };
  }
  const key = String(input.key ?? input.series ?? '').trim().toLowerCase();
  // The SAME alphabet as a series key, on purpose: a client can treat the two
  // stores alike, and a dotted key groups in a list without a second table.
  if (!SERIES_KEY_RE.test(key)) {
    return { ok: false, error: `object key "${key}" must be dotted, lowercase and 2–6 segments (e.g. bto.launch)` };
  }
  let fields = [];
  if (input.fields !== undefined && input.fields !== null) {
    if (!Array.isArray(input.fields)) return { ok: false, error: 'fields must be an array of {key, type}' };
    if (input.fields.length > MAX_FIELDS) {
      return { ok: false, error: `fields holds ${input.fields.length} — the limit is ${MAX_FIELDS}` };
    }
    const seen = new Set();
    for (let i = 0; i < input.fields.length; i++) {
      const parsed = normaliseField(input.fields[i], `fields[${i}]`);
      if (!parsed.ok) return parsed;
      if (seen.has(parsed.field.key)) {
        return { ok: false, error: `fields[${i}].key duplicates an earlier field ("${parsed.field.key}")` };
      }
      seen.add(parsed.field.key);
      fields.push(parsed.field);
    }
  }
  return {
    ok: true,
    object: {
      key,
      label: String(input.label ?? '').trim().slice(0, 120) || key,
      strict: input.strict === true || input.strict === 'true' || input.strict === 1,
      fields,
    },
  };
}

/**
 * Merge descriptors into an existing schema. ADDITIVE ONLY.
 *
 * A type change is refused rather than applied: every value already stored under
 * the old type is what conflicts, so a retry cannot help and the right move is a
 * new field name. Label/unit/precision stay editable — they describe how to
 * render a cell, not what is in it.
 */
export function mergeFields(current, incoming) {
  const out = (Array.isArray(current) ? current : []).map((f) => ({ ...f }));
  const byKey = new Map(out.map((f) => [f.key, f]));
  for (const next of Array.isArray(incoming) ? incoming : []) {
    const existing = byKey.get(next.key);
    if (!existing) {
      out.push({ ...next });
      byKey.set(next.key, out[out.length - 1]);
      continue;
    }
    if (existing.type !== next.type) {
      return {
        ok: false,
        code: 'FIELD_SHAPE_LOCKED',
        error:
          `"${next.key}" is already a ${existing.type} field — its type cannot change, because every value ` +
          `already stored reads as ${existing.type}. Use a new field name for ${next.type} data.`,
        current: existing,
        requested: next,
      };
    }
    existing.label = next.label;
    existing.unit = next.unit;
    existing.precision = next.precision;
  }
  if (out.length > MAX_FIELDS) {
    return { ok: false, error: `the schema would hold ${out.length} fields — the limit is ${MAX_FIELDS}` };
  }
  return { ok: true, fields: out };
}

/** Levenshtein distance, capped: only ever asked "is this ≤ 2?" */
export function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > 2) return 3;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    for (let j = 1; j <= t.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[t.length];
}

/**
 * An existing field a new one is one slip away from — `estate` vs `estates`.
 *
 * Not a refusal: the write succeeds, because the model may be right. It is the
 * sentence that turns a silent second column into a question the caller can see
 * and fix, which is the containment the soft mode depends on.
 */
export function nearDuplicate(fields, key) {
  const wanted = String(key ?? '');
  if (!wanted) return null;
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f?.key || f.key === wanted) continue;
    if (editDistance(f.key, wanted) <= 2) return f.key;
  }
  return null;
}

/**
 * Structurally parse a batch of records.
 *
 * A malformed REQUEST (not an array, empty, over the cap) fails whole; anything
 * inside one entry is per-item, because an agent that summarised a page and got
 * one row wrong must not lose the other eleven.
 */
export function parseRecordBatch(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'records must be an array of {key, values}' };
  if (!raw.length) return { ok: false, error: 'records must not be empty' };
  if (raw.length > MAX_RECORDS_PER_WRITE) {
    return { ok: false, error: `${raw.length} records in one write — the limit is ${MAX_RECORDS_PER_WRITE}` };
  }
  const entries = [];
  const rejected = [];
  const seen = new Map();
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    const prefix = `records[${index}]`;
    if (!isPlainObject(item)) {
      rejected.push({ index, field: prefix, error: 'must be an object with key and values', code: 'INVALID_VALUE' });
      continue;
    }
    const key = String(item.key ?? '').trim();
    if (!RECORD_KEY_RE.test(key)) {
      rejected.push({
        index,
        field: `${prefix}.key`,
        error: `"${key}" is not a row key — 1–64 characters of letters, digits, : . _ space or dash (e.g. 2023-10-15)`,
        code: 'BAD_RECORD_KEY',
      });
      continue;
    }
    if (seen.has(key)) {
      rejected.push({
        index,
        field: `${prefix}.key`,
        error: `duplicates records[${seen.get(key)}] in this batch — two rows cannot claim the same identity`,
        code: 'INVALID_VALUE',
      });
      continue;
    }
    if (!isPlainObject(item.values) || !Object.keys(item.values).length) {
      rejected.push({ index, field: `${prefix}.values`, error: 'values must be an object with at least one field', code: 'INVALID_VALUE' });
      continue;
    }
    seen.set(key, index);
    entries.push({ index, key, values: item.values, replace: item.replace === true });
  }
  if (!entries.length) {
    return { ok: false, error: 'no record in the batch was accepted', rejected };
  }
  return { ok: true, entries, rejected };
}

/** A limit in the range the store will actually answer. */
export function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

/** `ts` | `key` | `created` | `updated` | a field name. Unknown → refused. */
export function requireSort(raw, fields, fallback = 'ts') {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: true, sort: fallback };
  const map = typesOf(fields);
  if (SORTS.includes(name) || Object.prototype.hasOwnProperty.call(map, name)) return { ok: true, sort: name };
  return {
    ok: false,
    error: `sort "${name}" is neither ts, key, created, updated nor a field of this object (${Object.keys(map).join(', ') || 'no fields yet'})`,
  };
}

/** `field=value`, or `field>=value` / `field<=value` on a numeric field. */
export function parseWhere(raw, fields) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, where: null };
  const match = /^([a-z][a-z0-9_]{0,31})\s*(>=|<=|=)\s*(.+)$/.exec(text);
  if (!match) {
    return { ok: false, error: `where must be field=value, field>=value or field<=value — got "${text}"` };
  }
  const [, field, op, raw2] = match;
  const map = typesOf(fields);
  if (!Object.prototype.hasOwnProperty.call(map, field)) {
    return {
      ok: false,
      error: `where names "${field}", which this object does not have — fields: ${Object.keys(map).join(', ') || '(none yet)'}`,
    };
  }
  const type = map[field];
  if (op !== '=' && type !== 'number') {
    return { ok: false, error: `where "${op}" needs a numeric field — "${field}" is ${type}` };
  }
  let value;
  if (type === 'number') {
    value = Number(String(raw2).replace(/,/g, '').trim());
    if (!Number.isFinite(value)) return { ok: false, error: `where "${field}" is numeric — "${raw2}" is not a number` };
  } else if (type === 'bool') {
    value = /^(true|yes|1)$/i.test(String(raw2).trim());
  } else {
    value = String(raw2).trim();
  }
  return { ok: true, where: { field, op, value } };
}

// ── Local store (relay-only mode) ────────────────────────────────────────────
/**
 * The same contract as the hub, over a plain document.
 *
 * Relay-only mode has to behave the same way or the feature is only testable on
 * a machine with a hub: this is what a harness drives, and what a relay without
 * `METRICS_API` serves. Every method returns the hub's shape, including
 * `addedFields` and the per-item `rejected` list, so no caller can tell which
 * store answered.
 */
export function createLocalRecords(doc) {
  const state = {
    objects: isPlainObject(doc?.objects) ? doc.objects : {},
    records: isPlainObject(doc?.records) ? doc.records : {},
  };
  const now = () => Date.now();

  function stats(key) {
    const rows = Object.values(state.records[key] ?? {});
    const latest = rows.reduce((max, r) => (typeof r.ts === 'number' && r.ts > max ? r.ts : max), -Infinity);
    return { count: rows.length, latestTs: Number.isFinite(latest) ? latest : null };
  }

  function objectItem(key) {
    const o = state.objects[key];
    if (!o) return null;
    return { ...o, fields: o.fields.map((f) => ({ ...f })), ...stats(key) };
  }

  function declare(input) {
    const parsed = normaliseObject(input);
    if (!parsed.ok) return { ok: false, code: 'INVALID_VALUE', error: parsed.error };
    const next = parsed.object;
    const existing = state.objects[next.key];
    const stamp = now();
    if (!existing) {
      state.objects[next.key] = {
        key: next.key,
        label: next.label,
        strict: next.strict,
        fields: next.fields,
        createdAt: stamp,
        updatedAt: stamp,
      };
      return { ok: true, created: true, object: objectItem(next.key) };
    }
    const merged = mergeFields(existing.fields, next.fields);
    if (!merged.ok) {
      return {
        ok: false,
        code: merged.code ?? 'INVALID_VALUE',
        error: merged.error,
        details: merged,
        // The hub's 409 carries the stored descriptor; the local store says the
        // same thing in the same words so a caller cannot tell which answered.
        ...(merged.code === 'FIELD_SHAPE_LOCKED' ? { shapeLocked: true, current: merged.current } : {}),
      };
    }
    existing.label = input.label === undefined || input.label === null || String(input.label).trim() === ''
      ? existing.label
      : next.label;
    // An omitted `strict` means "leave it alone", not "reset to soft".
    if (input.strict !== undefined && input.strict !== null) existing.strict = next.strict;
    existing.fields = merged.fields;
    existing.updatedAt = stamp;
    return { ok: true, created: false, object: objectItem(next.key) };
  }

  function ensure(key) {
    if (state.objects[key]) return null;
    return declare({ key, fields: [] });
  }

  function read(key, { limit, offset = 0, sort = 'ts', order = 'desc', where = null } = {}) {
    if (!state.objects[key]) return { ok: false, code: 'NOT_FOUND', notFound: true, status: 404, error: `object "${key}" not found` };
    const fields = state.objects[key].fields;
    let rows = Object.values(state.records[key] ?? {}).map((r) => ({ ...r, values: { ...r.values } }));
    if (where) {
      rows = rows.filter((r) => {
        const v = r.values?.[where.field];
        if (where.op === '=') return String(v) === String(where.value);
        if (typeof v !== 'number') return false;
        return where.op === '>=' ? v >= where.value : v <= where.value;
      });
    }
    const total = rows.length;
    const direction = order === 'asc' ? 1 : -1;
    const keyOf = (r) => {
      if (sort === 'key') return r.key;
      if (sort === 'created') return r.createdAt;
      if (sort === 'updated') return r.updatedAt;
      if (sort === 'ts') return r.ts;
      return r.values?.[sort];
    };
    rows.sort((a, b) => {
      const av = keyOf(a);
      const bv = keyOf(b);
      // Unordered rows sort LAST rather than first: a page of "newest" must not
      // be padded with rows whose place in time is unknown.
      if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
      if (bv === null || bv === undefined) return -1;
      if (av === bv) return String(a.key).localeCompare(String(b.key));
      return av > bv ? direction : -direction;
    });
    const size = clampLimit(limit);
    return { ok: true, records: rows.slice(offset, offset + size), total, fields };
  }

  function object(key, { limit = DEFAULT_LIMIT } = {}) {
    const item = objectItem(key);
    if (!item) return { ok: false, code: 'NOT_FOUND', notFound: true, status: 404, error: `object "${key}" not found` };
    const page = read(key, { limit, sort: 'ts', order: 'desc' });
    return { ok: true, object: item, records: page.records ?? [], total: page.total ?? 0 };
  }

  function objects() {
    return { ok: true, objects: Object.keys(state.objects).sort().map((k) => objectItem(k)) };
  }

  function write(key, rawRecords) {
    const batch = parseRecordBatch(rawRecords);
    if (!batch.ok) return { ok: false, code: 'INVALID_VALUE', error: batch.error, rejected: batch.rejected ?? [] };
    const created = ensure(key);
    if (created && !created.ok) return created;
    const schema = state.objects[key];
    const added = [];
    const written = [];
    const rejected = [...batch.rejected];
    for (const entry of batch.entries) {
      // A TRIAL copy: a rejected row must not leave behind a column only it used.
      const trial = schema.fields.map((f) => ({ ...f }));
      const types = typesOf(trial);
      const values = {};
      let failure = null;
      for (const [name, raw] of Object.entries(entry.values)) {
        if (raw === null || raw === undefined) continue;
        if (!FIELD_KEY_RE.test(name)) {
          failure = { field: name, error: `"${name}" is not a field name — lowercase letters, digits and underscores, starting with a letter`, code: 'BAD_FIELD_KEY' };
          break;
        }
        const known = types[name];
        if (known === undefined) {
          if (schema.strict) {
            failure = {
              field: name,
              error: `"${name}" is not a field of this object — allowed: ${Object.keys(types).join(', ') || '(none)'}`,
              code: 'UNKNOWN_FIELD',
            };
            break;
          }
          const inferred = inferValue(raw, name);
          if (!inferred.ok) {
            failure = { field: name, error: inferred.error, code: 'INVALID_VALUE' };
            break;
          }
          trial.push({ key: name, label: name, type: inferred.type, unit: '', precision: DEFAULT_PRECISION });
          types[name] = inferred.type;
          added.push({ key: name, label: name, type: inferred.type, unit: '', precision: DEFAULT_PRECISION, inferred: true });
          values[name] = inferred.value;
          continue;
        }
        const coerced = coerceValue(raw, known, name);
        if (!coerced.ok) {
          failure = { field: name, error: coerced.error, code: 'INVALID_VALUE' };
          break;
        }
        values[name] = coerced.value;
      }
      if (failure) {
        rejected.push({ index: entry.index, ...failure });
        continue;
      }
      if (!Object.keys(values).length) {
        rejected.push({ index: entry.index, field: `records[${entry.index}]`, error: 'must carry at least one non-null field', code: 'INVALID_VALUE' });
        continue;
      }
      const rowKey = entry.key;
      const existing = state.records[key]?.[rowKey];
      const body = entry.replace || !existing ? { ...values } : { ...existing.values, ...values };
      const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
      if (size > BODY_MAX_BYTES) {
        rejected.push({ index: entry.index, field: `records[${entry.index}]`, error: `the row is ${size} bytes — the limit is ${BODY_MAX_BYTES}`, code: 'INVALID_VALUE' });
        continue;
      }
      const stamp = now();
      state.records[key] = state.records[key] ?? {};
      state.records[key][rowKey] = {
        key: rowKey,
        values: body,
        ts: deriveTs(body, trial, rowKey),
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: stamp,
      };
      schema.fields = trial;
      written.push({ key: rowKey, action: existing ? 'updated' : 'inserted' });
    }
    if (added.length) schema.updatedAt = now();
    if (!written.length) {
      return { ok: false, code: 'INVALID_VALUE', error: 'no record in the batch was accepted', rejected };
    }
    return { ok: true, accepted: written.length, records: written, addedFields: added, rejected };
  }

  function patchRecord(key, rec, values) {
    if (!state.objects[key]) return { ok: false, code: 'NOT_FOUND', notFound: true, status: 404, error: `object "${key}" not found` };
    if (!state.records[key]?.[rec]) return { ok: false, code: 'NOT_FOUND', notFound: true, status: 404, error: `record "${rec}" not found` };
    const res = write(key, [{ key: rec, values }]);
    if (!res.ok) return res;
    return { ok: true, record: { ...state.records[key][rec], values: { ...state.records[key][rec].values } }, addedFields: res.addedFields, rejected: res.rejected };
  }

  function removeRecord(key, rec) {
    if (!state.objects[key]) return { ok: false, code: 'NOT_FOUND', notFound: true, status: 404, error: `object "${key}" not found` };
    if (!state.records[key]?.[rec]) return { ok: false, code: 'NOT_FOUND', notFound: true, status: 404, error: `record "${rec}" not found` };
    delete state.records[key][rec];
    return { ok: true, deleted: 1 };
  }

  function patch(key, change = {}) {
    const existing = state.objects[key];
    if (!existing) return { ok: false, code: 'NOT_FOUND', notFound: true, status: 404, error: `object "${key}" not found` };
    const addFields = [];
    if (Array.isArray(change.addFields)) {
      for (let i = 0; i < change.addFields.length; i++) {
        const parsed = normaliseField(change.addFields[i], `addFields[${i}]`);
        if (!parsed.ok) return { ok: false, code: 'INVALID_VALUE', error: parsed.error };
        addFields.push(parsed.field);
      }
    }
    const drop = Array.isArray(change.dropFields) ? change.dropFields.map((s) => String(s)) : [];
    const merged = mergeFields(existing.fields, addFields);
    if (!merged.ok) return { ok: false, code: merged.code ?? 'INVALID_VALUE', error: merged.error };
    const present = new Set(merged.fields.map((f) => f.key));
    const missing = drop.filter((name) => !present.has(name));
    if (missing.length) {
      return { ok: false, code: 'INVALID_VALUE', error: `dropFields names ${missing.join(', ')}, which this object does not have — fields: ${[...present].join(', ')}` };
    }
    let rewritten = 0;
    if (drop.length) {
      for (const row of Object.values(state.records[key] ?? {})) {
        let touched = false;
        for (const name of drop) {
          if (Object.prototype.hasOwnProperty.call(row.values, name)) {
            delete row.values[name];
            touched = true;
          }
        }
        if (touched) {
          row.updatedAt = now();
          row.ts = deriveTs(row.values, merged.fields, row.key);
          rewritten += 1;
        }
      }
    }
    existing.fields = merged.fields.filter((f) => !drop.includes(f.key));
    if (change.label !== undefined && change.label !== null) existing.label = String(change.label).slice(0, 120) || existing.label;
    if (change.strict !== undefined && change.strict !== null) existing.strict = change.strict === true;
    existing.updatedAt = now();
    return { ok: true, object: objectItem(key), rewritten };
  }

  function remove(key, { purge = false } = {}) {
    if (!state.objects[key]) return { ok: false, code: 'NOT_FOUND', notFound: true, status: 404, error: `object "${key}" not found` };
    const count = Object.keys(state.records[key] ?? {}).length;
    if (count && !purge) {
      return {
        ok: false,
        code: 'OBJECT_NOT_EMPTY',
        status: 409,
        notEmpty: true,
        count,
        error: `"${key}" still holds ${count} record${count === 1 ? '' : 's'} — delete those too, or keep the object`,
      };
    }
    delete state.records[key];
    delete state.objects[key];
    return { ok: true, deletedRecords: count };
  }

  return { state, objects, object, declare, read, write, patchRecord, removeRecord, patch, remove };
}
