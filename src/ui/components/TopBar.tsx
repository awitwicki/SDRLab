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

function formatFrequency(hz: number): string {
  if (hz >= 1e9) return (hz / 1e9).toFixed(6) + ' GHz';
  if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz';
  if (hz >= 1e3) return (hz / 1e3).toFixed(3) + ' kHz';
  return hz.toFixed(0) + ' Hz';
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

const FREQ_STEP = 100_000;
const SAMPLE_RATES = [2_000_000, 4_000_000, 8_000_000, 10_000_000, 16_000_000, 20_000_000];

export default function TopBar({
  connected, running, frequency, tuningOffset, sampleRate, demodMode,
  onConnect, onDisconnect, onStart, onStop,
  onFrequencyChange, onDemodModeChange, onSampleRateChange,
}: TopBarProps) {
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

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -FREQ_STEP : FREQ_STEP;
    onFrequencyChange(Math.max(0, frequency + delta));
  }, [frequency, onFrequencyChange]);

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
        <div
          className={styles.freqDisplay}
          onClick={startEditing}
          onWheel={handleWheel}
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'ArrowUp') onFrequencyChange(frequency + FREQ_STEP);
            if (e.key === 'ArrowDown') onFrequencyChange(Math.max(0, frequency - FREQ_STEP));
          }}
        >
          {formatFrequency(tunedFreq)}
        </div>
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
