// What do the live /hub/metrics routes actually answer?
//
// The backend's summary describes the behaviour; this prints the SHAPES the relay
// has to parse, because "409 SERIES_SHAPE_LOCKED with {type, unit} echoed" is a
// sentence, not a contract. Writes one throwaway series and deletes it again.
//
// Run: node --env-file=web/.env.local scripts/probe-metrics-api.mjs
const base = String(process.env.JARVIS_FILE_URL || '').replace(/\/+$/, '');
const key = String(process.env.JARVIS_FILE_API_KEY || '').trim();
if (!base || !key) {
  console.error('SKIPPED: needs JARVIS_FILE_URL + JARVIS_FILE_API_KEY');
  process.exit(2);
}
const API = `${base}/hub/metrics`;
const SERIES = 'probe.relay.check';

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Connection: 'close',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 200);
  }
  return { status: res.status, location: res.headers.get('location'), body: parsed };
};

const show = (label, r) => {
  const body = r.body && typeof r.body === 'object' ? JSON.stringify(r.body) : String(r.body);
  console.log(`\n${label}\n  status ${r.status}${r.location ? `  location ${r.location}` : ''}\n  ${body.slice(0, 500)}`);
};

// Start clean so a previous crashed probe cannot make this misleading.
await call('DELETE', `/series/${SERIES}`);

show(
  'declare (new)',
  await call('POST', '/series', { key: SERIES, label: 'Probe', unit: 'x', type: 'number', precision: 2 }),
);
show(
  'declare again (same shape)',
  await call('POST', '/series', { key: SERIES, label: 'Probe 2', unit: 'x', type: 'number' }),
);
show(
  'declare with a different unit',
  await call('POST', '/series', { key: SERIES, type: 'number', unit: 'USD' }),
);
show(
  'samples, mixed batch',
  await call('POST', '/samples', {
    samples: [
      // The live slot pattern is [A-Za-z0-9:._-] — a SPACE is refused, so the
      // relay's `YYYY-MM-DD HH:MM` has to cross the wire as `YYYY-MM-DDTHH:MM`.
      { series: SERIES, value: 36.1, slot: '2026-11-09T09:00' },
      { series: SERIES, value: 36.4, slot: '2026-11-09T10:00' },
      { series: SERIES, value: 'n/a', slot: '2026-11-09T11:00' },
      { series: 'probe.unknown.series', value: 1 },
    ],
  }),
);
show(
  'same slot again (idempotent?)',
  await call('POST', '/samples', { samples: [{ series: SERIES, value: 37.2, slot: '2026-11-09T10:00' }] }),
);
show('read the range', await call('GET', `/samples?series=${encodeURIComponent(SERIES)}&limit=10`));
show('read with no series param', await call('GET', '/samples'));
show('list series', await call('GET', '/series'));
show('delete while non-empty', await call('DELETE', `/series/${SERIES}`));

// After a 409, the rows are still there — empty them through the documented
// route before deleting, so the probe leaves nothing behind.
show(
  'hard delete of a non-empty series, if there is one',
  await call('DELETE', `/series/${SERIES}?force=1`),
);

// Clean up for real: the rows must not be left behind on a live database.
const del = await call('DELETE', `/series/${SERIES}`);
show('delete after emptying (manual sql not needed?)', del);
const after = await call('GET', '/series');
const left = Array.isArray(after.body?.series)
  ? after.body.series.filter((s) => String(s.key ?? '').startsWith('probe.'))
  : [];
console.log(`\nleftover probe series: ${left.length}`);
