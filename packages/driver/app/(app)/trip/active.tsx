import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatCurrency, formatDistanceMi, API } from '@takeme/shared';
import { Button } from '@/components/ui';
import { TripMap } from '@/components/trip-map';
import { useDriverStatus } from '@/providers/driver-status';
import { useTrip } from '@/providers/trip';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export default function ActiveTripScreen() {
  const router = useRouter();
  const { activeTrip, apiClient } = useTrip();
  const { location } = useDriverStatus();
  const [elapsed, setElapsed] = useState(0);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  const handleComplete = async () => {
    if (!activeTrip || !apiClient || completing) return;
    setCompleting(true);
    try {
      await apiClient.put(API.DRIVER_RIDES, {
        rideId: activeTrip.id,
        action: 'complete',
      });
      router.replace('/(app)/trip/complete');
    } catch (err) {
      Alert.alert('Error', 'Could not complete trip.');
      setCompleting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.mapContainer}>
        <TripMap
          driver={location}
          dropoff={
            activeTrip
              ? { latitude: activeTrip.dropoff_lat, longitude: activeTrip.dropoff_lng }
              : null
          }
        />
      </View>

      <View style={styles.card}>
        <View style={styles.tripHeader}>
          <View>
            <Text style={styles.statusText}>Heading to destination</Text>
            <Text style={styles.addressText}>
              {activeTrip?.dropoff_address ?? 'Destination'}
            </Text>
          </View>
          <View style={styles.timer}>
            <Text style={styles.timerText}>
              {minutes}:{seconds.toString().padStart(2, '0')}
            </Text>
          </View>
        </View>

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

        <Button
          title={completing ? 'Completing...' : 'Complete Trip'}
          onPress={handleComplete}
          size="lg"
          fullWidth
          disabled={completing}
        />
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
  statusText: { ...typography.bodyBold, color: colors.text },
  addressText: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  timer: {
    backgroundColor: colors.accent + '15', borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  timerText: { ...typography.bodyBold, color: colors.accent, fontVariant: ['tabular-nums'] },
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
