import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import {
  createExpressLoginLink,
  createOnboardingLink,
  getConnectAccountStatus,
  getOrCreateConnectAccount,
} from '@/lib/driver-payouts';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/payouts/account-link
//   mode 'onboard' → Stripe-hosted Express onboarding (KYC + destination).
//   mode 'manage'  → Express dashboard login link (change payout destination).
//
// Identity & reauthentication: the bearer is a Clerk session token with a
// 60-second lifetime, so every link request is proven fresh by construction;
// the account is looked up ONLY through the caller's own wallet row, so a
// driver can never obtain a link to someone else's Stripe account. All KYC
// and bank/card entry happens on Stripe-hosted surfaces — no sensitive
// details ever transit or persist on TAKEME systems.
// ═══════════════════════════════════════════════════════════════════════════

const schema = z.object({ mode: z.enum(['onboard', 'manage']) });

export async function POST(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();
    const { data: driver } = await svc
      .from('drivers')
      .select('id, is_active, is_verified')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    // Payout accounts are for activated drivers only.
    if (!driver || !driver.is_active || !driver.is_verified) {
      return NextResponse.json({ error: 'Not an active driver' }, { status: 403 });
    }

    const body = schema.parse(await request.json());

    // Safe diagnostics only: driver row id + account id SUFFIX + step
    // outcomes. Never the Account Link URL, never full identifiers.
    const tag = `[payout-onboarding] driver=${driver.id}`;

    let accountId: string;
    try {
      accountId = await getOrCreateConnectAccount(user.id);
      console.log(`${tag} account=…${accountId.slice(-6)} ensure=ok`);
    } catch (createErr) {
      // The precise root cause the app must surface — most commonly Stripe
      // Connect not being enabled for the platform account.
      const message = createErr instanceof Error ? createErr.message : String(createErr);
      console.error(`${tag} ensure=FAILED reason="${message}"`);
      const notEnrolled = /sign(ed)? up for connect/i.test(message);
      return NextResponse.json(
        {
          error: notEnrolled
            ? 'Payouts are not available yet — the platform payout system is still being enabled.'
            : 'Could not start payout setup. Try again shortly.',
          code: notEnrolled ? 'connect_not_enabled' : 'account_create_failed',
        },
        { status: 503 },
      );
    }

    try {
      if (body.mode === 'manage') {
        const status = await getConnectAccountStatus(accountId);
        if (!status.detailsSubmitted) {
          // Can't manage an account that was never onboarded — send them there.
          const url = await createOnboardingLink(accountId);
          console.log(`${tag} account=…${accountId.slice(-6)} link=onboard result=ok`);
          return NextResponse.json({ url, mode: 'onboard' });
        }
        const url = await createExpressLoginLink(accountId);
        console.log(`${tag} account=…${accountId.slice(-6)} link=manage result=ok`);
        return NextResponse.json({ url, mode: 'manage' });
      }

      const url = await createOnboardingLink(accountId);
      console.log(`${tag} account=…${accountId.slice(-6)} link=onboard result=ok`);
      return NextResponse.json({ url, mode: 'onboard' });
    } catch (linkErr) {
      const message = linkErr instanceof Error ? linkErr.message : String(linkErr);
      console.error(`${tag} account=…${accountId.slice(-6)} link=FAILED reason="${message}"`);
      return NextResponse.json(
        { error: 'Could not open payout setup. Try again shortly.', code: 'account_link_failed' },
        { status: 503 },
      );
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    console.error('POST /api/driver/payouts/account-link failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
