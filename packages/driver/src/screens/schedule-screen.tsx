import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export interface ScheduleScreenProps {
  /** Live driver status — the one real piece of state this tab reflects. */
  online: boolean;
  onGoToHome: () => void;
  onOpenAlertSettings: () => void;
}

/**
 * The Schedule tab is deliberately honest: the platform has no scheduled-ride
 * or availability backend yet, so the primary surface explains what will live
 * here — clearly labeled as coming later — and the only interactive elements
 * are real ones (current status, alert settings). Nothing here fakes data.
 */
export function ScheduleScreenView(props: ScheduleScreenProps) {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.header}>Schedule</Text>

        <View style={styles.comingCard}>
          <View style={styles.comingBadge}>
            <Text style={styles.comingBadgeText}>Coming later</Text>
          </View>
          <Ionicons name="calendar-outline" size={32} color={colors.text} style={styles.comingIcon} />
          <Text style={styles.comingTitle}>Scheduled rides are coming</Text>
          <Text style={styles.comingBody}>
            When riders in your area can book trips ahead of time, their reservations will appear
            here — you&apos;ll be able to claim rides that fit your day before you even go online.
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Today</Text>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: props.online ? colors.statusApproved : colors.gray400 },
            ]}
          />
          <View style={styles.statusTextWrap}>
            <Text style={styles.statusTitle}>{props.online ? "You're online" : "You're offline"}</Text>
            <Text style={styles.statusBody}>
              {props.online
                ? 'Ride requests near you will reach you as they come in.'
                : 'Go online from the Home tab when you want to receive requests.'}
            </Text>
          </View>
          {!props.online ? (
            <Pressable
              accessibilityRole="button"
              onPress={props.onGoToHome}
              style={({ pressed }) => [styles.statusAction, pressed && styles.pressed]}
            >
              <Text style={styles.statusActionText}>Home</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.text} />
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.sectionTitle}>Be ready</Text>
        <Pressable
          accessibilityRole="button"
          onPress={props.onOpenAlertSettings}
          style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
        >
          <Ionicons name="notifications-outline" size={20} color={colors.text} />
          <View style={styles.linkTextWrap}>
            <Text style={styles.linkTitle}>Ride request alerts</Text>
            <Text style={styles.linkBody}>
              Check your alert sound and notification settings so you never miss a request.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.gray400} />
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingBottom: spacing['5xl'] },
  header: {
    ...typography.h2,
    color: colors.text,
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  pressed: { opacity: 0.7 },

  comingCard: {
    marginHorizontal: spacing['2xl'],
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    padding: spacing['2xl'],
    alignItems: 'center',
    marginBottom: spacing['3xl'],
  },
  comingBadge: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    alignSelf: 'center',
  },
  comingBadgeText: {
    ...typography.small,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  comingIcon: { marginTop: spacing.xl },
  comingTitle: { ...typography.h3, color: colors.text, marginTop: spacing.md, textAlign: 'center' },
  comingBody: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },

  sectionTitle: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing['2xl'],
    marginBottom: spacing.sm,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    marginBottom: spacing['3xl'],
    minHeight: 56,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusTextWrap: { flex: 1 },
  statusTitle: { ...typography.bodyBold, color: colors.text },
  statusBody: { ...typography.small, color: colors.textSecondary, marginTop: 1 },
  statusAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  statusActionText: { ...typography.captionBold, color: colors.text },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  linkTextWrap: { flex: 1 },
  linkTitle: { ...typography.body, color: colors.text },
  linkBody: { ...typography.small, color: colors.textSecondary, marginTop: 1 },
});
