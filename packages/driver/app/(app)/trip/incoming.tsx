import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatCurrency, formatDistanceMi, formatDuration, API, DISPATCH } from '@takeme/shared';
import { useTrip } from '@/providers/trip';
import { useDriverStatus } from '@/providers/driver-status';
import { useRouteEta } from '@/hooks/use-route-eta';
import { stopOfferAlert } from '@/lib/offer-alert';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

/**
 * Full-screen incoming ride offer — the driver's primary alert surface.
 * The trip provider owns delivery (push + server poll, deduped), the looping
 * alert sound/vibration, navigation here, and server-clock expiry; this
 * screen renders the decision UI: earnings, pickup ETA (real road route when
 * available), trip facts, a large Accept, and a clear Decline. A second
 * source feeds it as fallback: a ride already assigned via realtime
 * (`activeTrip`) — Accept confirms, Reject cancels.
 */
export default function IncomingRideScreen() {
  const router = useRouter();
  const { activeTrip, clearTrip, apiClient, incomingOffer, setIncomingOffer, refreshTrip } = useTrip();
  const { location } = useDriverStatus();
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const isOffer = incomingOffer != null;
  const rideId = incomingOffer?.rideId ?? activeTrip?.id ?? null;

  // Server-authoritative countdown: seconds until offer.expiresAt. The full
  // window length only shapes the progress bar.
  const windowSec = useMemo(() => {
    if (!incomingOffer) return DISPATCH.ACCEPT_TIMEOUT_SEC;
    return Math.max(
      1,
      Math.round((incomingOffer.expiresAt - incomingOffer.receivedAt) / 1000),
    );
  }, [incomingOffer]);
  const [timeLeft, setTimeLeft] = useState<number>(() =>
    incomingOffer
      ? Math.max(0, Math.ceil((incomingOffer.expiresAt - Date.now()) / 1000))
      : DISPATCH.ACCEPT_TIMEOUT_SEC,
  );

  // Real road-route ETA to the pickup, when the offer carries coordinates and
  // we have a live fix. Falls back to a conservative straight-line estimate.
  const pickupTarget = useMemo(
    () =>
      incomingOffer?.pickupLat != null && incomingOffer?.pickupLng != null
        ? { latitude: incomingOffer.pickupLat, longitude: incomingOffer.pickupLng }
        : null,
    [incomingOffer],
  );
  const pickupRoute = useRouteEta({
    apiClient,
    driver: location ? { latitude: location.latitude, longitude: location.longitude } : null,
    target: pickupTarget,
    enabled: isOffer && pickupTarget != null,
  });
  const pickupEtaMin =
    pickupRoute?.etaMin ??
    (incomingOffer?.pickupDistanceM != null
      ? Math.max(1, Math.round(incomingOffer.pickupDistanceM / 420))
      : null);
  const pickupDistanceKm =
    pickupRoute?.distanceKm ??
    (incomingOffer?.pickupDistanceM != null ? incomingOffer.pickupDistanceM / 1000 : null);

  const dismiss = () => {
    void stopOfferAlert();
    setIncomingOffer(null);
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/(tabs)/dashboard');
  };

  const handleReject = async () => {
    if (rejecting || accepting) return;
    setRejecting(true);
    void stopOfferAlert();
    try {
      if (rideId && apiClient) {
        if (isOffer) {
          // Turn down the offer — dispatch escalates to the next driver.
          await apiClient.put(API.DRIVER_RIDES, { rideId, action: 'decline' });
        } else if (activeTrip) {
          await apiClient.put(API.DRIVER_RIDES, {
            rideId,
            action: 'cancel',
            cancelReason: 'Driver rejected',
          });
          clearTrip();
        }
      }
    } catch {
      // Declining is best-effort — the server-side offer timeout escalates
      // on its own if this call never lands.
    } finally {
      setRejecting(false);
      dismiss();
    }
  };

  // The countdown re-arms every second; expiry simply dismisses — the server
  // owns the offer lifecycle and escalates expired offers itself.
  const expireRef = useRef(dismiss);
  useEffect(() => {
    expireRef.current = dismiss;
  });
  useEffect(() => {
    if (!isOffer) return;
    if (timeLeft <= 0) {
      expireRef.current();
      return;
    }
    const timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft, isOffer]);

  const handleAccept = async () => {
    if (!rideId || !apiClient || accepting) return;
    setAccepting(true);
    void stopOfferAlert();
    try {
      await apiClient.put(API.DRIVER_RIDES, { rideId, action: 'accept' });
      setIncomingOffer(null);
      // Load the now-assigned ride immediately instead of waiting on realtime.
      void refreshTrip();
      router.replace('/(app)/trip/navigate');
    } catch {
      Alert.alert(
        'Ride unavailable',
        'This request expired or went to another driver.',
        [{ text: 'OK', onPress: dismiss }],
      );
      setAccepting(false);
    }
  };

  const view = incomingOffer
    ? {
        pickupAddress: incomingOffer.pickupAddress,
        dropoffAddress: incomingOffer.dropoffAddress,
        distanceKm: incomingOffer.distanceKm,
        durationMin: incomingOffer.durationMin,
        estimatedFare: incomingOffer.estimatedFare,
        estimatedEarnings: incomingOffer.estimatedEarnings,
        petFriendly: incomingOffer.petFriendly,
      }
    : activeTrip
      ? {
          pickupAddress: activeTrip.pickup_address,
          dropoffAddress: activeTrip.dropoff_address,
          distanceKm: activeTrip.distance_km != null ? Number(activeTrip.distance_km) : null,
          durationMin: activeTrip.duration_min != null ? Number(activeTrip.duration_min) : null,
          estimatedFare: Number(activeTrip.estimated_fare ?? 0),
          estimatedEarnings: null,
          petFriendly: activeTrip.preferences.pet_friendly === true,
        }
      : null;

  if (!view) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>No incoming ride</Text>
          <Pressable style={[styles.declineButton, { marginTop: spacing.xl }]} onPress={dismiss}>
            <Text style={styles.declineText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const progress = isOffer ? Math.min(1, Math.max(0, timeLeft / windowSec)) : 1;
  const headline =
    view.estimatedEarnings != null
      ? formatCurrency(view.estimatedEarnings)
      : formatCurrency(view.estimatedFare);
  const headlineLabel = view.estimatedEarnings != null ? 'Estimated earnings' : 'Estimated fare';

  return (
    <SafeAreaView style={styles.container}>
      {isOffer ? (
        <View style={styles.timerBar}>
          <View style={[styles.timerFill, { width: `${progress * 100}%` }]} />
        </View>
      ) : null}

      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>New ride request</Text>
          {isOffer ? <Text style={styles.timer}>{timeLeft}s</Text> : null}
        </View>

        <View style={styles.earningsBlock}>
          <Text style={styles.earningsValue}>{headline}</Text>
          <Text style={styles.earningsLabel}>{headlineLabel}</Text>
        </View>

        {pickupEtaMin != null ? (
          <View style={styles.pickupEtaRow}>
            <Text style={styles.pickupEtaText}>
              {pickupEtaMin} min to pickup
              {pickupDistanceKm != null ? ` · ${formatDistanceMi(pickupDistanceKm)}` : ''}
            </Text>
          </View>
        ) : null}

        {view.petFriendly ? (
          <View style={styles.petBadge}>
            <Text style={styles.petBadgeTitle}>{'\u{1F43E}'} Pet Friendly trip</Text>
            <Text style={styles.petBadgeSubtitle}>Rider is bringing a household pet.</Text>
          </View>
        ) : null}

        <View style={styles.rideCard}>
          <View style={styles.locationRow}>
            <View style={[styles.dot, { backgroundColor: colors.accent }]} />
            <View style={styles.locationInfo}>
              <Text style={styles.locationLabel}>Pickup</Text>
              <Text style={styles.locationAddress} numberOfLines={2}>{view.pickupAddress}</Text>
            </View>
          </View>

          <View style={styles.connector} />

          <View style={styles.locationRow}>
            <View style={[styles.dot, { backgroundColor: colors.primary }]} />
            <View style={styles.locationInfo}>
              <Text style={styles.locationLabel}>Dropoff</Text>
              <Text style={styles.locationAddress} numberOfLines={2}>{view.dropoffAddress}</Text>
            </View>
          </View>

          <View style={styles.rideStats}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {view.distanceKm != null ? formatDistanceMi(view.distanceKm) : '—'}
              </Text>
              <Text style={styles.statLabel}>Trip distance</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {view.durationMin != null ? formatDuration(view.durationMin) : '—'}
              </Text>
              <Text style={styles.statLabel}>Trip time</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{formatCurrency(view.estimatedFare)}</Text>
              <Text style={styles.statLabel}>Fare</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.buttons}>
        <Pressable
          style={[styles.acceptButton, accepting && { opacity: 0.5 }]}
          onPress={handleAccept}
          disabled={accepting || rejecting}
          accessibilityRole="button"
          accessibilityLabel="Accept ride"
        >
          <Text style={styles.acceptText}>{accepting ? 'Accepting…' : 'Accept'}</Text>
        </Pressable>
        <Pressable
          style={[styles.declineButton, rejecting && { opacity: 0.5 }]}
          onPress={handleReject}
          disabled={rejecting || accepting}
          accessibilityRole="button"
          accessibilityLabel="Decline ride"
        >
          <Text style={styles.declineText}>{rejecting ? 'Declining…' : 'Decline'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  timerBar: { height: 6, backgroundColor: colors.gray200, overflow: 'hidden' },
  timerFill: { height: '100%', backgroundColor: colors.accent },
  content: { flex: 1, paddingHorizontal: spacing['2xl'], paddingTop: spacing.xl },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  title: { ...typography.h2, color: colors.text },
  timer: {
    ...typography.h2,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  earningsBlock: { alignItems: 'center', marginBottom: spacing.lg },
  earningsValue: {
    fontSize: 56,
    lineHeight: 64,
    fontWeight: '700',
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  earningsLabel: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  pickupEtaRow: {
    alignSelf: 'center',
    backgroundColor: colors.gray900,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  pickupEtaText: { ...typography.bodyBold, color: colors.white },
  petBadge: {
    width: '100%',
    backgroundColor: colors.gray900,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  petBadgeTitle: { ...typography.bodyBold, color: colors.white },
  petBadgeSubtitle: { ...typography.caption, color: colors.gray300, marginTop: 2 },
  rideCard: {
    width: '100%',
    backgroundColor: colors.gray50,
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
  },
  locationRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: spacing.md },
  locationInfo: { flex: 1 },
  locationLabel: { ...typography.small, color: colors.textMuted },
  locationAddress: { ...typography.bodyBold, color: colors.text },
  connector: {
    width: 2,
    height: 20,
    backgroundColor: colors.gray300,
    marginLeft: 5,
    marginVertical: spacing.xs,
  },
  rideStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.lg,
  },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { ...typography.bodyBold, color: colors.text },
  statLabel: { ...typography.small, color: colors.textMuted, marginTop: 4 },
  buttons: { padding: spacing['2xl'], gap: spacing.md },
  acceptButton: {
    backgroundColor: colors.accent,
    borderRadius: borderRadius.lg,
    paddingVertical: 22,
    alignItems: 'center',
  },
  acceptText: { ...typography.h3, color: colors.white },
  declineButton: {
    backgroundColor: colors.gray100,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  declineText: { ...typography.button, color: colors.text },
});
