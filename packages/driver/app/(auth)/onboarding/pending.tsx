import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing } from '@/theme/spacing';

export default function PendingScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Text style={styles.icon}>{'\u23F3'}</Text>
        </View>
        <Text style={styles.title}>Application Submitted</Text>
        <Text style={styles.subtitle}>
          We’re reviewing your application. This usually takes 1-2 business
          days. We’ll notify you once your account is approved.
        </Text>
        <Text style={styles.note}>
          You can close the app — we’ll send you a push notification when
          your application status changes.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['3xl'],
  },
  iconContainer: {
    marginBottom: spacing['2xl'],
  },
  icon: { fontSize: 64 },
  title: { ...typography.h2, color: colors.text, marginBottom: spacing.md, textAlign: 'center' },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: spacing.xl,
  },
  note: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
});
