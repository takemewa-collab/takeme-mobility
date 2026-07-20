import React, { useMemo, useState } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/providers/auth';
import { Button, Input } from '@/components/ui';
import { DEFAULT_DIAL_CODE, DIAL_CODES, DialCode } from '@/lib/dial-codes';
import { formatNationalNumber, formattedMaxLength, toE164 } from '@/lib/phone-format';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius, hitSlop } from '@/theme/spacing';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Maps a raw Clerk error line onto calm copy the driver can act on. */
function friendlySendError(raw: string | undefined, mode: 'phone' | 'email'): string {
  const message = raw ?? '';
  if (/rate.?limit|too many/i.test(message)) {
    return 'Too many attempts. Try again in a few minutes.';
  }
  if (/network|connect|offline|internet|fetch/i.test(message)) {
    return 'No connection. Check your network and try again.';
  }
  if (/invalid|not valid|format|incorrect/i.test(message)) {
    return mode === 'phone'
      ? "That number doesn't look right."
      : "That email doesn't look right.";
  }
  return message || 'Something went wrong. Try again.';
}

export default function PhoneEntryScreen() {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const isEmail = mode === 'email';
  const { sendOtp, sendEmailOtp } = useAuth();

  const [country, setCountry] = useState<DialCode>(DEFAULT_DIAL_CODE);
  const [digits, setDigits] = useState('');
  const [email, setEmail] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const formatted = useMemo(
    () => formatNationalNumber(digits, country.dial),
    [digits, country.dial],
  );

  const plausible = isEmail
    ? EMAIL_PATTERN.test(email.trim())
    : digits.length >= country.minDigits && digits.length <= country.maxDigits;

  const selectCountry = (next: DialCode) => {
    setCountry(next);
    setDigits((current) => current.slice(0, next.maxDigits));
    setError('');
    setPickerOpen(false);
  };

  const handleContinue = async () => {
    // One Clerk attempt at a time — the button also disables while in flight.
    if (sending || !plausible) return;
    setError('');
    setSending(true);
    try {
      if (isEmail) {
        const address = email.trim();
        const result = await sendEmailOtp(address);
        if (result.success) {
          router.push({
            pathname: '/(auth)/verify',
            params: { email: address, method: 'email' },
          });
        } else {
          setError(friendlySendError(result.error, 'email'));
        }
      } else {
        const e164 = toE164(country.dial, digits);
        const result = await sendOtp(e164);
        if (result.success) {
          // Navigate only once Clerk has accepted the send.
          router.push({
            pathname: '/(auth)/verify',
            params: { phone: e164, dial: country.dial, method: 'phone' },
          });
        } else {
          setError(friendlySendError(result.error, 'phone'));
        }
      }
    } finally {
      setSending(false);
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
          <Text style={styles.title}>
            {isEmail ? "What's your email?" : "What's your number?"}
          </Text>
          <Text style={styles.subtitle}>
            We use it to secure your account and sign you in.
          </Text>

          {isEmail ? (
            <Input
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              autoFocus
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                setError('');
              }}
              error={error || undefined}
            />
          ) : (
            <View>
              <View style={styles.phoneRow}>
                <Pressable
                  onPress={() => setPickerOpen(true)}
                  style={styles.dialChip}
                  accessibilityRole="button"
                  accessibilityLabel={`Country code ${country.name}, plus ${country.dial}`}
                >
                  <Text style={styles.dialChipText}>+{country.dial}</Text>
                  <Text style={styles.dialChipCaret}>▾</Text>
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
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>
          )}
        </View>

        <View style={styles.bottom}>
          <Button
            title={sending ? 'Sending…' : 'Continue'}
            onPress={() => void handleContinue()}
            size="lg"
            fullWidth
            disabled={!plausible || sending}
          />
        </View>
      </KeyboardAvoidingView>

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
                    onPress={() => selectCountry(item)}
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
    marginBottom: spacing['3xl'],
  },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
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
  dialChipText: {
    ...typography.bodyBold,
    color: colors.text,
  },
  dialChipCaret: {
    ...typography.caption,
    color: colors.textMuted,
    marginLeft: spacing.xs,
  },
  phoneInput: { flex: 1, width: 'auto' },
  errorText: {
    ...typography.small,
    color: colors.error,
    marginTop: spacing.xs,
  },
  bottom: { paddingBottom: spacing.xl },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
  },
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
  sheetTitle: {
    ...typography.h3,
    color: colors.text,
  },
  sheetClose: {
    minHeight: 44,
    justifyContent: 'center',
  },
  sheetCloseText: {
    ...typography.captionBold,
    color: colors.textSecondary,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingVertical: spacing.sm,
  },
  countryName: {
    ...typography.body,
    color: colors.text,
  },
  countryDial: {
    ...typography.body,
    color: colors.textSecondary,
  },
  countrySelected: {
    fontWeight: '700',
    color: colors.text,
  },
});
