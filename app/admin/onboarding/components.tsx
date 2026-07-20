'use client';

import { useState } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// TAKEME ADMIN — Onboarding shared components
// Status badges, time formatting, applicant-type labels, reason modal.
// ═══════════════════════════════════════════════════════════════════════════

const GREEN = new Set(['approved', 'clear', 'eligible', 'verified', 'active', 'completed']);
const BLUE = new Set(['submitted', 'under_review', 'pending_review', 'provider_pending', 'pending', 'waived', 'reinstated']);
const GRAY = new Set(['in_progress', 'not_started', 'none', 'offline', 'skipped']);
const RED = new Set(['needs_action', 'rejected', 'expired', 'adverse', 'adverse_final', 'suspended', 'blocked', 'ineligible', 'failed']);
const AMBER = new Set(['expiring_soon', 'consider', 'needs_review', 'expiring']);

export function badgeClass(status: string): string {
  const s = status?.toLowerCase?.() ?? '';
  if (GREEN.has(s)) return 'bg-emerald-500/15 text-emerald-400';
  if (RED.has(s)) return 'bg-red-500/15 text-red-400';
  if (AMBER.has(s)) return 'bg-amber-500/15 text-amber-400';
  if (BLUE.has(s)) return 'bg-blue-500/15 text-blue-400';
  if (GRAY.has(s)) return 'bg-zinc-500/15 text-[#86868b]';
  return 'bg-zinc-500/15 text-[#86868b]';
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return <span className="text-xs text-[#86868b]">--</span>;
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${badgeClass(status)} ${className ?? ''}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '--';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDay(iso: string | null | undefined) {
  if (!iso) return '--';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export const APPLICANT_TYPES = [
  'individual_owner',
  'individual_lease',
  'rental_seeker',
  'fleet_driver',
  'fleet_owner',
  'livery_operator',
  'subcarrier',
] as const;

export function applicantTypeLabel(t: string | null | undefined) {
  if (!t) return '--';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Reason / note modal ───────────────────────────────────────────────────

export interface ReasonModalConfig {
  title: string;
  description?: string;
  label: string;
  placeholder: string;
  confirmLabel: string;
  danger?: boolean;
  /** When true the text field must be non-empty to submit. */
  requireText: boolean;
  onSubmit: (text: string) => void;
}

export function ReasonModal({ config, onClose }: { config: ReasonModalConfig; onClose: () => void }) {
  const [text, setText] = useState('');
  const disabled = config.requireText && text.trim().length < 3;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-[#d2d2d7] bg-[#f5f5f7] p-6 shadow-2xl">
        <h3 className="mb-2 text-sm font-semibold text-[#1d1d1f]">{config.title}</h3>
        {config.description && (
          <p className={`mb-3 text-xs ${config.danger ? 'text-red-400 font-medium' : 'text-[#86868b]'}`}>
            {config.description}
          </p>
        )}
        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[#86868b]">
          {config.label}
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={config.placeholder}
          rows={4}
          autoFocus
          className="mb-4 w-full rounded-lg border border-[#d2d2d7] bg-[#FFFFFF] px-4 py-3 text-sm text-[#1d1d1f] placeholder-[#86868b] outline-none focus:border-[#1D6AE5]/50"
        />
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-[#d2d2d7] px-4 py-2 text-xs font-medium text-[#86868b] hover:text-[#6e6e73] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { config.onSubmit(text.trim()); onClose(); }}
            disabled={disabled}
            className={`rounded-lg px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
              config.danger
                ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
            }`}
          >
            {config.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
