import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * Shared loading / error / empty surfaces for the driver hub screens.
 * Monochrome, quiet, and honest: the error state always offers a retry, and
 * skeleton blocks stand in only where real data will render.
 */

export function SkeletonBlock({
  width,
  height,
  radius = borderRadius.sm,
  style,
}: {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: object;
}) {
  return <View style={[{ width, height, borderRadius: radius, backgroundColor: colors.gray100 }, style]} />;
}

/** Generic screen skeleton: header line + card + list rows. */
export function HubLoading({ testID }: { testID?: string }) {
  return (
    <View style={styles.loadingWrap} testID={testID} accessibilityLabel="Loading">
      <SkeletonBlock width="55%" height={34} />
      <SkeletonBlock width="35%" height={16} style={{ marginTop: spacing.md }} />
      <SkeletonBlock width="100%" height={128} radius={borderRadius.lg} style={{ marginTop: spacing['2xl'] }} />
      <SkeletonBlock width="100%" height={20} style={{ marginTop: spacing['2xl'] }} />
      <SkeletonBlock width="100%" height={20} style={{ marginTop: spacing.lg }} />
      <SkeletonBlock width="70%" height={20} style={{ marginTop: spacing.lg }} />
    </View>
  );
}

export function HubError({
  title = "Couldn't load this screen",
  body = 'Check your connection and try again.',
  onRetry,
}: {
  title?: string;
  body?: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.centerWrap}>
      <Ionicons name="cloud-offline-outline" size={32} color={colors.gray500} />
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateBody}>{body}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

export function HubEmpty({
  icon,
  title,
  body,
}: {
  icon: IoniconName;
  title: string;
  body?: string;
}) {
  return (
    <View style={styles.centerWrap}>
      <Ionicons name={icon} size={32} color={colors.gray400} />
      <Text style={styles.stateTitle}>{title}</Text>
      {body ? <Text style={styles.stateBody}>{body}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing.lg,
  },
  centerWrap: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['3xl'],
    gap: spacing.sm,
  },
  stateTitle: { ...typography.h3, color: colors.text, textAlign: 'center', marginTop: spacing.sm },
  stateBody: { ...typography.caption, color: colors.textSecondary, textAlign: 'center' },
  retryButton: {
    minHeight: 48,
    minWidth: 160,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    marginTop: spacing.lg,
  },
  pressed: { opacity: 0.85 },
  retryText: { ...typography.bodyBold, color: colors.white },
});
