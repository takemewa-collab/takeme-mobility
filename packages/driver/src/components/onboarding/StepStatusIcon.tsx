import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme';
import type { StepStatus } from '@/lib/application-steps';

const SIZE = 24;

/**
 * One glyph per dashboard status. Approved is the only green in the flow —
 * a quiet check, exactly as the design system reserves hue for status.
 */
export function StepStatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'approved':
      return (
        <View style={[styles.circle, styles.approved]}>
          <Ionicons name="checkmark" size={14} color={colors.statusApproved} />
        </View>
      );
    case 'action_needed':
      return (
        <View style={[styles.circle, styles.action]}>
          <Ionicons name="alert" size={13} color={colors.statusCritical} />
        </View>
      );
    case 'submitted':
    case 'under_review':
      return (
        <View style={[styles.circle, styles.waiting]}>
          <Ionicons name="time-outline" size={14} color={colors.gray600} />
        </View>
      );
    case 'in_progress':
      return (
        <View style={[styles.circle, styles.inProgress]}>
          <View style={styles.inProgressDot} />
        </View>
      );
    case 'not_started':
    default:
      return <View style={[styles.circle, styles.notStarted]} />;
  }
}

const styles = StyleSheet.create({
  circle: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approved: { backgroundColor: 'rgba(19, 122, 63, 0.10)' },
  action: { backgroundColor: 'rgba(179, 38, 30, 0.10)' },
  waiting: { backgroundColor: colors.gray100 },
  inProgress: { borderWidth: 1.5, borderColor: colors.text },
  inProgressDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.text },
  notStarted: { borderWidth: 1.5, borderColor: colors.gray300 },
});
