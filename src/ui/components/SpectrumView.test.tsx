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
