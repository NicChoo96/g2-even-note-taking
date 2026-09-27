// The location fix vocabulary — ONE shape for one device fix, whoever supplied it.
//
// WHY THIS FILE IS SEPARATE, AND PURE
//   A fix reaches this app by one of exactly two routes, and the wearer's
//   experience of them is completely different:
//     • 'hub'     — the packaged Even Hub app. The SDK bridge asks the HOST, which
//                   reads the phone's location services. No page-level prompt;
//                   `location` in app.json is the grant, and the pack step is
//                   what validates that name.
//     • 'browser' — a plain web page, where no bridge exists. navigator.geolocation
//                   raises the BROWSER's own permission prompt.
//   Both must land in THIS shape, or every consumer downstream has to know which
//   host it is running in. That is the whole point of the split: acquisition
//   lives in ./source.ts, and this file holds the vocabulary the rest of the app
//   — the Jarvis capability, the agent-run snapshot, the relay's tool, the
//   harnesses — is written against.
//
//   So nothing here acquires a fix, reads a bridge, touches the DOM, or imports
//   the SDK. The single clock use is a last-resort stamp (see normalizeFix), and
//   a harness imports this file directly to assert the semantics.

/** Where a fix came from. `hub` is the Even App host; `browser` is the page. */
export type FixSource = 'hub' | 'browser';

/** How hard to try. These strings are the SDK enum's own values, verbatim. */
export type AccuracyHint = 'low' | 'medium' | 'high';

export const ACCURACY_HINTS: readonly AccuracyHint[] = ['low', 'medium', 'high'];

export interface LocationFix {
  latitude: number;
  longitude: number;
  /** Radius of uncertainty in metres, when the device reports one. */
  accuracy?: number;
  /** Metres above sea level, when the device reports it. */
  altitude?: number;
  /** Metres per second, when the device reports it. */
  speed?: number;
  /** Degrees clockwise from true north, when the device reports it. */
  heading?: number;
  /** The host's own stamp on the reading, if it supplied one. */
  timestamp?: number;
  source: FixSource;
  /** When THIS app read the fix. The only field age is ever measured from. */
  capturedAt: number;
}

/**
 * A fix older than this is reported as stale wherever it is shown.
 *
 * Ten minutes is not a precision claim, it is a floor on honesty: a wearer who
 * has moved across a town has a fix that is GPS-accurate and still wrong, and the
 * model downstream cannot tell that from a fresh one unless it is told.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export function isAccuracyHint(value: unknown): value is AccuracyHint {
  return typeof value === 'string' && (ACCURACY_HINTS as readonly string[]).includes(value);
}

/** A finite number, or nothing — so one bad field cannot poison the whole fix. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * One validated fix, or null.
 *
 * Latitude and longitude are the ONLY required members, and the test on them is
 * RANGE, not truthiness: 0/0 is a real coordinate in the Gulf of Guinea, so a
 * host reporting it must be believed. What must not be believed is a missing or
 * out-of-range pair — and the honest answer to one is "no fix", never a
 * substituted default.
 */
export function normalizeFix(raw: unknown, source: FixSource, capturedAt: number): LocationFix | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const latitude = num(r.latitude);
  const longitude = num(r.longitude);
  if (latitude === undefined || longitude === undefined) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  const fix: LocationFix = {
    latitude,
    longitude,
    source,
    // The caller always passes a stamp; this fallback exists so a malformed one
    // degrades to "now" instead of to a NaN age that would render as garbage.
    capturedAt: num(capturedAt) ?? Date.now(),
  };

  const accuracy = num(r.accuracy);
  if (accuracy !== undefined && accuracy >= 0) fix.accuracy = accuracy;
  const altitude = num(r.altitude);
  if (altitude !== undefined) fix.altitude = altitude;
  const speed = num(r.speed);
  if (speed !== undefined && speed >= 0) fix.speed = speed;
  const heading = num(r.heading);
  if (heading !== undefined && heading >= 0 && heading <= 360) fix.heading = heading;
  const timestamp = num(r.timestamp);
  if (timestamp !== undefined) fix.timestamp = timestamp;

  return fix;
}

/** Five decimals is about 1.1 m — actionable, and short enough for the HUD. */
export function formatCoords(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export function formatAccuracy(meters: number | undefined): string {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return '';
  return meters < 10 ? `±${meters.toFixed(1)} m` : `±${Math.round(meters)} m`;
}

export function formatAltitude(meters: number | undefined): string {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return '';
  return `${Math.round(meters)} m above sea level`;
}

export function formatSpeed(mps: number | undefined): string {
  if (typeof mps !== 'number' || !Number.isFinite(mps) || mps < 0) return '';
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function formatHeading(degrees: number | undefined): string {
  if (typeof degrees !== 'number' || !Number.isFinite(degrees)) return '';
  const deg = ((degrees % 360) + 360) % 360;
  return `${Math.round(deg)}° ${COMPASS[Math.round(deg / 45) % 8]}`;
}

/** How long ago the fix was READ. Never negative, so clock skew reads as "now". */
export function fixAgeMs(fix: LocationFix, now: number): number {
  const age = now - fix.capturedAt;
  return Number.isFinite(age) && age > 0 ? age : 0;
}

export function isStale(fix: LocationFix, now: number = Date.now()): boolean {
  return fixAgeMs(fix, now) > STALE_AFTER_MS;
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'just now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * The label for a fix that was remembered rather than freshly read.
 *
 * Worded so it cannot be skimmed as current: the age is always present, and it
 * says `stale` once the fix is past STALE_AFTER_MS. This string is the ONLY
 * thing standing between a remembered fix and a claim about where the wearer is
 * right now, so it is generated in one place and never hand-written at a call
 * site.
 */
export function ageNote(fix: LocationFix, now: number = Date.now()): string {
  return `${isStale(fix, now) ? 'stale' : 'last known'}, ${formatAge(fixAgeMs(fix, now))}`;
}

/** The glasses' own one-line rendering of a fix — emoji-free and HUD-short. */
export function fixLine(fix: LocationFix): string {
  const parts = [formatCoords(fix.latitude, fix.longitude)];
  const accuracy = formatAccuracy(fix.accuracy);
  if (accuracy) parts.push(accuracy);
  return parts.join(' ');
}

/**
 * Where a fix came from, in words a wearer or a model can read.
 *
 * Both routes read the PHONE — the glasses have no receiver of their own — so
 * this says which piece of software did the asking, not which device was asked.
 */
export function describeSource(source: FixSource): string {
  return source === 'hub' ? 'the phone, via the Even Hub app' : 'the browser';
}
