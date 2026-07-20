import React, { useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Input } from '@/components/ui';
import { ErrorView, LoadingView } from '@/components/onboarding';
import { useOnboarding, onboardingErrorMessage } from '@/providers/onboarding';
import type { OnboardingMarket } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

export default function MarketScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { markets, state, loading, error, refresh, updateApplication } = useOnboarding();
  const [query, setQuery] = useState('');
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return markets;
    return markets.filter((m) =>
      [m.displayName, m.city, m.regionCode, m.countryCode]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(q)),
    );
  }, [markets, query]);

  if (markets.length === 0) {
    if (loading) return <LoadingView label="Loading markets…" />;
    return <ErrorView message={error} onRetry={() => void refresh()} />;
  }

  const selectMarket = async (market: OnboardingMarket) => {
    if (submittingKey) return;
    setSubmitError(null);
    setSubmittingKey(market.key);
    try {
      await updateApplication({ marketKey: market.key });
      // A brand-new application still needs a path; an existing one goes home
      // to see its recomputed steps.
      if (state?.application?.applicantType) {
        router.replace('/onboarding');
      } else {
        router.replace('/onboarding/path');
      }
    } catch (err) {
      setSubmitError(onboardingErrorMessage(err));
    } finally {
      setSubmittingKey(null);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.header, { paddingTop: insets.top + spacing.xl }]}>
        <Text style={styles.title}>Where will you drive?</Text>
        <Text style={styles.subtitle}>
          Choose your market. Your activation steps depend on where you drive.
        </Text>
        <Input
          placeholder="Search by city or region"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel="Search markets"
          containerStyle={styles.search}
        />
        {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(m) => m.key}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing['3xl'] }]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={styles.empty}>No markets match your search.</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.displayName}${item.status === 'waitlisted' ? ', waitlist' : ''}`}
            disabled={submittingKey !== null}
            onPress={() => void selectMarket(item)}
            style={({ pressed }) => [
              styles.row,
              pressed && styles.rowPressed,
              submittingKey !== null && submittingKey !== item.key && styles.rowDimmed,
            ]}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{item.displayName}</Text>
              <Text style={styles.rowSubtitle}>
                {[item.city, item.regionCode].filter(Boolean).join(', ')}
              </Text>
            </View>
            {item.status === 'waitlisted' ? (
              <View style={styles.waitlistTag}>
                <Text style={styles.waitlistTagText}>Waitlist</Text>
              </View>
            ) : null}
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
        ListFooterComponent={
          <Text style={styles.footerNote}>
            Requirements vary by market. If your market changes later, your steps update with it.
          </Text>
        }
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  search: { marginTop: spacing.lg },
  error: { ...typography.caption, color: colors.statusCritical, marginTop: spacing.sm },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  empty: { ...typography.body, color: colors.textMuted, textAlign: 'center', marginTop: spacing['3xl'] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.white,
    gap: spacing.md,
  },
  rowPressed: { backgroundColor: colors.gray50 },
  rowDimmed: { opacity: 0.5 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { ...typography.bodyBold, color: colors.text },
  rowSubtitle: { ...typography.caption, color: colors.textSecondary },
  waitlistTag: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  waitlistTagText: { ...typography.small, color: colors.textSecondary },
  chevron: { ...typography.h3, color: colors.gray400 },
  footerNote: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
});
