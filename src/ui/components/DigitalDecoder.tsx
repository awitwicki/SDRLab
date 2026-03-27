import { useMemo, useCallback } from 'react';
import type { BitEvent } from '../../devices/types';
import styles from './DigitalDecoder.module.css';

interface DigitalDecoderProps {
  bits: BitEvent[];
  enabled: boolean;
  onToggle: () => void;
}

function bitsToHex(events: BitEvent[]): string {
  const rawBits = events.map(e => e.bit);
  if (rawBits.length === 0) return '';
  const bytes: string[] = [];
  for (let i = 0; i + 7 < rawBits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | (rawBits[i + j] ?? 0);
    }
    bytes.push('0x' + byte.toString(16).toUpperCase().padStart(2, '0'));
  }
  return bytes.join(' ');
}

function estimateBitRate(events: BitEvent[]): number | null {
  if (events.length < 2) return null;
  let minDuration = Infinity;
  for (const e of events) {
    if (e.durationUs > 0 && e.durationUs < minDuration) minDuration = e.durationUs;
  }
  if (minDuration === Infinity || minDuration === 0) return null;
  return Math.round(1_000_000 / minDuration);
}

export default function DigitalDecoder({ bits, enabled, onToggle }: DigitalDecoderProps) {
  const hexStr = useMemo(() => bitsToHex(bits), [bits]);
  const bitRate = useMemo(() => estimateBitRate(bits), [bits]);

  const copyBits = useCallback(() => {
    const str = bits.map(e => e.bit).join('');
    navigator.clipboard.writeText(str);
  }, [bits]);

  const copyHex = useCallback(() => {
    navigator.clipboard.writeText(hexStr);
  }, [hexStr]);

  if (!enabled) return null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Digital Decoder (OOK)</span>
        <div className={styles.actions}>
          <button className={styles.actionBtn} onClick={copyBits} disabled={bits.length === 0}>Copy Bits</button>
          <button className={styles.actionBtn} onClick={copyHex} disabled={!hexStr}>Copy Hex</button>
          <button className={styles.actionBtn} onClick={onToggle}>Close</button>
        </div>
      </div>
      {bits.length === 0 ? (
        <div className={styles.empty}>Waiting for OOK signal...</div>
      ) : (
        <>
          <div className={styles.bitstream}>
            {bits.map((e, i) => (<span key={i} className={e.bit === 1 ? styles.bitOne : styles.bitZero}>{e.bit}</span>))}
          </div>
          {hexStr && <div className={styles.hexView}>{hexStr}</div>}
          <div className={styles.timing}>
            {bitRate && <div className={styles.timingItem}><span>Bit rate:</span><span>~{bitRate} bps</span></div>}
            {bits.length > 0 && <div className={styles.timingItem}><span>Events:</span><span>{bits.length}</span></div>}
            {bits.length > 0 && <div className={styles.timingItem}><span>Min pulse:</span><span>{Math.round(Math.min(...bits.map(b => b.durationUs)))} us</span></div>}
          </div>
        </>
      )}
    </div>
  );
}
