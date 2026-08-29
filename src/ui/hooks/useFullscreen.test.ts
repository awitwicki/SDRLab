import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useFullscreen from './useFullscreen';

// jsdom implements none of the Fullscreen API, so stand up just enough of it
// to drive the hook, including changes that originate outside the app (Esc).
function stubFullscreen({ enabled = true } = {}) {
  const requestFullscreen = vi.fn().mockResolvedValue(undefined);
  const exitFullscreen = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(document, 'fullscreenEnabled', { value: enabled, configurable: true });
  Object.defineProperty(document, 'fullscreenElement', { value: null, writable: true, configurable: true });
  document.documentElement.requestFullscreen = requestFullscreen;
  document.exitFullscreen = exitFullscreen;

  const setElement = (el: Element | null) => {
    Object.defineProperty(document, 'fullscreenElement', { value: el, writable: true, configurable: true });
    act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
  };
  return {
    requestFullscreen,
    exitFullscreen,
    enter: () => setElement(document.documentElement),
    leave: () => setElement(null),
  };
}

afterEach(() => {
  Reflect.deleteProperty(document, 'fullscreenEnabled');
  Reflect.deleteProperty(document, 'fullscreenElement');
  vi.restoreAllMocks();
});

describe('useFullscreen', () => {
  it('reports unsupported where the browser disallows fullscreen', () => {
    stubFullscreen({ enabled: false });
    const { result } = renderHook(() => useFullscreen());
    expect(result.current.supported).toBe(false);
  });

  it('reports supported where the browser allows it', () => {
    stubFullscreen();
    const { result } = renderHook(() => useFullscreen());
    expect(result.current.supported).toBe(true);
  });

  it('starts out of fullscreen', () => {
    stubFullscreen();
    const { result } = renderHook(() => useFullscreen());
    expect(result.current.isFullscreen).toBe(false);
  });

  it('requests fullscreen on the document element when toggled on', async () => {
    const fs = stubFullscreen();
    const { result } = renderHook(() => useFullscreen());
    await act(async () => { await result.current.toggle(); });
    expect(fs.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(fs.exitFullscreen).not.toHaveBeenCalled();
  });

  it('exits when toggled while already fullscreen', async () => {
    const fs = stubFullscreen();
    const { result } = renderHook(() => useFullscreen());
    fs.enter();
    await act(async () => { await result.current.toggle(); });
    expect(fs.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(fs.requestFullscreen).not.toHaveBeenCalled();
  });

  it('tracks fullscreen entered and left outside the app', () => {
    const fs = stubFullscreen();
    const { result } = renderHook(() => useFullscreen());
    fs.enter();
    expect(result.current.isFullscreen).toBe(true);
    fs.leave();
    expect(result.current.isFullscreen).toBe(false);
  });

  it('survives a rejected request without throwing', async () => {
    const fs = stubFullscreen();
    fs.requestFullscreen.mockRejectedValue(new Error('gesture required'));
    const { result } = renderHook(() => useFullscreen());
    await act(async () => { await expect(result.current.toggle()).resolves.toBeUndefined(); });
  });

  it('detaches its listener on unmount', () => {
    stubFullscreen();
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useFullscreen());
    unmount();
    expect(remove).toHaveBeenCalledWith('fullscreenchange', expect.any(Function));
  });
});
