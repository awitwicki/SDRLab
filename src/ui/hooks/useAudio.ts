import { useRef, useCallback, useEffect, useState } from 'react';
import { AudioEngine } from '../../audio/engine';
import { AudioRecorder } from '../../audio/recorder';

interface UseAudioReturn {
  initialized: boolean;
  volume: number;
  recording: boolean;
  bufferLevel: number;
  bufferSize: number;
  init: () => Promise<void>;
  setVolume: (v: number) => void;
  pushAudio: (samples: Float32Array, squelchOpen: boolean) => void;
  startRecording: () => void;
  stopRecording: () => void;
  destroy: () => Promise<void>;
}

export function useAudio(): UseAudioReturn {
  const engineRef = useRef<AudioEngine | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [volume, setVolumeState] = useState(0.5);
  const [recording, setRecording] = useState(false);
  const [bufferLevel, setBufferLevel] = useState(0);
  const [bufferSize, setBufferSize] = useState(0);

  useEffect(() => {
    return () => {
      engineRef.current?.destroy();
    };
  }, []);

  const init = useCallback(async () => {
    if (engineRef.current) return;
    const engine = new AudioEngine();
    await engine.init();
    engine.setBufferCallback((level, size) => {
      setBufferLevel(level);
      setBufferSize(size);
    });
    engineRef.current = engine;
    recorderRef.current = new AudioRecorder();
    setInitialized(true);
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    engineRef.current?.setVolume(v);
  }, []);

  const pushAudio = useCallback((samples: Float32Array, squelchOpen: boolean) => {
    engineRef.current?.pushAudio(samples, squelchOpen);
    if (recorderRef.current?.recording) {
      recorderRef.current.push(samples);
    }
  }, []);

  const startRecording = useCallback(() => {
    recorderRef.current?.start();
    setRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  const destroy = useCallback(async () => {
    await engineRef.current?.destroy();
    engineRef.current = null;
    setInitialized(false);
  }, []);

  return { initialized, volume, recording, bufferLevel, bufferSize, init, setVolume, pushAudio, startRecording, stopRecording, destroy };
}
