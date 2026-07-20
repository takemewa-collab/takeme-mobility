'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { StatusBadge, timeAgo, APPLICANT_TYPES, applicantTypeLabel } from './components';

// ═══════════════════════════════════════════════════════════════════════════
// TAKEME ADMIN — Driver Applications Queue
// Filterable onboarding review queue, sorted oldest-review-first.
// ═══════════════════════════════════════════════════════════════════════════

interface QueueCounts {
  review: number;
  needsAction: number;
  expiring: number;
  open: number;
  total: number;
  oldestReviewAt: string | null;
}

interface QueueApplication {
  id: string;
  userId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  applicantType: string | null;
  vehicleRelationship: string | null;
  market: string | null;
  vehicle: string | null;
  createdAt: string;
  updatedAt: string;
  counts: QueueCounts;
}

const QUEUE_TABS = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Needs review' },
  { key: 'expiring', label: 'Expiring' },
] as const;

const STATUS_OPTIONS = ['in_progress', 'pending', 'approved', 'rejected', 'suspended'] as const;

export default function AdminOnboardingPage() {
  const router = useRouter();
  const [applications, setApplications] = useState<QueueApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [queue, setQueue] = useState<string>('all');
  const [status, setStatus] = useState('');
  const [applicantType, setApplicantType] = useState('');
  const [search, setSearch] = useState('');
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchApplications = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (queue !== 'all') params.set('queue', queue);
      if (status) params.set('status', status);
      if (applicantType) params.set('applicantType', applicantType);
      if (search) params.set('search', search);

      const res = await fetch(`/api/admin/onboarding?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setApplications(data.applications ?? []);
      setError('');
    } catch {
      setError('Failed to load applications');
    } finally {
      setLoading(false);
    }
  }, [queue, status, applicantType, search]);

  useEffect(() => {
    setLoading(true);
    fetchApplications();
  }, [fetchApplications]);

  const handleSearchChange = (value: string) => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearch(value);
    }, 400);
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1d1d1f]">Driver applications</h1>
        <p className="text-sm text-[#86868b] mt-1">{applications.length} applications</p>
      </div>

      {/* Queue tabs + filters + search */}
      <div className="flex items-center justify-between mb-5 gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 bg-[#f5f5f7] rounded-xl p-1 border border-[#d2d2d7]">
            {QUEUE_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setQueue(t.key)}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  queue === t.key
                    ? 'bg-[#d2d2d7] text-[#1d1d1f]'
                    : 'text-[#86868b] hover:text-[#6e6e73]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2 rounded-xl bg-[#f5f5f7] border border-[#d2d2d7] text-sm text-[#1d1d1f] focus:outline-none focus:border-[#d2d2d7]"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>

          <select
            value={applicantType}
            onChange={(e) => setApplicantType(e.target.value)}
            className="px-3 py-2 rounded-xl bg-[#f5f5f7] border border-[#d2d2d7] text-sm text-[#1d1d1f] focus:outline-none focus:border-[#d2d2d7]"
          >
            <option value="">All types</option>
            {APPLICANT_TYPES.map((t) => (
              <option key={t} value={t}>{applicantTypeLabel(t)}</option>
            ))}
          </select>
        </div>

        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#86868b]"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="text"
            placeholder="Search name, phone or email..."
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-10 pr-4 py-2 rounded-xl bg-[#f5f5f7] border border-[#d2d2d7] text-sm text-[#1d1d1f] placeholder:text-[#86868b] focus:outline-none focus:border-[#d2d2d7] w-64"
          />
        </div>
      </div>

      {/* Error */}
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
            Loading applications...
          </div>
        ) : applications.length === 0 ? (
          <div className="py-20 text-center text-[#86868b] text-sm">No applications found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#d2d2d7]">
                  {['Applicant', 'Market', 'Type', 'Vehicle', 'Status', 'In review', 'Needs action', 'Expiring', 'Waiting since'].map((h) => (
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
                {applications.map((app) => (
                  <tr
                    key={app.id}
                    onClick={() => router.push(`/admin/onboarding/${app.id}`)}
                    className="border-b border-[#d2d2d7]/50 cursor-pointer transition-colors hover:bg-[#d2d2d7]/30"
                  >
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#1d1d1f]">{app.fullName || app.email || 'Unknown'}</p>
                      <p className="text-[10px] text-[#86868b]">{app.phone || app.email || '--'}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-[#6e6e73]">{app.market ?? '--'}</td>
                    <td className="px-4 py-3 text-xs text-[#6e6e73]">{applicantTypeLabel(app.applicantType)}</td>
                    <td className="px-4 py-3 text-xs text-[#86868b]">{app.vehicle ?? '--'}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={app.status} />
                    </td>
                    <td className="px-4 py-3">
                      {app.counts.review > 0 ? (
                        <span className="inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold bg-blue-500/15 text-blue-400">
                          {app.counts.review}
                        </span>
                      ) : (
                        <span className="text-xs text-[#86868b]">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {app.counts.needsAction > 0 ? (
                        <span className="inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-400">
                          {app.counts.needsAction}
                        </span>
                      ) : (
                        <span className="text-xs text-[#86868b]">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {app.counts.expiring > 0 ? (
                        <span className="inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold bg-amber-500/15 text-amber-400">
                          {app.counts.expiring}
                        </span>
                      ) : (
                        <span className="text-xs text-[#86868b]">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#86868b]">
                      {timeAgo(app.counts.oldestReviewAt ?? app.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
