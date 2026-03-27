// src/audio/recorder.test.ts
import { describe, it, expect } from 'vitest';
import { encodeWAV } from './recorder';

describe('encodeWAV', () => {
  it('creates valid WAV header', () => {
    const samples = new Float32Array([0, 0.5, 1, -1, -0.5, 0]);
    const buffer = encodeWAV(samples, 48000);
    const view = new DataView(buffer);

    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
    expect(String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15))).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(96000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39))).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('encodes sample values correctly', () => {
    const samples = new Float32Array([0, 1.0, -1.0]);
    const buffer = encodeWAV(samples, 48000);
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it('clamps values beyond -1..1', () => {
    const samples = new Float32Array([2.0, -3.0]);
    const buffer = encodeWAV(samples, 48000);
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it('returns correct total size', () => {
    const samples = new Float32Array(100);
    const buffer = encodeWAV(samples, 48000);
    expect(buffer.byteLength).toBe(44 + 100 * 2);
  });
});
