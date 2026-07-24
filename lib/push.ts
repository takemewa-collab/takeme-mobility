// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Push Notification Service
// Uses Expo Push API to send notifications to driver/rider apps.
// Push tokens are stored in driver_push_tokens / rider_push_tokens tables.
// ═══════════════════════════════════════════════════════════════════════════

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushMessage {
  to: string; // Expo push token
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** 'default', null (silent), or a bundled custom sound filename (iOS). */
  sound?: string | null;
  priority?: 'default' | 'high';
  channelId?: string;
  /**
   * iOS 15+ interruption level — time-sensitive breaks through Focus where
   * the user permits it. Expo's API enum is HYPHENATED ('time-sensitive');
   * sending 'timeSensitive' made the API 400 the ENTIRE request — proven live
   * on ride 38132b70 (offer_sent.push_provider_accepted=false): no driver
   * push at all, delivery survived only via the app's offer poll.
   */
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
}

export async function sendPushNotification(message: PushMessage): Promise<boolean> {
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        to: message.to,
        title: message.title,
        body: message.body,
        data: message.data ?? {},
        sound: message.sound === undefined ? 'default' : message.sound,
        priority: message.priority ?? 'high',
        channelId: message.channelId ?? 'ride-requests',
        ...(message.interruptionLevel ? { interruptionLevel: message.interruptionLevel } : {}),
      }),
    });

    if (!res.ok) {
      console.error('[push] Expo Push API error:', res.status);
      return false;
    }

    const result = await res.json();
    if (result.data?.[0]?.status === 'error') {
      console.error('[push] Push failed:', result.data[0].message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[push] Failed to send notification:', err);
    return false;
  }
}

export async function sendBatchPushNotifications(messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  // Expo allows up to 100 per request
  const chunks: PushMessage[][] = [];
  for (let i = 0; i < messages.length; i += 100) {
    chunks.push(messages.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(m => ({
          to: m.to,
          title: m.title,
          body: m.body,
          data: m.data ?? {},
          sound: m.sound ?? 'default',
          priority: m.priority ?? 'high',
        }))),
      });
    } catch (err) {
      console.error('[push] Batch send failed:', err);
    }
  }
}

// push_tokens.user_id is the AUTH user id, but dispatch works with drivers.id.
// Resolve the auth id first, then read the token — otherwise the lookup never
// matches and no driver push is ever sent.
export async function pushTokenForDriverRow(driverRowId: string): Promise<string | null> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const svc = createServiceClient();
  const { data: driver } = await svc
    .from('drivers')
    .select('auth_user_id')
    .eq('id', driverRowId)
    .maybeSingle();
  if (!driver?.auth_user_id) return null;
  return pushTokenForUser(driver.auth_user_id, 'driver');
}

export async function pushTokenForUser(
  userId: string,
  role: 'driver' | 'rider',
): Promise<string | null> {
  const { createServiceClient } = await import('@/lib/supabase/service');
  const svc = createServiceClient();
  const { data } = await svc
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId)
    .eq('role', role)
    .maybeSingle();
  return data?.token ?? null;
}

/**
 * Bundled custom alert sound in the driver app (expo-notifications `sounds`
 * config). Referenced by filename on both platforms; devices running a build
 * that predates the asset fall back to the default sound.
 */
export const RIDE_REQUEST_SOUND = 'ride_request.wav';

// Notification templates
export function rideRequestNotification(pushToken: string, rideData: {
  rideId: string;
  pickupAddress: string;
  dropoffAddress: string;
  estimatedFare: number;
  distanceKm: number;
  durationMin?: number;
  pickupLat?: number;
  pickupLng?: number;
  /** Driver's straight-line distance to the pickup at offer time. */
  pickupDistanceM?: number;
  /** Server-authoritative offer expiry (epoch ms) — drives the in-app countdown. */
  expiresAt?: number;
  /** Rider selected Pet Friendly — the driver must see this before accepting. */
  petFriendly?: boolean;
}): PushMessage {
  return {
    to: pushToken,
    title: rideData.petFriendly ? 'New Ride Request! · Pet Friendly' : 'New Ride Request!',
    body: `${rideData.pickupAddress} → ${rideData.dropoffAddress} · $${rideData.estimatedFare.toFixed(2)}`,
    data: {
      type: 'ride_request',
      rideId: rideData.rideId,
      pickupAddress: rideData.pickupAddress,
      dropoffAddress: rideData.dropoffAddress,
      estimatedFare: rideData.estimatedFare,
      distanceKm: rideData.distanceKm,
      ...(rideData.durationMin != null ? { durationMin: rideData.durationMin } : {}),
      ...(rideData.pickupLat != null ? { pickupLat: rideData.pickupLat } : {}),
      ...(rideData.pickupLng != null ? { pickupLng: rideData.pickupLng } : {}),
      ...(rideData.pickupDistanceM != null ? { pickupDistanceM: rideData.pickupDistanceM } : {}),
      ...(rideData.expiresAt != null ? { expiresAt: rideData.expiresAt } : {}),
      ...(rideData.petFriendly ? { petFriendly: true } : {}),
    },
    sound: RIDE_REQUEST_SOUND,
    priority: 'high',
    channelId: 'ride-requests',
    interruptionLevel: 'time-sensitive',
  };
}

export function rideAssignedNotification(pushToken: string, data: {
  rideId: string;
  driverName: string;
  vehicleDesc: string;
  /** Only present when computed from the driver's real position — never fabricated. */
  etaMinutes?: number;
}): PushMessage {
  return {
    to: pushToken,
    title: 'Driver on the way!',
    body:
      data.etaMinutes != null
        ? `${data.driverName} in ${data.vehicleDesc} · ${data.etaMinutes} min away`
        : `${data.driverName} in ${data.vehicleDesc}`,
    data: { type: 'driver_assigned', rideId: data.rideId },
    priority: 'high',
  };
}

export function rideCompletedNotification(pushToken: string, data: {
  rideId: string;
  fare: number;
}): PushMessage {
  return {
    to: pushToken,
    title: 'Trip Complete',
    body: `Your trip is complete. Total: $${data.fare.toFixed(2)}`,
    data: { type: 'ride_completed', rideId: data.rideId },
  };
}
