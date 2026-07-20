/**
 * Driver activation platform — shared types.
 * The requirements engine is pure and deterministic; everything here is
 * plain data so the engine can be unit-tested without a database.
 */

export type ApplicantType =
  | 'individual_owner'
  | 'individual_lease'
  | 'rental_seeker'
  | 'fleet_driver'
  | 'fleet_owner'
  | 'livery_operator'
  | 'subcarrier';

export type VehicleRelationship =
  | 'personal_owned'
  | 'personal_leased'
  | 'takeme_rental'
  | 'fleet_assigned'
  | 'commercial_livery'
  | 'none';

export type RequirementCategory =
  | 'identity'
  | 'legal'
  | 'vehicle'
  | 'background'
  | 'training'
  | 'market_permit'
  | 'opportunity';

export type ReviewMethod =
  | 'auto'
  | 'document_review'
  | 'provider'
  | 'manual'
  | 'quiz'
  | 'none';

export type RequirementStatus =
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'under_review'
  | 'needs_action'
  | 'approved'
  | 'rejected'
  | 'expiring_soon'
  | 'expired'
  | 'waived'
  | 'not_applicable'
  | 'blocked';

export type ActivationDecision =
  | 'eligible'
  | 'ineligible'
  | 'pending_review'
  | 'temporarily_blocked'
  | 'suspended'
  | 'expired_requirement';

export type BackgroundCheckStatus =
  | 'not_started'
  | 'disclosure_required'
  | 'consent_required'
  | 'info_required'
  | 'submitted'
  | 'provider_pending'
  | 'candidate_action'
  | 'under_review'
  | 'clear'
  | 'consider'
  | 'pre_adverse'
  | 'dispute'
  | 'adverse_final'
  | 'expired'
  | 'recheck_required'
  | 'provider_unavailable';

export interface RequirementDefinition {
  id: string;
  key: string;
  market_id: string | null;
  applicant_types: string[] | null;
  vehicle_relationships: string[] | null;
  category: RequirementCategory;
  required: boolean;
  blocking: boolean;
  review_method: ReviewMethod;
  title: string;
  summary: string;
  instructions: string;
  external_url: string | null;
  doc_kinds: string[] | null;
  depends_on: string[] | null;
  config: Record<string, unknown>;
  sort_order: number;
  active: boolean;
}

export interface ApplicationRequirementRow {
  id: string;
  application_id: string;
  definition_id: string;
  requirement_key: string;
  status: RequirementStatus;
  required: boolean;
  blocking: boolean;
  due_at: string | null;
  expires_at: string | null;
  rejection_reason: string | null;
  review_note: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export interface EngineContext {
  applicantType: ApplicantType | null;
  vehicleRelationship: VehicleRelationship | null;
  marketId: string | null;
}

/** Non-sensitive view of a background-check case fed into the engine. */
export interface BackgroundCaseView {
  status: BackgroundCheckStatus;
  provider: string;
  expires_at: string | null;
}

export interface ActivationInput {
  applicationStatus: string;
  requirements: Array<
    Pick<ApplicationRequirementRow, 'requirement_key' | 'status' | 'required' | 'blocking' | 'expires_at'>
  >;
  driver: { is_verified: boolean; is_active: boolean } | null;
  now: Date;
}

export interface ActivationResult {
  decision: ActivationDecision;
  reasonCodes: string[];
  /** Requirement keys the driver can act on right now, in display order. */
  requiredActions: string[];
}

export interface EvPolicy {
  require_battery_electric?: boolean;
  min_model_year?: number;
  min_doors?: number;
  min_seatbelts?: number;
  max_vehicle_age_years?: number;
}

export interface VehicleFacts {
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  doors: number | null;
  seatbelts: number | null;
  /** Normalized powertrain: 'bev' | 'phev' | 'hev' | 'ice' | 'unknown' */
  powertrain: string;
  bodyType: string | null;
}

export interface EvEligibilityResult {
  eligible: boolean;
  /** Machine-readable failure codes, e.g. 'not_battery_electric'. */
  reasons: string[];
  /** true when data was insufficient and manual review is required. */
  needsReview: boolean;
}
