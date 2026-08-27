// src/dsp/worker.ts — Thin WASM wrapper
// Processes EVERY IQ chunk for continuous audio. Throttles FFT display to ~30fps.
import type { DemodMode, WorkerInMessage, WorkerOutMessage, BitEvent } from '../devices/types';

let memory: WebAssembly.Memory;
let wasmReady = false;

interface WasmExports {
  wasm_init(sr: number, fft: number, mode: number, squelch: number, offset: number, ook: boolean, bw: number, audioEnabled: boolean): void;
  wasm_update_config(sr: number, mode: number, fft: number, squelch: number, offset: number, ook: boolean, bw: number, audioEnabled: boolean): void;
  wasm_process_iq_raw(raw: Uint8Array, computeFft: boolean): void;
  wasm_get_fft_ptr(): number;
  wasm_get_fft_len(): number;
  wasm_get_audio_ptr(): number;
  wasm_get_audio_len(): number;
  wasm_get_bits_ptr(): number;
  wasm_get_bits_len(): number;
  wasm_get_squelch_open(): boolean;
  wasm_get_rds_version(): number;
  wasm_get_rds_pi(): number;
  wasm_get_rds_ps_ptr(): number;
  wasm_get_rds_ps_len(): number;
  wasm_get_rds_rt_ptr(): number;
  wasm_get_rds_rt_len(): number;
  wasm_reset_rds(): void;
}

let wasm: WasmExports;
let lastRdsVersion = 0;
// Tracks the tuned centre frequency, the tuning-within-capture-window
// offset, and the demod mode across 'config' messages so a change on ANY
// of the three can clear stale RDS state (see applyConfig below). All null
// until the first config is actually applied, so startup never fires a
// spurious reset.
let lastFrequency: number | null = null;
let lastFrequencyOffset: number | null = null;
let lastDemodMode: DemodMode | null = null;

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

type ConfigMessage = Extract<WorkerInMessage, { type: 'config' }>;
let pendingConfig: ConfigMessage | null = null;

function applyConfig(msg: ConfigMessage): void {
  // wasm_update_config's Rust signature has no absolute-frequency parameter
  // — only frequencyOffset, the tuning-within-capture-window offset — so a
  // plain retune (same demod mode, sample rate and bandwidth, the common
  // "change station" case) never reaches DspState::update_config's
  // mode/sample-rate/bandwidth-changed checks and therefore never resets
  // anything on its own. That's true on EITHER tuning axis: panning the
  // capture's absolute centre (`frequency`, e.g. dragging the spectrum) or
  // moving within the current capture window (`frequencyOffset`, e.g.
  // click-tuning to a different signal without moving the device) can each
  // land on a different station's RDS. Reset on either changing — no
  // threshold/debounce on frequencyOffset: the frequency-pan path already
  // resets on every pixel-delta of a drag with no gating (onCenterFrequencyPan
  // fires continuously on mousemove), so gating only the offset path would
  // make the two axes inconsistent rather than protect a lock — reset_rds
  // doesn't touch the front-end's Costas loop/timing recovery anyway, only
  // the block decoder, so there's no lock for a frequent reset to thrash;
  // the cost is just re-syncing one ~100ms group plus PS reassembly.
  // Also reset on a demod-mode change: switching WFM -> NFM/AM makes the RDS
  // front-end go idle (rebuild_filters/configure), so its version counter
  // never changes again and the version-diff check below would never fire —
  // without this, the previous station's PS/RT would stay on screen for the
  // rest of the NFM/AM session instead of just until the next chunk.
  // Deliberately does NOT touch lastRdsVersion here: wasm_reset_rds() drops
  // the block decoder's version back to 0, and the next 'iq' chunk's
  // existing version-diff check (lastRdsVersion was some prior nonzero
  // value) will see that drop, post the now-empty rds message, and update
  // lastRdsVersion itself — which is what actually clears the UI's stale
  // station name. Pre-syncing lastRdsVersion to 0 here would suppress that
  // post entirely and leave the stale name on screen, reintroducing the bug.
  const retuned =
    (lastFrequency !== null && msg.frequency !== lastFrequency) ||
    (lastFrequencyOffset !== null && msg.frequencyOffset !== lastFrequencyOffset) ||
    (lastDemodMode !== null && msg.demodMode !== lastDemodMode);
  if (retuned) {
    wasm.wasm_reset_rds();
  }
  lastFrequency = msg.frequency;
  lastFrequencyOffset = msg.frequencyOffset;
  lastDemodMode = msg.demodMode;

  wasm.wasm_update_config(
    msg.sampleRate, modeToU8(msg.demodMode), msg.fftSize,
    msg.squelchLevel, msg.frequencyOffset, msg.ookEnabled, msg.channelBandwidth,
    msg.audioEnabled,
  );
}

async function startup() {
  const wasmModule = await import('../../dsp-wasm/pkg/dsp_wasm.js');
  const instance = await wasmModule.default();
  memory = instance.memory;
  wasm = wasmModule as unknown as WasmExports;
  wasm.wasm_init(2_000_000, 1024, 0, -60, 0, false, 200_000, true);
  wasmReady = true;
  if (pendingConfig) { applyConfig(pendingConfig); pendingConfig = null; }
}

startup();

// FFT throttle: send at most ~30fps
let lastFftTime = 0;
const FFT_INTERVAL_MS = 33;

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'config') {
    if (!wasmReady) { pendingConfig = msg; return; }
    applyConfig(msg);
  }

  if (msg.type === 'iq') {
    try {
      if (wasmReady) {
        const now = performance.now();
        const wantFft = now - lastFftTime >= FFT_INTERVAL_MS;
        wasm.wasm_process_iq_raw(msg.data, wantFft);

        const audioPtr = wasm.wasm_get_audio_ptr();
        const audioLen = wasm.wasm_get_audio_len();
        if (audioLen > 0) {
          const audioSamples = new Float32Array(memory.buffer, audioPtr, audioLen).slice();
          const squelchOpen = wasm.wasm_get_squelch_open();
          const audioMsg: WorkerOutMessage = { type: 'audio', samples: audioSamples, squelchOpen };
          self.postMessage(audioMsg, { transfer: [audioSamples.buffer] } as unknown as StructuredSerializeOptions);
        }

        if (wantFft) {
          lastFftTime = now;
          const fftPtr = wasm.wasm_get_fft_ptr();
          const fftLen = wasm.wasm_get_fft_len();
          if (fftLen > 0) {
            const fftBins = new Float32Array(memory.buffer, fftPtr, fftLen).slice();
            const fftMsg: WorkerOutMessage = { type: 'fft', bins: fftBins };
            self.postMessage(fftMsg, { transfer: [fftBins.buffer] } as unknown as StructuredSerializeOptions);
          }
        }

        const bitsLen = wasm.wasm_get_bits_len();
        if (bitsLen > 0) {
          const bitsPtr = wasm.wasm_get_bits_ptr();
          const bitsRaw = new Uint8Array(memory.buffer, bitsPtr, bitsLen).slice();
          const bitsMsg: WorkerOutMessage = { type: 'bits', data: deserializeBitEvents(bitsRaw) };
          self.postMessage(bitsMsg);
        }

        const rdsV = wasm.wasm_get_rds_version();
        if (rdsV !== lastRdsVersion) {
          lastRdsVersion = rdsV;
          const ps = new Uint8Array(memory.buffer, wasm.wasm_get_rds_ps_ptr(), wasm.wasm_get_rds_ps_len());
          const rt = new Uint8Array(memory.buffer, wasm.wasm_get_rds_rt_ptr(), wasm.wasm_get_rds_rt_len());
          const dec = (b: Uint8Array) => String.fromCharCode(...b).replace(/[\x00-\x1F]/g, ' ').trimEnd();
          self.postMessage({ type: 'rds', pi: wasm.wasm_get_rds_pi(), ps: dec(ps), rt: dec(rt) } as WorkerOutMessage);
        }
      }
    } finally {
      // Backpressure ack — MUST fire exactly once per 'iq', even if WASM traps.
      self.postMessage({ type: 'processed' } as WorkerOutMessage);
    }
  }
};
