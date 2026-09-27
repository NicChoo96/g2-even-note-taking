// location.get — where the wearer is.
//
// A GLOBAL action, for the same reason jev is one: any page can be asked "where
// am I", the answer belongs to the assistant rather than to a tab, and routing
// the wearer somewhere first would be a visible, pointless page change. See the
// reserve in ../agent.ts — a global that must survive the tool budget has to be
// named there, which is why this file and that list move together.
//
// WHY IT IS NOT effect: 'pure'
//   jev.decide is pure: it inspects text the caller handed it and touches nothing
//   else. This one reaches out to the device, so it is a READ — it changes
//   nothing the wearer can see and must never be gated, but it is not free of the
//   outside world either. ('read' carries no gate: needsGate only gates
//   'irreversible', see ../ledger.ts.)
//
// FAILING HONESTLY
//   There is no default latitude here, and no fallback to a city centre. When no
//   fix is available the capability says so and hands the REASON back, because a
//   fabricated location is worse than none: the model downstream cannot tell it
//   from a real one. Same rule as jev's "NEVER returns a default, a prior, or a
//   'probably'".
//
// IT READS ON DEMAND, WHICH IS THE POINT OF IT BEING A CAPABILITY
//   This runs in the WebView, where the device is reachable, so every call is a
//   fresh reading and the `accuracy` argument is genuinely honoured. An AGENT run
//   cannot do that — it executes server-side and is handed the snapshot taken
//   when it was triggered (see src/location/source.ts and web/server/location-tool.mjs).
import { GLOBAL_PAGE, type Capability } from '../types';
import { getCurrentFix } from '../../location/source';
import {
  ageNote,
  describeSource,
  fixAgeMs,
  fixLine,
  formatAge,
  formatAltitude,
  formatHeading,
  formatSpeed,
  isAccuracyHint,
  isStale,
} from '../../location/spec';

export const locationCapabilities: Capability[] = [
  {
    name: 'location.get',
    page: GLOBAL_PAGE,
    effect: 'read',
    title: 'Where am I',
    description:
      "Read the wearer's CURRENT position: latitude and longitude, the accuracy of the reading, and — " +
      'when the device reports them — altitude, speed and heading. Use it for anything that depends on ' +
      'where the wearer is: what is near them, local time or weather, how far something is, or recording ' +
      'where something happened. It takes a fresh reading on every call, so if the wearer has moved, call ' +
      'it again. It reports the reason when there is no position — including that permission was refused — ' +
      'and never invents a coordinate.',
    params: [
      {
        name: 'accuracy',
        type: 'enum',
        values: ['low', 'medium', 'high'],
        fallback: 'medium',
        description:
          'How hard to try. low = town-level, quickest; medium (default) = street-level; high = best ' +
          'available, slower and drains the battery faster. Use high only when the answer depends on metres.',
      },
    ],
    run: async (args) => {
      const accuracy = isAccuracyHint(args.accuracy) ? args.accuracy : 'medium';
      const attempt = await getCurrentFix({ accuracy });

      if (!attempt.fix) {
        return {
          ok: false,
          summary: 'no location available',
          data: { reason: attempt.reason, accuracy },
          hint:
            `${attempt.reason}. Do not guess a location — tell the wearer in one sentence, and say what ` +
            'would fix it if that is useful.',
        };
      }

      const fix = attempt.fix;
      const now = Date.now();
      const line = fixLine(fix);
      // A readable detail list beside the raw numbers: a model that has to turn
      // 2.3 into "2.3 km/h" itself sometimes does not, and the wearer hears the
      // difference. Only what the device actually reported.
      const detail = [
        formatAltitude(fix.altitude),
        formatSpeed(fix.speed),
        formatHeading(fix.heading),
      ].filter(Boolean);
      return {
        ok: true,
        // A remembered fix says so IN THE LINE the glasses render, so the wearer
        // cannot hear a stale coordinate presented as their current position.
        summary: attempt.cached ? `${line} (${ageNote(fix, now)})` : line,
        data: {
          ...fix,
          detail,
          sourceText: describeSource(fix.source),
          ageSeconds: Math.round(fixAgeMs(fix, now) / 1000),
          stale: isStale(fix, now),
          fresh: !attempt.cached,
        },
        ...(attempt.cached
          ? {
              hint:
                `This is a remembered fix from ${formatAge(fixAgeMs(fix, now))}, not a fresh reading. ` +
                'Say so if the wearer needs a current position.',
            }
          : {}),
      };
    },
  },
];
