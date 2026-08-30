import { useCallback, useRef, useState } from 'react';

/** Only the fields these gestures need, so tests need not build real events. */
export interface PointerLike {
  pointerId: number;
  clientX: number;
}
export interface WheelLike {
  deltaY: number;
  clientX: number;
}

const WHEEL_STEP = 1.2;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 40;
/** Beyond this a press is a drag, not a tap. */
const TAP_SLOP_PX = 4;

/**
 * Pinch, wheel and double-tap, all expressed as "scale the zoom by `factor`
 * about `anchorFraction`". Takes a coordinate mapper rather than a DOM ref so
 * the caller decides what 0..1 means and this stays independently testable.
 */
export default function useZoomGestures(
  xToFraction: (clientX: number) => number,
  onZoomAt: (factor: number, anchorFraction: number) => void,
) {
  const points = useRef(new Map<number, number>());
  const pinchDist = useRef<number | null>(null);
  const [pinching, setPinching] = useState(false);
  const lastTap = useRef<{ at: number; x: number } | null>(null);
  const pressed = useRef<{ x: number; moved: boolean } | null>(null);

  const gap = () => {
    const [a, b] = [...points.current.values()];
    return a === undefined || b === undefined ? null : { dist: Math.abs(b - a), mid: (a + b) / 2 };
  };

  const pointerDown = useCallback((e: PointerLike) => {
    points.current.set(e.pointerId, e.clientX);
    pressed.current = { x: e.clientX, moved: false };
    if (points.current.size === 2) {
      pinchDist.current = gap()?.dist ?? null;
      setPinching(true);
    }
  }, []);

  const pointerMove = useCallback((e: PointerLike) => {
    if (points.current.has(e.pointerId)) points.current.set(e.pointerId, e.clientX);
    if (pressed.current && Math.abs(e.clientX - pressed.current.x) > TAP_SLOP_PX) {
      pressed.current.moved = true;
    }
    if (points.current.size !== 2) return;
    const g = gap();
    if (!g || !pinchDist.current || g.dist === 0) return;
    onZoomAt(g.dist / pinchDist.current, xToFraction(g.mid));
    pinchDist.current = g.dist;
  }, [onZoomAt, xToFraction]);

  const pointerUp = useCallback((e: PointerLike) => {
    points.current.delete(e.pointerId);
    if (points.current.size < 2) {
      pinchDist.current = null;
      setPinching(false);
    }

    // A tap that ended a pinch is not a double-tap candidate.
    const wasTap = pressed.current?.moved === false && !pinching;
    pressed.current = null;
    if (!wasTap) return;

    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.at < DOUBLE_TAP_MS && Math.abs(e.clientX - prev.x) < DOUBLE_TAP_SLOP_PX) {
      lastTap.current = null;
      onZoomAt(2, xToFraction(e.clientX));
    } else {
      lastTap.current = { at: now, x: e.clientX };
    }
  }, [onZoomAt, xToFraction, pinching]);

  const wheel = useCallback((e: WheelLike) => {
    onZoomAt(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, xToFraction(e.clientX));
  }, [onZoomAt, xToFraction]);

  return { pinching, pointerDown, pointerMove, pointerUp, wheel };
}
