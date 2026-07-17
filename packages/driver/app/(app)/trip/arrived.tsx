import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { API } from '@takeme/shared';
import { Button } from '@/components/ui';
import { TripMap } from '@/components/trip-map';
import { TripMessagesSheet } from '@/components/trip-messages';
import { useDriverStatus } from '@/providers/driver-status';
import { useTrip } from '@/providers/trip';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export default function ArrivedScreen() {
  const router = useRouter();
  const { activeTrip, riderInfo, clearTrip, apiClient } = useTrip();
  const { location } = useDriverStatus();
  const [loading, setLoading] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);

  const handleStartTrip = async () => {
    if (!activeTrip || !apiClient || loading) return;
    setLoading(true);
    try {
      await apiClient.put(API.DRIVER_RIDES, {
        rideId: activeTrip.id,
        action: 'start_trip',
      });
      router.replace('/(app)/trip/active');
    } catch (err) {
      Alert.alert('Error', 'Could not start trip.');
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!activeTrip || !apiClient) return;
    try {
      await apiClient.put(API.DRIVER_RIDES, {
        rideId: activeTrip.id,
        action: 'cancel',
        cancelReason: 'Rider no-show',
      });
      clearTrip();
      router.replace('/(app)/(tabs)/dashboard');
    } catch {
      clearTrip();
      router.replace('/(app)/(tabs)/dashboard');
    }
  };


  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.mapContainer}>
        <TripMap
          driver={location}
          pickup={
            activeTrip
              ? { latitude: activeTrip.pickup_lat, longitude: activeTrip.pickup_lng }
              : null
          }
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.status}>You&apos;ve arrived</Text>
        <Text style={styles.hint}>
          Waiting for {riderInfo?.name ?? 'the rider'} at the pickup location
        </Text>

        {/* Contact happens in-app; phone numbers stay private on both sides. */}
        <View style={styles.actions}>
          <Pressable style={styles.contactButton} onPress={() => setMessagesOpen(true)}>
            <Text style={styles.contactText}>Message rider</Text>
          </Pressable>
        </View>

        <Button
          title={loading ? 'Starting...' : 'Start Trip'}
          onPress={handleStartTrip}
          size="lg"
          fullWidth
          disabled={loading}
        />

        <Pressable style={styles.cancelLink} onPress={handleCancel}>
          <Text style={styles.cancelText}>Cancel Ride</Text>
        </Pressable>
      </View>

      {activeTrip ? (
        <TripMessagesSheet
          rideId={activeTrip.id}
          visible={messagesOpen}
          onClose={() => setMessagesOpen(false)}
        />
      ) : null}
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
  status: { ...typography.h3, color: colors.accent, marginBottom: spacing.xs },
  hint: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.xl },
  actions: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.xl },
  contactButton: {
    flex: 1, alignItems: 'center', paddingVertical: spacing.md,
    backgroundColor: colors.gray100, borderRadius: borderRadius.md,
  },
  contactText: { ...typography.captionBold, color: colors.text },
  cancelLink: { alignItems: 'center', marginTop: spacing.lg },
  cancelText: { ...typography.captionBold, color: colors.error },
});
