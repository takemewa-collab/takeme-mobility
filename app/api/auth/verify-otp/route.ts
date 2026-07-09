import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { rateLimit } from '@/lib/rate-limit'

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-otp
//
// Verify phone OTP via Supabase (Twilio Verify).
// Supabase creates the session automatically on successful verification.
// We use a cookie-aware client so the session persists.
// ═══════════════════════════════════════════════════════════════════════════

const schema = z.object({
  phone: z.string().regex(/^\+1\d{10}$/, 'Invalid phone number'),
  code: z.string().length(6, 'Code must be 6 digits'),
})

async function getSessionClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  if (!url || !key) throw new Error('Supabase config missing')
  const cookieStore = await cookies()
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {}
      },
    },
  })
}

export async function POST(request: NextRequest) {
  try {
    let body: z.infer<typeof schema>
    try {
      body = schema.parse(await request.json())
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues[0]?.message || 'Invalid input' : 'Invalid request'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    // Rate limit per-phone to blunt code brute-forcing.
    const limited = await rateLimit(request, 'verify-otp', body.phone)
    if (limited) return limited

    // Verify OTP via Supabase (Twilio Verify)
    // This creates a real session automatically
    const supabase = await getSessionClient()

    const { data, error } = await supabase.auth.verifyOtp({
      phone: body.phone,
      token: body.code,
      type: 'sms',
    })

    if (error) {
      console.error('[verify-otp] Supabase verifyOtp failed:', error.message)
      return NextResponse.json({ error: error.message || 'Invalid or expired code' }, { status: 400 })
    }

    if (!data.session || !data.user) {
      return NextResponse.json({ error: 'Verification failed. Please try again.' }, { status: 400 })
    }

    // Session cookies are set automatically by the cookie-aware client.
    // The user is fully authenticated.

    return NextResponse.json({
      verified: true,
      userId: data.user.id,
    })
  } catch (err) {
    console.error('POST /api/auth/verify-otp failed:', err)
    return NextResponse.json({ error: 'Verification failed. Please try again.' }, { status: 500 })
  }
}
