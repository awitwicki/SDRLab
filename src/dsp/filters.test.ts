import { describe, it, expect } from 'vitest';
import { designLowPass, FIRFilter, decimate, NCOMixer } from './filters';

describe('designLowPass', () => {
  it('returns correct number of taps', () => {
    const taps = designLowPass(1000, 10000, 31);
    expect(taps.length).toBe(31);
  });

  it('taps sum to approximately 1 (unity gain at DC)', () => {
    const taps = designLowPass(1000, 10000, 31);
    let sum = 0;
    for (let i = 0; i < taps.length; i++) sum += taps[i]!;
    expect(sum).toBeCloseTo(1, 2);
  });

  it('is symmetric', () => {
    const taps = designLowPass(1000, 10000, 31);
    for (let i = 0; i < 15; i++) {
      expect(taps[i]).toBeCloseTo(taps[30 - i]!, 10);
    }
  });
});

describe('FIRFilter', () => {
  it('passes DC signal unchanged', () => {
    const taps = designLowPass(5000, 48000, 31);
    const filter = new FIRFilter(taps);
    const real = new Float32Array(100).fill(1);
    const imag = new Float32Array(100).fill(0);
    const out = filter.process(real, imag);
    for (let i = 31; i < 100; i++) {
      expect(out.real[i]).toBeCloseTo(1, 1);
    }
  });

  it('attenuates high-frequency signal', () => {
    const sampleRate = 48000;
    const cutoff = 1000;
    const taps = designLowPass(cutoff, sampleRate, 63);
    const filter = new FIRFilter(taps);
    const n = 500;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      real[i] = Math.cos(2 * Math.PI * 10000 * i / sampleRate);
    }
    const out = filter.process(real, imag);
    let maxAmp = 0;
    for (let i = 200; i < n; i++) {
      maxAmp = Math.max(maxAmp, Math.abs(out.real[i]!));
    }
    expect(maxAmp).toBeLessThan(0.1);
  });
});

describe('decimate', () => {
  it('reduces output length by decimation factor', () => {
    const taps = designLowPass(5000, 48000, 31);
    const filter = new FIRFilter(taps);
    const real = new Float32Array(100).fill(1);
    const imag = new Float32Array(100).fill(0);
    const out = decimate(real, imag, 4, filter);
    expect(out.real.length).toBe(25);
    expect(out.imag.length).toBe(25);
  });
});

describe('NCOMixer', () => {
  it('shifts a DC signal to the target offset frequency', () => {
    const mixer = new NCOMixer();
    const n = 1024;
    const real = new Float32Array(n).fill(1);
    const imag = new Float32Array(n).fill(0);
    const sampleRate = 48000;
    const offset = 1000;
    const out = mixer.mix(real, imag, offset, sampleRate);
    let crossings = 0;
    for (let i = 1; i < n; i++) {
      if (out.real[i - 1]! * out.real[i]! < 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(35);
    expect(crossings).toBeLessThan(50);
  });
});
