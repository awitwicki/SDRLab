import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useZoomGestures from './useZoomGestures';

// The plot is 1000px wide starting at x=0, so clientX maps straight to a
// 0..1 fraction across it.
const xToFraction = (clientX: number) => clientX / 1000;

function setup() {
  const onZoomAt = vi.fn();
  const { result } = renderHook(() => useZoomGestures(xToFraction, onZoomAt));
  return { result, onZoomAt };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('pinch', () => {
  it('zooms in as two fingers spread apart', () => {
    const { result, onZoomAt } = setup();
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 400 });
      result.current.pointerDown({ pointerId: 2, clientX: 600 });
    });
    act(() => result.current.pointerMove({ pointerId: 2, clientX: 800 }));
    // Gap went 200 -> 400, so the view should halve: a factor of 2.
    expect(onZoomAt).toHaveBeenCalledWith(2, expect.any(Number));
  });

  it('zooms out as two fingers come together', () => {
    const { result, onZoomAt } = setup();
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 300 });
      result.current.pointerDown({ pointerId: 2, clientX: 700 });
    });
    act(() => result.current.pointerMove({ pointerId: 2, clientX: 500 }));
    expect(onZoomAt).toHaveBeenCalledWith(0.5, expect.any(Number));
  });

  it('anchors on the midpoint between the fingers', () => {
    const { result, onZoomAt } = setup();
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 200 });
      result.current.pointerDown({ pointerId: 2, clientX: 400 });
    });
    act(() => result.current.pointerMove({ pointerId: 2, clientX: 600 }));
    // Midpoint of 200 and 600 is 400px, i.e. 0.4 across the plot.
    expect(onZoomAt).toHaveBeenCalledWith(expect.any(Number), 0.4);
  });

  it('reports a pinch in progress so the caller can suspend dragging', () => {
    const { result } = setup();
    expect(result.current.pinching).toBe(false);
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 400 });
      result.current.pointerDown({ pointerId: 2, clientX: 600 });
    });
    expect(result.current.pinching).toBe(true);
  });

  it('ends the pinch when a finger lifts', () => {
    const { result } = setup();
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 400 });
      result.current.pointerDown({ pointerId: 2, clientX: 600 });
    });
    act(() => result.current.pointerUp({ pointerId: 2, clientX: 600 }));
    expect(result.current.pinching).toBe(false);
  });

  it('ignores a single finger moving', () => {
    const { result, onZoomAt } = setup();
    act(() => result.current.pointerDown({ pointerId: 1, clientX: 400 }));
    act(() => result.current.pointerMove({ pointerId: 1, clientX: 700 }));
    expect(onZoomAt).not.toHaveBeenCalled();
  });
});

describe('wheel', () => {
  it('zooms in when scrolled up, anchored at the cursor', () => {
    const { result, onZoomAt } = setup();
    act(() => result.current.wheel({ deltaY: -100, clientX: 250 }));
    const [factor, anchor] = onZoomAt.mock.calls[0]!;
    expect(factor).toBeGreaterThan(1);
    expect(anchor).toBe(0.25);
  });

  it('zooms out when scrolled down', () => {
    const { result, onZoomAt } = setup();
    act(() => result.current.wheel({ deltaY: 100, clientX: 500 }));
    expect(onZoomAt.mock.calls[0]![0]).toBeLessThan(1);
  });
});

describe('double tap', () => {
  it('zooms in on a quick second tap at the same spot', () => {
    const { result, onZoomAt } = setup();
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 300 });
      result.current.pointerUp({ pointerId: 1, clientX: 300 });
    });
    act(() => vi.advanceTimersByTime(100));
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 300 });
      result.current.pointerUp({ pointerId: 1, clientX: 300 });
    });
    expect(onZoomAt).toHaveBeenCalledWith(2, 0.3);
  });

  it('ignores a second tap that comes too late', () => {
    const { result, onZoomAt } = setup();
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 300 });
      result.current.pointerUp({ pointerId: 1, clientX: 300 });
    });
    act(() => vi.advanceTimersByTime(1000));
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 300 });
      result.current.pointerUp({ pointerId: 1, clientX: 300 });
    });
    expect(onZoomAt).not.toHaveBeenCalled();
  });

  it('ignores a second tap somewhere else, which is two separate tunes', () => {
    const { result, onZoomAt } = setup();
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 300 });
      result.current.pointerUp({ pointerId: 1, clientX: 300 });
    });
    act(() => vi.advanceTimersByTime(100));
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 700 });
      result.current.pointerUp({ pointerId: 1, clientX: 700 });
    });
    expect(onZoomAt).not.toHaveBeenCalled();
  });

  it('does not treat the end of a drag as a tap', () => {
    const { result, onZoomAt } = setup();
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 300 });
      result.current.pointerUp({ pointerId: 1, clientX: 300 });
    });
    act(() => vi.advanceTimersByTime(100));
    act(() => {
      result.current.pointerDown({ pointerId: 1, clientX: 300 });
      result.current.pointerMove({ pointerId: 1, clientX: 500 });
      result.current.pointerUp({ pointerId: 1, clientX: 500 });
    });
    expect(onZoomAt).not.toHaveBeenCalled();
  });
});
