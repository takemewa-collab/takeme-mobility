/**
 * VIN decoding behind a provider abstraction. Default provider is the free
 * NHTSA vPIC service (no credentials). Failures degrade to manual entry —
 * a decode outage must never block an application.
 */
import { normalizePowertrain } from './ev-eligibility';
import type { VehicleFacts } from './types';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function normalizeVin(raw: string): string | null {
  const vin = raw.trim().toUpperCase();
  return VIN_RE.test(vin) ? vin : null;
}

export function normalizePlate(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface VinDecodeResult {
  ok: boolean;
  source: 'nhtsa_vpic' | 'unavailable';
  facts: Partial<VehicleFacts> | null;
}

interface VpicRow {
  Make?: string;
  Model?: string;
  ModelYear?: string;
  Doors?: string;
  SeatBeltsAll?: string;
  BodyClass?: string;
  FuelTypePrimary?: string;
  FuelTypeSecondary?: string;
  ElectrificationLevel?: string;
  ErrorCode?: string;
}

export async function decodeVin(vin: string, fetchImpl: typeof fetch = fetch): Promise<VinDecodeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetchImpl(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`,
      { signal: controller.signal },
    );
    if (!res.ok) return { ok: false, source: 'unavailable', facts: null };
    const json = (await res.json()) as { Results?: VpicRow[] };
    const row = json.Results?.[0];
    if (!row) return { ok: false, source: 'unavailable', facts: null };

    const year = row.ModelYear ? parseInt(row.ModelYear, 10) : NaN;
    const doors = row.Doors ? parseInt(row.Doors, 10) : NaN;
    const belts = row.SeatBeltsAll ? parseInt(row.SeatBeltsAll, 10) : NaN;
    const facts: Partial<VehicleFacts> = {
      vin,
      make: row.Make?.trim() || null,
      model: row.Model?.trim() || null,
      year: Number.isFinite(year) ? year : null,
      doors: Number.isFinite(doors) ? doors : null,
      seatbelts: Number.isFinite(belts) ? belts : null,
      bodyType: row.BodyClass?.trim() || null,
      powertrain: normalizePowertrain(row),
    };
    // vPIC returns a row even for junk VINs; require at least a make or year.
    if (!facts.make && facts.year == null) {
      return { ok: false, source: 'nhtsa_vpic', facts: null };
    }
    return { ok: true, source: 'nhtsa_vpic', facts };
  } catch {
    return { ok: false, source: 'unavailable', facts: null };
  } finally {
    clearTimeout(timer);
  }
}
