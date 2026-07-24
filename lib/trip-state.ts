// ═══════════════════════════════════════════════════════════════════════════
// The server-authoritative trip state machine — pure and unit-tested.
// Extracted from the driver/rides route so the transition table itself is
// under test: no state may be skipped, and both apps derive their screens
// from these statuses alone.
//
//   searching_driver → driver_assigned → driver_arriving → arrived
//     → in_progress → completed
// with cancellation allowed until the trip starts (rider/driver policy is
// enforced at the endpoints).
// ═══════════════════════════════════════════════════════════════════════════

export const VALID_TRANSITIONS: Record<string, string[]> = {
  driver_assigned: ['driver_arriving', 'cancelled'],
  driver_arriving: ['arrived', 'cancelled'],
  arrived: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
};

export const ACTION_TO_STATUS: Record<string, string> = {
  accept: 'driver_arriving',
  arriving: 'driver_arriving',
  arrived: 'arrived',
  start_trip: 'in_progress',
  complete: 'completed',
  cancel: 'cancelled',
};

/** True when `from → to` is an allowed, non-skipping transition. */
export function canTransition(from: string, to: string): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}
