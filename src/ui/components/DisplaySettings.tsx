import type { ColorMap } from '../../devices/types';
import styles from './ControlPanel.module.css';

interface DisplaySettingsProps {
  fftSize: number;
  colorMap: ColorMap;
  waterfallSpeed: number;
  displayOffset: number;
  onFftSizeChange: (size: number) => void;
  onColorMapChange: (map: ColorMap) => void;
  onWaterfallSpeedChange: (speed: number) => void;
  onDisplayOffsetChange: (offset: number) => void;
}

export default function DisplaySettings({
  fftSize, colorMap, waterfallSpeed, displayOffset,
  onFftSizeChange, onColorMapChange, onWaterfallSpeedChange, onDisplayOffsetChange,
}: DisplaySettingsProps) {
  return (
    <>
      <div className={styles.selectRow}>
        <span className={styles.label}>FFT</span>
        <select className={styles.select} value={fftSize} onChange={e => onFftSizeChange(Number(e.target.value))}>
          <option value={512}>512</option>
          <option value={1024}>1024</option>
          <option value={2048}>2048</option>
          <option value={4096}>4096</option>
        </select>
      </div>
      <div className={styles.selectRow}>
        <span className={styles.label}>Color</span>
        <select className={styles.select} value={colorMap} onChange={e => onColorMapChange(e.target.value as ColorMap)}>
          <option value="thermal">Thermal</option>
          <option value="grayscale">Grayscale</option>
          <option value="green">Green</option>
        </select>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Speed</span>
        <input type="range" className={styles.slider} min={1} max={5} step={1} value={waterfallSpeed} onChange={e => onWaterfallSpeedChange(Number(e.target.value))} />
        <span className={styles.value}>{waterfallSpeed}x</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Bias</span>
        <input type="range" className={styles.slider} min={-40} max={40} step={1} value={displayOffset} onChange={e => onDisplayOffsetChange(Number(e.target.value))} />
        <span className={styles.value}>{displayOffset > 0 ? '+' : ''}{displayOffset}</span>
      </div>
    </>
  );
}
