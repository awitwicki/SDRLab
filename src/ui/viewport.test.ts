import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  clampViewport,
  visibleSpan,
  viewportFractions,
  zoomAtAnchor,
  panByHz,
  fractionToOffsetHz,
  offsetHzToFraction,
  type ViewportState,
} from './viewport';

const SR = 2e6;
const full: ViewportState = { zoom: 1, centerOffset: 0 };

describe('visibleSpan', () => {
  it('is the whole captured span at 1x', () => {
    expect(visibleSpan(full, SR)).toBe(SR);
  });

  it('halves each time the zoom doubles', () => {
    expect(visibleSpan({ zoom: 2, centerOffset: 0 }, SR)).toBe(SR / 2);
    expect(visibleSpan({ zoom: 8, centerOffset: 0 }, SR)).toBe(SR / 8);
  });
});

describe('clampViewport', () => {
  it('pins the offset to zero at 1x, where there is nowhere to pan', () => {
    expect(clampViewport({ zoom: 1, centerOffset: 400e3 }, SR).centerOffset).toBe(0);
  });

  it('refuses to zoom out past the captured span', () => {
    expect(clampViewport({ zoom: 0.25, centerOffset: 0 }, SR).zoom).toBe(1);
  });

  it('refuses to zoom in past the maximum', () => {
    expect(clampViewport({ zoom: 99, centerOffset: 0 }, SR).zoom).toBe(MAX_ZOOM);
  });

  it('keeps the view inside the captured span at the right edge', () => {
    // At 4x the view is 500 kHz wide, so its centre cannot exceed 750 kHz.
    expect(clampViewport({ zoom: 4, centerOffset: 900e3 }, SR).centerOffset).toBe(750e3);
  });

  it('keeps the view inside the captured span at the left edge', () => {
    expect(clampViewport({ zoom: 4, centerOffset: -900e3 }, SR).centerOffset).toBe(-750e3);
  });

  it('leaves a viewport that already fits untouched', () => {
    const v = { zoom: 4, centerOffset: 100e3 };
    expect(clampViewport(v, SR)).toEqual(v);
  });
});

describe('viewportFractions', () => {
  it('covers the whole span at 1x', () => {
    expect(viewportFractions(full, SR)).toEqual({ startFraction: 0, spanFraction: 1 });
  });

  it('describes a centred half-width window at 2x', () => {
    expect(viewportFractions({ zoom: 2, centerOffset: 0 }, SR))
      .toEqual({ startFraction: 0.25, spanFraction: 0.5 });
  });

  it('shifts with the centre offset', () => {
    // 2x centred at +500 kHz spans 0 Hz..+1 MHz, i.e. the top half.
    expect(viewportFractions({ zoom: 2, centerOffset: 500e3 }, SR))
      .toEqual({ startFraction: 0.5, spanFraction: 0.5 });
  });
});

describe('zoomAtAnchor', () => {
  it('keeps the frequency under the anchor fixed while zooming in', () => {
    const before = fractionToOffsetHz(full, 0.75, SR);
    const after = zoomAtAnchor(full, 2, 0.75, SR);
    expect(fractionToOffsetHz(after, 0.75, SR)).toBeCloseTo(before, 6);
  });

  it('keeps the frequency under the anchor fixed while zooming out', () => {
    const start = { zoom: 8, centerOffset: 200e3 };
    const before = fractionToOffsetHz(start, 0.25, SR);
    const after = zoomAtAnchor(start, 0.5, 0.25, SR);
    expect(fractionToOffsetHz(after, 0.25, SR)).toBeCloseTo(before, 6);
  });

  it('zooming about the centre leaves the centre put', () => {
    const after = zoomAtAnchor(full, 4, 0.5, SR);
    expect(after.centerOffset).toBe(0);
    expect(after.zoom).toBe(4);
  });

  it('clamps rather than letting an edge anchor drag the view outside', () => {
    const after = zoomAtAnchor({ zoom: 2, centerOffset: 500e3 }, 0.5, 1, SR);
    expect(after.zoom).toBe(1);
    expect(after.centerOffset).toBe(0);
  });

  it('never exceeds the maximum zoom', () => {
    expect(zoomAtAnchor({ zoom: MAX_ZOOM, centerOffset: 0 }, 4, 0.5, SR).zoom).toBe(MAX_ZOOM);
  });
});

describe('panByHz', () => {
  it('moves the centre by the requested amount', () => {
    expect(panByHz({ zoom: 4, centerOffset: 0 }, 100e3, SR).centerOffset).toBe(100e3);
  });

  it('stops at the edge instead of running off the captured span', () => {
    expect(panByHz({ zoom: 4, centerOffset: 700e3 }, 500e3, SR).centerOffset).toBe(750e3);
  });

  it('does nothing at 1x, where the view already fills the span', () => {
    expect(panByHz(full, 300e3, SR).centerOffset).toBe(0);
  });
});

describe('fraction <-> frequency mapping', () => {
  it('maps the view edges to the captured span at 1x', () => {
    expect(fractionToOffsetHz(full, 0, SR)).toBe(-SR / 2);
    expect(fractionToOffsetHz(full, 1, SR)).toBe(SR / 2);
  });

  it('maps the middle of the view to its centre offset when zoomed', () => {
    const v = { zoom: 4, centerOffset: 300e3 };
    expect(fractionToOffsetHz(v, 0.5, SR)).toBe(300e3);
  });

  it('narrows the mapping as zoom increases', () => {
    // At 4x the view is 500 kHz wide, so the left edge is 250 kHz below centre.
    expect(fractionToOffsetHz({ zoom: 4, centerOffset: 0 }, 0, SR)).toBe(-250e3);
  });

  it('round-trips a frequency back to the same fraction', () => {
    const v = { zoom: 4, centerOffset: 300e3 };
    const hz = fractionToOffsetHz(v, 0.3, SR);
    expect(offsetHzToFraction(v, hz, SR)).toBeCloseTo(0.3, 9);
  });
});
