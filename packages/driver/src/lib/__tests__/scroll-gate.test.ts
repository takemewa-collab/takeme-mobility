import { describe, expect, it } from 'vitest';
import { reachedEnd, scrollProgress, SCROLL_END_TOLERANCE } from '../scroll-gate';

describe('reachedEnd', () => {
  it('is false before any layout is known (never enables early)', () => {
    expect(reachedEnd({ offsetY: 0, viewportH: 0, contentH: 0 })).toBe(false);
    expect(reachedEnd({ offsetY: 0, viewportH: 600, contentH: 0 })).toBe(false);
    expect(reachedEnd({ offsetY: 0, viewportH: 0, contentH: 2000 })).toBe(false);
  });

  it('short documents that fit the viewport count as read immediately', () => {
    expect(reachedEnd({ offsetY: 0, viewportH: 600, contentH: 400 })).toBe(true);
    expect(reachedEnd({ offsetY: 0, viewportH: 600, contentH: 600 })).toBe(true);
  });

  it('uses a tolerance band, not exact pixel equality', () => {
    // The regression that shipped: a flick's last throttled event lands
    // short of the true bottom. Within tolerance must still count.
    const contentH = 2000;
    const viewportH = 600;
    const nearBottom = contentH - viewportH - (SCROLL_END_TOLERANCE - 1);
    expect(reachedEnd({ offsetY: nearBottom, viewportH, contentH })).toBe(true);
    const farFromBottom = contentH - viewportH - (SCROLL_END_TOLERANCE + 40);
    expect(reachedEnd({ offsetY: farFromBottom, viewportH, contentH })).toBe(false);
  });

  it('overscroll past the bottom (iOS bounce) counts as reached', () => {
    expect(reachedEnd({ offsetY: 1450, viewportH: 600, contentH: 2000 })).toBe(true);
  });

  it('midway through a long document is not the end', () => {
    expect(reachedEnd({ offsetY: 500, viewportH: 600, contentH: 3000 })).toBe(false);
  });
});

describe('scrollProgress', () => {
  it('reports 0 before layout and 1 for short documents', () => {
    expect(scrollProgress({ offsetY: 0, viewportH: 0, contentH: 0 })).toBe(0);
    expect(scrollProgress({ offsetY: 0, viewportH: 600, contentH: 300 })).toBe(1);
  });

  it('grows monotonically and clamps to [0, 1]', () => {
    const at = (offsetY: number) => scrollProgress({ offsetY, viewportH: 600, contentH: 2400 });
    expect(at(0)).toBeCloseTo(0.25);
    expect(at(600)).toBeCloseTo(0.5);
    expect(at(1800)).toBe(1);
    expect(at(5000)).toBe(1); // bounce overscroll never exceeds 1
  });
});
