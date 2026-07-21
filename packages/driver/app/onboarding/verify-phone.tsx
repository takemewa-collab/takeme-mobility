import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { useUser } from '@clerk/clerk-expo';
import type { PhoneNumberResource } from '@clerk/types';
import { Button, Input } from '@/components/ui';
import { SubmitSuccess } from '@/components/onboarding';
import { exitTask } from '@/lib/nav';
import { useAuth } from '@/providers/auth';
import { useOnboarding } from '@/providers/onboarding';
import { DEFAULT_DIAL_CODE, DIAL_CODES, DialCode } from '@/lib/dial-codes';
import {
  formatE164Display,
  formatNationalNumber,
  formattedMaxLength,
  maskPhone,
  toE164,
} from '@/lib/phone-format';
import { borderRadius, colors, hitSlop, spacing, typography } from '@/theme';

const RESEND_COOLDOWN_S = 30;

/** One line out of Clerk's error array, readable enough to show a driver. */
function clerkError(e: unknown): string {
  const err = e as { errors?: { longMessage?: string; message?: string }[] };
  return err?.errors?.[0]?.longMessage ?? err?.errors?.[0]?.message ?? 'Something went wrong.';
}

type Stage = 'enter' | 'code' | 'done';

/**
 * Adds and verifies a phone number on the signed-in Clerk account. This is
 * the fallback for sessions that somehow lack a verified phone (e.g. email
 * OTP sign-ups) — the ONLY way a number ever attaches to the account is a
 * fresh OTP verification, never a form field.
 */
export default function VerifyPhoneScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { user: clerkUser } = useUser();
  const { refreshProfile, user: authUser } = useAuth();
  const { updateApplication } = useOnboarding();

  const [stage, setStage] = useState<Stage>('enter');
  const [country, setCountry] = useState<DialCode>(DEFAULT_DIAL_CODE);
  const [digits, setDigits] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const resourceRef = useRef<PhoneNumberResource | null>(null);
  const e164Ref = useRef('');

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const formatted = useMemo(
    () => formatNationalNumber(digits, country.dial),
    [digits, country.dial],
  );
  const plausible = digits.length >= country.minDigits && digits.length <= country.maxDigits;

  // Already verified — nothing to do here.
  const alreadyVerified = Boolean(authUser?.phone) && stage === 'enter';

  const sendCode = async () => {
    if (busy || !plausible) return;
    if (!clerkUser) {
      setError('Your session is still loading. Try again in a moment.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const e164 = toE164(country.dial, digits);
      // Re-use a matching unverified number left by an earlier attempt.
      const existing = clerkUser.phoneNumbers.find((p) => p.phoneNumber === e164);
      const resource = existing ?? (await clerkUser.createPhoneNumber({ phoneNumber: e164 }));
      await resource.prepareVerification();
      resourceRef.current = resource;
      e164Ref.current = e164;
      setCode('');
      setCooldown(RESEND_COOLDOWN_S);
      setStage('code');
    } catch (e) {
      setError(clerkError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async (value: string) => {
    const resource = resourceRef.current;
    if (busy || !resource || value.length !== 6) return;
    setBusy(true);
    setError('');
    try {
      await resource.attemptVerification({ code: value });
      // Make it the sign-in number, mirror it to the platform identity, and
      // stamp it on the application — all server-verified paths.
      if (clerkUser) {
        await clerkUser.update({ primaryPhoneNumberId: resource.id }).catch(() => {});
      }
      await refreshProfile();
      await updateApplication({ phone: e164Ref.current }).catch(() => {});
      setStage('done');
    } catch (e) {
      setError(clerkError(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    const resource = resourceRef.current;
    if (busy || cooldown > 0 || !resource) return;
    setBusy(true);
    setError('');
    try {
      await resource.prepareVerification();
      setCooldown(RESEND_COOLDOWN_S);
    } catch (e) {
      setError(clerkError(e));
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'done') {
    return (
      <SubmitSuccess
        title="Phone number verified"
        caption={formatE164Display(e164Ref.current)}
        onContinue={() => exitTask(router)}
      />
    );
  }

  if (alreadyVerified) {
    return (
      <View style={styles.container}>
        <View style={[styles.content, styles.centered]}>
          <Text style={styles.title}>You&apos;re all set</Text>
          <Text style={styles.subtitle}>
            {formatE164Display(authUser!.phone!)} is verified on your account.
          </Text>
        </View>
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Button title="Done" onPress={() => exitTask(router)} fullWidth size="lg" />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <View style={styles.content}>
        {stage === 'enter' ? (
          <>
            <Text style={styles.title}>Verify your phone number</Text>
            <Text style={styles.subtitle}>
              Your account needs a verified number for sign-in and ride requests. We&apos;ll text
              you a code.
            </Text>
            <View style={styles.phoneRow}>
              <Pressable
                onPress={() => setPickerOpen(true)}
                style={styles.dialChip}
                accessibilityRole="button"
                accessibilityLabel={`Country code ${country.name}, plus ${country.dial}`}
              >
                <Text style={styles.dialChipText}>+{country.dial}</Text>
              </Pressable>
              <Input
                placeholder={country.dial === '1' ? '(206) 555-0134' : 'Phone number'}
                keyboardType="number-pad"
                textContentType="telephoneNumber"
                autoComplete="tel"
                autoFocus
                value={formatted}
                maxLength={formattedMaxLength(country.dial, country.maxDigits)}
                onChangeText={(text) => {
                  setDigits(text.replace(/\D/g, '').slice(0, country.maxDigits));
                  setError('');
                }}
                containerStyle={styles.phoneInput}
              />
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title}>Enter the code</Text>
            <Text style={styles.subtitle}>
              Sent to {maskPhone(e164Ref.current, country.dial)}.
            </Text>
            <Input
              placeholder="6-digit code"
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              autoFocus
              value={code}
              maxLength={6}
              onChangeText={(text) => {
                const next = text.replace(/\D/g, '').slice(0, 6);
                setCode(next);
                setError('');
                if (next.length === 6) void confirmCode(next);
              }}
            />
            <Pressable
              onPress={() => void resend()}
              disabled={cooldown > 0 || busy}
              style={styles.resend}
              accessibilityRole="button"
            >
              <Text style={[styles.resendText, (cooldown > 0 || busy) && styles.resendDisabled]}>
                {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
              </Text>
            </Pressable>
          </>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        {stage === 'enter' ? (
          <Button
            title="Text me a code"
            onPress={() => void sendCode()}
            loading={busy}
            disabled={!plausible}
            fullWidth
            size="lg"
          />
        ) : (
          <Button
            title="Verify"
            onPress={() => void confirmCode(code)}
            loading={busy}
            disabled={code.length !== 6}
            fullWidth
            size="lg"
          />
        )}
      </View>

      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)} />
          <SafeAreaView edges={['bottom']} style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Country code</Text>
              <Pressable
                onPress={() => setPickerOpen(false)}
                hitSlop={hitSlop}
                style={styles.sheetClose}
                accessibilityRole="button"
              >
                <Text style={styles.sheetCloseText}>Close</Text>
              </Pressable>
            </View>
            <FlatList
              data={DIAL_CODES}
              keyExtractor={(item) => item.name}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              renderItem={({ item }) => {
                const selected = item.name === country.name;
                return (
                  <Pressable
                    onPress={() => {
                      setCountry(item);
                      setDigits((current) => current.slice(0, item.maxDigits));
                      setError('');
                      setPickerOpen(false);
                    }}
                    style={styles.countryRow}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.countryName, selected && styles.countrySelected]}>
                      {item.name}
                    </Text>
                    <Text style={[styles.countryDial, selected && styles.countrySelected]}>
                      +{item.dial}
                    </Text>
                  </Pressable>
                );
              }}
            />
          </SafeAreaView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl },
  centered: { justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  title: { ...typography.h2, color: colors.text },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    marginBottom: spacing['2xl'],
  },
  phoneRow: { flexDirection: 'row', alignItems: 'flex-start' },
  dialChip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.gray50,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    marginRight: spacing.sm,
  },
  dialChipText: { ...typography.bodyBold, color: colors.text },
  phoneInput: { flex: 1, width: 'auto' },
  resend: { minHeight: 44, justifyContent: 'center', marginTop: spacing.sm },
  resendText: { ...typography.captionBold, color: colors.text },
  resendDisabled: { color: colors.textMuted },
  error: { ...typography.caption, color: colors.statusCritical, marginTop: spacing.md },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    maxHeight: '70%',
    paddingHorizontal: spacing['2xl'],
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetTitle: { ...typography.h3, color: colors.text },
  sheetClose: { minHeight: 44, justifyContent: 'center' },
  sheetCloseText: { ...typography.captionBold, color: colors.textSecondary },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingVertical: spacing.sm,
  },
  countryName: { ...typography.body, color: colors.text },
  countryDial: { ...typography.body, color: colors.textSecondary },
  countrySelected: { fontWeight: '700', color: colors.text },
});
