import { useState, type ReactNode } from 'react';
import styles from './ControlPanel.module.css';

interface ControlPanelProps {
  open: boolean;
  onToggle: () => void;
  /** False on narrow screens, where the panel is stacked in the page flow and
   *  collapsing it would leave no way back to the settings. */
  collapsible?: boolean;
  children: ReactNode;
}

export default function ControlPanel({ open, onToggle, collapsible = true, children }: ControlPanelProps) {
  if (!collapsible) {
    return <div className={styles.panel}>{children}</div>;
  }
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
