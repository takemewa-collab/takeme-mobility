import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Alert, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RoutePoint, RoutePointStatus } from '@takeme/shared';
import { formatCurrency, formatDistanceMi, API, ApiError } from '@takeme/shared';
import { Button } from '@/components/ui';
import { TripMap } from '@/components/trip-map';
import { useDriverStatus } from '@/providers/driver-status';
import { useTrip } from '@/providers/trip';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

type StopAction = 'arrive_stop' | 'depart_stop' | 'skip_stop';

const STOP_ACTION_RESULT: Record<StopAction, RoutePointStatus> = {
  arrive_stop: 'arrived',
  depart_stop: 'completed',
  skip_stop: 'skipped',
};

const pointLabel = (p: RoutePoint) => p.place_name ?? p.formatted_address;

export default function ActiveTripScreen() {
  const router = useRouter();
  const { activeTrip, apiClient, markRoutePoint, refreshTrip } = useTrip();
  const { location } = useDriverStatus();
  const [elapsed, setElapsed] = useState(0);
  const [completing, setCompleting] = useState(false);
  const [stopActionPending, setStopActionPending] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  // ── Multi-stop derivation (pure from route_points; empty array = legacy) ──
  const routePoints = activeTrip?.route_points;
  const itinerary = useMemo(
    () =>
      (routePoints ?? [])
        .filter((p) => p.point_type === 'stop' || p.point_type === 'dropoff')
        .sort((a, b) => a.seq - b.seq),
    [routePoints],
  );
  const hasItinerary = itinerary.length > 0;
  const currentTarget =
    itinerary.find((p) => p.status === 'pending' || p.status === 'arrived') ?? null;
  const isIntermediateStop = currentTarget?.point_type === 'stop';
  const stops = useMemo(() => itinerary.filter((p) => p.point_type === 'stop'), [itinerary]);
  const currentStopNumber = isIntermediateStop && currentTarget
    ? stops.findIndex((p) => p.id === currentTarget.id) + 1
    : 0;

  // Map: current target as destination, later still-pending points as numbered
  // stops. Completed/skipped points never render.
  const mapDropoff = currentTarget
    ? { latitude: currentTarget.lat, longitude: currentTarget.lng }
    : activeTrip
      ? { latitude: activeTrip.dropoff_lat, longitude: activeTrip.dropoff_lng }
      : null;
  const mapStops = useMemo(
    () =>
      currentTarget
        ? itinerary
            .filter((p) => p.id !== currentTarget.id && p.status === 'pending' && p.seq > currentTarget.seq)
            .map((p) => ({ latitude: p.lat, longitude: p.lng }))
        : [],
    [itinerary, currentTarget],
  );

  // Rows below the header: everything except the current target, in seq order.
  const otherPoints = useMemo(
    () => itinerary.filter((p) => p.id !== currentTarget?.id),
    [itinerary, currentTarget],
  );

  const handleComplete = async () => {
    if (!activeTrip || !apiClient || completing || stopActionPending) return;
    setCompleting(true);
    try {
      await apiClient.put(API.DRIVER_RIDES, {
        rideId: activeTrip.id,
        action: 'complete',
      });
      router.replace('/(app)/trip/complete');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // A stop is still open (or state moved) — re-sync and re-derive.
        await refreshTrip();
      } else {
        Alert.alert('Error', 'Could not complete trip.');
      }
      setCompleting(false);
    }
  };

  const handleStopAction = async (action: StopAction) => {
    if (!activeTrip || !apiClient || !currentTarget || stopActionPending || completing) return;
    const pointId = currentTarget.id;
    setStopActionPending(true);
    try {
      const res = await apiClient.put<{
        pointId?: string;
        pointStatus?: RoutePointStatus;
        replay?: boolean;
      }>(API.DRIVER_RIDES, {
        rideId: activeTrip.id,
        action,
        pointId,
      });
      // Server confirmed — apply immediately instead of waiting for realtime.
      markRoutePoint(pointId, res?.pointStatus ?? STOP_ACTION_RESULT[action]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await refreshTrip();
      } else {
        Alert.alert('Error', 'Could not update the stop. Please try again.');
      }
    } finally {
      setStopActionPending(false);
    }
  };

  const handleSkipStop = () => {
    Alert.alert('Skip this stop?', 'The rider will see it was skipped.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Skip stop', style: 'destructive', onPress: () => handleStopAction('skip_stop') },
    ]);
  };

  const headerLabel = hasItinerary && currentTarget
    ? isIntermediateStop
      ? `Stop ${currentStopNumber} of ${stops.length}`
      : 'Final destination'
    : 'Heading to destination';
  const headerAddress = hasItinerary && currentTarget
    ? pointLabel(currentTarget)
    : activeTrip?.dropoff_address ?? 'Destination';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.mapContainer}>
        <TripMap driver={location} dropoff={mapDropoff} stops={mapStops} />
      </View>

      <View style={styles.card}>
        <View style={styles.tripHeader}>
          <View style={styles.tripHeaderText}>
            <Text style={styles.statusText}>{headerLabel}</Text>
            <Text style={styles.addressText} numberOfLines={2}>
              {headerAddress}
            </Text>
          </View>
          <View style={styles.timer}>
            <Text style={styles.timerText}>
              {minutes}:{seconds.toString().padStart(2, '0')}
            </Text>
          </View>
        </View>

        {hasItinerary && otherPoints.length > 0 ? (
          <View style={styles.itinerary}>
            {otherPoints.map((p) => (
              <View key={p.id} style={styles.itineraryRow}>
                <Text style={styles.itineraryBullet}>
                  {p.status === 'completed' ? '✓' : p.status === 'skipped' ? '–' : '•'}
                </Text>
                <Text
                  style={[
                    styles.itineraryText,
                    p.status === 'skipped' && styles.itinerarySkipped,
                    p.status === 'completed' && styles.itineraryDone,
                  ]}
                  numberOfLines={1}
                >
                  {pointLabel(p)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* The elapsed timer above is real; a simulated "progress" bar is not.
            Route-based progress returns when it can come from live GPS. */}
        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>
              {activeTrip?.distance_km ? formatDistanceMi(Number(activeTrip.distance_km)) : '...'}
            </Text>
            <Text style={styles.statLabel}>Distance</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>
              {formatCurrency(Number(activeTrip?.estimated_fare ?? 0))}
            </Text>
            <Text style={styles.statLabel}>Fare</Text>
          </View>
        </View>

        {isIntermediateStop && currentTarget ? (
          <>
            <Button
              title={
                stopActionPending
                  ? 'Updating...'
                  : currentTarget.status === 'pending'
                    ? 'Arrived at stop'
                    : 'Continue trip'
              }
              onPress={() =>
                handleStopAction(currentTarget.status === 'pending' ? 'arrive_stop' : 'depart_stop')
              }
              size="lg"
              fullWidth
              disabled={stopActionPending}
            />
            <Pressable
              onPress={handleSkipStop}
              disabled={stopActionPending}
              style={styles.skipButton}
              accessibilityRole="button"
            >
              <Text style={[styles.skipText, stopActionPending && styles.skipTextDisabled]}>
                Skip stop
              </Text>
            </Pressable>
          </>
        ) : (
          <Button
            title={completing ? 'Completing...' : 'Complete Trip'}
            onPress={handleComplete}
            size="lg"
            fullWidth
            disabled={completing || stopActionPending}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  mapContainer: { flex: 1, backgroundColor: colors.gray100 },
  card: {
    backgroundColor: colors.white,
    borderTopLeftRadius: borderRadius.xl, borderTopRightRadius: borderRadius.xl,
    padding: spacing['2xl'],
    shadowColor: colors.black, shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08, shadowRadius: 12, elevation: 8,
  },
  tripHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: spacing.lg,
  },
  tripHeaderText: { flex: 1, marginRight: spacing.md },
  statusText: { ...typography.bodyBold, color: colors.text },
  addressText: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  timer: {
    backgroundColor: colors.accent + '15', borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  timerText: { ...typography.bodyBold, color: colors.accent, fontVariant: ['tabular-nums'] },
  itinerary: { marginBottom: spacing.lg },
  itineraryRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 3,
  },
  itineraryBullet: {
    ...typography.small, color: colors.textMuted,
    width: 18, textAlign: 'center', marginRight: spacing.sm,
  },
  itineraryText: { ...typography.small, color: colors.textMuted, flex: 1 },
  itinerarySkipped: { textDecorationLine: 'line-through' },
  itineraryDone: { color: colors.textSecondary },
  skipButton: { alignSelf: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  skipText: { ...typography.small, color: colors.textMuted },
  skipTextDisabled: { opacity: 0.5 },
  progressTrack: {
    height: 4, backgroundColor: colors.gray200, borderRadius: 2,
    overflow: 'hidden', marginBottom: spacing.xl,
  },
  progressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 2 },
  stats: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: spacing.xl },
  stat: { alignItems: 'center' },
  statValue: { ...typography.h3, color: colors.text },
  statLabel: { ...typography.small, color: colors.textMuted, marginTop: 4 },
});
