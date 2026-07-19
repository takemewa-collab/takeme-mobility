#!/usr/bin/env node
// FAA NASR 28-day airport catalog import (APT_CSV → airports + airport_identifiers).
//
//   node scripts/airport-import/import-nasr.mjs
//
// Locates the CURRENT NASR edition on faa.gov, downloads the APT_CSV zip
// (bounded, sha256-checksummed), parses APT_BASE.csv, and reconciles the
// national landing-facility catalog:
//   - match by (country_code='US', faa_lid) among catalog_status='active'
//   - TAKEME UUIDs are preserved (updates in place); rows are NEVER deleted
//   - coverage_status is NEVER downgraded by this importer
//   - source-removed facilities get catalog_status='deactivated'; rows with
//     coverage above 'cataloged' are additionally listed in error_summary for
//     operator review (their `active` flag is left untouched)
// The whole run is wrapped in an airport_data_imports row; a re-run against an
// unchanged upstream zip short-circuits via checksum.

import {
  createServiceClient, must, selectAll,
  startImport, finishImport, shortCircuitIfUnchanged,
  fetchBounded, sha256Hex, extractZipEntry, parseCsv, indexColumns,
  NASR_SITE_TYPE, NASR_MILITARY_OWNERSHIP,
  DETECTION_RADIUS_AIRPORT_M, DETECTION_RADIUS_OTHER_M,
  titleCaseName, normalizeName, chunkArray, isValidIcao, forEachLimit, withNetRetry,
} from './common.mjs';

const NASR_PAGE_URL = 'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/';
const NASR_EXTRA_BASE = 'https://nfdc.faa.gov/webContent/28DaySub/extra/';
// Known-good effective date used only if the FAA page is unreachable; editions
// repeat every 28 days from this anchor.
const CYCLE_ANCHOR_ISO = '2026-07-09';
const CYCLE_DAYS = 28;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {string} isoDate e.g. '2026-07-09' → '09_Jul_2026' */
function editionToken(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${String(d).padStart(2, '0')}_${MONTHS[m - 1]}_${y}`;
}

/** Latest 28-day cycle date <= today, computed from the anchor (fallback path). */
function computeCycleDate(now = new Date()) {
  const anchor = Date.UTC(...CYCLE_ANCHOR_ISO.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const dayMs = 86_400_000;
  const cycles = Math.floor((now.getTime() - anchor) / (CYCLE_DAYS * dayMs));
  const eff = new Date(anchor + cycles * CYCLE_DAYS * dayMs);
  return eff.toISOString().slice(0, 10);
}

/** Discover the current edition date (ISO) from the FAA page, with computed fallback. */
async function discoverCurrentEdition() {
  try {
    const html = (await fetchBounded(NASR_PAGE_URL, { maxBytes: 8 * 1024 * 1024 })).toString('utf8');
    const dates = [...html.matchAll(/NASR_Subscription\/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    const today = new Date().toISOString().slice(0, 10);
    const current = [...new Set(dates)].filter((d) => d <= today).sort().pop();
    if (current) return { edition: current, discoveredVia: NASR_PAGE_URL };
  } catch (err) {
    console.warn(`edition discovery via faa.gov failed (${err.message}); falling back to 28-day cycle math`);
  }
  return { edition: computeCycleDate(), discoveredVia: 'computed 28-day cycle' };
}

async function main() {
  const sb = createServiceClient();
  const { edition, discoveredVia } = await discoverCurrentEdition();
  const zipUrl = `${NASR_EXTRA_BASE}${editionToken(edition)}_APT_CSV.zip`;
  console.log(`NASR edition ${edition} (via ${discoveredVia})`);
  console.log(`downloading ${zipUrl}`);

  const zip = await fetchBounded(zipUrl, { maxBytes: 256 * 1024 * 1024 });
  const checksum = sha256Hex(zip);
  console.log(`downloaded ${zip.length} bytes, sha256=${checksum}`);

  const shortId = await shortCircuitIfUnchanged(sb, 'faa_nasr', checksum, edition, edition);
  if (shortId) {
    console.log(`unchanged upstream (checksum match) — short-circuited as succeeded, import ${shortId}`);
    return;
  }

  const importId = await startImport(sb, 'faa_nasr', { sourceVersion: edition, effectiveDate: edition, checksum });
  console.log(`import ${importId} running`);

  try {
    const csvText = extractZipEntry(zip, 'APT_BASE.csv').toString('utf8');
    const rows = parseCsv(csvText);
    const header = rows[0];
    const ix = indexColumns(header, [
      'ARPT_ID', 'ICAO_ID', 'SITE_TYPE_CODE', 'STATE_CODE', 'ARPT_NAME', 'CITY',
      'COUNTRY_CODE', 'OWNERSHIP_TYPE_CODE', 'FACILITY_USE_CODE',
      'LAT_DECIMAL', 'LONG_DECIMAL', 'ARPT_STATUS',
    ]);

    const lineage = {
      provider: 'faa_nasr', edition, url: zipUrl, checksum,
      imported_at: new Date().toISOString(),
    };

    /** @type {Map<string, any>} desired state by faa_lid */
    const desired = new Map();
    let skippedNonUs = 0, skippedBad = 0, skippedDupLid = 0;

    for (const r of rows.slice(1)) {
      if (r.length < header.length - 1) { if (r.length > 1) skippedBad++; continue; }
      const get = (col) => (r[ix[col]] ?? '').trim();
      if (get('COUNTRY_CODE') !== 'US') { skippedNonUs++; continue; }
      const faaLid = get('ARPT_ID');
      const lat = Number(get('LAT_DECIMAL'));
      const lng = Number(get('LONG_DECIMAL'));
      const airportType = NASR_SITE_TYPE[get('SITE_TYPE_CODE')];
      if (!faaLid || !airportType || !Number.isFinite(lat) || !Number.isFinite(lng) ||
          lat < -90 || lat > 90 || lng < -180 || lng > 180) { skippedBad++; continue; }
      if (desired.has(faaLid)) { skippedDupLid++; continue; }
      const rawName = get('ARPT_NAME') || faaLid;
      const officialName = titleCaseName(rawName);
      const icao = get('ICAO_ID').toUpperCase();
      desired.set(faaLid, {
        faa_lid: faaLid,
        icao_code: isValidIcao(icao) ? icao : null,
        state_code: get('STATE_CODE') || null,
        official_name: officialName,
        display_name: officialName,
        normalized_name: normalizeName(rawName) || faaLid.toLowerCase(),
        municipality: titleCaseName(get('CITY')) || null,
        lat: Number(lat.toFixed(7)),
        lng: Number(lng.toFixed(7)),
        airport_type: airportType,
        ownership_use: `${get('OWNERSHIP_TYPE_CODE')}/${get('FACILITY_USE_CODE')}`,
        private_use: get('FACILITY_USE_CODE') === 'PR',
        military_only: NASR_MILITARY_OWNERSHIP.has(get('OWNERSHIP_TYPE_CODE')),
        arpt_status: get('ARPT_STATUS'),
      });
    }
    console.log(`parsed ${desired.size} US facilities (skipped: ${skippedNonUs} non-US, ${skippedBad} malformed, ${skippedDupLid} duplicate LIDs)`);

    // Existing active catalog rows, keyed by faa_lid.
    const existing = await selectAll(
      sb, 'airports',
      'id, faa_lid, icao_code, state_code, official_name, display_name, normalized_name, municipality, lat, lng, airport_type, ownership_use, private_use, military_only, coverage_status, catalog_status, active',
      (q) => q.eq('country_code', 'US').eq('catalog_status', 'active').not('faa_lid', 'is', null).order('id'),
    );
    const existingByLid = new Map(existing.map((row) => [row.faa_lid, row]));
    console.log(`existing active catalog rows: ${existing.length}`);

    // Partition into inserts / updates / deactivations.
    const inserts = [];
    const updates = [];
    for (const [lid, want] of desired) {
      const have = existingByLid.get(lid);
      const { arpt_status: arptStatus, ...fields } = want;
      const source = { ...lineage, arpt_status: arptStatus };
      if (!have) {
        inserts.push({
          country_code: 'US',
          ...fields,
          detection_radius_m: fields.airport_type === 'airport' ? DETECTION_RADIUS_AIRPORT_M : DETECTION_RADIUS_OTHER_M,
          source,
        });
        continue;
      }
      const changed =
        have.icao_code !== fields.icao_code ||
        have.state_code !== fields.state_code ||
        have.official_name !== fields.official_name ||
        have.normalized_name !== fields.normalized_name ||
        have.municipality !== fields.municipality ||
        Number(have.lat).toFixed(7) !== fields.lat.toFixed(7) ||
        Number(have.lng).toFixed(7) !== fields.lng.toFixed(7) ||
        have.airport_type !== fields.airport_type ||
        have.ownership_use !== fields.ownership_use ||
        have.private_use !== fields.private_use ||
        have.military_only !== fields.military_only;
      if (changed) {
        const patch = { ...fields, source };
        // Preserve an operator-customized display_name; follow the official
        // name only if display_name was still the previous official name.
        if (have.display_name !== have.official_name) delete patch.display_name;
        updates.push({ id: have.id, patch });
      }
    }
    const removedRows = existing.filter((row) => !desired.has(row.faa_lid));
    console.log(`plan: ${inserts.length} inserts, ${updates.length} updates, ${removedRows.length} deactivations`);

    // Inserts, chunks of 500; collect ids for identifier rows.
    /** @type {Map<string, string>} faa_lid → airport id (active catalog) */
    const idByLid = new Map(existing.map((row) => [row.faa_lid, row.id]));
    const icaoByLid = new Map();
    for (const [lid, want] of desired) if (want.icao_code) icaoByLid.set(lid, want.icao_code);

    let inserted = 0;
    for (const chunk of chunkArray(inserts, 500)) {
      const returned = await withNetRetry('insert airports chunk', async () =>
        must('insert airports chunk', await sb.from('airports').insert(chunk).select('id, faa_lid')));
      for (const row of returned) idByLid.set(row.faa_lid, row.id);
      inserted += returned.length;
      process.stdout.write(`\rinserted ${inserted}/${inserts.length}`);
    }
    if (inserts.length) console.log();

    // Updates: bounded-concurrency per-row patches (only changed rows).
    let updated = 0;
    await forEachLimit(updates, 16, async ({ id, patch }) => {
      await withNetRetry('update airport', async () =>
        must('update airport', await sb.from('airports').update(patch).eq('id', id)));
      updated++;
    });

    // Deactivations: catalog_status only; never delete, never touch `active`.
    let deactivated = 0;
    const reviewNeeded = removedRows.filter((r) => r.coverage_status !== 'cataloged');
    for (const chunk of chunkArray(removedRows.map((r) => r.id), 500)) {
      await withNetRetry('deactivate airports chunk', async () =>
        must('deactivate airports chunk', await sb
          .from('airports')
          .update({ catalog_status: 'deactivated' })
          .in('id', chunk)));
      deactivated += chunk.length;
    }
    if (removedRows.length) {
      // Free their identifiers so a successor facility can claim the codes.
      for (const chunk of chunkArray(removedRows.map((r) => r.id), 500)) {
        await withNetRetry('deactivate identifiers of removed airports', async () =>
          must('deactivate identifiers of removed airports', await sb
            .from('airport_identifiers')
            .update({ active: false })
            .in('airport_id', chunk)));
      }
    }

    // Idempotent identifier rows (faa_lid + icao) for all active catalog airports.
    const existingIdents = await selectAll(
      sb, 'airport_identifiers', 'identifier_type, identifier_value',
      (q) => q.eq('active', true).in('identifier_type', ['faa_lid', 'icao']).order('id'),
    );
    const identSeen = new Set(existingIdents.map((r) => `${r.identifier_type}:${r.identifier_value}`));
    const identInserts = [];
    for (const [lid, airportId] of idByLid) {
      if (!desired.has(lid)) continue; // deactivated rows get no fresh identifiers
      if (!identSeen.has(`faa_lid:${lid}`)) {
        identInserts.push({ airport_id: airportId, identifier_type: 'faa_lid', identifier_value: lid, provider: 'faa_nasr' });
      }
      const icao = icaoByLid.get(lid);
      if (icao && !identSeen.has(`icao:${icao}`)) {
        identInserts.push({ airport_id: airportId, identifier_type: 'icao', identifier_value: icao, provider: 'faa_nasr' });
      }
    }
    let identifiersInserted = 0;
    for (const chunk of chunkArray(identInserts, 500)) {
      const returned = await withNetRetry('insert identifiers chunk', async () =>
        must('insert identifiers chunk', await sb.from('airport_identifiers').insert(chunk).select('id')));
      identifiersInserted += returned.length;
    }

    const counts = {
      inserted,
      updated,
      deactivated,
      skipped: skippedNonUs + skippedBad + skippedDupLid,
      skipped_non_us: skippedNonUs,
      skipped_malformed: skippedBad,
      skipped_duplicate_lid: skippedDupLid,
      identifiers_inserted: identifiersInserted,
      source_facilities_us: desired.size,
    };
    const errorSummary = reviewNeeded.length
      ? `source-removed but coverage above cataloged — operator review required: ${reviewNeeded
          .map((r) => `${r.faa_lid} (${r.coverage_status})`).join(', ')}`
      : null;

    await finishImport(sb, importId, 'succeeded', counts, errorSummary);
    console.log(`import ${importId} succeeded:`, JSON.stringify(counts));
    if (errorSummary) console.warn(errorSummary);
  } catch (err) {
    await finishImport(sb, importId, 'failed', {}, String(err?.stack ?? err).slice(0, 4000)).catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
