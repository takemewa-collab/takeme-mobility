// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Airport Intelligence: pure logic
//
// Everything in this file is deliberately side-effect free (no supabase, no
// caches) so the safety-critical decision rules — which point types are
// bookable for which direction, how fees apply, how the immutable trip
// snapshot is shaped — are unit-testable without a database.
// ═══════════════════════════════════════════════════════════════════════════

export type AirportCoverageStatus =
  | 'cataloged'
  | 'passenger_service'
  | 'serviceable'
  | 'curated'
  | 'verified'
  | 'temporarily_disabled';

export type AirportServicePointType =
  | 'general_departures_dropoff'
  | 'airline_departures_dropoff'
  | 'rideshare_pickup'
  | 'arrivals_reference';

export type TripAirportDirection = 'airport_pickup' | 'airport_dropoff';
export type AirportSelectionMethod = 'airline' | 'flight' | 'manual' | 'verified_fallback';
export type AirportInstructionAudience = 'rider' | 'driver' | 'both';
export type AirportInstructionDirection = 'pickup' | 'dropoff';

// ── Direction ↔ point-type matrix ────────────────────────────────────────
// Drop-offs may ONLY land on departures curbs; pickups may ONLY land on
// rideshare pickup zones. arrivals_reference is context, never bookable.

const BOOKABLE_TYPES: Record<TripAirportDirection, readonly AirportServicePointType[]> = {
  airport_dropoff: ['general_departures_dropoff', 'airline_departures_dropoff'],
  airport_pickup: ['rideshare_pickup'],
};

export function servicePointTypeAllowed(
  direction: TripAirportDirection,
  pointType: AirportServicePointType,
): boolean {
  return BOOKABLE_TYPES[direction].includes(pointType);
}

/** trip direction → instruction/fee direction. */
export function instructionDirectionFor(direction: TripAirportDirection): AirportInstructionDirection {
  return direction === 'airport_pickup' ? 'pickup' : 'dropoff';
}

// ── Controlled name normalization ────────────────────────────────────────
// Mirrors normalize_airport_name() in SQL (044): lower, collapse every
// non-alphanumeric run to one space, trim. Exact-match lookups only — the
// resolution service never does substring "airport" heuristics.

export function normalizePlaceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Fee selection ────────────────────────────────────────────────────────

export interface AirportFeeRule {
  config: unknown;
  effective_from: string | null; // 'YYYY-MM-DD'
  effective_to: string | null;
}

export interface AirportFee {
  amount: number;
  currency: string;
  direction: 'pickup' | 'dropoff' | 'both';
}

/**
 * Pick the applicable airport fee out of the active airport_fee rules for a
 * direction on a given date. Rules with malformed configs are ignored — a
 * bad row must never turn into a silent $NaN charge.
 */
export function selectAirportFee(
  rules: AirportFeeRule[],
  direction: TripAirportDirection,
  todayIsoDate: string,
): AirportFee | null {
  const want = instructionDirectionFor(direction);
  for (const rule of rules) {
    if (rule.effective_from && todayIsoDate < rule.effective_from) continue;
    if (rule.effective_to && todayIsoDate > rule.effective_to) continue;
    const cfg = rule.config as { amount?: unknown; currency?: unknown; direction?: unknown } | null;
    if (!cfg || typeof cfg !== 'object') continue;
    const amount = Number(cfg.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100) continue;
    const feeDirection = cfg.direction === 'pickup' || cfg.direction === 'dropoff' || cfg.direction === 'both'
      ? cfg.direction
      : 'both';
    if (feeDirection !== 'both' && feeDirection !== want) continue;
    const currency = typeof cfg.currency === 'string' && /^[A-Za-z]{3}$/.test(cfg.currency)
      ? cfg.currency.toUpperCase()
      : 'USD';
    return { amount: Math.round(amount * 100) / 100, currency, direction: feeDirection };
  }
  return null;
}

// ── Snapshot composition ─────────────────────────────────────────────────
// The immutable JSON stored on trip_airport_context. Both apps render from
// this — later operational edits must never change an in-flight trip.

export interface SnapshotInstruction {
  title: string;
  body: string;
  image_url?: string;
}

export interface SnapshotParts {
  airport: { id: string; iata_code: string | null; display_name: string; updated_at: string };
  direction: TripAirportDirection;
  airline?: { id: string; display_name: string; iata_code: string | null; updated_at: string } | null;
  terminal?: { id: string; code: string; name: string; updated_at: string } | null;
  servicePoint: {
    id: string;
    point_type: AirportServicePointType;
    name: string;
    lat: number;
    lng: number;
    level: string | null;
    door: string | null;
    zone: string | null;
    island: string | null;
    updated_at: string;
  };
  riderInstructions: Array<SnapshotInstruction & { updated_at?: string }>;
  driverInstructions: Array<SnapshotInstruction & { updated_at?: string }>;
  fee?: { amount: number; currency: string } | null;
  flightNumber?: string | null;
  selectionMethod: AirportSelectionMethod;
  /** Extra updated_at timestamps to fold into config_version (rules, …). */
  extraVersions?: Array<string | null | undefined>;
}

export interface AirportSnapshot {
  airport: { id: string; iata_code: string | null; display_name: string };
  direction: TripAirportDirection;
  airline?: { id: string; display_name: string; iata_code: string | null };
  terminal?: { id: string; code: string; name: string };
  service_point: {
    id: string;
    point_type: AirportServicePointType;
    name: string;
    lat: number;
    lng: number;
    level: string | null;
    door: string | null;
    zone: string | null;
    island: string | null;
  };
  instructions: { rider: SnapshotInstruction[]; driver: SnapshotInstruction[] };
  fee?: { amount: number; currency: string };
  flight_number?: string;
  selection_method: AirportSelectionMethod;
  config_version: string;
}

function stripInstruction(i: SnapshotInstruction & { updated_at?: string }): SnapshotInstruction {
  return { title: i.title, body: i.body, ...(i.image_url ? { image_url: i.image_url } : {}) };
}

export function composeAirportSnapshot(parts: SnapshotParts): AirportSnapshot {
  const versions: Array<string | null | undefined> = [
    parts.airport.updated_at,
    parts.airline?.updated_at,
    parts.terminal?.updated_at,
    parts.servicePoint.updated_at,
    ...parts.riderInstructions.map((i) => i.updated_at),
    ...parts.driverInstructions.map((i) => i.updated_at),
    ...(parts.extraVersions ?? []),
  ];
  let maxMs = 0;
  for (const v of versions) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
  }
  const configVersion = maxMs > 0 ? new Date(maxMs).toISOString() : new Date(0).toISOString();

  return {
    airport: {
      id: parts.airport.id,
      iata_code: parts.airport.iata_code,
      display_name: parts.airport.display_name,
    },
    direction: parts.direction,
    ...(parts.airline
      ? {
          airline: {
            id: parts.airline.id,
            display_name: parts.airline.display_name,
            iata_code: parts.airline.iata_code,
          },
        }
      : {}),
    ...(parts.terminal
      ? { terminal: { id: parts.terminal.id, code: parts.terminal.code, name: parts.terminal.name } }
      : {}),
    service_point: {
      id: parts.servicePoint.id,
      point_type: parts.servicePoint.point_type,
      name: parts.servicePoint.name,
      lat: parts.servicePoint.lat,
      lng: parts.servicePoint.lng,
      level: parts.servicePoint.level,
      door: parts.servicePoint.door,
      zone: parts.servicePoint.zone,
      island: parts.servicePoint.island,
    },
    instructions: {
      rider: parts.riderInstructions.map(stripInstruction),
      driver: parts.driverInstructions.map(stripInstruction),
    },
    ...(parts.fee ? { fee: { amount: parts.fee.amount, currency: parts.fee.currency } } : {}),
    ...(parts.flightNumber ? { flight_number: parts.flightNumber } : {}),
    selection_method: parts.selectionMethod,
    config_version: configVersion,
  };
}
