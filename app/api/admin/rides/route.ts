import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { createServiceClient } from '@/lib/supabase/service'

// GET /api/admin/rides — List rides with filters
//
// Schema: rides(id, user_id, pickup_location, dropoff_location, distance, duration, price, status, created_at)
// pickup_location/dropoff_location are JSON strings: {"lat":..., "lng":..., "address":"..."}
// FK: rides.user_id → riders.id

export async function GET(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth.error) return auth.error

  const url = request.nextUrl
  const status = url.searchParams.get('status')
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
  const offset = Number(url.searchParams.get('offset') ?? 0)

  const svc = createServiceClient()

  try {
    let query = svc
      .from('rides')
      .select('id, user_id, pickup_location, dropoff_location, distance, duration, price, status, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status && status !== 'all') {
      const activeStatuses = ['searching_driver', 'driver_assigned', 'driver_arriving', 'arrived', 'in_progress']
      if (status === 'active') {
        query = query.in('status', activeStatuses)
      } else {
        query = query.eq('status', status)
      }
    }

    const { data, count, error } = await query

    if (error) {
      console.error('[admin/rides] Query error:', error.message)
      return NextResponse.json({ error: 'Failed to fetch rides' }, { status: 500 })
    }

    // Parse JSON location strings and look up rider names
    const userIds = [...new Set((data ?? []).map((r: Record<string, unknown>) => r.user_id as string).filter(Boolean))]
    const riderMap: Record<string, { full_name: string | null; email: string | null }> = {}

    if (userIds.length > 0) {
      const { data: riders } = await svc
        .from('riders')
        .select('id, full_name, email')
        .in('id', userIds)

      for (const rider of riders ?? []) {
        riderMap[rider.id] = { full_name: rider.full_name, email: rider.email }
      }
    }

    const rides = (data ?? []).map((r: Record<string, unknown>) => {
      let pickup: { lat?: number; lng?: number; address?: string } = {}
      let dropoff: { lat?: number; lng?: number; address?: string } = {}
      try { pickup = typeof r.pickup_location === 'string' ? JSON.parse(r.pickup_location) : (r.pickup_location as typeof pickup) ?? {} } catch {}
      try { dropoff = typeof r.dropoff_location === 'string' ? JSON.parse(r.dropoff_location) : (r.dropoff_location as typeof dropoff) ?? {} } catch {}

      const rider = riderMap[r.user_id as string]

      return {
        id: r.id,
        status: r.status,
        pickup_address: pickup.address ?? null,
        pickup_lat: pickup.lat ?? null,
        pickup_lng: pickup.lng ?? null,
        dropoff_address: dropoff.address ?? null,
        dropoff_lat: dropoff.lat ?? null,
        dropoff_lng: dropoff.lng ?? null,
        distance_km: r.distance ? Number(r.distance) : null,
        duration_min: r.duration ? Number(r.duration) : null,
        estimated_fare: r.price ? Number(r.price) : null,
        final_fare: r.price ? Number(r.price) : null,
        rider_id: r.user_id,
        rider_name: rider?.full_name ?? null,
        rider_email: rider?.email ?? null,
        requested_at: r.created_at,
        created_at: r.created_at,
      }
    })

    return NextResponse.json({ rides, total: count ?? 0, limit, offset })
  } catch (err) {
    console.error('[admin/rides] Unhandled:', err)
    return NextResponse.json({ error: 'Failed to fetch rides' }, { status: 500 })
  }
}
