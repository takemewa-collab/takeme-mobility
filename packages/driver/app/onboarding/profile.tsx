import React, { useState } from 'react';
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
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Input } from '@/components/ui';
import { LoadingView } from '@/components/onboarding';
import { useOnboarding, onboardingErrorMessage } from '@/providers/onboarding';
import type { WeeklyHours } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const HOURS_OPTIONS: { value: WeeklyHours; label: string }[] = [
  { value: 'under_10', label: '<10' },
  { value: '10_25', label: '10–25' },
  { value: '25_40', label: '25–40' },
  { value: 'over_40', label: '40+' },
];

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateApplication } = useOnboarding();
  const application = state?.application ?? null;

  const [fullName, setFullName] = useState(application?.fullName ?? '');
  const [email, setEmail] = useState(application?.email ?? '');
  const [phone, setPhone] = useState(application?.phone ?? '');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [weeklyHours, setWeeklyHours] = useState<WeeklyHours | null>(null);
  const [airportInterest, setAirportInterest] = useState(false);
  const [accessibleVehicle, setAccessibleVehicle] = useState(false);
  const [priorExperience, setPriorExperience] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ fullName?: string; email?: string; phone?: string }>({});

  if (!state) return <LoadingView />;

  const save = async () => {
    if (submitting) return;
    const errs: typeof fieldErrors = {};
    if (!fullName.trim()) errs.fullName = 'Enter your full legal name.';
    if (!email.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) {
      errs.email = 'Enter a valid email address.';
    }
    if (!phone.trim()) errs.phone = 'Enter your phone number.';
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setError(null);
    setSubmitting(true);
    try {
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
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        ...(licenseNumber.trim() ? { licenseNumber: licenseNumber.trim() } : {}),
        ...(preferences ? { preferences } : {}),
      });
      router.back();
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
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>About you</Text>
        <Text style={styles.subtitle}>
          Use your legal name as it appears on your driver&apos;s license.
        </Text>

        <View style={styles.fields}>
          <Input
            label="Full legal name"
            value={fullName}
            onChangeText={setFullName}
            autoCapitalize="words"
            autoComplete="name"
            error={fieldErrors.fullName}
          />
          <Input
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoComplete="email"
            error={fieldErrors.email}
          />
          <Input
            label="Phone"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
            error={fieldErrors.phone}
          />
          <Input
            label="Driver's license number"
            value={licenseNumber}
            onChangeText={setLicenseNumber}
            autoCapitalize="characters"
            autoCorrect={false}
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
              const selected = weeklyHours === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${option.label} hours per week`}
                  onPress={() => setWeeklyHours(selected ? null : option.value)}
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
            value={airportInterest}
            onChange={setAirportInterest}
          />
          <ToggleRow
            label="I have a wheelchair-accessible vehicle"
            value={accessibleVehicle}
            onChange={setAccessibleVehicle}
          />
          <ToggleRow
            label="I have rideshare or livery experience"
            value={priorExperience}
            onChange={setPriorExperience}
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Save" onPress={() => void save()} loading={submitting} fullWidth size="lg" />
      </ScrollView>
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
  content: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  fields: { marginTop: spacing['2xl'], gap: spacing.lg },
  optionalSection: {
    marginTop: spacing['2xl'],
    marginBottom: spacing['2xl'],
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
  error: { ...typography.caption, color: colors.statusCritical, marginBottom: spacing.md },
});
