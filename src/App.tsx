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
import FrequencyAxis from './ui/components/FrequencyAxis';
import styles from './App.module.css';

const DEFAULT_FREQUENCY = 100_000_000;
const DEFAULT_SAMPLE_RATE = 2_000_000;

export default function App() {
  const device = useDevice();
  const audio = useAudio();
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const dsp = useDSP({
    onAudio: (samples, squelchOpen) => audioRef.current.pushAudio(samples, squelchOpen),
  });

  const [frequency, setFrequency] = useState(DEFAULT_FREQUENCY);
  const [sampleRate, setSampleRate] = useState(DEFAULT_SAMPLE_RATE);
  const [tuningOffset, setTuningOffset] = useState(0);
  const [demodMode, setDemodMode] = useState<DemodMode>('WFM');
  const [gains, setGains] = useState<Record<string, number>>({ amp: 0, lna: 16, vga: 20 });
  const [squelchLevel, setSquelchLevel] = useState(-60);
  const [fftSize, setFftSize] = useState(1024);
  const [channelBandwidth, setChannelBandwidth] = useState(200_000);
  const [colorMap, setColorMap] = useState<ColorMap>('thermal');
  const [waterfallSpeed, setWaterfallSpeed] = useState(1);
  const [displayOffset, setDisplayOffset] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [ookEnabled, setOokEnabled] = useState(false);
  const [usbRate, setUsbRate] = useState(0);

  const usbBytesRef = useRef(0);
  const usbTimerRef = useRef<ReturnType<typeof setInterval>>();
  const freqDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    usbTimerRef.current = setInterval(() => {
      setUsbRate(usbBytesRef.current);
      usbBytesRef.current = 0;
    }, 1000);
    return () => clearInterval(usbTimerRef.current);
  }, []);

  useEffect(() => {
    dsp.updateConfig({
      frequency,
      sampleRate,
      demodMode,
      fftSize,
      squelchLevel,
      frequencyOffset: tuningOffset,
      ookEnabled,
      channelBandwidth,
    });
  }, [frequency, sampleRate, demodMode, fftSize, squelchLevel, tuningOffset, ookEnabled, channelBandwidth, dsp]);

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
      await device.setFrequency(frequency);
      await device.setSampleRate(sampleRate);
      for (const [stage, value] of Object.entries(gains)) {
        await device.setGain(stage, value);
      }
      await device.startRx((iq: Float32Array) => {
        usbBytesRef.current += iq.byteLength;
        dsp.sendIQ(iq);
      });
    } catch (err) {
      console.error('[Start] Failed:', err);
    }
  }, [device, dsp, frequency, sampleRate, gains]);

  const handleStop = useCallback(async () => {
    await device.stop();
  }, [device]);

  // Debounced USB frequency sync — prevents flooding USB during drag
  const syncFreqToDevice = useCallback((hz: number) => {
    clearTimeout(freqDebounceRef.current);
    freqDebounceRef.current = setTimeout(() => {
      if (device.running) {
        device.setFrequency(hz);
      }
    }, 150);
  }, [device]);

  const handleFrequencyChange = useCallback((hz: number) => {
    setFrequency(hz);
    setTuningOffset(0);
    syncFreqToDevice(hz);
  }, [syncFreqToDevice]);

  const handleTuningOffsetChange = useCallback((offset: number) => {
    const clamped = Math.max(-sampleRate / 2, Math.min(sampleRate / 2, offset));
    setTuningOffset(clamped);
  }, [sampleRate]);

  const handleCenterFrequencyPan = useCallback((hz: number) => {
    const rounded = Math.round(hz / 1000) * 1000;
    setFrequency(rounded);
    syncFreqToDevice(rounded);
  }, [syncFreqToDevice]);

  const handleSampleRateChange = useCallback(async (hz: number) => {
    setSampleRate(hz);
    setTuningOffset(prev => Math.max(-hz / 2, Math.min(hz / 2, prev)));
    if (device.running) {
      await device.setSampleRate(hz);
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

  return (
    <div className={styles.app}>
      <div className={styles.topBar}>
        <TopBar
          connected={device.connected}
          running={device.running}
          frequency={frequency}
          tuningOffset={tuningOffset}
          sampleRate={sampleRate}
          demodMode={demodMode}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onStart={handleStart}
          onStop={handleStop}
          onFrequencyChange={handleFrequencyChange}
          onDemodModeChange={setDemodMode}
          onSampleRateChange={handleSampleRateChange}
        />
      </div>

      <div className={styles.main}>
        <div className={styles.spectrum}>
          <SpectrumView
            fftData={dsp.fftData}
            frequency={frequency}
            sampleRate={sampleRate}
            tuningOffset={tuningOffset}
            demodMode={demodMode}
            displayOffset={displayOffset}
            onTuningOffsetChange={handleTuningOffsetChange}
            onCenterFrequencyPan={handleCenterFrequencyPan}
          />
        </div>
        <div className={styles.freqAxis}>
          <FrequencyAxis
            centerFrequency={frequency}
            sampleRate={sampleRate}
          />
        </div>
        <div className={styles.waterfall}>
          <WaterfallView
            fftData={dsp.fftData}
            frequency={frequency}
            sampleRate={sampleRate}
            colorMap={colorMap}
            tuningOffset={tuningOffset}
            demodMode={demodMode}
            displayOffset={displayOffset}
            waterfallSpeed={waterfallSpeed}
            onTuningOffsetChange={handleTuningOffsetChange}
            onCenterFrequencyPan={handleCenterFrequencyPan}
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
              channelBandwidth={channelBandwidth}
              recording={audio.recording}
              onVolumeChange={audio.setVolume}
              onSquelchChange={setSquelchLevel}
              onBandwidthChange={setChannelBandwidth}
              onRecordToggle={handleRecordToggle}
            />
          </AccordionSection>
          <AccordionSection title="Display">
            <DisplaySettings
              fftSize={fftSize}
              colorMap={colorMap}
              waterfallSpeed={waterfallSpeed}
              displayOffset={displayOffset}
              onFftSizeChange={setFftSize}
              onColorMapChange={setColorMap}
              onWaterfallSpeedChange={setWaterfallSpeed}
              onDisplayOffsetChange={setDisplayOffset}
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
          frequency={frequency}
          tuningOffset={tuningOffset}
          bufferLevel={audio.bufferLevel}
          bufferSize={audio.bufferSize}
          usbRate={usbRate}
        />
      </div>
    </div>
  );
}
