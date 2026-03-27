// src/dsp/worker.ts — Thin WASM wrapper with frame dropping
import type { DemodMode, WorkerInMessage, WorkerOutMessage, BitEvent } from '../devices/types';

let memory: WebAssembly.Memory;
let wasmReady = false;

interface WasmExports {
  wasm_init(sr: number, fft: number, mode: number, squelch: number, offset: number, ook: boolean, bw: number): void;
  wasm_update_config(sr: number, mode: number, fft: number, squelch: number, offset: number, ook: boolean, bw: number): void;
  wasm_process_iq(iq: Float32Array): void;
  wasm_get_fft_ptr(): number;
  wasm_get_fft_len(): number;
  wasm_get_audio_ptr(): number;
  wasm_get_audio_len(): number;
  wasm_get_bits_ptr(): number;
  wasm_get_bits_len(): number;
  wasm_get_squelch_open(): boolean;
}

let wasm: WasmExports;

function modeToU8(mode: DemodMode): number {
  switch (mode) {
    case 'WFM': return 0;
    case 'NFM': return 1;
    case 'AM':  return 2;
  }
}

function deserializeBitEvents(raw: Uint8Array): BitEvent[] {
  const events: BitEvent[] = [];
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i + 16 < raw.length; i += 17) {
    events.push({
      bit: raw[i]! as 0 | 1,
      startSample: view.getUint32(i + 1, true),
      durationSamples: view.getUint32(i + 5, true),
      durationUs: view.getFloat64(i + 9, true),
    });
  }
  return events;
}

async function startup() {
  const wasmModule = await import('../../dsp-wasm/pkg/dsp_wasm.js');
  const instance = await wasmModule.default();
  memory = instance.memory;
  wasm = wasmModule as unknown as WasmExports;
  wasm.wasm_init(2_000_000, 1024, 0, -60, 0, false, 200_000);
  wasmReady = true;
  scheduleProcess();
}

startup();

// --- Frame dropping: only process the latest IQ chunk ---
// When processing can't keep up, IQ messages queue up in the worker's
// message queue. We store the latest and process it on the next event loop
// turn via setTimeout(0). This ensures config/stop messages aren't blocked
// behind hundreds of stale IQ chunks.
let pendingIQ: Float32Array | null = null;
let processScheduled = false;

function scheduleProcess() {
  if (processScheduled) return;
  processScheduled = true;
  setTimeout(() => {
    processScheduled = false;
    if (pendingIQ && wasmReady) {
      const data = pendingIQ;
      pendingIQ = null;
      processIQ(data);
    }
    // Keep polling if there's data
    if (pendingIQ) scheduleProcess();
  }, 0);
}

function processIQ(data: Float32Array) {
  wasm.wasm_process_iq(data);

  const fftPtr = wasm.wasm_get_fft_ptr();
  const fftLen = wasm.wasm_get_fft_len();
  if (fftLen > 0) {
    const fftBins = new Float32Array(memory.buffer, fftPtr, fftLen).slice();
    const fftMsg: WorkerOutMessage = { type: 'fft', bins: fftBins };
    self.postMessage(fftMsg, { transfer: [fftBins.buffer] } as unknown as StructuredSerializeOptions);
  }

  const audioPtr = wasm.wasm_get_audio_ptr();
  const audioLen = wasm.wasm_get_audio_len();
  if (audioLen > 0) {
    const audioSamples = new Float32Array(memory.buffer, audioPtr, audioLen).slice();
    const squelchOpen = wasm.wasm_get_squelch_open();
    const audioMsg: WorkerOutMessage = { type: 'audio', samples: audioSamples, squelchOpen };
    self.postMessage(audioMsg, { transfer: [audioSamples.buffer] } as unknown as StructuredSerializeOptions);
  }

  const bitsLen = wasm.wasm_get_bits_len();
  if (bitsLen > 0) {
    const bitsPtr = wasm.wasm_get_bits_ptr();
    const bitsRaw = new Uint8Array(memory.buffer, bitsPtr, bitsLen).slice();
    const events = deserializeBitEvents(bitsRaw);
    const bitsMsg: WorkerOutMessage = { type: 'bits', data: events };
    self.postMessage(bitsMsg);
  }

  scheduleProcess();
}

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'config') {
    if (!wasmReady) return;
    wasm.wasm_update_config(
      msg.sampleRate, modeToU8(msg.demodMode), msg.fftSize,
      msg.squelchLevel, msg.frequencyOffset, msg.ookEnabled, msg.channelBandwidth,
    );
  }

  if (msg.type === 'iq') {
    // Store latest IQ data — previous unprocessed data is dropped
    pendingIQ = msg.data;
    scheduleProcess();
  }
};
