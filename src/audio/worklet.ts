// src/audio/worklet.ts
// @ts-nocheck
// Runs in AudioWorklet scope (module script) — AudioRing is a real import.
import { AudioRing } from './ring';

const RING_SIZE = 8192;
const LATENCY_CAP = 6144;   // if a burst pushes fill past this...
const LATENCY_TARGET = 2400; // ...trim back to ~50 ms

class SDRWorkletProcessor extends AudioWorkletProcessor {
  private ring = new AudioRing(RING_SIZE);
  private squelchOpen = true;
  private lastLevelPost = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'audio') {
        this.ring.write(msg.samples as Float32Array);
        if (this.ring.available() > LATENCY_CAP) this.ring.trimTo(LATENCY_TARGET);
        if (msg.squelchOpen !== undefined) {
          this.squelchOpen = msg.squelchOpen as boolean;
        }
      } else if (msg.type === 'flush') {
        this.ring.flush();
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (this.squelchOpen) {
      this.ring.read(output);
    } else {
      // Muted, but KEEP consuming at real-time rate — otherwise the ring
      // pins full and playback latency sticks at the high-water mark (F7).
      output.fill(0);
      this.ring.readInto(null, output.length);
    }

    // currentTime is an AudioWorkletGlobalScope global (seconds)
    if (currentTime - this.lastLevelPost > 0.25) {
      this.lastLevelPost = currentTime;
      this.port.postMessage({ type: 'bufferLevel', available: this.ring.available(), size: this.ring.size });
    }
    return true;
  }
}

registerProcessor('sdr-worklet', SDRWorkletProcessor);
