import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography } from '@/theme';
import { STEP_STATUS_LABEL, type StepStatus } from '@/lib/application-steps';
import { StepStatusIcon } from './StepStatusIcon';

interface StepListRowProps {
  title: string;
  status: StepStatus;
  /** Rejection reason / renewal note — shown in the critical tone. */
  detail?: string | null;
  /** "Usually reviewed within 24 hours." — shown while waiting on review. */
  reviewEstimate?: string | null;
  /** Draws the connector down to the next row; omit on the last row. */
  connector?: boolean;
  onPress?: () => void;
}

function statusColor(status: StepStatus): string {
  switch (status) {
    case 'approved':
      return colors.statusApproved;
    case 'action_needed':
      return colors.statusCritical;
    case 'not_started':
      return colors.textMuted;
    default:
      return colors.textSecondary;
  }
}

/**
 * One row of the vertical progress list: status glyph + hairline connector,
 * title, one status line. Deliberately small — the dashboard is a checklist,
 * not a stack of cards.
 */
export function StepListRow({
  title,
  status,
  detail,
  reviewEstimate,
  connector = false,
  onPress,
}: StepListRowProps) {
  const waiting = status === 'submitted' || status === 'under_review';
  const statusLine =
    status === 'action_needed' && detail
      ? detail
      : waiting && reviewEstimate
        ? `${STEP_STATUS_LABEL[status]} · ${reviewEstimate}`
        : STEP_STATUS_LABEL[status];

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${title}. ${STEP_STATUS_LABEL[status]}.`}
      style={({ pressed }) => [styles.row, pressed && onPress && styles.pressed]}
    >
      <View style={styles.iconColumn}>
        <StepStatusIcon status={status} />
        {connector ? <View style={styles.connector} /> : null}
      </View>
      <View style={styles.textColumn}>
        <Text style={styles.title}>{title}</Text>
        <Text style={[styles.status, { color: statusColor(status) }]} numberOfLines={2}>
          {statusLine}
        </Text>
      </View>
      {onPress ? (
        <Ionicons name="chevron-forward" size={16} color={colors.gray400} style={styles.chevron} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 56,
    gap: spacing.md,
  },
  pressed: { opacity: 0.6 },
  iconColumn: { width: 24, alignItems: 'center', paddingTop: 2 },
  connector: {
    flex: 1,
    width: StyleSheet.hairlineWidth * 2,
    backgroundColor: colors.gray200,
    marginTop: spacing.xs,
    marginBottom: -spacing.xs,
  },
  textColumn: { flex: 1, paddingBottom: spacing.lg, gap: 2 },
  title: { ...typography.bodyBold, color: colors.text },
  status: { ...typography.caption },
  chevron: { marginTop: 4 },
});
