import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatCurrency, formatDistanceMi, formatDuration } from '@takeme/shared';
import type { IssueCategory, TripDetailResponse } from '@/types/driver-hub';
import { timeLabel } from '@/lib/trips-view';
import { localYmdOfIso, weekdayMonthDayLabel } from '@/lib/earnings-view';
import { HubError, HubLoading } from '@/components/hub/state-views';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius, hitSlop } from '@/theme/spacing';

export interface TripDetailScreenProps {
  phase: 'loading' | 'error' | 'ready';
  detail: TripDetailResponse | null;
  onRetry: () => void;
  onBack: () => void;
  /** Resolves true on success, false on failure (screen shows the outcome). */
  onSubmitIssue: (category: IssueCategory, message: string) => Promise<boolean>;
}

const CATEGORIES: { key: IssueCategory; label: string }[] = [
  { key: 'safety', label: 'Safety concern' },
  { key: 'payment', label: 'Payment or fare' },
  { key: 'rider_behavior', label: 'Rider behavior' },
  { key: 'app_issue', label: 'App problem' },
  { key: 'other', label: 'Something else' },
];

const TIMELINE_STEPS: { key: keyof TripDetailResponse['trip']['timeline']; label: string }[] = [
  { key: 'requestedAt', label: 'Requested' },
  { key: 'acceptedAt', label: 'Accepted' },
  { key: 'arrivedAt', label: 'Arrived at pickup' },
  { key: 'startedAt', label: 'Trip started' },
  { key: 'completedAt', label: 'Completed' },
  { key: 'cancelledAt', label: 'Cancelled' },
];

function breakdownLabel(type: string, description: string | null): string {
  switch (type) {
    case 'ride_earning':
      return 'Ride earnings';
    case 'tip':
      return 'Tip';
    case 'bonus':
      return 'Bonus';
    case 'adjustment':
      return description ?? 'Adjustment';
    case 'fee':
      return description ?? 'Fee';
    default:
      return description ?? type;
  }
}

export function TripDetailScreenView(props: TripDetailScreenProps) {
  const header = (
    <View style={styles.navBar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={props.onBack}
        hitSlop={hitSlop}
        style={styles.backButton}
      >
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.navTitle}>Trip details</Text>
      <View style={styles.backButton} />
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

  if (props.phase === 'error' || !props.detail) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <HubError
          title="Couldn't load this trip"
          body="Check your connection and try again."
          onRetry={props.onRetry}
        />
      </SafeAreaView>
    );
  }

  const { trip, earnings } = props.detail;
  const cancelled = trip.status === 'cancelled';
  const dateSource = trip.timeline.completedAt ?? trip.timeline.cancelledAt ?? trip.timeline.requestedAt;
  const dateYmd = dateSource ? localYmdOfIso(dateSource) : null;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.summaryBlock}>
            {dateYmd ? <Text style={styles.summaryDate}>{weekdayMonthDayLabel(dateYmd)}</Text> : null}
            <Text style={styles.summaryStatus}>
              {cancelled ? 'Cancelled' : trip.status === 'completed' ? 'Completed' : trip.status}
              {cancelled && trip.cancelledBy ? ` by ${trip.cancelledBy === 'driver' ? 'you' : trip.cancelledBy}` : ''}
            </Text>
            {cancelled && trip.cancelReason ? (
              <Text style={styles.summaryCancelReason}>{trip.cancelReason}</Text>
            ) : null}
          </View>

          <View style={styles.routeBlock}>
            <View style={styles.routeRow}>
              <View style={styles.routeDotSolid} />
              <Text style={styles.routeAddress}>{trip.pickupAddress ?? 'Pickup'}</Text>
            </View>
            <View style={styles.routeLine} />
            <View style={styles.routeRow}>
              <View style={styles.routeDotHollow} />
              <Text style={styles.routeAddress}>{trip.dropoffAddress ?? 'Drop-off'}</Text>
            </View>
          </View>

          {trip.distanceKm != null || trip.durationMin != null ? (
            <View style={styles.statRow}>
              {trip.distanceKm != null ? (
                <Text style={styles.statText}>{formatDistanceMi(trip.distanceKm)}</Text>
              ) : null}
              {trip.distanceKm != null && trip.durationMin != null ? (
                <View style={styles.statDot} />
              ) : null}
              {trip.durationMin != null ? (
                <Text style={styles.statText}>{formatDuration(trip.durationMin)}</Text>
              ) : null}
              {trip.surgeMultiplier > 1 ? (
                <>
                  <View style={styles.statDot} />
                  <Text style={styles.statText}>{trip.surgeMultiplier}x surge</Text>
                </>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>Timeline</Text>
          <View style={styles.card}>
            {TIMELINE_STEPS.filter((step) => trip.timeline[step.key] != null).map((step) => (
              <View key={step.key} style={styles.timelineRow}>
                <Text style={styles.timelineLabel}>{step.label}</Text>
                <Text style={styles.timelineTime}>{timeLabel(trip.timeline[step.key])}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.sectionTitle}>Earnings</Text>
          <View style={styles.card}>
            <View style={styles.earningsRow}>
              <Text style={styles.earningsLabel}>Rider fare</Text>
              <Text style={styles.earningsValue}>{formatCurrency(trip.fareUsd)}</Text>
            </View>
            <View style={styles.earningsRow}>
              <Text style={styles.earningsLabel}>Your share</Text>
              <Text style={styles.earningsValue}>{Math.round(earnings.shareRate * 100)}%</Text>
            </View>
            {earnings.breakdown.map((line, i) => (
              <View key={`${line.type}-${i}`} style={styles.earningsRow}>
                <Text style={styles.earningsLabel} numberOfLines={1}>
                  {breakdownLabel(line.type, line.description)}
                </Text>
                <Text style={styles.earningsValue}>{formatCurrency(line.amountUsd)}</Text>
              </View>
            ))}
            <View style={[styles.earningsRow, styles.earningsTotalRow]}>
              <Text style={styles.earningsTotalLabel}>You earned</Text>
              <Text style={styles.earningsTotalValue}>{formatCurrency(earnings.totalUsd)}</Text>
            </View>
          </View>

          <IssueSection onSubmit={props.onSubmitIssue} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

type IssueStage = 'closed' | 'form' | 'sending' | 'sent' | 'failed';

function IssueSection({
  onSubmit,
}: {
  onSubmit: (category: IssueCategory, message: string) => Promise<boolean>;
}) {
  const [stage, setStage] = useState<IssueStage>('closed');
  const [category, setCategory] = useState<IssueCategory | null>(null);
  const [message, setMessage] = useState('');

  const valid = category != null && message.trim().length >= 5;

  const submit = useCallback(async () => {
    if (!category || message.trim().length < 5) return;
    setStage('sending');
    const ok = await onSubmit(category, message.trim());
    setStage(ok ? 'sent' : 'failed');
  }, [category, message, onSubmit]);

  if (stage === 'sent') {
    return (
      <View style={styles.issueConfirm}>
        <Ionicons name="checkmark-circle-outline" size={28} color={colors.statusApproved} />
        <Text style={styles.issueConfirmTitle}>Report received</Text>
        <Text style={styles.issueConfirmBody}>
          Our team will review your report and follow up if anything is needed.
        </Text>
      </View>
    );
  }

  if (stage === 'closed') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => setStage('form')}
        style={({ pressed }) => [styles.issueOpenButton, pressed && styles.pressed]}
      >
        <Ionicons name="flag-outline" size={18} color={colors.text} />
        <Text style={styles.issueOpenText}>Report an issue with this trip</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.gray400} />
      </Pressable>
    );
  }

  return (
    <View style={styles.issueForm}>
      <Text style={styles.sectionTitleInline}>Report an issue</Text>
      <View style={styles.issueCategories}>
        {CATEGORIES.map((c) => {
          const selected = category === c.key;
          return (
            <Pressable
              key={c.key}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setCategory(c.key)}
              style={[styles.issueChip, selected && styles.issueChipSelected]}
            >
              <Text style={[styles.issueChipText, selected && styles.issueChipTextSelected]}>
                {c.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        style={styles.issueInput}
        value={message}
        onChangeText={setMessage}
        placeholder="Tell us what happened"
        placeholderTextColor={colors.gray400}
        multiline
        maxLength={2000}
        accessibilityLabel="Describe the issue"
      />
      {stage === 'failed' ? (
        <Text style={styles.issueError}>
          We couldn&apos;t send your report. Check your connection and try again.
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={!valid || stage === 'sending'}
        onPress={submit}
        style={({ pressed }) => [
          styles.issueSubmit,
          (!valid || stage === 'sending') && styles.issueSubmitDisabled,
          pressed && styles.pressed,
        ]}
      >
        {stage === 'sending' ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Text style={styles.issueSubmitText}>Send report</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  scroll: { paddingBottom: spacing['6xl'] },
  pressed: { opacity: 0.7 },

  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    minHeight: 44,
  },
  backButton: { width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center' },
  navTitle: { ...typography.bodyBold, color: colors.text },

  summaryBlock: { paddingHorizontal: spacing['2xl'], paddingTop: spacing.md },
  summaryDate: { ...typography.h3, color: colors.text },
  summaryStatus: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  summaryCancelReason: { ...typography.small, color: colors.textMuted, marginTop: 2 },

  routeBlock: { paddingHorizontal: spacing['2xl'], marginTop: spacing.xl },
  routeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  routeDotSolid: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.black,
    marginTop: 6,
  },
  routeDotHollow: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.black,
    backgroundColor: colors.white,
    marginTop: 6,
  },
  routeLine: {
    width: 2,
    height: 18,
    backgroundColor: colors.gray300,
    marginLeft: 4,
    marginVertical: 2,
  },
  routeAddress: { ...typography.body, color: colors.text, flex: 1 },

  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing['2xl'],
    marginTop: spacing.lg,
  },
  statText: { ...typography.caption, color: colors.textSecondary },
  statDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: colors.gray400 },

  sectionTitle: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing['2xl'],
    marginTop: spacing['3xl'],
    marginBottom: spacing.sm,
  },
  sectionTitleInline: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  },
  card: {
    marginHorizontal: spacing['2xl'],
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.lg,
  },
  timelineRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.lg,
  },
  timelineLabel: { ...typography.caption, color: colors.textSecondary },
  timelineTime: { ...typography.captionBold, color: colors.text },

  earningsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.lg,
  },
  earningsLabel: { ...typography.caption, color: colors.textSecondary, flex: 1 },
  earningsValue: { ...typography.caption, color: colors.text },
  earningsTotalRow: { borderBottomWidth: 0 },
  earningsTotalLabel: { ...typography.bodyBold, color: colors.text },
  earningsTotalValue: { ...typography.bodyBold, color: colors.text },

  issueOpenButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing['2xl'],
    marginTop: spacing['3xl'],
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    minHeight: 52,
  },
  issueOpenText: { ...typography.bodyBold, color: colors.text, flex: 1 },
  issueForm: { marginHorizontal: spacing['2xl'], marginTop: spacing['3xl'] },
  issueCategories: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  issueChip: {
    minHeight: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  issueChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  issueChipText: { ...typography.captionBold, color: colors.textSecondary },
  issueChipTextSelected: { color: colors.white },
  issueInput: {
    ...typography.body,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    minHeight: 96,
    textAlignVertical: 'top',
    marginTop: spacing.md,
  },
  issueError: { ...typography.small, color: colors.statusCritical, marginTop: spacing.sm },
  issueSubmit: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    marginTop: spacing.md,
  },
  issueSubmitDisabled: { backgroundColor: colors.gray300 },
  issueSubmitText: { ...typography.bodyBold, color: colors.white },
  issueConfirm: {
    marginHorizontal: spacing['2xl'],
    marginTop: spacing['3xl'],
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.xl,
  },
  issueConfirmTitle: { ...typography.bodyBold, color: colors.text },
  issueConfirmBody: { ...typography.caption, color: colors.textSecondary, textAlign: 'center' },
});
