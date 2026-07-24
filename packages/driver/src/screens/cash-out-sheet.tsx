import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { formatCurrency } from '@takeme/shared';
import type { PayoutExecutionResult, PayoutsResponse } from '@/types/driver-hub';
import {
  instantFeeUsd,
  netPayoutUsd,
  parseAmountInput,
  validateCashOutAmount,
} from '@/lib/payout-math';
import { HubError } from '@/components/hub/state-views';
import type { AccountLinkError, PayoutSetupOutcome } from '@/lib/payout-setup';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius, hitSlop } from '@/theme/spacing';

type Speed = 'instant' | 'standard';

export interface CashOutSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Latest payouts payload; null while loading or after a failed fetch. */
  payouts: PayoutsResponse | null;
  payoutsPhase: 'loading' | 'error' | 'ready';
  onRetryPayouts: () => void;
  /**
   * Execute the payout. Must resolve with the server's result for BOTH the
   * 200 and 422 shapes, and reject only on transport-level failures.
   */
  onSubmit: (
    amountUsd: number,
    speed: Speed,
    idempotencyKey: string,
  ) => Promise<PayoutExecutionResult>;
  /**
   * Mint a FRESH account link and run the Stripe-hosted flow (single-use
   * links — never cached). Resolves with the outcome; the container must
   * re-fetch payouts after every session regardless of outcome.
   */
  onOpenAccountLink: (mode: 'onboard' | 'manage') => Promise<PayoutSetupOutcome>;
  /** Called after a completed payout attempt so balances refetch. */
  onCompleted: () => void;
}

type SheetStage =
  | { kind: 'form' }
  | { kind: 'submitting' }
  | { kind: 'result'; result: PayoutExecutionResult }
  | { kind: 'transport_error' };

export function CashOutSheet(props: CashOutSheetProps) {
  const { payouts, payoutsPhase } = props;

  const [stage, setStage] = useState<SheetStage>({ kind: 'form' });
  const [amountText, setAmountText] = useState<string | null>(null);
  const [speed, setSpeed] = useState<Speed | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<AccountLinkError | null>(null);
  // One idempotency key per confirmation: created on the first confirm tap,
  // reused on retry taps, discarded when the driver edits amount or speed.
  const idempotencyKeyRef = useRef<string | null>(null);

  const resetAndClose = useCallback(() => {
    setStage({ kind: 'form' });
    setAmountText(null);
    setSpeed(null);
    setLinkError(null);
    idempotencyKeyRef.current = null;
    props.onClose();
  }, [props]);

  const finishAfterAttempt = useCallback(() => {
    props.onCompleted();
    resetAndClose();
  }, [props, resetAndClose]);

  const openAccountLink = useCallback(
    async (mode: 'onboard' | 'manage') => {
      // Every tap requests a fresh single-use link; while it's minted the
      // button shows a busy state. Errors surface the server's exact copy.
      setLinkBusy(true);
      setLinkError(null);
      try {
        const outcome = await props.onOpenAccountLink(mode);
        if (!outcome.ok) setLinkError(outcome.error);
      } catch {
        setLinkError({ code: 'network', message: "Couldn't reach TAKEME. Check your connection." });
      } finally {
        setLinkBusy(false);
      }
    },
    [props],
  );

  // ── derived form state ──
  const connect = payouts?.connect ?? null;
  const fees = payouts?.fees ?? null;
  const availableUsd = payouts?.balances.availableUsd ?? 0;
  const destination =
    connect?.destinations.find((d) => d.isDefault) ?? connect?.destinations[0] ?? null;
  const canCashOut = connect != null && connect.payoutsEnabled && destination != null;
  const instantOffered =
    canCashOut && connect.instantEligible && destination != null && destination.supportsInstant;
  const effectiveSpeed: Speed = speed ?? (instantOffered ? 'instant' : 'standard');

  const amountUsd = amountText == null ? availableUsd : parseAmountInput(amountText);
  const amountIssue = fees
    ? validateCashOutAmount(amountUsd, availableUsd, fees.minPayoutUsd)
    : 'invalid';
  const feeUsd =
    fees && amountUsd != null && effectiveSpeed === 'instant'
      ? instantFeeUsd(amountUsd, fees.instantFeePct, fees.instantFeeMinUsd)
      : 0;
  const netUsd =
    fees && amountUsd != null
      ? netPayoutUsd(amountUsd, effectiveSpeed, fees)
      : null;

  const handleConfirm = useCallback(async () => {
    if (amountUsd == null || amountIssue != null) return;
    Keyboard.dismiss();
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = Crypto.randomUUID();
    setStage({ kind: 'submitting' });
    try {
      const result = await props.onSubmit(amountUsd, effectiveSpeed, idempotencyKeyRef.current);
      setStage({ kind: 'result', result });
    } catch {
      // Transport failure — the same key retries safely.
      setStage({ kind: 'transport_error' });
    }
  }, [amountUsd, amountIssue, effectiveSpeed, props]);

  const editAmount = useCallback((text: string) => {
    idempotencyKeyRef.current = null;
    setAmountText(text);
  }, []);

  const useFullBalance = useCallback(() => {
    idempotencyKeyRef.current = null;
    setAmountText(null);
  }, []);

  const pickSpeed = useCallback((next: Speed) => {
    idempotencyKeyRef.current = null;
    Keyboard.dismiss();
    setSpeed(next);
  }, []);

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={resetAndClose}
    >
      <View style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Cash out</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={resetAndClose}
            hitSlop={hitSlop}
            style={styles.closeButton}
          >
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
        </View>

        {payoutsPhase === 'loading' || (payoutsPhase === 'ready' && payouts == null) ? (
          <View style={styles.centerFill}>
            <ActivityIndicator size="large" color={colors.text} />
            <Text style={styles.centerCaption}>Checking your payout account…</Text>
          </View>
        ) : payoutsPhase === 'error' || payouts == null ? (
          <HubError
            title="Couldn't load payout details"
            body="Check your connection and try again."
            onRetry={props.onRetryPayouts}
          />
        ) : stage.kind === 'submitting' ? (
          <View style={styles.centerFill}>
            <ActivityIndicator size="large" color={colors.text} />
            <Text style={styles.centerCaption}>Sending your cash out…</Text>
          </View>
        ) : stage.kind === 'transport_error' ? (
          <View style={styles.centerFill}>
            <Ionicons name="cloud-offline-outline" size={32} color={colors.gray500} />
            <Text style={styles.resultTitle}>We couldn&apos;t confirm your cash out</Text>
            <Text style={styles.centerCaption}>
              The request didn&apos;t go through. Retrying is safe — a duplicate will not be
              created.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={handleConfirm}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            >
              <Text style={styles.primaryButtonText}>Try again</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={resetAndClose} style={styles.ghostButton}>
              <Text style={styles.ghostButtonText}>Cancel</Text>
            </Pressable>
          </View>
        ) : stage.kind === 'result' ? (
          <ResultView
            result={stage.result}
            destinationLabel={
              destination ? `${destination.brandOrBank} ••${destination.last4}` : null
            }
            arrivalCopy={
              effectiveSpeed === 'instant' ? payouts.fees.instantArrivalCopy : payouts.fees.standardArrivalCopy
            }
            onDone={finishAfterAttempt}
          />
        ) : !canCashOut ? (
          <UnavailableView
            reason={
              // 'connect_not_enabled' is the platform-wide honest state — the
              // server's exact explanation replaces the generic reason.
              linkError?.code === 'connect_not_enabled'
                ? linkError.message
                : connect?.unavailableReason ?? 'Cash out is temporarily unavailable.'
            }
            linkError={linkError && linkError.code !== 'connect_not_enabled' ? linkError : null}
            onboarded={connect?.onboarded === true}
            busy={linkBusy}
            onOpenAccountLink={openAccountLink}
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.formScroll}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <Text style={styles.fieldLabel}>Amount</Text>
            <View style={styles.amountRow}>
              <Text style={styles.amountCurrency}>$</Text>
              <TextInput
                style={styles.amountInput}
                value={amountText ?? availableUsd.toFixed(2)}
                onChangeText={editAmount}
                keyboardType="decimal-pad"
                returnKeyType="done"
                accessibilityLabel="Cash out amount in dollars"
                selectTextOnFocus
              />
            </View>
            <View style={styles.amountMetaRow}>
              <Text style={styles.amountAvailable}>
                {formatCurrency(availableUsd)} available
              </Text>
              {amountText != null ? (
                <Pressable accessibilityRole="button" onPress={useFullBalance} hitSlop={hitSlop}>
                  <Text style={styles.useFullLink}>Use full balance</Text>
                </Pressable>
              ) : null}
            </View>
            {amountIssue === 'below_minimum' && fees ? (
              <Text style={styles.fieldError}>
                Minimum cash out is {formatCurrency(fees.minPayoutUsd)}.
              </Text>
            ) : null}
            {amountIssue === 'exceeds_available' ? (
              <Text style={styles.fieldError}>
                You can cash out up to {formatCurrency(availableUsd)}.
              </Text>
            ) : null}
            {amountIssue === 'invalid' && amountText != null ? (
              <Text style={styles.fieldError}>Enter a valid amount.</Text>
            ) : null}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Speed</Text>
            {instantOffered ? (
              <SpeedOption
                selected={effectiveSpeed === 'instant'}
                title="Instant"
                subtitle={payouts.fees.instantArrivalCopy}
                trailing={
                  amountUsd != null && amountIssue == null
                    ? `${formatCurrency(feeUsd)} fee`
                    : `${Math.round(payouts.fees.instantFeePct * 1000) / 10}% fee (min ${formatCurrency(payouts.fees.instantFeeMinUsd)})`
                }
                onPress={() => pickSpeed('instant')}
              />
            ) : null}
            <SpeedOption
              selected={effectiveSpeed === 'standard'}
              title="Standard"
              subtitle={payouts.fees.standardArrivalCopy}
              trailing="Free"
              onPress={() => pickSpeed('standard')}
            />
            {!instantOffered && connect?.unavailableReason ? (
              <Text style={styles.speedNote}>{connect.unavailableReason}</Text>
            ) : null}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Deposit to</Text>
            <View style={styles.destinationRow}>
              <Ionicons
                name={destination?.kind === 'card' ? 'card-outline' : 'business-outline'}
                size={20}
                color={colors.text}
              />
              <Text style={styles.destinationText} numberOfLines={1}>
                {destination ? `${destination.brandOrBank} ••${destination.last4}` : ''}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void openAccountLink('manage')}
                disabled={linkBusy}
                hitSlop={hitSlop}
              >
                <Text style={styles.manageLink}>{linkBusy ? 'Opening…' : 'Manage'}</Text>
              </Pressable>
            </View>
            {linkError ? <Text style={styles.fieldError}>{linkError.message}</Text> : null}

            <View style={styles.netBlock}>
              {effectiveSpeed === 'instant' && amountUsd != null && amountIssue == null ? (
                <View style={styles.netRow}>
                  <Text style={styles.netRowLabel}>Instant fee</Text>
                  <Text style={styles.netRowValue}>-{formatCurrency(feeUsd)}</Text>
                </View>
              ) : null}
              <View style={styles.netRow}>
                <Text style={styles.netLabel}>You&apos;ll receive</Text>
                <Text style={styles.netValue}>
                  {netUsd != null && amountIssue == null ? formatCurrency(netUsd) : '—'}
                </Text>
              </View>
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={handleConfirm}
              disabled={amountIssue != null}
              style={({ pressed }) => [
                styles.primaryButton,
                amountIssue != null && styles.primaryButtonDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {amountUsd != null && amountIssue == null
                  ? `Cash out ${formatCurrency(amountUsd)}`
                  : 'Cash out'}
              </Text>
            </Pressable>
            <Text style={styles.finePrint}>
              Pending earnings become available after trips finalize and can&apos;t be cashed out
              yet.
            </Text>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function SpeedOption({
  selected,
  title,
  subtitle,
  trailing,
  onPress,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  trailing: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.speedOption,
        selected && styles.speedOptionSelected,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={20}
        color={selected ? colors.text : colors.gray400}
      />
      <View style={styles.speedTextWrap}>
        <Text style={styles.speedTitle}>{title}</Text>
        <Text style={styles.speedSubtitle}>{subtitle}</Text>
      </View>
      <Text style={styles.speedTrailing}>{trailing}</Text>
    </Pressable>
  );
}

function UnavailableView({
  reason,
  linkError,
  onboarded,
  busy,
  onOpenAccountLink,
}: {
  reason: string;
  linkError: AccountLinkError | null;
  onboarded: boolean;
  busy: boolean;
  onOpenAccountLink: (mode: 'onboard' | 'manage') => Promise<void>;
}) {
  return (
    <View style={styles.centerFill}>
      <Ionicons name="wallet-outline" size={32} color={colors.gray500} />
      <Text style={styles.resultTitle}>Cash out isn&apos;t ready yet</Text>
      <Text style={styles.centerCaption}>{reason}</Text>
      {linkError ? <Text style={styles.linkErrorText}>{linkError.message}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void onOpenAccountLink(onboarded ? 'manage' : 'onboard')}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
      >
        {busy ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Text style={styles.primaryButtonText}>
            {linkError
              ? 'Try again'
              : onboarded
                ? 'Review payout account'
                : 'Set up payouts'}
          </Text>
        )}
      </Pressable>
      <Text style={styles.finePrint}>
        Payout setup is handled securely by Stripe. TAKEME never sees your bank or card details.
      </Text>
    </View>
  );
}

function ResultView({
  result,
  destinationLabel,
  arrivalCopy,
  onDone,
}: {
  result: PayoutExecutionResult;
  destinationLabel: string | null;
  arrivalCopy: string;
  onDone: () => void;
}) {
  const succeeded = result.ok || result.replayed;
  // Funds only move (and get returned) once a payout row existed — pre-check
  // failures never touched the balance, so we don't claim a refund happened.
  const fundsReturned = !succeeded && Boolean(result.payoutId);
  return (
    <View style={styles.centerFill}>
      <Ionicons
        name={succeeded ? 'checkmark-circle-outline' : 'alert-circle-outline'}
        size={40}
        color={succeeded ? colors.statusApproved : colors.statusCritical}
      />
      <Text style={styles.resultTitle}>
        {succeeded ? `${formatCurrency(result.netUsd)} on the way` : 'Cash out failed'}
      </Text>
      {succeeded ? (
        <>
          {destinationLabel ? (
            <Text style={styles.centerCaption}>To {destinationLabel}</Text>
          ) : null}
          {result.feeUsd > 0 ? (
            <Text style={styles.centerCaption}>
              {formatCurrency(result.amountUsd)} minus {formatCurrency(result.feeUsd)} fee
            </Text>
          ) : null}
          <Text style={styles.centerCaption}>{arrivalCopy}</Text>
          {result.replayed ? (
            <Text style={styles.finePrint}>This cash out was already in progress.</Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.centerCaption}>
            {result.failureReason ?? 'The payout could not be completed.'}
          </Text>
          {fundsReturned ? (
            <Text style={styles.centerCaption}>
              Your funds were returned to your available balance.
            </Text>
          ) : null}
        </>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={onDone}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
      >
        <Text style={styles.primaryButtonText}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  sheetTitle: { ...typography.h3, color: colors.text },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.8 },

  centerFill: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['3xl'],
    gap: spacing.sm,
  },
  centerCaption: { ...typography.caption, color: colors.textSecondary, textAlign: 'center' },
  resultTitle: { ...typography.h3, color: colors.text, textAlign: 'center', marginTop: spacing.sm },

  formScroll: { paddingHorizontal: spacing['2xl'], paddingBottom: spacing['4xl'] },
  fieldLabel: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldLabelSpaced: { marginTop: spacing['2xl'] },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderFocused,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
  },
  amountCurrency: { ...typography.h1, color: colors.text, marginRight: 2 },
  amountInput: {
    ...typography.h1,
    color: colors.text,
    flex: 1,
    paddingVertical: 0,
  },
  amountMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
    minHeight: 20,
  },
  amountAvailable: { ...typography.small, color: colors.textSecondary },
  useFullLink: { ...typography.small, fontWeight: '600', color: colors.text, textDecorationLine: 'underline' },
  fieldError: { ...typography.small, color: colors.statusCritical, marginTop: spacing.xs },
  linkErrorText: {
    ...typography.caption,
    color: colors.statusCritical,
    textAlign: 'center',
    marginTop: spacing.xs,
  },

  speedOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginTop: spacing.sm,
    minHeight: 44,
  },
  speedOptionSelected: { borderColor: colors.borderFocused },
  speedTextWrap: { flex: 1 },
  speedTitle: { ...typography.bodyBold, color: colors.text },
  speedSubtitle: { ...typography.small, color: colors.textSecondary, marginTop: 1 },
  speedTrailing: { ...typography.captionBold, color: colors.text },
  speedNote: { ...typography.small, color: colors.textSecondary, marginTop: spacing.sm },

  destinationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginTop: spacing.sm,
    minHeight: 44,
  },
  destinationText: { ...typography.body, color: colors.text, flex: 1 },
  manageLink: { ...typography.captionBold, color: colors.text, textDecorationLine: 'underline' },

  netBlock: { marginTop: spacing['2xl'] },
  netRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  netRowLabel: { ...typography.caption, color: colors.textSecondary },
  netRowValue: { ...typography.caption, color: colors.text },
  netLabel: { ...typography.bodyBold, color: colors.text },
  netValue: { ...typography.h3, color: colors.text },

  primaryButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    alignSelf: 'stretch',
    marginTop: spacing.xl,
  },
  primaryButtonDisabled: { backgroundColor: colors.gray300 },
  primaryButtonText: { ...typography.bodyBold, color: colors.white },
  ghostButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  ghostButtonText: { ...typography.bodyBold, color: colors.textSecondary },
  finePrint: { ...typography.small, color: colors.textMuted, textAlign: 'center', marginTop: spacing.md },
});
