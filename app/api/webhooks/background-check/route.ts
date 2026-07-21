import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { mapProviderStatus } from '@/lib/onboarding/background-check';
import { logEvent } from '@/lib/onboarding/service';
import { pushTokenForUser, sendPushNotification } from '@/lib/push';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/webhooks/background-check — screening-provider callbacks.
// HMAC-SHA256 signature verification (X-Checkr-Signature format), replay-safe
// idempotency via the background_check_events unique (provider, event_id),
// and internal-state mapping. Sensitive report content is never stored —
// only lifecycle status.
// ═══════════════════════════════════════════════════════════════════════════

function verifySignature(rawBody: string, signature: string | null): boolean {
  // Checkr signs webhooks with HMAC-SHA256 keyed by the account API key.
  // A dedicated BACKGROUND_CHECK_WEBHOOK_SECRET (if set) takes precedence so
  // a future provider with its own signing secret needs no code change.
  const secret =
    process.env.BACKGROUND_CHECK_WEBHOOK_SECRET ?? process.env.CHECKR_API_KEY;
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ProviderEvent {
  id: string;
  type: string;
  data?: {
    object?: {
      id?: string;
      candidate_id?: string;
      status?: string;
      result?: string;
    };
  };
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-checkr-signature');
  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: ProviderEvent;
  try {
    event = JSON.parse(rawBody) as ProviderEvent;
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }
  if (!event.id || !event.type) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const svc = createServiceClient();

  // Idempotency claim BEFORE handling; released if handling fails so the
  // provider's retry is not silently swallowed.
  const { error: claimError } = await svc.from('background_check_events').insert({
    provider: 'checkr',
    event_id: event.id,
    event_type: event.type,
    // Store only lifecycle fields — never report details.
    payload: {
      objectId: event.data?.object?.id ?? null,
      candidateId: event.data?.object?.candidate_id ?? null,
      status: event.data?.object?.status ?? null,
      result: event.data?.object?.result ?? null,
    },
  });
  if (claimError) {
    if (claimError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    return NextResponse.json({ error: 'Storage failure' }, { status: 500 });
  }

  try {
    const candidateId = event.data?.object?.candidate_id ?? event.data?.object?.id;
    const mapped = mapProviderStatus(
      event.type,
      event.data?.object?.result ?? event.data?.object?.status,
    );

    if (candidateId && mapped) {
      const { data: caseRow } = await svc
        .from('background_check_cases')
        .select('id, user_id, application_id, status')
        .eq('provider', 'checkr')
        .eq('provider_case_id', candidateId)
        .maybeSingle();

      if (caseRow && caseRow.status !== mapped) {
        await svc
          .from('background_check_cases')
          .update({
            status: mapped,
            completed_at: ['clear', 'consider', 'adverse_final'].includes(mapped)
              ? new Date().toISOString()
              : null,
          })
          .eq('id', caseRow.id);
        await svc
          .from('background_check_events')
          .update({ case_id: caseRow.id, processed_at: new Date().toISOString() })
          .eq('provider', 'checkr')
          .eq('event_id', event.id);
        await logEvent(svc, {
          applicationId: caseRow.application_id,
          userId: caseRow.user_id,
          actor: 'provider',
          event: 'background_check_status',
          detail: { from: caseRow.status, to: mapped, eventType: event.type },
        });

        // Nudge the driver back into the app for meaningful transitions.
        if (['clear', 'candidate_action', 'info_required', 'consider'].includes(mapped)) {
          const token = await pushTokenForUser(caseRow.user_id, 'driver');
          if (token) {
            await sendPushNotification({
              to: token,
              title: 'Background check update',
              body:
                mapped === 'clear'
                  ? 'Your background check is complete.'
                  : 'Your background check needs your attention.',
              data: { type: 'onboarding_update', requirementKey: 'background_check' },
            });
          }
        }
      }
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    // Release the idempotency claim so the provider retry can succeed.
    await svc
      .from('background_check_events')
      .delete()
      .eq('provider', 'checkr')
      .eq('event_id', event.id);
    console.error('[bgc webhook] handling failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Handling failed' }, { status: 500 });
  }
}
