import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/theme';
import { ProgressHeader } from './ProgressHeader';

/**
 * The detail screens' simple progress indicator: "Step 3 of 8" over a thin
 * bar. `current` is 1-based; renders nothing when the position is unknown
 * (deep link before state loads) so screens never show a wrong number.
 */
export function StepProgress({ current, total }: { current: number | null; total: number }) {
  if (current == null || total <= 0) return null;
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        Step {current} of {total}
      </Text>
      <ProgressHeader fraction={current / total} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, marginBottom: spacing.lg },
  label: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontSize: 12,
    lineHeight: 16,
  },
});
