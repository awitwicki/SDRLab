// Shared ring buffer for the audio worklet — kept as a plain module so vitest
// can exercise the exact code the worklet runs.
export class AudioRing {
  private buf: Float32Array;
  private readPos = 0;
  private writePos = 0;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.buf = new Float32Array(size);
  }

  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.writePos] = samples[i]!;
      this.writePos = (this.writePos + 1) % this.size;
      if (this.writePos === this.readPos) {
        this.readPos = (this.readPos + 1) % this.size; // overwrite oldest
      }
    }
  }

  available(): number {
    if (this.writePos >= this.readPos) return this.writePos - this.readPos;
    return this.size - this.readPos + this.writePos;
  }

  readInto(out: Float32Array | null, n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.available() > 0) {
        if (out) out[i] = this.buf[this.readPos]!;
        this.readPos = (this.readPos + 1) % this.size;
      } else if (out) {
        out[i] = 0;
      }
    }
  }

  read(out: Float32Array): void {
    this.readInto(out, out.length);
  }

  flush(): void {
    this.readPos = 0;
    this.writePos = 0;
  }

  trimTo(target: number): void {
    const excess = this.available() - target;
    if (excess > 0) this.readPos = (this.readPos + excess) % this.size;
  }
}
