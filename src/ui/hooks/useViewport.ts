import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampViewport,
  panByHz,
  viewportFractions,
  visibleSpan as spanOf,
  zoomAtAnchor,
  type ViewportState,
} from '../viewport';

const FULL: ViewportState = { zoom: 1, centerOffset: 0 };

/** Owns the display zoom over the captured span. See ../viewport for the math. */
export default function useViewport(sampleRate: number) {
  const [state, setState] = useState<ViewportState>(FULL);

  // The offset is relative to a span that just changed size, so anything but a
  // reset would leave the view somewhere the user never picked.
  const lastRate = useRef(sampleRate);
  useEffect(() => {
    if (lastRate.current !== sampleRate) {
      lastRate.current = sampleRate;
      setState(FULL);
    }
  }, [sampleRate]);

  const zoomAt = useCallback((factor: number, anchorFraction: number) => {
    setState(s => zoomAtAnchor(s, factor, anchorFraction, sampleRate));
  }, [sampleRate]);

  const pan = useCallback((deltaHz: number) => {
    setState(s => panByHz(s, deltaHz, sampleRate));
  }, [sampleRate]);

  /** Absolute counterpart to pan(), matching how the drag handlers work:
   *  they compute a position relative to where the drag began. */
  const panTo = useCallback((centerOffset: number) => {
    setState(s => clampViewport({ zoom: s.zoom, centerOffset }, sampleRate));
  }, [sampleRate]);

  const reset = useCallback(() => setState(FULL), []);

  return useMemo(() => {
    const safe = clampViewport(state, sampleRate);
    return {
      ...safe,
      ...viewportFractions(safe, sampleRate),
      visibleSpan: spanOf(safe, sampleRate),
      zoomAt,
      pan,
      panTo,
      reset,
    };
  }, [state, sampleRate, zoomAt, pan, panTo, reset]);
}
