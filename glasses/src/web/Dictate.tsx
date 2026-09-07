// Reusable voice-input button for the G2 Even Reality Hub.
//
// Mount a <MicButton onText={...} /> next to ANY text box / input to give it
// speech-to-text: tap the mic, talk (glasses/phone mic in the Even App, or the
// browser mic on the web), and the transcript is delivered to onText. The heavy
// lifting lives in the engine-agnostic module ../dictate.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isDictating,
  lastDictationReason,
  startDictation,
  stopDictation,
  type DictState,
} from '../dictate';

export interface MicButtonProps {
  /** Receives each committed transcript chunk — append it to your input. */
  onText: (text: string) => void;
  /** Short helper text shown next to the mic when idle. */
  hint?: string;
  /** Tooltip / aria context. */
  title?: string;
  /** Hide the helper/interim text (use in tight rows, e.g. the todo adder). */
  compact?: boolean;
}

export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictState>('idle');
  const [detail, setDetail] = useState('');
  const [interim, setInterim] = useState('');
  // True once ANY phrase was committed to the field — used to tell a normal
  // end from an abnormal one so failures are never silent.
  const gotFinal = useRef(false);
  const flashTimer = useRef(0);

  const toggle = useCallback(async () => {
    if (isDictating()) {
      await stopDictation();
      return;
    }
    gotFinal.current = false;
    setInterim('');
    setDetail('');
    window.clearTimeout(flashTimer.current);
    await startDictation({
      onState: (s, d) => {
        if (s === 'listening' || s === 'transcribing') {
          setState(s);
          setDetail(d || '');
        } else if (s === 'error' || s === 'unsupported') {
          setState(s);
          setDetail(d || 'Voice unavailable');
          setInterim('');
        } else if (s === 'idle') {
          setInterim('');
          const r = lastDictationReason();
          // Ended without committing anything and NOT by an explicit stop →
          // surface WHY instead of silently returning to the idle mic.
          const abnormal =
            !gotFinal.current && !/tap|abort/.test(r) && r !== 'running' && r !== 'unknown';
          if (abnormal) {
            const short = (r || '').replace('auto-stop (', '').replace(')', '');
            setState('error');
            setDetail(
              short === 'never-heard'
                ? 'Nothing heard — is the mic allowed?'
                : short && short !== 'quiet'
                  ? `Ended: ${short}`
                  : 'Nothing captured — try again',
            );
            window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => {
              setState('idle');
              setDetail('');
            }, 4500);
          } else {
            setState('idle');
          }
        }
      },
      onPartial: (t) => setInterim(t),
      onFinal: (t) => {
        gotFinal.current = true;
        setInterim('');
        // Append to the target field — dictation KEEPS RUNNING (only an explicit
        // stop / ~5s silence / cap ends the session).
        onText(t);
      },
    });
  }, [onText]);

  // Clear any transient error timer on unmount.
  useEffect(() => {
    return () => window.clearTimeout(flashTimer.current);
  }, []);

  return { state, detail, interim, toggle };
}

export function MicButton({ onText, hint, title, compact = false }: MicButtonProps) {
  const { state, detail, interim, toggle } = useDictation(onText);
  const listening = state === 'listening';
  const busy = state === 'transcribing';
  const bad = state === 'error' || state === 'unsupported';

  const label = listening ? 'Stop dictation' : busy ? 'Transcribing…' : 'Dictate with voice';
  return (
    <span
      className={`dictate ${compact ? 'dictate-compact' : ''}`}
      title={title || hint}
    >
      <button
        type="button"
        className={`mic-btn ${listening ? 'on' : ''} ${busy ? 'busy' : ''} ${bad ? 'err' : ''}`}
        onClick={() => void toggle()}
        aria-label={label}
        aria-pressed={listening}
      >
        {busy ? '…' : listening ? '◼' : '🎙'}
      </button>
      {!compact && (
        <span className={`dictate-state ${bad ? 'err' : ''}`}>
          {bad
            ? detail || 'Voice unavailable'
            : interim ||
              (listening ? 'Listening… tap the mic to stop' : hint || 'Tap to dictate (mic permission will be requested)')}
        </span>
      )}
    </span>
  );
}
