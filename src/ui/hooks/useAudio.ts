import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { AudioEngine } from '../../audio/engine';
import { AudioRecorder } from '../../audio/recorder';

interface UseAudioReturn {
  initialized: boolean;
  volume: number;
  recording: boolean;
  bufferLevel: number;
  bufferSize: number;
  init: () => Promise<void>;
  resume: () => Promise<void>;
  setVolume: (v: number) => void;
  pushAudio: (samples: Float32Array, squelchOpen: boolean) => void;
  startRecording: () => void;
  stopRecording: () => void;
  destroy: () => Promise<void>;
  flush: () => void;
}

export function useAudio(): UseAudioReturn {
  const engineRef = useRef<AudioEngine | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [volume, setVolumeState] = useState(0.5);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
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
    engine.setVolume(volumeRef.current);
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

  const flush = useCallback(() => {
    engineRef.current?.flush();
  }, []);

  // Called from user gestures: a context the browser suspended for lack of
  // activation can only be revived from inside one.
  const resume = useCallback(async () => {
    await engineRef.current?.resume();
  }, []);

  return useMemo(() => ({
    initialized, volume, recording, bufferLevel, bufferSize, init, resume, setVolume, pushAudio, startRecording, stopRecording, destroy, flush,
  }), [initialized, volume, recording, bufferLevel, bufferSize, init, resume, setVolume, pushAudio, startRecording, stopRecording, destroy, flush]);
}
