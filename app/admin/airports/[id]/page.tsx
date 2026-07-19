'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

// ═══════════════════════════════════════════════════════════════════════════
// TAKEME ADMIN — Airport Intelligence: Detail / Editor
// Overview, terminals, service points, airlines, assignments, instructions,
// rules, sources & audit, publish panel.
// ═══════════════════════════════════════════════════════════════════════════

interface Airport {
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
  timezone?: string | null;
  detection_radius_m?: number | null;
  updated_at?: string | null;
}

type SourceJson = { url?: string; name?: string; note?: string } | null;

// Rows are "draft" when verified === false (admin upserts always land verified=false).
interface Publishable {
  verified?: boolean | null;
}

interface Identifier {
  id: string;
  identifier_type: string;
  identifier_value: string;
  source?: SourceJson;
}

interface Terminal extends Publishable {
  id: string;
  code: string | null;
  name: string;
  display_order: number | null;
  lat: number | null;
  lng: number | null;
  active: boolean;
  source?: SourceJson;
}

interface ServicePoint extends Publishable {
  id: string;
  point_type: string;
  name: string;
  lat: number | null;
  lng: number | null;
  terminal_id: string | null;
  level: string | null;
  door: string | null;
  zone: string | null;
  island: string | null;
  accessibility?: string | null;
  restrictions?: string | null;
  hours: { note?: string } | null;
  verified: boolean;
  active: boolean;
  source?: SourceJson;
}

interface AirlineInfo {
  id?: string;
  display_name: string;
  iata_code: string | null;
}

interface AirlineService {
  id: string;
  airline_id?: string | null;
  popularity_rank: number | null;
  active: boolean;
  reporting_period: string | null;
  // Contract names the joined airline `airline`; the Supabase join emits `airlines`.
  airline?: AirlineInfo | null;
  airlines?: AirlineInfo | null;
}

const svcAirline = (s: AirlineService) => s.airline ?? s.airlines ?? null;
const svcAirlineId = (s: AirlineService) => s.airline_id ?? svcAirline(s)?.id ?? null;

interface Assignment extends Publishable {
  id: string;
  airline_id: string | null;
  airlines?: AirlineInfo | null;
  terminal_id: string | null;
  departures_service_point_id: string | null;
  arrivals_service_point_id: string | null;
  effective_from: string | null;
  effective_to: string | null;
  active: boolean;
  source?: SourceJson;
}

interface Instruction {
  id: string;
  audience: string;
  direction: string;
  title: string;
  body: string;
  display_order: number | null;
  active: boolean;
  source?: SourceJson;
}

interface Rule {
  id: string;
  rule_type: string;
  config: Record<string, unknown> | null;
  effective_from: string | null;
  effective_to: string | null;
  active: boolean;
  source?: SourceJson;
}

interface Revision {
  id: string;
  entity_type?: string | null;
  entity_id?: string | null;
  state?: string | null;
  editor?: string | null;
  reviewer?: string | null;
  created_at?: string | null;
  published_at?: string | null;
}

interface ImportRow {
  id: string;
  source: string;
  source_version: string | null;
  effective_date: string | null;
  status: string;
  counts?: Record<string, unknown> | null;
  error_summary?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

interface AirportDetail {
  airport: Airport;
  identifiers: Identifier[];
  terminals: Terminal[];
  service_points: ServicePoint[];
  airline_services: AirlineService[];
  assignments: Assignment[];
  instructions: Instruction[];
  rules: Rule[];
  revisions: Revision[];
  imports: ImportRow[];
}

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

// Enums below match the admin API zod schemas exactly.
const POINT_TYPES = [
  'general_departures_dropoff',
  'airline_departures_dropoff',
  'rideshare_pickup',
  'arrivals_reference',
];

const AUDIENCES = ['rider', 'driver', 'both'];
const DIRECTIONS = ['pickup', 'dropoff'];
const RULE_TYPES = ['airport_fee', 'pickup_wait', 'geofence_rule', 'access_restriction', 'custom'];

type Mutate = (
  key: string,
  entity: string,
  action: 'upsert' | 'deactivate',
  data: Record<string, unknown>
) => Promise<boolean>;

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isDraft(row: Publishable) {
  return row.verified === false;
}

function mergedOptions(base: string[], values: Array<string | null | undefined>) {
  const set = new Set(base);
  for (const v of values) if (v) set.add(v);
  return Array.from(set);
}

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

// ── Page ──────────────────────────────────────────────────────────────────

export default function AdminAirportDetailPage() {
  const params = useParams<{ id: string }>();
  const airportId = params.id;

  const [data, setData] = useState<AirportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  const fetchDetail = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/airports/${airportId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
      setError('');
    } catch {
      setError('Failed to load airport');
    } finally {
      setLoading(false);
    }
  }, [airportId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const mutate: Mutate = useCallback(
    async (key, entity, action, payload) => {
      setBusy(key);
      setNotice(null);
      try {
        const res = await fetch(`/api/admin/airports/${airportId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity, action, data: payload }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          setNotice({ kind: 'error', text: `Save failed: ${d?.error ?? `HTTP ${res.status}`}` });
          return false;
        }
        await fetchDetail();
        setNotice({ kind: 'success', text: 'Saved' });
        return true;
      } catch {
        setNotice({ kind: 'error', text: 'Save failed: network error' });
        return false;
      } finally {
        setBusy('');
      }
    },
    [airportId, fetchDetail]
  );

  // coverage_status is not part of the airport upsert schema — promotions and
  // demotions go through the atomic publish endpoint (DB verified-floor trigger
  // can reject with 409; surface its message verbatim).
  const changeCoverage = useCallback(
    async (status: string): Promise<boolean> => {
      setBusy('coverage-save');
      setNotice(null);
      try {
        const res = await fetch(`/api/admin/airports/${airportId}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coverageStatus: status }),
        });
        const d = await res.json().catch(() => null);
        if (!res.ok || !(d?.published || d?.ok)) {
          setNotice({ kind: 'error', text: d?.error ?? `Coverage change failed: HTTP ${res.status}` });
          return false;
        }
        await fetchDetail();
        setNotice({ kind: 'success', text: `Coverage status set to ${status.replace(/_/g, ' ')}` });
        return true;
      } catch {
        setNotice({ kind: 'error', text: 'Coverage change failed: network error' });
        return false;
      } finally {
        setBusy('');
      }
    },
    [airportId, fetchDetail]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32 text-[#86868b]">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#86868b] border-t-[#1D6AE5] mr-3" />
        Loading airport...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <Link href="/admin/airports" className="text-xs text-[#1D6AE5] hover:underline">
          &larr; Back to airports
        </Link>
        <div className="mt-4 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
          {error || 'Failed to load airport'}
        </div>
      </div>
    );
  }

  const { airport } = data;

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="mb-6">
        <Link href="/admin/airports" className="text-xs text-[#1D6AE5] hover:underline">
          &larr; Back to airports
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-[#1d1d1f]">{airport.display_name}</h1>
          <span className="font-mono text-sm text-[#86868b]">
            {[airport.iata_code, airport.faa_lid].filter(Boolean).join(' / ')}
          </span>
          <span
            className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold capitalize ${
              COVERAGE_CLASSES[airport.coverage_status] ?? 'bg-zinc-500/15 text-[#86868b]'
            }`}
          >
            {airport.coverage_status.replace(/_/g, ' ')}
          </span>
          {!airport.active && (
            <span className="inline-flex rounded-full bg-red-500/15 px-2.5 py-0.5 text-[10px] font-semibold text-red-400">
              inactive
            </span>
          )}
        </div>
        <p className="text-sm text-[#86868b] mt-1">
          {[airport.municipality, airport.state_code].filter(Boolean).join(', ')}
          {airport.service_class ? ` · ${airport.service_class.replace(/_/g, ' ')}` : ''}
          {airport.enplanements != null
            ? ` · ${Number(airport.enplanements).toLocaleString('en-US')} enplanements`
            : ''}
        </p>
      </div>

      {/* Global notice */}
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
        {/* key remounts the form when the airport row changes (e.g. after refetch) */}
        <OverviewCard
          key={`${airport.id}:${airport.updated_at ?? ''}:${airport.coverage_status}`}
          airport={airport}
          identifiers={data.identifiers}
          mutate={mutate}
          changeCoverage={changeCoverage}
          busy={busy}
        />
        <TerminalsCard terminals={data.terminals} mutate={mutate} busy={busy} />
        <ServicePointsCard points={data.service_points} terminals={data.terminals} mutate={mutate} busy={busy} />
        <AirlinesCard services={data.airline_services} mutate={mutate} busy={busy} />
        <AssignmentsCard
          assignments={data.assignments}
          services={data.airline_services}
          terminals={data.terminals}
          points={data.service_points}
          mutate={mutate}
          busy={busy}
        />
        <InstructionsCard instructions={data.instructions} mutate={mutate} busy={busy} />
        <RulesCard rules={data.rules} mutate={mutate} busy={busy} />
        <SourcesAuditCard data={data} />
        <PublishPanel
          airportId={airportId}
          data={data}
          changeCoverage={changeCoverage}
          busy={busy}
          onPublished={fetchDetail}
        />
      </div>
    </div>
  );
}

// ── Shared UI ─────────────────────────────────────────────────────────────

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

const inputCls =
  'rounded-lg border border-[#d2d2d7] bg-[#FFFFFF] px-2.5 py-1.5 text-xs text-[#1d1d1f] placeholder-[#86868b] outline-none focus:border-[#1D6AE5] w-full';

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

function DraftBadge({ row }: { row: Publishable }) {
  if (!isDraft(row)) return null;
  return (
    <span className="inline-flex rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-blue-400">
      draft
    </span>
  );
}

function InactiveBadge({ active }: { active: boolean }) {
  if (active) return null;
  return (
    <span className="inline-flex rounded-full bg-zinc-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-[#86868b]">
      inactive
    </span>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────

function OverviewCard({
  airport,
  identifiers,
  mutate,
  changeCoverage,
  busy,
}: {
  airport: Airport;
  identifiers: Identifier[];
  mutate: Mutate;
  changeCoverage: (status: string) => Promise<boolean>;
  busy: string;
}) {
  const [displayName, setDisplayName] = useState(airport.display_name);
  const [coverage, setCoverage] = useState(airport.coverage_status);
  const [timezone, setTimezone] = useState(airport.timezone ?? '');
  const [radius, setRadius] = useState(airport.detection_radius_m != null ? String(airport.detection_radius_m) : '');
  const [active, setActive] = useState(airport.active);

  const save = async () => {
    const ok = await mutate('airport-save', 'airport', 'upsert', {
      display_name: displayName.trim(),
      timezone: timezone.trim() === '' ? null : timezone.trim(),
      // detection_radius_m is optional but not nullable in the API schema
      ...(radius.trim() !== '' ? { detection_radius_m: Number(radius) } : {}),
      active,
    });
    // Coverage changes go through the publish endpoint, not the upsert.
    if (ok && coverage !== airport.coverage_status) await changeCoverage(coverage);
  };

  return (
    <Card title="Overview">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="col-span-2">
          <Field label="Display name">
            <input className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
        </div>
        <Field label="Coverage status">
          <select className={inputCls} value={coverage} onChange={(e) => setCoverage(e.target.value)}>
            {mergedOptions([...COVERAGE_STATUSES], [airport.coverage_status]).map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timezone">
          <input
            className={inputCls}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/Los_Angeles"
          />
        </Field>
        <Field label="Detection radius (m)">
          <input
            className={inputCls}
            type="number"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            placeholder="e.g. 3000"
          />
        </Field>
        <div className="flex items-end pb-1.5">
          <label className="flex items-center gap-2 text-xs text-[#6e6e73]">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
        </div>
        <div className="flex items-end justify-end col-span-2">
          <SaveButton
            onClick={save}
            loading={busy === 'airport-save' || busy === 'coverage-save'}
            disabled={displayName.trim() === ''}
          >
            Save airport
          </SaveButton>
        </div>
      </div>

      {/* Identifiers */}
      <div className="mt-5 border-t border-[#d2d2d7] pt-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
          Identifiers
        </p>
        {identifiers.length === 0 ? (
          <p className="text-xs text-[#86868b]">No identifiers on record</p>
        ) : (
          <div className="space-y-1.5">
            {identifiers.map((idn) => (
              <div key={idn.id} className="flex items-center justify-between text-xs">
                <span className="text-[#86868b]">{idn.identifier_type.replace(/_/g, ' ')}</span>
                <span className="font-mono text-[11px] text-[#6e6e73] break-all text-right ml-4">
                  {idn.identifier_value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Terminals ─────────────────────────────────────────────────────────────

interface TerminalForm {
  id?: string;
  code: string;
  name: string;
  display_order: string;
  lat: string;
  lng: string;
}

const emptyTerminalForm: TerminalForm = { code: '', name: '', display_order: '', lat: '', lng: '' };

function TerminalsCard({ terminals, mutate, busy }: { terminals: Terminal[]; mutate: Mutate; busy: string }) {
  const [form, setForm] = useState<TerminalForm | null>(null);

  const startEdit = (t: Terminal) =>
    setForm({
      id: t.id,
      code: t.code ?? '',
      name: t.name,
      display_order: t.display_order != null ? String(t.display_order) : '',
      lat: t.lat != null ? String(t.lat) : '',
      lng: t.lng != null ? String(t.lng) : '',
    });

  const save = async () => {
    if (!form) return;
    const ok = await mutate('terminal-save', 'terminal', 'upsert', {
      ...(form.id ? { id: form.id } : {}),
      code: form.code.trim(),
      name: form.name.trim(),
      // display_order is optional but not nullable in the API schema
      ...(form.display_order.trim() !== '' ? { display_order: Number(form.display_order) } : {}),
      lat: numOrNull(form.lat),
      lng: numOrNull(form.lng),
    });
    if (ok) setForm(null);
  };

  const sorted = [...terminals].sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));

  return (
    <Card title="Terminals" badge={<span className="text-[10px] text-[#86868b]">{terminals.length}</span>}>
      {sorted.length === 0 ? (
        <p className="text-xs text-[#86868b] mb-3">No terminals yet</p>
      ) : (
        <div className="space-y-2 mb-3">
          {sorted.map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-3 py-2">
              <span className="font-mono text-[11px] text-[#86868b] w-10">{t.code ?? '--'}</span>
              <span className={`text-xs font-medium ${t.active ? 'text-[#1d1d1f]' : 'text-[#86868b] line-through'}`}>
                {t.name}
              </span>
              <DraftBadge row={t} />
              <InactiveBadge active={t.active} />
              <span className="ml-auto text-[10px] text-[#86868b] font-mono">
                {t.lat != null && t.lng != null ? `${Number(t.lat).toFixed(5)}, ${Number(t.lng).toFixed(5)}` : 'no coords'}
              </span>
              <GhostButton onClick={() => startEdit(t)}>Edit</GhostButton>
              {t.active && (
                <GhostButton
                  danger
                  loading={busy === `terminal-deactivate-${t.id}`}
                  onClick={() => mutate(`terminal-deactivate-${t.id}`, 'terminal', 'deactivate', { id: t.id })}
                >
                  Deactivate
                </GhostButton>
              )}
            </div>
          ))}
        </div>
      )}

      {form ? (
        <div className="rounded-lg border border-[#1D6AE5]/30 bg-[#FFFFFF] p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
            {form.id ? 'Edit terminal' : 'New terminal'}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Field label="Code">
              <input className={inputCls} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label="Name">
                <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
            </div>
            <Field label="Order">
              <input
                className={inputCls}
                type="number"
                value={form.display_order}
                onChange={(e) => setForm({ ...form, display_order: e.target.value })}
              />
            </Field>
            <Field label="Lat">
              <input className={inputCls} type="number" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} />
            </Field>
            <Field label="Lng">
              <input className={inputCls} type="number" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} />
            </Field>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <GhostButton onClick={() => setForm(null)}>Cancel</GhostButton>
            <SaveButton
              onClick={save}
              loading={busy === 'terminal-save'}
              disabled={form.name.trim() === '' || form.code.trim() === ''}
            >
              Save terminal
            </SaveButton>
          </div>
        </div>
      ) : (
        <GhostButton onClick={() => setForm({ ...emptyTerminalForm })}>+ Add terminal</GhostButton>
      )}
    </Card>
  );
}

// ── Service points ────────────────────────────────────────────────────────

interface PointForm {
  id?: string;
  point_type: string;
  name: string;
  lat: string;
  lng: string;
  terminal_id: string;
  level: string;
  door: string;
  zone: string;
  island: string;
  accessibility: string;
  restrictions: string;
  hours_note: string;
}

const emptyPointForm: PointForm = {
  point_type: 'rideshare_pickup',
  name: '',
  lat: '',
  lng: '',
  terminal_id: '',
  level: '',
  door: '',
  zone: '',
  island: '',
  accessibility: '',
  restrictions: '',
  hours_note: '',
};

function ServicePointsCard({
  points,
  terminals,
  mutate,
  busy,
}: {
  points: ServicePoint[];
  terminals: Terminal[];
  mutate: Mutate;
  busy: string;
}) {
  const [form, setForm] = useState<PointForm | null>(null);

  const terminalName = (id: string | null) => terminals.find((t) => t.id === id)?.name ?? null;

  const startEdit = (p: ServicePoint) =>
    setForm({
      id: p.id,
      point_type: p.point_type,
      name: p.name,
      lat: p.lat != null ? String(p.lat) : '',
      lng: p.lng != null ? String(p.lng) : '',
      terminal_id: p.terminal_id ?? '',
      level: p.level ?? '',
      door: p.door ?? '',
      zone: p.zone ?? '',
      island: p.island ?? '',
      accessibility: p.accessibility ?? '',
      restrictions: p.restrictions ?? '',
      hours_note: p.hours?.note ?? '',
    });

  const save = async () => {
    if (!form) return;
    const ok = await mutate('point-save', 'service_point', 'upsert', {
      ...(form.id ? { id: form.id } : {}),
      point_type: form.point_type,
      name: form.name.trim(),
      // lat/lng are required by the API schema (form disables save until set)
      lat: Number(form.lat),
      lng: Number(form.lng),
      terminal_id: form.terminal_id || null,
      level: form.level.trim() || null,
      door: form.door.trim() || null,
      zone: form.zone.trim() || null,
      island: form.island.trim() || null,
      accessibility: form.accessibility.trim() || null,
      restrictions: form.restrictions.trim() || null,
      // hours is jsonb on the backend; the free-text note lives at hours.note
      hours: form.hours_note.trim() ? { note: form.hours_note.trim() } : null,
    });
    if (ok) setForm(null);
  };

  const types = mergedOptions(POINT_TYPES, points.map((p) => p.point_type));
  const grouped = types
    .map((type) => ({ type, items: points.filter((p) => p.point_type === type) }))
    .filter((g) => g.items.length > 0);

  return (
    <Card title="Service Points" badge={<span className="text-[10px] text-[#86868b]">{points.length}</span>}>
      {grouped.length === 0 ? (
        <p className="text-xs text-[#86868b] mb-3">No service points yet</p>
      ) : (
        <div className="space-y-4 mb-3">
          {grouped.map((g) => (
            <div key={g.type}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
                {g.type.replace(/_/g, ' ')}
              </p>
              <div className="space-y-2">
                {g.items.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium ${p.active ? 'text-[#1d1d1f]' : 'text-[#86868b] line-through'}`}>
                          {p.name}
                        </span>
                        {p.verified && (
                          <span className="inline-flex rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-500">
                            verified
                          </span>
                        )}
                        <DraftBadge row={p} />
                        <InactiveBadge active={p.active} />
                      </div>
                      <p className="mt-0.5 text-[10px] text-[#86868b] truncate">
                        {[
                          terminalName(p.terminal_id),
                          p.level && `Level ${p.level}`,
                          p.door && `Door ${p.door}`,
                          p.zone && `Zone ${p.zone}`,
                          p.island && `Island ${p.island}`,
                          p.accessibility,
                          p.restrictions,
                          p.hours?.note,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'No placement details'}
                      </p>
                    </div>
                    <span className="ml-auto text-[10px] text-[#86868b] font-mono whitespace-nowrap">
                      {p.lat != null && p.lng != null
                        ? `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}`
                        : 'no coords'}
                    </span>
                    <GhostButton onClick={() => startEdit(p)}>Edit</GhostButton>
                    {p.active && (
                      <GhostButton
                        danger
                        loading={busy === `point-deactivate-${p.id}`}
                        onClick={() => mutate(`point-deactivate-${p.id}`, 'service_point', 'deactivate', { id: p.id })}
                      >
                        Deactivate
                      </GhostButton>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {form ? (
        <div className="rounded-lg border border-[#1D6AE5]/30 bg-[#FFFFFF] p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
            {form.id ? 'Edit service point' : 'New service point'}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Field label="Type">
              <select
                className={inputCls}
                value={form.point_type}
                onChange={(e) => setForm({ ...form, point_type: e.target.value })}
              >
                {mergedOptions(POINT_TYPES, [form.point_type]).map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Lat">
              <input className={inputCls} type="number" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} />
            </Field>
            <Field label="Lng">
              <input className={inputCls} type="number" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} />
            </Field>
            <Field label="Terminal">
              <select
                className={inputCls}
                value={form.terminal_id}
                onChange={(e) => setForm({ ...form, terminal_id: e.target.value })}
              >
                <option value="">No terminal</option>
                {terminals.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Level">
              <input className={inputCls} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} />
            </Field>
            <Field label="Door">
              <input className={inputCls} value={form.door} onChange={(e) => setForm({ ...form, door: e.target.value })} />
            </Field>
            <Field label="Zone">
              <input className={inputCls} value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} />
            </Field>
            <Field label="Island">
              <input className={inputCls} value={form.island} onChange={(e) => setForm({ ...form, island: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label="Accessibility">
                <input
                  className={inputCls}
                  value={form.accessibility}
                  onChange={(e) => setForm({ ...form, accessibility: e.target.value })}
                  placeholder="e.g. Elevator to level 3"
                />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="Restrictions">
                <input
                  className={inputCls}
                  value={form.restrictions}
                  onChange={(e) => setForm({ ...form, restrictions: e.target.value })}
                  placeholder="e.g. No waiting over 2 min"
                />
              </Field>
            </div>
            <div className="col-span-2 md:col-span-4">
              <Field label="Hours note">
                <input
                  className={inputCls}
                  value={form.hours_note}
                  onChange={(e) => setForm({ ...form, hours_note: e.target.value })}
                  placeholder="e.g. Closed 1am-4am"
                />
              </Field>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <GhostButton onClick={() => setForm(null)}>Cancel</GhostButton>
            <SaveButton
              onClick={save}
              loading={busy === 'point-save'}
              disabled={
                form.name.trim() === '' ||
                form.lat.trim() === '' ||
                form.lng.trim() === '' ||
                Number.isNaN(Number(form.lat)) ||
                Number.isNaN(Number(form.lng))
              }
            >
              Save point
            </SaveButton>
          </div>
        </div>
      ) : (
        <GhostButton onClick={() => setForm({ ...emptyPointForm })}>+ Add service point</GhostButton>
      )}
    </Card>
  );
}

// ── Airlines & popularity ─────────────────────────────────────────────────

function AirlinesCard({ services, mutate, busy }: { services: AirlineService[]; mutate: Mutate; busy: string }) {
  const [iata, setIata] = useState('');
  const [rank, setRank] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState('');

  // The upsert schema wants airline_id, so resolve the IATA code first.
  const add = async () => {
    const code = iata.trim().toUpperCase();
    setLookupError('');
    setLooking(true);
    let airlineId: string | null = null;
    try {
      const res = await fetch(`/api/airlines?q=${encodeURIComponent(code)}`);
      const d = await res.json().catch(() => null);
      const match = ((d?.airlines ?? []) as AirlineInfo[]).find(
        (a) => a.iata_code?.toUpperCase() === code
      );
      if (!match?.id) {
        setLookupError(`No active airline found with IATA code ${code}`);
        return;
      }
      airlineId = match.id;
    } catch {
      setLookupError('Airline lookup failed');
      return;
    } finally {
      setLooking(false);
    }

    const ok = await mutate('airline-add', 'airline_service', 'upsert', {
      airline_id: airlineId,
      popularity_rank: numOrNull(rank),
    });
    if (ok) {
      setIata('');
      setRank('');
    }
  };

  const ranked = [...services].sort((a, b) => (a.popularity_rank ?? 999) - (b.popularity_rank ?? 999));

  return (
    <Card title="Airlines & Popularity" badge={<span className="text-[10px] text-[#86868b]">{services.length}</span>}>
      {ranked.length === 0 ? (
        <p className="text-xs text-[#86868b] mb-3">No airline services recorded</p>
      ) : (
        <div className="space-y-1.5 mb-4">
          {ranked.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-3 py-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#d2d2d7]/60 text-[10px] font-bold text-[#6e6e73]">
                {s.popularity_rank ?? '--'}
              </span>
              <span className={`text-xs font-medium ${s.active ? 'text-[#1d1d1f]' : 'text-[#86868b] line-through'}`}>
                {svcAirline(s)?.display_name ?? 'Unknown airline'}
              </span>
              <span className="font-mono text-[11px] text-[#86868b]">{svcAirline(s)?.iata_code ?? '--'}</span>
              <InactiveBadge active={s.active} />
              <span className="ml-auto text-[10px] text-[#86868b]">
                {s.reporting_period ? `period ${s.reporting_period}` : ''}
              </span>
              {s.active && (
                <GhostButton
                  danger
                  loading={busy === `airline-deactivate-${s.id}`}
                  onClick={() => mutate(`airline-deactivate-${s.id}`, 'airline_service', 'deactivate', { id: s.id })}
                >
                  Deactivate
                </GhostButton>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="w-28">
          <Field label="Airline IATA">
            <input
              className={inputCls}
              value={iata}
              onChange={(e) => setIata(e.target.value.toUpperCase())}
              placeholder="e.g. AS"
              maxLength={3}
            />
          </Field>
        </div>
        <div className="w-24">
          <Field label="Rank">
            <input className={inputCls} type="number" value={rank} onChange={(e) => setRank(e.target.value)} placeholder="1" />
          </Field>
        </div>
        <SaveButton onClick={add} loading={looking || busy === 'airline-add'} disabled={iata.trim().length < 2}>
          Add airline
        </SaveButton>
      </div>
      {lookupError && <p className="mt-2 text-[11px] text-red-400">{lookupError}</p>}
    </Card>
  );
}

// ── Assignments ───────────────────────────────────────────────────────────

interface AssignmentForm {
  id?: string;
  airline_id: string;
  terminal_id: string;
  departures_service_point_id: string;
  arrivals_service_point_id: string;
  effective_from: string;
  effective_to: string;
}

const emptyAssignmentForm: AssignmentForm = {
  airline_id: '',
  terminal_id: '',
  departures_service_point_id: '',
  arrivals_service_point_id: '',
  effective_from: '',
  effective_to: '',
};

function AssignmentsCard({
  assignments,
  services,
  terminals,
  points,
  mutate,
  busy,
}: {
  assignments: Assignment[];
  services: AirlineService[];
  terminals: Terminal[];
  points: ServicePoint[];
  mutate: Mutate;
  busy: string;
}) {
  const [form, setForm] = useState<AssignmentForm | null>(null);

  const airlineName = (a: Assignment) => {
    // Assignment rows carry the joined airline; fall back to the services list.
    const joined = a.airlines ?? svcAirline(services.find((s) => svcAirlineId(s) === a.airline_id) ?? ({} as AirlineService));
    return joined ? `${joined.display_name} (${joined.iata_code ?? '--'})` : 'Unknown airline';
  };
  const terminalName = (id: string | null) => terminals.find((t) => t.id === id)?.name ?? '--';
  const pointName = (id: string | null) => points.find((p) => p.id === id)?.name ?? '--';

  const startEdit = (a: Assignment) =>
    setForm({
      id: a.id,
      airline_id: a.airline_id ?? '',
      terminal_id: a.terminal_id ?? '',
      departures_service_point_id: a.departures_service_point_id ?? '',
      arrivals_service_point_id: a.arrivals_service_point_id ?? '',
      effective_from: a.effective_from?.slice(0, 10) ?? '',
      effective_to: a.effective_to?.slice(0, 10) ?? '',
    });

  const save = async () => {
    if (!form) return;
    const ok = await mutate('assignment-save', 'assignment', 'upsert', {
      ...(form.id ? { id: form.id } : {}),
      airline_id: form.airline_id || null,
      terminal_id: form.terminal_id || null,
      departures_service_point_id: form.departures_service_point_id || null,
      arrivals_service_point_id: form.arrivals_service_point_id || null,
      effective_from: form.effective_from || null,
      effective_to: form.effective_to || null,
    });
    if (ok) setForm(null);
  };

  return (
    <Card title="Assignments" badge={<span className="text-[10px] text-[#86868b]">{assignments.length}</span>}>
      {assignments.length === 0 ? (
        <p className="text-xs text-[#86868b] mb-3">No airline-terminal assignments yet</p>
      ) : (
        <div className="space-y-2 mb-3">
          {assignments.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${a.active ? 'text-[#1d1d1f]' : 'text-[#86868b] line-through'}`}>
                    {airlineName(a)}
                  </span>
                  <span className="text-[10px] text-[#86868b]">&rarr; {terminalName(a.terminal_id)}</span>
                  <DraftBadge row={a} />
                  <InactiveBadge active={a.active} />
                </div>
                <p className="mt-0.5 text-[10px] text-[#86868b] truncate">
                  Departures: {pointName(a.departures_service_point_id)} · Arrivals: {pointName(a.arrivals_service_point_id)}
                  {(a.effective_from || a.effective_to) &&
                    ` · ${a.effective_from?.slice(0, 10) ?? '...'} → ${a.effective_to?.slice(0, 10) ?? 'open'}`}
                </p>
              </div>
              <div className="ml-auto flex gap-2">
                <GhostButton onClick={() => startEdit(a)}>Edit</GhostButton>
                {a.active && (
                  <GhostButton
                    danger
                    loading={busy === `assignment-deactivate-${a.id}`}
                    onClick={() => mutate(`assignment-deactivate-${a.id}`, 'assignment', 'deactivate', { id: a.id })}
                  >
                    Deactivate
                  </GhostButton>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {form ? (
        <div className="rounded-lg border border-[#1D6AE5]/30 bg-[#FFFFFF] p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
            {form.id ? 'Edit assignment' : 'New assignment'}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <Field label="Airline">
              <select
                className={inputCls}
                value={form.airline_id}
                onChange={(e) => setForm({ ...form, airline_id: e.target.value })}
              >
                <option value="">Select airline...</option>
                {services
                  .filter((s) => svcAirlineId(s))
                  .map((s) => (
                    <option key={s.id} value={svcAirlineId(s) ?? ''}>
                      {svcAirline(s)?.display_name ?? 'Unknown'} ({svcAirline(s)?.iata_code ?? '--'})
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Terminal">
              <select
                className={inputCls}
                value={form.terminal_id}
                onChange={(e) => setForm({ ...form, terminal_id: e.target.value })}
              >
                <option value="">Select terminal...</option>
                {terminals.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="hidden md:block" />
            <Field label="Departures point">
              <select
                className={inputCls}
                value={form.departures_service_point_id}
                onChange={(e) => setForm({ ...form, departures_service_point_id: e.target.value })}
              >
                <option value="">Select point...</option>
                {points.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.point_type.replace(/_/g, ' ')})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Arrivals point">
              <select
                className={inputCls}
                value={form.arrivals_service_point_id}
                onChange={(e) => setForm({ ...form, arrivals_service_point_id: e.target.value })}
              >
                <option value="">Select point...</option>
                {points.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.point_type.replace(/_/g, ' ')})
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex gap-2">
              <Field label="Effective from">
                <input
                  className={inputCls}
                  type="date"
                  value={form.effective_from}
                  onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
                />
              </Field>
              <Field label="Effective to">
                <input
                  className={inputCls}
                  type="date"
                  value={form.effective_to}
                  onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <GhostButton onClick={() => setForm(null)}>Cancel</GhostButton>
            <SaveButton
              onClick={save}
              loading={busy === 'assignment-save'}
              disabled={form.airline_id === '' || form.terminal_id === ''}
            >
              Save assignment
            </SaveButton>
          </div>
        </div>
      ) : (
        <GhostButton onClick={() => setForm({ ...emptyAssignmentForm })}>+ Add assignment</GhostButton>
      )}
    </Card>
  );
}

// ── Instructions ──────────────────────────────────────────────────────────

interface InstructionForm {
  id?: string;
  audience: string;
  direction: string;
  title: string;
  body: string;
  display_order: string;
}

const emptyInstructionForm: InstructionForm = {
  audience: 'rider',
  direction: 'pickup',
  title: '',
  body: '',
  display_order: '',
};

function InstructionsCard({ instructions, mutate, busy }: { instructions: Instruction[]; mutate: Mutate; busy: string }) {
  const [form, setForm] = useState<InstructionForm | null>(null);

  const startEdit = (i: Instruction) =>
    setForm({
      id: i.id,
      audience: i.audience,
      direction: i.direction,
      title: i.title,
      body: i.body,
      display_order: i.display_order != null ? String(i.display_order) : '',
    });

  const save = async () => {
    if (!form) return;
    const ok = await mutate('instruction-save', 'instruction', 'upsert', {
      ...(form.id ? { id: form.id } : {}),
      audience: form.audience,
      direction: form.direction,
      title: form.title.trim(),
      body: form.body.trim(),
      // display_order is optional but not nullable in the API schema
      ...(form.display_order.trim() !== '' ? { display_order: Number(form.display_order) } : {}),
    });
    if (ok) setForm(null);
  };

  const sorted = [...instructions].sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));

  return (
    <Card title="Instructions" badge={<span className="text-[10px] text-[#86868b]">{instructions.length}</span>}>
      {sorted.length === 0 ? (
        <p className="text-xs text-[#86868b] mb-3">No instructions yet</p>
      ) : (
        <div className="space-y-2 mb-3">
          {sorted.map((i) => (
            <div key={i.id} className="rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full bg-[#d2d2d7]/60 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#6e6e73]">
                  {i.audience}
                </span>
                <span className="inline-flex rounded-full bg-[#d2d2d7]/60 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#6e6e73]">
                  {i.direction}
                </span>
                <span className={`text-xs font-medium ${i.active ? 'text-[#1d1d1f]' : 'text-[#86868b] line-through'}`}>
                  {i.title}
                </span>
                <InactiveBadge active={i.active} />
                <div className="ml-auto flex gap-2">
                  <GhostButton onClick={() => startEdit(i)}>Edit</GhostButton>
                  {i.active && (
                    <GhostButton
                      danger
                      loading={busy === `instruction-deactivate-${i.id}`}
                      onClick={() => mutate(`instruction-deactivate-${i.id}`, 'instruction', 'deactivate', { id: i.id })}
                    >
                      Deactivate
                    </GhostButton>
                  )}
                </div>
              </div>
              <p className="mt-1 text-[11px] text-[#6e6e73] whitespace-pre-wrap">{i.body}</p>
            </div>
          ))}
        </div>
      )}

      {form ? (
        <div className="rounded-lg border border-[#1D6AE5]/30 bg-[#FFFFFF] p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
            {form.id ? 'Edit instruction' : 'New instruction'}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Field label="Audience">
              <select
                className={inputCls}
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
              >
                {mergedOptions(AUDIENCES, [form.audience]).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Direction">
              <select
                className={inputCls}
                value={form.direction}
                onChange={(e) => setForm({ ...form, direction: e.target.value })}
              >
                {mergedOptions(DIRECTIONS, [form.direction]).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Title">
              <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Order">
              <input
                className={inputCls}
                type="number"
                value={form.display_order}
                onChange={(e) => setForm({ ...form, display_order: e.target.value })}
              />
            </Field>
            <div className="col-span-2 md:col-span-4">
              <Field label="Body">
                <textarea
                  className={`${inputCls} min-h-[80px] font-normal`}
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <GhostButton onClick={() => setForm(null)}>Cancel</GhostButton>
            <SaveButton
              onClick={save}
              loading={busy === 'instruction-save'}
              disabled={form.title.trim() === '' || form.body.trim() === ''}
            >
              Save instruction
            </SaveButton>
          </div>
        </div>
      ) : (
        <GhostButton onClick={() => setForm({ ...emptyInstructionForm })}>+ Add instruction</GhostButton>
      )}
    </Card>
  );
}

// ── Rules & fees ──────────────────────────────────────────────────────────

interface RuleForm {
  id?: string;
  rule_type: string;
  config: string;
  effective_from: string;
  effective_to: string;
}

const emptyRuleForm: RuleForm = {
  rule_type: 'airport_fee',
  // airport_fee config shape enforced server-side: {amount, currency, direction}
  config: '{\n  "amount": 0,\n  "currency": "USD",\n  "direction": "both"\n}',
  effective_from: '',
  effective_to: '',
};

function RulesCard({ rules, mutate, busy }: { rules: Rule[]; mutate: Mutate; busy: string }) {
  const [form, setForm] = useState<RuleForm | null>(null);

  const jsonError = (() => {
    if (!form) return null;
    try {
      JSON.parse(form.config);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid JSON';
    }
  })();

  const startEdit = (r: Rule) =>
    setForm({
      id: r.id,
      rule_type: r.rule_type,
      config: JSON.stringify(r.config ?? {}, null, 2),
      effective_from: r.effective_from?.slice(0, 10) ?? '',
      effective_to: r.effective_to?.slice(0, 10) ?? '',
    });

  const save = async () => {
    if (!form || jsonError) return;
    const ok = await mutate('rule-save', 'rule', 'upsert', {
      ...(form.id ? { id: form.id } : {}),
      rule_type: form.rule_type,
      config: JSON.parse(form.config),
      effective_from: form.effective_from || null,
      effective_to: form.effective_to || null,
    });
    if (ok) setForm(null);
  };

  return (
    <Card title="Rules & Fees" badge={<span className="text-[10px] text-[#86868b]">{rules.length}</span>}>
      {rules.length === 0 ? (
        <p className="text-xs text-[#86868b] mb-3">No rules configured</p>
      ) : (
        <div className="space-y-2 mb-3">
          {rules.map((r) => (
            <div key={r.id} className="rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full bg-[#d2d2d7]/60 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#6e6e73]">
                  {r.rule_type.replace(/_/g, ' ')}
                </span>
                <InactiveBadge active={r.active} />
                {(r.effective_from || r.effective_to) && (
                  <span className="text-[10px] text-[#86868b]">
                    {r.effective_from?.slice(0, 10) ?? '...'} &rarr; {r.effective_to?.slice(0, 10) ?? 'open'}
                  </span>
                )}
                <div className="ml-auto flex gap-2">
                  <GhostButton onClick={() => startEdit(r)}>Edit</GhostButton>
                  {r.active && (
                    <GhostButton
                      danger
                      loading={busy === `rule-deactivate-${r.id}`}
                      onClick={() => mutate(`rule-deactivate-${r.id}`, 'rule', 'deactivate', { id: r.id })}
                    >
                      Deactivate
                    </GhostButton>
                  )}
                </div>
              </div>
              <pre className="mt-1.5 overflow-x-auto rounded-lg bg-[#f5f5f7] p-2 text-[10px] font-mono text-[#86868b]">
                {JSON.stringify(r.config ?? {}, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {form ? (
        <div className="rounded-lg border border-[#1D6AE5]/30 bg-[#FFFFFF] p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
            {form.id ? 'Edit rule' : 'New rule'}
          </p>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Rule type">
              <select
                className={inputCls}
                value={form.rule_type}
                onChange={(e) => setForm({ ...form, rule_type: e.target.value })}
              >
                {mergedOptions(RULE_TYPES, [form.rule_type]).map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Effective from">
              <input
                className={inputCls}
                type="date"
                value={form.effective_from}
                onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
              />
            </Field>
            <Field label="Effective to">
              <input
                className={inputCls}
                type="date"
                value={form.effective_to}
                onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
              />
            </Field>
            <div className="col-span-3">
              <Field label="Config (JSON)">
                <textarea
                  className={`${inputCls} min-h-[120px] font-mono ${jsonError ? 'border-red-400' : ''}`}
                  value={form.config}
                  onChange={(e) => setForm({ ...form, config: e.target.value })}
                  spellCheck={false}
                />
              </Field>
              {jsonError && <p className="mt-1 text-[11px] text-red-400">Invalid JSON: {jsonError}</p>}
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <GhostButton onClick={() => setForm(null)}>Cancel</GhostButton>
            <SaveButton onClick={save} loading={busy === 'rule-save'} disabled={!!jsonError}>
              Save rule
            </SaveButton>
          </div>
        </div>
      ) : (
        <GhostButton onClick={() => setForm({ ...emptyRuleForm })}>+ Add rule</GhostButton>
      )}
    </Card>
  );
}

// ── Sources & audit ───────────────────────────────────────────────────────

function SourcesAuditCard({ data }: { data: AirportDetail }) {
  const sourceRows: Array<{ label: string; source: SourceJson }> = [
    ...data.identifiers.map((i) => ({ label: `Identifier · ${i.identifier_type}`, source: i.source ?? null })),
    ...data.terminals.map((t) => ({ label: `Terminal · ${t.name}`, source: t.source ?? null })),
    ...data.service_points.map((p) => ({ label: `Point · ${p.name}`, source: p.source ?? null })),
    ...data.assignments.map((a) => ({ label: `Assignment · ${a.id.slice(0, 8)}`, source: a.source ?? null })),
    ...data.instructions.map((i) => ({ label: `Instruction · ${i.title}`, source: i.source ?? null })),
    ...data.rules.map((r) => ({ label: `Rule · ${r.rule_type}`, source: r.source ?? null })),
  ].filter((r) => r.source && (r.source.url || r.source.name));

  return (
    <Card title="Sources & Audit">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">Sources</p>
      {sourceRows.length === 0 ? (
        <p className="text-xs text-[#86868b] mb-4">No source references recorded</p>
      ) : (
        <div className="space-y-1.5 mb-4">
          {sourceRows.map((r, i) => (
            <div key={i} className="flex items-center justify-between text-xs gap-4">
              <span className="text-[#86868b] truncate">{r.label}</span>
              {r.source?.url ? (
                <a
                  href={r.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#1D6AE5] hover:underline truncate max-w-[50%]"
                >
                  {r.source.name ?? r.source.url}
                </a>
              ) : (
                <span className="text-[#6e6e73] truncate max-w-[50%]">{r.source?.name}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
        Revision history
      </p>
      {data.revisions.length === 0 ? (
        <p className="text-xs text-[#86868b] mb-4">No revisions recorded</p>
      ) : (
        <div className="overflow-x-auto mb-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#d2d2d7]">
                {['Entity', 'State', 'Editor', 'Reviewer', 'Time'].map((h) => (
                  <th key={h} className="pb-2 text-left text-[10px] font-semibold text-[#86868b] uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.revisions.map((r) => (
                <tr key={r.id} className="border-b border-[#d2d2d7]/30">
                  <td className="py-2 text-[#6e6e73]">{r.entity_type ?? '--'}</td>
                  <td className="py-2 text-[#6e6e73]">{r.state ?? '--'}</td>
                  <td className="py-2 text-[#86868b] max-w-[180px] truncate">{r.editor ?? '--'}</td>
                  <td className="py-2 text-[#86868b] max-w-[180px] truncate">{r.reviewer ?? '--'}</td>
                  <td className="py-2 text-[#86868b] whitespace-nowrap">{fmtTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">
        Recent imports touching this airport
      </p>
      {data.imports.length === 0 ? (
        <p className="text-xs text-[#86868b]">No imports recorded</p>
      ) : (
        <div className="space-y-1.5">
          {data.imports.map((imp) => (
            <div key={imp.id} className="flex items-center justify-between text-xs">
              <span className="text-[#6e6e73]">
                {imp.source}
                {imp.source_version ? ` ${imp.source_version}` : ''}
              </span>
              <span className={`${imp.status === 'failed' ? 'text-red-400' : 'text-[#86868b]'}`}>
                {imp.status} · {fmtTime(imp.finished_at ?? imp.started_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Publish panel ─────────────────────────────────────────────────────────

function PublishPanel({
  airportId,
  data,
  changeCoverage,
  busy,
  onPublished,
}: {
  airportId: string;
  data: AirportDetail;
  changeCoverage: (status: string) => Promise<boolean>;
  busy: string;
  onPublished: () => Promise<void> | void;
}) {
  const [selTerminals, setSelTerminals] = useState<Set<string>>(new Set());
  const [selPoints, setSelPoints] = useState<Set<string>>(new Set());
  const [selAssignments, setSelAssignments] = useState<Set<string>>(new Set());
  const [promotion, setPromotion] = useState('');
  const [note, setNote] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [summary, setSummary] = useState<unknown>(null);

  // Preselect unverified active rows (drafts) whenever data refreshes.
  useEffect(() => {
    setSelTerminals(new Set(data.terminals.filter((t) => t.active && isDraft(t)).map((t) => t.id)));
    setSelPoints(new Set(data.service_points.filter((p) => p.active && isDraft(p)).map((p) => p.id)));
    setSelAssignments(new Set(data.assignments.filter((a) => a.active && isDraft(a)).map((a) => a.id)));
  }, [data]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const selectedCount = selTerminals.size + selPoints.size + selAssignments.size;

  const publish = async () => {
    const parts = [
      selTerminals.size && `${selTerminals.size} terminal(s)`,
      selPoints.size && `${selPoints.size} service point(s)`,
      selAssignments.size && `${selAssignments.size} assignment(s)`,
      promotion && `coverage → ${promotion.replace(/_/g, ' ')}`,
    ]
      .filter(Boolean)
      .join(', ');
    if (!window.confirm(`Publish ${parts || 'nothing selected'} for ${data.airport.display_name}?`)) return;

    setPublishing(true);
    setPublishError('');
    setSummary(null);
    try {
      const body: Record<string, unknown> = {};
      if (selTerminals.size) body.terminalIds = Array.from(selTerminals);
      if (selPoints.size) body.servicePointIds = Array.from(selPoints);
      if (selAssignments.size) body.assignmentIds = Array.from(selAssignments);
      if (promotion) body.coverageStatus = promotion;
      if (note.trim()) body.note = note.trim();

      const res = await fetch(`/api/admin/airports/${airportId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !(d?.published || d?.ok)) {
        // 409 = DB verified-floor trigger blocked the coverage promotion; show its text verbatim.
        setPublishError(d?.error ?? `Publish failed: HTTP ${res.status}`);
        return;
      }
      setSummary(d.summary ?? null);
      setNote('');
      setPromotion('');
      await onPublished();
    } catch {
      setPublishError('Publish failed: network error');
    } finally {
      setPublishing(false);
    }
  };

  const disabled = data.airport.coverage_status === 'temporarily_disabled';

  const toggleDisabled = () => {
    const target = disabled ? 'curated' : 'temporarily_disabled';
    if (
      !window.confirm(
        disabled
          ? `Re-enable ${data.airport.display_name}? Coverage will be set back to curated.`
          : `Temporarily disable ${data.airport.display_name}? Riders will not be offered airport coverage.`
      )
    )
      return;
    // Coverage transitions go through the publish endpoint.
    changeCoverage(target);
  };

  return (
    <Card title="Publish">
      {disabled && (
        <div className="mb-3 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
          This airport is temporarily disabled.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <PublishGroup
          title="Terminals"
          items={data.terminals.map((t) => ({ id: t.id, label: t.name, draft: isDraft(t), active: t.active }))}
          selected={selTerminals}
          onToggle={(id) => toggle(selTerminals, setSelTerminals, id)}
        />
        <PublishGroup
          title="Service points"
          items={data.service_points.map((p) => ({ id: p.id, label: p.name, draft: isDraft(p), active: p.active }))}
          selected={selPoints}
          onToggle={(id) => toggle(selPoints, setSelPoints, id)}
        />
        <PublishGroup
          title="Assignments"
          items={data.assignments.map((a) => ({ id: a.id, label: a.id.slice(0, 8), draft: isDraft(a), active: a.active }))}
          selected={selAssignments}
          onToggle={(id) => toggle(selAssignments, setSelAssignments, id)}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="w-52">
          <Field label="Promote coverage status (optional)">
            <select className={inputCls} value={promotion} onChange={(e) => setPromotion(e.target.value)}>
              <option value="">No change</option>
              {COVERAGE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex-1 min-w-[200px]">
          <Field label="Note (optional)">
            <input
              className={inputCls}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this publish?"
            />
          </Field>
        </div>
        <button
          onClick={publish}
          disabled={publishing || (selectedCount === 0 && !promotion)}
          className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#1D6AE5] text-white hover:bg-[#1D6AE5]/90 transition-colors disabled:opacity-50"
        >
          {publishing ? 'Publishing...' : `Publish${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
        </button>
      </div>

      {publishError && (
        <div className="mt-3 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
          {publishError}
        </div>
      )}

      {summary != null && (
        <div className="mt-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-600">
          <p className="font-medium mb-1">Published</p>
          {typeof summary === 'string' ? (
            <p className="text-xs">{summary}</p>
          ) : (
            <pre className="text-[10px] font-mono overflow-x-auto">{JSON.stringify(summary, null, 2)}</pre>
          )}
        </div>
      )}

      <div className="mt-5 border-t border-[#d2d2d7] pt-4 flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-[#1d1d1f]">
            {disabled ? 'Re-enable airport' : 'Temporarily disable airport'}
          </p>
          <p className="text-[10px] text-[#86868b] mt-0.5">
            {disabled
              ? 'Restores coverage status to curated.'
              : 'Sets coverage status to temporarily disabled without losing any data.'}
          </p>
        </div>
        <GhostButton danger={!disabled} loading={busy === 'coverage-save'} onClick={toggleDisabled}>
          {disabled ? 'Re-enable' : 'Disable'}
        </GhostButton>
      </div>
    </Card>
  );
}

function PublishGroup({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: Array<{ id: string; label: string; draft: boolean; active: boolean }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="rounded-lg bg-[#FFFFFF] border border-[#d2d2d7]/60 p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#86868b]">{title}</p>
      {items.length === 0 ? (
        <p className="text-[11px] text-[#86868b]">None</p>
      ) : (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {items.map((item) => (
            <label key={item.id} className="flex items-center gap-2 text-[11px] text-[#6e6e73] cursor-pointer">
              <input type="checkbox" checked={selected.has(item.id)} onChange={() => onToggle(item.id)} />
              <span className={item.active ? '' : 'line-through text-[#86868b]'}>{item.label}</span>
              {item.draft && (
                <span className="inline-flex rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-blue-400">
                  draft
                </span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
