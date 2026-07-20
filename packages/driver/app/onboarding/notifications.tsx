import React, { useCallback, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { Button } from '@/components/ui';
import { exitTask } from '@/lib/nav';
import { registerForPush } from '@/lib/register-push';
import { useOnboarding } from '@/providers/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const REASONS: { title: string; body: string }[] = [
  { title: 'Ride requests', body: 'Know the moment a rider needs you, even in the background.' },
  { title: 'Application updates', body: 'Hear right away when a step is approved or needs attention.' },
  { title: 'Safety alerts', body: 'Important safety information while you drive.' },
  { title: 'Earnings', body: 'Payout confirmations and weekly summaries.' },
];

export default function NotificationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { apiClient } = useOnboarding();
  const [status, setStatus] = useState<Notifications.PermissionStatus | null>(null);
  const [requesting, setRequesting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      Notifications.getPermissionsAsync()
        .then((res) => {
          if (alive) setStatus(res.status);
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, []),
  );

  const enable = async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      const res = await Notifications.requestPermissionsAsync();
      setStatus(res.status);
      if (res.status === 'granted') {
        // Idempotent — also runs on the dashboard once the driver is active.
        await registerForPush(apiClient);
        exitTask(router);
      }
    } finally {
      setRequesting(false);
    }
  };

  const denied = status === 'denied';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
      ]}
    >
      <Text style={styles.title}>Stay in the loop</Text>
      <Text style={styles.subtitle}>
        TAKEME uses notifications for the things that matter while you drive.
      </Text>

      <View style={styles.reasons}>
        {REASONS.map((reason) => (
          <View key={reason.title} style={styles.reasonCard}>
            <Text style={styles.reasonTitle}>{reason.title}</Text>
            <Text style={styles.reasonBody}>{reason.body}</Text>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        {denied ? (
          <>
            <Text style={styles.deniedText}>
              Notifications are currently off for TAKEME Driver. You can turn them on in Settings.
            </Text>
            <Button
              title="Open Settings"
              onPress={() => void Linking.openSettings()}
              fullWidth
              size="lg"
            />
          </>
        ) : (
          <Button
            title="Turn on notifications"
            onPress={() => void enable()}
            loading={requesting}
            fullWidth
            size="lg"
          />
        )}
        <Button title="Not now" variant="ghost" onPress={() => exitTask(router)} fullWidth />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  reasons: { marginTop: spacing['2xl'], gap: spacing.md },
  reasonCard: {
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.white,
    gap: spacing.xs,
  },
  reasonTitle: { ...typography.bodyBold, color: colors.text },
  reasonBody: { ...typography.caption, color: colors.textSecondary },
  actions: { marginTop: spacing['2xl'], gap: spacing.sm },
  deniedText: { ...typography.caption, color: colors.textSecondary, textAlign: 'center' },
});
