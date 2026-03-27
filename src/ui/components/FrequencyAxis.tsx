import { useMemo } from 'react';
import styles from './FrequencyAxis.module.css';

interface FrequencyAxisProps {
  centerFrequency: number;
  sampleRate: number;
}

function chooseTickStep(visibleBandwidth: number): number {
  const targetTicks = 8;
  const raw = visibleBandwidth / targetTicks;
  const steps = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000];
  for (const s of steps) {
    if (s >= raw) return s;
  }
  return steps[steps.length - 1]!;
}

function formatTickLabel(hz: number): string {
  const mhz = hz / 1e6;
  if (mhz >= 1000) return (mhz / 1000).toFixed(1) + 'G';
  if (Number.isInteger(mhz)) return mhz.toFixed(0);
  if (mhz * 10 === Math.floor(mhz * 10)) return mhz.toFixed(1);
  return mhz.toFixed(2);
}

export default function FrequencyAxis({ centerFrequency, sampleRate }: FrequencyAxisProps) {
  const ticks = useMemo(() => {
    const step = chooseTickStep(sampleRate);
    const lowFreq = centerFrequency - sampleRate / 2;
    const highFreq = centerFrequency + sampleRate / 2;
    const firstTick = Math.ceil(lowFreq / step) * step;

    const result: { freq: number; pct: number; isCenter: boolean }[] = [];
    for (let f = firstTick; f <= highFreq; f += step) {
      const pct = ((f - lowFreq) / sampleRate) * 100;
      const isCenter = Math.abs(f - centerFrequency) < step / 2;
      result.push({ freq: f, pct, isCenter });
    }
    return result;
  }, [centerFrequency, sampleRate]);

  return (
    <div className={styles.axis}>
      {ticks.map(t => (
        <div
          key={t.freq}
          className={`${styles.tick} ${t.isCenter ? styles.tickCenter : ''}`}
          style={{ left: `${t.pct}%` }}
        >
          <div className={styles.tickMark} />
          <div className={styles.tickLabel}>{formatTickLabel(t.freq)}</div>
        </div>
      ))}
    </div>
  );
}
