// A ONE-SHOT DIAGNOSTIC probe for the two location routes — NOT the app's path.
//
// WHY THIS EXISTS, and why it is not simply `getCurrentFix`:
//
//   `source.ts` answers "where is the wearer?", and it is ordered deliberately so
//   that a host which OWNS location is never second-guessed. That is the right
//   rule for a feature and a useless one for a diagnosis, because the ordered
//   route reports the ANSWER and not the ROUTE. "The Even Hub app did not return
//   a location" is the same sentence whether the host was refused, had no GPS, or
//   never had the method at all — and those three need three different fixes.
//
//   So this module asks BOTH routes the same question, INDEPENDENTLY and in
//   PARALLEL, and reports each one's own outcome, including the W3C error code:
//   that code is the only thing that separates "the wearer said no" (1) from
//   "there is no positioner here" (2) from "it took too long" (3).
//
// Two deliberate properties:
//
//   • It is CONSOLE-FIRST. The browser route logs through the same two callbacks
//     the SDK's own snippet uses, so the phone app's dev console shows the exact
//     lines that snippet promises.
//   • It NEVER WRITES APP STATE. This is a measurement, not a fix: nothing is
//     remembered and nothing downstream may read it. `getCurrentFix` stays the
//     only way a location enters the app, so a probe can never be mistaken for
//     one. It reports, and that is all it does.
import { formatCoords, normalizeFix, type FixSource } from './spec';

/** The W3C geolocation codes, named — a report that cannot quote these is useless. */
const GEO_DENIED = 1;
const GEO_UNAVAILABLE = 2;
const GEO_TIMEOUT = 3;

export type ProbeStatus =
  | 'ok'
  | 'denied'
  | 'unavailable'
  | 'timeout'
  | 'unsupported'
  | 'invalid'
  | 'error';

/** Short words for the statuses, so the HUD line and the panel cannot disagree. */
export const PROBE_STATUS_LABELS: Record<ProbeStatus, string> = {
  ok: 'ok',
  denied: 'denied',
  unavailable: 'no-fix',
  timeout: 'timeout',
  unsupported: 'no-api',
  invalid: 'bad-data',
  error: 'error',
};

export interface ProbeStep {
  route: FixSource;
  status: ProbeStatus;
  /** The W3C code — browser route only, and the reason this probe exists. */
  code?: number;
  /** Formatted coordinates, present only when a USABLE fix came back. */
  coords?: string;
  /** Kept alongside `coords` so the one-line summary can be shorter than the readout. */
  latitude?: number;
  longitude?: number;
  /** A full sentence naming what happened, for the settings page and the console. */
  detail: string;
}

export interface ProbeReport {
  hub: ProbeStep;
  browser: ProbeStep;
  /** One compact line carrying both outcomes — what the glasses are shown. */
  summary: string;
}

export interface ProbeOptions {
  /**
   * The Even App bridge, or null/undefined in a plain browser. Passed IN rather
   * than imported, for the same reason `source.ts` declares its bridge
   * structurally: this module stays free of the SDK, and a harness can drive both
   * routes with a stub host.
   */
  hub?: unknown;
  /** How long to wait PER route. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10000;
/**
 * A permission prompt that nobody answers never calls back — the browser's own
 * `timeout` option does not tick while a prompt is up — so every route gets a
 * hard stop slightly beyond its own timeout. Without this the probe simply hangs,
 * and "it never came back" is indistinguishable from a bug in the probe.
 */
const HARD_GRACE_MS = 2000;

function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const text = String((err as { message?: unknown }).message ?? '').trim();
    if (text) return text;
  }
  return String(err);
}

/** The Even App host route: `bridge.getAppLocation({ accuracy, timeoutMs })`. */
async function probeHub(hub: unknown, timeoutMs: number): Promise<ProbeStep> {
  const get = (hub as { getAppLocation?: unknown } | null | undefined)?.getAppLocation;
  if (typeof get !== 'function') {
    return {
      route: 'hub',
      status: 'unsupported',
      detail:
        'the Even Hub app exposes no getAppLocation, so it cannot supply a location at all — ' +
        'an SDK older than 0.0.14, or a host with no positioner, such as the desktop simulator',
    };
  }
  try {
    const raw = await (
      get as (options: { accuracy: string; timeoutMs: number }) => Promise<unknown>
    ).call(hub, { accuracy: 'high', timeoutMs });
    const fix = normalizeFix(raw, 'hub', Date.now());
    if (!fix) {
      // The SDK documents null as no fix within the timeout, no permission, or
      // coordinates the host judged invalid. It never means "0, 0", and this
      // probe must not paper over the difference by inventing one either.
      return {
        route: 'hub',
        status: 'unavailable',
        detail:
          'getAppLocation resolved null — the SDK documents that as no fix within the timeout, ' +
          'no permission for the Even Hub app, or invalid coordinates',
      };
    }
    const coords = formatCoords(fix.latitude, fix.longitude);
    return {
      route: 'hub',
      status: 'ok',
      coords,
      latitude: fix.latitude,
      longitude: fix.longitude,
      detail: `getAppLocation returned ${coords} at accuracy 'high'`,
    };
  } catch (err) {
    // A host that does not implement the method THROWS rather than resolving
    // null, which is why this branch is load-bearing and not belt-and-braces.
    return {
      route: 'hub',
      status: 'denied',
      detail:
        `getAppLocation threw (${errText(err)}) — a host without the method throws instead of ` +
        'resolving null, and a refusal can surface this way too',
    };
  }
}

function browserDetail(code: number | undefined, message: string | undefined): string {
  switch (code) {
    case GEO_DENIED:
      return (
        'navigator.geolocation refused (code 1) — the wearer declined, or location is off for ' +
        'this app in the phone settings. This is the one outcome the app obeys rather than retries'
      );
    case GEO_UNAVAILABLE:
      return 'navigator.geolocation could not determine a position (code 2) — there is no positioner, or none is reachable';
    case GEO_TIMEOUT:
      return 'navigator.geolocation timed out before it had a position (code 3)';
    default:
      return `navigator.geolocation failed (${message || 'unknown error'})`;
  }
}

/** The page route: the raw `navigator.geolocation.getCurrentPosition` call. */
function probeBrowser(timeoutMs: number): Promise<ProbeStep> {
  const geo = (globalThis as { navigator?: { geolocation?: Geolocation } }).navigator?.geolocation;
  if (!geo || typeof geo.getCurrentPosition !== 'function') {
    return Promise.resolve({
      route: 'browser',
      status: 'unsupported',
      detail:
        'this WebView exposes no navigator.geolocation, so the page route cannot run here — ' +
        'expect the Even Hub host route to be the only one available',
    });
  }
  return new Promise<ProbeStep>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (step: ProbeStep) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(step);
    };
    timer = setTimeout(() => {
      done({
        route: 'browser',
        status: 'timeout',
        detail:
          `navigator.geolocation did not answer within ${timeoutMs + HARD_GRACE_MS} ms — a ` +
          'permission prompt that was never answered looks exactly like this',
      });
    }, timeoutMs + HARD_GRACE_MS);

    geo.getCurrentPosition(
      (position) => {
        // The SDK's own snippet, verbatim, including the console calls: the phone
        // app's dev console is the one place these are readable.
        console.log('Location granted:', position.coords.latitude, position.coords.longitude);
        const fix = normalizeFix(
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude,
            speed: position.coords.speed,
            heading: position.coords.heading,
            timestamp: position.timestamp,
          },
          'browser',
          Date.now(),
        );
        if (!fix) {
          done({
            route: 'browser',
            status: 'invalid',
            detail: 'navigator.geolocation answered with coordinates that cannot be used',
          });
          return;
        }
        const coords = formatCoords(fix.latitude, fix.longitude);
        done({
          route: 'browser',
          status: 'ok',
          coords,
          latitude: fix.latitude,
          longitude: fix.longitude,
          detail: `navigator.geolocation returned ${coords} from the page itself`,
        });
      },
      (error) => {
        console.error('Location error / denied:', error);
        const code = typeof error?.code === 'number' ? error.code : undefined;
        done({
          route: 'browser',
          status:
            code === GEO_DENIED
              ? 'denied'
              : code === GEO_TIMEOUT
                ? 'timeout'
                : code === GEO_UNAVAILABLE
                  ? 'unavailable'
                  : 'error',
          code,
          detail: browserDetail(code, error?.message),
        });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/** Four decimals is ~11 m — plenty to tell a fix from a placeholder, and short on the HUD. */
function shortStep(step: ProbeStep): string {
  if (step.status === 'ok' && typeof step.latitude === 'number' && typeof step.longitude === 'number') {
    return `${step.latitude.toFixed(4)},${step.longitude.toFixed(4)}`;
  }
  const code = typeof step.code === 'number' ? `(${step.code})` : '';
  return `${PROBE_STATUS_LABELS[step.status]}${code}`;
}

/**
 * Ask both routes where we are, once each, and report what each one said.
 *
 * Both run in PARALLEL rather than in sequence: on a phone the two routes resolve
 * the same underlying OS permission, so asking together costs one dialog and one
 * wait instead of two of each.
 */
export async function probeLocation(options: ProbeOptions = {}): Promise<ProbeReport> {
  const raw = options.timeoutMs;
  const timeoutMs =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.min(30000, Math.round(raw))
      : DEFAULT_TIMEOUT_MS;

  console.log(`[geo-probe] asking both routes, ${timeoutMs} ms each`);
  const [hub, browser] = await Promise.all([probeHub(options.hub, timeoutMs), probeBrowser(timeoutMs)]);
  const report: ProbeReport = { hub, browser, summary: `geo sdk=${shortStep(hub)} web=${shortStep(browser)}` };
  console.log('[geo-probe]', report.summary);
  return report;
}
