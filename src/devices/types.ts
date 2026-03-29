// src/devices/types.ts

export interface GainStage {
  name: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface DeviceInfo {
  name: string;
  serial: string;
  firmwareVersion: string;
  minFrequency: number;
  maxFrequency: number;
  minSampleRate: number;
  maxSampleRate: number;
  gainStages: GainStage[];
}

export interface SDRDevice {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setFrequency(hz: number): Promise<void>;
  setSampleRate(hz: number): Promise<void>;
  setGain(stage: string, value: number): Promise<void>;
  startRx(callback: (raw: Uint8Array) => void): Promise<void>;
  startTx(callback: () => Float32Array): Promise<void>;
  stop(): Promise<void>;
  getInfo(): DeviceInfo;
}

export type DemodMode = 'WFM' | 'NFM' | 'AM';

export type ColorMap = 'thermal' | 'grayscale' | 'green';

export interface RadioState {
  frequency: number;
  sampleRate: number;
  gains: Record<string, number>;
  demodMode: DemodMode;
  fftSize: number;
  squelchLevel: number;
  volume: number;
  ookEnabled: boolean;
  colorMap: ColorMap;
  waterfallSpeed: number;
}

export interface BitEvent {
  bit: 0 | 1;
  startSample: number;
  durationSamples: number;
  durationUs: number;
}

// Messages: Main thread -> DSP Worker
export type WorkerInMessage =
  | { type: 'iq'; data: Uint8Array }
  | { type: 'config'; frequency: number; sampleRate: number; demodMode: DemodMode; fftSize: number; squelchLevel: number; frequencyOffset: number; ookEnabled: boolean; channelBandwidth: number; audioEnabled: boolean };

// Messages: DSP Worker -> Main thread
export type WorkerOutMessage =
  | { type: 'fft'; bins: Float32Array }
  | { type: 'audio'; samples: Float32Array; squelchOpen: boolean }
  | { type: 'bits'; data: BitEvent[] }
  | { type: 'processed' };
