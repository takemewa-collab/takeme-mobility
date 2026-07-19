#!/usr/bin/env node
// FAA passenger boarding (enplanement) import — commercial classification pass.
//
//   node scripts/airport-import/import-enplanements.mjs
//
// Finds the most recent FINAL calendar-year "all enplanements" workbook on
// faa.gov (preliminary releases are ignored), downloads it (bounded,
// sha256-checksummed), and updates matching airports:
//   - enplanements + enplanements_year
//   - service_class from the FAA hub / service-level classification
//       P+L→large_hub, P+M→medium_hub, P+S→small_hub, P+N→nonhub_primary,
//       CS→nonprimary_commercial, R→reliever, GA→general_aviation
//   - iata_code: the file's Locid is an FAA LID; for commercial-service rows
//     with a pure 3-letter Locid it is adopted as IATA ONLY when iata_code is
//     currently null (conflicts are skipped and counted)
//   - coverage_status: 'cataloged' → 'passenger_service' for primary/commercial
//     rows; rows already above passenger_service are NEVER touched
// Matching is by FAA LID first, IATA fallback. Wrapped in airport_data_imports
// with a checksum short-circuit on re-runs.

import { createRequire } from 'node:module';
import {
  createServiceClient, must, selectAll,
  startImport, finishImport, shortCircuitIfUnchanged,
  fetchBounded, sha256Hex, chunkArray, forEachLimit, withNetRetry,
  classifyServiceClass, COMMERCIAL_SERVICE_CLASSES,
} from './common.mjs';

const require = createRequire(import.meta.url);

const PASSENGER_PAGE_URL = 'https://www.faa.gov/airports/planning_capacity/passenger_allcargo_stats/passenger';
const FAA_ORIGIN = 'https://www.faa.gov';

/** Find the newest final (non-preliminary) all-enplanements xlsx on the FAA page. */
async function discoverWorkbook() {
  const html = (await fetchBounded(PASSENGER_PAGE_URL, { maxBytes: 8 * 1024 * 1024 })).toString('utf8');
  /** @type {{ url: string, year: number }[]} */
  const candidates = [];
  for (const m of html.matchAll(/href="([^"]*arp-cy(\d{4})-all-enplanements[^"]*\.xlsx)"/gi)) {
    const href = m[1];
    if (/preliminary/i.test(href)) continue;
    candidates.push({ url: href.startsWith('http') ? href : `${FAA_ORIGIN}${href}`, year: Number(m[2]) });
  }
  if (!candidates.length) throw new Error('no final all-enplanements .xlsx link found on FAA passenger page');
  candidates.sort((a, b) => b.year - a.year);
  return candidates[0];
}

async function main() {
  const sb = createServiceClient();
  const { url, year } = await discoverWorkbook();
  console.log(`enplanements workbook: CY${year} — ${url}`);

  const wbBuf = await fetchBounded(url, { maxBytes: 64 * 1024 * 1024 });
  const checksum = sha256Hex(wbBuf);
  console.log(`downloaded ${wbBuf.length} bytes, sha256=${checksum}`);

  const effectiveDate = `${year}-12-31`;
  const shortId = await shortCircuitIfUnchanged(sb, 'faa_enplanements', checksum, `CY${year}`, effectiveDate);
  if (shortId) {
    console.log(`unchanged upstream (checksum match) — short-circuited as succeeded, import ${shortId}`);
    return;
  }

  const importId = await startImport(sb, 'faa_enplanements', { sourceVersion: `CY${year}`, effectiveDate, checksum });
  console.log(`import ${importId} running`);

  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(wbBuf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    /** @type {any[][]} */
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });

    // Locate the header row and required columns (inspect, don't guess).
    const headerRowIdx = rows.findIndex((r) => Array.isArray(r) && r.some((c) => String(c).trim().toLowerCase() === 'locid'));
    if (headerRowIdx < 0) throw new Error(`no header row with 'Locid' found; first rows: ${JSON.stringify(rows.slice(0, 3))}`);
    const header = rows[headerRowIdx].map((c) => String(c ?? '').trim());
    const col = (pred, label) => {
      const i = header.findIndex(pred);
      if (i < 0) throw new Error(`column ${label} not found in header: ${header.join(' | ')}`);
      return i;
    };
    const iLocid = col((h) => h.toLowerCase() === 'locid', 'Locid');
    const iSl = col((h) => h.toUpperCase() === 'S/L', 'S/L');
    const iHub = col((h) => h.toLowerCase() === 'hub', 'Hub');
    const enplRe = new RegExp(`^CY\\s*0?${String(year % 100)}\\s+Enplanements$`, 'i');
    const iEnpl = col((h) => enplRe.test(h) || new RegExp(`^CY\\s*${year}\\s+Enplanements$`, 'i').test(h), `CY${year} Enplanements`);

    // Parse records; the Locid column is an FAA LID.
    const records = new Map();
    let skippedBad = 0, skippedDup = 0;
    for (const r of rows.slice(headerRowIdx + 1)) {
      if (!Array.isArray(r) || r.length === 0) continue;
      const locid = String(r[iLocid] ?? '').trim().toUpperCase();
      const enpl = Number(r[iEnpl]);
      if (!/^[A-Z0-9]{3,4}$/.test(locid) || !Number.isFinite(enpl) || enpl < 0) { skippedBad++; continue; }
      if (records.has(locid)) { skippedDup++; continue; }
      records.set(locid, {
        locid,
        serviceLevel: String(r[iSl] ?? '').trim().toUpperCase(),
        hub: String(r[iHub] ?? '').trim().toUpperCase(),
        enplanements: Math.round(enpl),
      });
    }
    console.log(`parsed ${records.size} enplanement rows (skipped: ${skippedBad} malformed, ${skippedDup} duplicates)`);

    // Active catalog airports keyed by FAA LID (primary) and IATA (fallback).
    const airports = await selectAll(
      sb, 'airports',
      'id, faa_lid, iata_code, service_class, coverage_status, enplanements, enplanements_year, source',
      (q) => q.eq('country_code', 'US').eq('catalog_status', 'active').order('id'),
    );
    const byLid = new Map();
    const byIata = new Map();
    const takenIata = new Set();
    for (const a of airports) {
      if (a.faa_lid) byLid.set(a.faa_lid, a);
      if (a.iata_code) { byIata.set(a.iata_code, a); takenIata.add(a.iata_code); }
    }
    console.log(`active catalog airports: ${airports.length}`);

    const lineage = {
      provider: 'faa_enplanements', edition: `CY${year}`, url, checksum,
      imported_at: new Date().toISOString(),
    };

    /** @type {{ id: string, patch: any }[]} */
    const updates = [];
    /** @type {{ airport_id: string, identifier_type: string, identifier_value: string, provider: string }[]} */
    const iataIdentifierInserts = [];
    let matchedByLid = 0, matchedByIata = 0, unmatched = 0;
    let iataAssigned = 0, iataConflicts = 0, coveragePromoted = 0, commercialMatched = 0;
    const unmatchedSample = [];

    for (const rec of records.values()) {
      const airport = byLid.get(rec.locid) ?? byIata.get(rec.locid);
      if (!airport) {
        unmatched++;
        if (unmatchedSample.length < 25) unmatchedSample.push(rec.locid);
        continue;
      }
      if (byLid.get(rec.locid)) matchedByLid++; else matchedByIata++;

      const serviceClass = classifyServiceClass(rec.serviceLevel, rec.hub);
      const commercial = serviceClass !== null && COMMERCIAL_SERVICE_CLASSES.has(serviceClass);
      if (commercial) commercialMatched++;

      const patch = {};
      if (airport.enplanements !== rec.enplanements) patch.enplanements = rec.enplanements;
      if (airport.enplanements_year !== year) patch.enplanements_year = year;
      if (serviceClass && airport.service_class !== serviceClass) patch.service_class = serviceClass;
      if (commercial && airport.coverage_status === 'cataloged') {
        patch.coverage_status = 'passenger_service';
        coveragePromoted++;
      }
      if (commercial && airport.iata_code === null && /^[A-Z]{3}$/.test(rec.locid)) {
        if (takenIata.has(rec.locid)) {
          iataConflicts++;
        } else {
          patch.iata_code = rec.locid;
          takenIata.add(rec.locid);
          iataAssigned++;
          iataIdentifierInserts.push({
            airport_id: airport.id, identifier_type: 'iata',
            identifier_value: rec.locid, provider: 'faa_enplanements',
          });
        }
      }
      if (Object.keys(patch).length > 0) {
        patch.source = { ...(airport.source ?? {}), enplanements: lineage };
        updates.push({ id: airport.id, patch });
      }
    }

    console.log(`plan: ${updates.length} airport updates (${matchedByLid} by LID, ${matchedByIata} by IATA, ${unmatched} unmatched)`);
    let updated = 0;
    await forEachLimit(updates, 16, async ({ id, patch }) => {
      await withNetRetry('update airport enplanements', async () =>
        must('update airport enplanements', await sb.from('airports').update(patch).eq('id', id)));
      updated++;
      if (updated % 250 === 0) console.log(`updated ${updated}/${updates.length}`);
    });

    // Idempotent iata identifier rows for the codes just adopted.
    let identifiersInserted = 0;
    if (iataIdentifierInserts.length) {
      const existingIata = await selectAll(
        sb, 'airport_identifiers', 'identifier_value',
        (q) => q.eq('active', true).eq('identifier_type', 'iata').order('id'),
      );
      const have = new Set(existingIata.map((r) => r.identifier_value));
      const fresh = iataIdentifierInserts.filter((r) => !have.has(r.identifier_value));
      for (const chunk of chunkArray(fresh, 500)) {
        const returned = await withNetRetry('insert iata identifiers', async () =>
          must('insert iata identifiers', await sb.from('airport_identifiers').insert(chunk).select('id')));
        identifiersInserted += returned.length;
      }
    }

    const counts = {
      inserted: 0,
      updated,
      deactivated: 0,
      skipped: skippedBad + skippedDup + unmatched,
      matched_by_faa_lid: matchedByLid,
      matched_by_iata: matchedByIata,
      unmatched,
      commercial_passenger_matched: commercialMatched,
      coverage_promoted_to_passenger_service: coveragePromoted,
      iata_assigned: iataAssigned,
      iata_conflicts: iataConflicts,
      iata_identifiers_inserted: identifiersInserted,
      data_year: year,
    };
    const errorSummary = unmatched
      ? `unmatched Locids (${unmatched}): ${unmatchedSample.join(', ')}${unmatched > unmatchedSample.length ? ', …' : ''}`
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
