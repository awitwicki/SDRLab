import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './engine';

// Chrome on Android starts an AudioContext suspended whenever it is built
// outside a user gesture, and it stays silent until something resumes it.
class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}
class FakeGain extends FakeNode { gain = { value: 0 }; }
class FakeAnalyser extends FakeNode { fftSize = 0; }
class FakeWorkletNode extends FakeNode {
  port = { onmessage: null as unknown, postMessage: vi.fn() };
}

class FakeAudioContext {
  static last: FakeAudioContext;
  /** What the browser hands back: suspended without a gesture, running with. */
  static initialState: AudioContextState = 'suspended';
  state: AudioContextState = FakeAudioContext.initialState;
  destination = new FakeNode();
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn().mockResolvedValue(undefined);
  createGain = vi.fn(() => new FakeGain());
  createAnalyser = vi.fn(() => new FakeAnalyser());
  constructor() { FakeAudioContext.last = this; }
}

beforeEach(() => {
  FakeAudioContext.initialState = 'suspended';
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});

afterEach(() => vi.unstubAllGlobals());

describe('AudioEngine', () => {
  it('resumes a context the browser started suspended', async () => {
    const engine = new AudioEngine();
    await engine.init();
    expect(FakeAudioContext.last.resume).toHaveBeenCalled();
    expect(FakeAudioContext.last.state).toBe('running');
  });

  it('does not resume a context that is already running', async () => {
    FakeAudioContext.initialState = 'running';
    const engine = new AudioEngine();
    await engine.init();
    expect(FakeAudioContext.last.resume).not.toHaveBeenCalled();
  });

  it('reports whether it is currently suspended', async () => {
    const engine = new AudioEngine();
    await engine.init();
    expect(engine.suspended).toBe(false);
    FakeAudioContext.last.state = 'suspended';
    expect(engine.suspended).toBe(true);
  });

  it('resumes on demand, for calling from a later user gesture', async () => {
    const engine = new AudioEngine();
    await engine.init();
    FakeAudioContext.last.state = 'suspended';
    FakeAudioContext.last.resume.mockClear();
    await engine.resume();
    expect(FakeAudioContext.last.resume).toHaveBeenCalledTimes(1);
  });

  it('survives a rejected resume without throwing', async () => {
    const engine = new AudioEngine();
    await engine.init();
    FakeAudioContext.last.state = 'suspended';
    FakeAudioContext.last.resume.mockRejectedValueOnce(new Error('no activation'));
    await expect(engine.resume()).resolves.toBeUndefined();
  });
});
