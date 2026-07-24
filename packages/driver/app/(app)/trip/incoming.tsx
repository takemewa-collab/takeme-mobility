import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatCurrency, formatDistanceMi, formatDuration, API } from '@takeme/shared';
import { DISPATCH } from '@takeme/shared';
import { useTrip } from '@/providers/trip';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

/**
 * Incoming ride surface. Two sources feed it:
 *  - a dispatch OFFER (push-delivered while the ride is still searching —
 *    `incomingOffer`): Accept claims it via the accept action, Decline turns
 *    it down via the decline action (which never cancels the ride);
 *  - a ride already assigned to this driver (`activeTrip`, realtime) — legacy
 *    surface kept as a fallback; Accept confirms, Reject cancels.
 */
export default function IncomingRideScreen() {
  const router = useRouter();
  const { activeTrip, clearTrip, apiClient, incomingOffer, setIncomingOffer, refreshTrip } = useTrip();
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const isOffer = incomingOffer != null;
  const rideId = incomingOffer?.rideId ?? activeTrip?.id ?? null;

  // Offer countdowns start from when the push landed, not when the screen
  // mounted — a slow tap must not restart the clock.
  const initialTimeLeft = useMemo(() => {
    if (!incomingOffer) return DISPATCH.ACCEPT_TIMEOUT_SEC;
    const elapsedSec = Math.floor((Date.now() - incomingOffer.receivedAt) / 1000);
    return Math.max(0, DISPATCH.ACCEPT_TIMEOUT_SEC - elapsedSec);
  }, [incomingOffer]);
  const [timeLeft, setTimeLeft] = useState<number>(initialTimeLeft);

  const dismiss = () => {
    setIncomingOffer(null);
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/(tabs)/dashboard');
  };

  const handleReject = async () => {
    if (rejecting || accepting) return;
    setRejecting(true);
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
    if (timeLeft <= 0) {
      expireRef.current();
      return;
    }
    const timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft]);

  const handleAccept = async () => {
    if (!rideId || !apiClient || accepting) return;
    setAccepting(true);
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
        petFriendly: incomingOffer.petFriendly,
      }
    : activeTrip
      ? {
          pickupAddress: activeTrip.pickup_address,
          dropoffAddress: activeTrip.dropoff_address,
          distanceKm: activeTrip.distance_km != null ? Number(activeTrip.distance_km) : null,
          durationMin: activeTrip.duration_min != null ? Number(activeTrip.duration_min) : null,
          estimatedFare: Number(activeTrip.estimated_fare ?? 0),
          petFriendly: activeTrip.preferences.pet_friendly === true,
        }
      : null;

  if (!view) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>No incoming ride</Text>
          <Pressable style={styles.rejectButton} onPress={dismiss}>
            <Text style={styles.rejectText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const progress = timeLeft / DISPATCH.ACCEPT_TIMEOUT_SEC;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.timerBar}>
        <View style={[styles.timerFill, { width: `${progress * 100}%` }]} />
      </View>

      <View style={styles.content}>
        <Text style={styles.title}>New Ride Request</Text>
        <Text style={styles.timer}>{timeLeft}s</Text>

        {/* Preference badge sits above the ride card so the driver sees it
            before deciding to accept. expo-symbols isn't a dependency, so the
            paw is the text glyph rather than SF Symbol 'pawprint.fill'. */}
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
              <Text style={styles.locationAddress}>{view.pickupAddress}</Text>
            </View>
          </View>

          <View style={styles.connector} />

          <View style={styles.locationRow}>
            <View style={[styles.dot, { backgroundColor: colors.primary }]} />
            <View style={styles.locationInfo}>
              <Text style={styles.locationLabel}>Dropoff</Text>
              <Text style={styles.locationAddress}>{view.dropoffAddress}</Text>
            </View>
          </View>

          <View style={styles.rideStats}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {view.distanceKm != null ? formatDistanceMi(view.distanceKm) : '...'}
              </Text>
              <Text style={styles.statLabel}>Distance</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {view.durationMin != null ? formatDuration(view.durationMin) : '...'}
              </Text>
              <Text style={styles.statLabel}>Duration</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{formatCurrency(view.estimatedFare)}</Text>
              <Text style={styles.statLabel}>Estimated</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.buttons}>
        <Pressable
          style={[styles.button, styles.rejectButton, rejecting && { opacity: 0.5 }]}
          onPress={handleReject}
          disabled={rejecting || accepting}
        >
          <Text style={styles.rejectText}>{rejecting ? 'Declining...' : 'Decline'}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.acceptButton, accepting && { opacity: 0.5 }]}
          onPress={handleAccept}
          disabled={accepting || rejecting}
        >
          <Text style={styles.acceptText}>{accepting ? 'Accepting...' : 'Accept'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  timerBar: { height: 4, backgroundColor: colors.gray200, overflow: 'hidden' },
  timerFill: { height: '100%', backgroundColor: colors.accent },
  content: { flex: 1, padding: spacing['2xl'], alignItems: 'center' },
  title: { ...typography.h2, color: colors.text, marginBottom: spacing.sm },
  timer: { ...typography.h1, color: colors.accent, marginBottom: spacing['2xl'], fontVariant: ['tabular-nums'] },
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
  rideCard: { width: '100%', backgroundColor: colors.gray50, borderRadius: borderRadius.lg, padding: spacing.xl },
  locationRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: spacing.md },
  locationInfo: { flex: 1 },
  locationLabel: { ...typography.small, color: colors.textMuted },
  locationAddress: { ...typography.bodyBold, color: colors.text },
  connector: { width: 2, height: 20, backgroundColor: colors.gray300, marginLeft: 5, marginVertical: spacing.xs },
  rideStats: {
    flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.lg,
  },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { ...typography.bodyBold, color: colors.text },
  statLabel: { ...typography.small, color: colors.textMuted, marginTop: 4 },
  buttons: { flexDirection: 'row', padding: spacing['2xl'], gap: spacing.md },
  button: { flex: 1, paddingVertical: spacing.lg, borderRadius: borderRadius.md, alignItems: 'center' },
  rejectButton: { backgroundColor: colors.gray100 },
  acceptButton: { backgroundColor: colors.accent },
  rejectText: { ...typography.button, color: colors.text },
  acceptText: { ...typography.button, color: colors.white },
});
