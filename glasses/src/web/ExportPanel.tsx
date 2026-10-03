// EXPORT PANEL — one button that writes the whole configurable dataset to a
// single JSON file, shaped for the Postgres seed (see ./export-data.ts).
//
// It lives on its own tab rather than at the bottom of Settings, for one reason:
// Settings is already a long page of live controls, and an export that is
// discovered by scrolling past everything else is an export nobody finds. It is
// also the only place in the app that is ABOUT data rather than about doing
// something with it, so it reads as its own idea.
//
// Two things the panel must make obvious BEFORE the click, because both are
// surprises that would otherwise be found in the downloaded file:
//   • what will be in it (a live count per table), and
//   • what will NOT be in it (secret VALUES — the relay never returns one).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getState, subscribe } from '../store';
import { getAgents, subscribeAgents } from '../agents-store';
import { getAi, getMemoryView, subscribeAi, subscribeMemory } from '../ai';
import { ledgerEntries, ledgerSize, subscribeLedger } from '../ai/ledger';
import { snapshotMemory } from '../ai/memory';
import { getStreamToken } from '../auth-token';
import { API_BASE } from '../stream';
import { loadDeviceSession, loadOwnerSession } from '../durable-docs';
import { fetchAgentStatus, type AgentStatus } from './agents-client';
import {
  buildExportBundle,
  downloadJson,
  exportFilename,
  formatBytes,
  serializeBundle,
} from './export-data';

/**
 * How the counts are grouped on screen. The KEYS are the table names in the
 * bundle, so a row here and a collection there can never disagree about spelling
 * — the group is presentation, the key is the contract.
 */
const GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: 'Identity & settings', keys: ['app_user', 'app_setting', 'app_secret', 'llm_settings'] },
  { label: 'Hub content', keys: ['hub_state', 'todo_item', 'document', 'note', 'file_ref'] },
  { label: 'Agents', keys: ['tool', 'agent', 'agent_tool'] },
  { label: 'Session history', keys: ['jarvis_session', 'session_message', 'session_tombstone'] },
  { label: 'Jarvis memory', keys: ['memory_turn', 'memory_digest'] },
  { label: 'Run ledger (transient)', keys: ['ledger_entry'] },
];

export function ExportPanel() {
  const hub = useSyncExternalStore(subscribe, getState);
  const agents = useSyncExternalStore(subscribeAgents, getAgents);
  const ai = useSyncExternalStore(subscribeAi, getAi);
  // The VIEW is the cached, identity-stable snapshot — `snapshotMemory()` would
  // allocate on every call and spin `useSyncExternalStore` forever.
  const memoryView = useSyncExternalStore(subscribeMemory, getMemoryView);
  // A primitive, so it is safe as a snapshot.
  const ledgerCount = useSyncExternalStore(subscribeLedger, ledgerSize);

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  const [includeLedger, setIncludeLedger] = useState(false);
  const [includeToken, setIncludeToken] = useState(false);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    // All three are best-effort: an unreachable relay or a device with no stored
    // session must still be able to export what the client already holds.
    void (async () => {
      const [st, device, owner] = await Promise.all([
        fetchAgentStatus().catch(() => null),
        loadDeviceSession().catch(() => null),
        loadOwnerSession().catch(() => null),
      ]);
      if (!alive) return;
      setStatus(st);
      setDeviceId(device);
      setEmail(owner?.email ?? null);
    })();
    void fetch(`${API_BASE}/app.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { version?: string } | null) => {
        if (alive && m && typeof m.version === 'string') setAppVersion(m.version);
      })
      .catch(() => {
        /* no manifest — the export records null rather than guessing */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Keyed on the cached view, so it re-runs exactly when the log actually
  // changed rather than on every render.
  const memory = useMemo(() => snapshotMemory(), [memoryView]);

  const ledger = useMemo(
    () => (includeLedger ? ledgerEntries() : null),
    [includeLedger, ledgerCount],
  );

  // Rows only — no JSON is produced here, so typing in Docs while this tab is
  // open costs a few small array builds and never a full serialisation.
  const bundle = useMemo(
    () =>
      buildExportBundle({
        hub,
        agents,
        ai,
        memory,
        status,
        email,
        deviceId,
        appVersion,
        origin: API_BASE,
        ledger,
        includeOwnerCredential: includeToken ? getStreamToken() : null,
      }),
    [hub, agents, ai, memory, status, email, deviceId, appVersion, ledger, includeToken],
  );

  const save = async () => {
    setBusy(true);
    setErr('');
    setResult('');
    try {
      const text = serializeBundle(bundle);
      const name = exportFilename();
      const size = downloadJson(name, text);
      if (size === null) {
        setErr(
          'This WebView refused to start a download. Use “Copy JSON”, or open the hub in a normal browser tab.',
        );
        return;
      }
      const rows = Object.values(bundle.counts).reduce((a, b) => a + b, 0);
      setResult(`Wrote ${name} · ${formatBytes(size)} · ${rows} rows across ${Object.keys(bundle.counts).length} collections`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    setBusy(true);
    setErr('');
    setResult('');
    try {
      const text = serializeBundle(bundle);
      await navigator.clipboard.writeText(text);
      setResult(`Copied ${formatBytes(new Blob([text]).size)} of JSON to the clipboard`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-panel">
      <div className="panel-label spaced">Export seed data</div>
      <p className="hint-line">
        Downloads <strong>everything the app can configure</strong> as one JSON file, grouped by the
        database table each part becomes — documents, tasks, notes, file references, tools, agents,
        session history, and the Jarvis memory log. It is meant as the initial seed for the backend
        described in <code>docs/data-platform/BACKEND-BUILD-SPEC.md</code>: the shapes here are that
        spec's §3 tables, and the file carries its own import notes in <code>warnings</code>.
      </p>

      <div className="panel-label spaced">What will be in the file</div>
      {GROUPS.map((g) => (
        <div key={g.label} style={{ marginBottom: 8 }}>
          <div className="hint-line" style={{ marginBottom: 4 }}>
            {g.label}
          </div>
          <div className="status-grid">
            {g.keys.map((k) => (
              <span key={k} className="pill">
                {k} · {bundle.counts[k] ?? 0}
              </span>
            ))}
          </div>
        </div>
      ))}

      <div className="panel-label spaced">Options</div>
      <div className="field-toolbar">
        <label>
          <input
            type="checkbox"
            checked={includeLedger}
            onChange={(e) => setIncludeLedger(e.target.checked)}
          />{' '}
          Include the run ledger ({ledgerCount} entr{ledgerCount === 1 ? 'y' : 'ies'})
        </label>
      </div>
      <p className="hint-line">
        The ledger is live in-memory runtime state — a record of what runs were <em>attempted</em>,
        with a sequence number that restarts on every reload. Leave this off unless you deliberately
        want to seed the append-only audit table; it is not user data.
      </p>

      <div className="field-toolbar">
        <label>
          <input
            type="checkbox"
            checked={includeToken}
            onChange={(e) => setIncludeToken(e.target.checked)}
          />{' '}
          Include the owner bearer token
        </label>
      </div>
      <p className="hint-line">
        Off by default, and worth leaving off. The token in <code>identity.ownerToken</code> is a
        live credential that grants full access to this account — anyone who receives this file
        receives that access. The backend mints its own credentials anyway, so a seed does not need it.
      </p>

      {includeToken && (
        <p className="warn-line">
          The exported file will contain a working credential. Store it like a password and do not
          send it anywhere you would not send the token itself.
        </p>
      )}

      <div className="panel-label spaced">Secrets</div>
      <p className="hint-line">
        <code>app_secret</code> is a <strong>manifest, not a copy</strong>: every row has{' '}
        <code>value: null</code>. API keys live server-side by design and the relay never returns one,
        so the file tells you which credentials exist, where each came from, and what each is for.
        Seed the values from <code>web/.g2-hub-secrets.json</code> or the host environment.
      </p>
      <div className="status-grid">
        {bundle.collections.app_secret.map((s) => (
          <span
            key={s.key}
            className={s.present === false ? 'pill bad' : s.present ? 'pill ok' : 'pill'}
            title={`${s.hint} (source: ${s.source})`}
          >
            {s.key} · {s.present === null ? 'unknown' : s.present ? 'present' : 'absent'}
          </span>
        ))}
      </div>

      <div className="docs-actions" style={{ marginTop: 14 }}>
        <button onClick={() => void copy()} disabled={busy}>
          Copy JSON
        </button>
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Working…' : 'Download seed JSON'}
        </button>
      </div>

      {result && <p className="ok-line">{result}</p>}
      {err && <p className="warn-line">{err}</p>}

      {bundle.warnings.length > 0 && (
        <>
          <div className="panel-label spaced">Import notes carried in the file</div>
          <ul className="hint-line">
            {bundle.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
