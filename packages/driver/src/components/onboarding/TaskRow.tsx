import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { borderRadius, colors, spacing, typography } from '@/theme';
import type { RequirementStatus } from '@/types/onboarding';
import { StatusBadge, statusPresentation } from './StatusBadge';

interface TaskRowProps {
  title: string;
  summary?: string | null;
  status: RequirementStatus;
  /** Extra line under the summary — rejection reasons, renewal dates. */
  detail?: string | null;
  detailColor?: string;
  disabled?: boolean;
  disabledHint?: string;
  onPress?: () => void;
}

export function TaskRow({
  title,
  summary,
  status,
  detail,
  detailColor = colors.statusCritical,
  disabled = false,
  disabledHint,
  onPress,
}: TaskRowProps) {
  const { label } = statusPresentation(status);
  const tappable = !disabled && !!onPress;

  return (
    <Pressable
      onPress={tappable ? onPress : undefined}
      disabled={!tappable}
      accessibilityRole={tappable ? 'button' : undefined}
      accessibilityLabel={`${title}. ${label}.${disabled && disabledHint ? ` ${disabledHint}` : ''}`}
      style={({ pressed }) => [
        styles.row,
        pressed && tappable && styles.pressed,
        disabled && styles.dimmed,
      ]}
    >
      <View style={styles.textColumn}>
        <Text style={styles.title}>{title}</Text>
        {summary ? (
          <Text style={styles.summary} numberOfLines={2}>
            {summary}
          </Text>
        ) : null}
        {disabled && disabledHint ? <Text style={styles.hint}>{disabledHint}</Text> : null}
        {detail ? <Text style={[styles.detail, { color: detailColor }]}>{detail}</Text> : null}
        <StatusBadge status={status} />
      </View>
      {tappable ? <Text style={styles.chevron}>›</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    gap: spacing.md,
  },
  pressed: { backgroundColor: colors.gray50 },
  dimmed: { opacity: 0.55 },
  textColumn: { flex: 1, gap: spacing.xs },
  title: { ...typography.bodyBold, color: colors.text },
  summary: { ...typography.caption, color: colors.textSecondary },
  hint: { ...typography.caption, color: colors.textMuted },
  detail: { ...typography.caption },
  chevron: { ...typography.h3, color: colors.gray400, marginLeft: spacing.xs },
});
