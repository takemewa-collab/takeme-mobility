import { describe, expect, it } from 'vitest';
import { ACTION_TO_STATUS, VALID_TRANSITIONS, canTransition } from '../trip-state';

describe('trip state machine', () => {
  it('enforces the full order with no skips: assigned → arriving → arrived → in_progress → completed', () => {
    expect(canTransition('driver_assigned', 'driver_arriving')).toBe(true);
    expect(canTransition('driver_arriving', 'arrived')).toBe(true);
    expect(canTransition('arrived', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('rejects every skipping transition', () => {
    expect(canTransition('driver_assigned', 'arrived')).toBe(false);
    expect(canTransition('driver_assigned', 'in_progress')).toBe(false);
    expect(canTransition('driver_assigned', 'completed')).toBe(false);
    expect(canTransition('driver_arriving', 'in_progress')).toBe(false);
    expect(canTransition('driver_arriving', 'completed')).toBe(false);
    expect(canTransition('arrived', 'completed')).toBe(false);
  });

  it('start_trip only works from arrived', () => {
    const target = ACTION_TO_STATUS.start_trip;
    expect(target).toBe('in_progress');
    const validSources = Object.entries(VALID_TRANSITIONS)
      .filter(([, tos]) => tos.includes(target))
      .map(([from]) => from);
    expect(validSources).toEqual(['arrived']);
  });

  it('complete only works from in_progress', () => {
    const target = ACTION_TO_STATUS.complete;
    const validSources = Object.entries(VALID_TRANSITIONS)
      .filter(([, tos]) => tos.includes(target))
      .map(([from]) => from);
    expect(validSources).toEqual(['in_progress']);
  });

  it('rejects backwards and terminal-state transitions', () => {
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('cancelled', 'driver_assigned')).toBe(false);
    expect(canTransition('in_progress', 'arrived')).toBe(false);
    expect(canTransition('searching_driver', 'completed')).toBe(false);
  });
});
