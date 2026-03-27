/** FM demodulation via phase differentiation. */
export function demodFM(real: Float32Array, imag: Float32Array): Float32Array {
  const n = real.length;
  const audio = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const conjReal = real[i]! * real[i - 1]! + imag[i]! * imag[i - 1]!;
    const conjImag = imag[i]! * real[i - 1]! - real[i]! * imag[i - 1]!;
    audio[i] = Math.atan2(conjImag, conjReal);
  }
  audio[0] = 0;
  return audio;
}

/** AM demodulation via envelope detection with DC removal. */
export function demodAM(real: Float32Array, imag: Float32Array): Float32Array {
  const n = real.length;
  const audio = new Float32Array(n);
  let dcSum = 0;
  for (let i = 0; i < n; i++) {
    audio[i] = Math.sqrt(real[i]! * real[i]! + imag[i]! * imag[i]!);
    dcSum += audio[i]!;
  }
  const dc = dcSum / n;
  for (let i = 0; i < n; i++) {
    audio[i] = audio[i]! - dc;
  }
  return audio;
}

/** Measure RMS signal power in dB. */
export function measurePower(real: Float32Array, imag: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < real.length; i++) {
    sum += real[i]! * real[i]! + imag[i]! * imag[i]!;
  }
  return 10 * Math.log10(sum / real.length + 1e-20);
}

/**
 * Single-pole IIR de-emphasis filter.
 * Standard FM broadcast uses tau=75us (Americas) or 50us (Europe).
 */
export class DeEmphasis {
  private a: number;
  private b: number;
  private prev = 0;

  constructor(sampleRate: number, tau = 75e-6) {
    const dt = 1 / sampleRate;
    this.a = dt / (tau + dt);
    this.b = 1 - this.a;
  }

  process(samples: Float32Array): Float32Array {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const input = samples[i]!;
      this.prev = this.a * input + this.b * this.prev;
      out[i] = this.prev;
    }
    return out;
  }

  reset(): void {
    this.prev = 0;
  }
}
