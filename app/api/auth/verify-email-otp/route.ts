import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyEmailOTP } from '@/lib/email-otp';
import { rateLimit } from '@/lib/rate-limit';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// POST /api/auth/verify-email-otp
// Temporary email OTP fallback — remove once AWS SMS Production Access is approved
//
// 1. Verify OTP code (stored in otp_codes table)
// 2. Find existing Supabase user by email
// 3. Generate a real session via admin.generateLink + verifyOtp
// 4. Set session cookies

const schema = z.object({
  email: z.string().email('Invalid email'),
  code: z.string().length(6, 'Code must be 6 digits'),
});

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) throw new Error('Supabase service config missing');
  return createServerClient(url, key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}

async function getSessionClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!url || !key) throw new Error('Supabase config missing');
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {}
      },
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    let body: z.infer<typeof schema>;
    try {
      body = schema.parse(await request.json());
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues[0]?.message || 'Invalid input' : 'Invalid request';
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // Rate limit per-email (not just per-IP) so a 6-digit code cannot be
    // brute-forced across rotating IPs → account takeover.
    const limited = await rateLimit(request, 'verify-otp', body.email.toLowerCase());
    if (limited) return limited;

    // 1. Verify OTP from our otp_codes table
    const verification = await verifyEmailOTP(body.email, body.code);
    if (!verification.success) {
      return NextResponse.json({ error: verification.error || 'Invalid or expired code' }, { status: 400 });
    }

    // 2. Find existing user by email
    const admin = getAdminClient();

    const { data: { users }, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1 });
    // listUsers with filter isn't ideal — query auth.users directly
    const { data: userRows } = await admin
      .from('users' as 'users')
      .select('id, email')
      .eq('email', body.email)
      .limit(1);

    const existingUser = (userRows as { id: string; email?: string }[] | null)?.[0];

    if (!existingUser) {
      return NextResponse.json({ error: 'No account found with this email. Sign in with your phone number first.' }, { status: 400 });
    }

    const userId = existingUser.id;

    // 3. Generate a magic link token to create a real session
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: body.email,
    });

    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error('[verify-email-otp] generateLink failed:', linkErr);
      return NextResponse.json({ error: 'Could not create session.' }, { status: 500 });
    }

    // 4. Use the token to create a real session with cookies
    const sessionClient = await getSessionClient();

    const { error: otpErr } = await sessionClient.auth.verifyOtp({
      type: 'magiclink',
      token_hash: linkData.properties.hashed_token,
    });

    if (otpErr) {
      console.error('[verify-email-otp] Session creation failed:', otpErr);
      return NextResponse.json({ error: 'Could not sign in. Please try again.' }, { status: 500 });
    }

    return NextResponse.json({
      verified: true,
      userId,
    });

  } catch (err) {
    console.error('POST /api/auth/verify-email-otp failed:', err);
    return NextResponse.json({ error: 'Verification failed. Please try again.' }, { status: 500 });
  }
}
