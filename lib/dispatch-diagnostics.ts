// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Dispatch Eligibility Diagnostics
//
// When matching returns zero candidates, "No Drivers Available" must never be
// a mystery. This module re-runs every eligibility filter over the real
// driver fleet with the service role and produces a structured rejection
// reason per driver, mirroring find_nearby_drivers' WHERE clause exactly.
// The result is logged (Vercel) and persisted to ride_events as
// `dispatch_no_candidates`, keyed by ride id (the correlation id for the
// whole matching attempt).
// ═══════════════════════════════════════════════════════════════════════════

import { createServiceClient } from '@/lib/supabase/service';
import { haversineMeters, parseGeoPoint } from '@/lib/trip-geofence';

/**
 * Location freshness window used by find_nearby_drivers (migration 055).
 * Must match the SQL: dl.updated_at > now() - interval '90 seconds'.
 */
export const LOCATION_FRESHNESS_SEC = 90;

export type RejectionCode =
  | 'DRIVER_OFFLINE'
  | 'DRIVER_UNAVAILABLE'
  | 'DRIVER_NOT_APPROVED'
  | 'VEHICLE_MISSING'
  | 'VEHICLE_NOT_ELIGIBLE'
  | 'LOCATION_MISSING'
  | 'LOCATION_STALE'
  | 'OUTSIDE_RADIUS'
  | 'ACTIVE_RIDE_EXISTS'
  | 'RECENT_OFFER_COOLDOWN'
  | 'PUSH_TOKEN_MISSING';

export interface DriverRejection {
  driver_id: string;
  driver_name: string;
  reasons: { code: RejectionCode; detail?: string }[];
}

export interface NoCandidatesDiagnosis {
  rejections: DriverRejection[];
  /** Aggregate reason counts, e.g. { LOCATION_STALE: 1 } */
  summary: Record<string, number>;
  driversExamined: number;
}

interface DiagnoseInput {
  rideId: string;
  pickupLat: number;
  pickupLng: number;
  vehicleClass: string;
  maxRadiusM: number;
  excludedDriverIds: string[];
  attempt: number;
  /** Write a ride_events row (throttled by callers — every 10s retry must not spam). */
  persist: boolean;
}

/**
 * Evaluate every driver in the fleet against the matching filters and explain
 * exactly why each one was not offered this ride. Read-only apart from the
 * optional ride_events insert; never throws (diagnostics must not break
 * dispatch).
 */
export async function diagnoseNoCandidates(input: DiagnoseInput): Promise<NoCandidatesDiagnosis> {
  const empty: NoCandidatesDiagnosis = { rejections: [], summary: {}, driversExamined: 0 };
  try {
    const svc = createServiceClient();

    const [{ data: drivers }, { data: vehicles }, { data: locations }] = await Promise.all([
      svc.from('drivers').select('id, full_name, status, is_active, is_verified, auth_user_id'),
      svc.from('vehicles').select('driver_id, vehicle_class, is_active'),
      svc.from('driver_locations').select('driver_id, location, updated_at'),
    ]);

    if (!drivers?.length) {
      const diagnosis: NoCandidatesDiagnosis = {
        rejections: [],
        summary: { NO_DRIVERS_REGISTERED: 1 },
        driversExamined: 0,
      };
      await persistDiagnosis(input, diagnosis);
      return diagnosis;
    }

    const authIds = drivers.map((d) => d.auth_user_id).filter(Boolean) as string[];
    const { data: tokens } = authIds.length
      ? await svc.from('push_tokens').select('user_id').eq('role', 'driver').in('user_id', authIds)
      : { data: [] as { user_id: string }[] };
    const tokenSet = new Set((tokens ?? []).map((t) => t.user_id as string));

    const vehiclesByDriver = new Map<string, { vehicle_class: string; is_active: boolean }[]>();
    for (const v of vehicles ?? []) {
      const list = vehiclesByDriver.get(v.driver_id as string) ?? [];
      list.push({ vehicle_class: String(v.vehicle_class), is_active: Boolean(v.is_active) });
      vehiclesByDriver.set(v.driver_id as string, list);
    }
    const locByDriver = new Map(
      (locations ?? []).map((l) => [l.driver_id as string, l]),
    );
    const excluded = new Set(input.excludedDriverIds);

    const nowMs = Date.now();
    const rejections: DriverRejection[] = [];

    for (const d of drivers) {
      const reasons: DriverRejection['reasons'] = [];

      if (!d.is_active || !d.is_verified) {
        reasons.push({
          code: 'DRIVER_NOT_APPROVED',
          detail: `is_active=${d.is_active} is_verified=${d.is_verified}`,
        });
      }
      if (d.status === 'offline') {
        reasons.push({ code: 'DRIVER_OFFLINE' });
      } else if (d.status === 'busy' || d.status === 'on_trip') {
        reasons.push({ code: 'ACTIVE_RIDE_EXISTS', detail: `status=${d.status}` });
      } else if (d.status !== 'available') {
        reasons.push({ code: 'DRIVER_UNAVAILABLE', detail: `status=${d.status}` });
      }

      const driverVehicles = vehiclesByDriver.get(d.id as string) ?? [];
      const activeVehicles = driverVehicles.filter((v) => v.is_active);
      if (activeVehicles.length === 0) {
        reasons.push({ code: 'VEHICLE_MISSING', detail: 'no active vehicle' });
      } else if (!activeVehicles.some((v) => v.vehicle_class === input.vehicleClass)) {
        reasons.push({
          code: 'VEHICLE_NOT_ELIGIBLE',
          detail: `has [${activeVehicles.map((v) => v.vehicle_class).join(',')}], ride needs ${input.vehicleClass}`,
        });
      }

      const loc = locByDriver.get(d.id as string);
      if (!loc) {
        reasons.push({ code: 'LOCATION_MISSING', detail: 'no driver_locations row' });
      } else {
        const ageSec = Math.round((nowMs - new Date(loc.updated_at as string).getTime()) / 1000);
        if (ageSec > LOCATION_FRESHNESS_SEC) {
          reasons.push({
            code: 'LOCATION_STALE',
            detail: `location is ${ageSec}s old (threshold ${LOCATION_FRESHNESS_SEC}s)`,
          });
        }
        const point = parseGeoPoint(loc.location);
        if (point) {
          const distanceM = Math.round(
            haversineMeters(point, { lat: input.pickupLat, lng: input.pickupLng }),
          );
          if (distanceM > input.maxRadiusM) {
            reasons.push({
              code: 'OUTSIDE_RADIUS',
              detail: `${distanceM}m away (max ${input.maxRadiusM}m)`,
            });
          }
        }
      }

      if (excluded.has(d.id as string)) {
        reasons.push({ code: 'RECENT_OFFER_COOLDOWN', detail: 'missed/declined a recent offer for this ride' });
      }

      // Push delivery is not a matching filter, but a driver who cannot be
      // reached will silently eat the offer — surface it.
      if (d.auth_user_id && !tokenSet.has(d.auth_user_id as string)) {
        reasons.push({ code: 'PUSH_TOKEN_MISSING' });
      }

      if (reasons.length > 0) {
        rejections.push({
          driver_id: d.id as string,
          driver_name: (d.full_name as string) ?? 'unknown',
          reasons,
        });
      }
    }

    const summary: Record<string, number> = {};
    for (const r of rejections) {
      for (const reason of r.reasons) {
        summary[reason.code] = (summary[reason.code] ?? 0) + 1;
      }
    }

    const diagnosis: NoCandidatesDiagnosis = {
      rejections,
      summary,
      driversExamined: drivers.length,
    };

    console.log(
      `[dispatch] ride ${input.rideId} attempt ${input.attempt}: 0 candidates — examined ${drivers.length} driver(s):`,
      JSON.stringify(rejections.slice(0, 20)),
    );

    if (input.persist) await persistDiagnosis(input, diagnosis);
    return diagnosis;
  } catch (err) {
    console.error(`[dispatch] diagnostics failed for ride ${input.rideId}:`, err);
    return empty;
  }
}

async function persistDiagnosis(input: DiagnoseInput, diagnosis: NoCandidatesDiagnosis): Promise<void> {
  try {
    const svc = createServiceClient();
    await svc.from('ride_events').insert({
      ride_id: input.rideId,
      event_type: 'dispatch_no_candidates',
      actor: 'system',
      metadata: {
        attempt: input.attempt,
        max_radius_m: input.maxRadiusM,
        vehicle_class: input.vehicleClass,
        location_freshness_sec: LOCATION_FRESHNESS_SEC,
        drivers_examined: diagnosis.driversExamined,
        summary: diagnosis.summary,
        // Bounded: enough to debug any realistic market without unbounded rows.
        rejections: diagnosis.rejections.slice(0, 20),
      },
    });
  } catch (err) {
    console.error(`[dispatch] failed to persist diagnostics for ${input.rideId}:`, err);
  }
}
