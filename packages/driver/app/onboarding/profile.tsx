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
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { Button, Input } from '@/components/ui';
import { LoadingView } from '@/components/onboarding';
import { exitTask } from '@/lib/nav';
import { useDiscardGuard } from '@/hooks/use-discard-guard';
import { useAuth } from '@/providers/auth';
import { useOnboarding, onboardingErrorMessage } from '@/providers/onboarding';
import type { WeeklyHours } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const HOURS_OPTIONS: { value: WeeklyHours; label: string }[] = [
  { value: 'under_10', label: '<10' },
  { value: '10_25', label: '10–25' },
  { value: '25_40', label: '25–40' },
  { value: 'over_40', label: '40+' },
];

interface FormValues {
  fullName: string;
  email: string;
  phone: string;
  licenseNumber: string;
  weeklyHours: WeeklyHours | null;
  airportInterest: boolean;
  accessibleVehicle: boolean;
  priorExperience: boolean;
}

const EMPTY_FORM: FormValues = {
  fullName: '',
  email: '',
  phone: '',
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
    a.phone === b.phone &&
    a.licenseNumber === b.licenseNumber &&
    a.weeklyHours === b.weeklyHours &&
    a.airportInterest === b.airportInterest &&
    a.accessibleVehicle === b.accessibleVehicle &&
    a.priorExperience === b.priorExperience
  );
}

type FieldKey = 'fullName' | 'email' | 'phone' | 'licenseNumber';
type FieldErrors = Partial<Record<FieldKey, string>>;

const VALIDATORS: Record<FieldKey, (value: string) => string | undefined> = {
  fullName: (value) =>
    value.trim().length >= 2 ? undefined : 'Enter your full legal name.',
  email: (value) =>
    /^\S+@\S+\.\S+$/.test(value.trim()) ? undefined : 'Enter a valid email address.',
  phone: (value) => {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15
      ? undefined
      : 'Enter a valid phone number.';
  },
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

  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [snapshot, setSnapshot] = useState<FormValues | null>(null);
  const [phoneLocked, setPhoneLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pendingExit, setPendingExit] = useState(false);

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
      phone: application?.phone ?? authUser?.phone ?? '',
    };
    setValues(seed);
    setSnapshot(seed);
    setPhoneLocked(!application?.phone && Boolean(authUser?.phone));
    setFieldErrors({});
    setError(null);
  }, [state, application, authUser]);

  const dirty = snapshot != null && !sameForm(values, snapshot);
  useDiscardGuard(dirty);

  // Leave only after the commit that clears `dirty` has rendered, so the
  // discard guard never fires on a successful save.
  useEffect(() => {
    if (!pendingExit) return;
    setPendingExit(false);
    exitTask(router);
  }, [pendingExit, router]);

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
        phone: values.phone.trim(),
        licenseNumber: values.licenseNumber.trim(),
        ...(preferences ? { preferences } : {}),
      });
      // Reset the snapshot so back navigation no longer warns.
      setSnapshot(values);
      setPendingExit(true);
    } catch (err) {
      setError(onboardingErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

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
          <View>
            <Input
              label="Phone"
              value={values.phone}
              onChangeText={(text) => setField('phone', text)}
              onBlur={() => validateField('phone')}
              keyboardType="phone-pad"
              autoComplete="tel"
              editable={!phoneLocked}
              error={fieldErrors.phone}
            />
            {phoneLocked ? (
              <Text style={styles.fieldHint}>Verified at sign-in.</Text>
            ) : null}
          </View>
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
        <Button title="Save" onPress={() => void save()} loading={submitting} fullWidth size="lg" />
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
