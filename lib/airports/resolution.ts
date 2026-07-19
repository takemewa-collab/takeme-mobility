// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Airport Intelligence: resolution service
//
// Server-side only. Every read goes through the service client (the catalog
// has NO client read policies — 043) and returns published/active projections
// exclusively: never source jsonb, drafts, or import metadata.
//
// Caching is bounded (TTLCache): airport operational config 5 min, airline
// lists 15 min, keyed by airport id. Admin publish calls clearAirportCache().
// Every DB call is a single bounded query — no retries, no fan-out.
// ═══════════════════════════════════════════════════════════════════════════

import { TTLCache } from '@/lib/cache';
import { createServiceClient } from '@/lib/supabase/service';
import {
  composeAirportSnapshot,
  instructionDirectionFor,
  normalizePlaceName,
  selectAirportFee,
  servicePointTypeAllowed,
  type AirportCoverageStatus,
  type AirportFee,
  type AirportSelectionMethod,
  type AirportServicePointType,
  type AirportSnapshot,
  type SnapshotInstruction,
  type TripAirportDirection,
} from '@/lib/airports/logic';

export {
  servicePointTypeAllowed,
  instructionDirectionFor,
  normalizePlaceName,
  selectAirportFee,
  composeAirportSnapshot,
};
export type {
  AirportCoverageStatus,
  AirportSelectionMethod,
  AirportServicePointType,
  AirportSnapshot,
  TripAirportDirection,
};

// ── Row shapes (published projections only) ──────────────────────────────

export interface AirportRecord {
  id: string;
  iata_code: string | null;
  icao_code: string | null;
  faa_lid: string | null;
  display_name: string;
  municipality: string | null;
  state_code: string | null;
  timezone: string | null;
  lat: number;
  lng: number;
  coverage_status: AirportCoverageStatus;
  active: boolean;
  updated_at: string;
}

export interface ServicePointRecord {
  id: string;
  terminal_id: string | null;
  point_type: AirportServicePointType;
  name: string;
  lat: number;
  lng: number;
  level: string | null;
  door: string | null;
  zone: string | null;
  island: string | null;
  verified: boolean;
  updated_at: string;
}

export interface TerminalRecord {
  id: string;
  code: string;
  name: string;
  display_order: number;
  verified: boolean;
  updated_at: string;
}

interface FeeRuleRecord {
  config: unknown;
  effective_from: string | null;
  effective_to: string | null;
  updated_at: string;
}

interface AirportCoreConfig {
  airport: AirportRecord;
  servicePoints: ServicePointRecord[];
  terminals: TerminalRecord[];
  feeRules: FeeRuleRecord[];
}

export interface AirlineSummary {
  id: string;
  display_name: string;
  iata_code: string | null;
  rank: number | null;
}

export interface InstructionRecord extends SnapshotInstruction {
  updated_at?: string;
}

export interface AirportFlow {
  enabled: boolean;
  dropoff: { available: boolean; verified: boolean };
  pickup: { available: boolean; verified: boolean };
}

export type AirportResolution =
  | { kind: 'normal' }
  | {
      kind: 'airport';
      airport: {
        id: string;
        iata_code: string | null;
        display_name: string;
        municipality: string | null;
        state_code: string | null;
        coverage_status: AirportCoverageStatus;
        lat: number;
        lng: number;
      };
      flow: AirportFlow;
    };

export interface ResolvedAccess {
  airline: { id: string; display_name: string; iata_code: string | null; updated_at: string } | null;
  terminal: TerminalRecord | null;
  servicePoint: ServicePointRecord;
  selectionMethod: AirportSelectionMethod;
}

// ── Bounded caches ───────────────────────────────────────────────────────

const configCache = new TTLCache<AirportCoreConfig | null>(500, 5 * 60 * 1000);
const airlinesCache = new TTLCache<AirlineSummary[]>(500, 15 * 60 * 1000);

export function clearAirportCache(airportId: string): void {
  configCache.delete(configKey(airportId));
  airlinesCache.delete(airlinesKey(airportId));
}

function configKey(airportId: string): string {
  return `airport-config:${airportId}`;
}
function airlinesKey(airportId: string): string {
  return `airport-airlines:${airportId}`;
}

// ── Core config load (cached) ────────────────────────────────────────────

const AIRPORT_COLUMNS =
  'id, iata_code, icao_code, faa_lid, display_name, municipality, state_code, timezone, lat, lng, coverage_status, active, updated_at';
const POINT_COLUMNS =
  'id, terminal_id, point_type, name, lat, lng, level, door, zone, island, verified, updated_at';

function toAirportRecord(row: Record<string, unknown>): AirportRecord {
  return {
    ...(row as unknown as AirportRecord),
    lat: Number(row.lat),
    lng: Number(row.lng),
  };
}

function toServicePointRecord(row: Record<string, unknown>): ServicePointRecord {
  return {
    ...(row as unknown as ServicePointRecord),
    lat: Number(row.lat),
    lng: Number(row.lng),
  };
}

/**
 * The airport's live operational config: active catalog row + active service
 * points, terminals and fee rules. Null when the airport does not exist in
 * the active catalog. Cached 5 minutes per airport.
 */
export async function getAirportConfig(airportId: string): Promise<AirportCoreConfig | null> {
  const cached = configCache.get(configKey(airportId));
  if (cached !== undefined) return cached;

  const svc = createServiceClient();
  const { data: airportRow, error } = await svc
    .from('airports')
    .select(AIRPORT_COLUMNS)
    .eq('id', airportId)
    .eq('catalog_status', 'active')
    .maybeSingle();

  if (error) throw new Error(`airport config load failed: ${error.message}`);
  if (!airportRow) {
    configCache.set(configKey(airportId), null);
    return null;
  }

  const [pointsRes, terminalsRes, rulesRes] = await Promise.all([
    svc
      .from('airport_service_points')
      .select(POINT_COLUMNS)
      .eq('airport_id', airportId)
      .eq('active', true)
      .order('verified', { ascending: false })
      .order('name', { ascending: true })
      .limit(200),
    svc
      .from('airport_terminals')
      .select('id, code, name, display_order, verified, updated_at')
      .eq('airport_id', airportId)
      .eq('active', true)
      .order('display_order', { ascending: true })
      .order('code', { ascending: true })
      .limit(100),
    svc
      .from('airport_rules')
      .select('config, effective_from, effective_to, updated_at')
      .eq('airport_id', airportId)
      .eq('rule_type', 'airport_fee')
      .eq('active', true)
      .limit(20),
  ]);

  if (pointsRes.error) throw new Error(`service points load failed: ${pointsRes.error.message}`);
  if (terminalsRes.error) throw new Error(`terminals load failed: ${terminalsRes.error.message}`);
  if (rulesRes.error) throw new Error(`rules load failed: ${rulesRes.error.message}`);

  const config: AirportCoreConfig = {
    airport: toAirportRecord(airportRow as Record<string, unknown>),
    servicePoints: (pointsRes.data ?? []).map((p) => toServicePointRecord(p as Record<string, unknown>)),
    terminals: (terminalsRes.data ?? []) as TerminalRecord[],
    feeRules: (rulesRes.data ?? []) as FeeRuleRecord[],
  };
  configCache.set(configKey(airportId), config);
  return config;
}

export function flowFor(config: AirportCoreConfig): AirportFlow {
  const dropoffPoints = config.servicePoints.filter(
    (p) => p.point_type === 'general_departures_dropoff',
  );
  const pickupPoints = config.servicePoints.filter((p) => p.point_type === 'rideshare_pickup');

  const dropoffAvailable = dropoffPoints.length > 0;
  const pickupAvailable = pickupPoints.length > 0;

  const enabled =
    config.airport.active &&
    (config.airport.coverage_status === 'curated' || config.airport.coverage_status === 'verified') &&
    dropoffAvailable;

  return {
    enabled,
    dropoff: { available: dropoffAvailable, verified: dropoffPoints.some((p) => p.verified) },
    pickup: { available: pickupAvailable, verified: pickupPoints.some((p) => p.verified) },
  };
}

// ── resolvePlace ─────────────────────────────────────────────────────────

export interface ResolvePlaceInput {
  lat: number;
  lng: number;
  name?: string;
  mapboxId?: string;
  iata?: string;
}

/**
 * Is this place an airport we know? Resolution order:
 *   1. explicit provider place id (mapbox_place identifier)
 *   2. explicit IATA code
 *   3. PostGIS geofence/radius containment (SQL helper, 044)
 *   4. controlled normalized-name alias (exact match ONLY)
 * Anything else → {kind:'normal'}.
 */
export async function resolvePlace(input: ResolvePlaceInput): Promise<AirportResolution> {
  const svc = createServiceClient();
  let airportId: string | null = null;

  // 1. Provider place id.
  if (input.mapboxId) {
    const { data } = await svc
      .from('airport_identifiers')
      .select('airport_id')
      .eq('identifier_type', 'mapbox_place')
      .eq('identifier_value', input.mapboxId)
      .eq('active', true)
      .limit(1)
      .maybeSingle();
    airportId = data?.airport_id ?? null;
  }

  // 2. Explicit IATA code.
  if (!airportId && input.iata) {
    const iata = input.iata.trim().toUpperCase();
    if (/^[A-Z0-9]{3}$/.test(iata)) {
      const { data } = await svc
        .from('airports')
        .select('id')
        .eq('iata_code', iata)
        .eq('catalog_status', 'active')
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      airportId = data?.id ?? null;
    }
  }

  // 3. Geofence / detection-radius containment.
  if (!airportId) {
    const { data, error } = await svc.rpc('resolve_airport_by_point', {
      p_lat: input.lat,
      p_lng: input.lng,
    });
    if (!error && data) airportId = data as string;
  }

  // 4. Controlled alias fallback — exact normalized match only.
  if (!airportId && input.name) {
    const normalized = normalizePlaceName(input.name);
    if (normalized.length >= 3) {
      const { data } = await svc
        .from('airport_identifiers')
        .select('airport_id')
        .eq('identifier_type', 'alias_normalized')
        .eq('identifier_value', normalized)
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      airportId = data?.airport_id ?? null;
    }
  }

  if (!airportId) return { kind: 'normal' };

  const config = await getAirportConfig(airportId);
  if (!config || !config.airport.active) return { kind: 'normal' };

  const a = config.airport;
  return {
    kind: 'airport',
    airport: {
      id: a.id,
      iata_code: a.iata_code,
      display_name: a.display_name,
      municipality: a.municipality,
      state_code: a.state_code,
      coverage_status: a.coverage_status,
      lat: a.lat,
      lng: a.lng,
    },
    flow: flowFor(config),
  };
}

// ── Airlines ─────────────────────────────────────────────────────────────

interface AirlineServiceRow {
  popularity_rank: number | null;
  airlines: { id: string; display_name: string; iata_code: string | null; active: boolean } | null;
}

function rankSort(a: AirlineSummary, b: AirlineSummary): number {
  if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank !== null && b.rank === null) return -1;
  if (a.rank === null && b.rank !== null) return 1;
  return a.display_name.localeCompare(b.display_name);
}

export async function popularAirlines(airportId: string, limit = 8): Promise<AirlineSummary[]> {
  const cached = airlinesCache.get(airlinesKey(airportId));
  if (cached) return cached.slice(0, limit);

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('airport_airline_services')
    .select('popularity_rank, airlines!inner(id, display_name, iata_code, active)')
    .eq('airport_id', airportId)
    .eq('active', true)
    .eq('airlines.active', true)
    .limit(100);

  if (error) throw new Error(`airline list load failed: ${error.message}`);

  const airlines = ((data ?? []) as unknown as AirlineServiceRow[])
    .filter((row) => row.airlines)
    .map((row) => ({
      id: row.airlines!.id,
      display_name: row.airlines!.display_name,
      iata_code: row.airlines!.iata_code,
      rank: row.popularity_rank,
    }))
    .sort(rankSort);

  airlinesCache.set(airlinesKey(airportId), airlines);
  return airlines.slice(0, limit);
}

/** Sanitize a user search term for use inside PostgREST ilike patterns. */
function sanitizeSearchTerm(q: string): string {
  return q.replace(/[^a-zA-Z0-9 \-']/g, '').trim().slice(0, 50);
}

export async function searchAirportAirlines(airportId: string, q: string): Promise<AirlineSummary[]> {
  const term = sanitizeSearchTerm(q);
  if (!term) return popularAirlines(airportId, 50);

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('airport_airline_services')
    .select('popularity_rank, airlines!inner(id, display_name, iata_code, active)')
    .eq('airport_id', airportId)
    .eq('active', true)
    .eq('airlines.active', true)
    .or(`display_name.ilike.%${term}%,iata_code.ilike.${term}`, { referencedTable: 'airlines' })
    .limit(50);

  if (error) throw new Error(`airline search failed: ${error.message}`);

  return ((data ?? []) as unknown as AirlineServiceRow[])
    .filter((row) => row.airlines)
    .map((row) => ({
      id: row.airlines!.id,
      display_name: row.airlines!.display_name,
      iata_code: row.airlines!.iata_code,
      rank: row.popularity_rank,
    }))
    .sort(rankSort);
}

// ── Access resolution (airline → terminal + service point) ───────────────

function bestPointOfType(
  config: AirportCoreConfig,
  pointType: AirportServicePointType,
): ServicePointRecord | null {
  // servicePoints are pre-sorted verified-first, then name.
  return config.servicePoints.find((p) => p.point_type === pointType) ?? null;
}

function fallbackMethodFor(point: ServicePointRecord): AirportSelectionMethod {
  return point.verified ? 'verified_fallback' : 'manual';
}

/**
 * General fallback when no airline is chosen (or the airline has no
 * assignment): dropoff → general departures curb, pickup → rideshare zone.
 * Null when the airport has no suitable ACTIVE point — callers must treat
 * that as "flow unavailable", NEVER substitute the airport centroid.
 */
export async function resolveGeneralFallback(
  airportId: string,
  direction: TripAirportDirection,
): Promise<ResolvedAccess | null> {
  const config = await getAirportConfig(airportId);
  if (!config) return null;

  const pointType: AirportServicePointType =
    direction === 'airport_dropoff' ? 'general_departures_dropoff' : 'rideshare_pickup';
  const point = bestPointOfType(config, pointType);
  if (!point) return null;

  const terminal = point.terminal_id
    ? config.terminals.find((t) => t.id === point.terminal_id) ?? null
    : null;

  return {
    airline: null,
    terminal,
    servicePoint: point,
    selectionMethod: fallbackMethodFor(point),
  };
}

/**
 * Resolve where a specific airline is served for a direction. Uses the
 * active airline assignment when one exists (and its point is active and of
 * a bookable type); otherwise falls back to the general point.
 */
export async function resolveAirlineAccess(
  airportId: string,
  airlineId: string,
  direction: TripAirportDirection,
): Promise<ResolvedAccess | null> {
  const config = await getAirportConfig(airportId);
  if (!config) return null;

  const svc = createServiceClient();
  const [airlineRes, assignmentRes] = await Promise.all([
    svc
      .from('airlines')
      .select('id, display_name, iata_code, updated_at')
      .eq('id', airlineId)
      .eq('active', true)
      .maybeSingle(),
    svc
      .from('airport_airline_assignments')
      .select('terminal_id, departures_service_point_id, arrivals_service_point_id')
      .eq('airport_id', airportId)
      .eq('airline_id', airlineId)
      .eq('active', true)
      .maybeSingle(),
  ]);

  const airline = airlineRes.data ?? null;
  if (!airline) return null;

  const assignment = assignmentRes.data ?? null;

  let point: ServicePointRecord | null = null;
  let terminal: TerminalRecord | null = null;
  let selectionMethod: AirportSelectionMethod = 'airline';

  if (assignment) {
    const wantedId =
      direction === 'airport_dropoff'
        ? assignment.departures_service_point_id
        : assignment.arrivals_service_point_id;
    if (wantedId) {
      const candidate = config.servicePoints.find((p) => p.id === wantedId) ?? null;
      // The assignment's point must still be active (it is, if present in
      // config) and actually bookable for this direction — an
      // arrivals_reference row is context, never a pickup spot.
      if (candidate && servicePointTypeAllowed(direction, candidate.point_type)) {
        point = candidate;
      }
    }
    if (assignment.terminal_id) {
      terminal = config.terminals.find((t) => t.id === assignment.terminal_id) ?? null;
    }
  }

  if (!point) {
    const fallback = await resolveGeneralFallback(airportId, direction);
    if (!fallback) return null;
    point = fallback.servicePoint;
    terminal = terminal ?? fallback.terminal;
    selectionMethod = fallbackMethodFor(point);
  }

  if (!terminal && point.terminal_id) {
    terminal = config.terminals.find((t) => t.id === point!.terminal_id) ?? null;
  }

  return { airline, terminal, servicePoint: point, selectionMethod };
}

// ── Fees & instructions ──────────────────────────────────────────────────

export async function airportFee(
  airportId: string,
  direction: TripAirportDirection,
): Promise<number | null> {
  const fee = await airportFeeDetail(airportId, direction);
  return fee ? fee.amount : null;
}

export async function airportFeeDetail(
  airportId: string,
  direction: TripAirportDirection,
): Promise<AirportFee | null> {
  const config = await getAirportConfig(airportId);
  if (!config) return null;
  const today = new Date().toISOString().slice(0, 10);
  return selectAirportFee(config.feeRules, direction, today);
}

export async function instructionsFor(
  airportId: string,
  servicePointId: string | null,
  direction: TripAirportDirection,
  audience: 'rider' | 'driver',
): Promise<InstructionRecord[]> {
  const svc = createServiceClient();
  let query = svc
    .from('airport_instructions')
    .select('title, body, image_url, updated_at')
    .eq('airport_id', airportId)
    .eq('active', true)
    .eq('direction', instructionDirectionFor(direction))
    .in('audience', [audience, 'both'])
    .order('display_order', { ascending: true })
    .limit(20);

  query = servicePointId
    ? query.or(`service_point_id.is.null,service_point_id.eq.${servicePointId}`)
    : query.is('service_point_id', null);

  const { data, error } = await query;
  if (error) throw new Error(`instructions load failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    title: row.title as string,
    body: row.body as string,
    ...(row.image_url ? { image_url: row.image_url as string } : {}),
    updated_at: row.updated_at as string,
  }));
}

// ── Snapshot ─────────────────────────────────────────────────────────────

export interface SnapshotInput {
  airportId: string;
  direction: TripAirportDirection;
  servicePointId: string;
  airlineId?: string | null;
  terminalId?: string | null;
  flightNumber?: string | null;
  selectionMethod: AirportSelectionMethod;
}

/**
 * Build the immutable trip snapshot server-side from live config. Throws when
 * a referenced row is missing/inactive — callers validate first with
 * validateAirportContext().
 */
export async function buildAirportSnapshot(input: SnapshotInput): Promise<AirportSnapshot> {
  const config = await getAirportConfig(input.airportId);
  if (!config) throw new Error('airport_not_found');

  const point = config.servicePoints.find((p) => p.id === input.servicePointId);
  if (!point) throw new Error('service_point_not_found');

  const terminal = input.terminalId
    ? config.terminals.find((t) => t.id === input.terminalId) ?? null
    : point.terminal_id
      ? config.terminals.find((t) => t.id === point.terminal_id) ?? null
      : null;

  let airline: { id: string; display_name: string; iata_code: string | null; updated_at: string } | null = null;
  if (input.airlineId) {
    const svc = createServiceClient();
    const { data } = await svc
      .from('airlines')
      .select('id, display_name, iata_code, updated_at')
      .eq('id', input.airlineId)
      .eq('active', true)
      .maybeSingle();
    airline = data ?? null;
  }

  const [riderInstructions, driverInstructions] = await Promise.all([
    instructionsFor(input.airportId, point.id, input.direction, 'rider'),
    instructionsFor(input.airportId, point.id, input.direction, 'driver'),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const fee = selectAirportFee(config.feeRules, input.direction, today);

  return composeAirportSnapshot({
    airport: {
      id: config.airport.id,
      iata_code: config.airport.iata_code,
      display_name: config.airport.display_name,
      updated_at: config.airport.updated_at,
    },
    direction: input.direction,
    airline,
    terminal,
    servicePoint: point,
    riderInstructions,
    driverInstructions,
    fee: fee ? { amount: fee.amount, currency: fee.currency } : null,
    flightNumber: input.flightNumber ?? null,
    selectionMethod: input.selectionMethod,
    extraVersions: config.feeRules.map((r) => r.updated_at),
  });
}

// ── Booking-time validation ──────────────────────────────────────────────

export interface ValidateContextInput {
  airportId: string;
  direction: TripAirportDirection;
  servicePointId: string;
  airlineId?: string | null;
  terminalId?: string | null;
}

export type ValidateContextResult =
  | { ok: true; servicePoint: ServicePointRecord }
  | { ok: false; error: string };

/**
 * Validate a client-submitted airport context against live config: the
 * service point must be active, belong to the airport, and be of a type
 * bookable for the direction. Airline/terminal, when given, must be active
 * and consistent with the active airline assignment when one exists.
 */
export async function validateAirportContext(
  input: ValidateContextInput,
): Promise<ValidateContextResult> {
  const config = await getAirportConfig(input.airportId);
  if (!config || !config.airport.active) {
    return { ok: false, error: 'Airport is not available.' };
  }

  const point = config.servicePoints.find((p) => p.id === input.servicePointId);
  if (!point) {
    return { ok: false, error: 'Airport selection is out of date — please reselect.' };
  }
  if (!servicePointTypeAllowed(input.direction, point.point_type)) {
    return { ok: false, error: 'Selected airport location does not match the trip direction.' };
  }

  if (input.terminalId) {
    const terminal = config.terminals.find((t) => t.id === input.terminalId);
    if (!terminal) {
      return { ok: false, error: 'Airport terminal is no longer available.' };
    }
  }

  if (input.airlineId) {
    const svc = createServiceClient();
    const [airlineRes, assignmentRes] = await Promise.all([
      svc.from('airlines').select('id').eq('id', input.airlineId).eq('active', true).maybeSingle(),
      svc
        .from('airport_airline_assignments')
        .select('terminal_id, departures_service_point_id, arrivals_service_point_id')
        .eq('airport_id', input.airportId)
        .eq('airline_id', input.airlineId)
        .eq('active', true)
        .maybeSingle(),
    ]);

    if (!airlineRes.data) {
      return { ok: false, error: 'Airline is no longer available.' };
    }

    const assignment = assignmentRes.data;
    if (assignment) {
      if (input.terminalId && assignment.terminal_id && assignment.terminal_id !== input.terminalId) {
        return { ok: false, error: 'Airline terminal changed — please reselect.' };
      }
      // An airline-specific curb must be the assignment's curb; the general
      // fallback point is always acceptable.
      if (
        input.direction === 'airport_dropoff' &&
        point.point_type === 'airline_departures_dropoff' &&
        assignment.departures_service_point_id &&
        assignment.departures_service_point_id !== point.id
      ) {
        return { ok: false, error: 'Airline drop-off location changed — please reselect.' };
      }
    }
  }

  return { ok: true, servicePoint: point };
}
