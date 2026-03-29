import { useState, useRef, useCallback } from 'react';
import type { DemodMode } from '../../devices/types';
import styles from './TopBar.module.css';

interface TopBarProps {
  connected: boolean;
  running: boolean;
  frequency: number;
  tuningOffset: number;
  sampleRate: number;
  demodMode: DemodMode;
  onConnect: () => void;
  onDisconnect: () => void;
  onStart: () => void;
  onStop: () => void;
  onFrequencyChange: (hz: number) => void;
  onDemodModeChange: (mode: DemodMode) => void;
  onSampleRateChange: (hz: number) => void;
}

function parseFrequency(input: string): number | null {
  const cleaned = input.trim().toLowerCase();
  const match = cleaned.match(/^([0-9]*\.?[0-9]+)\s*(ghz|mhz|khz|hz)?$/);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  if (isNaN(value)) return null;
  const unit = match[2] ?? 'mhz';
  switch (unit) {
    case 'ghz': return value * 1e9;
    case 'mhz': return value * 1e6;
    case 'khz': return value * 1e3;
    case 'hz':  return value;
    default:    return value * 1e6;
  }
}

const SAMPLE_RATES = [2_000_000, 4_000_000, 8_000_000, 10_000_000, 16_000_000, 20_000_000];

/** SDR-style digit-by-digit frequency control.
 *  Click top half of digit → +1 at that position.
 *  Click bottom half → -1.
 *  Right-click → zero that digit and all below.
 *  Scroll wheel → ±1 at that position. */
function FrequencyDigits({ frequency, onChange }: Readonly<{ frequency: number; onChange: (hz: number) => void }>) {
  const hz = Math.round(frequency);
  const str = Math.max(0, hz).toString().padStart(10, '0');
  const firstNonZero = str.search(/[^0]/);

  const handleClick = (digitIdx: number, e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const isTop = e.clientY < rect.top + rect.height / 2;
    const place = Math.pow(10, 9 - digitIdx);
    onChange(Math.max(0, hz + (isTop ? place : -place)));
  };

  const handleContextMenu = (digitIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const place = Math.pow(10, 9 - digitIdx);
    onChange(Math.max(0, Math.floor(hz / (place * 10)) * (place * 10)));
  };

  const handleWheel = (digitIdx: number, e: React.WheelEvent) => {
    e.preventDefault();
    const place = Math.pow(10, 9 - digitIdx);
    onChange(Math.max(0, hz + (e.deltaY < 0 ? place : -place)));
  };

  const elements: React.ReactNode[] = [];
  for (let i = 0; i < 10; i++) {
    if (i === 1 || i === 4 || i === 7) {
      elements.push(<span key={`s${i}`} className={styles.freqSep}>.</span>);
    }
    const isDim = firstNonZero < 0 ? i < 9 : i < firstNonZero;
    elements.push(
      <span
        key={i}
        className={`${styles.freqDigit} ${isDim ? styles.freqDigitDim : ''}`}
        onClick={e => handleClick(i, e)}
        onContextMenu={e => handleContextMenu(i, e)}
        onWheel={e => handleWheel(i, e)}
      >
        {str[i]}
      </span>
    );
  }

  return (
    <div className={styles.freqDigits}>
      {elements}
      <span className={styles.freqUnit}>Hz</span>
    </div>
  );
}

export default function TopBar({
  connected, running, frequency, tuningOffset, sampleRate, demodMode,
  onConnect, onDisconnect, onStart, onStop,
  onFrequencyChange, onDemodModeChange, onSampleRateChange,
}: Readonly<TopBarProps>) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const tunedFreq = frequency + tuningOffset;

  const startEditing = useCallback(() => {
    setEditValue((tunedFreq / 1e6).toFixed(3));
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [tunedFreq]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const parsed = parseFrequency(editValue);
    if (parsed !== null && parsed > 0) {
      onFrequencyChange(parsed);
    }
  }, [editValue, onFrequencyChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditing(false);
  }, [commitEdit]);

  return (
    <div className={styles.topBar}>
      <button
        className={styles.connectBtn}
        data-connected={connected}
        onClick={connected ? onDisconnect : onConnect}
      >
        {connected ? 'Disconnect' : 'Connect'}
      </button>

      <button
        className={styles.startBtn}
        data-running={running}
        onClick={running ? onStop : onStart}
        disabled={!connected}
      >
        {running ? 'Stop' : 'Start'}
      </button>

      {editing ? (
        <input
          ref={inputRef}
          className={styles.freqInput}
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <FrequencyDigits
          frequency={tunedFreq}
          onChange={onFrequencyChange}
        />
      )}

      {!editing && (
        <button className={styles.freqEditBtn} onClick={startEditing} title="Type frequency">
          &#9998;
        </button>
      )}

      <select
        className={styles.modeSelect}
        value={demodMode}
        onChange={e => onDemodModeChange(e.target.value as DemodMode)}
      >
        <option value="WFM">WFM</option>
        <option value="NFM">NFM</option>
        <option value="AM">AM</option>
      </select>

      <select
        className={styles.srSelect}
        value={sampleRate}
        onChange={e => onSampleRateChange(Number(e.target.value))}
      >
        {SAMPLE_RATES.map(sr => (
          <option key={sr} value={sr}>{sr / 1e6} MHz</option>
        ))}
      </select>

      <div className={styles.spacer} />

      <div className={styles.status}>
        <span className={styles.statusDot} data-connected={connected} />
        <span>{connected ? 'Connected' : 'No device'}</span>
      </div>
    </div>
  );
}
