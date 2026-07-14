import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { isClerkToken, resolveClerkBearer } from '@/lib/auth/clerk';

/**
 * Supabase client for API routes that the mobile apps call.
 *
 * The web app authenticates with cookies; the mobile apps send
 * `Authorization: Bearer <token>` — a Clerk session JWT (Supabase accepts it
 * natively via third-party auth, and RLS resolves it through
 * public.app_user_id()) or an ordinary Supabase access token. When a bearer
 * is present it wins: auth is validated against that token and every
 * PostgREST query carries it, so RLS behaves exactly as it does for a
 * cookie session.
 */
export async function createApiClient(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase environment variables are not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.'
    );
  }

  const bearer = request.headers.get('authorization') ?? undefined;
  const token = bearer?.replace(/^bearer\s+/i, '');
  const cookieStore = await cookies();

  const supabase = createServerClient(url, key, {
    ...(bearer ? { global: { headers: { Authorization: bearer } } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component — middleware refreshes sessions.
        }
      },
    },
  });

  // Clerk session tokens resolve to their shadow Supabase user; PostgREST
  // still receives the Clerk bearer itself, which RLS understands via
  // public.app_user_id(). Ordinary Supabase tokens use the GoTrue lookup.
  if (token && isClerkToken(token)) {
    const user = await resolveClerkBearer(token);
    return { supabase, user };
  }

  const { data, error } = token
    ? await supabase.auth.getUser(token)
    : await supabase.auth.getUser();

  return { supabase, user: error ? null : data.user };
}
