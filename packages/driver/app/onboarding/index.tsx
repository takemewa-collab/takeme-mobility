import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { decideDestination } from '@/lib/activation-route';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { Button } from '@/components/ui';
import {
  ErrorView,
  LoadingView,
  ProgressHeader,
  SectionHeader,
  TaskRow,
} from '@/components/onboarding';
import { useOnboarding } from '@/providers/onboarding';
import { hrefForRequirement } from '@/lib/onboarding-routes';
import type { OnboardingRequirement, RequirementStatus } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const ACTION_STATUSES: RequirementStatus[] = [
  'not_started',
  'in_progress',
  'needs_action',
  'rejected',
  'expired',
  'expiring_soon',
];
const REVIEW_STATUSES: RequirementStatus[] = ['submitted', 'under_review'];
const DONE_STATUSES: RequirementStatus[] = ['approved', 'waived'];

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function detailFor(req: OnboardingRequirement): { text: string; color: string } | null {
  if (req.status === 'rejected' || req.status === 'needs_action') {
    const reason = req.rejectionReason ?? req.reviewNote;
    if (reason) return { text: reason, color: colors.statusCritical };
    return null;
  }
  if (req.status === 'expiring_soon' && req.expiresAt) {
    return { text: `Renew by ${formatDate(req.expiresAt)}`, color: colors.statusWarning };
  }
  if (req.status === 'expired') {
    return { text: 'This has expired and needs to be renewed.', color: colors.statusCritical };
  }
  return null;
}

export default function ActivationCenterScreen() {
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
  const [refreshing, setRefreshing] = useState(false);
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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const requirements = useMemo(
    () =>
      (state?.requirements ?? [])
        .filter((r) => r.status !== 'not_applicable')
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [state],
  );

  const sections = useMemo(() => {
    const optional = requirements.filter(
      (r) => (!r.required || r.category === 'opportunity') && !DONE_STATUSES.includes(r.status),
    );
    const optionalKeys = new Set(optional.map((r) => r.key));
    const core = requirements.filter((r) => !optionalKeys.has(r.key));
    return {
      action: core.filter(
        (r) => ACTION_STATUSES.includes(r.status) || r.status === 'blocked',
      ),
      inReview: core.filter((r) => REVIEW_STATUSES.includes(r.status)),
      optional,
      completed: core.filter((r) => DONE_STATUSES.includes(r.status)),
    };
  }, [requirements]);

  const progress = useMemo(() => {
    const blocking = (state?.requirements ?? []).filter((r) => r.blocking);
    if (blocking.length === 0) return 0;
    const satisfied = blocking.filter((r) =>
      ['approved', 'waived', 'not_applicable'].includes(r.status),
    );
    return satisfied.length / blocking.length;
  }, [state]);

  const nextRequirement = useMemo(() => {
    if (!state?.activation.nextAction) return null;
    return requirements.find((r) => r.key === state.activation.nextAction) ?? null;
  }, [state, requirements]);

  if (!state) {
    if (loading) return <LoadingView label="Loading your activation steps…" />;
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

  const openRequirement = (req: OnboardingRequirement) => {
    const href = hrefForRequirement(req);
    if (href) {
      router.push(href);
    } else if (req.externalUrl) {
      void Linking.openURL(req.externalUrl);
    }
  };

  const renderRows = (items: OnboardingRequirement[]) =>
    items.map((req) => {
      const blocked = req.status === 'blocked';
      const detail = detailFor(req);
      return (
        <TaskRow
          key={req.key}
          title={req.title}
          summary={req.summary}
          status={req.status}
          detail={detail?.text}
          detailColor={detail?.color}
          disabled={blocked}
          disabledHint={blocked ? 'Complete previous steps first' : undefined}
          onPress={() => openRequirement(req)}
        />
      );
    });

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
        ]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <Text style={styles.title}>Get ready to drive</Text>
        {state.market ? <Text style={styles.marketName}>{state.market.displayName}</Text> : null}

        <View style={styles.progressWrap}>
          <ProgressHeader fraction={progress} />
        </View>

        {marketChangeNotice ? (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>
              Your steps were updated for {marketChangeNotice}.
            </Text>
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
        ) : nextRequirement ? (
          <View style={styles.nextCard}>
            <Text style={styles.nextLabel}>Next step</Text>
            <Text style={styles.nextTitle}>{nextRequirement.title}</Text>
            {nextRequirement.summary ? (
              <Text style={styles.nextSummary}>{nextRequirement.summary}</Text>
            ) : null}
            <Button
              title="Continue"
              onPress={() => openRequirement(nextRequirement)}
              fullWidth
              style={styles.nextButton}
            />
          </View>
        ) : null}

        {!applicationRejected && notifStatus === 'undetermined' ? (
          <View style={styles.notifWrap}>
            <TaskRow
              title="Turn on notifications"
              summary="Get updates about your application and ride requests."
              status="not_started"
              onPress={() => router.push('/onboarding/notifications')}
            />
          </View>
        ) : null}

        {sections.action.length > 0 ? (
          <>
            <SectionHeader title="Action required" />
            <View style={styles.list}>{renderRows(sections.action)}</View>
          </>
        ) : null}

        {sections.inReview.length > 0 ? (
          <>
            <SectionHeader title="In review" />
            <View style={styles.list}>{renderRows(sections.inReview)}</View>
          </>
        ) : null}

        {sections.optional.length > 0 ? (
          <>
            <SectionHeader title="Optional" />
            <View style={styles.list}>{renderRows(sections.optional)}</View>
          </>
        ) : null}

        {sections.completed.length > 0 ? (
          <>
            <SectionHeader title="Completed" />
            <View style={styles.list}>{renderRows(sections.completed)}</View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text },
  marketName: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  progressWrap: { marginTop: spacing.lg },
  noticeCard: {
    marginTop: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
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
    borderRadius: borderRadius.lg,
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
  nextTitle: { ...typography.h3, color: colors.text },
  nextSummary: { ...typography.caption, color: colors.textSecondary },
  nextButton: { marginTop: spacing.md },
  notifWrap: { marginTop: spacing.xl },
  list: { gap: spacing.sm },
});
