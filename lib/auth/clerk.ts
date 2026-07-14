import { createClerkClient, verifyToken } from '@clerk/backend';
import { SignJWT } from 'jose';

import { createServiceClient } from '@/lib/supabase/service';

/**
 * Clerk → Supabase bridge.
 *
 * Clerk owns identity and OTP delivery (real SMS, no Twilio). Everything
 * downstream — RLS on every table, realtime, the driver app, Stripe customer
 * mapping — is keyed on Supabase auth user ids. So instead of migrating 82
 * tables, we verify the Clerk session here, ensure a shadow Supabase user
 * exists for that person (matched by phone/email so pre-Clerk accounts keep
 * their history), and mint a Supabase-compatible access token for the app.
 *
 * Requires env: CLERK_SECRET_KEY, SUPABASE_JWT_SECRET (legacy HS256 secret
 * from Dashboard → Settings → API; keep it enabled).
 */

const EXCHANGE_TOKEN_TTL_SECONDS = 55 * 60;

export type ClerkIdentity = {
  clerkId: string;
  phone: string | null;
  email: string | null;
  fullName: string | null;
};

/** Verifies the Clerk session JWT and loads the rider's contact identity. */
export async function identifyClerkUser(token: string): Promise<ClerkIdentity | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not configured');

  let sub: string;
  try {
    const payload = await verifyToken(token, { secretKey });
    sub = payload.sub;
  } catch {
    return null;
  }

  const clerk = createClerkClient({ secretKey });
  const user = await clerk.users.getUser(sub);
  const phone =
    user.phoneNumbers.find((p) => p.id === user.primaryPhoneNumberId)?.phoneNumber ??
    user.phoneNumbers[0]?.phoneNumber ??
    null;
  const email =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    null;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;

  return { clerkId: sub, phone, email, fullName };
}

/**
 * The Supabase auth user this Clerk identity maps to, created on first sign-in.
 * Match order: existing link → same phone → same email → brand-new user.
 */
export async function ensureShadowUser(identity: ClerkIdentity): Promise<string> {
  const supabase = createServiceClient();

  const { data: link } = await supabase
    .from('clerk_links')
    .select('user_id')
    .eq('clerk_id', identity.clerkId)
    .maybeSingle();
  if (link?.user_id) return link.user_id as string;

  // Pre-Clerk riders signed up with the same phone/email keep their account.
  let userId: string | null = null;
  if (identity.phone) {
    const { data } = await supabase.rpc('user_id_for_phone', {
      p_phone: identity.phone.replace(/^\+/, ''),
    });
    userId = (data as string | null) ?? null;
  }
  if (!userId && identity.email) {
    const { data } = await supabase.rpc('user_id_for_email', { p_email: identity.email });
    userId = (data as string | null) ?? null;
  }

  if (!userId) {
    const { data: created, error } = await supabase.auth.admin.createUser({
      phone: identity.phone ?? undefined,
      email: identity.email ?? undefined,
      phone_confirm: Boolean(identity.phone),
      email_confirm: Boolean(identity.email),
      user_metadata: identity.fullName ? { full_name: identity.fullName } : undefined,
      app_metadata: { provider: 'clerk' },
    });
    if (error || !created.user) {
      throw new Error(`could not create shadow user: ${error?.message}`);
    }
    userId = created.user.id;
  }

  await supabase
    .from('clerk_links')
    .upsert({ clerk_id: identity.clerkId, user_id: userId }, { onConflict: 'clerk_id' });

  return userId;
}

/**
 * A Supabase-compatible access token (HS256, legacy JWT secret): PostgREST,
 * realtime and the platform's own bearer path all accept it, so the rest of
 * the system never learns Clerk exists.
 */
export async function mintSupabaseToken(
  userId: string,
  identity: ClerkIdentity
): Promise<{ token: string; expiresAt: number }> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error('SUPABASE_JWT_SECRET is not configured');

  const expiresAt = Date.now() + EXCHANGE_TOKEN_TTL_SECONDS * 1000;
  const token = await new SignJWT({
    role: 'authenticated',
    phone: identity.phone?.replace(/^\+/, '') ?? '',
    email: identity.email ?? '',
    app_metadata: { provider: 'clerk' },
    user_metadata: identity.fullName ? { full_name: identity.fullName } : {},
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuer(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(new TextEncoder().encode(secret));

  return { token, expiresAt };
}
