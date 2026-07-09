import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/service';
import { requireAdmin } from '@/lib/admin-auth';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/approve
//
// Admin endpoint: approves a driver application and provisions the driver.
// Creates driver record, vehicle, wallet, and optionally triggers card.
//
// In production, protect this with an admin API key or admin role check.
// ═══════════════════════════════════════════════════════════════════════════

const schema = z.object({
  applicationId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    // Admin-only: approving a driver provisions a real Stripe cardholder + cards.
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const body = schema.parse(await request.json());
    const svc = createServiceClient();

    // Get application
    const { data: app } = await svc
      .from('driver_applications')
      .select('id, status, user_id, full_name')
      .eq('id', body.applicationId)
      .single();

    if (!app) return NextResponse.json({ error: 'Application not found' }, { status: 404 });
    if (app.status === 'approved') return NextResponse.json({ error: 'Already approved' }, { status: 409 });

    // Approve
    await svc.from('driver_applications').update({
      status: 'approved',
      approved_at: new Date().toISOString(),
    }).eq('id', body.applicationId);

    // Provision driver via RPC
    const { data: driverId, error: provisionErr } = await svc.rpc('provision_approved_driver', {
      p_application_id: body.applicationId,
    });

    if (provisionErr) {
      console.error('[driver/approve] Provision failed:', provisionErr);
      return NextResponse.json({ error: provisionErr.message }, { status: 500 });
    }

    // Trigger full card provisioning (non-blocking, feature-flagged)
    try {
      const { createCardholder, createVirtualCard, createPhysicalCard, isIssuingEnabled } = await import('@/lib/stripe-issuing');
      const appData = await svc.from('driver_applications').select('*').eq('id', body.applicationId).single();

      if (appData.data) {
        // 1. Create cardholder
        const ch = await createCardholder({
          name: appData.data.full_name,
          email: appData.data.email || '',
          phone: appData.data.phone,
          userId: appData.data.user_id,
        });

        // 2. Issue virtual card with spending limits ($500/day, $5K/month, $200/tx)
        const virtualCard = await createVirtualCard(ch.id, appData.data.user_id);

        // 3. Order physical card to driver's address (if we have address data)
        let physicalCard: { id: string; last4: string; status: string } | null = null;
        const hasAddress = appData.data.address_line1 || appData.data.city;
        if (hasAddress) {
          physicalCard = await createPhysicalCard(ch.id, appData.data.user_id, {
            name: appData.data.full_name,
            line1: appData.data.address_line1 || '1 TakeMe Way',
            city: appData.data.city || 'Seattle',
            state: appData.data.state || 'WA',
            postalCode: appData.data.postal_code || '98101',
          });
        }

        // 4. Store in driver_cards
        await svc.from('driver_cards').upsert({
          driver_id: appData.data.user_id,
          stripe_cardholder_id: ch.id,
          stripe_virtual_card_id: virtualCard.id,
          stripe_physical_card_id: physicalCard?.id ?? null,
          card_status: 'virtual_ready',
          shipping_status: physicalCard ? 'pending' : 'none',
        }, { onConflict: 'driver_id' });

        console.log(`[driver/approve] Card provisioned: virtual=${virtualCard.id}, physical=${physicalCard?.id ?? 'none'}, issuing_enabled=${isIssuingEnabled()}`);
      }
    } catch (cardErr) {
      console.warn('[driver/approve] Card creation failed (non-fatal):', cardErr);
    }

    return NextResponse.json({
      approved: true,
      driverId,
      applicationId: body.applicationId,
    });
  } catch (err) {
    console.error('[driver/approve]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Approval failed' }, { status: 500 });
  }
}
