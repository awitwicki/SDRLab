// src/audio/worklet.ts
// @ts-nocheck
// This file runs in AudioWorklet scope where AudioWorkletProcessor and
// registerProcessor are globals not known to the TypeScript DOM lib.

class SDRWorkletProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array;
  private readPos = 0;
  private writePos = 0;
  private readonly bufferSize: number;
  private squelchOpen = true;

  constructor() {
    super();
    this.bufferSize = 8192;
    this.buffer = new Float32Array(this.bufferSize);

    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'audio') {
        this.enqueue(msg.samples as Float32Array);
        if (msg.squelchOpen !== undefined) {
          this.squelchOpen = msg.squelchOpen as boolean;
        }
      }
    };
  }

  private enqueue(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i]!;
      this.writePos = (this.writePos + 1) % this.bufferSize;
      if (this.writePos === this.readPos) {
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
    }
  }

  private available(): number {
    if (this.writePos >= this.readPos) {
      return this.writePos - this.readPos;
    }
    return this.bufferSize - this.readPos + this.writePos;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (!this.squelchOpen) {
      output.fill(0);
      return true;
    }

    for (let i = 0; i < output.length; i++) {
      if (this.available() > 0) {
        output[i] = this.buffer[this.readPos]!;
        this.readPos = (this.readPos + 1) % this.bufferSize;
      } else {
        output[i] = 0;
      }
    }

    this.port.postMessage({ type: 'bufferLevel', available: this.available(), size: this.bufferSize });
    return true;
  }
}

registerProcessor('sdr-worklet', SDRWorkletProcessor);
