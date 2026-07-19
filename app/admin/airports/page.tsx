'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

// ═══════════════════════════════════════════════════════════════════════════
// TAKEME ADMIN — Airport Intelligence: Catalog + Imports
// Searchable / filterable airport catalog with import-history section.
// ═══════════════════════════════════════════════════════════════════════════

interface AirportRow {
  id: string;
  display_name: string;
  iata_code: string | null;
  faa_lid: string | null;
  state_code: string | null;
  municipality: string | null;
  service_class: string | null;
  enplanements: number | null;
  coverage_status: string;
  active: boolean;
  updated_at: string | null;
}

interface ImportRow {
  id: string;
  source: string;
  source_version: string | null;
  effective_date: string | null;
  status: string;
  counts: Record<string, unknown> | null;
  error_summary: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const PAGE_SIZE = 50;

// Matches DB enum airport_coverage_status.
const COVERAGE_STATUSES = [
  'cataloged',
  'passenger_service',
  'serviceable',
  'curated',
  'verified',
  'temporarily_disabled',
] as const;

const COVERAGE_CLASSES: Record<string, string> = {
  cataloged: 'bg-zinc-500/15 text-[#86868b]',
  passenger_service: 'bg-sky-500/15 text-sky-500',
  serviceable: 'bg-blue-500/15 text-blue-400',
  curated: 'bg-violet-500/15 text-violet-400',
  verified: 'bg-emerald-500/15 text-emerald-500',
  temporarily_disabled: 'bg-amber-500/15 text-amber-400',
};

const IMPORT_STATUS_CLASSES: Record<string, string> = {
  running: 'bg-blue-500/15 text-blue-400',
  succeeded: 'bg-emerald-500/15 text-emerald-500',
  failed: 'bg-red-500/15 text-red-400',
  partial: 'bg-amber-500/15 text-amber-400',
};

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'VI', 'WA', 'WV', 'WI', 'WY',
];

function timeAgo(iso: string | null) {
  if (!iso) return '--';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function fmtTime(iso: string | null) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function coverageLabel(status: string) {
  return status.replace(/_/g, ' ');
}

export default function AdminAirportsPage() {
  const [view, setView] = useState<'catalog' | 'imports'>('catalog');

  // Catalog state
  const [airports, setAirports] = useState<AirportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [coverage, setCoverage] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [page, setPage] = useState(1);

  // Imports state (fetched on mount so freshness banner shows on both views)
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [importsLoading, setImportsLoading] = useState(true);
  const [importsError, setImportsError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchAirports = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (coverage !== 'all') params.set('coverage', coverage);
      if (stateFilter !== 'all') params.set('state', stateFilter);
      params.set('page', String(page));

      const res = await fetch(`/api/admin/airports?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAirports(data.airports ?? []);
      setTotal(data.total ?? 0);
      setError('');
    } catch {
      setError('Failed to load airports');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, coverage, stateFilter, page]);

  useEffect(() => {
    fetchAirports();
  }, [fetchAirports]);

  const fetchImports = useCallback(async () => {
    setImportsLoading(true);
    try {
      const res = await fetch('/api/admin/airports/imports');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setImports(data.imports ?? []);
      setImportsError('');
    } catch {
      setImportsError('Failed to load import history');
    } finally {
      setImportsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchImports();
  }, [fetchImports]);

  // NASR data-freshness check: newest succeeded faa_nasr import older than 35 days.
  const newestNasr = imports
    .filter((i) => i.source === 'faa_nasr' && i.status === 'succeeded')
    .map((i) => new Date(i.finished_at ?? i.started_at ?? 0).getTime())
    .sort((a, b) => b - a)[0];
  const nasrStaleDays =
    !importsLoading && newestNasr
      ? Math.floor((Date.now() - newestNasr) / 86400000)
      : null;
  const nasrStale =
    !importsLoading && (newestNasr === undefined || (nasrStaleDays !== null && nasrStaleDays > 35));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1d1d1f]">Airports</h1>
        <p className="text-sm text-[#86868b] mt-1">
          Airport intelligence catalog — {total} airports
        </p>
      </div>

      {/* NASR freshness warning */}
      {nasrStale && (
        <div className="mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20 px-4 py-3 text-sm text-amber-500">
          {newestNasr === undefined
            ? 'No successful NASR import found. Airport reference data may be missing or stale.'
            : `NASR reference data is stale: last successful import was ${nasrStaleDays} days ago (threshold 35 days).`}
        </div>
      )}

      {/* View tabs */}
      <div className="flex gap-1 mb-5 bg-[#f5f5f7] rounded-xl p-1 w-fit border border-[#d2d2d7]">
        {(['catalog', 'imports'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize ${
              view === v ? 'bg-[#d2d2d7] text-[#1d1d1f]' : 'text-[#86868b] hover:text-[#6e6e73]'
            }`}
          >
            {v === 'catalog' ? 'Catalog' : 'Imports'}
          </button>
        ))}
      </div>

      {view === 'catalog' ? (
        <>
          {/* Search + state filter */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, IATA, or FAA code..."
              className="w-72 rounded-lg border border-[#d2d2d7] bg-[#f5f5f7] px-3 py-2 text-sm text-[#1d1d1f] placeholder-[#86868b] outline-none focus:border-[#1D6AE5]"
            />
            <select
              value={stateFilter}
              onChange={(e) => {
                setStateFilter(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-[#d2d2d7] bg-[#f5f5f7] px-3 py-2 text-sm text-[#6e6e73] outline-none focus:border-[#1D6AE5]"
            >
              <option value="all">All states</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {/* Coverage chips */}
          <div className="flex flex-wrap gap-2 mb-5">
            {['all', ...COVERAGE_STATUSES].map((c) => (
              <button
                key={c}
                onClick={() => {
                  setCoverage(c);
                  setPage(1);
                }}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  coverage === c
                    ? 'border-[#1D6AE5] bg-[#1D6AE5]/10 text-[#1D6AE5]'
                    : 'border-[#d2d2d7] bg-[#f5f5f7] text-[#86868b] hover:text-[#6e6e73]'
                }`}
              >
                {c === 'all' ? 'All' : coverageLabel(c)}
              </button>
            ))}
          </div>

          {error && (
            <div className="mb-4 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Table */}
          <div className="bg-[#f5f5f7] rounded-xl border border-[#d2d2d7] overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-[#86868b]">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#86868b] border-t-[#1D6AE5] mr-3" />
                Loading airports...
              </div>
            ) : airports.length === 0 ? (
              <div className="py-20 text-center text-[#86868b] text-sm">No airports found</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#d2d2d7]">
                    {['Name', 'Codes', 'State', 'Class', 'Enplanements', 'Coverage', 'Updated'].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[#86868b]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {airports.map((a) => (
                    <tr key={a.id} className="border-b border-[#d2d2d7]/50 transition-colors hover:bg-[#d2d2d7]/30">
                      <td className="px-4 py-3">
                        <Link href={`/admin/airports/${a.id}`} className="block">
                          <span className={`text-xs font-medium ${a.active ? 'text-[#1d1d1f]' : 'text-[#86868b] line-through'}`}>
                            {a.display_name}
                          </span>
                          {a.municipality && (
                            <span className="block text-[10px] text-[#86868b]">{a.municipality}</span>
                          )}
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[#6e6e73]">
                        {[a.iata_code, a.faa_lid].filter(Boolean).join(' / ') || '--'}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#6e6e73]">{a.state_code ?? '--'}</td>
                      <td className="px-4 py-3 text-xs text-[#6e6e73] capitalize">
                        {a.service_class?.replace(/_/g, ' ') ?? '--'}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#6e6e73]">
                        {a.enplanements != null ? Number(a.enplanements).toLocaleString('en-US') : '--'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold capitalize ${
                            COVERAGE_CLASSES[a.coverage_status] ?? 'bg-zinc-500/15 text-[#86868b]'
                          }`}
                        >
                          {coverageLabel(a.coverage_status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-[#86868b]">{timeAgo(a.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-[#86868b]">
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#f5f5f7] border border-[#d2d2d7] text-[#6e6e73] disabled:opacity-30 hover:bg-[#d2d2d7] transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#f5f5f7] border border-[#d2d2d7] text-[#6e6e73] disabled:opacity-30 hover:bg-[#d2d2d7] transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {importsError && (
            <div className="mb-4 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
              {importsError}
            </div>
          )}

          <div className="bg-[#f5f5f7] rounded-xl border border-[#d2d2d7] overflow-hidden">
            {importsLoading ? (
              <div className="flex items-center justify-center py-20 text-[#86868b]">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#86868b] border-t-[#1D6AE5] mr-3" />
                Loading imports...
              </div>
            ) : imports.length === 0 ? (
              <div className="py-20 text-center text-[#86868b] text-sm">No imports recorded</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#d2d2d7]">
                    {['Source', 'Version', 'Effective', 'Status', 'Counts', 'Errors', 'Started', 'Finished'].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[#86868b]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {imports.map((imp) => {
                    const failed = imp.status === 'failed';
                    return (
                      <tr
                        key={imp.id}
                        className={`border-b border-[#d2d2d7]/50 ${failed ? 'bg-red-500/5' : ''}`}
                      >
                        <td className="px-4 py-3 text-xs font-medium text-[#1d1d1f]">{imp.source}</td>
                        <td className="px-4 py-3 font-mono text-[11px] text-[#6e6e73]">
                          {imp.source_version ?? '--'}
                        </td>
                        <td className="px-4 py-3 text-xs text-[#6e6e73]">{imp.effective_date ?? '--'}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                              IMPORT_STATUS_CLASSES[imp.status] ?? 'bg-zinc-500/15 text-[#86868b]'
                            }`}
                          >
                            {imp.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[10px] font-mono text-[#86868b] max-w-[220px]">
                          {imp.counts
                            ? Object.entries(imp.counts)
                                .map(([k, v]) => `${k}: ${String(v)}`)
                                .join(' · ')
                            : '--'}
                        </td>
                        <td className={`px-4 py-3 text-[11px] max-w-[220px] ${failed ? 'text-red-400' : 'text-[#86868b]'}`}>
                          {imp.error_summary ?? '--'}
                        </td>
                        <td className="px-4 py-3 text-xs text-[#86868b] whitespace-nowrap">
                          {fmtTime(imp.started_at)}
                        </td>
                        <td className="px-4 py-3 text-xs text-[#86868b] whitespace-nowrap">
                          {fmtTime(imp.finished_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
