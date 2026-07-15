import * as TaskManager from 'expo-task-manager';
import { API } from '@takeme/shared';
import { getClerkToken } from '@/lib/clerk';

export const BACKGROUND_LOCATION_TASK = 'DRIVER_LOCATION_BROADCAST';

/**
 * Background task that receives location updates and sends them to the API.
 * Defined at top level so expo-task-manager registers it before app mounts.
 * Auth comes from the Clerk singleton, which restores the persisted session
 * even on headless launches (see getClerkToken).
 */
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error('[BackgroundLocation] Error:', error.message);
    return;
  }

  if (!data) return;

  const { locations } = data as {
    locations: Array<{
      coords: {
        latitude: number;
        longitude: number;
        heading: number | null;
        speed: number | null;
      };
      timestamp: number;
    }>;
  };

  const latest = locations[locations.length - 1];
  if (!latest) return;

  try {
    const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!apiBaseUrl) return;

    let accessToken: string | null = null;
    try {
      accessToken = await getClerkToken();
    } catch {
      // Token retrieval failed, send without auth (will get 401)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    await fetch(`${apiBaseUrl}${API.DRIVER_LOCATION}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lat: latest.coords.latitude,
        lng: latest.coords.longitude,
        heading: latest.coords.heading,
        speedKmh: latest.coords.speed ? latest.coords.speed * 3.6 : null,
      }),
    });
  } catch (err) {
    console.error('[BackgroundLocation] Failed to send location:', err);
  }
});
