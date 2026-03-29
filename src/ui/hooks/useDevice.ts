import { useState, useRef, useCallback } from 'react';
import { HackRF } from '../../devices/hackrf';
import type { SDRDevice, DeviceInfo } from '../../devices/types';

interface UseDeviceReturn {
  connected: boolean;
  running: boolean;
  deviceInfo: DeviceInfo | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  startRx: (callback: (raw: Uint8Array) => void) => Promise<void>;
  stop: () => Promise<void>;
  setFrequency: (hz: number) => Promise<void>;
  setSampleRate: (hz: number) => Promise<void>;
  setGain: (stage: string, value: number) => Promise<void>;
}

export function useDevice(): UseDeviceReturn {
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const deviceRef = useRef<SDRDevice | null>(null);

  const connect = useCallback(async () => {
    const device = new HackRF();
    await device.connect();
    deviceRef.current = device;
    setConnected(true);
    setDeviceInfo(device.getInfo());
  }, []);

  const disconnect = useCallback(async () => {
    if (deviceRef.current) {
      await deviceRef.current.disconnect();
      deviceRef.current = null;
    }
    setConnected(false);
    setRunning(false);
    setDeviceInfo(null);
  }, []);

  const startRx = useCallback(async (callback: (raw: Uint8Array) => void) => {
    if (!deviceRef.current) return;
    await deviceRef.current.startRx(callback);
    setRunning(true);
  }, []);

  const stop = useCallback(async () => {
    if (!deviceRef.current) return;
    await deviceRef.current.stop();
    setRunning(false);
  }, []);

  const setFrequency = useCallback(async (hz: number) => {
    if (!deviceRef.current) return;
    await deviceRef.current.setFrequency(hz);
  }, []);

  const setSampleRate = useCallback(async (hz: number) => {
    if (!deviceRef.current) return;
    await deviceRef.current.setSampleRate(hz);
  }, []);

  const setGain = useCallback(async (stage: string, value: number) => {
    if (!deviceRef.current) return;
    await deviceRef.current.setGain(stage, value);
  }, []);

  return { connected, running, deviceInfo, connect, disconnect, startRx, stop, setFrequency, setSampleRate, setGain };
}
