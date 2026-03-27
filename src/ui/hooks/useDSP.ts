import { useRef, useCallback, useEffect, useState } from 'react';
import type { DemodMode, WorkerInMessage, WorkerOutMessage, BitEvent } from '../../devices/types';

interface UseDSPReturn {
  fftData: Float32Array | null;
  audioData: { samples: Float32Array; squelchOpen: boolean } | null;
  bitEvents: BitEvent[];
  sendIQ: (data: Float32Array) => void;
  updateConfig: (config: {
    frequency: number;
    sampleRate: number;
    demodMode: DemodMode;
    fftSize: number;
    squelchLevel: number;
    frequencyOffset: number;
    ookEnabled: boolean;
  }) => void;
}

export function useDSP(): UseDSPReturn {
  const workerRef = useRef<Worker | null>(null);
  const [fftData, setFftData] = useState<Float32Array | null>(null);
  const [audioData, setAudioData] = useState<{ samples: Float32Array; squelchOpen: boolean } | null>(null);
  const [bitEvents, setBitEvents] = useState<BitEvent[]>([]);

  useEffect(() => {
    const worker = new Worker(new URL('../../dsp/worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'fft':
          setFftData(msg.bins);
          break;
        case 'audio':
          setAudioData({ samples: msg.samples, squelchOpen: msg.squelchOpen });
          break;
        case 'bits':
          setBitEvents(prev => [...prev.slice(-100), ...msg.data]);
          break;
      }
    };

    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const sendIQ = useCallback((data: Float32Array) => {
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
  }) => {
    const msg: WorkerInMessage = { type: 'config', ...config };
    workerRef.current?.postMessage(msg);
  }, []);

  return { fftData, audioData, bitEvents, sendIQ, updateConfig };
}
