// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Push Notification Service
// Uses Expo Push API to send notifications to driver/rider apps.
// Push tokens are stored in the push_tokens table, keyed by (user_id, role)
// where user_id is the AUTH user id (auth.users.id, not drivers.id).
// ═══════════════════════════════════════════════════════════════════════════

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushMessage {
  to: string; // Expo push token
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'high';
  channelId?: string;
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
        sound: message.sound ?? 'default',
        priority: message.priority ?? 'high',
        channelId: message.channelId ?? 'ride-requests',
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

// Notification templates
export function rideRequestNotification(pushToken: string, rideData: {
  rideId: string;
  pickupAddress: string;
  dropoffAddress: string;
  estimatedFare: number;
  distanceKm: number;
}): PushMessage {
  return {
    to: pushToken,
    title: 'New Ride Request!',
    body: `${rideData.pickupAddress} → ${rideData.dropoffAddress} · $${rideData.estimatedFare.toFixed(2)}`,
    data: {
      type: 'ride_request',
      rideId: rideData.rideId,
      pickupAddress: rideData.pickupAddress,
      dropoffAddress: rideData.dropoffAddress,
      estimatedFare: rideData.estimatedFare,
      distanceKm: rideData.distanceKm,
    },
    priority: 'high',
    channelId: 'ride-requests',
  };
}

export function rideAssignedNotification(pushToken: string, data: {
  rideId: string;
  driverName: string;
  vehicleDesc: string;
  etaMinutes?: number;
}): PushMessage {
  return {
    to: pushToken,
    title: 'Driver on the way!',
    body: data.etaMinutes
      ? `${data.driverName} in ${data.vehicleDesc} · ${data.etaMinutes} min away`
      : `${data.driverName} is on the way in ${data.vehicleDesc}`,
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
