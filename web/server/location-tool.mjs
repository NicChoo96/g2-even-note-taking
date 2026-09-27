// The `location` tool as the RELAY sees it.
//
// Agent runs execute server-side, and a fix lives in the phone — there is no
// route from here to the device, and no client round trip mid-run to add one. So
// this tool does not FETCH a position: it reads the snapshot the client resolved
// when it triggered the run and sent along with it (src/location/run.ts,
// POST /api/agent/run). Same kind, two halves of the trip.
//
// Everything here is pure and takes its data as an argument rather than reaching
// for it, for the reason hub-tools.mjs does the same: a harness imports this file
// directly and asserts the semantics, and nothing in here knows what a socket is.
//
// FAILING HONESTLY is the whole point of the module. A missing or unusable
// snapshot produces a refusal that NAMES the situation and forbids a guess —
// coordinates invented here would be indistinguishable, to the model reading
// them, from coordinates the phone actually reported.

/** The only kind this file handles. */
export const LOCATION_KIND = 'location';

/** Model-facing tool names, so relay dispatch and the schema agree by name. */
export const LOCATION_TOOL_NAMES = { location: 'jarvis_location' };

/** Does this tool read the device's position? */
export function isLocationTool(t) {
  return t?.kind === LOCATION_KIND;
}

/**
 * What the model is told when there is no position.
 *
 * It says WHY at both levels — nothing was captured for this run, and the two
 * ordinary causes — because "no location" on its own invites the model to fill
 * the gap. It also spells out the prohibition, since this is the one tool result
 * where a plausible invention is worse than an empty answer.
 */
export const NO_FIX_TEXT =
  'No location is available for this run. A position is captured on the wearer\u2019s device when the ' +
  'run starts, and this run either had none captured (nothing to read, or the device could not get a ' +
  'fix in time) or was started without location access. Do NOT state, estimate or infer where the ' +
  'wearer is from anything else in this conversation. Tell the wearer plainly that no position is ' +
  'available, and if it helps, say that location access or a fresh reading is needed.';

/** A finite number, or undefined — one bad field must not spoil the rest. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Validate a snapshot off the wire.
 *
 * Range-checked, not truthiness-checked: 0/0 is a real coordinate in the Gulf of
 * Guinea. What must not survive is a missing or out-of-range pair, and the answer
 * to one is null — never a substituted default.
 */
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const latitude = num(raw.latitude);
  const longitude = num(raw.longitude);
  if (latitude === undefined || longitude === undefined) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  const fix = {
    latitude,
    longitude,
    source: raw.source === 'browser' ? 'browser' : 'hub',
    capturedAt: num(raw.capturedAt) ?? num(raw.timestamp) ?? 0,
  };
  const accuracy = num(raw.accuracy);
  if (accuracy !== undefined && accuracy >= 0) fix.accuracy = accuracy;
  const altitude = num(raw.altitude);
  if (altitude !== undefined) fix.altitude = altitude;
  const speed = num(raw.speed);
  if (speed !== undefined && speed >= 0) fix.speed = speed;
  const heading = num(raw.heading);
  if (heading !== undefined && heading >= 0 && heading <= 360) fix.heading = heading;
  return fix;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Seconds, minutes, hours or days — whichever keeps the number readable. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'moments';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * The tool result, as the model reads it.
 *
 * Plain ASCII and no emoji: a G2 renders a tool result back to the wearer in some
 * flows, and the hub channels already refuse those glyphs. The AGE is always on
 * the first screen and the caveat is always present, because this text is the only
 * thing between a snapshot and a claim about where the wearer is standing NOW.
 */
export function formatFix(fix, now = Date.now()) {
  const age = fix.capturedAt ? now - fix.capturedAt : 0;
  const lines = [`Position: ${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}`];
  if (fix.accuracy !== undefined) {
    lines.push(`Accuracy: about ${fix.accuracy < 10 ? fix.accuracy.toFixed(1) : Math.round(fix.accuracy)} m`);
  }
  lines.push(
    fix.capturedAt
      ? `Captured: ${formatAge(age)} before this tool call (${new Date(fix.capturedAt).toISOString()})`
      : 'Captured: at an unstated time',
  );
  lines.push(`Reported by: ${fix.source === 'browser' ? 'the browser' : 'the phone, via the Even Hub app'}`);
  const extra = [];
  if (fix.altitude !== undefined) extra.push(`${Math.round(fix.altitude)} m above sea level`);
  if (fix.speed !== undefined) extra.push(`${(fix.speed * 3.6).toFixed(1)} km/h`);
  if (fix.heading !== undefined) {
    const deg = ((fix.heading % 360) + 360) % 360;
    extra.push(`heading ${Math.round(deg)} deg ${COMPASS[Math.round(deg / 45) % 8]}`);
  }
  if (extra.length) lines.push(`Also reported: ${extra.join(', ')}`);
  lines.push(
    age > 10 * 60 * 1000
      ? 'Note: this position is old. Say how old it is whenever the answer depends on where the wearer is now.'
      : 'Note: captured when this run started; the run cannot take a new reading.',
  );
  return lines.join('\n');
}

/** The tool's parameters — none. It cannot be told to try harder from here. */
export function locationToolSchema(t) {
  return {
    type: 'function',
    function: {
      name: t?.name || LOCATION_TOOL_NAMES.location,
      description:
        t?.description ||
        'Read the wearer\u2019s location: latitude and longitude, the accuracy of the reading, and ' +
          'altitude, speed and heading when the device reported them. The position was captured when ' +
          'the run started, so treat it as where the wearer was then and report the age when it ' +
          'matters. If no position was captured the tool says so rather than guessing.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Dispatch for the location kind.
 *
 * `snapshot` is whatever the client sent with the run. There is no second source
 * and no fallback: absent means absent, and the refusal says so.
 */
export function runLocationTool(tool, args, snapshot) {
  const fix = normalizeSnapshot(snapshot);
  if (!fix) return { ok: false, text: NO_FIX_TEXT };
  return { ok: true, text: formatFix(fix, Date.now()) };
}

/** The one-line label the relay logs for this call — tool name, no arguments. */
export function locationToolSummary(tool) {
  return tool?.name || LOCATION_TOOL_NAMES.location;
}
