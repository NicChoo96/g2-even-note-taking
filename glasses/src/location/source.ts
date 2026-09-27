// Acquiring ONE location fix, from whichever of the two routes can supply it.
//
// THE DECISION TREE, and why it is ordered this way:
//
//   1. A hub host that HAS `getAppLocation` OWNS the answer — including a
//      refusal. Falling back to navigator.geolocation after the host said no
//      would raise a SECOND permission prompt for the same phone, and in the
//      packaged WebView it is the host, not the page, that decides.
//   2. A host WITHOUT the method is not a refusal, it is no support: an older
//      SDK, or the desktop simulator, which ships no GPS at all. The browser
//      route is tried. That is also the plain-web-app case, where there is no
//      bridge to ask.
//
// This is the ONLY location code that knows a host exists. It deliberately does
// NOT import the SDK: `AppLocationAccuracy` serialises to exactly 'low' |
// 'medium' | 'high', so the accuracy hint is passed as that plain string, and a
// harness can import this module and drive both routes with a stub host.
import { getDurableBridge } from '../durable-docs';
import {
  normalizeFix,
  type AccuracyHint,
  type LocationFix,
} from './spec';

const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

/**
 * The slice of the SDK bridge this module uses, declared structurally so no SDK
 * import is needed. `getAppLocation` resolves the fix, or null when the host has
 * no result within the timeout / no permission / coordinates it judged invalid
 * (the SDK documents all three as null) — and on a host that does not implement
 * it at all, the call THROWS instead, which is why the optional method check and
 * the try/catch are both load-bearing rather than belt-and-braces.
 */
interface LocationBridge {
  getAppLocation?: (options?: { accuracy?: string; timeoutMs?: number }) => Promise<unknown>;
}

export interface FixAttempt {
  fix: LocationFix | null;
  /** Why there is no fix — a sentence the wearer can act on. Empty when there is one. */
  reason: string;
  /**
   * The fix is REMEMBERED, not freshly read. Only ever true after a TIMEOUT or an
   * UNAVAILABLE reading, never after a refusal: a wearer who has just said no has
   * not asked to be told where they were ten minutes ago.
   */
  cached: boolean;
}

/**
 * The last fix this page obtained, for the life of the page.
 *
 * A phone indoors, or one just woken, often times out on the first try and
 * succeeds moments later, and a run that dies for want of a fix it had a minute
 * ago is worse than one that answers with a fix labelled as a minute old.
 *
 * It is deliberately NOT persisted. A fix written to storage would outlive the
 * page, and the one thing that must never happen is a remembered coordinate
 * being offered as a current one hours later by code that cannot tell.
 */
let remembered: LocationFix | null = null;

/** Remember a fix as this page's last known position. */
export function rememberFix(fix: LocationFix): void {
  remembered = fix;
}

/** Drop the remembered fix (a refusal, or a teardown). */
export function forgetFix(): void {
  remembered = null;
}

function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));
}

function message(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const text = String((err as { message?: unknown }).message ?? '').trim();
    if (text) return text;
  }
  return String(err);
}

interface HubAttempt {
  fix: LocationFix | null;
  reason: string;
  /** This host cannot do location at all — fall through to the browser. */
  unsupported: boolean;
  /** The host answered, and the answer was no. Do not fall back, do not remember. */
  refused: boolean;
}

async function fromHub(bridge: LocationBridge, hint: AccuracyHint, timeoutMs: number): Promise<HubAttempt> {
  const get = bridge.getAppLocation;
  if (typeof get !== 'function') {
    return { fix: null, reason: '', unsupported: true, refused: false };
  }
  try {
    const raw = await get.call(bridge, { accuracy: hint, timeoutMs });
    const fix = normalizeFix(raw, 'hub', Date.now());
    if (!fix) {
      // The SDK documents this exact case: null means no fix within the timeout,
      // no permission, or coordinates the host judged invalid. It never means
      // "0, 0", and it must never be papered over with one.
      return {
        fix: null,
        unsupported: false,
        refused: false,
        reason:
          'the Even Hub app did not return a location — location may be switched off for it, ' +
          'or the phone could not get a fix in time',
      };
    }
    return { fix, reason: '', unsupported: false, refused: false };
  } catch (err) {
    return {
      fix: null,
      unsupported: false,
      refused: true,
      reason: `the Even Hub app refused the location request (${message(err)})`,
    };
  }
}

interface GeoError {
  code?: number;
  message?: string;
}

/** What each W3C geolocation failure actually means to the wearer. */
function describeGeoError(err: GeoError | undefined): { reason: string; refused: boolean } {
  switch (err?.code) {
    case 1:
      return {
        reason: 'location permission was denied — allow location for this site in the browser, then ask again',
        refused: true,
      };
    case 2:
      return { reason: 'the browser could not determine a position', refused: false };
    case 3:
      return { reason: 'the browser timed out before it had a position', refused: false };
    default:
      return {
        reason: `the browser could not read a location (${err?.message || 'unknown error'})`,
        refused: false,
      };
  }
}

function fromBrowser(hint: AccuracyHint, timeoutMs: number): Promise<FixAttempt> {
  const geo = (globalThis as { navigator?: { geolocation?: Geolocation } }).navigator?.geolocation;
  if (!geo || typeof geo.getCurrentPosition !== 'function') {
    return Promise.resolve({ fix: null, reason: 'this browser has no location support', cached: false });
  }
  return new Promise<FixAttempt>((resolve) => {
    geo.getCurrentPosition(
      (position) => {
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
        if (fix) rememberFix(fix);
        resolve(
          fix
            ? { fix, reason: '', cached: false }
            : { fix: null, reason: 'the browser returned coordinates that cannot be used', cached: false },
        );
      },
      (err) => {
        const { reason, refused } = describeGeoError(err as GeoError);
        // A refusal is an INSTRUCTION, so it is obeyed: no remembered fix is
        // offered, because the wearer has just said we may not have one.
        const fallback = refused ? null : remembered;
        resolve({ fix: fallback, reason: fallback ? '' : reason, cached: Boolean(fallback) });
      },
      { enableHighAccuracy: hint === 'high', timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

export interface FixRequest {
  accuracy?: AccuracyHint;
  timeoutMs?: number;
}

/**
 * Read the wearer's current location.
 *
 * Never inventing one is the contract: when no route yields a fix the result
 * carries `fix: null` and a REASON, because a fabricated coordinate is worse than
 * no answer — nothing downstream can tell it from a real one.
 */
export async function getCurrentFix(request: FixRequest = {}): Promise<FixAttempt> {
  const hint: AccuracyHint = request.accuracy ?? 'medium';
  const timeoutMs = clampTimeout(request.timeoutMs);

  const bridge = (getDurableBridge() as unknown as LocationBridge | null) ?? null;
  if (bridge) {
    const hub = await fromHub(bridge, hint, timeoutMs);
    if (!hub.unsupported) {
      if (hub.fix) {
        rememberFix(hub.fix);
        return { fix: hub.fix, reason: '', cached: false };
      }
      // A host that simply had nothing to give is the same shape of failure as a
      // browser timeout, so a remembered fix is offered — labelled. A host
      // REFUSAL is obeyed instead.
      const fallback = hub.refused ? null : remembered;
      return { fix: fallback, reason: fallback ? '' : hub.reason, cached: Boolean(fallback) };
    }
  }

  return fromBrowser(hint, timeoutMs);
}
