import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { API, type ApiClient } from '@takeme/shared';

// Foreground presentation. Ride requests get NO OS banner and NO OS sound
// while the app is open — the trip provider presents the full-screen offer
// with its own looping alert; letting the banner fire too would double the
// sound and bury the primary surface. Everything else keeps the default
// banner treatment.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const isRideRequest =
      (notification.request.content.data as Record<string, unknown> | null)?.type ===
      'ride_request';
    return {
      shouldShowBanner: !isRideRequest,
      shouldShowList: true,
      shouldPlaySound: !isRideRequest,
      shouldSetBadge: false,
    };
  },
});

/**
 * Registers this device for push and stores the Expo token server-side so
 * dispatch can reach a backgrounded driver. Safe to call repeatedly; a no-op on
 * simulators (no push hardware) and if permission is denied.
 */
export async function registerForPush(apiClient: ApiClient): Promise<void> {
  try {
    if (!Device.isDevice) return;

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return;

    if (Platform.OS === 'android') {
      // Dedicated high-importance channel: heads-up presentation, custom
      // TAKEME alert sound (bundled via the expo-notifications `sounds`
      // config), strong vibration, visible on the lock screen. NOTE: Android
      // freezes channel settings after first creation — changing them needs a
      // new channel id.
      await Notifications.setNotificationChannelAsync('ride-requests', {
        name: 'Ride requests',
        description: 'Incoming ride offers that need an immediate response.',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'ride_request.wav',
        vibrationPattern: [0, 400, 150, 400, 150, 400],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        enableVibrate: true,
        bypassDnd: false,
      });
    }

    const projectId = '0cc33074-ead9-4e4b-92bc-06077d4b205d';
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;

    await apiClient.post(API.PUSH_TOKEN, {
      token,
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      role: 'driver',
    });
  } catch (err) {
    console.warn('[push] driver registration failed (non-fatal):', err);
  }
}
