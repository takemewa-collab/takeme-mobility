import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { checkPermission, getUserRole } from '@/lib/auth/permissions';
import { auditLog } from '@/lib/auth/audit';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';

// ═══════════════════════════════════════════════════════════════════════════
// Zero Trust — API Route Guard
// Server-side enforcement for every API route.
// UI hiding is NOT security.
// ═══════════════════════════════════════════════════════════════════════════

type RouteHandler = (request: NextRequest, context?: unknown) => Promise<NextResponse | Response>;

// Sensitive resources return 404 instead of 403
const STEALTH_RESOURCES = new Set(['security', 'audit_logs', 'ops', 'monitoring']);

export function withPermission(resource: string, action: string): (handler: RouteHandler) => RouteHandler {
  return (handler: RouteHandler) => {
    return async (request: NextRequest, context?: unknown): Promise<NextResponse | Response> => {
      // Allow cron jobs and internal calls — Bearer secret only, never the
      // spoofable x-vercel-cron header (see verifyInternalRequest).
      if (verifyInternalRequest(request)) {
        return handler(request, context);
      }

      // Step 1: Validate Supabase session
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        await auditLog({
          action: 'api_access',
          resource,
          success: false,
          request,
          riskScore: 40,
          metadata: { reason: 'no_session', path: request.nextUrl.pathname },
        });
        return STEALTH_RESOURCES.has(resource)
          ? new NextResponse(null, { status: 404 })
          : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // Step 2: Check role permissions
      const perm = await checkPermission(user.id, resource, action);

      if (!perm.allowed) {
        const role = await getUserRole(user.id);
        await auditLog({
          userId: user.id,
          userEmail: user.email,
          userRole: role ?? undefined,
          action: `api_${action}`,
          resource,
          success: false,
          request,
          riskScore: 50,
          metadata: { reason: perm.reason, path: request.nextUrl.pathname },
        });
        return STEALTH_RESOURCES.has(resource)
          ? new NextResponse(null, { status: 404 })
          : NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
      }

      // Step 3: Check IP allowlist for sensitive resources
      if (STEALTH_RESOURCES.has(resource)) {
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
        const svc = createServiceClient();
        const { data: allowlist } = await svc
          .from('ip_allowlist')
          .select('ip_cidr')
          .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

        if (allowlist && allowlist.length > 0) {
          const allowed = allowlist.some((entry) => ipMatchesCIDR(ip, entry.ip_cidr));
          if (!allowed) {
            const role = await getUserRole(user.id);
            await auditLog({
              userId: user.id,
              userEmail: user.email,
              userRole: role ?? undefined,
              action: `api_${action}`,
              resource,
              success: false,
              request,
              riskScore: 80,
              metadata: { reason: 'ip_not_in_allowlist', ip, path: request.nextUrl.pathname },
            });
            return new NextResponse(null, { status: 404 });
          }
        }
      }

      // Step 4: Log successful access
      const role = await getUserRole(user.id);
      await auditLog({
        userId: user.id,
        userEmail: user.email,
        userRole: role ?? undefined,
        action: `api_${action}`,
        resource,
        success: true,
        request,
      });

      // Step 5: Call handler
      return handler(request, context);
    };
  };
}

// Simple CIDR matching (supports /32 exact match and basic subnets)
function ipMatchesCIDR(ip: string, cidr: string): boolean {
  if (cidr === ip || cidr === `${ip}/32`) return true;

  const [cidrIP, bits] = cidr.split('/');
  if (!bits) return ip === cidr;

  const mask = parseInt(bits, 10);
  if (isNaN(mask)) return false;

  const ipNum = ipToNumber(ip);
  const cidrNum = ipToNumber(cidrIP);
  if (ipNum === null || cidrNum === null) return false;

  const maskBits = (0xFFFFFFFF << (32 - mask)) >>> 0;
  return (ipNum & maskBits) === (cidrNum & maskBits);
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    result = (result << 8) + n;
  }
  return result >>> 0;
}
