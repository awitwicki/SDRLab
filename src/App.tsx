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
const STORAGE_KEY = 'sdrlab-settings';

interface SavedSettings {
  frequency: number;
  sampleRate: number;
  demodMode: DemodMode;
  gains: Record<string, number>;
  squelchLevel: number;
  fftSize: number;
  channelBandwidth: number;
  colorMap: ColorMap;
  waterfallSpeed: number;
  displayOffset: number;
  fftSmoothing: number;
  panelOpen: boolean;
  audioEnabled: boolean;
  waterfallEnabled: boolean;
}

function loadSettings(): Partial<SavedSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Partial<SavedSettings>;
  } catch { /* ignore corrupt data */ }
  return {};
}

function saveSettings(s: SavedSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota exceeded */ }
}

export default function App() {
  const device = useDevice();
  const audio = useAudio();
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const dsp = useDSP({
    onAudio: (samples, squelchOpen) => audioRef.current.pushAudio(samples, squelchOpen),
  });

  const saved = useRef(loadSettings()).current;
  const [frequency, setFrequency] = useState(saved.frequency ?? DEFAULT_FREQUENCY);
  const [sampleRate, setSampleRate] = useState(saved.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const [tuningOffset, setTuningOffset] = useState(0);
  const [demodMode, setDemodMode] = useState<DemodMode>(saved.demodMode ?? 'WFM');
  const [gains, setGains] = useState<Record<string, number>>(saved.gains ?? { amp: 0, lna: 0, vga: 0 });
  const [squelchLevel, setSquelchLevel] = useState(saved.squelchLevel ?? -60);
  const [fftSize, setFftSize] = useState(saved.fftSize ?? 1024);
  const [channelBandwidth, setChannelBandwidth] = useState(saved.channelBandwidth ?? 200_000);
  const [colorMap, setColorMap] = useState<ColorMap>(saved.colorMap ?? 'thermal');
  const [waterfallSpeed, setWaterfallSpeed] = useState(saved.waterfallSpeed ?? 1);
  const [displayOffset, setDisplayOffset] = useState(saved.displayOffset ?? 0);
  const [fftSmoothing, setFftSmoothing] = useState(saved.fftSmoothing ?? 50);
  const [panelOpen, setPanelOpen] = useState(saved.panelOpen ?? true);
  const [audioEnabled, setAudioEnabled] = useState(saved.audioEnabled ?? true);
  const [waterfallEnabled, setWaterfallEnabled] = useState(saved.waterfallEnabled ?? true);
  const [ookEnabled, setOokEnabled] = useState(false);
  const [usbRate, setUsbRate] = useState(0);

  // Persist settings to localStorage (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      saveSettings({
        frequency, sampleRate, demodMode, gains, squelchLevel, fftSize,
        channelBandwidth, colorMap, waterfallSpeed, displayOffset, fftSmoothing, panelOpen,
        audioEnabled, waterfallEnabled,
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [frequency, sampleRate, demodMode, gains, squelchLevel, fftSize,
      channelBandwidth, colorMap, waterfallSpeed, displayOffset, fftSmoothing, panelOpen,
      audioEnabled, waterfallEnabled]);

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
      audioEnabled,
    });
  }, [frequency, sampleRate, demodMode, fftSize, squelchLevel, tuningOffset, ookEnabled, channelBandwidth, audioEnabled, dsp]);

  const handleConnect = useCallback(async () => {
    try {
      await device.connect();
      if (audioEnabled) await audio.init();
    } catch (err) {
      console.error('Connect failed:', err);
    }
  }, [device, audio, audioEnabled]);

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
      await device.startRx((raw: Uint8Array) => {
        usbBytesRef.current += raw.byteLength;
        dsp.sendIQ(raw);
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
        <div className={waterfallEnabled ? styles.spectrum : styles.spectrumExpanded}>
          <SpectrumView
            fftData={dsp.fftData}
            frequency={frequency}
            sampleRate={sampleRate}
            tuningOffset={tuningOffset}
            demodMode={demodMode}
            displayOffset={displayOffset}
            fftSmoothing={fftSmoothing}
            onTuningOffsetChange={handleTuningOffsetChange}
            onCenterFrequencyPan={handleCenterFrequencyPan}
          />
        </div>
        {waterfallEnabled && (
          <>
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
          </>
        )}
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
              audioEnabled={audioEnabled}
              onVolumeChange={audio.setVolume}
              onSquelchChange={setSquelchLevel}
              onBandwidthChange={setChannelBandwidth}
              onRecordToggle={handleRecordToggle}
              onAudioToggle={setAudioEnabled}
            />
          </AccordionSection>
          <AccordionSection title="Display">
            <DisplaySettings
              fftSize={fftSize}
              colorMap={colorMap}
              waterfallSpeed={waterfallSpeed}
              displayOffset={displayOffset}
              fftSmoothing={fftSmoothing}
              waterfallEnabled={waterfallEnabled}
              onFftSizeChange={setFftSize}
              onColorMapChange={setColorMap}
              onWaterfallSpeedChange={setWaterfallSpeed}
              onDisplayOffsetChange={setDisplayOffset}
              onFftSmoothingChange={setFftSmoothing}
              onWaterfallToggle={setWaterfallEnabled}
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
