/**
 * Airport Intelligence Platform — official-data ingestion contracts.
 *
 * Pure types + pure helpers shared by the API layer and tests. The runnable
 * importers live in scripts/airport-import/*.mjs (plain Node, JSDoc-typed) and
 * mirror the pure helpers below 1:1 — if you change a helper here, change its
 * twin in scripts/airport-import/common.mjs (see docs/airport-data-imports.md).
 *
 * Nothing in this module touches the network or the database.
 */

// ── Source registry ──────────────────────────────────────────────────────────

export type ImportSource = 'faa_nasr' | 'faa_enplanements' | 'bts_t100' | 'curated';

export type ImportStatus = 'running' | 'succeeded' | 'failed' | 'partial';

/** Counts recorded on airport_data_imports.counts. */
export interface ImportCounts {
  inserted?: number;
  updated?: number;
  deactivated?: number;
  /** number of skipped records, or the literal 'unchanged' on a checksum short-circuit */
  skipped?: number | 'unchanged';
  [extra: string]: number | string | undefined;
}

/** Lineage stamped into airports.source / airlines.source / services.source. */
export interface SourceLineage {
  provider: ImportSource;
  /** e.g. NASR edition '2026-07-09', 'CY2024', 'T100 2024-07..2025-06' */
  edition?: string;
  url?: string;
  checksum?: string;
  imported_at?: string;
  [extra: string]: string | number | boolean | undefined;
}

// ── FAA NASR (28-day subscription, APT_BASE.csv) ─────────────────────────────

export type AirportType =
  | 'airport'
  | 'heliport'
  | 'seaplane_base'
  | 'gliderport'
  | 'balloonport'
  | 'ultralight';

/** NASR SITE_TYPE_CODE → airports.airport_type. */
export const NASR_SITE_TYPE: Readonly<Record<string, AirportType>> = {
  A: 'airport',
  B: 'balloonport',
  C: 'seaplane_base',
  G: 'gliderport',
  H: 'heliport',
  U: 'ultralight',
};

/** Military ownership codes in NASR OWNERSHIP_TYPE_CODE. */
export const NASR_MILITARY_OWNERSHIP = new Set(['MA', 'MN', 'MR', 'CG']);

/** Detection radius defaults by facility type (meters). */
export const DETECTION_RADIUS_AIRPORT_M = 2500;
export const DETECTION_RADIUS_OTHER_M = 800;

/** The APT_BASE.csv columns the importer depends on (must exist in the header). */
export const NASR_REQUIRED_COLUMNS = [
  'ARPT_ID',
  'ICAO_ID',
  'SITE_TYPE_CODE',
  'STATE_CODE',
  'ARPT_NAME',
  'CITY',
  'COUNTRY_CODE',
  'OWNERSHIP_TYPE_CODE',
  'FACILITY_USE_CODE',
  'LAT_DECIMAL',
  'LONG_DECIMAL',
  'ARPT_STATUS',
] as const;

export interface NasrAirportRecord {
  faaLid: string;
  icaoId: string | null;
  siteType: AirportType;
  stateCode: string | null;
  officialName: string;
  municipality: string | null;
  lat: number;
  lng: number;
  ownershipUse: string;
  privateUse: boolean;
  militaryOnly: boolean;
  arptStatus: string;
}

// ── FAA enplanements (passenger boardings, yearly) ───────────────────────────

export type ServiceClass =
  | 'large_hub'
  | 'medium_hub'
  | 'small_hub'
  | 'nonhub_primary'
  | 'nonprimary_commercial'
  | 'reliever'
  | 'general_aviation'
  | 'unclassified';

export interface EnplanementRecord {
  /** FAA LID from the file's Locid column */
  locid: string;
  /** S/L: 'P' primary, 'CS' commercial service, 'R' reliever, 'GA' general aviation */
  serviceLevel: string;
  /** Hub: 'L' | 'M' | 'S' | 'N' | '' */
  hub: string;
  enplanements: number;
  year: number;
}

/** Service classes considered commercial passenger service. */
export const COMMERCIAL_SERVICE_CLASSES: ReadonlySet<ServiceClass> = new Set([
  'large_hub',
  'medium_hub',
  'small_hub',
  'nonhub_primary',
  'nonprimary_commercial',
]);

/**
 * FAA hub / service-level classification → airports.service_class.
 * Returns null when the file row carries no classification we recognize
 * (the airport's existing service_class must then be left untouched).
 */
export function classifyServiceClass(serviceLevel: string, hub: string): ServiceClass | null {
  const sl = serviceLevel.trim().toUpperCase();
  const h = hub.trim().toUpperCase();
  if (sl === 'P') {
    if (h === 'L') return 'large_hub';
    if (h === 'M') return 'medium_hub';
    if (h === 'S') return 'small_hub';
    return 'nonhub_primary';
  }
  if (sl === 'CS') return 'nonprimary_commercial';
  if (sl === 'R') return 'reliever';
  if (sl === 'GA') return 'general_aviation';
  return null;
}

// ── BTS T-100 (airline service, rolling 12 months) ───────────────────────────

/** Expected columns of a manually downloaded T-100 Segment/Market extract. */
export const T100_REQUIRED_COLUMNS = [
  'UNIQUE_CARRIER',
  'CARRIER_NAME',
  'ORIGIN',
  'PASSENGERS',
  'YEAR',
  'MONTH',
] as const;

export interface T100AggregateRow {
  uniqueCarrier: string;
  carrierName: string;
  originLid: string;
  passengers: number;
}

// ── Pure helpers (mirrored in scripts/airport-import/common.mjs) ─────────────

const TITLE_SMALL_WORDS = new Set(['of', 'the', 'at', 'on', 'and', 'for', 'de', 'la']);
const TITLE_KEEP_UPPER = /^(?:[IVX]+|USA|US|AFB|AAF|NAS|NAF|MCAS|ANGB|ANG|JB|LLC|Inc\.?)$/i;

/**
 * Title-case an ALL-CAPS official facility name sensibly:
 * "SEATTLE-TACOMA INTL" → "Seattle-Tacoma Intl",
 * "ST. LUKES" → "St. Lukes", "NAS WHIDBEY" keeps "NAS", roman numerals kept.
 */
export function titleCaseName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;
  const words = trimmed.split(' ').map((word, wi) => {
    if (TITLE_KEEP_UPPER.test(word)) return word.toUpperCase();
    const lower = word.toLowerCase();
    if (wi > 0 && TITLE_SMALL_WORDS.has(lower)) return lower;
    // Capitalize the first letter of each hyphen-/slash-separated segment.
    return lower.replace(/(^|[-/(.])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
  });
  return words.join(' ');
}

/** lower-case, alphanumeric + single spaces — the controlled-alias key. */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split an array into chunks of at most `size` (used for 500-row upserts). */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error('chunkArray: size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[]);
  }
  return out;
}

/** Valid ICAO airport identifier for our schema (4 alphanumerics). */
export function isValidIcao(value: string | null | undefined): value is string {
  return !!value && /^[A-Z0-9]{4}$/.test(value);
}

/** Valid IATA identifier for our schema (3 alphanumerics; we only auto-assign pure alpha). */
export function isValidIata(value: string | null | undefined): value is string {
  return !!value && /^[A-Z0-9]{3}$/.test(value);
}
