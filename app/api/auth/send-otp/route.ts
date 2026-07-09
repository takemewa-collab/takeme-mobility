import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { rateLimit } from '@/lib/rate-limit'
import { createServiceClient } from '@/lib/supabase/service'

// POST /api/auth/send-otp
// Uses Supabase phone auth (Twilio Verify) — no AWS SNS
const schema = z.object({
  phone: z.string().regex(/^\+1\d{10}$/, 'Must be a valid US phone: +1XXXXXXXXXX'),
})

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await rateLimit(request, 'send-otp')
    if (rateLimited) return rateLimited

    let body: z.infer<typeof schema>
    try {
      body = schema.parse(await request.json())
    } catch (err) {
      const msg = err instanceof z.ZodError
        ? err.issues[0]?.message || 'Invalid phone number'
        : 'Invalid request'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    // Send OTP via Supabase (Twilio Verify handles SMS delivery)
    const supabase = createServiceClient()
    const { error } = await supabase.auth.signInWithOtp({
      phone: body.phone,
    })

    if (error) {
      // Log the provider detail server-side; return a generic message.
      console.error('[send-otp] Supabase signInWithOtp failed:', error.message)
      return NextResponse.json({ error: 'Could not send code. Please try again.' }, { status: 500 })
    }

    return NextResponse.json({ sent: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[send-otp] Unhandled error:', message)
    return NextResponse.json({ error: 'Could not send code. Please try again.' }, { status: 500 })
  }
}
