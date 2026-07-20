import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/providers/auth';
import { Button } from '@/components/ui';
import { maskPhone } from '@/lib/phone-format';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius, hitSlop } from '@/theme/spacing';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN = 30;
const RATE_LIMIT_COOLDOWN = 120;

function formatCooldown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export default function DriverVerifyScreen() {
  const { phone, email, dial, method } = useLocalSearchParams<{
    phone?: string;
    email?: string;
    dial?: string;
    method: 'phone' | 'email';
  }>();
  const router = useRouter();
  const { verifyOtp, sendOtp, verifyEmailOtp, sendEmailOtp } = useAuth();

  const isEmail = method === 'email';
  const identifier = isEmail ? email : phone;
  // Only ever show a masked number — never the full identifier, never logged.
  const destination = isEmail ? (email ?? '') : phone ? maskPhone(phone, dial) : '';

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const verifyNow = async (fullCode: string) => {
    if (verifying || fullCode.length !== CODE_LENGTH || !identifier) return;
    setError('');
    setVerifying(true);
    try {
      const result = isEmail
        ? await verifyEmailOtp(identifier, fullCode)
        : await verifyOtp(identifier, fullCode);
      if (result.success) {
        // The Activation Center is the front door after sign-in; it forwards
        // fully-activated drivers straight to the dashboard.
        router.replace('/onboarding');
        return;
      }
      setCode('');
      const raw = result.error ?? '';
      if (/expired/i.test(raw)) {
        setError('That code expired. Use Resend below to get a new one.');
      } else if (/network|connect|offline|internet/i.test(raw)) {
        setError('No connection. Check your network and try again.');
      } else {
        setError("That code didn't match. Check the latest message.");
      }
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0 || resending || !identifier) return;
    setError('');
    setResending(true);
    try {
      const result = isEmail ? await sendEmailOtp(identifier) : await sendOtp(identifier);
      if (result.success) {
        setCode('');
        setCooldown(RESEND_COOLDOWN);
      } else {
        const raw = result.error ?? '';
        if (/rate.?limit|too many/i.test(raw)) {
          setCooldown(RATE_LIMIT_COOLDOWN);
          setError('Too many codes requested. Wait a few minutes before trying again.');
        } else if (/network|connect|offline|internet/i.test(raw)) {
          setError('No connection. Check your network and try again.');
        } else {
          setError('Could not send a new code. Try again shortly.');
        }
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={hitSlop}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
        </View>

        <View style={styles.content}>
          <Text style={styles.title}>Enter the code</Text>
          <Text style={styles.subtitle}>Sent to {destination}</Text>
          <Pressable
            onPress={() => router.back()}
            hitSlop={hitSlop}
            style={styles.editLink}
            accessibilityRole="button"
          >
            <Text style={styles.editLinkText}>{isEmail ? 'Edit email' : 'Edit number'}</Text>
          </Pressable>

          {/* One hidden input drives the six boxes — the robust pattern for
              iOS one-time-code autofill. */}
          <TextInput
            ref={inputRef}
            value={code}
            onChangeText={(text) => {
              const next = text.replace(/\D/g, '').slice(0, CODE_LENGTH);
              setCode(next);
              setError('');
              // Auto-submit the moment the last digit lands — from the event
              // handler, not an effect, so no cascading-render hazard.
              if (next.length === CODE_LENGTH) void verifyNow(next);
            }}
            keyboardType="number-pad"
            maxLength={CODE_LENGTH}
            autoFocus
            textContentType="oneTimeCode"
            autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
            style={styles.hiddenInput}
          />

          <Pressable onPress={() => inputRef.current?.focus()} style={styles.codeContainer}>
            {Array.from({ length: CODE_LENGTH }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.codeBox,
                  code.length === i && styles.codeBoxActive,
                  error ? styles.codeBoxError : null,
                ]}
              >
                <Text style={styles.codeDigit}>{code[i] ?? ''}</Text>
              </View>
            ))}
          </Pressable>

          {error ? (
            <Text style={styles.error}>{error}</Text>
          ) : (
            <View style={styles.statusBlock}>
              <Text style={styles.statusTitle}>Code requested</Text>
              <Text style={styles.statusDetail}>Delivery can take up to a minute.</Text>
            </View>
          )}

          <Pressable
            onPress={() => void handleResend()}
            disabled={cooldown > 0 || resending}
            style={styles.resendTarget}
            accessibilityRole="button"
          >
            <Text style={[styles.resend, (cooldown > 0 || resending) && styles.resendDisabled]}>
              {cooldown > 0
                ? `Resend in ${formatCooldown(cooldown)}`
                : resending
                  ? 'Sending…'
                  : 'Resend code'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.bottom}>
          <Button
            title={verifying ? 'Checking…' : 'Verify'}
            onPress={() => void verifyNow(code)}
            size="lg"
            fullWidth
            disabled={code.length !== CODE_LENGTH || verifying}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  keyboardView: { flex: 1, paddingHorizontal: spacing['2xl'] },
  header: {
    paddingTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  backButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
  },
  backGlyph: {
    fontSize: 34,
    lineHeight: 38,
    fontWeight: '400',
    color: colors.text,
  },
  content: { flex: 1 },
  title: {
    ...typography.h1,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
  },
  editLink: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginBottom: spacing.lg,
  },
  editLinkText: {
    ...typography.captionBold,
    color: colors.text,
    textDecorationLine: 'underline',
  },
  hiddenInput: { position: 'absolute', opacity: 0, height: 0, width: 0 },
  codeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  codeBox: {
    width: 48,
    height: 56,
    borderRadius: borderRadius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.gray50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBoxActive: { borderColor: colors.borderFocused, backgroundColor: colors.white },
  codeBoxError: { borderColor: colors.error },
  codeDigit: { ...typography.h2, color: colors.text },
  error: {
    ...typography.caption,
    color: colors.error,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  statusBlock: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  statusTitle: {
    ...typography.captionBold,
    color: colors.text,
  },
  statusDetail: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  resendTarget: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'center',
  },
  resend: {
    ...typography.captionBold,
    color: colors.text,
  },
  resendDisabled: { color: colors.textMuted },
  bottom: { paddingBottom: spacing.xl },
});
