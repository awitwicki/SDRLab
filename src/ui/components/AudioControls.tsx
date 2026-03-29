import styles from './ControlPanel.module.css';

interface AudioControlsProps {
  volume: number;
  squelchLevel: number;
  channelBandwidth: number;
  recording: boolean;
  audioEnabled: boolean;
  onVolumeChange: (v: number) => void;
  onSquelchChange: (v: number) => void;
  onBandwidthChange: (hz: number) => void;
  onRecordToggle: () => void;
  onAudioToggle: (enabled: boolean) => void;
}

export default function AudioControls({
  volume, squelchLevel, channelBandwidth, recording, audioEnabled,
  onVolumeChange, onSquelchChange, onBandwidthChange, onRecordToggle, onAudioToggle,
}: AudioControlsProps) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6 }}>
        <label>
          <input type="checkbox" checked={audioEnabled} onChange={e => onAudioToggle(e.target.checked)} />
          {' '}Enable Audio
        </label>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Vol</span>
        <input type="range" className={styles.slider} min={0} max={1} step={0.01} value={volume} onChange={e => onVolumeChange(Number(e.target.value))} />
        <span className={styles.value}>{Math.round(volume * 100)}%</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Squelch</span>
        <input type="range" className={styles.slider} min={-100} max={0} step={1} value={squelchLevel} onChange={e => onSquelchChange(Number(e.target.value))} />
        <span className={styles.value}>{squelchLevel} dB</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>BW</span>
        <input type="range" className={styles.slider} min={5000} max={250000} step={5000} value={channelBandwidth} onChange={e => onBandwidthChange(Number(e.target.value))} />
        <span className={styles.value}>{(channelBandwidth / 1000).toFixed(0)}k</span>
      </div>
      <button className={styles.recordBtn} data-recording={recording} onClick={onRecordToggle}>
        {recording ? 'Stop Recording' : 'Record'}
      </button>
    </>
  );
}
