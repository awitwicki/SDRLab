import { useRef, useCallback, useEffect, useState } from 'react';
import type { DemodMode, WorkerInMessage, WorkerOutMessage, BitEvent } from '../../devices/types';

interface UseDSPOptions {
  /** Called directly from worker thread — bypasses React state for zero-latency audio. */
  onAudio?: (samples: Float32Array, squelchOpen: boolean) => void;
}

interface UseDSPReturn {
  fftData: Float32Array | null;
  bitEvents: BitEvent[];
  sendIQ: (data: Uint8Array) => void;
  updateConfig: (config: {
    frequency: number;
    sampleRate: number;
    demodMode: DemodMode;
    fftSize: number;
    squelchLevel: number;
    frequencyOffset: number;
    ookEnabled: boolean;
    channelBandwidth: number;
    audioEnabled: boolean;
  }) => void;
}

// Max IQ chunks in-flight to worker. Prevents unbounded queue buildup at high sample rates.
const MAX_IN_FLIGHT = 3;

export function useDSP(options: UseDSPOptions = {}): UseDSPReturn {
  const workerRef = useRef<Worker | null>(null);
  const [fftData, setFftData] = useState<Float32Array | null>(null);
  const [bitEvents, setBitEvents] = useState<BitEvent[]>([]);

  // Refs for hot-path data that shouldn't trigger re-renders
  const fftRef = useRef<Float32Array | null>(null);
  const rafRef = useRef(0);
  const inFlightRef = useRef(0);
  const onAudioRef = useRef(options.onAudio);
  onAudioRef.current = options.onAudio;

  useEffect(() => {
    const worker = new Worker(new URL('../../dsp/worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'fft':
          fftRef.current = msg.bins;
          if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(() => {
              setFftData(fftRef.current);
              rafRef.current = 0;
            });
          }
          break;
        case 'audio':
          onAudioRef.current?.(msg.samples, msg.squelchOpen);
          break;
        case 'bits':
          setBitEvents(prev => [...prev.slice(-100), ...msg.data]);
          break;
        case 'processed':
          // Backpressure: worker finished processing a chunk
          if (inFlightRef.current > 0) inFlightRef.current--;
          break;
      }
    };

    workerRef.current = worker;
    return () => {
      cancelAnimationFrame(rafRef.current);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const sendIQ = useCallback((data: Uint8Array) => {
    // Backpressure: drop IQ chunks when worker is behind (prevents minutes of lag at 20Msps)
    if (inFlightRef.current >= MAX_IN_FLIGHT) return;
    inFlightRef.current++;
    const msg: WorkerInMessage = { type: 'iq', data };
    workerRef.current?.postMessage(msg, { transfer: [data.buffer] } as unknown as StructuredSerializeOptions);
  }, []);

  const updateConfig = useCallback((config: {
    frequency: number;
    sampleRate: number;
    demodMode: DemodMode;
    fftSize: number;
    squelchLevel: number;
    frequencyOffset: number;
    ookEnabled: boolean;
    channelBandwidth: number;
    audioEnabled: boolean;
  }) => {
    const msg: WorkerInMessage = { type: 'config', ...config };
    workerRef.current?.postMessage(msg);
  }, []);

  return { fftData, bitEvents, sendIQ, updateConfig };
}
