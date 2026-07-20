import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { ApiError } from '@takeme/shared';
import { Button } from '@/components/ui';
import { ErrorView, LoadingView } from '@/components/onboarding';
import { exitTask } from '@/lib/nav';
import { useOnboarding, onboardingErrorMessage } from '@/providers/onboarding';
import type { LegalConsentInput, LegalDocumentContent } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const SCROLL_END_THRESHOLD = 24;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function LegalScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ keys?: string }>();
  const { state, fetchLegalDocuments, acceptLegal } = useOnboarding();

  const keys = useMemo(() => {
    if (params.keys) return params.keys.split(',').filter(Boolean);
    const legalReq = state?.requirements.find(
      (r) => r.key === 'legal_agreements' || ((r.config.legal_keys?.length ?? 0) > 0 && r.category === 'legal'),
    );
    return legalReq?.config.legal_keys ?? [];
  }, [params.keys, state]);

  const locale = state?.application?.preferredLanguage ?? 'en';

  const [documents, setDocuments] = useState<LegalDocumentContent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [versionNotice, setVersionNotice] = useState(false);
  const collected = useRef<LegalConsentInput[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const viewportHeight = useRef(0);

  const consents = useMemo(() => state?.consents ?? [], [state]);
  const isAccepted = useCallback(
    (doc: LegalDocumentContent) =>
      consents.some((c) => c.documentKey === doc.key && c.version === doc.version),
    [consents],
  );

  const load = useCallback(async () => {
    setLoadError(null);
    setDocuments(null);
    collected.current = [];
    setPageIndex(0);
    try {
      const docs = await fetchLegalDocuments(keys, locale);
      setDocuments(docs);
    } catch (err) {
      setLoadError(onboardingErrorMessage(err));
    }
  }, [fetchLegalDocuments, keys, locale]);

  useEffect(() => {
    if (keys.length === 0) return;
    void load();
  }, [keys, load]);

  const acceptedDocs = useMemo(
    () => (documents ?? []).filter((d) => isAccepted(d)),
    [documents, isAccepted],
  );
  const pendingDocs = useMemo(
    () => (documents ?? []).filter((d) => !isAccepted(d)),
    [documents, isAccepted],
  );

  if (keys.length === 0) {
    return (
      <ErrorView
        message="There are no documents to review right now."
        onRetry={() => exitTask(router)}
      />
    );
  }
  if (loadError) return <ErrorView message={loadError} onRetry={() => void load()} />;
  if (!documents) return <LoadingView label="Loading documents…" />;

  const finish = async () => {
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await acceptLegal(collected.current, {
        platform: Platform.OS,
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        osVersion: String(Platform.Version),
        model: Device.modelName ?? 'unknown',
      });
      exitTask(router);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // A document changed while reading — refetch and re-show.
        setVersionNotice(true);
        await load();
      } else {
        setSubmitError(onboardingErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Everything already accepted at the current versions.
  if (pendingDocs.length === 0) {
    return (
      <View style={[styles.container, { paddingTop: spacing.xl }]}>
        <View style={styles.content}>
          <Text style={styles.subtitle}>
            You&apos;ve accepted the current version of every agreement.
          </Text>
          <View style={styles.acceptedList}>
            {acceptedDocs.map((doc) => {
              const consent = consents.find(
                (c) => c.documentKey === doc.key && c.version === doc.version,
              );
              return (
                <View key={doc.key} style={styles.acceptedRow}>
                  <Text style={styles.acceptedTitle}>{doc.title}</Text>
                  <Text style={styles.acceptedDate}>
                    Accepted {consent ? formatDate(consent.acceptedAt) : ''}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Button title="Done" onPress={() => exitTask(router)} fullWidth size="lg" />
        </View>
      </View>
    );
  }

  const doc = pendingDocs[Math.min(pageIndex, pendingDocs.length - 1)];
  const isLast = pageIndex >= pendingDocs.length - 1;
  const acceptEnabled = !doc.requiresScroll || scrolledToEnd;

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    if (contentOffset.y + layoutMeasurement.height >= contentSize.height - SCROLL_END_THRESHOLD) {
      setScrolledToEnd(true);
    }
  };

  const acceptCurrent = () => {
    collected.current = [
      ...collected.current.filter((c) => c.key !== doc.key),
      { key: doc.key, version: doc.version, locale: doc.locale, contentHash: doc.contentHash },
    ];
    if (isLast) {
      void finish();
    } else {
      setPageIndex((i) => i + 1);
      setScrolledToEnd(false);
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }
  };

  return (
    <View style={[styles.container, { paddingTop: spacing.xl }]}>
      <View style={styles.content}>
        {versionNotice ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              These documents were updated. Please review the latest version.
            </Text>
          </View>
        ) : null}
        <Text style={styles.progress}>
          Document {pageIndex + 1} of {pendingDocs.length}
        </Text>
        <Text style={styles.title}>{doc.title}</Text>
        <Text style={styles.meta}>
          Version {doc.version}
          {doc.effectiveAt ? ` · Effective ${formatDate(doc.effectiveAt)}` : ''}
        </Text>
        <ScrollView
          ref={scrollRef}
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onLayout={(e) => {
            viewportHeight.current = e.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_, h) => {
            // Short documents have no end to scroll to.
            if (viewportHeight.current > 0 && h <= viewportHeight.current) {
              setScrolledToEnd(true);
            }
          }}
        >
          <Text style={styles.bodyText}>{doc.body}</Text>
        </ScrollView>
      </View>
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        {doc.requiresScroll && !scrolledToEnd ? (
          <Text style={styles.scrollHint}>Scroll to the end to accept.</Text>
        ) : null}
        {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
        <Button
          title="Accept and continue"
          onPress={acceptCurrent}
          disabled={!acceptEnabled}
          loading={submitting}
          fullWidth
          size="lg"
        />
        <Button title="Do this later" variant="ghost" onPress={() => exitTask(router)} fullWidth />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, paddingHorizontal: spacing.lg },
  progress: { ...typography.caption, color: colors.textMuted },
  subtitle: { ...typography.body, color: colors.textSecondary },
  title: { ...typography.h2, color: colors.text, marginTop: spacing.xs },
  meta: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
  body: {
    flex: 1,
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.gray50,
  },
  bodyContent: { padding: spacing.xl },
  bodyText: { fontSize: 16, lineHeight: 24, color: colors.text },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
  scrollHint: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
  error: { ...typography.caption, color: colors.statusCritical, textAlign: 'center' },
  notice: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    backgroundColor: colors.gray50,
    marginBottom: spacing.md,
  },
  noticeText: { ...typography.caption, color: colors.text },
  acceptedList: { marginTop: spacing.xl, gap: spacing.sm },
  acceptedRow: {
    minHeight: 56,
    justifyContent: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.white,
    gap: 2,
  },
  acceptedTitle: { ...typography.bodyBold, color: colors.text },
  acceptedDate: { ...typography.caption, color: colors.statusApproved },
});
