import { describe, expect, it } from 'vitest';
import { resolveWorkerUrl } from '../qstash';

describe('resolveWorkerUrl', () => {
  it('prefers the canonical site URL over per-deployment hosts', () => {
    expect(
      resolveWorkerUrl({
        NEXT_PUBLIC_SITE_URL: 'https://www.takememobility.com',
        VERCEL_URL: 'takeme-mobility-abc123-quantumlabsio.vercel.app',
        NEXT_PUBLIC_VERCEL_URL: 'takeme-mobility-abc123-quantumlabsio.vercel.app',
      }),
    ).toBe('https://www.takememobility.com/api/dispatch/worker');
  });

  it('never targets a deployment-protected host when a production URL exists', () => {
    const url = resolveWorkerUrl({
      VERCEL_PROJECT_PRODUCTION_URL: 'www.takememobility.com',
      VERCEL_URL: 'takeme-mobility-abc123-quantumlabsio.vercel.app',
    });
    expect(url).toBe('https://www.takememobility.com/api/dispatch/worker');
    expect(url).not.toContain('quantumlabsio.vercel.app');
  });

  it('normalizes the apex to www — a 308-redirected POST loses the delivery', () => {
    expect(resolveWorkerUrl({ NEXT_PUBLIC_SITE_URL: 'https://takememobility.com' })).toBe(
      'https://www.takememobility.com/api/dispatch/worker',
    );
    expect(resolveWorkerUrl({ NEXT_PUBLIC_SITE_URL: 'https://takememobility.com/' })).toBe(
      'https://www.takememobility.com/api/dispatch/worker',
    );
  });

  it('falls back to the deployment host only when nothing better exists', () => {
    expect(resolveWorkerUrl({ VERCEL_URL: 'preview-abc.vercel.app' })).toBe(
      'https://preview-abc.vercel.app/api/dispatch/worker',
    );
  });

  it('returns null when no host is known (local dev — dispatch runs inline)', () => {
    expect(resolveWorkerUrl({})).toBeNull();
  });
});
