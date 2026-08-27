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
const MIN_FREQ = 1_000_000;      // HackRF One lower limit
const MAX_FREQ = 6_000_000_000;  // HackRF One upper limit
const clampFreq = (hz: number) => Math.min(MAX_FREQ, Math.max(MIN_FREQ, hz));
const MODE_DEFAULT_BW: Record<DemodMode, number> = { WFM: 200_000, NFM: 15_000, AM: 10_000 };
// Bump whenever a saved field's *meaning* changes in a way that makes an old
// stored value actively wrong (not just outdated) — e.g. v2: squelchLevel
// was tuned by users against the pre-multi-stage-decimation squelch
// measurement, which read channel power inflated by wide-filter leakage
// (~14 dB high at narrow bandwidths). Loading that old value verbatim now
// under-squelches (opens too easily) or, more commonly for a threshold
// tuned against inflated readings, leaves squelch shut on real signals.
// loadSettings() drops just the affected field(s) when the stored version
// is behind, so the rest of a user's settings still restore normally.
const SETTINGS_VERSION = 2;

interface SavedSettings {
  settingsVersion: number;
  frequency: number;
  sampleRate: number;
  tuningOffset: number;
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
  spectrumHeight: number;
}

function loadSettings(): Partial<SavedSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SavedSettings>;
      if ((parsed.settingsVersion ?? 0) < SETTINGS_VERSION) {
        // Stale squelchLevel from a pre-v2 save — drop it so the caller's
        // `saved.squelchLevel ?? -60` falls through to the default instead
        // of using a threshold tuned against the old, inflated readings.
        delete parsed.squelchLevel;
      }
      return parsed;
    }
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

  const [saved] = useState(loadSettings); // lazy init — runs exactly once
  const [frequency, setFrequency] = useState(saved.frequency ?? DEFAULT_FREQUENCY);
  const [sampleRate, setSampleRate] = useState(saved.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const [tuningOffset, setTuningOffset] = useState(saved.tuningOffset ?? 0);
  const [demodMode, setDemodMode] = useState<DemodMode>(saved.demodMode ?? 'WFM');
  const [gains, setGains] = useState<Record<string, number>>(saved.gains ?? { amp: 0, lna: 16, vga: 20 });
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
  const [spectrumHeight, setSpectrumHeight] = useState(saved.spectrumHeight ?? 200);
  const [ookEnabled, setOokEnabled] = useState(false);
  const [usbRate, setUsbRate] = useState(0);

  // Persist settings to localStorage (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      saveSettings({
        settingsVersion: SETTINGS_VERSION,
        frequency, sampleRate, tuningOffset, demodMode, gains, squelchLevel, fftSize,
        channelBandwidth, colorMap, waterfallSpeed, displayOffset, fftSmoothing, panelOpen,
        audioEnabled, waterfallEnabled, spectrumHeight,
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [frequency, sampleRate, tuningOffset, demodMode, gains, squelchLevel, fftSize,
      channelBandwidth, colorMap, waterfallSpeed, displayOffset, fftSmoothing, panelOpen,
      audioEnabled, waterfallEnabled, spectrumHeight]);

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
  }, [frequency, sampleRate, demodMode, fftSize, squelchLevel, tuningOffset, ookEnabled, channelBandwidth, audioEnabled, dsp.updateConfig]);

  const handleConnect = useCallback(async () => {
    try {
      await device.connect();
      if (audioEnabled) await audioRef.current.init();
    } catch (err) {
      console.error('Connect failed:', err);
    }
  }, [device, audioEnabled]);

  const handleDisconnect = useCallback(async () => {
    await device.stop();
    await device.disconnect();
    await audioRef.current.destroy();
  }, [device]);

  const handleStart = useCallback(async () => {
    audioRef.current.flush();
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
  }, [device, dsp.sendIQ, frequency, sampleRate, gains]);

  const handleStop = useCallback(async () => {
    audioRef.current.flush();
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
    const clamped = clampFreq(hz);
    setFrequency(clamped);
    setTuningOffset(0);
    syncFreqToDevice(clamped);
  }, [syncFreqToDevice]);

  const handleTuningOffsetChange = useCallback((offset: number) => {
    const clamped = Math.max(-sampleRate / 2, Math.min(sampleRate / 2, offset));
    setTuningOffset(clamped);
  }, [sampleRate]);

  const handleCenterFrequencyPan = useCallback((hz: number) => {
    const rounded = clampFreq(Math.round(hz / 1000) * 1000);
    setFrequency(rounded);
    syncFreqToDevice(rounded);
  }, [syncFreqToDevice]);

  const handleDemodModeChange = useCallback((mode: DemodMode) => {
    audioRef.current.flush();
    setDemodMode(mode);
    setChannelBandwidth(MODE_DEFAULT_BW[mode]);
  }, []);

  const handleSampleRateChange = useCallback(async (hz: number) => {
    audioRef.current.flush();
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
    if (audioRef.current.recording) {
      audioRef.current.stopRecording();
    } else {
      audioRef.current.startRecording();
    }
  }, []);

  const handleAudioToggle = useCallback(async (enabled: boolean) => {
    setAudioEnabled(enabled);
    if (enabled && !audioRef.current.initialized) {
      try { await audioRef.current.init(); } catch (err) { console.error('Audio init failed:', err); }
    }
  }, []);

  const handlePanelToggle = useCallback(() => setPanelOpen(p => !p), []);
  const handleOokToggle = useCallback(() => setOokEnabled(false), []);
  const handleOokChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setOokEnabled(e.target.checked), []);

  const mainRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ startY: number; startH: number } | null>(null);

  const handleSplitDown = useCallback((e: React.PointerEvent) => {
    if (!waterfallEnabled || e.button !== 0) return;
    splitDragRef.current = { startY: e.clientY, startH: spectrumHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [waterfallEnabled, spectrumHeight]);

  const handleSplitMove = useCallback((e: React.PointerEvent) => {
    const drag = splitDragRef.current;
    if (!drag) return;
    // Reserve >=160px for waterfall+axis, plus the OOK decoder panel's fixed
    // 240px (.decoder in App.module.css) when it's showing — otherwise the
    // decoder panel can get pushed past .main's overflow:hidden and clipped.
    const reserved = waterfallEnabled && ookEnabled ? 160 + 240 : 160;
    const maxH = (mainRef.current?.offsetHeight ?? 800) - reserved;
    setSpectrumHeight(Math.max(100, Math.min(maxH, drag.startH + (e.clientY - drag.startY))));
  }, [waterfallEnabled, ookEnabled]);

  const handleSplitUp = useCallback(() => { splitDragRef.current = null; }, []);

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
          onDemodModeChange={handleDemodModeChange}
          onSampleRateChange={handleSampleRateChange}
          rdsPs={dsp.rdsData?.ps}
        />
      </div>

      <div className={styles.main} ref={mainRef}>
        <div
          className={waterfallEnabled ? styles.spectrum : styles.spectrumExpanded}
          style={waterfallEnabled ? { flex: `0 0 ${spectrumHeight}px` } : undefined}
        >
          <SpectrumView
            fftData={dsp.fftData}
            frequency={frequency}
            sampleRate={sampleRate}
            tuningOffset={tuningOffset}
            channelBandwidth={channelBandwidth}
            displayOffset={displayOffset}
            fftSmoothing={fftSmoothing}
            onTuningOffsetChange={handleTuningOffsetChange}
            onCenterFrequencyPan={handleCenterFrequencyPan}
          />
        </div>
        <div
          className={styles.freqAxis}
          data-resizable={waterfallEnabled}
          onPointerDown={handleSplitDown}
          onPointerMove={handleSplitMove}
          onPointerUp={handleSplitUp}
          onPointerCancel={handleSplitUp}
        >
          <FrequencyAxis
            centerFrequency={frequency}
            sampleRate={sampleRate}
          />
        </div>
        {waterfallEnabled && (
          <div className={styles.waterfall}>
            <WaterfallView
              fftData={dsp.fftData}
              frequency={frequency}
              sampleRate={sampleRate}
              colorMap={colorMap}
              tuningOffset={tuningOffset}
              channelBandwidth={channelBandwidth}
              displayOffset={displayOffset}
              waterfallSpeed={waterfallSpeed}
              onTuningOffsetChange={handleTuningOffsetChange}
              onCenterFrequencyPan={handleCenterFrequencyPan}
            />
          </div>
        )}
        {ookEnabled && (
          <div className={styles.decoder}>
            <DigitalDecoder
              bits={dsp.bitEvents}
              enabled={ookEnabled}
              onToggle={handleOokToggle}
            />
          </div>
        )}
      </div>

      <div className={panelOpen ? styles.panel : styles.panelCollapsed}>
        <ControlPanel open={panelOpen} onToggle={handlePanelToggle}>
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
              onAudioToggle={handleAudioToggle}
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
                  onChange={handleOokChange}
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
          rdsText={dsp.rdsData && (dsp.rdsData.ps || dsp.rdsData.rt) ? `${dsp.rdsData.ps} — ${dsp.rdsData.rt}` : undefined}
        />
      </div>
    </div>
  );
}
