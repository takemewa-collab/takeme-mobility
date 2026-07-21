import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import * as ImagePicker from 'expo-image-picker';
import { Button, Input } from '@/components/ui';
import {
  ErrorView,
  LoadingView,
  StatusBadge,
  StepProgress,
  SubmitSuccess,
} from '@/components/onboarding';
import { exitTask } from '@/lib/nav';
import { useDiscardGuard } from '@/hooks/use-discard-guard';
import { useStepFlow } from '@/hooks/use-step-flow';
import { useOnboarding, onboardingErrorMessage, type UploadPhase } from '@/providers/onboarding';
import type { OnboardingDocument, OnboardingRequirement } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const EXPIRING_KIND = /license|insurance|registration|permit/i;
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

interface Slot {
  id: string;
  docType: string;
  label: string;
  /** Index among slots sharing a docType — pairs uploads with documents. */
  docIndex: number;
}

interface PendingCapture {
  base64: string;
  contentType: string;
}

function labelForKind(kind: string): string {
  // Sides are encoded in the kind itself ('license_front' / 'license_back');
  // the server keeps exactly one live document per docType.
  const side = kind.endsWith('_front') ? 'Front' : kind.endsWith('_back') ? 'Back' : null;
  const base = kind.replace(/_(front|back)$/, '');
  const pretty = base
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return side ? `${pretty} — ${side}` : pretty;
}

function buildSlots(req: OnboardingRequirement): Slot[] {
  const kinds = req.docKinds ?? [];
  return kinds.map((kind) => ({
    id: kind,
    docType: kind,
    label: labelForKind(kind),
    docIndex: 0,
  }));
}

function documentForSlot(req: OnboardingRequirement, slot: Slot): OnboardingDocument | null {
  const docs = req.documents
    .filter((d) => d.docType === slot.docType && d.status !== 'expired')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return docs[slot.docIndex] ?? null;
}

export default function DocumentScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { key } = useLocalSearchParams<{ key?: string }>();
  const { state, loading, error, refresh, uploadDocument, getDocumentUrl } = useOnboarding();

  const requirement = useMemo(
    () => state?.requirements.find((r) => r.key === key) ?? null,
    [state, key],
  );
  const { step, stepNumber, totalSteps, goNext } = useStepFlow(key);

  const [phases, setPhases] = useState<Record<string, UploadPhase | null>>({});
  const [slotErrors, setSlotErrors] = useState<Record<string, string | null>>({});
  const [failedCaptures, setFailedCaptures] = useState<Record<string, PendingCapture | null>>({});
  const [expiryByKind, setExpiryByKind] = useState<Record<string, string>>({});
  const [cameraBlocked, setCameraBlocked] = useState(false);
  // Distinguishes "just finished uploading here" (confirm + auto-advance)
  // from revisiting an already-submitted step (quiet status card).
  const uploadedThisSession = useRef(false);

  // Warn only while an upload is actually in flight. A completed upload lives
  // on the server; a dismissed picker is a no-op — neither should nag on back.
  const uploadInFlight = Object.values(phases).some((phase) => phase != null);
  useDiscardGuard(uploadInFlight, 'Upload in progress — leaving now will cancel it.', {
    stay: 'Keep waiting',
    leave: 'Leave',
  });

  if (!state) {
    if (loading) return <LoadingView />;
    return <ErrorView message={error} onRetry={() => void refresh()} />;
  }
  if (!requirement || !requirement.docKinds?.length) {
    return (
      <ErrorView message="This step is no longer available." onRetry={() => exitTask(router)} />
    );
  }

  const slots = buildSlots(requirement);
  const cameraOnly = requirement.config.camera_only === true;

  const allSubmitted = slots.every((slot) => {
    const doc = documentForSlot(requirement, slot);
    return doc != null && (doc.status === 'pending' || doc.status === 'approved');
  });

  const expiryError = (kind: string): string | null => {
    const value = expiryByKind[kind]?.trim();
    if (!value) return null;
    if (!DATE_FORMAT.test(value)) return 'Use YYYY-MM-DD format.';
    return Number.isNaN(new Date(value).getTime()) ? 'Enter a valid date.' : null;
  };

  const upload = async (slot: Slot, capture: PendingCapture) => {
    if (phases[slot.id]) return;
    const expiry = expiryByKind[slot.docType]?.trim();
    if (expiry && expiryError(slot.docType)) {
      setSlotErrors((prev) => ({
        ...prev,
        [slot.id]: 'Fix the expiration date before uploading.',
      }));
      return;
    }
    setSlotErrors((prev) => ({ ...prev, [slot.id]: null }));
    try {
      await uploadDocument({
        requirementKey: requirement.key,
        docType: slot.docType,
        base64: capture.base64,
        contentType: capture.contentType,
        ...(expiry ? { expiresOn: expiry } : {}),
        onPhase: (phase) => setPhases((prev) => ({ ...prev, [slot.id]: phase })),
      });
      uploadedThisSession.current = true;
      setFailedCaptures((prev) => ({ ...prev, [slot.id]: null }));
    } catch (err) {
      setFailedCaptures((prev) => ({ ...prev, [slot.id]: capture }));
      setSlotErrors((prev) => ({ ...prev, [slot.id]: onboardingErrorMessage(err) }));
    } finally {
      setPhases((prev) => ({ ...prev, [slot.id]: null }));
    }
  };

  const capture = async (slot: Slot, source: 'camera' | 'library') => {
    if (phases[slot.id]) return;
    setSlotErrors((prev) => ({ ...prev, [slot.id]: null }));
    try {
      let result: ImagePicker.ImagePickerResult;
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setCameraBlocked(true);
          return;
        }
        setCameraBlocked(false);
        result = await ImagePicker.launchCameraAsync({ quality: 0.8, base64: true });
      } else {
        result = await ImagePicker.launchImageLibraryAsync({
          quality: 0.8,
          base64: true,
          mediaTypes: ['images'],
        });
      }
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.base64) {
        setSlotErrors((prev) => ({
          ...prev,
          [slot.id]: 'That photo could not be read. Try again.',
        }));
        return;
      }
      await upload(slot, {
        base64: asset.base64,
        contentType: asset.mimeType ?? 'image/jpeg',
      });
    } catch {
      setSlotErrors((prev) => ({
        ...prev,
        [slot.id]: 'Something went wrong capturing the photo. Try again.',
      }));
    }
  };

  const kindsNeedingExpiry = (requirement.docKinds ?? []).filter((kind) =>
    EXPIRING_KIND.test(kind),
  );

  const headerTitle = step?.title ?? requirement.title;

  if (allSubmitted && uploadedThisSession.current) {
    return (
      <>
        <Stack.Screen options={{ title: headerTitle }} />
        <SubmitSuccess
          title="Submitted for review"
          caption={step?.reviewEstimate ?? 'We’ll let you know if anything else is needed.'}
          onContinue={goNext}
        />
      </>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen options={{ title: headerTitle }} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <StepProgress current={stepNumber} total={totalSteps} />
        {/* Repeat the name only when this upload is one piece of a larger
            step (e.g. a permit inside the market requirements step). */}
        {requirement.title !== headerTitle ? (
          <Text style={styles.title}>{requirement.title}</Text>
        ) : null}
        {requirement.instructions ? (
          <Text style={styles.instructions}>{requirement.instructions}</Text>
        ) : requirement.summary ? (
          <Text style={styles.instructions}>{requirement.summary}</Text>
        ) : null}

        {cameraBlocked ? (
          <View style={styles.permissionCard}>
            <Text style={styles.permissionTitle}>Camera access is off</Text>
            <Text style={styles.permissionBody}>
              TAKEME uses your camera to photograph your documents for verification. Turn it on in
              Settings to continue.
            </Text>
            <Button
              title="Open Settings"
              variant="outline"
              onPress={() => void Linking.openSettings()}
            />
          </View>
        ) : null}

        <View style={styles.slots}>
          {slots.map((slot) => (
            <SlotCard
              key={slot.id}
              slot={slot}
              document={documentForSlot(requirement, slot)}
              phase={phases[slot.id] ?? null}
              error={slotErrors[slot.id] ?? null}
              failedCapture={failedCaptures[slot.id] ?? null}
              cameraOnly={cameraOnly}
              onCapture={(source) => void capture(slot, source)}
              onRetry={(pending) => void upload(slot, pending)}
              getDocumentUrl={getDocumentUrl}
            />
          ))}
        </View>

        {kindsNeedingExpiry.length > 0 ? (
          <View style={styles.expirySection}>
            {kindsNeedingExpiry.map((kind) => (
              <Input
                key={kind}
                label={`${labelForKind(kind)} — expiration date on the document (optional)`}
                value={expiryByKind[kind] ?? ''}
                onChangeText={(text) =>
                  setExpiryByKind((prev) => ({ ...prev, [kind]: text }))
                }
                placeholder="YYYY-MM-DD"
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
                error={expiryError(kind) ?? undefined}
              />
            ))}
          </View>
        ) : null}

        {allSubmitted ? (
          <View style={styles.reviewCard}>
            <Text style={styles.reviewTitle}>In review</Text>
            <Text style={styles.reviewBody}>
              Your documents are submitted.{' '}
              {step?.reviewEstimate ?? 'We’ll let you know if anything else is needed.'}
            </Text>
            <Button title="Done" onPress={() => exitTask(router)} fullWidth size="lg" />
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

interface SlotCardProps {
  slot: Slot;
  document: OnboardingDocument | null;
  phase: UploadPhase | null;
  error: string | null;
  failedCapture: PendingCapture | null;
  cameraOnly: boolean;
  onCapture: (source: 'camera' | 'library') => void;
  onRetry: (pending: PendingCapture) => void;
  getDocumentUrl: (id: string) => Promise<string>;
}

const PHASE_LABEL: Record<UploadPhase, string> = {
  preparing: 'Preparing…',
  uploading: 'Uploading…',
  processing: 'Processing…',
};

function SlotCard({
  slot,
  document,
  phase,
  error,
  failedCapture,
  cameraOnly,
  onCapture,
  onRetry,
  getDocumentUrl,
}: SlotCardProps) {
  const [thumb, setThumb] = useState<{ id: string; url: string } | null>(null);

  const docId = document?.id ?? null;
  useEffect(() => {
    let alive = true;
    if (!docId) return;
    getDocumentUrl(docId)
      .then((url) => {
        if (alive) setThumb({ id: docId, url });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [docId, getDocumentUrl]);
  // Keyed by document id so a replaced document never shows a stale preview.
  const thumbUrl = thumb && thumb.id === docId ? thumb.url : null;

  const rejected = document?.status === 'rejected';
  const needsCapture = !document || rejected;

  return (
    <View style={styles.slotCard}>
      <View style={styles.slotHeader}>
        <Text style={styles.slotLabel}>{slot.label}</Text>
        {document ? (
          <StatusBadge
            status={
              document.status === 'pending'
                ? 'submitted'
                : document.status === 'approved'
                  ? 'approved'
                  : document.status === 'rejected'
                    ? 'rejected'
                    : 'expired'
            }
          />
        ) : null}
      </View>

      {thumbUrl ? (
        <Image
          source={{ uri: thumbUrl }}
          style={styles.thumbnail}
          alt={`${slot.label} photo`}
          accessibilityLabel={`${slot.label} photo`}
        />
      ) : null}

      {rejected && document?.rejectionReason ? (
        <Text style={styles.rejectionText}>{document.rejectionReason}</Text>
      ) : null}
      {error ? <Text style={styles.rejectionText}>{error}</Text> : null}

      {phase ? (
        <Text style={styles.phaseText}>{PHASE_LABEL[phase]}</Text>
      ) : failedCapture ? (
        <Button title="Retry upload" variant="outline" onPress={() => onRetry(failedCapture)} />
      ) : needsCapture ? (
        <View style={styles.captureButtons}>
          <Button
            title={rejected ? 'Retake photo' : 'Take photo'}
            variant="outline"
            onPress={() => onCapture('camera')}
          />
          {!cameraOnly ? (
            <Button
              title="Choose from library"
              variant="ghost"
              onPress={() => onCapture('library')}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text },
  instructions: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  permissionCard: {
    marginTop: spacing.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.gray50,
    gap: spacing.md,
  },
  permissionTitle: { ...typography.bodyBold, color: colors.text },
  permissionBody: { ...typography.caption, color: colors.textSecondary },
  slots: { marginTop: spacing.xl, gap: spacing.md },
  slotCard: {
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.white,
    gap: spacing.md,
  },
  slotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  slotLabel: { ...typography.bodyBold, color: colors.text, flex: 1 },
  thumbnail: {
    width: 96,
    height: 64,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.gray100,
  },
  rejectionText: { ...typography.caption, color: colors.statusCritical },
  phaseText: { ...typography.caption, color: colors.textSecondary },
  captureButtons: { gap: spacing.sm },
  expirySection: { marginTop: spacing.xl, gap: spacing.lg },
  reviewCard: {
    marginTop: spacing['2xl'],
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.gray50,
    gap: spacing.md,
  },
  reviewTitle: { ...typography.h3, color: colors.text },
  reviewBody: { ...typography.caption, color: colors.textSecondary },
});
