/**
 * Requirements engine — pure, deterministic, unit-tested.
 * No I/O here: the service layer loads rows, this module decides.
 */
import type {
  ActivationInput,
  ActivationResult,
  ApplicationRequirementRow,
  BackgroundCaseView,
  EngineContext,
  RequirementDefinition,
  RequirementStatus,
} from './types';

/** Statuses that satisfy a requirement for activation purposes. */
export const SATISFIED: ReadonlySet<RequirementStatus> = new Set([
  'approved',
  'waived',
  'not_applicable',
]);

/** Statuses meaning "the ball is with TAKEME, not the driver". */
export const IN_REVIEW: ReadonlySet<RequirementStatus> = new Set([
  'submitted',
  'under_review',
]);

/**
 * Which requirement definitions apply to an application context.
 * NULL applicant_types / vehicle_relationships / market_id mean "all".
 */
export function applicableDefinitions(
  definitions: RequirementDefinition[],
  ctx: EngineContext,
): RequirementDefinition[] {
  return definitions
    .filter((def) => {
      if (!def.active) return false;
      if (def.market_id && def.market_id !== ctx.marketId) return false;
      if (def.applicant_types && def.applicant_types.length > 0) {
        if (!ctx.applicantType || !def.applicant_types.includes(ctx.applicantType)) return false;
      }
      if (def.vehicle_relationships && def.vehicle_relationships.length > 0) {
        if (!ctx.vehicleRelationship || !def.vehicle_relationships.includes(ctx.vehicleRelationship)) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
}

/**
 * Expiry-aware effective status. A stored 'approved' row whose expires_at has
 * passed is 'expired'; one inside the renewal window is 'expiring_soon'.
 */
export function effectiveStatus(
  row: Pick<ApplicationRequirementRow, 'status' | 'expires_at'>,
  renewalWindowDays: number,
  now: Date,
): RequirementStatus {
  if (row.status === 'approved' && row.expires_at) {
    const expires = new Date(row.expires_at);
    if (expires.getTime() <= now.getTime()) return 'expired';
    const windowMs = renewalWindowDays * 24 * 60 * 60 * 1000;
    if (expires.getTime() - now.getTime() <= windowMs) return 'expiring_soon';
  }
  return row.status;
}

/**
 * Dependency gating: a requirement whose depends_on list is not yet satisfied
 * shows as 'blocked' unless it is already satisfied or actively in review.
 */
export function withDependencyBlocking<
  T extends Pick<ApplicationRequirementRow, 'requirement_key' | 'status'>,
>(rows: T[], definitionsByKey: Map<string, RequirementDefinition>): Map<string, RequirementStatus> {
  const statusByKey = new Map(rows.map((r) => [r.requirement_key, r.status]));
  const out = new Map<string, RequirementStatus>();
  for (const row of rows) {
    const def = definitionsByKey.get(row.requirement_key);
    const deps = def?.depends_on ?? [];
    const gated =
      deps.length > 0 &&
      deps.some((dep) => {
        const depStatus = statusByKey.get(dep);
        // A dependency not present in this application's set doesn't gate.
        return depStatus !== undefined && !SATISFIED.has(depStatus);
      });
    if (gated && !SATISFIED.has(row.status) && !IN_REVIEW.has(row.status)) {
      out.set(row.requirement_key, 'blocked');
    } else {
      out.set(row.requirement_key, row.status);
    }
  }
  return out;
}

/** Map a background-check case status onto its requirement's status. */
export function backgroundRequirementStatus(
  bg: BackgroundCaseView | null,
): RequirementStatus {
  if (!bg) return 'not_started';
  switch (bg.status) {
    case 'not_started':
    case 'disclosure_required':
    case 'consent_required':
      return 'not_started';
    case 'info_required':
    case 'candidate_action':
      return 'needs_action';
    case 'submitted':
    case 'provider_pending':
    case 'under_review':
    case 'consider':
    case 'pre_adverse':
    case 'dispute':
      return 'under_review';
    case 'clear':
      return 'approved';
    case 'adverse_final':
      return 'rejected';
    case 'expired':
    case 'recheck_required':
      return 'expired';
    case 'provider_unavailable':
      return 'needs_action';
    default:
      return 'under_review';
  }
}

/**
 * The server-authoritative activation decision. The mobile app must never
 * derive eligibility from local state; it renders this result.
 */
export function computeActivation(input: ActivationInput): ActivationResult {
  const { requirements, driver, now } = input;
  const reasonCodes: string[] = [];
  const requiredActions: string[] = [];

  if (input.applicationStatus === 'suspended' || (driver && !driver.is_active)) {
    return {
      decision: 'suspended',
      reasonCodes: ['account_suspended'],
      requiredActions: [],
    };
  }
  if (input.applicationStatus === 'rejected') {
    return {
      decision: 'ineligible',
      reasonCodes: ['application_rejected'],
      requiredActions: [],
    };
  }

  let hasExpired = false;
  let hasPendingReview = false;

  for (const req of requirements) {
    if (!req.required || !req.blocking) continue;
    const status = effectiveStatus(req, 0, now);
    if (SATISFIED.has(status)) continue;
    if (status === 'expired') {
      hasExpired = true;
      reasonCodes.push(`expired:${req.requirement_key}`);
      requiredActions.push(req.requirement_key);
    } else if (IN_REVIEW.has(status)) {
      hasPendingReview = true;
      reasonCodes.push(`in_review:${req.requirement_key}`);
    } else {
      reasonCodes.push(`missing:${req.requirement_key}`);
      requiredActions.push(req.requirement_key);
    }
  }

  if (reasonCodes.length === 0) {
    return { decision: 'eligible', reasonCodes: [], requiredActions: [] };
  }
  if (hasExpired) {
    return { decision: 'expired_requirement', reasonCodes, requiredActions };
  }
  if (requiredActions.length === 0 && hasPendingReview) {
    return { decision: 'pending_review', reasonCodes, requiredActions };
  }
  return { decision: 'ineligible', reasonCodes, requiredActions };
}

/**
 * The single most useful next action for the driver, in definition order.
 * Returns the requirement key, or null when there is nothing to do.
 */
export function nextAction(
  rows: Array<Pick<ApplicationRequirementRow, 'requirement_key' | 'status' | 'required'>>,
  definitionsByKey: Map<string, RequirementDefinition>,
  displayStatus: Map<string, RequirementStatus>,
): string | null {
  const actionable: RequirementStatus[] = ['needs_action', 'rejected', 'expired', 'expiring_soon', 'not_started', 'in_progress'];
  const ordered = [...rows].sort((a, b) => {
    const da = definitionsByKey.get(a.requirement_key)?.sort_order ?? 999;
    const db = definitionsByKey.get(b.requirement_key)?.sort_order ?? 999;
    return da - db;
  });
  // Problems first (needs_action / rejected / expired), then fresh steps.
  for (const wanted of [
    ['needs_action', 'rejected', 'expired', 'expiring_soon'] as RequirementStatus[],
    ['not_started', 'in_progress'] as RequirementStatus[],
  ]) {
    for (const row of ordered) {
      if (!row.required) continue;
      const status = displayStatus.get(row.requirement_key) ?? row.status;
      if (wanted.includes(status) && actionable.includes(status)) return row.requirement_key;
    }
  }
  return null;
}
