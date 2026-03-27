/**
 * In-place radix-2 Cooley-Tukey FFT.
 * Arrays are modified in place. Length must be a power of 2.
 */
export function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      let tmp = real[i]!; real[i] = real[j]!; real[j] = tmp;
      tmp = imag[i]!; imag[i] = imag[j]!; imag[j] = tmp;
    }
  }

  // Butterfly stages
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angle = -2 * Math.PI / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let j = 0; j < halfLen; j++) {
        const uReal = real[i + j]!;
        const uImag = imag[i + j]!;
        const vReal = real[i + j + halfLen]! * curReal - imag[i + j + halfLen]! * curImag;
        const vImag = real[i + j + halfLen]! * curImag + imag[i + j + halfLen]! * curReal;
        real[i + j] = uReal + vReal;
        imag[i + j] = uImag + vImag;
        real[i + j + halfLen] = uReal - vReal;
        imag[i + j + halfLen] = uImag - vImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/** Generate a Blackman-Harris window of length n. */
export function blackmanHarris(n: number): Float32Array {
  const w = new Float32Array(n);
  const a0 = 0.35875;
  const a1 = 0.48829;
  const a2 = 0.14128;
  const a3 = 0.01168;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
  }
  return w;
}

/** Convert complex FFT output to power in dB. */
export function powerSpectrum(real: Float32Array, imag: Float32Array): Float32Array {
  const n = real.length;
  const power = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const mag2 = real[i]! * real[i]! + imag[i]! * imag[i]!;
    power[i] = 10 * Math.log10(mag2 + 1e-20);
  }
  return power;
}
