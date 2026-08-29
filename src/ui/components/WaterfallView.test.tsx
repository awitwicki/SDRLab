import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WaterfallView from './WaterfallView';

// Container is 1000px wide starting at x=0. With sampleRate 2 MHz and
// tuningOffset 0 the line sits at x=500; a 200 kHz channel is 10% of the
// span, so the band reaches 50px either side.
const WIDTH = 1000;
const CURSOR_X = 500;

function renderWaterfall(overrides: Partial<React.ComponentProps<typeof WaterfallView>> = {}) {
  const { container } = render(
    <WaterfallView
      fftData={null}
      frequency={100e6}
      sampleRate={2e6}
      colorMap="thermal"
      tuningOffset={0}
      channelBandwidth={200e3}
      waterfallSpeed={1}
      displayOffset={0}
      onTuningOffsetChange={vi.fn()}
      onCenterFrequencyPan={vi.fn()}
      {...overrides}
    />,
  );
  const root = container.firstElementChild as HTMLElement;
  const cursor = container.querySelector('div[class*="cursor"]') as HTMLElement;
  return { root, cursor };
}

const isVisible = (el: HTMLElement) => el.className.includes('cursorVisible');

beforeEach(() => {
  // jsdom has no WebGL; the component already no-ops when getContext returns
  // null, so stub it rather than let jsdom log "not implemented" per test.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: WIDTH, bottom: 200, width: WIDTH, height: 200, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('WaterfallView tuning line', () => {
  it('is hidden until the pointer arrives', () => {
    const { cursor } = renderWaterfall();
    expect(isVisible(cursor)).toBe(false);
  });

  it('appears when hovering the line itself', () => {
    const { root, cursor } = renderWaterfall();
    fireEvent.mouseMove(root, { clientX: CURSOR_X });
    expect(isVisible(cursor)).toBe(true);
  });

  it('appears when hovering inside the channel band but off the line', () => {
    const { root, cursor } = renderWaterfall();
    fireEvent.mouseMove(root, { clientX: CURSOR_X + 40 });
    expect(isVisible(cursor)).toBe(true);
  });

  it('stays hidden outside the band', () => {
    const { root, cursor } = renderWaterfall();
    fireEvent.mouseMove(root, { clientX: CURSOR_X + 200 });
    expect(isVisible(cursor)).toBe(false);
  });

  it('still reveals on the line when the band is narrower than the grab area', () => {
    // 2 kHz of a 2 MHz span is well under a pixel, so only the grab area applies.
    const { root, cursor } = renderWaterfall({ channelBandwidth: 2e3 });
    fireEvent.mouseMove(root, { clientX: CURSOR_X + 5 });
    expect(isVisible(cursor)).toBe(true);
    fireEvent.mouseMove(root, { clientX: CURSOR_X + 40 });
    expect(isVisible(cursor)).toBe(false);
  });

  it('hides again when the pointer leaves', () => {
    const { root, cursor } = renderWaterfall();
    fireEvent.mouseMove(root, { clientX: CURSOR_X });
    expect(isVisible(cursor)).toBe(true);
    fireEvent.mouseLeave(root);
    expect(isVisible(cursor)).toBe(false);
  });

  it('stays visible while dragging the line beyond the reveal zone', () => {
    const { root, cursor } = renderWaterfall();
    fireEvent.mouseDown(root, { clientX: CURSOR_X });
    fireEvent.mouseMove(root, { clientX: CURSOR_X + 300 });
    expect(isVisible(cursor)).toBe(true);
  });

  it('reveals the line after a click-to-tune', () => {
    const { root, cursor } = renderWaterfall();
    const x = CURSOR_X + 300;
    fireEvent.mouseDown(root, { clientX: x });
    fireEvent.mouseUp(root, { clientX: x });
    expect(isVisible(cursor)).toBe(true);
  });
});
