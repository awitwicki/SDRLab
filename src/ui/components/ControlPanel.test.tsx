import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ControlPanel from './ControlPanel';

afterEach(cleanup);

describe('ControlPanel', () => {
  it('shows the collapse toggle when collapsible', () => {
    render(<ControlPanel open onToggle={vi.fn()}><p>controls</p></ControlPanel>);
    expect(screen.getByTitle('Close panel')).toBeTruthy();
    expect(screen.getByText('controls')).toBeTruthy();
  });

  it('hides its contents behind a stub when collapsed', () => {
    render(<ControlPanel open={false} onToggle={vi.fn()}><p>controls</p></ControlPanel>);
    expect(screen.getByTitle('Open panel')).toBeTruthy();
    expect(screen.queryByText('controls')).toBeNull();
  });

  // On a phone the panel is stacked in the page flow, where a collapse control
  // would strand the user with no way back to the settings.
  it('drops the toggle entirely when not collapsible', () => {
    render(<ControlPanel open onToggle={vi.fn()} collapsible={false}><p>controls</p></ControlPanel>);
    expect(screen.queryByTitle('Close panel')).toBeNull();
    expect(screen.queryByTitle('Open panel')).toBeNull();
    expect(screen.getByText('controls')).toBeTruthy();
  });

  it('still renders its contents when not collapsible and open is false', () => {
    render(<ControlPanel open={false} onToggle={vi.fn()} collapsible={false}><p>controls</p></ControlPanel>);
    expect(screen.getByText('controls')).toBeTruthy();
    expect(screen.queryByTitle('Open panel')).toBeNull();
  });
});
