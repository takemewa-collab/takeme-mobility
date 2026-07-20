import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';
import { submitBackgroundCheck } from '@/lib/onboarding/background-check';
import {
  getOnboardingBundle,
  latestApplication,
  logEvent,
  toClientState,
} from '@/lib/onboarding/service';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/onboarding/background-check — start the screening.
// Preconditions: the standalone disclosure and the authorization must both be
// consented (verified server-side against consent_records — tapping Next in
// the app is never treated as consent).
// Sensitive identifiers (SSN, DOB) are collected by the provider's hosted
// flow, never by TAKEME.
// ═══════════════════════════════════════════════════════════════════════════

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, 'driver-onboarding');
  if (limited) return limited;

  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const application = await latestApplication(svc, user.id);
  if (!application || ['rejected', 'suspended'].includes(application.status)) {
    return NextResponse.json({ error: 'No editable application' }, { status: 409 });
  }

  // Disclosure + authorization must be consented at their current versions.
  const requiredKeys = ['background_check_disclosure', 'background_check_authorization'];
  const { data: docs } = await svc
    .from('legal_documents')
    .select('key, version')
    .eq('active', true)
    .in('key', requiredKeys)
    .order('version', { ascending: false });
  const latestVersion = new Map<string, number>();
  for (const d of docs ?? []) {
    if (!latestVersion.has(d.key)) latestVersion.set(d.key, d.version);
  }
  const { data: consents } = await svc
    .from('consent_records')
    .select('document_key, version')
    .eq('user_id', user.id)
    .in('document_key', requiredKeys);
  const consented = new Set((consents ?? []).map((c) => `${c.document_key}:${c.version}`));
  const missing = requiredKeys.filter(
    (k) => !latestVersion.has(k) || !consented.has(`${k}:${latestVersion.get(k)}`),
  );
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Please review and accept the background check disclosures first.', missing },
      { status: 412 },
    );
  }

  // Existing open case → idempotent return.
  const { data: existing } = await svc
    .from('background_check_cases')
    .select('*')
    .eq('application_id', application.id)
    .not('status', 'in', '("adverse_final","expired")')
    .maybeSingle();
  if (existing && !['not_started', 'consent_required', 'disclosure_required', 'provider_unavailable'].includes(existing.status)) {
    const bundle = await getOnboardingBundle(svc, user.id);
    return NextResponse.json({ state: toClientState(bundle), alreadySubmitted: true });
  }

  const { data: market } = application.market_id
    ? await svc.from('onboarding_markets').select('region_code').eq('id', application.market_id).maybeSingle()
    : { data: null };

  const result = await submitBackgroundCheck({
    userId: user.id,
    applicationId: application.id,
    fullName: application.full_name,
    email: application.email,
    phone: application.phone,
    workState: market?.region_code ?? null,
  });

  const caseRow = {
    user_id: user.id,
    application_id: application.id,
    provider: result.provider,
    provider_case_id: result.providerCaseId,
    status: result.status,
    result_summary: result.invitationUrl ? { invitation_url: result.invitationUrl } : null,
    submitted_at: result.status === 'provider_unavailable' ? null : new Date().toISOString(),
  };
  if (existing) {
    await svc.from('background_check_cases').update(caseRow).eq('id', existing.id);
  } else {
    const { error } = await svc.from('background_check_cases').insert(caseRow);
    if (error) {
      return NextResponse.json({ error: 'Could not start background check' }, { status: 500 });
    }
  }

  await logEvent(svc, {
    applicationId: application.id,
    userId: user.id,
    actor: 'driver',
    event: 'background_check_submitted',
    detail: { provider: result.provider, status: result.status },
  });

  const bundle = await getOnboardingBundle(svc, user.id);
  return NextResponse.json({
    state: toClientState(bundle),
    invitationUrl: result.invitationUrl,
    providerUnavailable: result.status === 'provider_unavailable',
  });
}
