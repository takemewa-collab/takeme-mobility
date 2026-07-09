import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/invariants/check — Cron-triggered invariant checker (every 5 min)
//
// Checks system invariants and logs results to invariant_check_log.
// Alerts on violations.
// ═══════════════════════════════════════════════════════════════════════════

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  details: string;
}

export async function GET(request: Request) {
  if (!verifyInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const svc = createServiceClient();
  const results: CheckResult[] = [];
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();

  // CHECK 1: Orphaned active rides (active with no driver > 5 min)
  try {
    const { data } = await svc
      .from('rides')
      .select('id')
      .eq('status', 'searching_driver')
      .lt('requested_at', fiveMinAgo)
      .is('assigned_driver_id', null)
      .limit(10);

    const count = data?.length ?? 0;
    results.push({
      name: 'orphaned_active_rides',
      status: count > 0 ? 'warn' : 'pass',
      details: count > 0 ? `${count} rides searching > 5 min with no driver` : 'No orphaned rides',
    });
  } catch (e) {
    results.push({ name: 'orphaned_active_rides', status: 'fail', details: (e as Error).message });
  }

  // CHECK 2: Stale payment processing (processing > 10 min)
  try {
    const { data } = await svc
      .from('payment_audit_log')
      .select('id, ride_id')
      .eq('status', 'processing')
      .lt('created_at', tenMinAgo)
      .limit(10);

    const count = data?.length ?? 0;
    if (count > 0) {
      // Auto-resolve: mark as failed
      for (const p of data ?? []) {
        await svc.from('payment_audit_log')
          .update({ status: 'failed', metadata: { auto_resolved: true, reason: 'stale_processing_10m' } })
          .eq('id', p.id);
        // Release Redis lock
        const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
        const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
        if (REDIS_URL && REDIS_TOKEN && p.ride_id) {
          await fetch(`${REDIS_URL}/del/payment:processing:${p.ride_id}`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
          }).catch(() => {});
        }
      }
    }

    results.push({
      name: 'stale_payment_processing',
      status: count > 0 ? 'warn' : 'pass',
      details: count > 0 ? `${count} payments auto-resolved (stale > 10m)` : 'No stale payments',
    });
  } catch (e) {
    results.push({ name: 'stale_payment_processing', status: 'fail', details: (e as Error).message });
  }

  // CHECK 3: Admin role consistency (is_admin=true but role mismatch)
  try {
    const { data } = await svc
      .from('riders')
      .select('id, email, role, is_admin')
      .eq('is_admin', true)
      .not('role', 'in', '("exec_founder","security_owner","super_admin")')
      .limit(10);

    const count = data?.length ?? 0;
    results.push({
      name: 'admin_role_consistency',
      status: count > 0 ? 'fail' : 'pass',
      details: count > 0 ? `${count} users with is_admin=true but non-admin role: ${data?.map(u => u.email).join(', ')}` : 'Admin flags consistent',
    });
  } catch (e) {
    results.push({ name: 'admin_role_consistency', status: 'fail', details: (e as Error).message });
  }

  // CHECK 4: Audit log integrity (count should only increase)
  try {
    const { count: currentCount } = await svc.from('audit_logs').select('*', { count: 'exact', head: true });
    const { data: lastCheck } = await svc.from('invariant_check_log')
      .select('details')
      .eq('check_name', 'audit_log_integrity')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const lastCount = lastCheck?.details ? parseInt(lastCheck.details.split(':')[1] ?? '0', 10) : 0;
    const decreased = lastCount > 0 && (currentCount ?? 0) < lastCount;

    results.push({
      name: 'audit_log_integrity',
      status: decreased ? 'fail' : 'pass',
      details: `count:${currentCount ?? 0}` + (decreased ? ` DECREASED from ${lastCount} — CRITICAL` : ''),
    });

    if (decreased) {
      // Critical alert
      const { auditLog } = await import('@/lib/auth/audit');
      await auditLog({
        action: 'INVARIANT_VIOLATION',
        resource: 'audit_logs',
        success: false,
        riskScore: 95,
        metadata: { previous: lastCount, current: currentCount, violation: 'audit_log_count_decreased' },
      });
    }
  } catch (e) {
    results.push({ name: 'audit_log_integrity', status: 'fail', details: (e as Error).message });
  }

  // CHECK 5: Circuit breaker states
  try {
    const { getAllCircuitStates } = await import('@/lib/invariants/circuitBreaker');
    const states = await getAllCircuitStates();
    const openCircuits = Object.entries(states).filter(([, s]) => s === 'OPEN');

    results.push({
      name: 'circuit_breakers',
      status: openCircuits.length > 0 ? 'warn' : 'pass',
      details: openCircuits.length > 0
        ? `OPEN circuits: ${openCircuits.map(([n]) => n).join(', ')}`
        : 'All circuits closed',
    });
  } catch (e) {
    results.push({ name: 'circuit_breakers', status: 'fail', details: (e as Error).message });
  }

  // CHECK 6: Fleet invariants
  try {
    const { checkFleetInvariants } = await import('@/lib/fleet/invariants');
    const fleetResults = await checkFleetInvariants();
    for (const fr of fleetResults) {
      results.push({ name: fr.name, status: fr.passed ? 'pass' : 'fail', details: fr.details });
    }
  } catch (e) {
    results.push({ name: 'fleet_invariants', status: 'fail', details: (e as Error).message });
  }

  // Save results
  try {
    await svc.from('invariant_check_log').insert(
      results.map(r => ({ check_name: r.name, status: r.status, details: r.details })),
    );
  } catch { /* non-critical */ }

  const failures = results.filter(r => r.status === 'fail');
  const warns = results.filter(r => r.status === 'warn');

  console.log(`[invariants] ${results.length} checks: ${failures.length} fail, ${warns.length} warn, ${results.length - failures.length - warns.length} pass`);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    results,
    summary: { total: results.length, pass: results.length - failures.length - warns.length, warn: warns.length, fail: failures.length },
  });
}
