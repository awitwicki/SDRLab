import { useState, type ReactNode } from 'react';
import styles from './ControlPanel.module.css';

interface ControlPanelProps {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export default function ControlPanel({ open, onToggle, children }: ControlPanelProps) {
  if (!open) {
    return (
      <div className={styles.collapsed}>
        <button className={styles.toggleBtn} onClick={onToggle} title="Open panel">{'<'}</button>
      </div>
    );
  }
  return (
    <div className={styles.panel}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 4 }}>
        <button className={styles.toggleBtn} onClick={onToggle} title="Close panel">{'>'}</button>
      </div>
      {children}
    </div>
  );
}

interface AccordionSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function AccordionSection({ title, defaultOpen = true, children }: AccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>{'>'}</span>
      </div>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}
