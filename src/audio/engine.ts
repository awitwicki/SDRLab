// src/audio/engine.ts
// Bundled as a standalone ES module: a bare `new URL('./worklet.ts', ...)`
// makes Vite inline the untranspiled TypeScript as a data: URL typed
// video/mp2t, which addModule rejects, leaving production builds silent.
import workletUrl from './worklet.ts?worker&url';
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

    // Built outside a user gesture (device.connect() consumes the click's
    // activation) the context arrives suspended and stays silent. Desktop
    // Chrome usually waives this via its media engagement score; Android does
    // not. Resuming here covers the case where activation is still valid --
    // otherwise a later gesture has to call resume().
    await this.resume();
  }

  pushAudio(samples: Float32Array, squelchOpen: boolean): void {
    this.workletNode?.port.postMessage({ type: 'audio', samples, squelchOpen });
  }

  flush(): void {
    this.workletNode?.port.postMessage({ type: 'flush' });
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

  /** True when the browser is holding the context silent, pending a gesture. */
  get suspended(): boolean {
    return this.ctx?.state === 'suspended';
  }

  async resume(): Promise<void> {
    if (this.ctx?.state !== 'suspended') return;
    try {
      await this.ctx.resume();
    } catch {
      // Rejected when there is no user activation to spend. Not fatal: the
      // next gesture gets another attempt.
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
