import { describe, expect, it } from 'vitest';
import { rideRequestNotification, RIDE_REQUEST_SOUND } from '../push';

// Expo Push API enum contract — the API 400s the ENTIRE request on an
// unknown interruptionLevel (live incident: ride 38132b70 got no driver
// push because we sent camelCase 'timeSensitive'). Valid values:
// 'active' | 'critical' | 'passive' | 'time-sensitive'.
const EXPO_INTERRUPTION_LEVELS = ['active', 'critical', 'passive', 'time-sensitive'];

describe('rideRequestNotification payload', () => {
  const msg = rideRequestNotification('ExponentPushToken[x]', {
    rideId: 'ride-1',
    pickupAddress: 'A',
    dropoffAddress: 'B',
    estimatedFare: 12.5,
    distanceKm: 3.2,
    durationMin: 11,
    pickupLat: 47.6,
    pickupLng: -122.3,
    pickupDistanceM: 420,
    expiresAt: 1_800_000_000_000,
    petFriendly: true,
  });

  it('uses a valid Expo interruption level (hyphenated)', () => {
    expect(EXPO_INTERRUPTION_LEVELS).toContain(msg.interruptionLevel);
    expect(msg.interruptionLevel).toBe('time-sensitive');
  });

  it('carries the bundled custom sound and the ride-requests channel', () => {
    expect(msg.sound).toBe(RIDE_REQUEST_SOUND);
    expect(msg.channelId).toBe('ride-requests');
    expect(msg.priority).toBe('high');
  });

  it('carries the offer lifecycle fields the driver app depends on', () => {
    expect(msg.data).toMatchObject({
      type: 'ride_request',
      rideId: 'ride-1',
      expiresAt: 1_800_000_000_000,
      pickupLat: 47.6,
      pickupLng: -122.3,
      pickupDistanceM: 420,
      petFriendly: true,
    });
  });
});
