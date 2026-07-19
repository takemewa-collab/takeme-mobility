import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatCurrency, formatDistanceMi, formatDuration, API } from '@takeme/shared';
import { DISPATCH } from '@takeme/shared';
import { useTrip } from '@/providers/trip';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export default function IncomingRideScreen() {
  const router = useRouter();
  const { activeTrip, clearTrip, apiClient } = useTrip();
  const [timeLeft, setTimeLeft] = useState<number>(DISPATCH.ACCEPT_TIMEOUT_SEC);
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const handleReject = async () => {
    if (rejecting) return;
    setRejecting(true);
    try {
      if (activeTrip && apiClient) {
        await apiClient.put(API.DRIVER_RIDES, {
          rideId: activeTrip.id,
          action: 'cancel',
          cancelReason: 'Driver rejected',
        });
      }
      clearTrip();
      router.back();
    } catch {
      clearTrip();
      router.back();
    }
  };

  // The countdown re-arms every second; the latest handleReject is kept in a
  // ref so the expiry path never fires a stale closure.
  const rejectRef = useRef(handleReject);
  useEffect(() => {
    rejectRef.current = handleReject;
  });
  useEffect(() => {
    if (timeLeft <= 0) {
      rejectRef.current();
      return;
    }
    const timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft]);

  const handleAccept = async () => {
    if (!activeTrip || !apiClient || accepting) return;
    setAccepting(true);
    try {
      await apiClient.put(API.DRIVER_RIDES, {
        rideId: activeTrip.id,
        action: 'accept',
      });
      router.replace('/(app)/trip/navigate');
    } catch {
      Alert.alert('Error', 'Could not accept ride. Please try again.');
      setAccepting(false);
    }
  };

  if (!activeTrip) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.title}>No incoming ride</Text>
          <Pressable style={styles.rejectButton} onPress={() => router.back()}>
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
        {activeTrip.preferences.pet_friendly ? (
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
              <Text style={styles.locationAddress}>{activeTrip.pickup_address}</Text>
            </View>
          </View>

          <View style={styles.connector} />

          <View style={styles.locationRow}>
            <View style={[styles.dot, { backgroundColor: colors.primary }]} />
            <View style={styles.locationInfo}>
              <Text style={styles.locationLabel}>Dropoff</Text>
              <Text style={styles.locationAddress}>{activeTrip.dropoff_address}</Text>
            </View>
          </View>

          <View style={styles.rideStats}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {activeTrip.distance_km ? formatDistanceMi(Number(activeTrip.distance_km)) : '...'}
              </Text>
              <Text style={styles.statLabel}>Distance</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {activeTrip.duration_min ? formatDuration(Number(activeTrip.duration_min)) : '...'}
              </Text>
              <Text style={styles.statLabel}>Duration</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>
                {formatCurrency(Number(activeTrip.estimated_fare ?? 0))}
              </Text>
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
          <Text style={styles.rejectText}>{rejecting ? 'Rejecting...' : 'Reject'}</Text>
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
