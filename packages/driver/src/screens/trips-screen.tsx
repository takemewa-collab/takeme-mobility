import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatCurrency } from '@takeme/shared';
import type { TripRow } from '@/types/driver-hub';
import { groupTripsByDay, timeLabel } from '@/lib/trips-view';
import { HubEmpty, HubError, HubLoading } from '@/components/hub/state-views';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export type TripsFilter = 'all' | 'completed' | 'cancelled';

export interface ActiveTripSummary {
  id: string;
  status: string;
  pickupAddress: string | null;
  dropoffAddress: string | null;
}

export interface TripsScreenProps {
  phase: 'loading' | 'error' | 'ready';
  trips: TripRow[];
  filter: TripsFilter;
  onFilterChange: (filter: TripsFilter) => void;
  loadingMore: boolean;
  onEndReached: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  activeTrip: ActiveTripSummary | null;
  onContinueTrip: () => void;
  onTripPress: (id: string) => void;
  /** Device-local dates, computed once by the container (no clock in render). */
  todayYmd: string;
  yesterdayYmd: string;
}

const FILTERS: { key: TripsFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

export function TripsScreenView(props: TripsScreenProps) {
  const sections = groupTripsByDay(props.trips, props.todayYmd, props.yesterdayYmd).map(
    (section) => ({ ...section, data: section.trips }),
  );

  const header = (
    <View>
      <Text style={styles.header}>Trips</Text>
      {props.activeTrip ? (
        <ActiveTripCard trip={props.activeTrip} onContinue={props.onContinueTrip} />
      ) : null}
      <View style={styles.filterRow} accessibilityRole="tablist">
        {FILTERS.map((f) => {
          const selected = props.filter === f.key;
          return (
            <Pressable
              key={f.key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => props.onFilterChange(f.key)}
              style={[styles.filterChip, selected && styles.filterChipSelected]}
            >
              <Text style={[styles.filterText, selected && styles.filterTextSelected]}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  if (props.phase === 'loading') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <HubLoading />
      </SafeAreaView>
    );
  }

  if (props.phase === 'error') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <HubError
          title="Couldn't load your trips"
          body="Check your connection and try again."
          onRetry={props.onRetry}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item }) => <TripRowItem trip={item} onPress={() => props.onTripPress(item.id)} />}
        ListEmptyComponent={
          <HubEmpty
            icon="car-outline"
            title={
              props.filter === 'cancelled'
                ? 'No cancelled trips'
                : props.filter === 'completed'
                  ? 'No completed trips yet'
                  : 'No trips yet'
            }
            body={
              props.filter === 'all'
                ? 'Your completed and cancelled trips will appear here.'
                : undefined
            }
          />
        }
        ListFooterComponent={
          props.loadingMore ? (
            <View style={styles.footerLoading}>
              <ActivityIndicator color={colors.text} />
            </View>
          ) : null
        }
        onEndReachedThreshold={0.4}
        onEndReached={props.onEndReached}
        refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

function ActiveTripCard({ trip, onContinue }: { trip: ActiveTripSummary; onContinue: () => void }) {
  return (
    <View style={styles.activeCard}>
      <View style={styles.activeHead}>
        <View style={styles.liveDot} />
        <Text style={styles.activeTitle}>Trip in progress</Text>
      </View>
      {trip.dropoffAddress ? (
        <Text style={styles.activeAddress} numberOfLines={1}>
          To {trip.dropoffAddress}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={onContinue}
        style={({ pressed }) => [styles.activeButton, pressed && styles.pressed]}
      >
        <Text style={styles.activeButtonText}>Continue trip</Text>
        <Ionicons name="arrow-forward" size={16} color={colors.text} />
      </Pressable>
    </View>
  );
}

function TripRowItem({ trip, onPress }: { trip: TripRow; onPress: () => void }) {
  const cancelled = trip.status === 'cancelled';
  const time = timeLabel(trip.requestedAt);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.tripRow, pressed && styles.pressed]}
    >
      <View style={styles.tripInfo}>
        {time ? <Text style={styles.tripTime}>{time}</Text> : null}
        <View style={styles.tripAddresses}>
          <Text style={styles.tripAddress} numberOfLines={1}>
            {trip.pickupAddress ?? 'Pickup'}
          </Text>
          <View style={styles.tripArrowRow}>
            <Ionicons name="arrow-down" size={12} color={colors.gray400} />
            <Text style={styles.tripAddressSecondary} numberOfLines={1}>
              {trip.dropoffAddress ?? 'Drop-off'}
            </Text>
          </View>
        </View>
        {cancelled ? <Text style={styles.tripCancelled}>Cancelled</Text> : null}
      </View>
      <View style={styles.tripTrailing}>
        <Text style={cancelled ? styles.tripAmountMuted : styles.tripAmount}>
          {!cancelled && trip.earningsUsd != null ? formatCurrency(trip.earningsUsd) : '—'}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.gray400} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  listContent: { paddingBottom: spacing['5xl'], flexGrow: 1 },
  header: {
    ...typography.h2,
    color: colors.text,
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  pressed: { opacity: 0.7 },

  activeCard: {
    marginHorizontal: spacing['2xl'],
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderFocused,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
  },
  activeHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.statusApproved },
  activeTitle: { ...typography.bodyBold, color: colors.text },
  activeAddress: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
  activeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    minHeight: 44,
  },
  activeButtonText: { ...typography.bodyBold, color: colors.text },

  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing['2xl'],
    paddingBottom: spacing.lg,
  },
  filterChip: {
    minHeight: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { ...typography.captionBold, color: colors.textSecondary },
  filterTextSelected: { color: colors.white },

  sectionTitle: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing['2xl'],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: 64,
  },
  tripInfo: { flex: 1 },
  tripTime: { ...typography.small, color: colors.textMuted },
  tripAddresses: { marginTop: 2 },
  tripAddress: { ...typography.body, color: colors.text },
  tripArrowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 1 },
  tripAddressSecondary: { ...typography.caption, color: colors.textSecondary, flex: 1 },
  tripCancelled: { ...typography.small, color: colors.statusCritical, marginTop: 2 },
  tripTrailing: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  tripAmount: { ...typography.bodyBold, color: colors.text },
  tripAmountMuted: { ...typography.body, color: colors.textMuted },
  footerLoading: { paddingVertical: spacing.xl },
});
