import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatCurrency } from '@takeme/shared';
import type {
  EarningsResponse,
  IncentiveProgram,
  PayoutHistoryEntry,
  PayoutsResponse,
} from '@/types/driver-hub';
import {
  barFractions,
  breakdownRows,
  formatOnlineDuration,
  shortWeekday,
  weekRangeLabel,
  weekdayMonthDayLabel,
} from '@/lib/earnings-view';
import { HubError, HubLoading } from '@/components/hub/state-views';
import { StatusChip, type ChipTone } from '@/components/hub/status-chip';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius, hitSlop } from '@/theme/spacing';

export interface EarningsScreenProps {
  phase: 'loading' | 'error' | 'ready';
  earnings: EarningsResponse | null;
  payouts: PayoutsResponse | null;
  incentives: IncentiveProgram[];
  /** True while a week navigation request is in flight. */
  weekFetching: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  selectedDay: string | null;
  onSelectDay: (ymd: string | null) => void;
  onOpenCashOut: () => void;
  onViewDayTrips: (ymd: string) => void;
}

const CHART_HEIGHT = 120;

export function EarningsScreenView(props: EarningsScreenProps) {
  const { phase, earnings } = props;

  if (phase === 'loading' || (phase === 'ready' && !earnings)) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Text style={styles.header}>Earnings</Text>
        <HubLoading />
      </SafeAreaView>
    );
  }

  if (phase === 'error' || !earnings) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <Text style={styles.header}>Earnings</Text>
        <HubError
          title="Couldn't load your earnings"
          body="Check your connection and try again."
          onRetry={props.onRetry}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
      >
        <Text style={styles.header}>Earnings</Text>

        <TodayHero earnings={earnings} />
        <BalanceCard
          balances={earnings.balances}
          onOpenCashOut={props.onOpenCashOut}
        />
        {props.incentives.length > 0 ? <PromotionsSection programs={props.incentives} /> : null}
        <WeekSection
          earnings={earnings}
          weekFetching={props.weekFetching}
          onPrevWeek={props.onPrevWeek}
          onNextWeek={props.onNextWeek}
          selectedDay={props.selectedDay}
          onSelectDay={props.onSelectDay}
          onViewDayTrips={props.onViewDayTrips}
        />
        {props.payouts && props.payouts.history.length > 0 ? (
          <PayoutHistorySection history={props.payouts.history} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Today ───────────────────────────────────────────────────────────────────

function TodayHero({ earnings }: { earnings: EarningsResponse }) {
  const today = earnings.today;
  const tripCount = today.earnings.trips;
  const online = today.onlineSeconds;
  return (
    <View style={styles.heroWrap}>
      <Text style={styles.heroLabel}>Today</Text>
      <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit>
        {formatCurrency(today.earnings.grossUsd)}
      </Text>
      <View style={styles.heroStatsRow}>
        <Text style={styles.heroStat}>
          {tripCount} {tripCount === 1 ? 'trip' : 'trips'}
        </Text>
        {online != null ? (
          <>
            <View style={styles.heroDot} />
            <Text style={styles.heroStat}>{formatOnlineDuration(online)} online</Text>
          </>
        ) : null}
      </View>
      {online == null ? (
        <Text style={styles.heroFootnote}>Online-time tracking just started for your account.</Text>
      ) : null}
    </View>
  );
}

// ── Balance card ────────────────────────────────────────────────────────────

function BalanceCard({
  balances,
  onOpenCashOut,
}: {
  balances: EarningsResponse['balances'];
  onOpenCashOut: () => void;
}) {
  return (
    <View style={styles.balanceCard}>
      <Text style={styles.balanceLabel}>Available balance</Text>
      <Text style={styles.balanceAmount} numberOfLines={1} adjustsFontSizeToFit>
        {formatCurrency(balances.availableUsd)}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onOpenCashOut}
        style={({ pressed }) => [styles.cashOutButton, pressed && styles.pressed]}
      >
        <Text style={styles.cashOutText}>Cash out</Text>
      </Pressable>
      <View style={styles.balanceRows}>
        <BalanceRow label="Pending" value={balances.pendingUsd} hint="Settles after trips finalize" />
        {balances.inTransitUsd > 0 ? (
          <BalanceRow label="In transit" value={balances.inTransitUsd} hint="On its way to your bank" />
        ) : null}
        <BalanceRow label="Lifetime earnings" value={balances.lifetimeUsd} />
      </View>
    </View>
  );
}

function BalanceRow({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <View style={styles.balanceRow}>
      <View style={styles.balanceRowLeft}>
        <Text style={styles.balanceRowLabel}>{label}</Text>
        {hint ? <Text style={styles.balanceRowHint}>{hint}</Text> : null}
      </View>
      <Text style={styles.balanceRowValue}>{formatCurrency(value)}</Text>
    </View>
  );
}

// ── Week section ────────────────────────────────────────────────────────────

function WeekSection({
  earnings,
  weekFetching,
  onPrevWeek,
  onNextWeek,
  selectedDay,
  onSelectDay,
  onViewDayTrips,
}: {
  earnings: EarningsResponse;
  weekFetching: boolean;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  selectedDay: string | null;
  onSelectDay: (ymd: string | null) => void;
  onViewDayTrips: (ymd: string) => void;
}) {
  const week = earnings.week;
  const fractions = barFractions(week.days.map((d) => d.earnings.grossUsd));
  const emptyWeek = week.earnings.grossUsd === 0 && week.earnings.trips === 0;
  const selected = selectedDay ? week.days.find((d) => d.date === selectedDay) ?? null : null;
  const rows = breakdownRows(week.earnings);

  return (
    <View style={styles.section}>
      <View style={styles.weekNav}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous week"
          onPress={onPrevWeek}
          hitSlop={hitSlop}
          style={({ pressed }) => [styles.weekChevron, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.weekLabel}>{weekRangeLabel(week.start, week.end)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next week"
          onPress={onNextWeek}
          disabled={earnings.nav.nextAnchor == null}
          hitSlop={hitSlop}
          style={({ pressed }) => [styles.weekChevron, pressed && styles.pressed]}
        >
          <Ionicons
            name="chevron-forward"
            size={20}
            color={earnings.nav.nextAnchor == null ? colors.gray300 : colors.text}
          />
        </Pressable>
      </View>

      <View style={[styles.weekBody, weekFetching && styles.weekBodyFetching]}>
        <Text style={styles.weekTotal} numberOfLines={1} adjustsFontSizeToFit>
          {formatCurrency(week.earnings.grossUsd)}
        </Text>
        <Text style={styles.weekTotalCaption}>
          {emptyWeek
            ? 'No earnings this week yet'
            : `${week.earnings.trips} ${week.earnings.trips === 1 ? 'trip' : 'trips'}${
                week.onlineSeconds != null ? ` · ${formatOnlineDuration(week.onlineSeconds)} online` : ''
              }`}
        </Text>

        <View style={styles.chart}>
          {week.days.map((day, i) => {
            const isSelected = day.date === selectedDay;
            return (
              <Pressable
                key={day.date}
                accessibilityRole="button"
                accessibilityLabel={`${weekdayMonthDayLabel(day.date)}, ${formatCurrency(day.earnings.grossUsd)}`}
                onPress={() => onSelectDay(isSelected ? null : day.date)}
                style={styles.chartColumn}
              >
                <View style={styles.chartBarArea}>
                  {fractions[i] > 0 ? (
                    <View
                      style={[
                        styles.chartBar,
                        {
                          height: Math.max(3, Math.round(fractions[i] * CHART_HEIGHT)),
                          backgroundColor: isSelected ? colors.black : colors.gray300,
                        },
                      ]}
                    />
                  ) : null}
                </View>
                <Text style={[styles.chartDayLabel, isSelected && styles.chartDayLabelSelected]}>
                  {shortWeekday(day.date).slice(0, 1)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.chartBaseline} />

        {selected ? (
          <View style={styles.dayPanel}>
            <View style={styles.dayPanelHeader}>
              <Text style={styles.dayPanelTitle}>{weekdayMonthDayLabel(selected.date)}</Text>
              <Text style={styles.dayPanelAmount}>{formatCurrency(selected.earnings.grossUsd)}</Text>
            </View>
            {selected.earnings.trips > 0 ? (
              <>
                <Text style={styles.dayPanelCaption}>
                  {selected.earnings.trips} {selected.earnings.trips === 1 ? 'trip' : 'trips'} · net{' '}
                  {formatCurrency(selected.earnings.netUsd)}
                  {selected.earnings.tipsUsd > 0
                    ? ` · tips ${formatCurrency(selected.earnings.tipsUsd)}`
                    : ''}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onViewDayTrips(selected.date)}
                  style={({ pressed }) => [styles.dayPanelLink, pressed && styles.pressed]}
                >
                  <Text style={styles.dayPanelLinkText}>See trips</Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.text} />
                </Pressable>
              </>
            ) : (
              <Text style={styles.dayPanelCaption}>No trips this day</Text>
            )}
          </View>
        ) : null}

        <View style={styles.breakdown}>
          {rows.map((row) => (
            <View key={row.key} style={styles.breakdownRow}>
              <Text style={row.emphasized ? styles.breakdownLabelBold : styles.breakdownLabel}>
                {row.label}
              </Text>
              <Text style={row.emphasized ? styles.breakdownValueBold : styles.breakdownValue}>
                {formatCurrency(row.amountUsd)}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// ── Promotions ──────────────────────────────────────────────────────────────

function numberIn(obj: Record<string, unknown> | null, keys: string[]): number | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = Number(obj[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function PromotionsSection({ programs }: { programs: IncentiveProgram[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Promotions</Text>
      {programs.map((program) => (
        <ProgramRow key={program.id} program={program} />
      ))}
    </View>
  );
}

function ProgramRow({ program }: { program: IncentiveProgram }) {
  // Progress renders only when the program actually carries numeric
  // goal/progress data — nothing is invented for unknown program types.
  let progressLabel: string | null = null;
  let progressFraction: number | null = null;
  if (program.type === 'ride_count_goal') {
    const goal = numberIn(program.config, ['target_rides', 'rides', 'goal']);
    const done = numberIn(program.progress, ['rides', 'count', 'completed']);
    if (goal != null && goal > 0 && done != null) {
      progressLabel = `${Math.min(done, goal)} of ${goal} rides`;
      progressFraction = Math.min(1, done / goal);
    }
  } else if (program.type === 'time_window_bonus') {
    const done = numberIn(program.progress, ['rides', 'count', 'completed']);
    if (done != null && done > 0) progressLabel = `${done} qualifying ${done === 1 ? 'ride' : 'rides'}`;
  }
  return (
    <View style={styles.programRow}>
      <View style={styles.programHead}>
        <Text style={styles.programTitle} numberOfLines={2}>
          {program.title}
        </Text>
        {program.earnedUsd > 0 ? (
          <Text style={styles.programEarned}>{formatCurrency(program.earnedUsd)}</Text>
        ) : null}
      </View>
      {program.description ? (
        <Text style={styles.programBody} numberOfLines={3}>
          {program.description}
        </Text>
      ) : null}
      {progressFraction != null ? (
        <View style={styles.programTrack}>
          <View style={[styles.programFill, { width: `${Math.round(progressFraction * 100)}%` }]} />
        </View>
      ) : null}
      {progressLabel ? <Text style={styles.programProgressLabel}>{progressLabel}</Text> : null}
    </View>
  );
}

// ── Payout history ──────────────────────────────────────────────────────────

function payoutChip(entry: PayoutHistoryEntry): { label: string; tone: ChipTone } {
  switch (entry.status) {
    case 'paid':
      return { label: 'Paid', tone: 'approved' };
    case 'in_transit':
      return { label: 'In transit', tone: 'muted' };
    case 'pending':
      return { label: 'Processing', tone: 'muted' };
    case 'failed':
      return { label: 'Failed', tone: 'critical' };
    default:
      return { label: entry.status, tone: 'muted' };
  }
}

function payoutDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function PayoutHistorySection({ history }: { history: PayoutHistoryEntry[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Payout activity</Text>
      {history.map((entry) => {
        const chip = payoutChip(entry);
        const destination =
          entry.destination_brand && entry.destination_last4
            ? `${entry.destination_brand} ••${entry.destination_last4}`
            : null;
        return (
          <View key={entry.id} style={styles.payoutRow}>
            <View style={styles.payoutLeft}>
              <Text style={styles.payoutAmount}>{formatCurrency(entry.amount)}</Text>
              <Text style={styles.payoutMeta} numberOfLines={1}>
                {[payoutDateLabel(entry.created_at), destination, entry.speed === 'instant' ? 'Instant' : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {entry.fee != null && entry.fee > 0 && entry.net != null ? (
                <Text style={styles.payoutMeta}>
                  Fee {formatCurrency(entry.fee)} · you received {formatCurrency(entry.net)}
                </Text>
              ) : null}
              {(entry.status === 'in_transit' || entry.status === 'pending') && entry.expected_arrival ? (
                <Text style={styles.payoutMeta}>
                  Expected {payoutDateLabel(entry.expected_arrival)}
                </Text>
              ) : null}
              {entry.status === 'failed' && entry.failure_reason ? (
                <Text style={styles.payoutFailure} numberOfLines={2}>
                  {entry.failure_reason}
                </Text>
              ) : null}
            </View>
            <StatusChip label={chip.label} tone={chip.tone} />
          </View>
        );
      })}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingBottom: spacing['5xl'] },
  header: {
    ...typography.h2,
    color: colors.text,
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  pressed: { opacity: 0.7 },

  heroWrap: { paddingHorizontal: spacing['2xl'], paddingBottom: spacing['2xl'] },
  heroLabel: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  heroAmount: { ...typography.h1, fontSize: 44, lineHeight: 52, color: colors.text, marginTop: 2 },
  heroStatsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  heroStat: { ...typography.caption, color: colors.textSecondary },
  heroDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: colors.gray400 },
  heroFootnote: { ...typography.small, color: colors.textMuted, marginTop: spacing.xs },

  balanceCard: {
    marginHorizontal: spacing['2xl'],
    padding: spacing.xl,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.lg,
    marginBottom: spacing['3xl'],
  },
  balanceLabel: { ...typography.caption, color: colors.gray400 },
  balanceAmount: { ...typography.h1, color: colors.white, marginTop: 2 },
  cashOutButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderRadius: borderRadius.md,
    marginTop: spacing.lg,
  },
  cashOutText: { ...typography.bodyBold, color: colors.text },
  balanceRows: { marginTop: spacing.lg },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray700,
    gap: spacing.lg,
  },
  balanceRowLeft: { flex: 1 },
  balanceRowLabel: { ...typography.caption, color: colors.gray300 },
  balanceRowHint: { ...typography.small, color: colors.gray500, marginTop: 1 },
  balanceRowValue: { ...typography.captionBold, color: colors.white },

  section: { marginBottom: spacing['3xl'] },
  sectionTitle: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing['2xl'],
    marginBottom: spacing.sm,
  },

  weekNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
  },
  weekChevron: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekLabel: { ...typography.bodyBold, color: colors.text },
  weekBody: { paddingHorizontal: spacing['2xl'], paddingTop: spacing.md },
  weekBodyFetching: { opacity: 0.45 },
  weekTotal: { ...typography.h2, color: colors.text },
  weekTotalCaption: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },

  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  chartColumn: { flex: 1, alignItems: 'center' },
  chartBarArea: { height: CHART_HEIGHT, width: '100%', justifyContent: 'flex-end', alignItems: 'center' },
  chartBar: { width: '62%', borderRadius: 3 },
  chartDayLabel: { ...typography.small, color: colors.textMuted, marginTop: spacing.sm },
  chartDayLabelSelected: { color: colors.text, fontWeight: '700' },
  chartBaseline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.gray300,
    marginTop: -22,
    marginBottom: 22,
  },

  dayPanel: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
  },
  dayPanelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dayPanelTitle: { ...typography.captionBold, color: colors.text },
  dayPanelAmount: { ...typography.bodyBold, color: colors.text },
  dayPanelCaption: { ...typography.small, color: colors.textSecondary, marginTop: 2 },
  dayPanelLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: spacing.sm,
    minHeight: 44,
  },
  dayPanelLinkText: { ...typography.captionBold, color: colors.text },

  breakdown: { marginTop: spacing.xl },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.lg,
  },
  breakdownLabel: { ...typography.body, color: colors.textSecondary },
  breakdownValue: { ...typography.body, color: colors.text },
  breakdownLabelBold: { ...typography.bodyBold, color: colors.text },
  breakdownValueBold: { ...typography.bodyBold, color: colors.text },

  programRow: {
    marginHorizontal: spacing['2xl'],
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  programHead: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg },
  programTitle: { ...typography.bodyBold, color: colors.text, flex: 1 },
  programEarned: { ...typography.bodyBold, color: colors.text },
  programBody: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
  programTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.gray200,
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  programFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  programProgressLabel: { ...typography.small, color: colors.textSecondary, marginTop: spacing.xs },

  payoutRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing['2xl'],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  payoutLeft: { flex: 1 },
  payoutAmount: { ...typography.bodyBold, color: colors.text },
  payoutMeta: { ...typography.small, color: colors.textSecondary, marginTop: 1 },
  payoutFailure: { ...typography.small, color: colors.statusCritical, marginTop: 2 },
});
