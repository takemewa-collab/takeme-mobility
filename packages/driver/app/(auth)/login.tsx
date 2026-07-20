import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { Button } from '@/components/ui';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, hitSlop } from '@/theme/spacing';

const PRIVACY_URL = 'https://www.takememobility.com/privacy';

const BENEFITS = [
  'Premium electric-only rides',
  'Transparent earnings, fast payouts',
  'Support that answers',
];

export default function DriverWelcomeScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.brand}>
        <Text style={styles.wordmark}>TAKEME</Text>
        <Text style={styles.wordmarkSuffix}>Driver</Text>
      </View>

      <View style={styles.value}>
        <Text style={styles.headline}>Drive electric.{'\n'}Earn on your terms.</Text>
        <View style={styles.benefits}>
          {BENEFITS.map((benefit, index) => (
            <View
              key={benefit}
              style={[styles.benefitRow, index > 0 && styles.benefitRowDivided]}
            >
              <Text style={styles.benefitGlyph}>•</Text>
              <Text style={styles.benefitText}>{benefit}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.actions}>
        <Button
          title="Continue with phone"
          onPress={() => router.push('/(auth)/phone')}
          size="lg"
          fullWidth
        />
        <Text style={styles.returningCaption}>Signing back in uses the same steps.</Text>
        <Button
          title="Continue with email"
          onPress={() =>
            router.push({ pathname: '/(auth)/phone', params: { mode: 'email' } })
          }
          variant="ghost"
          size="lg"
          fullWidth
        />
        <View style={styles.legalBlock}>
          <Text style={styles.legal}>
            By continuing you agree to the TAKEME Driver Terms shown during setup.
          </Text>
          <Pressable
            onPress={() => {
              void WebBrowser.openBrowserAsync(PRIVACY_URL);
            }}
            hitSlop={hitSlop}
            style={styles.legalLinkTarget}
          >
            <Text style={styles.legalLink}>Privacy Policy</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing['2xl'],
  },
  brand: {
    paddingTop: spacing['4xl'],
    alignItems: 'flex-start',
  },
  wordmark: {
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 6,
    color: colors.text,
  },
  wordmarkSuffix: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 4,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  value: {
    flex: 1,
    justifyContent: 'center',
  },
  headline: {
    ...typography.h1,
    color: colors.text,
  },
  benefits: {
    marginTop: spacing['3xl'],
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.lg,
  },
  benefitRowDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  benefitGlyph: {
    ...typography.body,
    color: colors.textMuted,
    width: spacing.xl,
  },
  benefitText: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  actions: {
    paddingBottom: spacing.xl,
  },
  returningCaption: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  legalBlock: {
    marginTop: spacing.lg,
    alignItems: 'center',
  },
  legal: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: 'center',
  },
  legalLinkTarget: {
    minHeight: 44,
    justifyContent: 'center',
  },
  legalLink: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text,
    textDecorationLine: 'underline',
  },
});
