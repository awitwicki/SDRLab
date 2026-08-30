import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import useViewport from './useViewport';

const SR = 2e6;

describe('useViewport', () => {
  it('starts showing the whole captured span', () => {
    const { result } = renderHook(() => useViewport(SR));
    expect(result.current.zoom).toBe(1);
    expect(result.current.centerOffset).toBe(0);
    expect(result.current.visibleSpan).toBe(SR);
    expect(result.current.spanFraction).toBe(1);
  });

  it('zooms about an anchor', () => {
    const { result } = renderHook(() => useViewport(SR));
    act(() => result.current.zoomAt(2, 0.5));
    expect(result.current.zoom).toBe(2);
    expect(result.current.visibleSpan).toBe(SR / 2);
  });

  it('pans within the span once zoomed', () => {
    const { result } = renderHook(() => useViewport(SR));
    act(() => result.current.zoomAt(4, 0.5));
    act(() => result.current.pan(100e3));
    expect(result.current.centerOffset).toBe(100e3);
  });

  it('cannot pan while showing the whole span', () => {
    const { result } = renderHook(() => useViewport(SR));
    act(() => result.current.pan(300e3));
    expect(result.current.centerOffset).toBe(0);
  });

  it('pans to an absolute offset, clamped to the span', () => {
    const { result } = renderHook(() => useViewport(SR));
    act(() => result.current.zoomAt(4, 0.5));
    act(() => result.current.panTo(200e3));
    expect(result.current.centerOffset).toBe(200e3);
    act(() => result.current.panTo(9e6));
    expect(result.current.centerOffset).toBe(750e3);
  });

  it('returns to the full span on reset', () => {
    const { result } = renderHook(() => useViewport(SR));
    act(() => result.current.zoomAt(8, 0.2));
    act(() => result.current.reset());
    expect(result.current.zoom).toBe(1);
    expect(result.current.centerOffset).toBe(0);
  });

  // The offset is measured against a span that just changed size, so keeping
  // it would leave the view pointing somewhere the user never chose.
  it('resets when the sample rate changes underneath it', () => {
    const { result, rerender } = renderHook(({ sr }) => useViewport(sr), {
      initialProps: { sr: SR },
    });
    act(() => result.current.zoomAt(4, 0.2));
    expect(result.current.zoom).toBe(4);
    rerender({ sr: 8e6 });
    expect(result.current.zoom).toBe(1);
    expect(result.current.centerOffset).toBe(0);
  });

  it('holds its zoom across an unrelated re-render', () => {
    const { result, rerender } = renderHook(({ sr }) => useViewport(sr), {
      initialProps: { sr: SR },
    });
    act(() => result.current.zoomAt(4, 0.5));
    rerender({ sr: SR });
    expect(result.current.zoom).toBe(4);
  });
});
