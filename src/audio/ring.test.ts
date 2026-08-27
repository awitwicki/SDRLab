import { describe, it, expect } from 'vitest';
import { AudioRing } from './ring';

describe('AudioRing', () => {
  it('write then read round-trips in order', () => {
    const r = new AudioRing(8);
    r.write(Float32Array.from([1, 2, 3]));
    const out = new Float32Array(3);
    r.read(out);
    expect([...out]).toEqual([1, 2, 3]);
    expect(r.available()).toBe(0);
  });

  it('read past available yields zeros for the missing tail', () => {
    const r = new AudioRing(8);
    r.write(Float32Array.from([5]));
    const out = new Float32Array(3);
    r.read(out);
    expect([...out]).toEqual([5, 0, 0]);
  });

  it('overwrites oldest on overflow, keeping the newest size-1 samples', () => {
    const r = new AudioRing(4); // capacity is size-1 = 3
    r.write(Float32Array.from([1, 2, 3, 4, 5]));
    expect(r.available()).toBe(3);
    const out = new Float32Array(3);
    r.read(out);
    expect([...out]).toEqual([3, 4, 5]);
  });

  it('flush empties the ring', () => {
    const r = new AudioRing(8);
    r.write(Float32Array.from([1, 2, 3]));
    r.flush();
    expect(r.available()).toBe(0);
  });

  it('trimTo drops oldest samples down to the target', () => {
    const r = new AudioRing(16);
    r.write(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    r.trimTo(3);
    expect(r.available()).toBe(3);
    const out = new Float32Array(3);
    r.read(out);
    expect([...out]).toEqual([6, 7, 8]);
  });

  it('readInto(null, n) discards n samples (squelched consumption)', () => {
    const r = new AudioRing(8);
    r.write(Float32Array.from([1, 2, 3, 4]));
    r.readInto(null, 2);
    expect(r.available()).toBe(2);
    const out = new Float32Array(2);
    r.read(out);
    expect([...out]).toEqual([3, 4]);
  });
});
