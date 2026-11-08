// "Run this agent every morning" — the missing switch.
//
// WHY THIS PAGE EXISTS: the relay has had a scheduler since 0.3.65, but the only
// way to configure it was a gitignored file (or, worse, a JSON blob in a host's
// environment). So the clock worked and nobody could see it, which reads as
// "there is no scheduler". This is the control surface for that clock, and it
// says where the schedule is stored, because a schedule that only lives in the
// container's memory dies on the next deploy.
//
// WHAT IT DOES NOT DO: it does not choose a model, a prompt, or tools. A
// scheduled run uses the agent's OWN saved task and toolIds — the same run the
// wearer gets from a tap — so the only things to choose here are WHEN.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSchedule, runAgentNow, saveSchedule, type ScheduleJob, type ScheduleState } from './agents-client';
import { getAgents, subscribeAgents } from '../agents-store';
import { useSyncExternalStore } from 'react';

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Every day", "Weekdays", "Mon, Wed, Fri" — the way a person says it. */
function daysLabel(days: number[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return 'every day';
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(',') === '1,2,3,4,5') return 'weekdays';
  if (sorted.join(',') === '0,6') return 'weekends';
  return sorted.map((d) => DAY_NAMES[d] ?? '?').join(', ');
}

/** A local, readable time — the browser's clock, NOT the relay's. */
function whenLabel(ms: number | null): string {
  if (ms === null) return 'never';
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

interface Draft {
  agent: string;
  at: string;
  days: number[];
  ask: string;
}

const BLANK: Draft = { agent: '', at: '07:00', days: [], ask: '' };

export function AgentSchedule() {
  const [state, setState] = useState<ScheduleState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [warn, setWarn] = useState('');
  const [draft, setDraft] = useState<Draft>(BLANK);

  const reload = useCallback(async () => {
    const next = await fetchSchedule();
    setState(next);
    setLoading(false);
    return next;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The agent list comes from the hub-owned store, so a job can only be pinned to
  // an agent that actually exists — the relay refuses an unknown name at run
  // time, and a picker that offers one would be handing the wearer that failure.
  const agentsState = useSyncExternalStore(subscribeAgents, getAgents);
  const agentNames = useMemo(
    () => agentsState.agents.map((a) => a.name).sort((a, b) => a.localeCompare(b)),
    [agentsState.agents],
  );

  const jobs = state?.jobs ?? [];
  const scheduled = useMemo(() => new Set(jobs.map((j) => j.agent.toLowerCase())), [jobs]);

  const write = async (next: {
    enabled?: boolean;
    jobs: Array<{ agent: string; at: string; days?: number[] | null; ask?: string; enabled?: boolean }>;
  }) => {
    setBusy(true);
    setNote('');
    setWarn('');
    try {
      const res = await saveSchedule({ enabled: state?.enabled ?? true, timeZone: state?.timeZone, ...next });
      if (!res.ok) {
        setWarn(res.error || 'The relay refused that schedule.');
        return false;
      }
      setState(res);
      if (res.durable === false) {
        // Two different truths, so two different sentences. The useful one names
        // the fix; a bare "not durable" would leave the same question the env var
        // did.
        setWarn(
          res.onDisk
            ? `Saved on the relay at ${res.file ?? 'its own disk'} — that survives a restart, ` +
                `but a deploy wipes it unless the host has a mounted volume ` +
                `(set G2_DATA_DIR to that mount). Hub not used: ${res.durableError ?? 'unknown reason'}.`
            : `Saved in memory only — ${res.durableError ?? 'the hub did not accept it'}. ` +
                'It will be forgotten when the relay restarts.',
        );
      } else {
        setNote('Saved — stored on the hub, so it survives deploys.');
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  const toBody = (list: ScheduleJob[]) =>
    list.map((j) => ({ agent: j.agent, at: j.at, days: j.days, ask: j.ask, enabled: j.enabled }));

  const add = async () => {
    if (!draft.agent.trim()) {
      setWarn('Pick an agent first.');
      return;
    }
    if (scheduled.has(draft.agent.trim().toLowerCase())) {
      setWarn(`${draft.agent} is already scheduled — edit that row instead.`);
      return;
    }
    const ok = await write({
      jobs: [
        ...toBody(jobs),
        { agent: draft.agent.trim(), at: draft.at, days: draft.days.length ? draft.days : null, ask: draft.ask.trim() },
      ],
    });
    if (ok) setDraft(BLANK);
  };

  const toggleJob = (job: ScheduleJob) =>
    void write({ jobs: toBody(jobs.map((j) => (j.agent === job.agent && j.at === job.at ? { ...j, enabled: !j.enabled } : j))) });

  const removeJob = (job: ScheduleJob) =>
    void write({ jobs: toBody(jobs.filter((j) => !(j.agent === job.agent && j.at === job.at))) });

  const setEnabled = (enabled: boolean) => void write({ jobs: toBody(jobs), enabled });

  const runNow = async (job: ScheduleJob) => {
    setBusy(true);
    setNote('');
    setWarn('');
    try {
      const res = await runAgentNow(job.agent);
      if (res.ok) setNote(`Started ${job.agent} now — watch the Jarvis tab for the run.`);
      else setWarn(res.error || `Could not start ${job.agent}.`);
    } finally {
      setBusy(false);
    }
  };

  const toggleDay = (day: number) => {
    setDraft((d) => ({
      ...d,
      days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day].sort((a, b) => a - b),
    }));
  };

  return (
    <div
      style={{
        border: '1px solid var(--line, #333)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 14,
      }}
    >
      <div className="panel-label">Scheduled runs</div>

      {/* WHERE THE CLOCK IS, said plainly: this is the question the feature kept
          failing to answer. */}
      <p className="hint-line" style={{ marginTop: 6 }}>
        The clock runs on the relay ({state?.timeZone ?? 'Asia/Singapore'}), so these fire with
        every app closed. Missed windows are skipped after {state?.graceMinutes ?? 20} minutes
        rather than replayed, and at most {state?.caps.perDay ?? 12} runs happen a day.
      </p>

      {loading && <p className="hint-line">Loading the schedule…</p>}

      {/* A 401 is the honest reason a paired-only device sees nothing here, and
          saying so beats an empty list that looks like "you never set one up". */}
      {!loading && !state && (
        <p className="warn-line">
          ⚠️ Could not read the schedule. Editing it needs the relay owner signed in — a paired
          device can run agents but not schedule them.
        </p>
      )}

      {!loading && state?.killed && (
        <p className="warn-line">
          The scheduler is switched off on the relay (<code>G2_AGENT_CRON=0</code>). Nothing here
          will fire until that is unset.
        </p>
      )}

      {!loading && state && jobs.length > 0 && (
        <div className="field-toolbar" style={{ marginTop: 8 }}>
          <button className={state.enabled ? 'primary' : ''} onClick={() => setEnabled(!state.enabled)} disabled={busy}>
            {state.enabled ? 'Scheduler on' : 'Scheduler off'}
          </button>
          <span className="hint-line">
            {state.running ? 'Firing on schedule.' : 'Paused — the jobs below are kept.'}
          </span>
        </div>
      )}

      {note && <p className="hint-line">{note}</p>}
      {warn && <p className="warn-line">⚠️ {warn}</p>}

      {jobs.length === 0 && !loading && (
        <p className="hint-line" style={{ marginTop: 8 }}>
          Nothing scheduled yet. Add one below — a daily agent is how you get a morning brief
          without opening anything.
        </p>
      )}

      {jobs.length > 0 && (
        <ul className="agent-list" style={{ marginTop: 8 }}>
          {jobs.map((job) => (
            <li key={`${job.agent}-${job.at}`} className="agent-row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <strong>{job.agent}</strong>{' '}
                <span className="hint-line">
                  {job.at} · {daysLabel(job.days)}
                </span>
                <div className="hint-line">
                  next {whenLabel(job.nextAt)}
                  {job.lastSlot ? ` · last ran ${job.lastSlot}` : ' · has not run yet'}
                  {job.enabled ? '' : ' · paused'}
                </div>
                {job.ask && <div className="hint-line">+ “{job.ask}”</div>}
                {job.lastError && <div className="warn-line">⚠️ {job.lastError}</div>}
              </div>
              <button onClick={() => void runNow(job)} disabled={busy}>
                Run now
              </button>
              <button onClick={() => toggleJob(job)} disabled={busy}>
                {job.enabled ? 'Pause' : 'Resume'}
              </button>
              <button className="icon-btn danger" onClick={() => removeJob(job)} disabled={busy} aria-label="Remove job">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ADD ONE */}
      <div style={{ marginTop: 12, borderTop: '1px solid var(--line, #333)', paddingTop: 10 }}>
        <div className="panel-label">Add a scheduled run</div>
        <div className="field-toolbar" style={{ marginTop: 6 }}>
          <select
            value={draft.agent}
            onChange={(e) => setDraft((d) => ({ ...d, agent: e.target.value }))}
            aria-label="Agent"
          >
            <option value="">Choose an agent…</option>
            {agentNames.map((name) => (
              <option key={name} value={name}>
                {name}
                {scheduled.has(name.toLowerCase()) ? ' (scheduled)' : ''}
              </option>
            ))}
          </select>
          <input
            type="time"
            value={draft.at}
            onChange={(e) => setDraft((d) => ({ ...d, at: e.target.value }))}
            aria-label="Time"
          />
          <span className="hint-line">{draft.days.length ? daysLabel(draft.days) : 'every day'}</span>
        </div>

        <div className="field-toolbar" style={{ marginTop: 6 }}>
          {DAY_INITIALS.map((initial, day) => {
            const on = draft.days.includes(day);
            return (
              <button
                key={day}
                className={on ? 'primary' : ''}
                onClick={() => toggleDay(day)}
                aria-label={DAY_NAMES[day]}
                aria-pressed={on}
                style={{ minWidth: 34 }}
              >
                {initial}
              </button>
            );
          })}
          {draft.days.length > 0 && (
            <button onClick={() => setDraft((d) => ({ ...d, days: [] }))}>Every day</button>
          )}
        </div>

        <div className="field-toolbar" style={{ marginTop: 6 }}>
          <input
            value={draft.ask}
            onChange={(e) => setDraft((d) => ({ ...d, ask: e.target.value }))}
            placeholder="Optional extra instruction for scheduled runs…"
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={() => void add()} disabled={busy || !draft.agent}>
            Add
          </button>
        </div>

        {state && state.source !== 'none' && state.source !== 'hub' && state.source !== 'ui' && (
          <p className="hint-line">
            Running from the {state.source === 'env' ? 'host environment' : 'local file'} today —
            the next save moves it into the hub, where it survives deploys.
          </p>
        )}
      </div>
    </div>
  );
}
