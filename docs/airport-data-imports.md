# Airport data imports

Official-data ingestion for the Airport Intelligence Platform
(`supabase/migrations/043_airport_intelligence.sql`). Three adapters live in
`scripts/airport-import/` (plain Node, run with `node`, no build step); shared
pure types/helpers for the API and tests live in `lib/airport-import/types.ts`.
The runtime twins of those pure helpers live in
`scripts/airport-import/common.mjs` — **if you change one, change both**.

Credentials come from `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`; quoted values are handled). All writes use the
service-role client. Every network fetch has an explicit 30s AbortController
timeout, at most 2 retries, and a hard response-size bound; every DB pagination
loop has a hard page cap. Batched writes go in chunks of 500.

## Lineage guarantees (all sources)

Every run — including curated/manual edits scripted elsewhere — is wrapped in an
`airport_data_imports` row:

1. insert `status='running'` with `source`, `source_version`, `effective_date`,
   `checksum` (sha256 of the exact downloaded artifact);
2. finish with `succeeded` / `failed` and
   `counts {inserted, updated, deactivated, skipped, …}`;
3. re-running against a byte-identical upstream artifact **short-circuits**: a
   `succeeded` row is recorded with `counts {"skipped":"unchanged"}` and a
   pointer to the prior import in `error_summary`, and no table is touched.

Rows in `airports` / `airlines` / `airport_airline_services` carry a `source`
jsonb (`{provider, edition, url, checksum, imported_at, …}`) naming exactly
which artifact produced them. **Curated data flows through the same lineage**:
any manual/curated load must create an `airport_data_imports` row with
`source='curated'` and stamp `source jsonb` with `provider:'curated'` — no
side-door writes.

Safety rules shared by all adapters:

- TAKEME UUIDs are stable: matches are updated in place, never re-created.
- Rows are **never deleted** and `coverage_status` is **never downgraded** by
  an importer.
- Facilities that disappear from the official source get
  `catalog_status='deactivated'`. If such a row's coverage is above
  `cataloged` (operational data exists), it keeps `active=true` and is listed
  in the import's `error_summary` for operator review — importers never
  blindly kill operational data.

## A. FAA NASR airport catalog — `import-nasr.mjs`

```
node scripts/airport-import/import-nasr.mjs
```

- **Source**: FAA 28-day NASR subscription, `APT_CSV` extra download
  (`APT_BASE.csv` inside the zip). The current edition is discovered from
  https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/
  (edition links look like `NASR_Subscription/2026-07-09`); the zip URL is
  `https://nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_APT_CSV.zip`.
  If the page is unreachable, the edition date is computed from the 28-day
  cycle anchor in the script.
- **Cadence**: every 28 days (each NASR edition).
- **Scope**: rows with `COUNTRY_CODE='US'` (includes territories via
  `STATE_CODE`); ~19k landing facilities of all site types (airport, heliport,
  seaplane base, gliderport, ultralight, balloonport).
- **Mapping**: `ARPT_ID→faa_lid`, `ICAO_ID→icao_code` (4-alnum only),
  `SITE_TYPE_CODE→airport_type`, `FACILITY_USE_CODE='PR'→private_use`,
  military ownership codes (`MA/MN/MR/CG`)→`military_only`,
  `OWNERSHIP_TYPE_CODE/FACILITY_USE_CODE→ownership_use`, sensible title-casing
  of `ARPT_NAME`/`CITY`, `LAT_DECIMAL`/`LONG_DECIMAL` rounded to 7 decimals,
  `detection_radius_m` 2500 for airports / 800 otherwise (set on insert only —
  operator tuning is preserved on update). `ARPT_STATUS` is recorded in
  `source` jsonb. NASR has **no IATA column** — `iata_code` stays null here;
  the enplanements pass adds IATA where available.
- **Display names**: `display_name` follows `official_name` unless an operator
  has customized it (detected by `display_name != official_name`), in which
  case the customization is preserved.
- **Identifiers**: idempotent `airport_identifiers` rows for `faa_lid` and
  `icao`. Identifiers of source-removed airports are set inactive so a
  successor facility can claim the code (the partial unique index only guards
  active rows).
- **Updates** are diffed field-by-field; unchanged rows are not written, so a
  new edition with few changes performs few writes.

## B. FAA enplanements / commercial classification — `import-enplanements.mjs`

```
node scripts/airport-import/import-enplanements.mjs
```

- **Source**: FAA Passenger Boarding (Enplanement) data,
  https://www.faa.gov/airports/planning_capacity/passenger_allcargo_stats/passenger.
  The script picks the most recent **final** calendar-year
  `arp-cyYYYY-all-enplanements.xlsx` (preliminary releases are ignored),
  parsed with the `xlsx` dev dependency.
- **Cadence**: yearly (finals typically publish ~September for the prior CY).
- **Matching**: the workbook's `Locid` column is an **FAA LID**; matching is by
  `faa_lid` first, `iata_code` fallback, among `catalog_status='active'`.
- **Updates**: `enplanements`, `enplanements_year`, `service_class` from the
  FAA classification (`P`+Hub `L/M/S/N` → `large_hub/medium_hub/small_hub/
  nonhub_primary`, `CS` → `nonprimary_commercial`, `R` → `reliever`,
  `GA` → `general_aviation`); `coverage_status` `cataloged→passenger_service`
  for primary/commercial rows only (rows already above `passenger_service` are
  never touched).
- **IATA heuristic**: for commercial-service rows whose Locid is a pure
  3-letter code, the LID is adopted as `iata_code` **only when currently
  null**; collisions with an already-claimed code are skipped and counted
  (`iata_conflicts`). Known LID≠IATA divergences (e.g. IWA/AZA) are expected
  to be corrected by curated data, which wins because the importer never
  overwrites a non-null `iata_code`. Newly adopted codes also get an
  idempotent `iata` row in `airport_identifiers`.

## C. BTS T-100 airline service — `import-t100.mjs`

```
node scripts/airport-import/import-t100.mjs <path/to/t100-extract.csv>
```

- **Source**: BTS T-100 Domestic/International Segment (or Market) data.
  transtats.bts.gov requires an **interactive form download** — the adapter
  never scrapes it and never invents data. Run without arguments to print
  usage and exit 0.
- **Obtaining the extract** (manual, ~monthly with a 2–3 month lag):
  1. Go to https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FMG
     (T-100 Segment, All Carriers) — or the Market equivalent.
  2. Select at least: `UNIQUE_CARRIER`, `CARRIER_NAME`, `ORIGIN`,
     `PASSENGERS`, `YEAR`, `MONTH`. Extra columns are ignored.
  3. Download the last ~14 months (two calendar years is fine), unzip the CSV.
- **Cadence**: monthly-lagged; each run aggregates the most recent **rolling
  12-month window present in the file** (older rows are ignored).
- **Writes**: `airlines` (matched by `bts_carrier=UNIQUE_CARRIER`; IATA-shaped
  carrier codes recorded when unclaimed) and `airport_airline_services`
  upserted on `(airport_id, airline_id)` with `popularity_rank` per airport by
  window passenger volume, `popularity_score` = passengers,
  `reporting_period` like `T100 2024-07..2025-06`, and full source lineage.
  Services previously active at a covered airport but absent from the new
  window are **deactivated, not deleted**. Airports not covered by the extract
  are untouched (their curated services survive).
- SEA's launch airline services are seeded through the curated path (with
  `source='curated'` lineage), not by this adapter.

## Verifying a run

```sql
select id, source, source_version, status, counts, checksum, error_summary
from airport_data_imports order by started_at desc limit 10;

select service_class, count(*) from airports
where catalog_status = 'active' group by 1 order by 2 desc;

select faa_lid, iata_code, icao_code, state_code, lat, lng, airport_type,
       service_class, coverage_status
from airports where faa_lid = 'SEA' and catalog_status = 'active';
```
