import type { NextRequest } from 'next/server';
import type { User, SupabaseClient } from '@supabase/supabase-js';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// Request authentication — works for BOTH callers:
//   • Mobile apps send  Authorization: Bearer <supabase access token>
//   • Web app relies on the cookie session (@supabase/ssr)
// Bearer wins when present. Cookie-only createClient() silently 401s every
// mobile request, so any route the rider/driver apps call must use this.
// ═══════════════════════════════════════════════════════════════════════════

export interface RequestAuth {
  user: User;
  /** RLS-scoped client acting as the authenticated user (NOT service role). */
  supabase: SupabaseClient;
}

function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization');
  return authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;
}

/**
 * Resolve the authenticated user AND an RLS-scoped Supabase client for a
 * request. Returns null when the caller is not authenticated.
 */
export async function getRequestAuth(request: NextRequest): Promise<RequestAuth | null> {
  const token = extractBearerToken(request);

  if (token) {
    const svc = createServiceClient();
    const { data, error } = await svc.auth.getUser(token);
    if (error || !data.user) return null;

    // PostgREST evaluates RLS from the JWT in the Authorization header.
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );
    return { user: data.user, supabase };
  }

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return { user: data.user, supabase };
}

/** Convenience wrapper when only the user identity is needed. */
export async function getRequestUser(request: NextRequest): Promise<User | null> {
  const auth = await getRequestAuth(request);
  return auth?.user ?? null;
}
