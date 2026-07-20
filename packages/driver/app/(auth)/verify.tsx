import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/providers/auth';
import { Button } from '@/components/ui';
import { formatPhone } from '@takeme/shared';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

const CODE_LENGTH = 6;

export default function DriverVerifyScreen() {
  const { phone, email, method } = useLocalSearchParams<{ phone?: string; email?: string; method: 'phone' | 'email' }>();
  const router = useRouter();
  const { verifyOtp, sendOtp, verifyEmailOtp, sendEmailOtp, loading } = useAuth();

  const isEmail = method === 'email';
  const identifier = isEmail ? email : phone;

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [resendCooldown, setResendCooldown] = useState(30);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const verifyNow = async (fullCode: string) => {
    if (fullCode.length !== CODE_LENGTH || !identifier) return;
    setError('');

    const result = isEmail
      ? await verifyEmailOtp(identifier, fullCode)
      : await verifyOtp(identifier, fullCode);
    if (result.success) {
      // The Activation Center is the front door after sign-in; it forwards
      // fully-activated drivers straight to the dashboard.
      router.replace('/onboarding');
    } else {
      setError(result.error ?? 'Invalid code');
      setCode('');
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || !identifier) return;
    setError('');
    const result = isEmail
      ? await sendEmailOtp(identifier)
      : await sendOtp(identifier);
    if (result.success) {
      setResendCooldown(30);
    } else {
      setError(result.error ?? 'Failed to resend');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <View style={styles.content}>
          <Text style={styles.title}>Verify your number</Text>
          <Text style={styles.subtitle}>
            Enter the 6-digit code sent to{'\n'}
            {isEmail ? (email ?? '') : (phone ? formatPhone(phone) : '')}
          </Text>

          <TextInput
            ref={inputRef}
            value={code}
            onChangeText={(text) => {
              const next = text.replace(/\D/g, '').slice(0, CODE_LENGTH);
              setCode(next);
              setError('');
              // Auto-verify the moment the last digit lands — from the event
              // handler, not an effect, so no cascading-render hazard.
              if (next.length === CODE_LENGTH) void verifyNow(next);
            }}
            keyboardType="number-pad"
            maxLength={CODE_LENGTH}
            autoFocus
            style={styles.hiddenInput}
          />

          <Pressable
            onPress={() => inputRef.current?.focus()}
            style={styles.codeContainer}
          >
            {Array.from({ length: CODE_LENGTH }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.codeBox,
                  code.length === i && styles.codeBoxActive,
                  error && styles.codeBoxError,
                ]}
              >
                <Text style={styles.codeDigit}>{code[i] ?? ''}</Text>
              </View>
            ))}
          </Pressable>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable onPress={handleResend} disabled={resendCooldown > 0}>
            <Text
              style={[styles.resend, resendCooldown > 0 && styles.resendDisabled]}
            >
              {resendCooldown > 0
                ? `Resend code in ${resendCooldown}s`
                : 'Resend code'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.bottom}>
          <Button
            title="Verify"
            onPress={() => void verifyNow(code)}
            size="lg"
            fullWidth
            loading={loading}
            disabled={code.length !== CODE_LENGTH}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  keyboardView: { flex: 1, paddingHorizontal: spacing['2xl'] },
  content: { flex: 1, paddingTop: spacing['5xl'] },
  title: { ...typography.h2, color: colors.text, marginBottom: spacing.sm },
  subtitle: { ...typography.body, color: colors.textSecondary, marginBottom: spacing['3xl'], lineHeight: 26 },
  hiddenInput: { position: 'absolute', opacity: 0, height: 0, width: 0 },
  codeContainer: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.lg },
  codeBox: {
    width: 48, height: 56, borderRadius: borderRadius.md,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.gray50,
    alignItems: 'center', justifyContent: 'center',
  },
  codeBoxActive: { borderColor: colors.accent, backgroundColor: colors.white },
  codeBoxError: { borderColor: colors.error },
  codeDigit: { ...typography.h2, color: colors.text },
  error: { ...typography.caption, color: colors.error, textAlign: 'center', marginBottom: spacing.md },
  resend: { ...typography.captionBold, color: colors.accent, textAlign: 'center' },
  resendDisabled: { color: colors.textMuted },
  bottom: { paddingBottom: spacing['3xl'] },
});
