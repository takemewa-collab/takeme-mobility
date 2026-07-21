import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { Button, Input } from '@/components/ui';
import { LoadingView, StepProgress, SubmitSuccess } from '@/components/onboarding';
import { useDiscardGuard } from '@/hooks/use-discard-guard';
import { useStepFlow } from '@/hooks/use-step-flow';
import { formatE164Display } from '@/lib/phone-format';
import { useAuth } from '@/providers/auth';
import { useOnboarding, onboardingErrorMessage } from '@/providers/onboarding';
import type { ApplicationUpdate, WeeklyHours } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const HOURS_OPTIONS: { value: WeeklyHours; label: string }[] = [
  { value: 'under_10', label: '<10' },
  { value: '10_25', label: '10–25' },
  { value: '25_40', label: '25–40' },
  { value: 'over_40', label: '40+' },
];

/**
 * Phone is deliberately absent: it is authenticated identity data. The
 * verified number from Clerk (the one the driver signs in with) is displayed
 * read-only and synchronized to the application automatically — changing it
 * always goes through a fresh OTP verification, never a form field.
 */
interface FormValues {
  fullName: string;
  email: string;
  licenseNumber: string;
  weeklyHours: WeeklyHours | null;
  airportInterest: boolean;
  accessibleVehicle: boolean;
  priorExperience: boolean;
}

const EMPTY_FORM: FormValues = {
  fullName: '',
  email: '',
  licenseNumber: '',
  weeklyHours: null,
  airportInterest: false,
  accessibleVehicle: false,
  priorExperience: false,
};

function sameForm(a: FormValues, b: FormValues): boolean {
  return (
    a.fullName === b.fullName &&
    a.email === b.email &&
    a.licenseNumber === b.licenseNumber &&
    a.weeklyHours === b.weeklyHours &&
    a.airportInterest === b.airportInterest &&
    a.accessibleVehicle === b.accessibleVehicle &&
    a.priorExperience === b.priorExperience
  );
}

type FieldKey = 'fullName' | 'email' | 'licenseNumber';
type FieldErrors = Partial<Record<FieldKey, string>>;

const VALIDATORS: Record<FieldKey, (value: string) => string | undefined> = {
  fullName: (value) =>
    value.trim().length >= 2 ? undefined : 'Enter your full legal name.',
  email: (value) =>
    /^\S+@\S+\.\S+$/.test(value.trim()) ? undefined : 'Enter a valid email address.',
  licenseNumber: (value) => {
    const trimmed = value.trim();
    if (!trimmed) return "Enter your driver's license number.";
    if (trimmed.length > 32 || !/^[A-Za-z0-9 -]+$/.test(trimmed)) {
      return 'Letters and numbers only, up to 32 characters.';
    }
    return undefined;
  },
};

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { user: authUser } = useAuth();
  const { state, updateApplication } = useOnboarding();
  const { stepNumber, totalSteps, goNext } = useStepFlow('profile_details');

  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [snapshot, setSnapshot] = useState<FormValues | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  // Seed once per focus from whatever server state exists at that moment —
  // never mid-edit, so a background refresh can't stomp the user's typing.
  const seededThisFocus = useRef(false);
  useFocusEffect(
    useCallback(() => {
      return () => {
        seededThisFocus.current = false;
      };
    }, []),
  );

  const application = state?.application ?? null;
  useEffect(() => {
    if (seededThisFocus.current || !state) return;
    seededThisFocus.current = true;
    // Server application first; the verified sign-in identity fills any gaps.
    const seed: FormValues = {
      ...EMPTY_FORM,
      fullName: application?.fullName ?? authUser?.full_name ?? '',
      email: application?.email ?? authUser?.email ?? '',
    };
    setValues(seed);
    setSnapshot(seed);
    setFieldErrors({});
    setError(null);
  }, [state, application, authUser]);

  // The verified sign-in number is authoritative. It renders read-only below
  // and is mirrored onto the application silently — late Clerk hydration
  // updates this on re-render and must never block the form.
  const verifiedPhone = authUser?.phone ?? application?.phone ?? null;

  // The provider de-duplicates concurrent application mutations by sharing
  // one in-flight promise. An explicit save must never be swallowed by a
  // racing silent write (auto-save or phone sync), so every silent write
  // registers here and the explicit save drains it first.
  const silentWriteInFlight = useRef<Promise<unknown> | null>(null);
  const registerSilentWrite = useCallback((request: Promise<unknown>) => {
    silentWriteInFlight.current = request;
    void request.finally(() => {
      if (silentWriteInFlight.current === request) silentWriteInFlight.current = null;
    });
  }, []);

  // One-shot silent sync: application.phone always converges on the verified
  // sign-in number without the driver doing anything.
  const phoneSynced = useRef(false);
  useEffect(() => {
    if (phoneSynced.current || !state || !application) return;
    const clerkPhone = authUser?.phone;
    if (!clerkPhone || application.phone === clerkPhone) return;
    phoneSynced.current = true;
    registerSilentWrite(
      updateApplication({ phone: clerkPhone }).catch(() => {
        // Retry naturally on next mount; the explicit save also carries it.
        phoneSynced.current = false;
      }),
    );
  }, [state, application, authUser, updateApplication, registerSilentWrite]);

  const dirty = snapshot != null && !sameForm(values, snapshot);
  useDiscardGuard(dirty);

  // Auto-save: fields that individually pass validation are written to the
  // server a moment after typing stops, so leaving mid-step loses nothing.
  // Silent by design — the explicit Continue is where errors surface.
  useEffect(() => {
    if (!snapshot || submitting || saved || sameForm(values, snapshot)) return;
    const timer = setTimeout(() => {
      const payload: ApplicationUpdate = {};
      const applied: Partial<FormValues> = {};
      (Object.keys(VALIDATORS) as FieldKey[]).forEach((field) => {
        const value = values[field];
        if (value !== snapshot[field] && value.trim() && !VALIDATORS[field](value)) {
          payload[field] = value.trim();
          applied[field] = value;
        }
      });
      const prefsChanged =
        values.weeklyHours !== snapshot.weeklyHours ||
        values.airportInterest !== snapshot.airportInterest ||
        values.accessibleVehicle !== snapshot.accessibleVehicle ||
        values.priorExperience !== snapshot.priorExperience;
      if (prefsChanged) {
        payload.preferences = {
          ...(values.weeklyHours ? { weeklyHours: values.weeklyHours } : {}),
          airportInterest: values.airportInterest,
          accessibleVehicle: values.accessibleVehicle,
          priorExperience: values.priorExperience,
        };
        applied.weeklyHours = values.weeklyHours;
        applied.airportInterest = values.airportInterest;
        applied.accessibleVehicle = values.accessibleVehicle;
        applied.priorExperience = values.priorExperience;
      }
      if (Object.keys(payload).length === 0) return;
      registerSilentWrite(
        updateApplication(payload)
          .then(() => {
            // Only the fields actually sent count as saved; anything typed
            // since stays dirty and re-arms the next auto-save.
            setSnapshot((prev) => (prev ? { ...prev, ...applied } : prev));
          })
          .catch(() => {}),
      );
    }, 1500);
    return () => clearTimeout(timer);
  }, [values, snapshot, submitting, saved, updateApplication, registerSilentWrite]);

  const setField = <K extends keyof FormValues>(field: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (field in VALIDATORS) {
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const validateField = (field: FieldKey) => {
    setFieldErrors((prev) => ({ ...prev, [field]: VALIDATORS[field](values[field]) }));
  };

  if (!state || !snapshot) return <LoadingView />;

  const nameWordCount = values.fullName.trim().split(/\s+/).filter(Boolean).length;
  const showNameHint = nameWordCount === 1 && !fieldErrors.fullName;

  const save = async () => {
    if (submitting) return;
    const errs: FieldErrors = {};
    (Object.keys(VALIDATORS) as FieldKey[]).forEach((field) => {
      const message = VALIDATORS[field](values[field]);
      if (message) errs[field] = message;
    });
    setFieldErrors(errs);
    if (Object.values(errs).some(Boolean)) return;

    setError(null);
    setSubmitting(true);
    try {
      // Let any in-flight silent write settle so the guarded mutation below
      // is a fresh request carrying the full payload.
      if (silentWriteInFlight.current) {
        await silentWriteInFlight.current;
      }
      const { weeklyHours, airportInterest, accessibleVehicle, priorExperience } = values;
      const preferences =
        weeklyHours || airportInterest || accessibleVehicle || priorExperience
          ? {
              ...(weeklyHours ? { weeklyHours } : {}),
              airportInterest,
              accessibleVehicle,
              priorExperience,
            }
          : undefined;
      await updateApplication({
        fullName: values.fullName.trim(),
        email: values.email.trim(),
        licenseNumber: values.licenseNumber.trim(),
        // The verified sign-in number rides along so the step completes even
        // if the background sync hasn't landed yet. Never user-edited here.
        ...(verifiedPhone ? { phone: verifiedPhone } : {}),
        ...(preferences ? { preferences } : {}),
      });
      // Reset the snapshot so back navigation no longer warns.
      setSnapshot(values);
      setSaved(true);
    } catch (err) {
      setError(onboardingErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (saved) {
    return <SubmitSuccess title="Details saved" onContinue={goNext} />;
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <StepProgress current={stepNumber} total={totalSteps} />
        <Text style={styles.subtitle}>
          Use your legal name as it appears on your driver&apos;s license.
        </Text>

        <View style={styles.fields}>
          <View>
            <Input
              label="Full legal name"
              value={values.fullName}
              onChangeText={(text) => setField('fullName', text)}
              onBlur={() => validateField('fullName')}
              autoCapitalize="words"
              autoComplete="name"
              error={fieldErrors.fullName}
            />
            {showNameHint ? (
              <Text style={styles.fieldHint}>Include your first and last name.</Text>
            ) : null}
          </View>
          <Input
            label="Email"
            value={values.email}
            onChangeText={(text) => setField('email', text)}
            onBlur={() => validateField('email')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoComplete="email"
            error={fieldErrors.email}
          />
          {verifiedPhone ? (
            <View
              style={styles.phoneRow}
              accessibilityLabel={`Phone number ${formatE164Display(verifiedPhone)}. Verified.`}
            >
              <View style={styles.phoneText}>
                <Text style={styles.phoneLabel}>Phone number</Text>
                <Text style={styles.phoneValue}>{formatE164Display(verifiedPhone)}</Text>
              </View>
              <View style={styles.verifiedBadge}>
                <Ionicons name="checkmark-circle" size={15} color={colors.statusApproved} />
                <Text style={styles.verifiedText}>Verified</Text>
              </View>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Verify your phone number"
              onPress={() => router.push('/onboarding/verify-phone')}
              style={({ pressed }) => [styles.phoneRow, pressed && styles.phoneRowPressed]}
            >
              <View style={styles.phoneText}>
                <Text style={styles.phoneLabel}>Phone number</Text>
                <Text style={styles.phoneMissing}>Verify your phone number</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.gray400} />
            </Pressable>
          )}
          <Input
            label="Driver's license number"
            value={values.licenseNumber}
            onChangeText={(text) => setField('licenseNumber', text)}
            onBlur={() => validateField('licenseNumber')}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={32}
            error={fieldErrors.licenseNumber}
          />
        </View>

        <View style={styles.optionalSection}>
          <Text style={styles.optionalTitle}>Optional — driving preferences</Text>
          <Text style={styles.optionalHint}>
            Helps us plan coverage. Never affects your application.
          </Text>

          <Text style={styles.fieldLabel}>Hours per week</Text>
          <View style={styles.segmented} accessibilityRole="radiogroup">
            {HOURS_OPTIONS.map((option) => {
              const selected = values.weeklyHours === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${option.label} hours per week`}
                  onPress={() => setField('weeklyHours', selected ? null : option.value)}
                  style={[styles.segment, selected && styles.segmentSelected]}
                >
                  <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <ToggleRow
            label="Interested in airport trips"
            value={values.airportInterest}
            onChange={(next) => setField('airportInterest', next)}
          />
          <ToggleRow
            label="I have a wheelchair-accessible vehicle"
            value={values.accessibleVehicle}
            onChange={(next) => setField('accessibleVehicle', next)}
          />
          <ToggleRow
            label="I have rideshare or livery experience"
            value={values.priorExperience}
            onChange={(next) => setField('priorExperience', next)}
          />
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Continue" onPress={() => void save()} loading={submitting} fullWidth size="lg" />
      </View>
    </KeyboardAvoidingView>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.gray300, true: colors.accent }}
        thumbColor={colors.white}
        accessibilityLabel={label}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xl },
  subtitle: { ...typography.body, color: colors.textSecondary },
  fields: { marginTop: spacing.xl, gap: spacing.lg },
  fieldHint: { ...typography.small, color: colors.textMuted, marginTop: spacing.xs },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    backgroundColor: colors.gray50,
    gap: spacing.md,
  },
  phoneRowPressed: { backgroundColor: colors.gray100 },
  phoneText: { flex: 1, gap: 1 },
  phoneLabel: { ...typography.small, color: colors.textMuted },
  phoneValue: { ...typography.bodyBold, color: colors.text },
  phoneMissing: { ...typography.bodyBold, color: colors.text },
  verifiedBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  verifiedText: { ...typography.caption, color: colors.statusApproved },
  optionalSection: {
    marginTop: spacing['2xl'],
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.gray50,
  },
  optionalTitle: { ...typography.bodyBold, color: colors.text },
  optionalHint: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  fieldLabel: { ...typography.captionBold, color: colors.text, marginTop: spacing.lg, marginBottom: spacing.sm },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    backgroundColor: colors.white,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: { backgroundColor: colors.primary },
  segmentText: { ...typography.caption, color: colors.text },
  segmentTextSelected: { color: colors.white, fontWeight: '600' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    marginTop: spacing.md,
    gap: spacing.md,
  },
  toggleLabel: { ...typography.caption, color: colors.text, flex: 1 },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  error: { ...typography.caption, color: colors.statusCritical },
});
