// src/dsp/ook-decoder.ts
import type { BitEvent } from '../devices/types';

/**
 * Decode OOK/ASK signal from IQ samples.
 * Pipeline: envelope detection -> smoothing -> threshold -> edge detection -> bit events.
 */
export function decodeOOK(
  real: Float32Array,
  imag: Float32Array,
  sampleRate: number,
  threshold?: number,
): BitEvent[] {
  const n = real.length;
  if (n === 0) return [];

  // 1. Compute envelope (magnitude)
  const envelope = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    envelope[i] = Math.sqrt(real[i]! * real[i]! + imag[i]! * imag[i]!);
  }

  // 2. Moving average smoothing (keep window small to avoid transition lag)
  const windowSize = Math.max(1, Math.floor(sampleRate / 200000));
  const smoothed = new Float32Array(n);
  let runningSum = 0;
  for (let i = 0; i < n; i++) {
    runningSum += envelope[i]!;
    if (i >= windowSize) runningSum -= envelope[i - windowSize]!;
    smoothed[i] = runningSum / Math.min(i + 1, windowSize);
  }

  // 3. Auto-threshold if not provided
  if (threshold === undefined) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      if (smoothed[i]! < min) min = smoothed[i]!;
      if (smoothed[i]! > max) max = smoothed[i]!;
    }
    threshold = (min + max) / 2;
  }

  // 4. Threshold to bits + edge detection -> events
  const events: BitEvent[] = [];
  let currentBit: 0 | 1 = smoothed[0]! > threshold ? 1 : 0;
  let startSample = 0;

  for (let i = 1; i < n; i++) {
    const bit: 0 | 1 = smoothed[i]! > threshold ? 1 : 0;
    if (bit !== currentBit) {
      const duration = i - startSample;
      events.push({
        bit: currentBit,
        startSample,
        durationSamples: duration,
        durationUs: (duration / sampleRate) * 1e6,
      });
      currentBit = bit;
      startSample = i;
    }
  }

  // Final segment
  const duration = n - startSample;
  events.push({
    bit: currentBit,
    startSample,
    durationSamples: duration,
    durationUs: (duration / sampleRate) * 1e6,
  });

  return events;
}
