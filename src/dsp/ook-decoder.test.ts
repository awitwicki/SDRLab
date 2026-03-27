// src/dsp/ook-decoder.test.ts
import { describe, it, expect } from 'vitest';
import { decodeOOK } from './ook-decoder';
function generateOOKSignal(
  bits: number[],
  samplesPerBit: number,
  _sampleRate: number,
  noiseLevel = 0,
): { real: Float32Array; imag: Float32Array } {
  const totalSamples = bits.length * samplesPerBit;
  const real = new Float32Array(totalSamples);
  const imag = new Float32Array(totalSamples);
  for (let b = 0; b < bits.length; b++) {
    for (let s = 0; s < samplesPerBit; s++) {
      const idx = b * samplesPerBit + s;
      const amplitude = bits[b]! === 1 ? 1.0 : 0.0;
      real[idx] = amplitude + (Math.random() - 0.5) * noiseLevel;
      imag[idx] = (Math.random() - 0.5) * noiseLevel;
    }
  }
  return { real, imag };
}

describe('decodeOOK', () => {
  it('decodes a simple alternating bit pattern', () => {
    const bits = [1, 0, 1, 0, 1, 0];
    const samplesPerBit = 100;
    const sampleRate = 100000;
    const { real, imag } = generateOOKSignal(bits, samplesPerBit, sampleRate);
    const events = decodeOOK(real, imag, sampleRate);
    expect(events.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(events[i]!.bit).toBe(bits[i]);
    }
  });

  it('detects correct pulse widths', () => {
    const bits = [1, 1, 0, 0, 0, 1];
    const samplesPerBit = 200;
    const sampleRate = 200000;
    const { real, imag } = generateOOKSignal(bits, samplesPerBit, sampleRate);
    const events = decodeOOK(real, imag, sampleRate);
    expect(events.length).toBe(3);
    expect(events[0]!.bit).toBe(1);
    expect(events[0]!.durationSamples).toBeCloseTo(400, -2);
    expect(events[1]!.bit).toBe(0);
    expect(events[1]!.durationSamples).toBeCloseTo(600, -2);
    expect(events[2]!.bit).toBe(1);
    expect(events[2]!.durationSamples).toBeCloseTo(200, -2);
  });

  it('reports timing in microseconds', () => {
    const sampleRate = 1000000;
    const { real, imag } = generateOOKSignal([1, 0], 500, sampleRate);
    const events = decodeOOK(real, imag, sampleRate);
    expect(events[0]!.durationUs).toBeCloseTo(500, -1);
  });

  it('handles all-zeros (silence)', () => {
    const real = new Float32Array(1000).fill(0);
    const imag = new Float32Array(1000).fill(0);
    const events = decodeOOK(real, imag, 100000);
    expect(events.length).toBe(1);
    expect(events[0]!.bit).toBe(0);
  });
});
