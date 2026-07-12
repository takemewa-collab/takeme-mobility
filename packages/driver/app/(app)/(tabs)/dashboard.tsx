import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { formatCurrency, API } from '@takeme/shared';
import { TripMap } from '@/components/trip-map';
import { registerForPush } from '@/lib/register-push';
import { useDriverStatus } from '@/providers/driver-status';
import { useTrip } from '@/providers/trip';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export default function DashboardScreen() {
  const router = useRouter();
  const { status, goOnline, goOffline, loading, isLocationPermitted, error, location } =
    useDriverStatus();
  const { activeTrip, apiClient } = useTrip();

  const [dashData, setDashData] = useState<{
    trips: number; hours: number; earned: number;
  }>({ trips: 0, hours: 0, earned: 0 });

  const isOnline = status === 'available' || status === 'busy' || status === 'on_trip';

  const handleToggle = () => {
    if (isOnline) goOffline();
    else goOnline();
  };

  // Fetch dashboard stats
  useEffect(() => {
    if (!apiClient) return;
    const fetchDash = async () => {
      try {
        const data = await apiClient.get<{
          wallet?: { available: number; pending: number; lifetime: number };
          transactions?: { amount: number }[];
        }>(API.DRIVER_DASHBOARD);
        setDashData({
          trips: data.transactions?.length ?? 0,
          hours: 0,
          earned: data.wallet?.available ?? 0,
        });
      } catch {
        // Dashboard not critical, fail silently
      }
    };
    fetchDash();
  }, [apiClient, status]);

  // Auto-navigate to incoming ride when one is assigned
  useEffect(() => {
    if (activeTrip?.status === 'driver_assigned') {
      router.push('/(app)/trip/incoming');
    }
  }, [activeTrip?.status, router]);

  // Register for push once we have an authenticated API client, and route to
  // the incoming screen when the driver taps a ride-request notification.
  useEffect(() => {
    if (apiClient) registerForPush(apiClient);
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { type?: string };
      if (data?.type === 'ride_request') router.push('/(app)/trip/incoming');
    });
    return () => sub.remove();
  }, [apiClient, router]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.mapContainer}>
        <TripMap driver={location} followDriver />
        <View style={styles.mapBadge}>
          <Text style={styles.mapBadgeText}>
            {isOnline ? 'Waiting for ride requests…' : "You're offline"}
          </Text>
        </View>
      </View>

      <View style={styles.statusCard}>
        <View style={styles.toggleRow}>
          <View>
            <Text style={styles.statusLabel}>{isOnline ? 'Online' : 'Offline'}</Text>
            <Text style={styles.statusHint}>
              {isOnline ? 'Receiving ride requests' : 'Toggle on to start earning'}
            </Text>
          </View>
          <View style={styles.toggleContainer}>
            <Switch
              value={isOnline}
              onValueChange={handleToggle}
              disabled={loading || !isLocationPermitted}
              trackColor={{ false: colors.gray300, true: colors.accent }}
              thumbColor={colors.white}
            />
          </View>
        </View>

        {!isLocationPermitted && (
          <Text style={styles.warning}>Location permission required to go online</Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.statsRow}>
          <StatCard label="Trips" value={String(dashData.trips)} />
          <StatCard label="Hours" value={dashData.hours.toFixed(1)} />
          <StatCard label="Earned" value={formatCurrency(dashData.earned)} />
        </View>
      </View>
    </SafeAreaView>
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
  mapBadge: {
    position: 'absolute',
    top: spacing.lg,
    alignSelf: 'center',
    backgroundColor: colors.white,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },
  mapBadgeText: { ...typography.caption, color: colors.text },
  statusCard: {
    backgroundColor: colors.white, borderTopLeftRadius: borderRadius.xl, borderTopRightRadius: borderRadius.xl,
    padding: spacing['2xl'], shadowColor: colors.black, shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08, shadowRadius: 12, elevation: 8,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.lg },
  statusLabel: { ...typography.h3, color: colors.text },
  statusHint: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  toggleContainer: { transform: [{ scale: 1.2 }] },
  warning: { ...typography.caption, color: colors.warning, marginBottom: spacing.md },
  error: { ...typography.caption, color: colors.error, marginBottom: spacing.md },
  statsRow: { flexDirection: 'row', gap: spacing.md },
  statCard: { flex: 1, backgroundColor: colors.gray50, borderRadius: borderRadius.md, padding: spacing.lg, alignItems: 'center' },
  statValue: { ...typography.h3, color: colors.text },
  statLabel: { ...typography.small, color: colors.textMuted, marginTop: 4 },
});
