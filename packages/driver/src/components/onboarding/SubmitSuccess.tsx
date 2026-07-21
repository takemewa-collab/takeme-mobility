import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

interface SubmitSuccessProps {
  title: string;
  /** e.g. "Usually reviewed within 24 hours." */
  caption?: string | null;
  buttonTitle?: string;
  onContinue: () => void;
  /** Auto-advance to the next step after this delay; 0 disables. */
  autoAdvanceMs?: number;
}

/**
 * The immediate confirmation after a submission: a quiet green check, one
 * line of what happens next, then the flow moves itself to the next step.
 * The button exists for anyone faster than the timer.
 */
export function SubmitSuccess({
  title,
  caption,
  buttonTitle = 'Continue',
  onContinue,
  autoAdvanceMs = 1600,
}: SubmitSuccessProps) {
  const firedRef = useRef(false);
  const onContinueRef = useRef(onContinue);
  useEffect(() => {
    onContinueRef.current = onContinue;
  });

  // Fires exactly once, whether the timer or the button gets there first.
  const continueOnce = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    onContinueRef.current();
  }, []);

  useEffect(() => {
    if (autoAdvanceMs <= 0) return;
    const timer = setTimeout(continueOnce, autoAdvanceMs);
    return () => clearTimeout(timer);
  }, [autoAdvanceMs, continueOnce]);

  return (
    <View style={styles.container}>
      <View style={styles.center}>
        <View style={styles.badge}>
          <Ionicons name="checkmark" size={34} color={colors.statusApproved} />
        </View>
        <Text style={styles.title}>{title}</Text>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      </View>
      <Button title={buttonTitle} onPress={continueOnce} fullWidth size="lg" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing['2xl'],
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  badge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(19, 122, 63, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  title: { ...typography.h2, color: colors.text, textAlign: 'center' },
  caption: { ...typography.body, color: colors.textSecondary, textAlign: 'center' },
});
