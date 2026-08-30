import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import StatusBar from './StatusBar';

// NOTE: the bug these guard (RDS text widening the grid until the side panel is
// pushed off screen) is a layout failure, and jsdom computes no layout. These
// cover the markup contract only; the overflow itself needs a real browser.
const props = {
  sampleRate: 2e6,
  frequency: 100e6,
  tuningOffset: 0,
  bufferLevel: 0,
  bufferSize: 1024,
  usbRate: 0,
};

afterEach(cleanup);

describe('StatusBar RDS readout', () => {
  it('omits the RDS section entirely when nothing is decoded', () => {
    render(<StatusBar {...props} />);
    expect(screen.queryByText('RDS:')).toBeNull();
  });

  it('shows decoded RDS text when present', () => {
    render(<StatusBar {...props} rdsText="RADIO 1 — Now playing something" />);
    expect(screen.getByText('RDS:')).toBeTruthy();
    expect(screen.getByText('RADIO 1 — Now playing something')).toBeTruthy();
  });

  it('keeps the full text reachable when it is visually truncated', () => {
    const long = 'RADIO 1 — ' + 'a very long radio text message '.repeat(4).trim();
    render(<StatusBar {...props} rdsText={long} />);
    expect(screen.getByText(long).getAttribute('title')).toBe(long);
  });

  it('marks the RDS item as the one allowed to shrink', () => {
    // Regression guard: without this class the item refuses to shrink below
    // min-content and the grid widens past the viewport.
    const { container } = render(<StatusBar {...props} rdsText="RADIO 1" />);
    const item = container.querySelector('div[class*="rdsItem"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain('RADIO 1');
  });
});
