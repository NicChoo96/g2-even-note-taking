// Device pairing card — Settings → Devices.
//
// Pairing is NOT a gate any more. Signing in with the owner Google account is
// what unlocks the app on every surface, including the Even App WebView (the
// phone that already drives the glasses over the SDK bridge must not be locked
// behind an approval screen). This card keeps the original per-device flow for
// a device that cannot sign in, and gives the owner one place to see and revoke
// every credential.
//
// The wire protocol is unchanged: a device self-registers a per-device ID,
// shows a 6-character code, and an owner approves it from here.
import { useEffect, useState } from 'react';
import { anyOwnerToken, pairPending, useAuth, type PendingDevice } from './auth';

export function DevicesPanel() {
  const {
    devices,
    pairDevice,
    revokeDevice,
    refreshDevices,
    pairError,
    pairing,
    paired,
    pairCode,
    pairStatus,
    thisDeviceId,
    inEvenApp,
    setPairing,
    unpair,
  } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  /** Devices that have ASKED to connect and are waiting for one tap. */
  const [waiting, setWaiting] = useState<PendingDevice[]>([]);

  // Poll while this panel is open: the whole point is that the other device is
  // sitting on its "waiting" screen, and the owner has this page in front of
  // them. Five seconds is fast enough to feel immediate and slow enough that a
  // forgotten tab is not chatting to the relay every second.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const tok = await anyOwnerToken();
      if (!tok) return;
      const r = await pairPending(tok.token);
      if (alive && r.ok) setWaiting(r.pending);
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const approve = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setDone(null);
    const r = await pairDevice(code);
    setBusy(false);
    if (r.ok) {
      setDone('Device approved 🎉');
      setCode('');
    }
  };

  /** One tap on a waiting device — no code to copy. */
  const approveWaiting = async (deviceId: string) => {
    setBusy(true);
    setDone(null);
    const r = await pairDevice(deviceId);
    setBusy(false);
    if (r.ok) {
      setDone('Device approved 🎉');
      setWaiting((list) => list.filter((d) => d.deviceId !== deviceId));
    }
  };

  // This build's own device state, when there is one to talk about.
  const thisState = paired
    ? 'approved'
    : pairing
      ? pairStatus === 'approved'
        ? 'approved'
        : 'waiting for approval'
      : 'not paired';

  return (
    <section className="card devices-panel">
      <div className="panel-label">Devices · optional device pairing</div>
      <p className="hint-line">
        Signing in with the owner Google account is enough on every device, including this
        one. A pairing code is only needed for a device that cannot sign in.
      </p>

      {(inEvenApp || thisDeviceId) && (
        <div className="device-row">
          <span className="device-name">This device</span>
          <span className="device-meta">
            {thisState}
            {thisDeviceId ? ` · ${thisDeviceId.slice(0, 8)}…` : ''}
          </span>
          {paired ? (
            <button className="icon-btn danger" onClick={unpair} title="Unpair this device">
              ✕
            </button>
          ) : pairing ? (
            <button className="icon-btn" onClick={() => setPairing(false)} title="Stop pairing">
              ✕
            </button>
          ) : (
            <button onClick={() => setPairing(true)}>Pair this device</button>
          )}
        </div>
      )}

      {pairing && pairCode && !paired && (
        <>
          <p className="hint-line">Code for this device — approve it from any signed-in browser:</p>
          <div className="pair-code inline">{pairCode}</div>
        </>
      )}

      {/* ── WAITING TO CONNECT ─────────────────────────────────────────────
          The device shows a code and waits; this lists it by NAME with one
          button. Typing six characters off a lens was the last piece of friction
          in pairing, and it was never necessary — the thing asking is already
          registered, it just needs a yes. */}
      {waiting.length > 0 && (
        <>
          <div className="panel-label spaced">Waiting to connect</div>
          <ul className="device-list">
            {waiting.map((d) => (
              <li key={d.deviceId} className="device-row">
                <span className="device-name">📱 {d.label || 'A device'}</span>
                <span className="device-meta">
                  {d.pairCode ? `code ${d.pairCode}` : 'no code'}
                  {d.createdAt ? ` · ${new Date(d.createdAt).toLocaleTimeString()}` : ''}
                </span>
                <button
                  className="primary"
                  onClick={() => void approveWaiting(d.deviceId)}
                  disabled={busy}
                >
                  Approve
                </button>
              </li>
            ))}
          </ul>
          <p className="hint-line">
            Approve only a device you just started. Its code is shown here so you can check it
            against the lens.
          </p>
        </>
      )}

      <div className="pair-row">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && void approve()}
          placeholder="Pairing code from the other device"
          maxLength={6}
        />
        <button className="primary" onClick={() => void approve()} disabled={busy || !code.trim()}>
          {busy ? 'Approving…' : 'Approve'}
        </button>
      </div>
      {pairError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{pairError}</p>}
      {done && <p style={{ color: 'var(--good)', fontSize: 12 }}>{done}</p>}

      {(devices ?? []).length > 0 ? (
        <ul className="device-list">
          {(devices ?? []).map((d) => (
            <li key={d.deviceId} className="device-row">
              <span className="device-name" title={d.deviceId}>
                🥽 {d.deviceId.slice(0, 8)}…
              </span>
              <span className="device-meta">
                {d.email} · {d.approvedAt ? new Date(d.approvedAt).toLocaleDateString() : ''}
              </span>
              <button
                className="icon-btn danger"
                onClick={() => void revokeDevice(d.deviceId)}
                aria-label="Revoke device"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint-line">No paired devices. Sign-in covers every client that can use Google.</p>
      )}
    </section>
  );
}
