import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useAuth } from '@/providers/auth';
import { useSupabase } from '@/providers/supabase';
import { useTrip } from '@/providers/trip';

// ---------------------------------------------------------------------------
// Push notifications — the ONLY channel through which a driver learns about
// a ride offer while the app is backgrounded. The dispatch server sends a
// `ride_request` push (channelId `ride-requests`, 15s offer TTL); this hook
// registers the Expo push token with the API and routes offers to the
// incoming-ride screen.
// ---------------------------------------------------------------------------

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

// Ride offers must be visible even while the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function parseNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function usePushNotifications() {
  const { user } = useAuth();
  const supabase = useSupabase();
  const { setIncomingOffer } = useTrip();
  const router = useRouter();
  const registered = useRef(false);

  // ── Register the Expo push token with the API ──────────────────────────
  useEffect(() => {
    if (!user || registered.current || !API_BASE) return;
    let cancelled = false;

    (async () => {
      try {
        if (Platform.OS === 'android') {
          // Must match the channelId the server sends (lib/push.ts).
          await Notifications.setNotificationChannelAsync('ride-requests', {
            name: 'Ride requests',
            importance: Notifications.AndroidImportance.MAX,
            sound: 'default',
            vibrationPattern: [0, 250, 250, 250],
            lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
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
            role: 'driver',
          }),
        });

        if (res.ok) {
          registered.current = true;
          console.log('[push:driver] Token registered');
        } else {
          console.warn('[push:driver] Registration failed:', res.status);
        }
      } catch (err) {
        // Simulators and Expo Go can't get push tokens — never crash over it.
        console.warn('[push:driver] Registration error:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  // ── Route incoming ride offers to the incoming screen ──────────────────
  useEffect(() => {
    const handleData = (data: Record<string, unknown> | undefined) => {
      if (!data || data.type !== 'ride_request' || typeof data.rideId !== 'string') {
        return;
      }
      setIncomingOffer({
        rideId: data.rideId,
        pickupAddress: typeof data.pickupAddress === 'string' ? data.pickupAddress : '',
        dropoffAddress: typeof data.dropoffAddress === 'string' ? data.dropoffAddress : '',
        estimatedFare: parseNumber(data.estimatedFare),
        distanceKm: parseNumber(data.distanceKm),
      });
      router.push('/(app)/trip/incoming');
    };

    // Offer arrives while the app is open — jump straight to it (15s TTL).
    const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
      handleData(notification.request.content.data as Record<string, unknown>);
    });

    // Driver tapped the notification (app backgrounded or killed → resumed).
    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      handleData(response.notification.request.content.data as Record<string, unknown>);
    });

    // Cold start: the notification that launched the app.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        handleData(response.notification.request.content.data as Record<string, unknown>);
      }
    });

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, [setIncomingOffer, router]);
}
