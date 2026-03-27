import styles from './StatusBar.module.css';

interface StatusBarProps {
  sampleRate: number;
  frequency: number;
  tuningOffset: number;
  bufferLevel: number;
  bufferSize: number;
  usbRate: number;
}

export default function StatusBar({ sampleRate, frequency, tuningOffset, bufferLevel, bufferSize, usbRate }: Readonly<StatusBarProps>) {
  const bufferPct = bufferSize > 0 ? (bufferLevel / bufferSize) * 100 : 0;
  const bufferColor = bufferPct > 80 ? 'var(--danger)' : bufferPct > 50 ? 'var(--warning)' : 'var(--success)';
  const lowFreq = (frequency - sampleRate / 2) / 1e6;
  const highFreq = (frequency + sampleRate / 2) / 1e6;
  const tunedFreq = (frequency + tuningOffset) / 1e6;

  return (
    <div className={styles.statusBar}>
      <div className={styles.item}>
        <span className={styles.itemLabel}>SR:</span>
        <span>{(sampleRate / 1e6).toFixed(1)} MHz</span>
      </div>
      <div className={styles.item}>
        <span className={styles.itemLabel}>BW:</span>
        <span>{lowFreq.toFixed(1)} - {highFreq.toFixed(1)} MHz</span>
      </div>
      <div className={styles.item}>
        <span className={styles.itemLabel}>Tune:</span>
        <span>{tunedFreq.toFixed(3)} MHz</span>
      </div>
      <div className={styles.item}>
        <span className={styles.itemLabel}>Buf:</span>
        <div className={styles.bufferBar}>
          <div className={styles.bufferFill} style={{ width: `${bufferPct}%`, background: bufferColor }} />
        </div>
        <span>{Math.round(bufferPct)}%</span>
      </div>
      <div className={styles.item}>
        <span className={styles.itemLabel}>USB:</span>
        <span>{(usbRate / 1024).toFixed(0)} KB/s</span>
      </div>
    </div>
  );
}
