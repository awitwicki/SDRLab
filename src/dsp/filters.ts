/**
 * Design a FIR low-pass filter using windowed sinc method (Blackman window).
 */
export function designLowPass(cutoffHz: number, sampleRate: number, numTaps: number): Float32Array {
  const taps = new Float32Array(numTaps);
  const fc = cutoffHz / sampleRate;
  const m = (numTaps - 1) / 2;

  for (let i = 0; i < numTaps; i++) {
    if (i === m) {
      taps[i] = 2 * fc;
    } else {
      const x = i - m;
      taps[i] = Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    }
    // Blackman window
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1))
            + 0.08 * Math.cos((4 * Math.PI * i) / (numTaps - 1));
    taps[i] = taps[i]! * w;
  }

  // Normalize for unity DC gain
  let sum = 0;
  for (let i = 0; i < numTaps; i++) sum += taps[i]!;
  for (let i = 0; i < numTaps; i++) taps[i] = taps[i]! / sum;

  return taps;
}

/** Stateful FIR filter for complex (I/Q) samples. */
export class FIRFilter {
  private taps: Float32Array;
  private bufReal: Float32Array;
  private bufImag: Float32Array;
  private pos = 0;

  constructor(taps: Float32Array) {
    this.taps = taps;
    this.bufReal = new Float32Array(taps.length);
    this.bufImag = new Float32Array(taps.length);
  }

  process(real: Float32Array, imag: Float32Array): { real: Float32Array; imag: Float32Array } {
    const n = real.length;
    const outReal = new Float32Array(n);
    const outImag = new Float32Array(n);
    const numTaps = this.taps.length;

    for (let i = 0; i < n; i++) {
      this.bufReal[this.pos] = real[i]!;
      this.bufImag[this.pos] = imag[i]!;
      let sumR = 0;
      let sumI = 0;
      for (let j = 0; j < numTaps; j++) {
        const idx = (this.pos - j + numTaps) % numTaps;
        sumR += this.taps[j]! * this.bufReal[idx]!;
        sumI += this.taps[j]! * this.bufImag[idx]!;
      }
      outReal[i] = sumR;
      outImag[i] = sumI;
      this.pos = (this.pos + 1) % numTaps;
    }

    return { real: outReal, imag: outImag };
  }

  reset(): void {
    this.bufReal.fill(0);
    this.bufImag.fill(0);
    this.pos = 0;
  }
}

/** Low-pass filter + downsample by integer factor. */
export function decimate(
  real: Float32Array,
  imag: Float32Array,
  factor: number,
  filter: FIRFilter,
): { real: Float32Array; imag: Float32Array } {
  const filtered = filter.process(real, imag);
  const outLen = Math.floor(filtered.real.length / factor);
  const outReal = new Float32Array(outLen);
  const outImag = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    outReal[i] = filtered.real[i * factor]!;
    outImag[i] = filtered.imag[i * factor]!;
  }
  return { real: outReal, imag: outImag };
}

/** Numerically controlled oscillator for frequency shifting. */
export class NCOMixer {
  private phase = 0;

  mix(
    real: Float32Array,
    imag: Float32Array,
    offsetHz: number,
    sampleRate: number,
  ): { real: Float32Array; imag: Float32Array } {
    const n = real.length;
    const outReal = new Float32Array(n);
    const outImag = new Float32Array(n);
    const phaseInc = (2 * Math.PI * offsetHz) / sampleRate;

    for (let i = 0; i < n; i++) {
      const cosVal = Math.cos(this.phase);
      const sinVal = Math.sin(this.phase);
      outReal[i] = real[i]! * cosVal - imag[i]! * sinVal;
      outImag[i] = real[i]! * sinVal + imag[i]! * cosVal;
      this.phase += phaseInc;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      if (this.phase < -2 * Math.PI) this.phase += 2 * Math.PI;
    }

    return { real: outReal, imag: outImag };
  }

  reset(): void {
    this.phase = 0;
  }
}
