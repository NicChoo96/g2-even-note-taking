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
import { useAuth } from './auth';

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
