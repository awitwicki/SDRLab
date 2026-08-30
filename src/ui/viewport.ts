// Display-only zoom over the captured span. The device still captures the
// full sample rate; this just selects which slice of it the spectrum,
// waterfall and frequency axis draw, so nothing here retunes hardware.

export const MAX_ZOOM = 8;

export interface ViewportState {
  /** 1 = the whole captured span, MAX_ZOOM = the tightest view. */
  zoom: number;
  /** Centre of the view, in Hz relative to the hardware centre frequency. */
  centerOffset: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function visibleSpan(v: ViewportState, sampleRate: number): number {
  return sampleRate / v.zoom;
}

/** Holds the view inside the captured span; at 1x that forces the offset to 0. */
export function clampViewport(v: ViewportState, sampleRate: number): ViewportState {
  const zoom = clamp(v.zoom, 1, MAX_ZOOM);
  const half = sampleRate / zoom / 2;
  const limit = sampleRate / 2 - half;
  return { zoom, centerOffset: clamp(v.centerOffset, -limit, limit) };
}

/** The view as a 0..1 window over the captured span, as the shaders want it. */
export function viewportFractions(v: ViewportState, sampleRate: number) {
  const spanFraction = 1 / v.zoom;
  const startFraction = (v.centerOffset + sampleRate / 2) / sampleRate - spanFraction / 2;
  return { startFraction, spanFraction };
}

/** Frequency offset at a 0..1 position across the *visible* view. */
export function fractionToOffsetHz(v: ViewportState, fraction: number, sampleRate: number): number {
  const span = visibleSpan(v, sampleRate);
  return v.centerOffset - span / 2 + fraction * span;
}

/** Inverse of fractionToOffsetHz. */
export function offsetHzToFraction(v: ViewportState, offsetHz: number, sampleRate: number): number {
  const span = visibleSpan(v, sampleRate);
  return (offsetHz - (v.centerOffset - span / 2)) / span;
}

/**
 * Scales the zoom while pinning the frequency under `anchorFraction` (0..1
 * across the visible view), so a pinch or wheel keeps the signal under the
 * fingers or cursor in place.
 */
export function zoomAtAnchor(
  v: ViewportState,
  factor: number,
  anchorFraction: number,
  sampleRate: number,
): ViewportState {
  const anchorHz = fractionToOffsetHz(v, anchorFraction, sampleRate);
  const zoom = clamp(v.zoom * factor, 1, MAX_ZOOM);
  const span = sampleRate / zoom;
  // Put the anchor frequency back under the same fraction at the new width.
  const centerOffset = anchorHz - anchorFraction * span + span / 2;
  return clampViewport({ zoom, centerOffset }, sampleRate);
}

export function panByHz(v: ViewportState, deltaHz: number, sampleRate: number): ViewportState {
  return clampViewport({ zoom: v.zoom, centerOffset: v.centerOffset + deltaHz }, sampleRate);
}
