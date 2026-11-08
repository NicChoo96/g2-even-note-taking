// Can the live gateway actually hold the schedule?
//
// The relay now stores the schedule at `/hub/relay/agent-cron`, which is only
// durable if the gateway implements the relay-state family (backend Part 1). A
// 403/404 here is not a failure of the page — it is the page telling the truth
// ("saved for this process only"), and the wearer deserves to know which one it
// is before trusting a schedule.
//
// Read-only: it does not write anything.
//
// Run: node --env-file=web/.env.local scripts/check-relay-state.mjs
const base = String(process.env.JARVIS_FILE_URL || process.env.JARVIS_URL || '').replace(/\/+$/, '');
const user = process.env.JARVIS_FILE_USER || process.env.JARVIS_USERNAME || '';
const pass = process.env.JARVIS_FILE_PWD || process.env.JARVIS_PASSWORD || '';
const apiKey = process.env.JARVIS_FILE_API_KEY || process.env.JARVIS_API_KEY || '';
if (!base) {
  console.error('FAILED: JARVIS_FILE_URL is not set (pass --env-file=web/.env.local)');
  process.exit(2);
}

const call = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Connection: 'close',
    },
  });
  const text = await res.text();
  return { status: res.status, text };
};

let token = apiKey;
if (!token) {
  const login = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (login.status !== 200) {
    console.error(`FAILED: login refused — ${login.status}`);
    process.exit(2);
  }
  token = JSON.parse(login.text).access_token;
}

const cfg = await call('/config', { token });
const prefix = JSON.parse(cfg.text || '{}').hub_prefix || '/hub';
console.log(`gateway ${base}  prefix ${prefix}\n`);

for (const key of ['auth', 'agent-cron']) {
  const res = await call(`${prefix}/relay/${key}`, { token });
  const label = res.status === 200 ? 'SUPPORTED' : res.status === 404 ? 'missing key (route works)' : 'NOT AVAILABLE';
  console.log(`  GET ${prefix}/relay/${key.padEnd(11)} -> ${res.status}  ${label}`);
  if (res.status === 200) {
    const body = JSON.parse(res.text || '{}');
    const shape = Object.keys(body ?? {}).join(', ');
    console.log(`      keys: ${shape}`);
    if (key === 'agent-cron') console.log(`      value: ${JSON.stringify(body.value).slice(0, 160)}`);
  } else {
    console.log(`      ${res.text.slice(0, 200)}`);
  }
}
