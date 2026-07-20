import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors, spacing, typography } from '@/theme';

export function SectionHeader({ title }: { title: string }) {
  return (
    <Text accessibilityRole="header" style={styles.header}>
      {title}
    </Text>
  );
}

const styles = StyleSheet.create({
  header: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontSize: 12,
    lineHeight: 16,
    marginTop: spacing['2xl'],
    marginBottom: spacing.sm,
  },
});
