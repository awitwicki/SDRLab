import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SpectrumView from './SpectrumView';

// 1000px wide from x=0; at 2 MHz span the tuning line sits at x=500.
const WIDTH = 1000;
const CURSOR_X = 500;
const touch = { pointerType: 'touch', pointerId: 1 };

function renderSpectrum() {
  const onTuningOffsetChange = vi.fn();
  const onCenterFrequencyPan = vi.fn();
  const { container } = render(
    <SpectrumView
      fftData={null}
      frequency={100e6}
      sampleRate={2e6}
      tuningOffset={0}
      channelBandwidth={200e3}
      displayOffset={0}
      fftSmoothing={0}
      viewport={{ zoom: 1, centerOffset: 0 }}
      onZoomAt={vi.fn()}
      onViewPan={vi.fn()}
      onTuningOffsetChange={onTuningOffsetChange}
      onCenterFrequencyPan={onCenterFrequencyPan}
    />,
  );
  return {
    root: container.firstElementChild as HTMLElement,
    onTuningOffsetChange,
    onCenterFrequencyPan,
  };
}

beforeEach(() => {
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

describe('SpectrumView touch input', () => {
  it('tunes where a finger taps', () => {
    const { root, onTuningOffsetChange } = renderSpectrum();
    fireEvent.pointerDown(root, { ...touch, clientX: 750 });
    fireEvent.pointerUp(root, { ...touch, clientX: 750 });
    expect(onTuningOffsetChange).toHaveBeenCalledWith(500e3);
  });

  it('pans the centre frequency on a horizontal finger drag', () => {
    const { root, onCenterFrequencyPan } = renderSpectrum();
    fireEvent.pointerDown(root, { ...touch, clientX: 800 });
    fireEvent.pointerMove(root, { ...touch, clientX: 700 });
    expect(onCenterFrequencyPan).toHaveBeenCalledWith(100e6 + 200e3);
  });

  it('drags the tuning line when the finger starts on it', () => {
    const { root, onTuningOffsetChange } = renderSpectrum();
    fireEvent.pointerDown(root, { ...touch, clientX: CURSOR_X });
    fireEvent.pointerMove(root, { ...touch, clientX: CURSOR_X + 50 });
    expect(onTuningOffsetChange).toHaveBeenCalledWith(100e3);
  });

  it('does not tune on a drag that ends far from where it began', () => {
    const { root, onTuningOffsetChange } = renderSpectrum();
    fireEvent.pointerDown(root, { ...touch, clientX: 800 });
    fireEvent.pointerMove(root, { ...touch, clientX: 700 });
    fireEvent.pointerUp(root, { ...touch, clientX: 700 });
    expect(onTuningOffsetChange).not.toHaveBeenCalled();
  });
});

describe('SpectrumView when zoomed', () => {
  function renderZoomed() {
    const onTuningOffsetChange = vi.fn();
    const onCenterFrequencyPan = vi.fn();
    const onViewPan = vi.fn();
    const onZoomAt = vi.fn();
    const { container } = render(
      <SpectrumView
        fftData={null}
        frequency={100e6}
        sampleRate={2e6}
        tuningOffset={0}
        channelBandwidth={200e3}
        displayOffset={0}
        fftSmoothing={0}
        viewport={{ zoom: 4, centerOffset: 0 }}
        onZoomAt={onZoomAt}
        onViewPan={onViewPan}
        onTuningOffsetChange={onTuningOffsetChange}
        onCenterFrequencyPan={onCenterFrequencyPan}
      />,
    );
    return {
      root: container.firstElementChild as HTMLElement,
      onTuningOffsetChange, onCenterFrequencyPan, onViewPan, onZoomAt,
    };
  }

  it('tunes within the visible window', () => {
    const { root, onTuningOffsetChange } = renderZoomed();
    fireEvent.pointerDown(root, { clientX: 750 });
    fireEvent.pointerUp(root, { clientX: 750 });
    expect(onTuningOffsetChange).toHaveBeenCalledWith(125e3);
  });

  it('slides the view rather than retuning', () => {
    const { root, onViewPan, onCenterFrequencyPan } = renderZoomed();
    fireEvent.pointerDown(root, { clientX: 800 });
    fireEvent.pointerMove(root, { clientX: 700 });
    expect(onViewPan).toHaveBeenCalledWith(50e3);
    expect(onCenterFrequencyPan).not.toHaveBeenCalled();
  });

  it('zooms on the wheel', () => {
    const { root, onZoomAt } = renderZoomed();
    fireEvent.wheel(root, { deltaY: -100, clientX: 500 });
    expect(onZoomAt).toHaveBeenCalledWith(expect.any(Number), 0.5);
  });
});
