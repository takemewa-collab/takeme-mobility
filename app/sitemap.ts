import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://takememobility.com';

// Public marketing routes only — no authenticated/operational pages.
const ROUTES = [
  '',
  '/about',
  '/business',
  '/cities',
  '/connect',
  '/contact',
  '/driver',
  '/driver/apply',
  '/fleet',
  '/fleet/apply',
  '/fleet/list-your-ev',
  '/fleet/vehicles',
  '/help',
  '/insurance',
  '/privacy',
  '/rentals',
  '/safety',
  '/students',
  '/technology',
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : 0.7,
  }));
}
