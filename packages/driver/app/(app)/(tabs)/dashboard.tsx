import React, { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { Ionicons } from '@expo/vector-icons';
import { formatCurrency, API } from '@takeme/shared';
import { TripMap } from '@/components/trip-map';
import { registerForPush } from '@/lib/register-push';
import { useDriverStatus } from '@/providers/driver-status';
import { useOnboarding } from '@/providers/onboarding';
import { useTrip, offerFromPushData } from '@/providers/trip';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

interface WalletSummary {
  available: number;
  pending: number;
  lifetime: number;
}

export default function DashboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    status,
    goOnline,
    goOffline,
    loading,
    error,
    location,
    locationPermission,
    locationStatus,
    requestLocationPermission,
    retryLocation,
    activationBlock,
    clearActivationBlock,
  } = useDriverStatus();
  const { activeTrip, apiClient, setIncomingOffer } = useTrip();
  const { state: onboardingState } = useOnboarding();

  const [wallet, setWallet] = useState<WalletSummary | null>(null);

  const isOnline = status === 'available' || status === 'busy' || status === 'on_trip';

  const handleToggle = () => {
    if (isOnline) void goOffline();
    else void goOnline();
  };

  // Wallet summary — real data only; hidden entirely until it loads.
  useEffect(() => {
    if (!apiClient) return;
    let alive = true;
    (async () => {
      try {
        const data = await apiClient.get<{ wallet?: WalletSummary }>(API.DRIVER_DASHBOARD);
        if (alive && data.wallet) setWallet(data.wallet);
      } catch {
        // Non-critical; the panel simply doesn't render.
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiClient, status]);

  // Auto-navigate to incoming ride when one is assigned
  useEffect(() => {
    if (activeTrip?.status === 'driver_assigned') {
      router.push('/(app)/trip/incoming');
    }
  }, [activeTrip?.status, router]);

  // Register for push once we have an authenticated API client, and route
  // notification taps to the right surface. Ride offers exist ONLY in the
  // push payload while the ride is still searching (nothing is assigned yet),
  // so the payload itself seeds the incoming-offer state that /incoming
  // renders — whether the push was tapped, arrived in the foreground, or
  // cold-started the app.
  useEffect(() => {
    if (apiClient) registerForPush(apiClient);

    const handleRideRequest = (data: Record<string, unknown> | null | undefined) => {
      const offer = offerFromPushData(data);
      if (!offer) return false;
      setIncomingOffer(offer);
      router.push('/(app)/trip/incoming');
      return true;
    };

    // Tapped from the notification shade (background / killed → resumed).
    const tapSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>;
      if (handleRideRequest(data)) return;
      if (data?.type === 'onboarding_update') router.push('/onboarding');
    });

    // Arrived while the app is open — show the offer immediately; a banner
    // the driver has to notice and tap would burn most of the 15s window.
    const receiveSub = Notifications.addNotificationReceivedListener((notification) => {
      handleRideRequest(notification.request.content.data as Record<string, unknown>);
    });

    // Cold start from a tapped notification: the listener above registers too
    // late to see it, but the OS keeps the last response around.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = response.notification.request.content.data as Record<string, unknown>;
      // Offers older than the accept window are dead — don't show a ghost.
      // (`date` is epoch seconds on some platforms, ms on others — normalize.)
      const rawDate = response.notification.date;
      const sentAt = rawDate && rawDate < 1e12 ? rawDate * 1000 : rawDate;
      if (sentAt && Date.now() - sentAt > 60_000) return;
      handleRideRequest(data);
    });

    return () => {
      tapSub.remove();
      receiveSub.remove();
    };
  }, [apiClient, router, setIncomingOffer]);

  // The server refuses `available` until activation completes; explain and
  // route to the Activation Center rather than surfacing a raw 403.
  useEffect(() => {
    if (!activationBlock) return;
    Alert.alert(
      "You can't go online yet",
      'A few activation steps still need your attention.',
      [
        { text: 'Not now', style: 'cancel', onPress: clearActivationBlock },
        {
          text: "See what's needed",
          onPress: () => {
            clearActivationBlock();
            router.push('/onboarding');
          },
        },
      ],
    );
  }, [activationBlock, clearActivationBlock, router]);

  // Defense in depth: the (app) gate normally keeps unactivated drivers out.
  const needsSetup =
    onboardingState != null && onboardingState.activation.decision !== 'eligible';

  const showMap = locationPermission === 'granted' && location != null;

  return (
    <View style={styles.container}>
      <View style={styles.mapContainer}>
        {showMap ? (
          <TripMap driver={location} followDriver />
        ) : (
          <LocationSurface
            permission={locationPermission}
            status={locationStatus}
            onRequest={() => void requestLocationPermission()}
            onOpenSettings={() => void Linking.openSettings()}
            onRetry={retryLocation}
          />
        )}

        {/* Single, compact status control floating over the map. */}
        <View style={[styles.statusPill, { top: insets.top + spacing.md }]}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isOnline ? colors.statusApproved : colors.gray400 },
            ]}
          />
          <Text style={styles.statusPillText}>{isOnline ? 'Online' : 'Offline'}</Text>
          <Switch
            value={isOnline}
            onValueChange={handleToggle}
            disabled={loading || (!isOnline && (needsSetup || locationPermission !== 'granted'))}
            trackColor={{ false: colors.gray300, true: colors.primary }}
            thumbColor={colors.white}
            accessibilityLabel={isOnline ? 'Go offline' : 'Go online'}
          />
        </View>
      </View>

      <View style={styles.sheet}>
        {needsSetup ? (
          <View style={styles.setupBlock}>
            <Text style={styles.setupTitle}>Complete your application to go online</Text>
            <Text style={styles.setupHint}>
              A few steps still need your attention before you can drive.
            </Text>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
              onPress={() => router.push('/onboarding')}
            >
              <Text style={styles.primaryButtonText}>Continue setup</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.sheetHint}>
              {isOnline
                ? 'Waiting for ride requests near you.'
                : 'Go online when you’re ready to receive requests.'}
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {wallet ? (
              <View style={styles.statsRow}>
                <StatCard label="Available" value={formatCurrency(wallet.available)} />
                <StatCard label="Pending" value={formatCurrency(wallet.pending)} />
                <StatCard label="Lifetime" value={formatCurrency(wallet.lifetime)} />
              </View>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

function LocationSurface({
  permission,
  status,
  onRequest,
  onOpenSettings,
  onRetry,
}: {
  permission: 'undetermined' | 'granted' | 'denied';
  status: 'idle' | 'locating' | 'available' | 'timeout';
  onRequest: () => void;
  onOpenSettings: () => void;
  onRetry: () => void;
}) {
  let title = 'Turn on location';
  let body = 'TAKEME uses your location to show your position and match you with nearby riders.';
  let actionLabel = 'Allow location';
  let action = onRequest;

  if (permission === 'denied') {
    title = 'Location is off';
    body = 'Location permission is required to drive. Turn it on in Settings to continue.';
    actionLabel = 'Open Settings';
    action = onOpenSettings;
  } else if (permission === 'granted' && (status === 'locating' || status === 'idle')) {
    title = 'Finding your location';
    body = 'This usually takes a few seconds.';
    actionLabel = '';
    action = onRetry;
  } else if (permission === 'granted' && status === 'timeout') {
    title = 'Location unavailable';
    body = 'We couldn’t get a GPS fix. Move to an open area or try again.';
    actionLabel = 'Try again';
    action = onRetry;
  }

  return (
    <View style={styles.locationSurface}>
      <View style={styles.locationCard}>
        <Ionicons name="location-outline" size={28} color={colors.text} />
        <Text style={styles.locationTitle}>{title}</Text>
        <Text style={styles.locationBody}>{body}</Text>
        {actionLabel ? (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            onPress={action}
          >
            <Text style={styles.primaryButtonText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  mapContainer: { flex: 1, backgroundColor: colors.gray100 },
  statusPill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.xs,
    minHeight: 44,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusPillText: { ...typography.bodyBold, color: colors.text, marginRight: spacing.xs },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  sheetHint: { ...typography.caption, color: colors.textSecondary },
  error: { ...typography.caption, color: colors.statusCritical },
  statsRow: { flexDirection: 'row', gap: spacing.md },
  statCard: {
    flex: 1,
    backgroundColor: colors.gray50,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
  },
  statValue: { ...typography.bodyBold, color: colors.text },
  statLabel: { ...typography.small, color: colors.textMuted, marginTop: 2 },
  setupBlock: { gap: spacing.sm, paddingBottom: spacing.sm },
  setupTitle: { ...typography.h3, color: colors.text },
  setupHint: { ...typography.caption, color: colors.textSecondary },
  locationSurface: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['2xl'],
    backgroundColor: colors.gray50,
  },
  locationCard: {
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing['2xl'],
    maxWidth: 340,
  },
  locationTitle: { ...typography.h3, color: colors.text, textAlign: 'center' },
  locationBody: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  primaryButton: {
    minHeight: 48,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    marginTop: spacing.sm,
  },
  pressed: { opacity: 0.85 },
  primaryButtonText: { ...typography.bodyBold, color: colors.white },
});
