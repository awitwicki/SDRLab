import styles from './StatusBar.module.css';

interface StatusBarProps {
  sampleRate: number;
  bufferLevel: number;
  bufferSize: number;
  usbRate: number;
}

export default function StatusBar({ sampleRate, bufferLevel, bufferSize, usbRate }: StatusBarProps) {
  const bufferPct = bufferSize > 0 ? (bufferLevel / bufferSize) * 100 : 0;
  const bufferColor = bufferPct > 80 ? 'var(--danger)' : bufferPct > 50 ? 'var(--warning)' : 'var(--success)';

  return (
    <div className={styles.statusBar}>
      <div className={styles.item}>
        <span className={styles.itemLabel}>SR:</span>
        <span>{(sampleRate / 1e6).toFixed(1)} MHz</span>
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
