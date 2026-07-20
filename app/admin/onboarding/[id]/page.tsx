'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  StatusBadge,
  badgeClass,
  timeAgo,
  fmtDate,
  fmtDay,
  applicantTypeLabel,
  ReasonModal,
  type ReasonModalConfig,
} from '../components';

// ═══════════════════════════════════════════════════════════════════════════
// TAKEME ADMIN — Driver Application Review
// Requirement checklist, documents, vehicle, background check, consents,
// event history, and application-level actions.
// ═══════════════════════════════════════════════════════════════════════════

interface Requirement {
  id: string;
  key: string;
  title: string;
  category: string | null;
  reviewMethod: string | null;
  required: boolean;
  blocking: boolean;
  status: string;
  rejectionReason: string | null;
  reviewNote: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  complianceReview: boolean;
}

interface DocumentItem {
  id: string;
  docType: string;
  status: string;
  rejectionReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  requirementId: string | null;
  mimeType: string | null;
  viewUrl: string | null;
}

interface ConsentItem {
  documentKey: string;
  version: string | number;
  locale: string | null;
  acceptedAt: string;
}

interface EventItem {
  actor: string;
  actor_id: string | null;
  event: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

interface DetailData {
  application: {
    id: string;
    user_id: string;
    full_name: string | null;
    phone: string | null;
    email: string | null;
    license_number: string | null;
    status: string;
    applicant_type: string | null;
    vehicle_relationship: string | null;
    vehicle_make: string | null;
    vehicle_model: string | null;
    vehicle_year: number | null;
    vehicle_color: string | null;
    plate_number: string | null;
    plate_state: string | null;
    vin: string | null;
    powertrain: string | null;
    doors: number | null;
    seatbelts: number | null;
    vehicle_verification: Record<string, unknown> | null;
    preferences: Record<string, unknown> | null;
    preferred_language: string | null;
    created_at: string;
    submitted_at: string | null;
  };
  market: { key: string; displayName: string } | null;
  driver: { id: string; is_verified: boolean; is_active: boolean; status: string } | null;
  activation: { decision: string; reasonCodes: string[]; requiredActions: string[] };
  requirements: Requirement[];
  documents: DocumentItem[];
  consents: ConsentItem[];
  backgroundCheck: {
    provider: string;
    status: string;
    submittedAt: string | null;
    completedAt: string | null;
  } | null;
  events: EventItem[];
}

const REVIEWABLE_STATUSES = ['submitted', 'under_review', 'pending_review', 'needs_action'];
const SATISFIED_STATUSES = ['approved', 'waived', 'verified', 'clear'];
const EXPIRY_CATEGORIES = ['document_review', 'market_permit'];

const label = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '--');

function decisionClass(decision: string): string {
  const s = decision?.toLowerCase?.() ?? '';
  if (['eligible', 'activate', 'approved', 'active', 'ready'].includes(s)) {
    return 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400';
  }
  if (['blocked', 'rejected', 'ineligible', 'suspended', 'adverse'].includes(s)) {
    return 'border-red-500/30 bg-red-500/5 text-red-400';
  }
  return 'border-amber-500/30 bg-amber-500/5 text-amber-400';
}

export default function OnboardingDetailPage() {
  const params = useParams<{ id: string }>();
  const appId = params.id;

  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [modal, setModal] = useState<ReasonModalConfig | null>(null);
  // Optional expiration date inputs, keyed by requirement key or `doc:{id}`.
  const [expiry, setExpiry] = useState<Record<string, string>>({});

  const fetchDetail = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/onboarding/${appId}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load application');
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const performAction = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setActionMessage('');
    try {
      const res = await fetch(`/api/admin/onboarding/${appId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionMessage(`Error: ${json.error ?? `HTTP ${res.status}`}`);
      } else {
        await fetchDetail();
      }
    } catch {
      setActionMessage('Error: action failed');
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFFFFF] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#1D6AE5] border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#FFFFFF] flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 text-sm mb-4">{error}</p>
          <Link href="/admin/onboarding" className="text-xs text-[#1D6AE5] hover:text-[#005bb5]">Back to applications</Link>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { application, market, driver, activation, requirements, documents, consents, backgroundCheck, events } = data;
  const vv = application.vehicle_verification;
  const vvReasons = Array.isArray(vv?.reasons) ? (vv.reasons as unknown[]).map(String) : [];
  const anyBusy = busy !== '';

  const canReject = application.status !== 'rejected';
  const canSuspend = !['suspended', 'rejected'].includes(application.status);
  const canReinstate = ['suspended', 'rejected'].includes(application.status);

  return (
    <div className="min-h-screen bg-[#FFFFFF] p-6 lg:p-8">
      <div className="mx-auto max-w-[1200px]">
        {/* Breadcrumb */}
        <div className="mb-6 flex items-center gap-2 text-xs text-[#86868b]">
          <Link href="/admin" className="hover:text-[#6e6e73] transition-colors">Dashboard</Link>
          <span>/</span>
          <Link href="/admin/onboarding" className="hover:text-[#6e6e73] transition-colors">Driver applications</Link>
          <span>/</span>
          <span className="text-[#1d1d1f]">{application.full_name || application.email || application.id}</span>
        </div>

        {/* Header */}
        <div className="mb-6 flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1D6AE5]/10 text-[#1D6AE5] text-xl font-bold">
              {(application.full_name || application.email)?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold text-[#1d1d1f]">{application.full_name || 'Unknown'}</h1>
                <StatusBadge status={application.status} className="!text-[11px]" />
                {driver?.is_verified && (
                  <span className="inline-flex rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400">
                    Verified driver
                  </span>
                )}
              </div>
              <p className="text-sm text-[#86868b]">{application.email ?? '--'}</p>
              <p className="text-sm text-[#86868b]">{application.phone ?? '--'}</p>
              <div className="mt-1 flex items-center gap-3 text-xs text-[#86868b]">
                <span>Market: <span className="text-[#6e6e73]">{market?.displayName ?? '--'}</span></span>
                <span>Type: <span className="text-[#6e6e73]">{applicantTypeLabel(application.applicant_type)}</span></span>
                {application.vehicle_relationship && (
                  <span>Vehicle: <span className="text-[#6e6e73]">{label(application.vehicle_relationship)}</span></span>
                )}
              </div>
            </div>
          </div>

          {/* Top-level actions */}
          <div className="flex flex-wrap gap-2">
            {canReject && (
              <button
                onClick={() => setModal({
                  title: 'Reject application',
                  label: 'Reason',
                  placeholder: 'Reason for rejection...',
                  confirmLabel: 'Reject application',
                  danger: true,
                  requireText: true,
                  onSubmit: (reason) => performAction('reject_application', { action: 'reject_application', reason }),
                })}
                disabled={anyBusy}
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                {busy === 'reject_application' ? 'Rejecting...' : 'Reject application'}
              </button>
            )}
            {canSuspend && (
              <button
                onClick={() => setModal({
                  title: 'Suspend application',
                  label: 'Reason',
                  placeholder: 'Reason for suspension...',
                  confirmLabel: 'Suspend',
                  danger: true,
                  requireText: true,
                  onSubmit: (reason) => performAction('suspend_application', { action: 'suspend_application', reason }),
                })}
                disabled={anyBusy}
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
              >
                {busy === 'suspend_application' ? 'Suspending...' : 'Suspend'}
              </button>
            )}
            {canReinstate && (
              <button
                onClick={() => setModal({
                  title: 'Reinstate application',
                  label: 'Note (optional)',
                  placeholder: 'Optional note...',
                  confirmLabel: 'Reinstate',
                  requireText: false,
                  onSubmit: (note) => performAction('reinstate_application', { action: 'reinstate_application', ...(note ? { note } : {}) }),
                })}
                disabled={anyBusy}
                className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {busy === 'reinstate_application' ? 'Reinstating...' : 'Reinstate'}
              </button>
            )}
            <button
              onClick={() => setModal({
                title: `Add note for ${application.full_name || application.email || 'applicant'}`,
                label: 'Note',
                placeholder: 'Enter note...',
                confirmLabel: 'Save note',
                requireText: true,
                onSubmit: (note) => performAction('add_note', { action: 'add_note', note }),
              })}
              disabled={anyBusy}
              className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-xs font-semibold text-blue-400 transition-colors hover:bg-blue-500/20 disabled:opacity-50"
            >
              {busy === 'add_note' ? 'Saving...' : 'Add note'}
            </button>
          </div>
        </div>

        {/* Activation banner */}
        <div className={`mb-6 rounded-xl border px-4 py-3 ${decisionClass(activation.decision)}`}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold uppercase tracking-wider">Activation: {label(activation.decision)}</span>
            {activation.reasonCodes.map((code) => (
              <span key={code} className="inline-flex rounded-full bg-[#FFFFFF] border border-[#d2d2d7] px-2.5 py-0.5 text-[10px] font-semibold text-[#6e6e73]">
                {label(code)}
              </span>
            ))}
          </div>
          {activation.requiredActions.length > 0 && (
            <p className="mt-1.5 text-[11px] text-[#86868b]">
              Required: {activation.requiredActions.map(label).join(', ')}
            </p>
          )}
        </div>

        {actionMessage && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs font-medium text-red-400">
            {actionMessage}
          </div>
        )}

        {/* Requirement checklist */}
        <div className="mb-8 rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] overflow-hidden">
          <div className="border-b border-[#d2d2d7] px-5 py-4">
            <h3 className="text-sm font-semibold text-[#1d1d1f]">Requirements ({requirements.length})</h3>
          </div>
          {requirements.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-[#86868b]">No requirements</p>
          ) : (
            <div>
              {requirements.map((req) => {
                const canApproveReq = REVIEWABLE_STATUSES.includes(req.status);
                const canRejectReq = REVIEWABLE_STATUSES.includes(req.status);
                const canRequestInfo = ['submitted', 'under_review', 'pending_review'].includes(req.status);
                const canWaive = !SATISFIED_STATUSES.includes(req.status);
                const showExpiryInput = req.category != null && EXPIRY_CATEGORIES.includes(req.category);
                return (
                  <div key={req.id} className="border-b border-[#d2d2d7]/50 px-5 py-4 last:border-b-0">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-[#1d1d1f]">{req.title}</p>
                          <StatusBadge status={req.status} />
                          {req.category && (
                            <span className="inline-flex rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] font-semibold text-[#86868b]">
                              {label(req.category)}
                            </span>
                          )}
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            req.blocking ? 'bg-red-500/10 text-red-400' : 'bg-zinc-500/15 text-[#86868b]'
                          }`}>
                            {req.blocking ? 'blocking' : req.required ? 'required' : 'optional'}
                          </span>
                          {req.complianceReview && (
                            <span className="inline-flex rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                              compliance review
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-[11px] text-[#86868b] flex-wrap">
                          {req.reviewMethod && <span>Review: {label(req.reviewMethod)}</span>}
                          {req.expiresAt && <span>Expires: {fmtDay(req.expiresAt)}</span>}
                          {req.updatedAt && <span>Updated {timeAgo(req.updatedAt)}</span>}
                        </div>
                        {req.rejectionReason && (
                          <p className="mt-1 text-[11px] text-red-400">Rejection: {req.rejectionReason}</p>
                        )}
                        {req.reviewNote && (
                          <p className="mt-1 text-[11px] text-[#6e6e73]">Note: {req.reviewNote}</p>
                        )}
                      </div>

                      {/* Per-row actions */}
                      <div className="flex items-center gap-2 flex-wrap shrink-0">
                        {canApproveReq && showExpiryInput && (
                          <input
                            type="date"
                            value={expiry[req.key] ?? ''}
                            onChange={(e) => setExpiry((prev) => ({ ...prev, [req.key]: e.target.value }))}
                            title="Optional expiration date"
                            className="rounded-lg border border-[#d2d2d7] bg-[#FFFFFF] px-2 py-1.5 text-[11px] text-[#6e6e73] focus:outline-none focus:border-[#1D6AE5]/50"
                          />
                        )}
                        {canApproveReq && (
                          <button
                            onClick={() => performAction(`approve_req:${req.key}`, {
                              action: 'approve_requirement',
                              requirementKey: req.key,
                              ...(expiry[req.key] ? { expiresOn: expiry[req.key] } : {}),
                            })}
                            disabled={anyBusy}
                            className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                          >
                            {busy === `approve_req:${req.key}` ? 'Approving...' : 'Approve'}
                          </button>
                        )}
                        {canRejectReq && (
                          <button
                            onClick={() => setModal({
                              title: `Reject "${req.title}"`,
                              label: 'Reason',
                              placeholder: 'Reason for rejection...',
                              confirmLabel: 'Reject',
                              danger: true,
                              requireText: true,
                              onSubmit: (reason) => performAction(`reject_req:${req.key}`, {
                                action: 'reject_requirement',
                                requirementKey: req.key,
                                reason,
                              }),
                            })}
                            disabled={anyBusy}
                            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                          >
                            {busy === `reject_req:${req.key}` ? 'Rejecting...' : 'Reject'}
                          </button>
                        )}
                        {canRequestInfo && (
                          <button
                            onClick={() => setModal({
                              title: `Request info for "${req.title}"`,
                              label: 'Note to applicant',
                              placeholder: 'What is needed...',
                              confirmLabel: 'Request info',
                              requireText: true,
                              onSubmit: (note) => performAction(`request_info:${req.key}`, {
                                action: 'request_info',
                                requirementKey: req.key,
                                note,
                              }),
                            })}
                            disabled={anyBusy}
                            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] font-semibold text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                          >
                            {busy === `request_info:${req.key}` ? 'Requesting...' : 'Request info'}
                          </button>
                        )}
                        {canWaive && (
                          <button
                            onClick={() => setModal({
                              title: `Waive "${req.title}"`,
                              label: 'Reason',
                              placeholder: 'Reason for waiving...',
                              confirmLabel: 'Waive',
                              requireText: true,
                              onSubmit: (reason) => performAction(`waive_req:${req.key}`, {
                                action: 'waive_requirement',
                                requirementKey: req.key,
                                reason,
                              }),
                            })}
                            disabled={anyBusy}
                            className="rounded-lg border border-[#d2d2d7] bg-[#FFFFFF] px-3 py-1.5 text-[11px] font-semibold text-[#86868b] transition-colors hover:text-[#6e6e73] disabled:opacity-50"
                          >
                            {busy === `waive_req:${req.key}` ? 'Waiving...' : 'Waive'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Documents */}
        <div className="mb-8 rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] overflow-hidden">
          <div className="border-b border-[#d2d2d7] px-5 py-4">
            <h3 className="text-sm font-semibold text-[#1d1d1f]">Documents ({documents.length})</h3>
          </div>
          {documents.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-[#86868b]">No documents uploaded</p>
          ) : (
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {documents.map((doc) => {
                const isImage = doc.mimeType?.startsWith('image/') && doc.viewUrl;
                const isPdf = doc.mimeType === 'application/pdf' && doc.viewUrl;
                const actionable = !['approved', 'rejected'].includes(doc.status);
                const expiryKey = `doc:${doc.id}`;
                return (
                  <div key={doc.id} className="rounded-lg border border-[#d2d2d7] bg-[#FFFFFF] p-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-[#1d1d1f] capitalize">{label(doc.docType)}</p>
                      <StatusBadge status={doc.status} />
                    </div>
                    {isImage ? (
                      <a href={doc.viewUrl!} target="_blank" rel="noopener noreferrer" className="block mb-2">
                        {/* Signed URL expires in 5 min; next/image not applicable */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={doc.viewUrl!}
                          alt={label(doc.docType)}
                          className="h-32 w-full rounded-lg border border-[#d2d2d7] object-cover"
                        />
                      </a>
                    ) : isPdf ? (
                      <a
                        href={doc.viewUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-[#d2d2d7] bg-[#f5f5f7] px-3 py-2 text-[11px] font-medium text-[#1D6AE5] hover:text-[#005bb5] transition-colors"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                        Open PDF
                      </a>
                    ) : doc.viewUrl ? (
                      <a
                        href={doc.viewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mb-2 inline-block text-[11px] font-medium text-[#1D6AE5] hover:text-[#005bb5] transition-colors"
                      >
                        Open file
                      </a>
                    ) : (
                      <p className="mb-2 text-[11px] text-[#86868b]">No preview available</p>
                    )}
                    <div className="space-y-0.5 text-[10px] text-[#86868b]">
                      <p>Uploaded {fmtDate(doc.createdAt)}</p>
                      {doc.expiresAt && <p>Expires {fmtDay(doc.expiresAt)}</p>}
                      {doc.rejectionReason && <p className="text-red-400">Rejection: {doc.rejectionReason}</p>}
                    </div>
                    {actionable && (
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        <input
                          type="date"
                          value={expiry[expiryKey] ?? ''}
                          onChange={(e) => setExpiry((prev) => ({ ...prev, [expiryKey]: e.target.value }))}
                          title="Optional expiration date"
                          className="rounded-lg border border-[#d2d2d7] bg-[#f5f5f7] px-2 py-1.5 text-[11px] text-[#6e6e73] focus:outline-none focus:border-[#1D6AE5]/50"
                        />
                        <button
                          onClick={() => performAction(`approve_doc:${doc.id}`, {
                            action: 'approve_document',
                            documentId: doc.id,
                            ...(expiry[expiryKey] ? { expiresOn: expiry[expiryKey] } : {}),
                          })}
                          disabled={anyBusy}
                          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                        >
                          {busy === `approve_doc:${doc.id}` ? 'Approving...' : 'Approve'}
                        </button>
                        <button
                          onClick={() => setModal({
                            title: `Reject ${label(doc.docType)}`,
                            label: 'Reason',
                            placeholder: 'Reason for rejection...',
                            confirmLabel: 'Reject',
                            danger: true,
                            requireText: true,
                            onSubmit: (reason) => performAction(`reject_doc:${doc.id}`, {
                              action: 'reject_document',
                              documentId: doc.id,
                              reason,
                            }),
                          })}
                          disabled={anyBusy}
                          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                        >
                          {busy === `reject_doc:${doc.id}` ? 'Rejecting...' : 'Reject'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Vehicle + Background check */}
        <div className="mb-8 grid gap-6 lg:grid-cols-2">
          {/* Vehicle */}
          <div className="rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] p-5">
            <h3 className="mb-4 text-sm font-semibold text-[#1d1d1f]">Vehicle</h3>
            {application.vehicle_make ? (
              <div className="space-y-2 text-xs">
                <InfoRow
                  label="Vehicle"
                  value={`${application.vehicle_year ?? ''} ${application.vehicle_make} ${application.vehicle_model ?? ''}${application.vehicle_color ? ` (${application.vehicle_color})` : ''}`.trim()}
                />
                <InfoRow label="VIN" value={application.vin ?? '--'} mono />
                <InfoRow
                  label="Plate"
                  value={application.plate_number ? `${application.plate_number}${application.plate_state ? ` (${application.plate_state})` : ''}` : '--'}
                  mono
                />
                <InfoRow label="Powertrain" value={label(application.powertrain)} />
                <InfoRow label="Doors / seatbelts" value={`${application.doors ?? '--'} / ${application.seatbelts ?? '--'}`} />
              </div>
            ) : (
              <p className="text-sm text-[#86868b]">No vehicle on application</p>
            )}

            {/* Vehicle verification summary */}
            {vv && (
              <div className="mt-4 rounded-lg border border-[#d2d2d7] bg-[#FFFFFF] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[#86868b]">Verification</p>
                  {vv.eligible === true ? (
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${badgeClass('eligible')}`}>eligible</span>
                  ) : vv.eligible === false ? (
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${badgeClass('ineligible')}`}>ineligible</span>
                  ) : null}
                  {(vv.needsReview === true || vv.needs_review === true) && (
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${badgeClass('needs_review')}`}>needs review</span>
                  )}
                </div>
                {vvReasons.length > 0 && (
                  <ul className="mb-2 list-disc pl-4 text-[11px] text-[#6e6e73] space-y-0.5">
                    {vvReasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
                <p className="text-[10px] text-[#86868b]">
                  {typeof vv.source === 'string' && <span>Source: {vv.source}</span>}
                  {typeof (vv.checkedAt ?? vv.checked_at) === 'string' && (
                    <span>{typeof vv.source === 'string' ? ' -- ' : ''}Checked {fmtDate(String(vv.checkedAt ?? vv.checked_at))}</span>
                  )}
                </p>
              </div>
            )}
          </div>

          {/* Background check */}
          <div className="rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] p-5">
            <h3 className="mb-4 text-sm font-semibold text-[#1d1d1f]">Background check</h3>
            {backgroundCheck ? (
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-xs text-[#86868b]">Provider:</span>
                  <span className="text-xs font-medium text-[#1d1d1f] capitalize">{backgroundCheck.provider}</span>
                  <StatusBadge status={backgroundCheck.status} />
                </div>
                <div className="space-y-2 text-xs">
                  <InfoRow label="Submitted" value={fmtDate(backgroundCheck.submittedAt)} />
                  <InfoRow label="Completed" value={fmtDate(backgroundCheck.completedAt)} />
                </div>
                {backgroundCheck.provider === 'manual' && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      onClick={() => performAction('bg:clear', { action: 'set_background_status', status: 'clear' })}
                      disabled={anyBusy}
                      className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      {busy === 'bg:clear' ? 'Saving...' : 'Clear'}
                    </button>
                    <button
                      onClick={() => performAction('bg:consider', { action: 'set_background_status', status: 'consider' })}
                      disabled={anyBusy}
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] font-semibold text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                    >
                      {busy === 'bg:consider' ? 'Saving...' : 'Consider'}
                    </button>
                    <button
                      onClick={() => setModal({
                        title: 'Final adverse decision',
                        description: 'This is a final adverse decision.',
                        label: 'Note (optional)',
                        placeholder: 'Optional note...',
                        confirmLabel: 'Confirm final adverse',
                        danger: true,
                        requireText: false,
                        onSubmit: (note) => performAction('bg:adverse_final', {
                          action: 'set_background_status',
                          status: 'adverse_final',
                          ...(note ? { note } : {}),
                        }),
                      })}
                      disabled={anyBusy}
                      className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                    >
                      {busy === 'bg:adverse_final' ? 'Saving...' : 'Final adverse'}
                    </button>
                    <button
                      onClick={() => performAction('bg:under_review', { action: 'set_background_status', status: 'under_review' })}
                      disabled={anyBusy}
                      className="rounded-lg border border-[#d2d2d7] bg-[#FFFFFF] px-3 py-1.5 text-[11px] font-semibold text-[#86868b] transition-colors hover:text-[#6e6e73] disabled:opacity-50"
                    >
                      {busy === 'bg:under_review' ? 'Saving...' : 'Back to review'}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-[#86868b]">No background case</p>
            )}

            {/* Consents */}
            <h3 className="mb-3 mt-6 text-sm font-semibold text-[#1d1d1f]">Consents ({consents.length})</h3>
            {consents.length === 0 ? (
              <p className="text-sm text-[#86868b]">No consents recorded</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-[#d2d2d7] bg-[#FFFFFF]">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#d2d2d7]">
                      {['Document', 'Version', 'Locale', 'Accepted'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {consents.map((c, i) => (
                      <tr key={`${c.documentKey}-${i}`} className="border-b border-[#d2d2d7]/50 last:border-b-0">
                        <td className="px-3 py-2 text-[11px] text-[#1d1d1f]">{label(c.documentKey)}</td>
                        <td className="px-3 py-2 text-[11px] text-[#6e6e73]">v{c.version}</td>
                        <td className="px-3 py-2 text-[11px] text-[#6e6e73]">{c.locale ?? '--'}</td>
                        <td className="px-3 py-2 text-[11px] text-[#86868b]">{fmtDate(c.acceptedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* History */}
        <div className="mb-8 rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] overflow-hidden">
          <div className="border-b border-[#d2d2d7] px-5 py-4">
            <h3 className="text-sm font-semibold text-[#1d1d1f]">History ({events.length})</h3>
          </div>
          {events.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-[#86868b]">No events</p>
          ) : (
            <div>
              {events.map((ev, i) => (
                <div key={i} className="flex items-start gap-3 border-b border-[#d2d2d7]/50 px-5 py-3 last:border-b-0">
                  <span className="mt-1 inline-flex rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] font-semibold text-[#86868b] capitalize shrink-0">
                    {ev.actor}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-[#1d1d1f]">{label(ev.event)}</p>
                    {ev.detail && Object.keys(ev.detail).length > 0 && (
                      <pre className="mt-0.5 whitespace-pre-wrap break-all text-[10px] text-[#86868b]">
                        {JSON.stringify(ev.detail)}
                      </pre>
                    )}
                  </div>
                  <span className="text-[10px] text-[#86868b] shrink-0" title={fmtDate(ev.created_at)}>
                    {timeAgo(ev.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Reason / note modal */}
        {modal && <ReasonModal config={modal} onClose={() => setModal(null)} />}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[#86868b]">{label}</span>
      <span className={`text-right text-[#6e6e73] ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
