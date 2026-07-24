// ═══════════════════════════════════════════════════════════════════════════
// When may the E2E monitor send its SES "System Check" email?
//
// Never on routine success — the cron runs every 5 minutes and a
// success-every-run email is 288 messages/day of noise. Email is warranted
// only when:
//   * a monitoring step failed on this run           → 'failure'
//   * the service just recovered (prev run failing,
//     this run fully healthy)                        → 'recovery'
//   * an explicitly configured digest interval
//     (MONITOR_DIGEST_HOURS) has elapsed             → 'digest'
// ═══════════════════════════════════════════════════════════════════════════

export type MonitorEmailReason = 'failure' | 'recovery' | 'digest' | null;

export interface EmailDecisionInput {
  /** Failed step count for the run that just executed. */
  currentFailed: number;
  /** Was the PREVIOUS run fully healthy? null = no history exists. */
  previousRunHealthy: boolean | null;
  /** Digest cadence in hours; null/0/NaN = digest disabled. */
  digestEveryHours: number | null;
  /** When the last digest email went out; null = never. */
  lastDigestAt: Date | null;
  now?: Date;
}

export function monitorEmailReason(input: EmailDecisionInput): MonitorEmailReason {
  if (input.currentFailed > 0) return 'failure';

  // Healthy run after a failing one — announce the recovery exactly once.
  if (input.previousRunHealthy === false) return 'recovery';

  const hours = input.digestEveryHours;
  if (hours != null && Number.isFinite(hours) && hours > 0) {
    if (!input.lastDigestAt) return 'digest';
    const now = input.now ?? new Date();
    if (now.getTime() - input.lastDigestAt.getTime() >= hours * 3_600_000) return 'digest';
  }

  return null;
}
