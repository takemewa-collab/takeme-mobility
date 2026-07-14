import { createClerkClient, verifyToken } from '@clerk/backend';
import type { User } from '@supabase/supabase-js';

import { createServiceClient } from '@/lib/supabase/service';

/**
 * Clerk → Supabase bridge (native third-party auth).
 *
 * Clerk owns identity and OTP delivery (real SMS, no Twilio) and is
 * registered as a third-party auth provider on the Supabase project, so
 * PostgREST and realtime accept Clerk session tokens directly — no minted
 * JWTs. Everything else — RLS on every table, the Stripe customer mapping,
 * dispatch — is keyed on Supabase auth user ids, so each Clerk identity maps
 * to a shadow Supabase user via `clerk_links` (created on first sign-in;
 * pre-Clerk accounts are matched by phone/email and keep their history).
 * In SQL the mapping is resolved by `public.app_user_id()`.
 *
 * Requires env: CLERK_SECRET_KEY (server only — never in a client bundle).
 */

export type ClerkIdentity = {
  clerkId: string;
  phone: string | null;
  email: string | null;
  fullName: string | null;
};

function clerkClient() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not configured');
  return createClerkClient({ secretKey });
}

/** True when the bearer looks like a Clerk session JWT (issuer check only —
 *  cryptographic verification happens in verifyClerkToken). */
export function isClerkToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return typeof payload.iss === 'string' && /^https:\/\/clerk\./.test(payload.iss);
  } catch {
    return false;
  }
}

/** Verifies the Clerk session JWT signature and returns its subject. */
export async function verifyClerkToken(token: string): Promise<string | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not configured');
  try {
    const payload = await verifyToken(token, { secretKey });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/** Loads the person's contact identity from the Clerk API. */
export async function loadClerkIdentity(clerkId: string): Promise<ClerkIdentity> {
  const user = await clerkClient().users.getUser(clerkId);
  const phone =
    user.phoneNumbers.find((p) => p.id === user.primaryPhoneNumberId)?.phoneNumber ??
    user.phoneNumbers[0]?.phoneNumber ??
    null;
  const email =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    null;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;

  return { clerkId, phone, email, fullName };
}

/**
 * The Supabase auth user this Clerk identity maps to, created on first
 * sign-in. Match order: existing link → same phone → same email → new user.
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

// Warm-lambda caches: Clerk sub → shadow uuid, and uuid → auth user record.
// TTL keeps deletions and contact changes from staying stale for long.
const CACHE_TTL_MS = 5 * 60 * 1000;
const subToUserId = new Map<string, { userId: string; expires: number }>();
const userById = new Map<string, { user: User; expires: number }>();

/**
 * Resolves a verified Clerk bearer to the shadow Supabase auth user record.
 * Returns null when the token doesn't verify. Creates the shadow user (and
 * link) on the first request that carries a fresh Clerk identity.
 */
export async function resolveClerkBearer(token: string): Promise<User | null> {
  const sub = await verifyClerkToken(token);
  if (!sub) return null;

  const now = Date.now();
  const cachedSub = subToUserId.get(sub);
  let userId = cachedSub && cachedSub.expires > now ? cachedSub.userId : null;

  if (!userId) {
    const supabase = createServiceClient();
    const { data: link } = await supabase
      .from('clerk_links')
      .select('user_id')
      .eq('clerk_id', sub)
      .maybeSingle();
    userId = (link?.user_id as string | undefined) ?? null;

    if (!userId) {
      const identity = await loadClerkIdentity(sub);
      userId = await ensureShadowUser(identity);
    }
    subToUserId.set(sub, { userId, expires: now + CACHE_TTL_MS });
  }

  const cachedUser = userById.get(userId);
  if (cachedUser && cachedUser.expires > now) return cachedUser.user;

  const svc = createServiceClient();
  const { data, error } = await svc.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  userById.set(userId, { user: data.user, expires: now + CACHE_TTL_MS });
  return data.user;
}

/** Removes the Clerk side of an identity during account deletion. */
export async function deleteClerkUser(clerkId: string): Promise<void> {
  await clerkClient().users.deleteUser(clerkId);
}
