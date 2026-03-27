import styles from './ControlPanel.module.css';

interface AudioControlsProps {
  volume: number;
  squelchLevel: number;
  recording: boolean;
  onVolumeChange: (v: number) => void;
  onSquelchChange: (v: number) => void;
  onRecordToggle: () => void;
}

export default function AudioControls({ volume, squelchLevel, recording, onVolumeChange, onSquelchChange, onRecordToggle }: AudioControlsProps) {
  return (
    <>
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
      <button className={styles.recordBtn} data-recording={recording} onClick={onRecordToggle}>
        {recording ? 'Stop Recording' : 'Record'}
      </button>
    </>
  );
}
