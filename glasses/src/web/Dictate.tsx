// Reusable voice-input button for the G2 Even Reality Hub.
//
// Mount a <MicButton onText={...} /> next to ANY text box / input to give it
// speech-to-text: tap the mic, talk (glasses/phone mic in the Even App, or the
// browser mic on the web), and the transcript is delivered to onText. The heavy
// lifting lives in the engine-agnostic module ../dictate.
import { useCallback, useState } from 'react';
import { startDictation, stopDictation, isDictating, type DictState } from '../dictate';

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

  const toggle = useCallback(async () => {
    if (isDictating()) {
      await stopDictation();
      return;
    }
    setInterim('');
    setDetail('');
    await startDictation({
      onState: (s, d) => {
        setState(s);
        setDetail(d || '');
        if (s === 'idle' || s === 'error' || s === 'unsupported') setInterim('');
      },
      onPartial: (t) => setInterim(t),
      onFinal: (t) => {
        setInterim('');
        onText(t);
      },
    });
  }, [onText]);

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
              (listening ? 'Listening… tap the mic to stop' : hint || 'Voice input')}
        </span>
      )}
    </span>
  );
}
