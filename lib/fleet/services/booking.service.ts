import { createServiceClient } from '@/lib/supabase/service'
import { FleetError, FleetErrorCode } from '@/lib/fleet/errors'
import { createFleetPaymentIntent, cancelFleetPaymentIntent, createFleetRefund } from '@/lib/fleet/utils/stripe-connect'
import { checkEligibility, getCachedEligibility } from '@/lib/fleet/services/eligibility.service'
import { logFleetAudit } from '@/lib/fleet/services/audit.service'

// ═══════════════════════════════════════════════════════════════════════════
// TakeMe Fleet — Booking Service
// ═══════════════════════════════════════════════════════════════════════════

const CANCELLABLE_STATUSES = [
  'draft',
  'pending_checkout',
  'deposit_pending',
  'confirmed',
  'pickup_ready',
  'in_use',
  'return_pending',
  'disputed',
]

const NON_OVERLAPPING_STATUSES = ['cancelled', 'failed']

// ── createBooking ──────────────────────────────────────────────────────────

export async function createBooking(
  driverId: string,
  input: {
    vehicleId: string
    startDate: string
    endDate: string
    pickupAddress?: string
    pickupNotes?: string
  },
  idempotencyKey: string,
) {
  const svc = createServiceClient()

  // Idempotency check
  const { data: existing } = await svc
    .from('rental_bookings')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()

  if (existing) {
    return existing
  }

  // Validate dates
  const startDate = new Date(input.startDate)
  const endDate = new Date(input.endDate)
  const now = new Date()

  if (endDate <= startDate) {
    throw new FleetError(FleetErrorCode.INVALID_DATES, 'End date must be after start date')
  }

  if (startDate <= now) {
    throw new FleetError(FleetErrorCode.INVALID_DATES, 'Start date must be in the future')
  }

  // Fetch vehicle
  const { data: vehicle, error: vehicleErr } = await svc
    .from('fleet_vehicles')
    .select('*')
    .eq('id', input.vehicleId)
    .single()

  if (vehicleErr || !vehicle) {
    throw new FleetError(FleetErrorCode.NOT_FOUND, `Vehicle ${input.vehicleId} not found`)
  }

  if (vehicle.status !== 'active') {
    throw new FleetError(FleetErrorCode.VEHICLE_UNAVAILABLE, 'Vehicle is not active')
  }

  // Check eligibility
  let eligibility = await getCachedEligibility(driverId, input.vehicleId)
  if (!eligibility) {
    eligibility = await checkEligibility(driverId, input.vehicleId)
  }

  if (eligibility.result === 'ineligible') {
    throw new FleetError(FleetErrorCode.DRIVER_INELIGIBLE, 'Driver is not eligible to rent this vehicle')
  }

  // Check availability — overlapping bookings
  const { data: overlapping } = await svc
    .from('rental_bookings')
    .select('id')
    .eq('vehicle_id', input.vehicleId)
    .not('status', 'in', `(${NON_OVERLAPPING_STATUSES.join(',')})`)
    .lt('start_date', input.endDate)
    .gt('end_date', input.startDate)
    .limit(1)

  if (overlapping && overlapping.length > 0) {
    throw new FleetError(FleetErrorCode.VEHICLE_UNAVAILABLE, 'Vehicle is not available for the selected dates')
  }

  // Check availability — blocked dates
  const { data: blocked } = await svc
    .from('vehicle_availability')
    .select('id')
    .eq('vehicle_id', input.vehicleId)
    .eq('blocked', true)
    .lt('available_from', input.endDate)
    .gt('available_until', input.startDate)
    .limit(1)

  if (blocked && blocked.length > 0) {
    throw new FleetError(FleetErrorCode.VEHICLE_UNAVAILABLE, 'Vehicle is blocked for the selected dates')
  }

  // Calculate pricing
  const durationDays = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000)
  const baseRate =
    durationDays >= 7 && vehicle.weekly_rate_cents
      ? Math.round(vehicle.weekly_rate_cents / 7)
      : vehicle.daily_rate_cents
  const totalBase = baseRate * durationDays
  const surgeMultiplier = 1.0
  const discountPct = 0
  const subtotal = Math.round(totalBase * surgeMultiplier * (1 - discountPct / 100))
  const cleaningFee = vehicle.cleaning_fee_cents || 0
  const commissionCents = Math.round(subtotal * 0.2)
  const ownerPayout = subtotal - commissionCents
  const depositAmount = vehicle.deposit_amount_cents || 0
  const totalCharge = subtotal + cleaningFee + depositAmount

  // Acquire date locks
  const dateLocks: { vehicle_id: string; date_key: string; locked_at: string; expires_at: string }[] = []
  const lockExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutes
  const lockNow = new Date().toISOString()

  for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
    const dateKey = d.toISOString().split('T')[0]
    dateLocks.push({
      vehicle_id: input.vehicleId,
      date_key: dateKey,
      locked_at: lockNow,
      expires_at: lockExpiry,
    })
  }

  for (const lock of dateLocks) {
    const { error: lockErr } = await svc.from('fleet_booking_locks').upsert(lock, {
      onConflict: 'vehicle_id,date_key',
      ignoreDuplicates: false,
    })

    if (lockErr) {
      // Check if lock is held by another non-expired booking
      const { data: existingLock } = await svc
        .from('fleet_booking_locks')
        .select('*')
        .eq('vehicle_id', lock.vehicle_id)
        .eq('date_key', lock.date_key)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()

      if (existingLock && existingLock.booking_id) {
        throw new FleetError(FleetErrorCode.VEHICLE_UNAVAILABLE, `Vehicle is locked for ${lock.date_key}`)
      }

      // Retry upsert if the existing lock is expired
      const { error: retryErr } = await svc.from('fleet_booking_locks').upsert(lock, {
        onConflict: 'vehicle_id,date_key',
        ignoreDuplicates: false,
      })

      if (retryErr) {
        console.error('[BookingService] Failed to acquire date lock:', retryErr.message)
        throw new FleetError(FleetErrorCode.VEHICLE_UNAVAILABLE, 'Failed to acquire date lock')
      }
    }
  }

  // Insert booking
  const { data: booking, error: bookingErr } = await svc
    .from('rental_bookings')
    .insert({
      vehicle_id: input.vehicleId,
      driver_id: driverId,
      owner_id: vehicle.owner_id,
      status: 'draft',
      start_date: input.startDate,
      end_date: input.endDate,
      daily_rate_cents: baseRate,
      total_rental_cents: subtotal,
      commission_cents: commissionCents,
      owner_payout_cents: ownerPayout,
      deposit_amount_cents: depositAmount,
      surge_multiplier: surgeMultiplier,
      discount_pct: discountPct,
      cleaning_fee_cents: cleaningFee,
      idempotency_key: idempotencyKey,
      pickup_address: input.pickupAddress ?? null,
      pickup_notes: input.pickupNotes ?? null,
    })
    .select('*')
    .single()

  if (bookingErr || !booking) {
    console.error('[BookingService] Failed to create booking:', bookingErr?.message)
    throw new FleetError(FleetErrorCode.DB_ERROR, `Failed to create booking: ${bookingErr?.message}`)
  }

  // Insert security deposit record
  const { error: depositErr } = await svc.from('security_deposits').insert({
    booking_id: booking.id,
    amount_cents: depositAmount,
    status: 'pending',
  })

  if (depositErr) {
    console.error('[BookingService] Failed to create security deposit record:', depositErr.message)
  }

  // Log audit
  await logFleetAudit({
    entityType: 'booking',
    entityId: booking.id,
    actorId: driverId,
    actorRole: 'driver',
    event: 'draft',
    metadata: {
      reason: 'Booking created',
      vehicleId: input.vehicleId,
      startDate: input.startDate,
      endDate: input.endDate,
      totalCharge,
    },
  })

  return booking
}

// ── getBooking ─────────────────────────────────────────────────────────────

export async function getBooking(bookingId: string) {
  const svc = createServiceClient()

  const { data: booking, error } = await svc
    .from('rental_bookings')
    .select('*')
    .eq('id', bookingId)
    .single()

  if (error || !booking) {
    throw new FleetError(FleetErrorCode.NOT_FOUND, `Booking ${bookingId} not found`)
  }

  return booking
}

// ── confirmBooking ─────────────────────────────────────────────────────────

export async function confirmBooking(
  bookingId: string,
  driverId: string,
  params: { paymentMethodId?: string },
) {
  const svc = createServiceClient()

  const booking = await getBooking(bookingId)

  if (booking.driver_id !== driverId) {
    throw new FleetError(FleetErrorCode.FORBIDDEN, 'Driver does not own this booking')
  }

  if (booking.status !== 'draft' && booking.status !== 'pending_checkout') {
    throw new FleetError(FleetErrorCode.INVALID_STATUS, `Cannot confirm booking with status "${booking.status}"`)
  }

  const totalCharge =
    booking.total_rental_cents + (booking.cleaning_fee_cents || 0) + (booking.deposit_amount_cents || 0)

  // Create main payment intent
  const paymentIntent = await createFleetPaymentIntent({
    amount: totalCharge,
    bookingId,
    description: `TakeMe Fleet rental booking ${bookingId}`,
    paymentMethodId: params.paymentMethodId,
    transferGroup: `fleet_booking_${bookingId}`,
  })

  // Insert payment record for booking charge
  const { error: paymentErr } = await svc.from('fleet_payments').insert({
    booking_id: bookingId,
    driver_id: driverId,
    idempotency_key: `booking_charge_${bookingId}`,
    payment_type: 'booking_charge',
    amount_cents: totalCharge,
    currency: 'usd',
    stripe_payment_intent_id: paymentIntent.id,
    status: paymentIntent.status,
  })

  if (paymentErr) {
    console.error('[BookingService] Failed to insert booking payment record:', paymentErr.message)
  }

  let depositIntentId: string | undefined
  let depositClientSecret: string | undefined

  // Create deposit payment intent if deposit > 0
  if (booking.deposit_amount_cents > 0) {
    const depositIntent = await createFleetPaymentIntent({
      amount: booking.deposit_amount_cents,
      bookingId,
      description: `TakeMe Fleet security deposit for booking ${bookingId}`,
      paymentMethodId: params.paymentMethodId,
      captureMethod: 'manual',
      transferGroup: `fleet_deposit_${bookingId}`,
    })

    depositIntentId = depositIntent.id
    depositClientSecret = depositIntent.clientSecret

    // Insert deposit payment record
    const { error: depPayErr } = await svc.from('fleet_payments').insert({
      booking_id: bookingId,
      driver_id: driverId,
      idempotency_key: `deposit_hold_${bookingId}`,
      payment_type: 'deposit_hold',
      amount_cents: booking.deposit_amount_cents,
      currency: 'usd',
      stripe_payment_intent_id: depositIntent.id,
      status: depositIntent.status,
    })

    if (depPayErr) {
      console.error('[BookingService] Failed to insert deposit payment record:', depPayErr.message)
    }

    // Update security deposit with stripe PI
    await svc
      .from('security_deposits')
      .update({ stripe_payment_intent_id: depositIntent.id, status: 'authorized' })
      .eq('booking_id', bookingId)
  }

  // Update booking status
  const { error: updateErr } = await svc
    .from('rental_bookings')
    .update({
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      checkout_session_id: paymentIntent.id,
    })
    .eq('id', bookingId)

  if (updateErr) {
    console.error('[BookingService] Failed to update booking status to confirmed:', updateErr.message)
    throw new FleetError(FleetErrorCode.DB_ERROR, `Failed to confirm booking: ${updateErr.message}`)
  }

  // Update date locks with booking_id
  const startDate = new Date(booking.start_date)
  const endDate = new Date(booking.end_date)

  for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
    const dateKey = d.toISOString().split('T')[0]
    await svc
      .from('fleet_booking_locks')
      .update({ booking_id: bookingId })
      .eq('vehicle_id', booking.vehicle_id)
      .eq('date_key', dateKey)
  }

  // Log audit
  await logFleetAudit({
    entityType: 'booking',
    entityId: bookingId,
    actorId: driverId,
    actorRole: 'driver',
    event: 'confirmed',
    metadata: { reason: 'Booking confirmed with payment', paymentIntentId: paymentIntent.id },
  })

  return {
    bookingId,
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.clientSecret,
    depositIntentId,
    depositClientSecret,
  }
}

// ── activateBooking ────────────────────────────────────────────────────────

export async function activateBooking(
  bookingId: string,
  actorId: string,
  params: { odometerPickup?: number },
) {
  const svc = createServiceClient()

  const booking = await getBooking(bookingId)

  if (actorId !== booking.driver_id && actorId !== booking.owner_id) {
    throw new FleetError(FleetErrorCode.FORBIDDEN, 'Not authorized for this booking')
  }

  if (booking.status !== 'confirmed' && booking.status !== 'pickup_ready') {
    throw new FleetError(
      FleetErrorCode.INVALID_STATUS,
      `Cannot activate booking with status "${booking.status}"`,
    )
  }

  const { data: updated, error } = await svc
    .from('rental_bookings')
    .update({
      status: 'in_use',
      actual_pickup_at: new Date().toISOString(),
      odometer_pickup: params.odometerPickup ?? null,
    })
    .eq('id', bookingId)
    .select('*')
    .single()

  if (error || !updated) {
    console.error('[BookingService] Failed to activate booking:', error?.message)
    throw new FleetError(FleetErrorCode.DB_ERROR, `Failed to activate booking: ${error?.message}`)
  }

  await logFleetAudit({
    entityType: 'booking',
    entityId: bookingId,
    actorId,
    actorRole: 'driver',
    event: 'in_use',
    metadata: { reason: 'Booking activated — vehicle picked up', odometerPickup: params.odometerPickup },
  })

  return updated
}

// ── completeBooking ────────────────────────────────────────────────────────

export async function completeBooking(
  bookingId: string,
  actorId: string,
  params: {
    odometerReturn?: number
    returnConditionNotes?: string
    damageReported?: boolean
    damageNotes?: string
    damageChargeCents?: number
  },
) {
  const svc = createServiceClient()

  const booking = await getBooking(bookingId)

  if (actorId !== booking.driver_id && actorId !== booking.owner_id) {
    throw new FleetError(FleetErrorCode.FORBIDDEN, 'Not authorized for this booking')
  }

  if (booking.status !== 'in_use' && booking.status !== 'return_pending') {
    throw new FleetError(
      FleetErrorCode.INVALID_STATUS,
      `Cannot complete booking with status "${booking.status}"`,
    )
  }

  // Calculate excess mileage
  let excessMiles = 0
  let excessChargeCents = 0

  if (params.odometerReturn != null && booking.odometer_pickup != null) {
    const totalMiles = params.odometerReturn - booking.odometer_pickup

    // Fetch vehicle for mileage limits
    const { data: vehicle } = await svc
      .from('fleet_vehicles')
      .select('mileage_limit_daily, excess_mileage_cents')
      .eq('id', booking.vehicle_id)
      .single()

    if (vehicle?.mileage_limit_daily) {
      const durationDays = Math.ceil(
        (new Date(booking.end_date).getTime() - new Date(booking.start_date).getTime()) / 86400000,
      )
      const allowedMiles = vehicle.mileage_limit_daily * durationDays
      excessMiles = Math.max(0, totalMiles - allowedMiles)
      excessChargeCents = excessMiles * (vehicle.excess_mileage_cents || 0)
    }
  }

  const { data: updated, error } = await svc
    .from('rental_bookings')
    .update({
      status: 'completed',
      actual_return_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      odometer_return: params.odometerReturn ?? null,
      excess_miles: excessMiles,
      excess_charge_cents: excessChargeCents,
      damage_reported: params.damageReported ?? false,
      damage_charge_cents: params.damageChargeCents ?? 0,
    })
    .eq('id', bookingId)
    .select('*')
    .single()

  if (error || !updated) {
    console.error('[BookingService] Failed to complete booking:', error?.message)
    throw new FleetError(FleetErrorCode.DB_ERROR, `Failed to complete booking: ${error?.message}`)
  }

  // Release deposit unless damage reported
  if (!params.damageReported) {
    const { error: depositErr } = await svc
      .from('security_deposits')
      .update({ status: 'released' })
      .eq('booking_id', bookingId)

    if (depositErr) {
      console.error('[BookingService] Failed to release security deposit:', depositErr.message)
    }
  }

  // Delete booking locks
  const startDate = new Date(booking.start_date)
  const endDate = new Date(booking.end_date)

  for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
    const dateKey = d.toISOString().split('T')[0]
    await svc
      .from('fleet_booking_locks')
      .delete()
      .eq('vehicle_id', booking.vehicle_id)
      .eq('date_key', dateKey)
  }

  await logFleetAudit({
    entityType: 'booking',
    entityId: bookingId,
    actorId,
    actorRole: 'driver',
    event: 'completed',
    metadata: {
      reason: 'Booking completed — vehicle returned',
      odometerReturn: params.odometerReturn,
      excessMiles,
      excessChargeCents,
      damageReported: params.damageReported,
      damageChargeCents: params.damageChargeCents,
    },
  })

  return {
    ...updated,
    excess_miles: excessMiles,
    excess_charge_cents: excessChargeCents,
  }
}

// ── cancelBooking ──────────────────────────────────────────────────────────

export async function cancelBooking(bookingId: string, actorId: string, reason: string) {
  const svc = createServiceClient()

  const booking = await getBooking(bookingId)

  if (actorId !== booking.driver_id && actorId !== booking.owner_id) {
    throw new FleetError(FleetErrorCode.FORBIDDEN, 'Not authorized for this booking')
  }

  if (!CANCELLABLE_STATUSES.includes(booking.status)) {
    throw new FleetError(
      FleetErrorCode.INVALID_STATUS,
      `Cannot cancel booking with status "${booking.status}"`,
    )
  }

  // Refund main payment if it exists and succeeded
  const { data: payments } = await svc
    .from('fleet_payments')
    .select('*')
    .eq('booking_id', bookingId)
    .eq('payment_type', 'booking_charge')
    .eq('status', 'succeeded')

  if (payments && payments.length > 0) {
    for (const payment of payments) {
      try {
        await createFleetRefund(payment.stripe_payment_intent_id)
      } catch (err) {
        console.error(
          '[BookingService] Failed to refund payment:',
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  // Cancel deposit payment intent if it exists
  const { data: depositPayments } = await svc
    .from('fleet_payments')
    .select('*')
    .eq('booking_id', bookingId)
    .eq('payment_type', 'deposit_hold')

  if (depositPayments && depositPayments.length > 0) {
    for (const dp of depositPayments) {
      try {
        await cancelFleetPaymentIntent(dp.stripe_payment_intent_id)
      } catch (err) {
        console.error(
          '[BookingService] Failed to cancel deposit payment intent:',
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  // Update booking status
  const { data: updated, error } = await svc
    .from('rental_bookings')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by: actorId,
      cancel_reason: reason,
    })
    .eq('id', bookingId)
    .select('*')
    .single()

  if (error || !updated) {
    console.error('[BookingService] Failed to cancel booking:', error?.message)
    throw new FleetError(FleetErrorCode.DB_ERROR, `Failed to cancel booking: ${error?.message}`)
  }

  // Delete booking locks
  const startDate = new Date(booking.start_date)
  const endDate = new Date(booking.end_date)

  for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
    const dateKey = d.toISOString().split('T')[0]
    await svc
      .from('fleet_booking_locks')
      .delete()
      .eq('vehicle_id', booking.vehicle_id)
      .eq('date_key', dateKey)
  }

  await logFleetAudit({
    entityType: 'booking',
    entityId: bookingId,
    actorId,
    actorRole: 'driver',
    event: 'cancelled',
    metadata: { reason },
  })

  return updated
}

// ── listDriverBookings ─────────────────────────────────────────────────────

export async function listDriverBookings(driverId: string, limit = 20) {
  const svc = createServiceClient()

  const { data, error } = await svc
    .from('rental_bookings')
    .select('*')
    .eq('driver_id', driverId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[BookingService] Failed to list driver bookings:', error.message)
    throw new FleetError(FleetErrorCode.DB_ERROR, `Failed to list driver bookings: ${error.message}`)
  }

  return data ?? []
}

// ── listOwnerBookings ──────────────────────────────────────────────────────

export async function listOwnerBookings(ownerId: string, limit = 20) {
  const svc = createServiceClient()

  const { data, error } = await svc
    .from('rental_bookings')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[BookingService] Failed to list owner bookings:', error.message)
    throw new FleetError(FleetErrorCode.DB_ERROR, `Failed to list owner bookings: ${error.message}`)
  }

  return data ?? []
}
