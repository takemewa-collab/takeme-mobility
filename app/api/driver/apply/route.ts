import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestAuth } from '@/lib/auth/request-user';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/apply — Submit driver application
// GET  /api/driver/apply — Check application status
// ═══════════════════════════════════════════════════════════════════════════

const applySchema = z.object({
  fullName: z.string().min(2, 'Full name is required'),
  phone: z.string().min(10, 'Valid phone number required'),
  email: z.string().email().optional(),
  licenseNumber: z.string().min(4, 'License number is required'),
  vehicleMake: z.string().min(1, 'Vehicle make is required'),
  vehicleModel: z.string().min(1, 'Vehicle model is required'),
  vehicleYear: z.number().int().min(2015).max(2030).optional(),
  vehicleColor: z.string().optional(),
  plateNumber: z.string().min(2, 'Plate number is required'),
  vehicleClass: z.enum(['electric', 'comfort_electric', 'premium_electric', 'suv_electric']).default('electric'),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getRequestAuth(request);
    if (!auth) {
      return NextResponse.json({ error: 'Sign in to apply.' }, { status: 401 });
    }
    const { user, supabase } = auth;

    let body: z.infer<typeof applySchema>;
    try {
      body = applySchema.parse(await request.json());
    } catch (err) {
      const msg = err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        : 'Invalid application data';
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // Check for existing application
    const { data: existing } = await supabase
      .from('driver_applications')
      .select('id, status')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing && existing.status === 'pending') {
      return NextResponse.json({ error: 'You already have a pending application.' }, { status: 409 });
    }

    if (existing && existing.status === 'approved') {
      return NextResponse.json({ error: 'You are already an approved driver.' }, { status: 409 });
    }

    // Insert application
    const { data: app, error: insertError } = await supabase
      .from('driver_applications')
      .insert({
        user_id: user.id,
        full_name: body.fullName,
        phone: body.phone,
        email: body.email ?? user.email,
        license_number: body.licenseNumber,
        vehicle_make: body.vehicleMake,
        vehicle_model: body.vehicleModel,
        vehicle_year: body.vehicleYear,
        vehicle_color: body.vehicleColor,
        plate_number: body.plateNumber,
        vehicle_class: body.vehicleClass,
        status: 'pending',
      })
      .select('id, status')
      .single();

    if (insertError || !app) {
      console.error('[driver/apply] Insert failed:', insertError);
      return NextResponse.json({ error: insertError?.message || 'Application failed.' }, { status: 500 });
    }

    return NextResponse.json({ applicationId: app.id, status: app.status }, { status: 201 });
  } catch (err) {
    console.error('[driver/apply] Error:', err);
    return NextResponse.json({ error: 'Application failed. Please try again.' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getRequestAuth(request);
    if (!auth) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    }
    const { user, supabase } = auth;

    const { data: app } = await supabase
      .from('driver_applications')
      .select('id, status, full_name, vehicle_make, vehicle_model, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({ application: app ?? null });
  } catch {
    return NextResponse.json({ error: 'Failed to check status.' }, { status: 500 });
  }
}
