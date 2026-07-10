import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useAuth } from '@/providers/auth';
import { useSupabase } from '@/providers/supabase';
import { useRide } from '@/providers/ride';

// ---------------------------------------------------------------------------
// Push notifications — how the rider hears about their ride while the app is
// backgrounded: driver assigned, trip complete, or no drivers found. The
// server templates live in lib/push.ts and default to channelId
// `ride-requests`, so the Android channel id here must match.
// ---------------------------------------------------------------------------

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

// Ride updates should still banner while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function usePushNotifications() {
  const { user } = useAuth();
  const supabase = useSupabase();
  const { restoreActiveRide } = useRide();
  const router = useRouter();
  const registered = useRef(false);

  // ── Register the Expo push token with the API ──────────────────────────
  useEffect(() => {
    if (!user || registered.current || !API_BASE) return;
    let cancelled = false;

    (async () => {
      try {
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('ride-requests', {
            name: 'Ride updates',
            importance: Notifications.AndroidImportance.HIGH,
            sound: 'default',
          });
        }

        let { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') {
          ({ status } = await Notifications.requestPermissionsAsync());
        }
        if (status !== 'granted' || cancelled) return;

        const projectId: string | undefined =
          Constants.expoConfig?.extra?.eas?.projectId;
        const { data: expoToken } = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );

        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken || cancelled) return;

        const res = await fetch(`${API_BASE}/api/push-token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            token: expoToken,
            platform: Platform.OS === 'android' ? 'android' : 'ios',
            role: 'rider',
          }),
        });

        if (res.ok) {
          registered.current = true;
          console.log('[push:rider] Token registered');
        } else {
          console.warn('[push:rider] Registration failed:', res.status);
        }
      } catch (err) {
        // Simulators and Expo Go can't get push tokens — never crash over it.
        console.warn('[push:rider] Registration error:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  // ── Route notification taps to the right ride screen ───────────────────
  // Foreground updates already flow through the realtime subscription in
  // RideProvider, so only taps (background/killed) need handling here.
  useEffect(() => {
    const handleTap = async (data: Record<string, unknown> | undefined) => {
      if (!data || typeof data.type !== 'string') return;

      switch (data.type) {
        case 'driver_assigned':
          await restoreActiveRide();
          router.push('/(app)/ride/tracking');
          break;
        case 'ride_completed':
          await restoreActiveRide();
          router.push('/(app)/ride/complete');
          break;
        case 'dispatch_failed':
          // Ride was cancelled server-side; refresh state so the UI resets.
          await restoreActiveRide();
          break;
        default:
          break;
      }
    };

    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      handleTap(response.notification.request.content.data as Record<string, unknown>);
    });

    // Cold start: the notification that launched the app.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        handleTap(response.notification.request.content.data as Record<string, unknown>);
      }
    });

    return () => {
      responseSub.remove();
    };
  }, [restoreActiveRide, router]);
}
