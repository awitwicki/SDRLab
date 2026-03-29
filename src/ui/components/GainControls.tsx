import styles from './ControlPanel.module.css';

interface GainControlsProps {
  gains: Record<string, number>;
  onGainChange: (stage: string, value: number) => void;
}

export default function GainControls({ gains, onGainChange }: GainControlsProps) {
  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Amp</span>
        <input type="checkbox" checked={(gains['amp'] ?? 0) > 0} onChange={e => onGainChange('amp', e.target.checked ? 14 : 0)} />
        <span className={styles.value}>{(gains['amp'] ?? 0) > 0 ? 'On' : 'Off'}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>LNA</span>
        <input type="range" className={styles.slider} min={0} max={40} step={8} value={gains['lna'] ?? 0} onChange={e => onGainChange('lna', Number(e.target.value))} />
        <span className={styles.value}>{gains['lna'] ?? 0} dB</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>VGA</span>
        <input type="range" className={styles.slider} min={0} max={62} step={2} value={gains['vga'] ?? 0} onChange={e => onGainChange('vga', Number(e.target.value))} />
        <span className={styles.value}>{gains['vga'] ?? 0} dB</span>
      </div>
    </>
  );
}
