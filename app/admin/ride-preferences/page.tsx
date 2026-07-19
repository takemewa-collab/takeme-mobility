'use client';

import { useState, useEffect, useCallback } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// TAKEME ADMIN — Ride Preferences: Women Preferred + Pet Friendly
// Per-market configuration (default "All markets" row + per-state overrides),
// driver-program aggregates, and recent audit-log changes.
// ═══════════════════════════════════════════════════════════════════════════

type Preference = 'women_preferred' | 'pet_friendly';

interface PrefConfig {
  id: string;
  preference: Preference;
  state_code: string | null;
  enabled: boolean;
  fee: number | null;
  fee_effective_from: string | null;
  fee_effective_to: string | null;
  rules: Record<string, unknown> | null;
  copy_version: string | null;
  fallback_default: string | null;
  active: boolean;
  updated_at: string | null;
}

interface DriverStats {
  petFriendlyOptIn: number;
  womenInvited: number;
  womenEnrolled: number;
}

// Audit entries come from admin_audit_log; shape is tolerated loosely.
interface AuditEntry {
  id?: string | number;
  action?: string | null;
  entity?: string | null;
  entity_id?: string | null;
  actor?: string | null;
  admin_email?: string | null;
  detail?: unknown;
  created_at?: string | null;
}

const FALLBACK_DEFAULTS = ['keep_looking', 'any_driver'] as const;

// Rules keys the apps understand, per preference. Unknown keys block save so a
// typo never ships silently.
const RULE_KEYS: Record<Preference, string[]> = {
  pet_friendly: ['max_pets', 'size_guidance', 'eta_note'],
  women_preferred: ['rollout_note'],
};

const DEFAULT_RULES: Record<Preference, string> = {
  pet_friendly: '{\n  "max_pets": 1,\n  "size_guidance": "",\n  "eta_note": ""\n}',
  women_preferred: '{\n  "rollout_note": ""\n}',
};

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'VI', 'WA', 'WV', 'WI', 'WY',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function timeAgo(iso: string | null | undefined) {
  if (!iso) return '--';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Shared UI (mirrors airports admin) ────────────────────────────────────

const inputCls =
  'rounded-lg border border-[#d2d2d7] bg-[#FFFFFF] px-2.5 py-1.5 text-xs text-[#1d1d1f] placeholder-[#86868b] outline-none focus:border-[#1D6AE5] w-full';

function Card({ title, children, badge }: { title: string; children: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div className="bg-[#f5f5f7] rounded-xl border border-[#d2d2d7] p-5">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#86868b]">{title}</h3>
        {badge}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
        {label}
      </span>
      {children}
    </label>
  );
}

function SaveButton({
  onClick,
  disabled,
  loading,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#1D6AE5]/10 border border-[#1D6AE5]/20 text-[#1D6AE5] hover:bg-[#1D6AE5]/20 transition-colors disabled:opacity-50"
    >
      {loading ? '...' : children}
    </button>
  );
}

function GhostButton({
  onClick,
  disabled,
  loading,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 ${
        danger
          ? 'bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20'
          : 'bg-[#f5f5f7] border-[#d2d2d7] text-[#6e6e73] hover:bg-[#d2d2d7]'
      }`}
    >
      {loading ? '...' : children}
    </button>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[9px] font-semibold ${
        enabled ? 'bg-emerald-500/15 text-emerald-500' : 'bg-zinc-500/15 text-[#86868b]'
      }`}
    >
      {enabled ? 'enabled' : 'disabled'}
    </span>
  );
}

// ── Config editor form ────────────────────────────────────────────────────

interface ConfigForm {
  id?: string;
  state_code: string | null; // null = "All markets" default row
  enabled: boolean;
  fee: string;
  fee_effective_from: string;
  fee_effective_to: string;
  rules: string;
  copy_version: string;
  fallback_default: string;
}

function formFromConfig(c: PrefConfig): ConfigForm {
  return {
    id: c.id,
    state_code: c.state_code,
    enabled: c.enabled,
    fee: c.fee != null ? String(c.fee) : '',
    fee_effective_from: c.fee_effective_from?.slice(0, 10) ?? '',
    fee_effective_to: c.fee_effective_to?.slice(0, 10) ?? '',
    rules: JSON.stringify(c.rules ?? {}, null, 2),
    copy_version: c.copy_version ?? '',
    fallback_default: c.fallback_default ?? 'keep_looking',
  };
}

function emptyForm(preference: Preference, stateCode: string | null): ConfigForm {
  return {
    state_code: stateCode,
    enabled: false,
    fee: '',
    fee_effective_from: '',
    fee_effective_to: '',
    rules: DEFAULT_RULES[preference],
    copy_version: 'v1',
    fallback_default: 'keep_looking',
  };
}

// Returns { error } (blocks save) and parsed rules when valid.
function validateRules(preference: Preference, raw: string): { error: string | null; parsed: Record<string, unknown> | null } {
  const text = raw.trim();
  if (text === '') return { error: null, parsed: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: e instanceof Error ? `Invalid JSON: ${e.message}` : 'Invalid JSON', parsed: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Rules must be a JSON object', parsed: null };
  }
  const allowed = RULE_KEYS[preference];
  const unknown = Object.keys(parsed as Record<string, unknown>).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return {
      error: `Unknown rules key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`,
      parsed: null,
    };
  }
  return { error: null, parsed: parsed as Record<string, unknown> };
}

type SaveConfig = (key: string, data: Record<string, unknown>) => Promise<boolean>;

// ── Preference panel ──────────────────────────────────────────────────────

function PreferencePanel({
  preference,
  title,
  subtitle,
  configs,
  saveConfig,
  busy,
}: {
  preference: Preference;
  title: string;
  subtitle: string;
  configs: PrefConfig[];
  saveConfig: SaveConfig;
  busy: string;
}) {
  const [form, setForm] = useState<ConfigForm | null>(null);
  const hasFee = preference === 'pet_friendly';

  const defaultRow = configs.find((c) => c.state_code === null) ?? null;
  const overrides = configs
    .filter((c) => c.state_code !== null)
    .sort((a, b) => (a.state_code ?? '').localeCompare(b.state_code ?? ''));
  const usedStates = new Set(overrides.map((c) => c.state_code));
  const availableStates = US_STATES.filter((s) => !usedStates.has(s));

  const rulesCheck = form ? validateRules(preference, form.rules) : { error: null, parsed: null };
  const saveKey = `${preference}-save`;

  const save = async () => {
    if (!form || rulesCheck.error) return;
    const ok = await saveConfig(saveKey, {
      ...(form.id ? { id: form.id } : {}),
      preference,
      state_code: form.state_code,
      enabled: form.enabled,
      ...(hasFee
        ? {
            fee: form.fee.trim() === '' ? null : Number(form.fee),
            fee_effective_from: form.fee_effective_from || null,
            fee_effective_to: form.fee_effective_to || null,
          }
        : {}),
      rules: rulesCheck.parsed,
      copy_version: form.copy_version.trim() || null,
      fallback_default: form.fallback_default,
    });
    if (ok) setForm(null);
  };

  const feeInvalid = hasFee && form != null && form.fee.trim() !== '' && (Number.isNaN(Number(form.fee)) || Number(form.fee) < 0);
  const editing = (c: PrefConfig | null, stateCode: string | null) =>
    form != null && (c ? form.id === c.id : form.id === undefined && form.state_code === stateCode);

  const row = (c: PrefConfig | null, stateCode: string | null) => {
    const label = stateCode === null ? 'All markets' : stateCode;
    return (
      <div
        key={c?.id ?? label}
        className="flex items-center gap-2 rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-3 py-2"
      >
        <span
          className={`w-24 shrink-0 text-xs font-medium ${
            stateCode === null ? 'text-[#1d1d1f]' : 'font-mono text-[#6e6e73]'
          }`}
        >
          {label}
        </span>
        {c ? (
          <>
            <EnabledBadge enabled={c.enabled} />
            {!c.active && (
              <span className="inline-flex rounded-full bg-zinc-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#86868b]">
                inactive
              </span>
            )}
            <span className="min-w-0 truncate text-[10px] text-[#86868b]">
              {[
                hasFee && c.fee != null ? `fee $${Number(c.fee).toFixed(2)}` : null,
                hasFee && (c.fee_effective_from || c.fee_effective_to)
                  ? `${c.fee_effective_from?.slice(0, 10) ?? '...'} → ${c.fee_effective_to?.slice(0, 10) ?? 'open'}`
                  : null,
                c.copy_version ? `copy ${c.copy_version}` : null,
                c.fallback_default ? `fallback ${c.fallback_default.replace(/_/g, ' ')}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'no details'}
            </span>
            <span className="ml-auto whitespace-nowrap text-[10px] text-[#86868b]">{timeAgo(c.updated_at)}</span>
          </>
        ) : (
          <span className="ml-2 text-[10px] text-[#86868b]">not configured</span>
        )}
        <div className={c ? '' : 'ml-auto'}>
          <GhostButton
            disabled={editing(c, stateCode)}
            onClick={() => setForm(c ? formFromConfig(c) : emptyForm(preference, stateCode))}
          >
            {c ? 'Edit' : 'Configure'}
          </GhostButton>
        </div>
      </div>
    );
  };

  return (
    <Card
      title={title}
      badge={defaultRow ? <EnabledBadge enabled={defaultRow.enabled} /> : null}
    >
      <p className="mb-3 text-[11px] text-[#86868b]">{subtitle}</p>
      <p className="mb-3 text-[11px] text-[#86868b]">
        Setting a row to <span className="font-medium text-[#6e6e73]">disabled</span> takes effect on riders and
        drivers immediately — no app release required.
      </p>

      <div className="space-y-2 mb-3">
        {row(defaultRow, null)}
        {overrides.map((c) => row(c, c.state_code))}
      </div>

      {form ? (
        <div className="rounded-lg border border-[#1D6AE5]/30 bg-[#FFFFFF] p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
            {form.state_code === null ? 'All markets (default)' : `State override — ${form.state_code}`}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-xs text-[#6e6e73]">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                Enabled
              </label>
            </div>
            <Field label="Copy version">
              <input
                className={inputCls}
                value={form.copy_version}
                onChange={(e) => setForm({ ...form, copy_version: e.target.value })}
                placeholder="e.g. v1"
              />
            </Field>
            <Field label="Fallback default">
              <select
                className={inputCls}
                value={form.fallback_default}
                onChange={(e) => setForm({ ...form, fallback_default: e.target.value })}
              >
                {FALLBACK_DEFAULTS.map((f) => (
                  <option key={f} value={f}>
                    {f.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>
            {hasFee && (
              <>
                <Field label="Fee (USD)">
                  <input
                    className={inputCls}
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.fee}
                    onChange={(e) => setForm({ ...form, fee: e.target.value })}
                    placeholder="e.g. 4.00"
                  />
                </Field>
                <Field label="Fee effective from">
                  <input
                    className={inputCls}
                    type="date"
                    value={form.fee_effective_from}
                    onChange={(e) => setForm({ ...form, fee_effective_from: e.target.value })}
                  />
                </Field>
                <Field label="Fee effective to">
                  <input
                    className={inputCls}
                    type="date"
                    value={form.fee_effective_to}
                    onChange={(e) => setForm({ ...form, fee_effective_to: e.target.value })}
                  />
                </Field>
              </>
            )}
            <div className="col-span-2 md:col-span-4">
              <Field label={`Rules JSON (${RULE_KEYS[preference].join(', ')})`}>
                <textarea
                  className={`${inputCls} min-h-[100px] font-mono`}
                  value={form.rules}
                  onChange={(e) => setForm({ ...form, rules: e.target.value })}
                  spellCheck={false}
                />
              </Field>
              {rulesCheck.error && <p className="mt-1 text-[11px] text-red-400">{rulesCheck.error}</p>}
              {feeInvalid && <p className="mt-1 text-[11px] text-red-400">Fee must be a non-negative number</p>}
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <GhostButton onClick={() => setForm(null)}>Cancel</GhostButton>
            <SaveButton
              onClick={save}
              loading={busy === saveKey}
              disabled={rulesCheck.error !== null || feeInvalid}
            >
              Save config
            </SaveButton>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <select
            className="rounded-lg border border-[#d2d2d7] bg-[#f5f5f7] px-2.5 py-1.5 text-[11px] text-[#6e6e73] outline-none focus:border-[#1D6AE5]"
            value=""
            onChange={(e) => {
              if (e.target.value) setForm(emptyForm(preference, e.target.value));
            }}
          >
            <option value="">+ Add state override...</option>
            {availableStates.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
    </Card>
  );
}

// ── Driver program card ───────────────────────────────────────────────────

function DriverProgramCard({
  stats,
  action,
  busy,
}: {
  stats: DriverStats | null;
  action: (key: string, body: Record<string, unknown>) => Promise<boolean>;
  busy: string;
}) {
  const [driverId, setDriverId] = useState('');
  const idValid = UUID_RE.test(driverId.trim());

  const run = async (kind: 'invite_driver' | 'uninvite_driver') => {
    const ok = await action(`driver-${kind}`, { action: kind, driverId: driverId.trim() });
    if (ok) setDriverId('');
  };

  const stat = (label: string, value: number | undefined) => (
    <div className="rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-4 py-3">
      <p className="text-2xl font-bold text-[#1d1d1f]">{value != null ? value.toLocaleString('en-US') : '--'}</p>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">{label}</p>
    </div>
  );

  return (
    <Card title="Driver Programs">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {stat('Pet-friendly opted in', stats?.petFriendlyOptIn)}
        {stat('Women program invited', stats?.womenInvited)}
        {stat('Women program enrolled', stats?.womenEnrolled)}
      </div>
      <p className="mb-3 text-[11px] text-[#86868b]">
        Aggregate counts only — no personal data is shown here. Inviting a driver to the women-program sends a
        consent request in the driver app; drivers are enrolled only after they explicitly accept, and they can
        withdraw at any time. Uninviting revokes a pending invite or removes an enrollment.
      </p>
      <div className="flex items-end gap-2">
        <div className="w-80">
          <Field label="Driver ID (UUID)">
            <input
              className={`${inputCls} font-mono`}
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Field>
        </div>
        <SaveButton
          onClick={() => run('invite_driver')}
          loading={busy === 'driver-invite_driver'}
          disabled={!idValid}
        >
          Invite driver
        </SaveButton>
        <GhostButton
          danger
          onClick={() => run('uninvite_driver')}
          loading={busy === 'driver-uninvite_driver'}
          disabled={!idValid}
        >
          Uninvite
        </GhostButton>
      </div>
      {driverId.trim() !== '' && !idValid && (
        <p className="mt-2 text-[11px] text-red-400">Enter a valid driver UUID</p>
      )}
    </Card>
  );
}

// ── Audit card ────────────────────────────────────────────────────────────

function AuditCard({ entries }: { entries: AuditEntry[] }) {
  return (
    <Card title="Recent Changes" badge={<span className="text-[10px] text-[#86868b]">{entries.length}</span>}>
      {entries.length === 0 ? (
        <p className="text-xs text-[#86868b]">No recent changes recorded</p>
      ) : (
        <div className="space-y-1.5">
          {entries.map((e, i) => (
            <div
              key={e.id ?? i}
              className="flex items-center gap-3 rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-3 py-2"
            >
              <span className="text-xs font-medium text-[#1d1d1f]">
                {(e.action ?? 'change').replace(/_/g, ' ')}
              </span>
              {e.entity && <span className="text-[10px] text-[#86868b]">{e.entity.replace(/_/g, ' ')}</span>}
              {(e.actor ?? e.admin_email) && (
                <span className="truncate text-[10px] text-[#86868b]">by {e.actor ?? e.admin_email}</span>
              )}
              <span className="ml-auto whitespace-nowrap text-[10px] text-[#86868b]">{fmtTime(e.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function AdminRidePreferencesPage() {
  const [configs, setConfigs] = useState<PrefConfig[]>([]);
  const [drivers, setDrivers] = useState<DriverStats | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiUnavailable, setApiUnavailable] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/ride-preferences');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setConfigs(Array.isArray(d?.config) ? d.config : []);
      setDrivers(
        d?.driverCounts
          ? {
              petFriendlyOptIn: d.driverCounts.petFriendlyOptIn ?? 0,
              womenInvited: d.driverCounts.womenPreferredInvited ?? 0,
              womenEnrolled: d.driverCounts.womenPreferredEnrolled ?? 0,
            }
          : null
      );
      setAudit(Array.isArray(d?.audit) ? d.audit : null);
      setApiUnavailable(false);
    } catch {
      setApiUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const post = useCallback(
    async (key: string, body: Record<string, unknown>, successText: string) => {
      setBusy(key);
      setNotice(null);
      try {
        const res = await fetch('/api/admin/ride-preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          setNotice({ kind: 'error', text: `Save failed: ${d?.error ?? `HTTP ${res.status}`}` });
          return false;
        }
        await fetchAll();
        setNotice({ kind: 'success', text: successText });
        return true;
      } catch {
        setNotice({ kind: 'error', text: 'Save failed: network error' });
        return false;
      } finally {
        setBusy('');
      }
    },
    [fetchAll]
  );

  const saveConfig: SaveConfig = useCallback(
    // The API takes a flat camelCase upsert body keyed by (preference, stateCode).
    (key, data) =>
      post(
        key,
        {
          preference: data.preference,
          stateCode: data.state_code ?? null,
          enabled: data.enabled,
          fee: data.fee ?? null,
          feeEffectiveFrom: data.fee_effective_from ?? null,
          feeEffectiveTo: data.fee_effective_to ?? null,
          rules: data.rules ?? null,
          copyVersion: data.copy_version ?? null,
          fallbackDefault: data.fallback_default ?? 'any_driver',
        },
        'Configuration saved'
      ),
    [post]
  );

  const driverAction = useCallback(
    (key: string, body: Record<string, unknown>) => post(key, body, 'Driver program updated'),
    [post]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32 text-[#86868b]">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#86868b] border-t-[#1D6AE5] mr-3" />
        Loading ride preferences...
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1d1d1f]">Ride Preferences</h1>
        <p className="text-sm text-[#86868b] mt-1">
          Women Preferred and Pet Friendly ride options — per-market rollout, fees, rules, and driver programs
        </p>
      </div>

      {apiUnavailable && (
        <div className="mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20 px-4 py-3 text-sm text-amber-500">
          The ride-preferences API is not available yet. Configuration shown below is empty and saves will fail
          until the backend endpoint is deployed.
        </div>
      )}

      {notice && (
        <div
          className={`mb-4 rounded-xl px-4 py-3 text-sm border ${
            notice.kind === 'error'
              ? 'bg-red-500/10 border-red-500/20 text-red-400'
              : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="space-y-5">
        <PreferencePanel
          preference="women_preferred"
          title="Women Preferred"
          subtitle="Women and nonbinary riders can prefer women drivers. Availability depends on enrolled drivers in the market."
          configs={configs.filter((c) => c.preference === 'women_preferred')}
          saveConfig={saveConfig}
          busy={busy}
        />
        <PreferencePanel
          preference="pet_friendly"
          title="Pet Friendly"
          subtitle="Riders traveling with pets are matched with opted-in drivers. A per-market fee can apply within its effective window."
          configs={configs.filter((c) => c.preference === 'pet_friendly')}
          saveConfig={saveConfig}
          busy={busy}
        />
        <DriverProgramCard stats={drivers} action={driverAction} busy={busy} />
        {audit && <AuditCard entries={audit} />}
      </div>
    </div>
  );
}
