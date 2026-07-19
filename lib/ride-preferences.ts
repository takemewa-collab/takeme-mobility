// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Ride Preferences (Women Preferred + Pet Friendly)
//
// Config-driven, server-enforced. The client only ever sends boolean intent;
// availability, fees, copy and matching behavior all come from
// ride_preference_config (state row overrides the NULL-state default row).
//
// SERVICE ANIMALS: service animals are NOT a preference and NEVER carry a
// fee. No code path in this module (or its callers) may charge the pet fee
// unless the rider explicitly selected petFriendly.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TTLCache } from './cache';

// ── Types ────────────────────────────────────────────────────────────────

export type PreferenceKind = 'women_preferred' | 'pet_friendly';
export type PreferenceFallback = 'keep_looking' | 'any_driver';

export interface PreferenceConfigRow {
  preference: PreferenceKind;
  state_code: string | null;
  enabled: boolean;
  fee: number | null;
  fee_effective_from: string | null;
  fee_effective_to: string | null;
  rules: Record<string, unknown>;
  copy_version: string | null;
  fallback_default: PreferenceFallback;
}

export interface ResolvedPreferenceConfig {
  womenPreferred: PreferenceConfigRow | null;
  petFriendly: PreferenceConfigRow | null;
}

/**
 * What the client is allowed to send. `.strict()` — unknown keys are
 * rejected, never silently dropped.
 */
export const ridePreferencesSchema = z
  .object({
    womenPreferred: z.boolean().optional(),
    petFriendly: z.boolean().optional(),
    fallback: z.enum(['keep_looking', 'any_driver']).optional(),
  })
  .strict();

export type RidePreferencesInput = z.infer<typeof ridePreferencesSchema>;

/**
 * The shape persisted on rides.preferences / ride_quotes.preferences.
 * `{}` (or null) means "no preferences" — legacy behavior everywhere.
 */
export interface StoredRidePreferences {
  women_preferred?: boolean;
  pet_friendly?: boolean;
  fallback?: PreferenceFallback;
}

/** Rider-facing copy — the rider UI shows this on the options sheet. */
export const SERVICE_ANIMAL_NOTE =
  'Service animals ride on every TAKEME trip at no charge — no option needed.';

// ── Config resolution ────────────────────────────────────────────────────

/**
 * Pure precedence: for each preference, a row matching the requested state
 * wins over the NULL-state default row. Inactive rows must be filtered by
 * the caller's query.
 */
export function resolvePreferenceConfig(
  rows: PreferenceConfigRow[],
  stateCode: string | null,
): ResolvedPreferenceConfig {
  const pick = (kind: PreferenceKind): PreferenceConfigRow | null => {
    const forKind = rows.filter((r) => r.preference === kind);
    const stateRow = stateCode
      ? forKind.find((r) => r.state_code === stateCode)
      : undefined;
    return stateRow ?? forKind.find((r) => r.state_code === null) ?? null;
  };
  return { womenPreferred: pick('women_preferred'), petFriendly: pick('pet_friendly') };
}

const CONFIG_TTL_MS = 5 * 60 * 1000;
let configCache = new TTLCache<ResolvedPreferenceConfig>(100, CONFIG_TTL_MS);

/** Invalidate cached config (admin publishes call this). */
export function clearPreferenceCache(): void {
  configCache = new TTLCache<ResolvedPreferenceConfig>(100, CONFIG_TTL_MS);
}

/**
 * Load the active preference config for a market. State row overrides the
 * default (NULL state) row. Cached 5 minutes per state.
 */
export async function getPreferenceConfig(
  svc: SupabaseClient,
  stateCode: string | null,
): Promise<ResolvedPreferenceConfig> {
  const key = stateCode ?? '~default~';
  const cached = configCache.get(key);
  if (cached) return cached;

  let query = svc
    .from('ride_preference_config')
    .select(
      'preference, state_code, enabled, fee, fee_effective_from, fee_effective_to, rules, copy_version, fallback_default',
    )
    .eq('active', true);
  query = stateCode
    ? query.or(`state_code.is.null,state_code.eq.${stateCode}`)
    : query.is('state_code', null);

  const { data, error } = await query;
  if (error) {
    // Fail closed: no config → no preferences offered, never a guess.
    console.error('[ride-preferences] config load failed:', error.message);
    return { womenPreferred: null, petFriendly: null };
  }

  const rows: PreferenceConfigRow[] = (data ?? []).map((r) => ({
    preference: r.preference as PreferenceKind,
    state_code: r.state_code ?? null,
    enabled: Boolean(r.enabled),
    fee: r.fee === null || r.fee === undefined ? null : Number(r.fee),
    fee_effective_from: r.fee_effective_from ?? null,
    fee_effective_to: r.fee_effective_to ?? null,
    rules: (r.rules ?? {}) as Record<string, unknown>,
    copy_version: r.copy_version ?? null,
    fallback_default: (r.fallback_default ?? 'any_driver') as PreferenceFallback,
  }));

  const resolved = resolvePreferenceConfig(rows, stateCode);
  configCache.set(key, resolved);
  return resolved;
}

// ── Pet fee (effective-date windowed) ────────────────────────────────────

/**
 * The pet fee currently in force, or null when there is none (disabled
 * preference, no fee configured, or outside the effective window).
 */
export function activePetFee(
  config: ResolvedPreferenceConfig,
  at: Date = new Date(),
): number | null {
  const row = config.petFriendly;
  if (!row || !row.enabled || row.fee === null) return null;
  if (row.fee_effective_from && at < new Date(row.fee_effective_from)) return null;
  if (row.fee_effective_to && at >= new Date(row.fee_effective_to)) return null;
  return row.fee;
}

// ── Validation (pure — unit tested) ──────────────────────────────────────

export type ValidatePreferencesResult =
  | { ok: true; stored: StoredRidePreferences | null; petFee: number | null }
  | { ok: false; error: string };

/**
 * Validate a rider's requested preferences against the server config.
 * A disabled/unknown preference is a hard rejection (400 upstream) — never
 * silently dropped. Returns the normalized snapshot to persist and the pet
 * fee to charge (null when no petFriendly selection — service animals and
 * plain rides are never charged).
 */
export function validatePreferences(
  config: ResolvedPreferenceConfig,
  prefs: RidePreferencesInput | null | undefined,
  at: Date = new Date(),
): ValidatePreferencesResult {
  const wantsWomen = prefs?.womenPreferred === true;
  const wantsPet = prefs?.petFriendly === true;

  if (!wantsWomen && !wantsPet) {
    // No preferences selected — nothing to store, nothing to charge.
    return { ok: true, stored: null, petFee: null };
  }

  if (wantsPet && !config.petFriendly?.enabled) {
    return { ok: false, error: 'pet_friendly_unavailable' };
  }
  if (wantsWomen && !config.womenPreferred?.enabled) {
    return { ok: false, error: 'women_preferred_unavailable' };
  }

  const stored: StoredRidePreferences = {};
  if (wantsWomen) {
    stored.women_preferred = true;
    // fallback is only meaningful with women_preferred.
    stored.fallback =
      prefs?.fallback ?? config.womenPreferred?.fallback_default ?? 'any_driver';
  }
  if (wantsPet) stored.pet_friendly = true;

  return { ok: true, stored, petFee: wantsPet ? activePetFee(config, at) : null };
}

// ── Matching filter (pure — unit tested) ─────────────────────────────────

export interface PreferenceFlaggedCandidate {
  pet_friendly_opt_in?: boolean;
  women_preferred_enrolled?: boolean;
}

/**
 * Hard filters applied to dispatch candidates:
 *   - pet_friendly rides only go to opted-in drivers (always a hard filter).
 *   - women_preferred with fallback 'keep_looking' hard-filters to enrolled
 *     drivers — the ride keeps looking (and ultimately follows the normal
 *     no-driver path) rather than silently assigning a non-enrolled driver.
 *   - women_preferred with 'any_driver' does NOT filter here; enrolled
 *     drivers are prioritized during ranking instead (lib/matching).
 */
export function applyPreferenceFilters<T extends PreferenceFlaggedCandidate>(
  candidates: T[],
  prefs: StoredRidePreferences | null | undefined,
): T[] {
  if (!prefs) return candidates;
  let out = candidates;
  if (prefs.pet_friendly === true) {
    out = out.filter((c) => c.pet_friendly_opt_in === true);
  }
  if (prefs.women_preferred === true && (prefs.fallback ?? 'any_driver') === 'keep_looking') {
    out = out.filter((c) => c.women_preferred_enrolled === true);
  }
  return out;
}

// ── Rider-facing options ─────────────────────────────────────────────────

export interface RiderPreferenceOptions {
  womenPreferred: {
    visible: boolean;
    disclaimer: string | null;
    copyVersion: string | null;
  };
  petFriendly: {
    visible: boolean;
    fee: number | null;
    rules: Record<string, unknown>;
    etaNote: string | null;
  };
}

/**
 * v1 rider eligibility for Women Preferred = the feature is enabled for the
 * market. Per-rider gating (verification tiers, account signals) slots in
 * here without touching callers.
 */
async function riderEligibleForWomenPreferred(
  svc: SupabaseClient,
  riderId: string,
): Promise<boolean> {
  void svc;
  void riderId; // v1: no per-rider signals yet
  return true;
}

/**
 * What the rider may SEE on the ride options sheet. Disabled preferences are
 * invisible (not "greyed out") — availability is server truth.
 */
export async function riderPreferenceOptions(
  svc: SupabaseClient,
  riderId: string,
  stateCode: string | null,
): Promise<RiderPreferenceOptions> {
  const config = await getPreferenceConfig(svc, stateCode);

  const womenRow = config.womenPreferred;
  const womenVisible =
    womenRow?.enabled === true && (await riderEligibleForWomenPreferred(svc, riderId));

  const petRow = config.petFriendly;
  const petVisible = petRow?.enabled === true;

  return {
    womenPreferred: {
      visible: womenVisible,
      disclaimer: womenVisible
        ? ((womenRow?.rules?.rollout_note as string | undefined) ?? null)
        : null,
      copyVersion: womenVisible ? (womenRow?.copy_version ?? null) : null,
    },
    petFriendly: {
      visible: petVisible,
      fee: petVisible ? activePetFee(config) : null,
      rules: petVisible ? (petRow?.rules ?? {}) : {},
      etaNote: petVisible
        ? ((petRow?.rules?.eta_note as string | undefined) ?? null)
        : null,
    },
  };
}
