import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export type ChipTone = 'neutral' | 'muted' | 'approved' | 'warning' | 'critical';

const TONE_TEXT: Record<ChipTone, string> = {
  neutral: colors.text,
  muted: colors.textSecondary,
  approved: colors.statusApproved,
  warning: colors.statusWarning,
  critical: colors.statusCritical,
};

/**
 * Small bordered status label. Status hues appear ONLY here (text + dot),
 * always paired with a label — never conveyed by colour alone.
 */
export function StatusChip({ label, tone = 'neutral' }: { label: string; tone?: ChipTone }) {
  return (
    <View style={styles.chip}>
      <View style={[styles.dot, { backgroundColor: TONE_TEXT[tone] }]} />
      <Text style={[styles.label, { color: TONE_TEXT[tone] }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { ...typography.small, fontWeight: '600' },
});
