/**
 * Read-to-the-end detection for gated documents (agreements, disclosures).
 *
 * Pure and unit-tested because the naive in-component version shipped a
 * production deadlock: it compared a single throttled onScroll event against
 * an almost-exact pixel boundary. On a real iPhone a fast flick's LAST
 * scroll event can land tens of points short of the rest position (the
 * throttle drops the endpoint, and the final settle only fires
 * onMomentumScrollEnd, which nobody listened to) — so the end was never
 * "reached" and Accept stayed disabled forever.
 *
 * Rules encoded here:
 * - generous tolerance, never exact pixel equality;
 * - short documents (content fits the viewport) count as read immediately,
 *   regardless of the order layout/content-size callbacks fire in;
 * - callers keep the result sticky: once reached, scrolling back up never
 *   revokes it (that is the caller's state, fed by `reachedEnd`).
 */

export interface ScrollMetrics {
  /** Current scroll offset (contentOffset.y). */
  offsetY: number;
  /** Visible viewport height (layoutMeasurement.height). */
  viewportH: number;
  /** Total content height (contentSize.height). */
  contentH: number;
}

/** Points of slack before the true bottom that still count as "the end". */
export const SCROLL_END_TOLERANCE = 56;

export function reachedEnd(
  { offsetY, viewportH, contentH }: ScrollMetrics,
  tolerance: number = SCROLL_END_TOLERANCE,
): boolean {
  if (viewportH <= 0 || contentH <= 0) return false;
  // Fits without scrolling — nothing to reach.
  if (contentH <= viewportH + 1) return true;
  return offsetY + viewportH >= contentH - tolerance;
}

/** 0..1 reading progress for a visible progress indicator. */
export function scrollProgress({ offsetY, viewportH, contentH }: ScrollMetrics): number {
  if (viewportH <= 0 || contentH <= 0) return 0;
  if (contentH <= viewportH + 1) return 1;
  const progress = (offsetY + viewportH) / contentH;
  return Math.min(1, Math.max(0, progress));
}
