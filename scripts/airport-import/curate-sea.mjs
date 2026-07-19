// Curated data load: SEA (Seattle-Tacoma International Airport) — the first
// fully verified airport in the Airport Intelligence Platform.
//
//   node scripts/airport-import/curate-sea.mjs
//
// Follows the curated-data pipeline rules in docs/airport-data-imports.md:
// everything is wrapped in an airport_data_imports row (source='curated') with
// a checksum of the curated payload; every row carries source jsonb with
// provider:'curated' plus the official URL and accessed date. Idempotent:
// airlines match by iata_code, services by (airport, airline), terminals by
// (airport, code), service points by (airport, name), instructions by
// (airport, audience, direction, title), identifiers by (type, value).
// Re-running with an unchanged payload against an already-verified SEA
// short-circuits with counts {skipped:'unchanged'}.
//
// Research sources (all accessed 2026-07-17):
//  * Airlines list:   https://www.portseattle.org/sea/airlines-destinations
//  * Rideshare pickup: https://www.portseattle.org/sea/ground-transportation/app-based-rideshare
//  * Pickup FAQ:      https://www.portseattle.org/faq/where-app-based-rideshare-pick-area
//  * Stats portal:    https://www.portseattle.org/page/airport-statistics
//  * CY2025 ranking:  https://api-pos.azure-api.net/aamwww/pos/StatisticalReports/Public/paxcomp-122025.xls
//    (Port of Seattle "Total Passengers by Airline", December 2025 report,
//    Year-To-Date column = calendar year 2025; total 52,715,181 passengers.)
//
// Deliberately NOT loaded (unverifiable from official sources):
//  * Per-airline curb/terminal assignments — SEA publishes no stable
//    airline-to-curb mapping; all airlines use the general Departures Drive
//    drop-off. airport_airline_assignments stays empty.
//  * airport_fee rule — no rider-facing per-trip TNC fee is documented on
//    portseattle.org rider pages; no fee row is created.
//
// Coordinates were chosen from official guidance and cross-checked against
// OpenStreetMap geometry (Overpass, accessed 2026-07-17): the drop-off sits on
// the "Departures Drive" way 37017723 (layer 2, ticketing level) in front of
// the Sea-Tac Airport Main Terminal (way 23772634, center 47.4425,-122.3008);
// the pickup is the centroid of the Port of Seattle multi-storey parking
// garage (relation 15763840, 7 levels, center 47.44328,-122.29924). Both are
// ~1.1 km from the catalog centroid (ARP), far beyond the 25 m anti-centroid
// trigger.

import {
  createServiceClient,
  must,
  withNetRetry,
  sha256Hex,
  shortCircuitIfUnchanged,
  startImport,
  finishImport,
} from './common.mjs';

const ACCESSED = '2026-07-17';
const EFFECTIVE_DATE = '2026-07-17';
const SOURCE_VERSION = 'SEA curation 2026-07';
const REPORTING_PERIOD = 'Port of Seattle CY2025 traffic (Total Passengers by Airline, Dec 2025 YTD); curated 2026-07';

const URLS = {
  airlines: 'https://www.portseattle.org/sea/airlines-destinations',
  rideshare: 'https://www.portseattle.org/sea/ground-transportation/app-based-rideshare',
  rideshareFaq: 'https://www.portseattle.org/faq/where-app-based-rideshare-pick-area',
  stats: 'https://www.portseattle.org/page/airport-statistics',
  paxByAirline: 'https://api-pos.azure-api.net/aamwww/pos/StatisticalReports/Public/paxcomp-122025.xls',
};

const CY2025_TOTAL_PAX = 52_715_181;

function curatedSource(url, extra = {}) {
  return { provider: 'curated', url, accessed: ACCESSED, ...extra };
}

// ── Airlines (Port of Seattle "Airlines and Destinations", accessed 2026-07-17)
// 37 airlines are listed; AMC (Air Mobility Command — US military charter, no
// IATA code, not bookable by the public) is deliberately excluded → 36 rows.
// cy2025 = CY2025 total passengers from the Dec-2025 YTD report. Regional
// operations flown under a mainline brand (Horizon Air, SkyWest capacity for
// Alaska/Delta/United/American, Air Canada Jazz) are attributed to the
// marketing brand, since riders book the brand; the components are recorded in
// metrics. Cathay Pacific is listed as serving SEA but reported no CY2025
// passengers (service post-dates CY2025) — it ranks last with a null score.
const AIRLINES = [
  { iata: 'AS', icao: 'ASA', name: 'Alaska Airlines', legal: 'Alaska Airlines, Inc.', country: 'US',
    cy2025: 26_751_971, components: { 'AS Alaska Airlines': 22_440_925, 'QX Horizon Air': 2_919_727, 'OO2 Alaska/Skywest': 1_391_319 } },
  { iata: 'DL', icao: 'DAL', name: 'Delta Air Lines', legal: 'Delta Air Lines, Inc.', country: 'US',
    cy2025: 12_720_844, components: { 'DL Delta Air Lines': 10_393_614, 'OO1 Delta Connection/Skywest': 2_327_230 } },
  { iata: 'UA', icao: 'UAL', name: 'United Airlines', legal: 'United Airlines, Inc.', country: 'US',
    cy2025: 2_723_502, components: { 'UA United Airlines': 2_677_663, 'OO United Express/Skywest': 45_839 } },
  { iata: 'AA', icao: 'AAL', name: 'American Airlines', legal: 'American Airlines, Inc.', country: 'US',
    cy2025: 2_305_087, components: { 'AA American Airlines': 2_062_354, 'OO3 American Eagle/Skywest': 242_733 } },
  { iata: 'WN', icao: 'SWA', name: 'Southwest Airlines', legal: 'Southwest Airlines Co.', country: 'US', cy2025: 2_193_476 },
  { iata: 'HA', icao: 'HAL', name: 'Hawaiian Airlines', legal: 'Hawaiian Airlines, Inc.', country: 'US', cy2025: 885_094 },
  { iata: 'F9', icao: 'FFT', name: 'Frontier Airlines', legal: 'Frontier Airlines, Inc.', country: 'US', cy2025: 542_760 },
  { iata: 'BR', icao: 'EVA', name: 'EVA Air', legal: 'EVA Airways Corporation', country: 'TW', cy2025: 297_272 },
  { iata: 'BA', icao: 'BAW', name: 'British Airways', legal: 'British Airways Plc', country: 'GB', cy2025: 285_155 },
  { iata: 'AC', icao: 'ACA', name: 'Air Canada', legal: 'Air Canada', country: 'CA',
    cy2025: 264_965, components: { 'AC Air Canada': 112_584, 'QK Air Canada Jazz': 152_381 } },
  { iata: 'QR', icao: 'QTR', name: 'Qatar Airways', legal: 'Qatar Airways Group Q.C.S.C.', country: 'QA', cy2025: 239_088 },
  { iata: 'LH', icao: 'DLH', name: 'Lufthansa', legal: 'Deutsche Lufthansa AG', country: 'DE', cy2025: 218_434 },
  { iata: 'TK', icao: 'THY', name: 'Turkish Airlines', legal: 'Türk Hava Yolları A.O.', country: 'TR', cy2025: 209_065 },
  { iata: 'FI', icao: 'ICE', name: 'Icelandair', legal: 'Icelandair ehf.', country: 'IS', cy2025: 205_767 },
  { iata: 'KE', icao: 'KAL', name: 'Korean Air', legal: 'Korean Air Lines Co., Ltd.', country: 'KR', cy2025: 194_042 },
  { iata: 'EK', icao: 'UAE', name: 'Emirates', legal: 'Emirates', country: 'AE', cy2025: 186_920 },
  { iata: 'OZ', icao: 'AAR', name: 'Asiana Airlines', legal: 'Asiana Airlines, Inc.', country: 'KR', cy2025: 170_729 },
  { iata: 'B6', icao: 'JBU', name: 'JetBlue Airways', legal: 'JetBlue Airways Corporation', country: 'US', cy2025: 169_872 },
  { iata: 'JX', icao: 'SJX', name: 'STARLUX Airlines', legal: 'STARLUX Airlines Co., Ltd.', country: 'TW', cy2025: 158_835 },
  { iata: 'WS', icao: 'WJA', name: 'WestJet', legal: 'WestJet Airlines Ltd.', country: 'CA', cy2025: 151_871 },
  { iata: 'NH', icao: 'ANA', name: 'ANA (All Nippon Airways)', legal: 'All Nippon Airways Co., Ltd.', country: 'JP', cy2025: 136_725 },
  { iata: 'VS', icao: 'VIR', name: 'Virgin Atlantic', legal: 'Virgin Atlantic Airways Ltd.', country: 'GB', cy2025: 134_188 },
  { iata: 'DE', icao: 'CFG', name: 'Condor', legal: 'Condor Flugdienst GmbH', country: 'DE', cy2025: 133_156 },
  { iata: 'SY', icao: 'SCX', name: 'Sun Country Airlines', legal: 'Sun Country, Inc.', country: 'US', cy2025: 132_024 },
  { iata: 'CI', icao: 'CAL', name: 'China Airlines', legal: 'China Airlines, Ltd.', country: 'TW', cy2025: 129_777 },
  { iata: 'JL', icao: 'JAL', name: 'Japan Airlines', legal: 'Japan Airlines Co., Ltd.', country: 'JP', cy2025: 126_272 },
  { iata: 'Y4', icao: 'VOI', name: 'Volaris', legal: 'Concesionaria Vuela Compañía de Aviación, S.A.P.I. de C.V.', country: 'MX', cy2025: 125_954 },
  { iata: 'AM', icao: 'AMX', name: 'Aeroméxico', legal: 'Aerovías de México, S.A. de C.V.', country: 'MX', cy2025: 120_431 },
  { iata: 'AF', icao: 'AFR', name: 'Air France', legal: 'Société Air France, S.A.', country: 'FR', cy2025: 114_409 },
  { iata: 'EI', icao: 'EIN', name: 'Aer Lingus', legal: 'Aer Lingus Limited', country: 'IE', cy2025: 114_362 },
  { iata: 'SQ', icao: 'SIA', name: 'Singapore Airlines', legal: 'Singapore Airlines Limited', country: 'SG', cy2025: 111_112 },
  { iata: 'PR', icao: 'PAL', name: 'Philippine Airlines', legal: 'Philippine Airlines, Inc.', country: 'PH', cy2025: 98_294 },
  { iata: 'HU', icao: 'CHH', name: 'Hainan Airlines', legal: 'Hainan Airlines Holding Co., Ltd.', country: 'CN', cy2025: 72_330 },
  { iata: 'SK', icao: 'SAS', name: 'SAS', legal: 'Scandinavian Airlines System', country: 'SE', cy2025: 47_370 },
  { iata: 'AY', icao: 'FIN', name: 'Finnair', legal: 'Finnair Oyj', country: 'FI', cy2025: 24_734 },
  { iata: 'CX', icao: 'CPA', name: 'Cathay Pacific', legal: 'Cathay Pacific Airways Limited', country: 'HK', cy2025: null },
];

// ── Terminal (SEA is a single-terminal airport; concourses A–D and the N/S
// satellites are airside and share the same landside curbs — not separate rows).
const TERMINAL = {
  code: 'Main',
  name: 'Main Terminal',
  display_order: 0,
  lat: 47.4425,     // Sea-Tac Airport Main Terminal building center (OSM way 23772634)
  lng: -122.3008,
};

// ── Service points ───────────────────────────────────────────────────────────
const SERVICE_POINTS = [
  {
    key: 'dropoff',
    point_type: 'general_departures_dropoff',
    name: 'Departures Drive drop-off',
    lat: 47.44283,   // node on "Departures Drive" (OSM way 37017723, layer 2 =
    lng: -122.300959, // ticketing level) in front of the Main Terminal
    level: '2',
    zone: 'Departures Drive — ticketing curb',
    restrictions: 'Active loading and unloading only. Departures drives are often congested 6–8 a.m.',
    on_terminal: true,
    source: curatedSource(URLS.rideshare, {
      note: 'Passengers using app-based rideshare at SEA are dropped off at the terminal on the airport drives. Coordinate on Departures Drive (ticketing level) in front of the Main Terminal; cross-checked against OSM way 37017723 / terminal way 23772634.',
    }),
  },
  {
    key: 'pickup',
    point_type: 'rideshare_pickup',
    name: 'Rideshare pickup — Parking garage, 3rd floor',
    lat: 47.44328,   // centroid of the Port of Seattle multi-storey parking
    lng: -122.29924, // garage (OSM relation 15763840); stalls 1–34 are in the middle of the garage
    level: '3',
    zone: 'Ground Transportation Plaza — stalls 1–34, middle of the garage',
    restrictions: 'Wait until your assigned vehicle has parked before boarding.',
    on_terminal: false, // the garage is a standalone landside structure
    source: curatedSource(URLS.rideshare, {
      note: '"Uber and Lyft Ride App pick-up is available on the 3rd floor of the airport parking garage" — TNC/Rideshare pickup area in marked stalls 1–34 in the middle of the parking garage. Coordinate is the garage centroid, cross-checked against OSM relation 15763840 (Port of Seattle, parking=multi-storey, 7 levels).',
      also: URLS.rideshareFaq,
    }),
  },
  {
    key: 'arrivals',
    point_type: 'arrivals_reference',
    name: 'Baggage claim (arrivals reference)',
    lat: 47.4425,    // Main Terminal building center; baggage claim is the
    lng: -122.3008,  // lower landside level. Non-bookable context.
    level: '1',
    zone: 'Baggage claim, lower level',
    restrictions: null,
    on_terminal: true,
    source: curatedSource(URLS.rideshare, {
      note: 'Non-bookable reference: baggage claim level of the Main Terminal. Rideshare pickup is NOT at this curb (garage 3rd floor); premium products excepted per official guidance.',
    }),
  },
];

// ── Instructions (official Port of Seattle wording, condensed) ──────────────
const INSTRUCTIONS = [
  {
    audience: 'rider', direction: 'dropoff', point: 'dropoff', display_order: 0,
    title: 'Drop-off at Departures Drive',
    body: 'Your driver will drop you off at the terminal on the airport drives. Follow signs for Departures — airline check-in areas are along the ticketing curb. During peak congestion your driver may use the Arrivals drive instead; from baggage-claim level, take the elevator or escalator up one level to ticketing. Departure drives are busiest 6–8 a.m.',
    source: curatedSource(URLS.rideshare),
  },
  {
    audience: 'rider', direction: 'pickup', point: 'pickup', display_order: 0,
    title: 'Pickup: parking garage, 3rd floor',
    body: 'Walk across the skybridges (a level below ticketing, a level above baggage claim) and go down one level to the 3rd floor of the parking garage. Follow the App-Based Rideshare signs to the Ground Transportation Plaza — pickups are in marked stalls 1–34 in the middle of the garage. Wait until your assigned vehicle has parked before boarding.',
    source: curatedSource(URLS.rideshare, { also: URLS.rideshareFaq }),
  },
  {
    audience: 'driver', direction: 'pickup', point: 'pickup', display_order: 0,
    title: 'Rider pickup: garage 3rd floor',
    body: 'Enter the airport parking garage and proceed to the 3rd-floor Ground Transportation Plaza rideshare pickup area (marked stalls 1–34, middle of the garage). Park fully in a stall before your rider boards, and obey all posted rideshare signage.',
    source: curatedSource(URLS.rideshare),
  },
  {
    audience: 'driver', direction: 'dropoff', point: 'dropoff', display_order: 0,
    title: 'Rider drop-off: Departures Drive',
    body: 'Drop riders at the ticketing curb on Departures Drive. Active loading and unloading only — do not wait at the curb. During peak congestion the Arrivals drive may be used to avoid delays.',
    source: curatedSource(URLS.rideshare),
  },
];

// ── Alias identifiers (normalized per lib/airports/logic.ts normalizePlaceName:
// lower, collapse non-alphanumerics to single spaces, trim).
const ALIASES = ['seatac', 'seatac airport', 'seattle tacoma international airport'];

// ── Payload checksum (idempotency short-circuit) ────────────────────────────
const PAYLOAD = { URLS, REPORTING_PERIOD, AIRLINES, TERMINAL, SERVICE_POINTS, INSTRUCTIONS, ALIASES };
const CHECKSUM = sha256Hex(Buffer.from(JSON.stringify(PAYLOAD)));

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const sb = createServiceClient();

  const sea = must('lookup SEA', await sb
    .from('airports')
    .select('id, coverage_status, lat, lng')
    .eq('faa_lid', 'SEA').eq('catalog_status', 'active').single());
  console.log(`SEA airport: ${sea.id} (coverage_status=${sea.coverage_status})`);

  // Short-circuit only when the payload is unchanged AND the airport already
  // reached 'verified' — a crashed prior run must be resumable.
  if (sea.coverage_status === 'verified') {
    const shortId = await shortCircuitIfUnchanged(sb, 'curated', CHECKSUM, SOURCE_VERSION, EFFECTIVE_DATE);
    if (shortId) {
      console.log(`Payload unchanged and SEA already verified; short-circuit import ${shortId}`);
      return;
    }
  }

  const importId = await startImport(sb, 'curated', {
    sourceVersion: SOURCE_VERSION,
    effectiveDate: EFFECTIVE_DATE,
    checksum: CHECKSUM,
  });
  console.log(`import ${importId} running (checksum ${CHECKSUM.slice(0, 12)}…)`);

  const counts = {
    airlines: { inserted: 0, updated: 0, unchanged: 0 },
    services: { inserted: 0, updated: 0, unchanged: 0 },
    terminals: { inserted: 0, unchanged: 0 },
    service_points: { inserted: 0, unchanged: 0 },
    instructions: { inserted: 0, unchanged: 0 },
    identifiers: { inserted: 0, unchanged: 0 },
    rules: { inserted: 0, note: 'no rider-facing TNC fee documented on portseattle.org; deliberately no airport_fee rule' },
    assignments: { inserted: 0, note: 'no official per-airline curb mapping exists at SEA; deliberately none' },
    revisions: { inserted: 0 },
  };

  try {
    // 1. Airlines (idempotent by iata_code among active rows) ---------------
    const iatas = AIRLINES.map((a) => a.iata);
    const existingAirlines = must('select airlines', await withNetRetry('select airlines', async () =>
      sb.from('airlines').select('id, iata_code, legal_name, display_name, icao_code, country_code').in('iata_code', iatas).eq('active', true)));
    const byIata = new Map(existingAirlines.map((r) => [r.iata_code, r]));
    const airlineIds = new Map(); // iata → id

    for (const a of AIRLINES) {
      const row = {
        legal_name: a.legal,
        display_name: a.name,
        iata_code: a.iata,
        icao_code: a.icao,
        country_code: a.country,
        active: true,
        source: curatedSource(URLS.airlines),
      };
      const prior = byIata.get(a.iata);
      if (!prior) {
        const ins = must(`insert airline ${a.iata}`, await withNetRetry(`insert airline ${a.iata}`, async () =>
          sb.from('airlines').insert(row).select('id').single()));
        airlineIds.set(a.iata, ins.id);
        counts.airlines.inserted++;
      } else {
        airlineIds.set(a.iata, prior.id);
        const changed = prior.legal_name !== row.legal_name || prior.display_name !== row.display_name
          || prior.icao_code !== row.icao_code || prior.country_code !== row.country_code;
        if (changed) {
          must(`update airline ${a.iata}`, await withNetRetry(`update airline ${a.iata}`, async () =>
            sb.from('airlines').update(row).eq('id', prior.id)));
          counts.airlines.updated++;
        } else {
          counts.airlines.unchanged++;
        }
      }
    }

    // 2. Airline services with popularity ranking ---------------------------
    // Rank by CY2025 marketing-brand passengers (desc); carriers with no
    // CY2025 data (Cathay Pacific) rank after all scored carriers.
    const ranked = [...AIRLINES].sort((x, y) => (y.cy2025 ?? -1) - (x.cy2025 ?? -1));
    const existingServices = must('select services', await withNetRetry('select services', async () =>
      sb.from('airport_airline_services').select('id, airline_id, popularity_rank, popularity_score, reporting_period, active').eq('airport_id', sea.id)));
    const svcByAirline = new Map(existingServices.map((r) => [r.airline_id, r]));

    for (let i = 0; i < ranked.length; i++) {
      const a = ranked[i];
      const airlineId = airlineIds.get(a.iata);
      const row = {
        airport_id: sea.id,
        airline_id: airlineId,
        active: true,
        popularity_rank: i + 1,
        popularity_score: a.cy2025,
        metrics: {
          passengers_cy2025: a.cy2025,
          market_share_cy2025: a.cy2025 == null ? null : Number((a.cy2025 / CY2025_TOTAL_PAX).toFixed(4)),
          ...(a.components ? { components: a.components, methodology: 'regional operations flown under the mainline brand are attributed to the marketing carrier' } : {}),
          ...(a.cy2025 == null ? { note: 'listed on the Airlines and Destinations page but reported no CY2025 passengers (service post-dates CY2025); ranked last' } : {}),
        },
        reporting_period: REPORTING_PERIOD,
        source: curatedSource(URLS.paxByAirline, { report: 'Total Passengers by Airline, December 2025 (YTD = CY2025)', listed_at: URLS.airlines }),
      };
      const prior = svcByAirline.get(airlineId);
      if (!prior) {
        must(`insert service ${a.iata}`, await withNetRetry(`insert service ${a.iata}`, async () =>
          sb.from('airport_airline_services').insert(row)));
        counts.services.inserted++;
      } else if (prior.popularity_rank !== row.popularity_rank
          || Number(prior.popularity_score ?? NaN) !== Number(row.popularity_score ?? NaN)
          || prior.reporting_period !== row.reporting_period || !prior.active) {
        must(`update service ${a.iata}`, await withNetRetry(`update service ${a.iata}`, async () =>
          sb.from('airport_airline_services').update(row).eq('id', prior.id)));
        counts.services.updated++;
      } else {
        counts.services.unchanged++;
      }
    }

    // 3. Terminal (single 'Main' terminal; concourses are not separate curbs)
    const existingTerminals = must('select terminals', await withNetRetry('select terminals', async () =>
      sb.from('airport_terminals').select('id, code').eq('airport_id', sea.id)));
    let terminalId = existingTerminals.find((t) => t.code === TERMINAL.code)?.id;
    if (!terminalId) {
      const ins = must('insert terminal', await withNetRetry('insert terminal', async () =>
        sb.from('airport_terminals').insert({
          airport_id: sea.id,
          code: TERMINAL.code,
          name: TERMINAL.name,
          display_order: TERMINAL.display_order,
          lat: TERMINAL.lat,
          lng: TERMINAL.lng,
          active: true,
          source: curatedSource(URLS.rideshare, { note: 'SEA is a single-terminal airport (concourses A–D + North/South satellites share one landside terminal); building center from OSM way 23772634' }),
        }).select('id').single()));
      terminalId = ins.id;
      counts.terminals.inserted++;
    } else {
      counts.terminals.unchanged++;
    }

    // 4. Service points (idempotent by airport + name) -----------------------
    const existingPoints = must('select points', await withNetRetry('select points', async () =>
      sb.from('airport_service_points').select('id, name').eq('airport_id', sea.id)));
    const pointIds = new Map(); // key → id
    for (const p of SERVICE_POINTS) {
      const prior = existingPoints.find((x) => x.name === p.name);
      if (prior) {
        pointIds.set(p.key, prior.id);
        counts.service_points.unchanged++;
        continue;
      }
      const ins = must(`insert point ${p.key}`, await withNetRetry(`insert point ${p.key}`, async () =>
        sb.from('airport_service_points').insert({
          airport_id: sea.id,
          terminal_id: p.on_terminal ? terminalId : null,
          point_type: p.point_type,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          level: p.level,
          zone: p.zone,
          restrictions: p.restrictions,
          active: true,
          source: p.source,
        }).select('id').single()));
      pointIds.set(p.key, ins.id);
      counts.service_points.inserted++;
    }

    // 5. Instructions (idempotent by airport + audience + direction + title) -
    const existingInstr = must('select instructions', await withNetRetry('select instructions', async () =>
      sb.from('airport_instructions').select('id, audience, direction, title').eq('airport_id', sea.id)));
    for (const ins of INSTRUCTIONS) {
      const prior = existingInstr.find((x) => x.audience === ins.audience && x.direction === ins.direction && x.title === ins.title);
      if (prior) { counts.instructions.unchanged++; continue; }
      must(`insert instruction ${ins.audience}/${ins.direction}`, await withNetRetry(`insert instruction ${ins.audience}/${ins.direction}`, async () =>
        sb.from('airport_instructions').insert({
          airport_id: sea.id,
          service_point_id: pointIds.get(ins.point),
          audience: ins.audience,
          direction: ins.direction,
          locale: 'en',
          title: ins.title,
          body: ins.body,
          display_order: ins.display_order,
          active: true,
          source: ins.source,
        })));
      counts.instructions.inserted++;
    }

    // 6. Alias identifiers (idempotent by type + value among active rows) ----
    const existingAliases = must('select aliases', await withNetRetry('select aliases', async () =>
      sb.from('airport_identifiers').select('id, identifier_value').eq('identifier_type', 'alias_normalized').in('identifier_value', ALIASES).eq('active', true)));
    for (const alias of ALIASES) {
      if (existingAliases.some((x) => x.identifier_value === alias)) { counts.identifiers.unchanged++; continue; }
      must(`insert alias ${alias}`, await withNetRetry(`insert alias ${alias}`, async () =>
        sb.from('airport_identifiers').insert({
          airport_id: sea.id,
          identifier_type: 'alias_normalized',
          identifier_value: alias,
          provider: 'curated',
          active: true,
        })));
      counts.identifiers.inserted++;
    }

    // 7. Publish: verify terminal + all service points, promote to 'verified'.
    // The DB verified-floor trigger enforces general dropoff + rideshare pickup.
    const publishResult = must('publish_airport_config', await withNetRetry('publish_airport_config', async () =>
      sb.rpc('publish_airport_config', {
        p_airport: sea.id,
        p_terminals: [terminalId],
        p_service_points: [pointIds.get('dropoff'), pointIds.get('pickup'), pointIds.get('arrivals')],
        p_assignments: [],
        p_coverage: 'verified',
      })));
    counts.publish = publishResult;
    console.log('publish_airport_config →', JSON.stringify(publishResult));

    // 8. Published revision record (only on an actual coverage transition).
    if (sea.coverage_status !== 'verified') {
      must('insert revision', await withNetRetry('insert revision', async () =>
        sb.from('airport_data_revisions').insert({
          entity_type: 'airport',
          entity_id: sea.id,
          state: 'published',
          before: { coverage_status: sea.coverage_status },
          after: { airport_id: sea.id, coverage_status: 'verified' },
          editor: 'curate-sea script',
          published_at: new Date().toISOString(),
        })));
      counts.revisions.inserted++;
    }

    await finishImport(sb, importId, 'succeeded', counts);
    console.log(`import ${importId} succeeded`);
    console.log(JSON.stringify(counts, null, 2));
  } catch (err) {
    await finishImport(sb, importId, 'failed', counts, String(err?.message ?? err)).catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
