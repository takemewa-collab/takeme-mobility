import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/cron/driver-maintenance — daily housekeeping (Vercel Cron):
// document/requirement expiration warnings as REAL driver notifications.
// Deduped per document per 14-day window so a driver is reminded, not
// spammed. Never mutates compliance state — surfacing only.
// ═══════════════════════════════════════════════════════════════════════════

const WARN_WINDOW_DAYS = 30;
const REMIND_EVERY_DAYS = 14;

const DOC_LABELS: Record<string, string> = {
  drivers_license: 'Driver license',
  insurance: 'Insurance',
  vehicle_insurance: 'Insurance',
  vehicle_registration: 'Vehicle registration',
  vehicle_inspection: 'Vehicle inspection',
  background_check: 'Background check',
};

function labelFor(key: string): string {
  return DOC_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export async function GET(request: NextRequest) {
  if (!verifyInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const svc = createServiceClient();
    const now = Date.now();
    const horizon = new Date(now + WARN_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const remindCutoff = new Date(now - REMIND_EVERY_DAYS * 24 * 3600 * 1000).toISOString();

    // Expiring requirements for ACTIVE drivers only.
    const { data: expiring } = await svc
      .from('application_requirements')
      .select('user_id, requirement_key, expires_at')
      .not('expires_at', 'is', null)
      .lte('expires_at', horizon)
      .limit(500);

    let created = 0;
    for (const req of expiring ?? []) {
      const { data: activeDriver } = await svc
        .from('drivers')
        .select('id')
        .eq('auth_user_id', req.user_id)
        .eq('is_active', true)
        .maybeSingle();
      if (!activeDriver) continue;

      // Dedup: skip if we warned about this requirement recently.
      const { data: recent } = await svc
        .from('driver_notifications')
        .select('id')
        .eq('user_id', req.user_id)
        .eq('category', 'document')
        .eq('data->>requirementKey', req.requirement_key)
        .gte('created_at', remindCutoff)
        .limit(1);
      if (recent && recent.length > 0) continue;

      const expiresAt = new Date(req.expires_at as string);
      const expired = expiresAt.getTime() < now;
      const dateStr = expiresAt.toISOString().slice(0, 10);
      const { error } = await svc.from('driver_notifications').insert({
        user_id: req.user_id,
        category: 'document',
        title: expired
          ? `${labelFor(req.requirement_key)} expired`
          : `${labelFor(req.requirement_key)} expires soon`,
        body: expired
          ? `Your ${labelFor(req.requirement_key).toLowerCase()} expired on ${dateStr}. Update it to keep driving.`
          : `Your ${labelFor(req.requirement_key).toLowerCase()} expires on ${dateStr}. Update it before then to keep driving.`,
        data: { requirementKey: req.requirement_key, expiresAt: req.expires_at },
      });
      if (!error) created += 1;
    }

    return NextResponse.json({ checked: expiring?.length ?? 0, notified: created });
  } catch (err) {
    console.error('GET /api/cron/driver-maintenance failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
