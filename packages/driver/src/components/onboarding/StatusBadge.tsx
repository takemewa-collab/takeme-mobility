import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/theme';
import type { RequirementStatus } from '@/types/onboarding';

/**
 * Status is never conveyed by colour alone — every badge pairs a tinted dot
 * with a text label. The three status hues are reserved for exactly this.
 */
export function statusPresentation(status: RequirementStatus): {
  label: string;
  color: string;
} {
  switch (status) {
    case 'approved':
      return { label: 'Approved', color: colors.statusApproved };
    case 'waived':
      return { label: 'Waived', color: colors.statusApproved };
    case 'submitted':
    case 'under_review':
      return { label: 'In review', color: colors.gray600 };
    case 'needs_action':
      return { label: 'Action needed', color: colors.statusCritical };
    case 'rejected':
      return { label: 'Rejected', color: colors.statusCritical };
    case 'expired':
      return { label: 'Expired', color: colors.statusCritical };
    case 'expiring_soon':
      return { label: 'Expiring soon', color: colors.statusWarning };
    case 'in_progress':
      return { label: 'In progress', color: colors.gray600 };
    case 'blocked':
      return { label: 'Locked', color: colors.gray400 };
    case 'not_applicable':
      return { label: 'Not needed', color: colors.gray400 };
    case 'not_started':
    default:
      return { label: 'To do', color: colors.gray500 };
  }
}

export function StatusBadge({ status }: { status: RequirementStatus }) {
  const { label, color } = statusPresentation(status);
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { ...typography.caption },
});
