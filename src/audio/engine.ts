// src/audio/engine.ts
export interface AudioEngineState {
  volume: number;
  bufferLevel: number;
  bufferSize: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private _volume = 0.5;
  private _bufferLevel = 0;
  private _bufferSize = 0;
  private onBufferUpdate: ((level: number, size: number) => void) | null = null;

  async init(): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: 48000 });

    const workletUrl = new URL('./worklet.ts', import.meta.url);
    await this.ctx.audioWorklet.addModule(workletUrl);

    this.workletNode = new AudioWorkletNode(this.ctx, 'sdr-worklet');
    this.gainNode = this.ctx.createGain();
    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 256;

    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.ctx.destination);

    this.gainNode.gain.value = this._volume;

    this.workletNode.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'bufferLevel') {
        this._bufferLevel = event.data.available as number;
        this._bufferSize = event.data.size as number;
        this.onBufferUpdate?.(this._bufferLevel, this._bufferSize);
      }
    };
  }

  pushAudio(samples: Float32Array, squelchOpen: boolean): void {
    this.workletNode?.port.postMessage({ type: 'audio', samples, squelchOpen });
  }

  setVolume(value: number): void {
    this._volume = Math.max(0, Math.min(1, value));
    if (this.gainNode) {
      this.gainNode.gain.value = this._volume;
    }
  }

  getVolume(): number {
    return this._volume;
  }

  setBufferCallback(cb: (level: number, size: number) => void): void {
    this.onBufferUpdate = cb;
  }

  async resume(): Promise<void> {
    if (this.ctx?.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  async destroy(): Promise<void> {
    this.workletNode?.disconnect();
    this.gainNode?.disconnect();
    this.analyserNode?.disconnect();
    await this.ctx?.close();
    this.ctx = null;
    this.workletNode = null;
    this.gainNode = null;
    this.analyserNode = null;
  }

  getState(): AudioEngineState {
    return {
      volume: this._volume,
      bufferLevel: this._bufferLevel,
      bufferSize: this._bufferSize,
    };
  }
}
