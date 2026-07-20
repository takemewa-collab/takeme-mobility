import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { ApiError } from '@takeme/shared';
import { Button } from '@/components/ui';
import { ErrorView, LoadingView } from '@/components/onboarding';
import { useOnboarding, onboardingErrorMessage } from '@/providers/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const DEFAULT_DISCLOSURE_KEYS = ['background_check_disclosure', 'background_check_authorization'];

type TimelineStep = { label: string; done: boolean; current: boolean };

function timelineFor(status: string): TimelineStep[] {
  const normalized = status.toLowerCase();
  const complete = ['complete', 'completed', 'clear', 'passed', 'approved'].includes(normalized);
  const inReview = ['in_review', 'under_review', 'consider', 'review', 'processing'].includes(
    normalized,
  );
  return [
    { label: 'Submitted', done: true, current: !inReview && !complete },
    { label: 'In review', done: complete, current: inReview },
    { label: 'Complete', done: complete, current: complete },
  ];
}

export default function BackgroundCheckScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, loading, error, refresh, startBackgroundCheck } = useOnboarding();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [providerUnavailable, setProviderUnavailable] = useState(false);
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);

  const requirement = useMemo(
    () => state?.requirements.find((r) => r.category === 'background') ?? null,
    [state],
  );

  const disclosureKeys = useMemo(() => {
    const keys = requirement?.config.disclosure_keys;
    return keys && keys.length > 0 ? keys : DEFAULT_DISCLOSURE_KEYS;
  }, [requirement]);

  if (!state) {
    if (loading) return <LoadingView />;
    return <ErrorView message={error} onRetry={() => void refresh()} />;
  }

  const consents = state.consents;
  const backgroundCheck = state.backgroundCheck;
  const consentedAll = disclosureKeys.every((key) =>
    consents.some((c) => c.documentKey === key),
  );

  const openDisclosures = () => {
    router.push({ pathname: '/onboarding/legal', params: { keys: disclosureKeys.join(',') } });
  };

  const authorize = async () => {
    if (submitting) return;
    setSubmitError(null);
    setProviderUnavailable(false);
    setSubmitting(true);
    try {
      const res = await startBackgroundCheck();
      setInvitationUrl(res.invitationUrl);
      setProviderUnavailable(res.providerUnavailable);
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        // Disclosures not yet consented — read them first, then come back.
        openDisclosures();
      } else {
        setSubmitError(onboardingErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const activeInvitationUrl = invitationUrl ?? backgroundCheck?.invitationUrl ?? null;
  const started = backgroundCheck != null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
      ]}
    >
      <Text style={styles.title}>Background check</Text>
      <Text style={styles.subtitle}>
        A screening partner reviews your driving and criminal record. TAKEME never sees your Social
        Security number — it goes directly to the screening partner.
      </Text>

      <View style={styles.disclosureList}>
        {disclosureKeys.map((key) => {
          const consent = consents.find((c) => c.documentKey === key);
          const label = key
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`${label}. ${consent ? 'Accepted' : 'Review'}`}
              onPress={openDisclosures}
              style={({ pressed }) => [styles.disclosureRow, pressed && styles.rowPressed]}
            >
              <Text style={styles.disclosureLabel}>{label}</Text>
              {consent ? (
                <Text style={styles.acceptedText}>Accepted ✓</Text>
              ) : (
                <Text style={styles.reviewText}>Review ›</Text>
              )}
            </Pressable>
          );
        })}
      </View>

      {started && backgroundCheck ? (
        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>Your check</Text>
          <View style={styles.timeline}>
            {timelineFor(backgroundCheck.status).map((step) => (
              <View key={step.label} style={styles.timelineStep}>
                <View
                  style={[
                    styles.timelineDot,
                    (step.done || step.current) && styles.timelineDotActive,
                  ]}
                />
                <Text
                  style={[
                    styles.timelineLabel,
                    (step.done || step.current) && styles.timelineLabelActive,
                  ]}
                >
                  {step.label}
                </Text>
              </View>
            ))}
          </View>
          <Text style={styles.statusBody}>
            {backgroundCheck.provider
              ? `Handled by ${backgroundCheck.provider}.`
              : 'Handled by our screening partner.'}{' '}
            We&apos;ll notify you when there is an update.
          </Text>
        </View>
      ) : null}

      {providerUnavailable ? (
        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>Screening is briefly unavailable</Text>
          <Text style={styles.statusBody}>
            Our screening partner could not be reached. Your authorization is saved — try again in
            a little while.
          </Text>
        </View>
      ) : null}

      {submitError ? <Text style={styles.error}>{submitError}</Text> : null}

      <View style={styles.actions}>
        {activeInvitationUrl ? (
          <Button
            title="Continue with our screening partner"
            onPress={() => void WebBrowser.openBrowserAsync(activeInvitationUrl)}
            fullWidth
            size="lg"
          />
        ) : !started || providerUnavailable ? (
          <Button
            title={providerUnavailable ? 'Try again' : 'Authorize and start'}
            onPress={() => (consentedAll ? void authorize() : openDisclosures())}
            loading={submitting}
            fullWidth
            size="lg"
          />
        ) : null}
        <Button title="Back" variant="ghost" onPress={() => router.back()} fullWidth />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  disclosureList: { marginTop: spacing['2xl'], gap: spacing.sm },
  disclosureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  disclosureLabel: { ...typography.bodyBold, color: colors.text, flex: 1 },
  acceptedText: { ...typography.caption, color: colors.statusApproved },
  reviewText: { ...typography.captionBold, color: colors.text },
  statusCard: {
    marginTop: spacing.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.gray50,
    gap: spacing.md,
  },
  statusTitle: { ...typography.bodyBold, color: colors.text },
  statusBody: { ...typography.caption, color: colors.textSecondary },
  timeline: { flexDirection: 'row', justifyContent: 'space-between' },
  timelineStep: { alignItems: 'center', flex: 1, gap: spacing.xs },
  timelineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gray300 },
  timelineDotActive: { backgroundColor: colors.primary },
  timelineLabel: { ...typography.small, color: colors.textMuted },
  timelineLabelActive: { color: colors.text },
  error: { ...typography.caption, color: colors.statusCritical, marginTop: spacing.lg },
  actions: { marginTop: spacing['2xl'], gap: spacing.sm },
});
