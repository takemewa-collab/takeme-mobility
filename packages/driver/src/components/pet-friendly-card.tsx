import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

/**
 * Compact instruction line shown on trip screens when the ride carries the
 * pet_friendly preference. Note: women_preferred deliberately has NO driver-
 * facing indicator anywhere — do not add one here.
 */
export function PetFriendlyCard() {
  return (
    <View style={styles.card}>
      <Text style={styles.text}>
        <Text style={styles.bold}>Pet Friendly</Text>
        {' · Rider brings a household pet — a blanket or carrier is recommended.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.gray50,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
  },
  text: { ...typography.small, color: colors.textSecondary },
  bold: { ...typography.small, fontWeight: '600', color: colors.text },
});
