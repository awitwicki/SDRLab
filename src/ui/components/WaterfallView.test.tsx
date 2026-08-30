import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WaterfallView from './WaterfallView';

// Container is 1000px wide starting at x=0. With sampleRate 2 MHz and
// tuningOffset 0 the line sits at x=500; a 200 kHz channel is 10% of the
// span, so the band reaches 50px either side.
const WIDTH = 1000;
const CURSOR_X = 500;

function renderWaterfall(overrides: Partial<React.ComponentProps<typeof WaterfallView>> = {}) {
  const onTuningOffsetChange = vi.fn();
  const onCenterFrequencyPan = vi.fn();
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
      viewport={{ zoom: 1, centerOffset: 0 }}
      startFraction={0}
      spanFraction={1}
      onZoomAt={vi.fn()}
      onViewPan={vi.fn()}
      onTuningOffsetChange={onTuningOffsetChange}
      onCenterFrequencyPan={onCenterFrequencyPan}
      {...overrides}
    />,
  );
  const root = container.firstElementChild as HTMLElement;
  const cursor = container.querySelector('div[class*="cursor"]') as HTMLElement;
  const band = container.querySelector('div[class*="bandwidth"]') as HTMLElement;
  return { root, cursor, band, onTuningOffsetChange, onCenterFrequencyPan };
}

const touch = { pointerType: 'touch', pointerId: 1 };

const isVisible = (el: HTMLElement) => /cursorVisible|bandwidthVisible/.test(el.className);

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
    const { cursor, band } = renderWaterfall();
    expect(isVisible(cursor)).toBe(false);
    expect(isVisible(band)).toBe(false);
  });

  it('appears when hovering the line itself', () => {
    const { root, cursor, band } = renderWaterfall();
    fireEvent.pointerMove(root, { clientX: CURSOR_X });
    expect(isVisible(cursor)).toBe(true);
    expect(isVisible(band)).toBe(true);
  });

  it('appears when hovering inside the channel band but off the line', () => {
    const { root, cursor, band } = renderWaterfall();
    fireEvent.pointerMove(root, { clientX: CURSOR_X + 40 });
    expect(isVisible(cursor)).toBe(true);
    expect(isVisible(band)).toBe(true);
  });

  it('stays hidden outside the band', () => {
    const { root, cursor, band } = renderWaterfall();
    fireEvent.pointerMove(root, { clientX: CURSOR_X + 200 });
    expect(isVisible(cursor)).toBe(false);
    expect(isVisible(band)).toBe(false);
  });

  it('still reveals on the line when the band is narrower than the grab area', () => {
    // 2 kHz of a 2 MHz span is well under a pixel, so only the grab area applies.
    const { root, cursor } = renderWaterfall({ channelBandwidth: 2e3 });
    fireEvent.pointerMove(root, { clientX: CURSOR_X + 5 });
    expect(isVisible(cursor)).toBe(true);
    fireEvent.pointerMove(root, { clientX: CURSOR_X + 40 });
    expect(isVisible(cursor)).toBe(false);
  });

  it('hides again when the pointer leaves', () => {
    const { root, cursor, band } = renderWaterfall();
    fireEvent.pointerMove(root, { clientX: CURSOR_X });
    expect(isVisible(cursor)).toBe(true);
    expect(isVisible(band)).toBe(true);
    fireEvent.pointerLeave(root);
    expect(isVisible(cursor)).toBe(false);
    expect(isVisible(band)).toBe(false);
  });

  it('stays visible while dragging the line beyond the reveal zone', () => {
    const { root, cursor } = renderWaterfall();
    fireEvent.pointerDown(root, { clientX: CURSOR_X });
    fireEvent.pointerMove(root, { clientX: CURSOR_X + 300 });
    expect(isVisible(cursor)).toBe(true);
  });

  it('reveals the line after a click-to-tune', () => {
    const { root, cursor } = renderWaterfall();
    const x = CURSOR_X + 300;
    fireEvent.pointerDown(root, { clientX: x });
    fireEvent.pointerUp(root, { clientX: x });
    expect(isVisible(cursor)).toBe(true);
  });
});

describe('WaterfallView touch input', () => {
  it('tunes where a finger taps', () => {
    const { root, onTuningOffsetChange } = renderWaterfall();
    // x=750 of 1000px is 3/4 across a 2 MHz span, i.e. +500 kHz of centre.
    fireEvent.pointerDown(root, { ...touch, clientX: 750 });
    fireEvent.pointerUp(root, { ...touch, clientX: 750 });
    expect(onTuningOffsetChange).toHaveBeenCalledWith(500e3);
  });

  it('pans the centre frequency on a horizontal finger drag', () => {
    const { root, onCenterFrequencyPan } = renderWaterfall();
    // Start clear of the line so this is a pan, then drag 100px left.
    fireEvent.pointerDown(root, { ...touch, clientX: 800 });
    fireEvent.pointerMove(root, { ...touch, clientX: 700 });
    expect(onCenterFrequencyPan).toHaveBeenCalledWith(100e6 + 200e3);
  });

  it('drags the tuning line when the finger starts on it', () => {
    const { root, onTuningOffsetChange } = renderWaterfall();
    fireEvent.pointerDown(root, { ...touch, clientX: CURSOR_X });
    fireEvent.pointerMove(root, { ...touch, clientX: CURSOR_X + 50 });
    expect(onTuningOffsetChange).toHaveBeenCalledWith(100e3);
  });

  it('reveals the overlay under a finger', () => {
    const { root, cursor, band } = renderWaterfall();
    fireEvent.pointerDown(root, { ...touch, clientX: CURSOR_X });
    expect(isVisible(cursor)).toBe(true);
    expect(isVisible(band)).toBe(true);
  });
});

// At 4x the view is 500 kHz wide centred on the tuned frequency, so it spans
// -250 kHz..+250 kHz of the hardware centre.
const zoomed4x = { viewport: { zoom: 4, centerOffset: 0 } };

describe('WaterfallView when zoomed', () => {
  it('tunes within the visible window, not the whole span', () => {
    const { root, onTuningOffsetChange } = renderWaterfall(zoomed4x);
    // 0.75 across a 500 kHz window starting at -250 kHz is +125 kHz.
    fireEvent.pointerDown(root, { clientX: 750 });
    fireEvent.pointerUp(root, { clientX: 750 });
    expect(onTuningOffsetChange).toHaveBeenCalledWith(125e3);
  });

  it('slides the view instead of retuning the hardware', () => {
    const onViewPan = vi.fn();
    const { root, onCenterFrequencyPan } = renderWaterfall({ ...zoomed4x, onViewPan });
    fireEvent.pointerDown(root, { clientX: 800 });
    fireEvent.pointerMove(root, { clientX: 700 });
    // 100px of a 1000px-wide 500 kHz window is 50 kHz.
    expect(onViewPan).toHaveBeenCalledWith(50e3);
    expect(onCenterFrequencyPan).not.toHaveBeenCalled();
  });

  it('still retunes the hardware at 1x, where there is nowhere to slide', () => {
    const onViewPan = vi.fn();
    const { root, onCenterFrequencyPan } = renderWaterfall({ onViewPan });
    fireEvent.pointerDown(root, { clientX: 800 });
    fireEvent.pointerMove(root, { clientX: 700 });
    expect(onCenterFrequencyPan).toHaveBeenCalled();
    expect(onViewPan).not.toHaveBeenCalled();
  });

  it('places the tuning line by the visible window', () => {
    // Tuned +125 kHz sits three quarters across a -250..+250 kHz window.
    const { cursor } = renderWaterfall({ ...zoomed4x, tuningOffset: 125e3 });
    expect(cursor.style.left).toBe('75%');
  });

  it('widens the channel band as the window narrows', () => {
    // 200 kHz of a 500 kHz window is 40%, against 10% of the full span.
    const { band } = renderWaterfall(zoomed4x);
    expect(band.style.width).toBe('40%');
  });
});

describe('WaterfallView zoom gestures', () => {
  it('zooms on the wheel, anchored at the cursor', () => {
    const onZoomAt = vi.fn();
    const { root } = renderWaterfall({ onZoomAt });
    fireEvent.wheel(root, { deltaY: -100, clientX: 250 });
    expect(onZoomAt).toHaveBeenCalledWith(expect.any(Number), 0.25);
    expect(onZoomAt.mock.calls[0]![0]).toBeGreaterThan(1);
  });

  it('zooms on a two-finger pinch', () => {
    const onZoomAt = vi.fn();
    const { root } = renderWaterfall({ onZoomAt });
    fireEvent.pointerDown(root, { pointerId: 1, clientX: 400 });
    fireEvent.pointerDown(root, { pointerId: 2, clientX: 600 });
    fireEvent.pointerMove(root, { pointerId: 2, clientX: 800 });
    expect(onZoomAt).toHaveBeenCalledWith(2, expect.any(Number));
  });

  it('does not retune while pinching', () => {
    const { root, onCenterFrequencyPan, onTuningOffsetChange } = renderWaterfall({ onZoomAt: vi.fn() });
    fireEvent.pointerDown(root, { pointerId: 1, clientX: 400 });
    fireEvent.pointerDown(root, { pointerId: 2, clientX: 600 });
    fireEvent.pointerMove(root, { pointerId: 2, clientX: 800 });
    expect(onCenterFrequencyPan).not.toHaveBeenCalled();
    expect(onTuningOffsetChange).not.toHaveBeenCalled();
  });
});
