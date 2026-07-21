import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  LayoutAnimation,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
} from 'react-native';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { decideDestination } from '@/lib/activation-route';
import {
  deriveApplicationSteps,
  combineStatuses,
  type ApplicationStep,
} from '@/lib/application-steps';
import { hrefForRequirement } from '@/lib/onboarding-routes';
import { Button } from '@/components/ui';
import {
  ErrorView,
  LoadingView,
  ProgressHeader,
  StepListRow,
} from '@/components/onboarding';
import { useAuth } from '@/providers/auth';
import { useOnboarding } from '@/providers/onboarding';
import type { OnboardingRequirement } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * The application dashboard. One prominent next step, a quiet progress line,
 * and the full checklist tucked behind "View all steps" — a first-time driver
 * should never have to decide what to do next.
 */
export default function ApplicationDashboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    state,
    loading,
    error,
    refresh,
    marketChangeNotice,
    dismissMarketChangeNotice,
  } = useOnboarding();
  const { signOut, user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [notifStatus, setNotifStatus] = useState<Notifications.PermissionStatus | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      Notifications.getPermissionsAsync()
        .then((res) => {
          if (alive) setNotifStatus(res.status);
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, []),
  );

  // The notice is one-shot: visible on the first index render after a market
  // change, cleared when the driver leaves the screen.
  useEffect(() => {
    return () => {
      if (marketChangeNotice) dismissMarketChangeNotice();
    };
  }, [marketChangeNotice, dismissMarketChangeNotice]);

  const onAccountMenu = useCallback(() => {
    Alert.alert('Account', user?.phone ?? user?.email ?? undefined, [
      { text: 'Contact support', onPress: () => void Linking.openURL('mailto:support@takememobility.com') },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [signOut, user]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const derived = useMemo(() => (state ? deriveApplicationSteps(state) : null), [state]);

  if (!state) {
    if (loading) return <LoadingView label="Loading your application…" />;
    return <ErrorView message={error} onRetry={() => void refresh()} />;
  }

  if (decideDestination(state) === 'dashboard') {
    return <Redirect href="/(app)/(tabs)/dashboard" />;
  }

  if (!state.application) {
    return <Redirect href="/onboarding/market" />;
  }

  const applicationRejected = state.application.status === 'rejected';
  const suspended =
    state.activation.decision === 'suspended' || state.application.status === 'suspended';
  const halted = applicationRejected || suspended;

  const steps = derived?.steps ?? [];
  const nextStep = derived?.nextStep ?? null;
  const completedCount = derived?.completedCount ?? 0;
  const totalCount = derived?.totalCount ?? 0;

  const openStep = (step: ApplicationStep) => {
    if (step.blocked) {
      Alert.alert(step.title, 'This step unlocks once the steps before it are complete.');
      return;
    }
    if (step.href) router.push(step.href);
  };

  const openOptional = (req: OnboardingRequirement) => {
    const href = hrefForRequirement(req);
    if (href) {
      router.push(href);
    } else if (req.externalUrl) {
      void Linking.openURL(req.externalUrl);
    }
  };

  const toggleSteps = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setStepsExpanded((v) => !v);
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
        ]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.title}>Your application</Text>
            {state.market ? <Text style={styles.marketName}>{state.market.displayName}</Text> : null}
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Help"
              onPress={() => void Linking.openURL('mailto:support@takememobility.com')}
              style={({ pressed }) => [styles.headerAction, pressed && styles.headerActionPressed]}
            >
              <Ionicons name="help-circle-outline" size={24} color={colors.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Account"
              onPress={onAccountMenu}
              style={({ pressed }) => [styles.headerAction, pressed && styles.headerActionPressed]}
            >
              <Ionicons name="person-circle-outline" size={24} color={colors.text} />
            </Pressable>
          </View>
        </View>

        {totalCount > 0 ? (
          <View style={styles.progressBlock}>
            <Text style={styles.progressText}>
              {completedCount} of {totalCount} steps completed
            </Text>
            <ProgressHeader fraction={totalCount > 0 ? completedCount / totalCount : 0} />
          </View>
        ) : null}

        {marketChangeNotice ? (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>Your steps were updated for {marketChangeNotice}.</Text>
          </View>
        ) : null}

        {applicationRejected ? (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeTitle}>Your application was not approved</Text>
            <Text style={styles.noticeText}>
              After review, we are unable to approve your application at this time. If you believe
              this is a mistake, our team can take another look.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void Linking.openURL('mailto:support@takememobility.com')}
              style={styles.supportLink}
            >
              <Text style={styles.supportLinkText}>Contact support</Text>
            </Pressable>
          </View>
        ) : suspended ? (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeTitle}>Your account is suspended</Text>
            <Text style={styles.noticeText}>
              Driving is paused while we review your account. We will notify you when there is an
              update. If you have questions, contact support.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void Linking.openURL('mailto:support@takememobility.com')}
              style={styles.supportLink}
            >
              <Text style={styles.supportLinkText}>Contact support</Text>
            </Pressable>
          </View>
        ) : nextStep ? (
          <View style={styles.nextCard}>
            <Text
              style={[
                styles.nextLabel,
                nextStep.status === 'action_needed' && styles.nextLabelCritical,
              ]}
            >
              {nextStep.status === 'action_needed' ? 'Action needed' : 'Next step'}
            </Text>
            <Text style={styles.nextTitle}>{nextStep.title}</Text>
            <Text style={styles.nextSummary}>
              {nextStep.status === 'action_needed' && nextStep.detail
                ? nextStep.detail
                : nextStep.explanation}
            </Text>
            <View style={styles.nextMeta}>
              <Ionicons name="time-outline" size={14} color={colors.textMuted} />
              <Text style={styles.nextMetaText}>{nextStep.estimatedTime}</Text>
            </View>
            <Button
              title={nextStep.status === 'action_needed' ? 'Fix this step' : 'Continue'}
              onPress={() => openStep(nextStep)}
              fullWidth
              size="lg"
              style={styles.nextButton}
            />
          </View>
        ) : (
          <View style={styles.nextCard}>
            <Text style={styles.nextLabel}>In review</Text>
            <Text style={styles.nextTitle}>Nothing to do right now</Text>
            <Text style={styles.nextSummary}>
              We&apos;re reviewing your submissions and will notify you the moment anything needs
              your attention.
            </Text>
            <Button
              title="View application status"
              onPress={() => router.push('/onboarding/review')}
              fullWidth
              size="lg"
              style={styles.nextButton}
            />
          </View>
        )}

        {!halted && notifStatus === 'undetermined' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Turn on notifications"
            onPress={() => router.push('/onboarding/notifications')}
            style={({ pressed }) => [styles.notifRow, pressed && styles.notifRowPressed]}
          >
            <Ionicons name="notifications-outline" size={18} color={colors.text} />
            <View style={styles.notifText}>
              <Text style={styles.notifTitle}>Turn on notifications</Text>
              <Text style={styles.notifBody}>Hear right away when a step is approved.</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.gray400} />
          </Pressable>
        ) : null}

        {steps.length > 0 ? (
          <View style={styles.allSteps}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={stepsExpanded ? 'Hide all steps' : 'View all steps'}
              accessibilityState={{ expanded: stepsExpanded }}
              onPress={toggleSteps}
              style={({ pressed }) => [styles.allStepsHeader, pressed && styles.notifRowPressed]}
            >
              <Text style={styles.allStepsTitle}>
                {stepsExpanded ? 'Hide all steps' : 'View all steps'}
              </Text>
              <Ionicons
                name={stepsExpanded ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.textSecondary}
              />
            </Pressable>

            {stepsExpanded ? (
              <View style={styles.stepList}>
                {steps.map((step, index) => (
                  <StepListRow
                    key={`${step.key}-${index}`}
                    title={step.title}
                    status={step.status}
                    detail={step.detail}
                    reviewEstimate={step.reviewEstimate}
                    connector
                    onPress={() => openStep(step)}
                  />
                ))}
                {derived ? (
                  <StepListRow
                    title={derived.reviewStep.title}
                    status={derived.reviewStep.status}
                    onPress={() => router.push('/onboarding/review')}
                  />
                ) : null}

                {derived && derived.optional.length > 0 ? (
                  <View style={styles.optionalBlock}>
                    <Text style={styles.optionalHeader}>Optional</Text>
                    {derived.optional.map((req, index) => (
                      <StepListRow
                        key={req.key}
                        title={req.title}
                        status={combineStatuses([req.status])}
                        connector={index < derived.optional.length - 1}
                        onPress={() => openOptional(req)}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headerText: { flex: 1 },
  title: { ...typography.h1, color: colors.text },
  marketName: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  headerActions: { flexDirection: 'row', gap: spacing.xs, marginTop: 2 },
  headerAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  headerActionPressed: { backgroundColor: colors.gray100 },
  progressBlock: { marginTop: spacing['2xl'], gap: spacing.sm },
  progressText: { ...typography.captionBold, color: colors.text },
  noticeCard: {
    marginTop: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.xl,
    padding: spacing.xl,
    backgroundColor: colors.gray50,
    gap: spacing.sm,
  },
  noticeTitle: { ...typography.bodyBold, color: colors.text },
  noticeText: { ...typography.caption, color: colors.textSecondary },
  supportLink: { minHeight: 44, justifyContent: 'center' },
  supportLinkText: { ...typography.captionBold, color: colors.text },
  nextCard: {
    marginTop: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.xl,
    padding: spacing.xl,
    backgroundColor: colors.white,
    gap: spacing.xs,
  },
  nextLabel: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontSize: 12,
    lineHeight: 16,
  },
  nextLabelCritical: { color: colors.statusCritical },
  nextTitle: { ...typography.h3, color: colors.text, marginTop: spacing.xs },
  nextSummary: { ...typography.caption, color: colors.textSecondary },
  nextMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  nextMetaText: { ...typography.caption, color: colors.textMuted },
  nextButton: { marginTop: spacing.lg },
  notifRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.white,
  },
  notifRowPressed: { backgroundColor: colors.gray50 },
  notifText: { flex: 1, gap: 1 },
  notifTitle: { ...typography.captionBold, color: colors.text },
  notifBody: { ...typography.small, color: colors.textSecondary },
  allSteps: { marginTop: spacing['2xl'] },
  allStepsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  allStepsTitle: { ...typography.bodyBold, color: colors.text },
  stepList: { marginTop: spacing.lg, paddingHorizontal: spacing.xs },
  optionalBlock: { marginTop: spacing.md },
  optionalHeader: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontSize: 12,
    lineHeight: 16,
    marginBottom: spacing.lg,
  },
});
