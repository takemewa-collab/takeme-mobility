import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { API, type ApiClient } from '@takeme/shared';

// Foreground presentation: show ride requests even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
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
      await Notifications.setNotificationChannelAsync('ride-requests', {
        name: 'Ride requests',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
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
