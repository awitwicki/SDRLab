import { useState, useRef, useCallback, useEffect, memo } from 'react';
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
  rdsPs?: string;
  isFullscreen: boolean;
  /** False where the browser has no Fullscreen API, e.g. Safari on iPhone. */
  fullscreenSupported: boolean;
  onFullscreenToggle: () => void;
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
  const str = Math.max(0, hz).toString().padStart(10, '0').slice(-10);
  const firstNonZero = str.search(/[^0]/);
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ hz, onChange });
  stateRef.current = { hz, onChange };

  const placeOf = (digitIdx: number) => Math.pow(10, 9 - digitIdx);
  const step = (digitIdx: number, dir: 1 | -1) => {
    const { hz, onChange } = stateRef.current;
    onChange(Math.max(0, hz + dir * placeOf(digitIdx)));
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const idx = (e.target as HTMLElement).dataset['digit'];
      if (idx === undefined) return;
      e.preventDefault(); // works: listener registered with passive: false
      step(Number(idx), e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleClick = (digitIdx: number, e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    step(digitIdx, e.clientY < rect.top + rect.height / 2 ? 1 : -1);
  };

  const handleContextMenu = (digitIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const place = placeOf(digitIdx);
    stateRef.current.onChange(Math.max(0, Math.floor(hz / (place * 10)) * (place * 10)));
  };

  const handleKeyDown = (digitIdx: number, e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); step(digitIdx, 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(digitIdx, -1); }
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
        data-digit={i}
        tabIndex={0}
        role="spinbutton"
        aria-label={`${placeOf(i).toLocaleString()} Hz digit`}
        aria-valuenow={Number(str[i])}
        aria-valuemin={0}
        aria-valuemax={9}
        className={`${styles.freqDigit} ${isDim ? styles.freqDigitDim : ''}`}
        onClick={e => handleClick(i, e)}
        onContextMenu={e => handleContextMenu(i, e)}
        onKeyDown={e => handleKeyDown(i, e)}
      >
        {str[i]}
      </span>
    );
  }

  return (
    <div ref={containerRef} className={styles.freqDigits}>
      {elements}
      <span className={styles.freqUnit}>Hz</span>
    </div>
  );
}

function TopBar({
  connected, running, frequency, tuningOffset, sampleRate, demodMode,
  onConnect, onDisconnect, onStart, onStop,
  onFrequencyChange, onDemodModeChange, onSampleRateChange, rdsPs,
  isFullscreen, fullscreenSupported, onFullscreenToggle,
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

      {rdsPs && <span className={styles.rdsPs} title="RDS station name">{rdsPs}</span>}

      <div className={styles.spacer} />

      <div className={styles.status}>
        <span className={styles.statusDot} data-connected={connected} />
        <span>{connected ? 'Connected' : 'No device'}</span>
      </div>

      {fullscreenSupported && (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onFullscreenToggle}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          <svg
            width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
          >
            {/* Corners point outward to expand, inward to restore. */}
            <path d={isFullscreen ? 'M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4' : 'M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4'} />
          </svg>
        </button>
      )}
    </div>
  );
}

export default memo(TopBar);
