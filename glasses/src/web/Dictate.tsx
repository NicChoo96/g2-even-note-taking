// Reusable voice-input button for the G2 Even Reality Hub.
//
// Mount a <MicButton onText={...} /> next to ANY text box / input to give it
// speech-to-text: tap the mic, talk (glasses/phone mic in the Even App, or the
// browser mic on the web), and the FINISHED transcript is delivered to onText
// once — when you stop the mic. The heavy lifting lives in the engine-agnostic
// module ../dictate.
//
// The transcript is deliberately NOT written into the field while listening:
// a write re-renders the host page, and on the glasses a page write while the
// mic is open makes the host drop the audio stream mid-utterance. Instead the
// running transcript is shown next to the mic and committed on stop.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dictationSnapshot,
  isDictating,
  lastDictationReason,
  startDictation,
  stopDictation,
  type DictState,
} from '../dictate';

export interface MicButtonProps {
  /** Receives the FINISHED transcript once — when you stop the mic. */
  onText: (text: string) => void;
  /** Short helper text shown next to the mic when idle. */
  hint?: string;
  /** Tooltip / aria context. */
  title?: string;
  /** Hide the helper/interim text (use in tight rows, e.g. the todo adder). */
  compact?: boolean;
  /**
   * 'text' (default) writes the transcript into a field; 'ai' hands it to the
   * Jarvis agent. The capture flow is IDENTICAL — only the wording changes — so
   * an AI command never needs a different mic gesture or a second permission
   * prompt. Every existing MicButton keeps the default and is unaffected.
   */
  mode?: 'text' | 'ai';
}

export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictState>('idle');
  const [detail, setDetail] = useState('');
  const [interim, setInterim] = useState('');
  // True once ANY phrase was committed to the field — used to tell a normal
  // end from an abnormal one so failures are never silent.
  const gotFinal = useRef(false);
  const flashTimer = useRef(0);
  // Keep the latest callback in a ref: `toggle` must stay identity-stable, or
  // the target field's re-render would restart the session on every keystroke.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

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
          // Commit ONCE, now that the mic is closed. Writing the field mid-
          // session re-renders the page and the host drops the audio stream.
          const snap = dictationSnapshot();
          if (snap.commit && snap.text) {
            gotFinal.current = true;
            onTextRef.current(snap.text);
          }
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
      // Live transcript — shown while speaking, NOT written to the field.
      onText: (full) => setInterim(full),
    });
  }, []);

  // Clear any transient error timer on unmount.
  useEffect(() => {
    return () => window.clearTimeout(flashTimer.current);
  }, []);

  return { state, detail, interim, toggle };
}

export function MicButton({ onText, hint, title, compact = false, mode = 'text' }: MicButtonProps) {
  const { state, detail, interim, toggle } = useDictation(onText);
  const listening = state === 'listening';
  const busy = state === 'transcribing';
  const bad = state === 'error' || state === 'unsupported';
  const ai = mode === 'ai';

  const label = listening
    ? ai
      ? 'Stop and run the agent'
      : 'Stop dictation'
    : busy
      ? 'Transcribing…'
      : ai
        ? 'Speak a command for Jarvis'
        : 'Dictate with voice';
  return (
    <span
      className={`dictate ${compact ? 'dictate-compact' : ''} ${ai ? 'dictate-ai' : ''}`}
      title={title || hint}
    >
      <button
        type="button"
        className={`mic-btn ${listening ? 'on' : ''} ${busy ? 'busy' : ''} ${bad ? 'err' : ''}`}
        onClick={() => void toggle()}
        aria-label={label}
        aria-pressed={listening}
      >
        {busy ? '…' : listening ? '◼' : ai ? '✦' : '🎙'}
      </button>
      {!compact && (
        <span className={`dictate-state ${bad ? 'err' : ''}`}>
          {bad
            ? detail || 'Voice unavailable'
            : interim ||
              (listening
                ? ai
                  ? 'Listening… stop to run the agent'
                  : 'Listening… tap the mic to stop'
                : hint || 'Tap to dictate (mic permission will be requested)')}
        </span>
      )}
    </span>
  );
}
