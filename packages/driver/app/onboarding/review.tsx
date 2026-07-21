import React, { useCallback, useMemo, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deriveApplicationSteps,
  type ApplicationStep,
} from '@/lib/application-steps';
import {
  ErrorView,
  LoadingView,
  SectionHeader,
  StepListRow,
} from '@/components/onboarding';
import { useOnboarding } from '@/providers/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

/**
 * Final review: the whole application at a glance, split into what still
 * needs the driver, what TAKEME is reviewing, and what's done. No actions
 * are duplicated here — each row deep-links back to its step.
 */
export default function FinalReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, loading, error, refresh } = useOnboarding();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const derived = useMemo(() => (state ? deriveApplicationSteps(state) : null), [state]);

  if (!state || !derived) {
    if (loading) return <LoadingView />;
    return <ErrorView message={error} onRetry={() => void refresh()} />;
  }

  const actionRequired = derived.steps.filter((s) => s.status === 'action_needed');
  const underReview = derived.steps.filter(
    (s) => s.status === 'submitted' || s.status === 'under_review',
  );
  const completed = derived.steps.filter((s) => s.status === 'approved');
  const notStarted = derived.steps.filter(
    (s) => s.status === 'not_started' || s.status === 'in_progress',
  );

  const allDone = completed.length === derived.totalCount && derived.totalCount > 0;
  const summary = allDone
    ? 'Every step is approved. We’re finalizing your activation — you’ll be notified the moment you can drive.'
    : actionRequired.length > 0
      ? 'A few items need your attention before we can finish reviewing your application.'
      : underReview.length > 0
        ? 'Nothing else is needed from you right now. We’ll notify you as each review completes.'
        : 'Finish the remaining steps and we’ll start reviewing your application.';

  const openStep = (step: ApplicationStep) => {
    if (step.href) router.push(step.href);
  };

  const renderRows = (steps: ApplicationStep[]) =>
    steps.map((step, index) => (
      <StepListRow
        key={`${step.key}-${index}`}
        title={step.title}
        status={step.status}
        detail={step.detail}
        reviewEstimate={step.reviewEstimate}
        connector={index < steps.length - 1}
        onPress={() => openStep(step)}
      />
    ));

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <View style={styles.summaryCard}>
        <Text style={styles.summaryProgress}>
          {derived.completedCount} of {derived.totalCount} steps completed
        </Text>
        <Text style={styles.summaryText}>{summary}</Text>
      </View>

      {actionRequired.length > 0 ? (
        <>
          <SectionHeader title="Action required" />
          <View style={styles.group}>{renderRows(actionRequired)}</View>
        </>
      ) : null}

      {notStarted.length > 0 ? (
        <>
          <SectionHeader title="Still to do" />
          <View style={styles.group}>{renderRows(notStarted)}</View>
        </>
      ) : null}

      {underReview.length > 0 ? (
        <>
          <SectionHeader title="Under review" />
          <View style={styles.group}>{renderRows(underReview)}</View>
        </>
      ) : null}

      {completed.length > 0 ? (
        <>
          <SectionHeader title="Completed" />
          <View style={styles.group}>{renderRows(completed)}</View>
        </>
      ) : null}

      <Pressable
        accessibilityRole="button"
        onPress={() => void Linking.openURL('mailto:support@takememobility.com')}
        style={styles.supportLink}
      >
        <Text style={styles.supportLinkText}>Questions? Contact support</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  summaryCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.xl,
    padding: spacing.xl,
    backgroundColor: colors.gray50,
    gap: spacing.xs,
  },
  summaryProgress: { ...typography.bodyBold, color: colors.text },
  summaryText: { ...typography.caption, color: colors.textSecondary },
  group: { paddingHorizontal: spacing.xs },
  supportLink: { minHeight: 44, justifyContent: 'center', marginTop: spacing.xl },
  supportLinkText: { ...typography.captionBold, color: colors.textSecondary, textAlign: 'center' },
});
