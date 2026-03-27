import { useState, useCallback, useEffect, useRef } from 'react';
import type { DemodMode, ColorMap } from './devices/types';
import { useDevice } from './ui/hooks/useDevice';
import { useDSP } from './ui/hooks/useDSP';
import { useAudio } from './ui/hooks/useAudio';
import TopBar from './ui/components/TopBar';
import SpectrumView from './ui/components/SpectrumView';
import WaterfallView from './ui/components/WaterfallView';
import ControlPanel, { AccordionSection } from './ui/components/ControlPanel';
import GainControls from './ui/components/GainControls';
import AudioControls from './ui/components/AudioControls';
import DisplaySettings from './ui/components/DisplaySettings';
import DigitalDecoder from './ui/components/DigitalDecoder';
import StatusBar from './ui/components/StatusBar';
import styles from './App.module.css';

const DEFAULT_FREQUENCY = 100_000_000;
const DEFAULT_SAMPLE_RATE = 2_000_000;

export default function App() {
  const device = useDevice();
  const dsp = useDSP();
  const audio = useAudio();

  const [frequency, setFrequency] = useState(DEFAULT_FREQUENCY);
  const [sampleRate] = useState(DEFAULT_SAMPLE_RATE);
  const [demodMode, setDemodMode] = useState<DemodMode>('WFM');
  const [gains, setGains] = useState<Record<string, number>>({ amp: 0, lna: 16, vga: 20 });
  const [squelchLevel, setSquelchLevel] = useState(-60);
  const [fftSize, setFftSize] = useState(1024);
  const [colorMap, setColorMap] = useState<ColorMap>('thermal');
  const [waterfallSpeed, setWaterfallSpeed] = useState(1);
  const [panelOpen, setPanelOpen] = useState(true);
  const [ookEnabled, setOokEnabled] = useState(false);
  const [usbRate, setUsbRate] = useState(0);

  const usbBytesRef = useRef(0);
  const usbTimerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    usbTimerRef.current = setInterval(() => {
      setUsbRate(usbBytesRef.current);
      usbBytesRef.current = 0;
    }, 1000);
    return () => clearInterval(usbTimerRef.current);
  }, []);

  useEffect(() => {
    if (dsp.audioData) {
      audio.pushAudio(dsp.audioData.samples, dsp.audioData.squelchOpen);
    }
  }, [dsp.audioData, audio]);

  useEffect(() => {
    dsp.updateConfig({
      frequency,
      sampleRate,
      demodMode,
      fftSize,
      squelchLevel,
      frequencyOffset: 0,
      ookEnabled,
    });
  }, [frequency, sampleRate, demodMode, fftSize, squelchLevel, ookEnabled, dsp]);

  const handleConnect = useCallback(async () => {
    try {
      await device.connect();
      await audio.init();
    } catch (err) {
      console.error('Connect failed:', err);
    }
  }, [device, audio]);

  const handleDisconnect = useCallback(async () => {
    await device.stop();
    await device.disconnect();
    await audio.destroy();
  }, [device, audio]);

  const handleStart = useCallback(async () => {
    try {
      console.log('[Start] setFrequency', frequency);
      await device.setFrequency(frequency);
      console.log('[Start] setSampleRate', sampleRate);
      await device.setSampleRate(sampleRate);
      for (const [stage, value] of Object.entries(gains)) {
        console.log('[Start] setGain', stage, value);
        await device.setGain(stage, value);
      }
      console.log('[Start] startRx');
      await device.startRx((iq: Float32Array) => {
        usbBytesRef.current += iq.byteLength;
        dsp.sendIQ(iq);
      });
      console.log('[Start] streaming');
    } catch (err) {
      console.error('[Start] Failed:', err);
    }
  }, [device, dsp, frequency, sampleRate, gains]);

  const handleStop = useCallback(async () => {
    await device.stop();
  }, [device]);

  const handleFrequencyChange = useCallback(async (hz: number) => {
    setFrequency(hz);
    if (device.running) {
      await device.setFrequency(hz);
    }
  }, [device]);

  const handleGainChange = useCallback(async (stage: string, value: number) => {
    setGains(prev => ({ ...prev, [stage]: value }));
    if (device.running) {
      await device.setGain(stage, value);
    }
  }, [device]);

  const handleRecordToggle = useCallback(() => {
    if (audio.recording) {
      audio.stopRecording();
    } else {
      audio.startRecording();
    }
  }, [audio]);

  const handleTune = useCallback((hz: number) => {
    handleFrequencyChange(hz);
  }, [handleFrequencyChange]);

  return (
    <div className={styles.app}>
      <div className={styles.topBar}>
        <TopBar
          connected={device.connected}
          running={device.running}
          frequency={frequency}
          demodMode={demodMode}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onStart={handleStart}
          onStop={handleStop}
          onFrequencyChange={handleFrequencyChange}
          onDemodModeChange={setDemodMode}
        />
      </div>

      <div className={styles.main}>
        <div className={styles.spectrum}>
          <SpectrumView
            fftData={dsp.fftData}
            frequency={frequency}
            sampleRate={sampleRate}
            onTune={handleTune}
          />
        </div>
        <div className={styles.waterfall}>
          <WaterfallView
            fftData={dsp.fftData}
            frequency={frequency}
            sampleRate={sampleRate}
            colorMap={colorMap}
            onTune={handleTune}
          />
        </div>
        {ookEnabled && (
          <div className={styles.decoder}>
            <DigitalDecoder
              bits={dsp.bitEvents}
              enabled={ookEnabled}
              onToggle={() => setOokEnabled(false)}
            />
          </div>
        )}
      </div>

      <div className={panelOpen ? styles.panel : styles.panelCollapsed}>
        <ControlPanel open={panelOpen} onToggle={() => setPanelOpen(!panelOpen)}>
          <AccordionSection title="Gain">
            <GainControls gains={gains} onGainChange={handleGainChange} />
          </AccordionSection>
          <AccordionSection title="Audio">
            <AudioControls
              volume={audio.volume}
              squelchLevel={squelchLevel}
              recording={audio.recording}
              onVolumeChange={audio.setVolume}
              onSquelchChange={setSquelchLevel}
              onRecordToggle={handleRecordToggle}
            />
          </AccordionSection>
          <AccordionSection title="Display">
            <DisplaySettings
              fftSize={fftSize}
              colorMap={colorMap}
              waterfallSpeed={waterfallSpeed}
              onFftSizeChange={setFftSize}
              onColorMapChange={setColorMap}
              onWaterfallSpeedChange={setWaterfallSpeed}
            />
          </AccordionSection>
          <AccordionSection title="Digital" defaultOpen={false}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <label>
                <input
                  type="checkbox"
                  checked={ookEnabled}
                  onChange={e => setOokEnabled(e.target.checked)}
                />
                {' '}Enable OOK Decoder
              </label>
            </div>
          </AccordionSection>
        </ControlPanel>
      </div>

      <div className={styles.statusBar}>
        <StatusBar
          sampleRate={sampleRate}
          bufferLevel={audio.bufferLevel}
          bufferSize={audio.bufferSize}
          usbRate={usbRate}
        />
      </div>
    </div>
  );
}
