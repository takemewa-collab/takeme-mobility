import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';
import {
  getOnboardingBundle,
  latestApplication,
  logEvent,
  toClientState,
} from '@/lib/onboarding/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/driver/onboarding/legal?keys=a,b&locale=en — active versioned
//      legal documents (falls back to 'en' when a locale is missing).
// POST /api/driver/onboarding/legal — record consent for one or more
//      documents. Consent rows are immutable and carry the content hash of
//      the exact text version accepted, plus server + client timestamps.
// ═══════════════════════════════════════════════════════════════════════════

const consentSchema = z
  .object({
    consents: z
      .array(
        z.object({
          key: z.string().min(1).max(64),
          version: z.number().int().min(1),
          locale: z.string().min(2).max(8),
          contentHash: z.string().length(64),
        }),
      )
      .min(1)
      .max(10),
    clientAcceptedAt: z.string().datetime().optional(),
    device: z
      .object({
        platform: z.string().max(16).optional(),
        appVersion: z.string().max(32).optional(),
        osVersion: z.string().max(32).optional(),
        model: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const keys = (url.searchParams.get('keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  const locale = url.searchParams.get('locale') ?? 'en';

  const svc = createServiceClient();
  let query = svc
    .from('legal_documents')
    .select('key, version, locale, title, body, content_hash, requires_scroll, effective_at')
    .eq('active', true)
    .in('locale', locale === 'en' ? ['en'] : [locale, 'en'])
    .order('version', { ascending: false });
  if (keys.length > 0) query = query.in('key', keys);
  const { data } = await query;

  // Latest version per key, preferring the requested locale.
  const byKey = new Map<string, NonNullable<typeof data>[number]>();
  for (const doc of data ?? []) {
    const existing = byKey.get(doc.key);
    if (!existing) {
      byKey.set(doc.key, doc);
      continue;
    }
    const preferExisting =
      existing.version > doc.version ||
      (existing.version === doc.version && existing.locale === locale);
    if (!preferExisting) byKey.set(doc.key, doc);
  }

  return NextResponse.json({
    documents: [...byKey.values()].map((d) => ({
      key: d.key,
      version: d.version,
      locale: d.locale,
      title: d.title,
      body: d.body,
      contentHash: d.content_hash,
      requiresScroll: d.requires_scroll,
      effectiveAt: d.effective_at,
    })),
  });
}

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, 'driver-onboarding');
  if (limited) return limited;

  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = consentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { consents, clientAcceptedAt, device } = parsed.data;

  const svc = createServiceClient();
  const application = await latestApplication(svc, user.id);

  // Validate each consent against the exact stored document version.
  const rows: Array<Record<string, unknown>> = [];
  for (const consent of consents) {
    const { data: doc } = await svc
      .from('legal_documents')
      .select('id, key, version, locale, content_hash, active')
      .eq('key', consent.key)
      .eq('version', consent.version)
      .eq('locale', consent.locale)
      .maybeSingle();
    if (!doc || !doc.active) {
      return NextResponse.json(
        { error: `Document ${consent.key} v${consent.version} is not the current version. Refresh and try again.` },
        { status: 409 },
      );
    }
    if (doc.content_hash !== consent.contentHash) {
      return NextResponse.json(
        { error: 'The document changed since you read it. Please review the new version.' },
        { status: 409 },
      );
    }
    rows.push({
      user_id: user.id,
      application_id: application?.id ?? null,
      legal_document_id: doc.id,
      document_key: doc.key,
      version: doc.version,
      locale: doc.locale,
      content_hash: doc.content_hash,
      client_accepted_at: clientAcceptedAt ?? null,
      device: device ?? {},
    });
  }

  // Idempotent: skip keys already consented at this version.
  const { data: existing } = await svc
    .from('consent_records')
    .select('document_key, version')
    .eq('user_id', user.id);
  const already = new Set((existing ?? []).map((c) => `${c.document_key}:${c.version}`));
  const fresh = rows.filter((r) => !already.has(`${r.document_key}:${r.version}`));

  if (fresh.length > 0) {
    const { error } = await svc.from('consent_records').insert(fresh);
    if (error) {
      return NextResponse.json({ error: 'Could not record consent' }, { status: 500 });
    }
    await logEvent(svc, {
      applicationId: application?.id ?? null,
      userId: user.id,
      actor: 'driver',
      event: 'consents_recorded',
      detail: { keys: fresh.map((r) => `${r.document_key}:${r.version}`) },
    });
  }

  const bundle = await getOnboardingBundle(svc, user.id);
  return NextResponse.json({ state: toClientState(bundle) });
}
