/**
 * Response shapes for the driver operating surfaces (Earnings, Cash Out,
 * Trips, Account, Notifications, Incentives). These mirror the platform's
 * /api/driver/* routes exactly — every number rendered in the app comes from
 * one of these payloads, never from client-side computation.
 */

// ── Earnings ────────────────────────────────────────────────────────────────

export interface EarningsSummary {
  grossUsd: number;
  rideEarningsUsd: number;
  tipsUsd: number;
  bonusesUsd: number;
  adjustmentsUsd: number;
  feesUsd: number;
  netUsd: number;
  trips: number;
}

export interface EarningsDay {
  /** Local YYYY-MM-DD in the driver's reported timezone. */
  date: string;
  earnings: EarningsSummary;
}

export interface EarningsResponse {
  timeZone: string;
  balances: {
    availableUsd: number;
    pendingUsd: number;
    lifetimeUsd: number;
    inTransitUsd: number;
  };
  today: {
    date: string;
    earnings: EarningsSummary;
    /** null before status-history tracking existed — never zero-filled. */
    onlineSeconds: number | null;
  };
  week: {
    start: string;
    end: string;
    earnings: EarningsSummary;
    onlineSeconds: number | null;
    days: EarningsDay[];
  };
  nav: {
    prevAnchor: string;
    /** null when the shown week already contains today. */
    nextAnchor: string | null;
  };
}

// ── Payouts / Cash Out ──────────────────────────────────────────────────────

export interface PayoutDestination {
  id: string;
  kind: string;
  brandOrBank: string;
  last4: string;
  supportsInstant: boolean;
  isDefault: boolean;
}

export interface PayoutHistoryEntry {
  id: string;
  amount: number;
  fee: number | null;
  net: number | null;
  method: string | null;
  speed: string | null;
  status: string;
  destination_brand: string | null;
  destination_last4: string | null;
  expected_arrival: string | null;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PayoutsResponse {
  balances: {
    availableUsd: number;
    pendingUsd: number;
    lifetimeUsd: number;
    inTransitUsd: number;
    paidOutUsd: number;
    instantAvailableUsd: number;
  };
  fees: {
    instantFeePct: number;
    instantFeeMinUsd: number;
    minPayoutUsd: number;
    dailyLimitUsd: number;
    standardFeeUsd: number;
    instantArrivalCopy: string;
    standardArrivalCopy: string;
  };
  connect: {
    onboarded: boolean;
    payoutsEnabled: boolean;
    requirementsDue: string[];
    destinations: PayoutDestination[];
    instantEligible: boolean;
    unavailableReason: string | null;
  };
  history: PayoutHistoryEntry[];
}

/** POST /api/driver/payouts — 200 on success/replay, 422 carries the same shape. */
export interface PayoutExecutionResult {
  ok: boolean;
  payoutId?: string | null;
  status?: string;
  amountUsd: number;
  feeUsd: number;
  netUsd: number;
  expectedArrival: string | null;
  failureReason?: string | null;
  replayed: boolean;
}

// ── Trips ───────────────────────────────────────────────────────────────────

export interface TripRow {
  id: string;
  status: string;
  vehicleClass: string | null;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  fareUsd: number;
  surgeMultiplier: number;
  distanceKm: number | null;
  durationMin: number | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  earningsUsd: number | null;
  tipsUsd: number | null;
  payoutStatus: string | null;
}

export interface TripsResponse {
  trips: TripRow[];
  nextBefore: string | null;
}

export interface TripTimeline {
  requestedAt: string | null;
  acceptedAt: string | null;
  arrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface TripEarningsLine {
  type: string;
  amountUsd: number;
  description: string | null;
  at: string;
}

export interface TripDetailResponse {
  trip: {
    id: string;
    status: string;
    vehicleClass: string | null;
    pickupAddress: string | null;
    dropoffAddress: string | null;
    fareUsd: number;
    surgeMultiplier: number;
    distanceKm: number | null;
    durationMin: number | null;
    cancelReason: string | null;
    cancelledBy: string | null;
    timeline: TripTimeline;
  };
  earnings: {
    totalUsd: number;
    /** Fraction (e.g. 0.8) — display as "Your share: 80%". */
    shareRate: number;
    breakdown: TripEarningsLine[];
  };
}

export type IssueCategory = 'safety' | 'payment' | 'rider_behavior' | 'app_issue' | 'other';

// ── Notifications ───────────────────────────────────────────────────────────

export interface DriverNotification {
  id: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationsResponse {
  notifications: DriverNotification[];
  unreadCount: number;
  nextBefore: string | null;
}

// ── Profile / Performance ───────────────────────────────────────────────────

export interface DriverDocument {
  id: string;
  docType: string;
  status: string;
  expiresAt: string | null;
  actionRequired: boolean;
  expired: boolean;
}

export interface ProfileResponse {
  driver: {
    driverId: string;
    fullName: string | null;
    rating: number | null;
    totalTrips: number;
    verified: boolean;
    memberSince: string | null;
  };
  vehicle: {
    make: string | null;
    model: string | null;
    year: number | null;
    color: string | null;
    plateNumber: string | null;
    vehicleClass: string | null;
    capacity: number | null;
  } | null;
  documents: DriverDocument[];
  requirements: { key: string; status: string; expiresAt: string | null }[];
}

export interface PerformanceResponse {
  windowDays: number;
  rating: number | null;
  totalTrips: number;
  driverSince: string | null;
  offers: {
    sent: number;
    accepted: number;
    declined: number;
    timedOut: number;
    acceptanceRatePct: number | null;
  };
  trips: {
    completed: number;
    cancelledByYou: number;
    completionRatePct: number | null;
    cancellationRatePct: number | null;
  };
}

// ── Incentives ──────────────────────────────────────────────────────────────

export interface IncentiveProgram {
  id: string;
  key: string;
  title: string;
  description: string | null;
  type: string;
  config: Record<string, unknown> | null;
  startsAt: string;
  endsAt: string;
  progress: Record<string, unknown> | null;
  earnedUsd: number;
  status: string;
}

export interface IncentivesResponse {
  programs: IncentiveProgram[];
}
