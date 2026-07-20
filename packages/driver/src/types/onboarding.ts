/**
 * TypeScript contracts for the driver onboarding / Activation Center APIs.
 * These mirror the server responses exactly — the server state object is the
 * single source of truth and is re-adopted wholesale after every mutation.
 */

export type ApplicationStatus =
  | 'in_progress'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suspended';

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

export type OnboardingDocumentStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface OnboardingDocument {
  id: string;
  docType: string;
  status: OnboardingDocumentStatus;
  rejectionReason: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface TrainingSection {
  title: string;
  body: string;
}

export interface TrainingQuestion {
  id: string;
  prompt: string;
  /** Options only — the server holds the answers and scores submissions. */
  options: string[];
}

export interface RequirementConfig {
  requires_back?: boolean;
  camera_only?: boolean;
  sections?: TrainingSection[] | null;
  questions?: TrainingQuestion[] | null;
  pass_score?: number;
  legal_keys?: string[] | null;
  disclosure_keys?: string[] | null;
}

export interface OnboardingRequirement {
  key: string;
  title: string;
  summary: string;
  instructions: string | null;
  category: RequirementCategory;
  reviewMethod: ReviewMethod;
  required: boolean;
  blocking: boolean;
  externalUrl: string | null;
  docKinds: string[] | null;
  dependsOn: string[] | null;
  sortOrder: number;
  status: RequirementStatus;
  rejectionReason: string | null;
  reviewNote: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  config: RequirementConfig;
  documents: OnboardingDocument[];
}

export interface ApplicationVehicle {
  make: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  plate: string | null;
  plateState: string | null;
  vin: string | null;
  verification: string | null;
}

export interface OnboardingApplication {
  id: string;
  status: ApplicationStatus;
  applicantType: ApplicantType | null;
  vehicleRelationship: VehicleRelationship | null;
  preferredLanguage: string | null;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  vehicle: ApplicationVehicle | null;
  submittedAt: string | null;
}

export interface EvPolicy {
  min_model_year?: number;
  min_doors?: number;
  min_seatbelts?: number;
  [key: string]: unknown;
}

export interface ApplicationMarket {
  id: string;
  key: string;
  displayName: string;
  status: string;
  evPolicy: EvPolicy;
}

export interface BackgroundCheckState {
  status: string;
  provider: string | null;
  invitationUrl: string | null;
  submittedAt: string | null;
}

export interface ConsentRecord {
  documentKey: string;
  version: string;
  acceptedAt: string;
}

export type ActivationDecision =
  | 'eligible'
  | 'ineligible'
  | 'pending_review'
  | 'temporarily_blocked'
  | 'suspended'
  | 'expired_requirement';

export interface ActivationState {
  decision: ActivationDecision;
  reasonCodes: string[];
  requiredActions: string[];
  nextAction: string | null;
}

export interface DriverRecordState {
  exists: boolean;
  isVerified: boolean;
  isActive: boolean;
}

export interface OnboardingState {
  application: OnboardingApplication | null;
  market: ApplicationMarket | null;
  requirements: OnboardingRequirement[];
  backgroundCheck: BackgroundCheckState | null;
  consents: ConsentRecord[];
  activation: ActivationState;
  driver: DriverRecordState;
}

export interface OnboardingMarket {
  key: string;
  displayName: string;
  countryCode: string;
  regionCode: string;
  city: string;
  status: 'active' | 'waitlisted';
}

export interface OnboardingResponse {
  state: OnboardingState;
  markets: OnboardingMarket[];
}

// ---------------------------------------------------------------------------
// Mutation payloads and responses
// ---------------------------------------------------------------------------

export type WeeklyHours = 'under_10' | '10_25' | '25_40' | 'over_40';

export interface DriverPreferences {
  weeklyHours?: WeeklyHours;
  airportInterest?: boolean;
  accessibleVehicle?: boolean;
  languagesSpoken?: string[];
  priorExperience?: boolean;
  rentalInterest?: boolean;
  preferredAreas?: string[];
}

export interface ApplicationUpdate {
  marketKey?: string;
  applicantType?: ApplicantType;
  vehicleRelationship?: VehicleRelationship;
  fullName?: string;
  email?: string;
  phone?: string;
  licenseNumber?: string;
  preferredLanguage?: string;
  preferences?: DriverPreferences;
}

export interface ApplicationUpdateResponse {
  state: OnboardingState;
  marketChanged: boolean;
}

export interface VehicleSubmission {
  vin?: string;
  plate: string;
  plateConfirm: string;
  plateState: string;
  make?: string;
  model?: string;
  year?: number;
  color?: string;
  doors?: number;
  seatbelts?: number;
}

export interface VehicleFacts {
  make: string | null;
  model: string | null;
  year: number | null;
  doors: number | null;
  seatbelts: number | null;
  powertrain: string | null;
  bodyType: string | null;
}

export interface VehicleEligibility {
  eligible: boolean;
  needsReview: boolean;
  reasons: string[];
}

export interface VehicleCheckResult {
  decoded: boolean;
  eligibility: VehicleEligibility;
  facts: VehicleFacts;
}

export interface VehicleSubmitResponse {
  state: OnboardingState;
  vehicle: VehicleCheckResult;
}

export interface LegalDocumentContent {
  key: string;
  version: string;
  locale: string;
  title: string;
  /** Plain text; paragraphs separated by blank lines. */
  body: string;
  contentHash: string;
  requiresScroll: boolean;
  effectiveAt: string | null;
}

export interface LegalConsentInput {
  key: string;
  version: string;
  locale: string;
  contentHash: string;
}

export interface CreateUploadResponse {
  path: string;
  token: string;
  signedUrl: string;
}

export interface SubmitDocumentResponse {
  state: OnboardingState;
  documentId: string;
}

export interface BackgroundCheckStartResponse {
  state: OnboardingState;
  invitationUrl: string | null;
  providerUnavailable: boolean;
}

export interface TrainingAnswer {
  questionId: string;
  selected: string;
}

export interface TrainingResult {
  score: number;
  passScore: number;
  passed: boolean;
  attemptsRemaining: number | null;
}

export interface TrainingSubmitResponse {
  state: OnboardingState;
  result: TrainingResult;
}

export type WaitlistVehicleSize = 'standard' | 'large';

export interface WaitlistJoinResponse {
  joined: boolean;
}
