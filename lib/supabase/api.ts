import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { verifyMintedBearer } from '@/lib/auth/verify-bearer';

/**
 * Supabase client for API routes that the mobile apps call.
 *
 * The web app authenticates with cookies; the mobile apps send
 * `Authorization: Bearer <supabase access token>`. When a bearer token is
 * present it wins: auth is validated against that token and every PostgREST
 * query carries it, so RLS behaves exactly as it does for a cookie session.
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

  // Platform-minted tokens (Clerk exchange) verify locally — no GoTrue round
  // trip, and PostgREST still receives the same bearer for RLS. Ordinary
  // Supabase session tokens fall through to the usual lookup.
  if (token) {
    const minted = await verifyMintedBearer(token);
    if (minted) {
      const user = {
        id: minted.id,
        aud: 'authenticated',
        role: 'authenticated',
        phone: minted.phone ?? undefined,
        email: minted.email ?? undefined,
        app_metadata: { provider: 'clerk' },
        user_metadata: {},
        created_at: '',
      } as unknown as User;
      return { supabase, user };
    }
  }

  const { data, error } = token
    ? await supabase.auth.getUser(token)
    : await supabase.auth.getUser();

  return { supabase, user: error ? null : data.user };
}
