import { describe, it, expect } from 'vitest';
import { demodFM, demodAM, DeEmphasis } from './demodulators';

describe('demodFM', () => {
  it('recovers a constant-frequency signal as DC', () => {
    const n = 256;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const freq = 0.1;
    for (let i = 0; i < n; i++) {
      real[i] = Math.cos(2 * Math.PI * freq * i);
      imag[i] = Math.sin(2 * Math.PI * freq * i);
    }
    const audio = demodFM(real, imag);
    const ref = audio[1]!;
    for (let i = 2; i < n; i++) {
      expect(audio[i]).toBeCloseTo(ref, 3);
    }
  });

  it('detects frequency modulation', () => {
    const n = 512;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const instFreq = 0.05 + 0.0001 * i;
      phase += 2 * Math.PI * instFreq;
      real[i] = Math.cos(phase);
      imag[i] = Math.sin(phase);
    }
    const audio = demodFM(real, imag);
    let increasing = 0;
    for (let i = 10; i < n - 1; i++) {
      if (audio[i + 1]! > audio[i]! - 0.001) increasing++;
    }
    expect(increasing / (n - 11)).toBeGreaterThan(0.9);
  });
});

describe('demodAM', () => {
  it('recovers envelope of an AM signal', () => {
    const n = 512;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const carrierFreq = 0.25;
    const modFreq = 0.01;
    for (let i = 0; i < n; i++) {
      const envelope = 0.5 + 0.5 * Math.cos(2 * Math.PI * modFreq * i);
      real[i] = envelope * Math.cos(2 * Math.PI * carrierFreq * i);
      imag[i] = envelope * Math.sin(2 * Math.PI * carrierFreq * i);
    }
    const audio = demodAM(real, imag);
    let crossings = 0;
    for (let i = 1; i < n; i++) {
      if (audio[i - 1]! * audio[i]! < 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(6);
    expect(crossings).toBeLessThan(16);
  });
});

describe('DeEmphasis', () => {
  it('attenuates high frequencies more than low', () => {
    const sampleRate = 48000;
    const de = new DeEmphasis(sampleRate);
    const lowFreq = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) lowFreq[i] = Math.sin(2 * Math.PI * 100 * i / sampleRate);
    const lowOut = de.process(lowFreq);
    de.reset();
    const highFreq = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) highFreq[i] = Math.sin(2 * Math.PI * 10000 * i / sampleRate);
    const highOut = de.process(highFreq);
    let lowAmp = 0, highAmp = 0;
    for (let i = 800; i < 1000; i++) {
      lowAmp = Math.max(lowAmp, Math.abs(lowOut[i]!));
      highAmp = Math.max(highAmp, Math.abs(highOut[i]!));
    }
    expect(lowAmp).toBeGreaterThan(highAmp * 2);
  });
});
