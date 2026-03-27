// src/dsp/worker.ts
import { fft, blackmanHarris, powerSpectrum } from './fft';
import { designLowPass, FIRFilter, decimate, NCOMixer } from './filters';
import { demodFM, demodAM, measurePower, DeEmphasis } from './demodulators';
import { decodeOOK } from './ook-decoder';
import type { DemodMode, WorkerInMessage, WorkerOutMessage } from '../devices/types';

// --- State ---
let config = {
  sampleRate: 2_000_000,
  demodMode: 'WFM' as DemodMode,
  fftSize: 1024,
  squelchLevel: -60,
  frequencyOffset: 0,
  ookEnabled: false,
};

const AUDIO_RATE = 48000;

let window: Float32Array = blackmanHarris(config.fftSize);
let mixer = new NCOMixer();
let deemphasis = new DeEmphasis(AUDIO_RATE);

// Decimation filters — rebuilt on config change
let channelFilter: FIRFilter | null = null;
let audioFilter: FIRFilter | null = null;

function getChannelBandwidth(mode: DemodMode): number {
  switch (mode) {
    case 'WFM': return 200_000;
    case 'NFM': return 12_500;
    case 'AM':  return 10_000;
  }
}

function rebuildFilters(): void {
  const channelBW = getChannelBandwidth(config.demodMode);
  channelFilter = new FIRFilter(designLowPass(channelBW / 2, config.sampleRate, 63));
  // Audio decimation: from channel rate to 48 kHz
  const channelRate = Math.min(config.sampleRate, channelBW * 2);
  if (channelRate > AUDIO_RATE) {
    audioFilter = new FIRFilter(designLowPass(AUDIO_RATE / 2, channelRate, 31));
  } else {
    audioFilter = null;
  }
  deemphasis.reset();
}

rebuildFilters();

// --- FFT Processing ---
function processFFT(real: Float32Array, imag: Float32Array): void {
  const n = config.fftSize;
  const fftReal = new Float32Array(n);
  const fftImag = new Float32Array(n);
  // Take last fftSize samples, apply window
  const offset = Math.max(0, real.length - n);
  for (let i = 0; i < n && offset + i < real.length; i++) {
    fftReal[i] = real[offset + i]! * window[i]!;
    fftImag[i] = imag[offset + i]! * window[i]!;
  }
  fft(fftReal, fftImag);
  const bins = powerSpectrum(fftReal, fftImag);

  // FFT-shift: move DC to center
  const shifted = new Float32Array(n);
  const half = n / 2;
  for (let i = 0; i < half; i++) {
    shifted[i] = bins[i + half]!;
    shifted[i + half] = bins[i]!;
  }

  const msg: WorkerOutMessage = { type: 'fft', bins: shifted };
  self.postMessage(msg, { transfer: [shifted.buffer] } as unknown as StructuredSerializeOptions);
}

// --- Demodulation Pipeline ---
function processAudio(real: Float32Array, imag: Float32Array): void {
  // 1. Frequency shift (tuning offset)
  let sigReal = real;
  let sigImag = imag;
  if (config.frequencyOffset !== 0) {
    const mixed = mixer.mix(real, imag, -config.frequencyOffset, config.sampleRate);
    sigReal = mixed.real;
    sigImag = mixed.imag;
  }

  // 2. Channel filter + decimation to channel bandwidth
  const channelBW = getChannelBandwidth(config.demodMode);
  const channelDecimation = Math.max(1, Math.floor(config.sampleRate / (channelBW * 2)));
  let chReal: Float32Array, chImag: Float32Array;
  if (channelFilter && channelDecimation > 1) {
    const dec = decimate(sigReal, sigImag, channelDecimation, channelFilter);
    chReal = dec.real;
    chImag = dec.imag;
  } else {
    chReal = sigReal;
    chImag = sigImag;
  }

  // 3. Squelch check
  const power = measurePower(chReal, chImag);
  const squelchOpen = power > config.squelchLevel;

  // 4. Demodulate
  let audio: Float32Array;
  switch (config.demodMode) {
    case 'WFM':
    case 'NFM':
      audio = demodFM(chReal, chImag);
      if (config.demodMode === 'WFM') {
        audio = deemphasis.process(audio);
      }
      break;
    case 'AM':
      audio = demodAM(chReal, chImag);
      break;
  }

  // 5. Decimate to audio rate (48 kHz)
  const channelRate = config.sampleRate / channelDecimation;
  const audioDecimation = Math.max(1, Math.floor(channelRate / AUDIO_RATE));
  if (audioFilter && audioDecimation > 1) {
    const audioImag = new Float32Array(audio.length);
    const dec = decimate(audio, audioImag, audioDecimation, audioFilter);
    audio = dec.real;
  }

  const msg: WorkerOutMessage = { type: 'audio', samples: audio, squelchOpen };
  self.postMessage(msg, { transfer: [audio.buffer] } as unknown as StructuredSerializeOptions);
}

// --- OOK Processing ---
function processOOK(real: Float32Array, imag: Float32Array): void {
  if (!config.ookEnabled) return;

  let sigReal = real;
  let sigImag = imag;
  if (config.frequencyOffset !== 0) {
    const mixed = mixer.mix(real, imag, -config.frequencyOffset, config.sampleRate);
    sigReal = mixed.real;
    sigImag = mixed.imag;
  }

  const events = decodeOOK(sigReal, sigImag, config.sampleRate);
  if (events.length > 0) {
    const msg: WorkerOutMessage = { type: 'bits', data: events };
    self.postMessage(msg);
  }
}

// --- Message Handler ---
self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'config') {
    const modeChanged = msg.demodMode !== config.demodMode;
    const sampleRateChanged = msg.sampleRate !== config.sampleRate;
    const fftSizeChanged = msg.fftSize !== config.fftSize;

    config = {
      sampleRate: msg.sampleRate,
      demodMode: msg.demodMode,
      fftSize: msg.fftSize,
      squelchLevel: msg.squelchLevel,
      frequencyOffset: msg.frequencyOffset,
      ookEnabled: msg.ookEnabled,
    };

    if (fftSizeChanged) {
      window = blackmanHarris(config.fftSize);
    }
    if (modeChanged || sampleRateChanged) {
      rebuildFilters();
      mixer.reset();
    }
  }

  if (msg.type === 'iq') {
    const data = msg.data;
    // Deinterleave I/Q (data is already Float32Array of interleaved I,Q)
    const n = data.length / 2;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      real[i] = data[i * 2]!;
      imag[i] = data[i * 2 + 1]!;
    }

    processFFT(real, imag);
    processAudio(real, imag);
    processOOK(real, imag);
  }
};
