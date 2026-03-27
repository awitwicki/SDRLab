import { describe, it, expect } from 'vitest';
import { fft, blackmanHarris, powerSpectrum } from './fft';

describe('blackmanHarris', () => {
  it('returns correct window length', () => {
    const w = blackmanHarris(256);
    expect(w.length).toBe(256);
  });

  it('is near zero at edges and peaks in the middle', () => {
    const w = blackmanHarris(256);
    expect(w[0]).toBeCloseTo(0.00006, 4);
    expect(w[128]).toBeGreaterThan(0.9);
  });

  it('is symmetric', () => {
    const w = blackmanHarris(256);
    for (let i = 0; i < 128; i++) {
      expect(w[i]).toBeCloseTo(w[255 - i]!, 5);
    }
  });
});

describe('fft', () => {
  it('detects a DC signal', () => {
    const n = 64;
    const real = new Float32Array(n).fill(1);
    const imag = new Float32Array(n).fill(0);
    fft(real, imag);
    expect(Math.sqrt(real[0]! ** 2 + imag[0]! ** 2)).toBeCloseTo(n, 1);
    for (let i = 1; i < n; i++) {
      expect(Math.sqrt(real[i]! ** 2 + imag[i]! ** 2)).toBeCloseTo(0, 5);
    }
  });

  it('detects a pure cosine at the correct bin', () => {
    const n = 256;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const binIndex = 10;
    for (let i = 0; i < n; i++) {
      real[i] = Math.cos(2 * Math.PI * binIndex * i / n);
    }
    fft(real, imag);
    const mag10 = Math.sqrt(real[10]! ** 2 + imag[10]! ** 2);
    const mag246 = Math.sqrt(real[246]! ** 2 + imag[246]! ** 2);
    expect(mag10).toBeCloseTo(n / 2, 0);
    expect(mag246).toBeCloseTo(n / 2, 0);
    for (let i = 1; i < n; i++) {
      if (i === 10 || i === 246) continue;
      expect(Math.sqrt(real[i]! ** 2 + imag[i]! ** 2)).toBeCloseTo(0, 3);
    }
  });

  it('handles power-of-two sizes', () => {
    for (const size of [8, 16, 32, 128]) {
      const real = new Float32Array(size);
      const imag = new Float32Array(size);
      real[0] = 1;
      expect(() => fft(real, imag)).not.toThrow();
    }
  });
});

describe('powerSpectrum', () => {
  it('converts to dB correctly', () => {
    const real = new Float32Array([1, 0, 0, 0]);
    const imag = new Float32Array([0, 1, 0, 0]);
    const power = powerSpectrum(real, imag);
    expect(power[0]).toBeCloseTo(0, 1);
    expect(power[1]).toBeCloseTo(0, 1);
    expect(power[2]).toBeLessThan(-100);
  });
});
