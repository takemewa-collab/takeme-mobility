import React, { useMemo, useState } from 'react';
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
import type { VehicleCheckResult, WaitlistVehicleSize } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

const VIN_LENGTH = 17;
const VIN_ILLEGAL = /[IOQ]/;

const ELIGIBILITY_COPY: Record<string, string> = {
  not_battery_electric:
    "TAKEME is an electric-only platform, and this vehicle isn't battery-electric.",
  below_min_model_year: "This vehicle's model year is below the minimum for your market.",
  exceeds_max_vehicle_age: 'This vehicle is older than the maximum age for your market.',
  too_few_doors: "This vehicle doesn't have enough doors for your market.",
  too_few_seatbelts: "This vehicle doesn't have enough seatbelts for your market.",
  powertrain_unverified: "We couldn't verify the powertrain automatically.",
  model_year_unknown: "We couldn't determine the model year automatically.",
};

function reasonCopy(code: string): string {
  return ELIGIBILITY_COPY[code] ?? 'This vehicle needs a closer look before it can be approved.';
}

export default function VehicleScreen() {
  const { state } = useOnboarding();
  if (!state) return <LoadingView />;
  if (state.application?.vehicleRelationship === 'takeme_rental') {
    return <WaitlistView />;
  }
  return <VehicleCheckView />;
}

// ---------------------------------------------------------------------------
// VIN-first vehicle check
// ---------------------------------------------------------------------------

function VehicleCheckView() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, markets, submitVehicle, updateApplication } = useOnboarding();

  const defaultPlateState = useMemo(() => {
    const region = markets.find((m) => m.key === state?.market?.key)?.regionCode ?? '';
    return /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : '';
  }, [markets, state]);

  const [vin, setVin] = useState(state?.application?.vehicle?.vin ?? '');
  const [plate, setPlate] = useState('');
  const [plateConfirm, setPlateConfirm] = useState('');
  const [plateState, setPlateState] = useState(defaultPlateState);
  const [manualMode, setManualMode] = useState(false);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [color, setColor] = useState('');
  const [doors, setDoors] = useState('');
  const [seatbelts, setSeatbelts] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VehicleCheckResult | null>(null);
  const [switchingToRental, setSwitchingToRental] = useState(false);

  const vinTrimmed = vin.trim().toUpperCase();
  const vinHasIllegal = VIN_ILLEGAL.test(vinTrimmed);
  const vinError =
    vinTrimmed.length > 0 && vinTrimmed.length === VIN_LENGTH && vinHasIllegal
      ? 'VINs never contain the letters I, O, or Q.'
      : undefined;

  const validate = (): string | null => {
    if (vinTrimmed && (vinTrimmed.length !== VIN_LENGTH || vinHasIllegal)) {
      return 'Enter the full 17-character VIN, or leave it blank to enter details manually.';
    }
    if (!plate.trim()) return 'Enter your license plate.';
    if (plate.trim().toUpperCase() !== plateConfirm.trim().toUpperCase()) {
      return "The plate numbers don't match.";
    }
    if (!/^[A-Za-z]{2}$/.test(plateState.trim())) {
      return 'Enter the two-letter plate state.';
    }
    if (manualMode) {
      if (!make.trim() || !model.trim()) return 'Enter the make and model.';
      if (!/^\d{4}$/.test(year.trim())) return 'Enter the four-digit model year.';
    }
    return null;
  };

  const submit = async () => {
    if (submitting) return;
    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await submitVehicle({
        ...(vinTrimmed ? { vin: vinTrimmed } : {}),
        plate: plate.trim().toUpperCase(),
        plateConfirm: plateConfirm.trim().toUpperCase(),
        plateState: plateState.trim().toUpperCase(),
        ...(manualMode
          ? {
              make: make.trim(),
              model: model.trim(),
              year: Number(year.trim()),
              ...(color.trim() ? { color: color.trim() } : {}),
              ...(doors.trim() ? { doors: Number(doors.trim()) } : {}),
              ...(seatbelts.trim() ? { seatbelts: Number(seatbelts.trim()) } : {}),
            }
          : {}),
      });
      if (!res.decoded && !manualMode) {
        // Decode failed — reveal the manual fields for the next attempt.
        setManualMode(true);
        setResult(null);
      } else {
        setResult(res);
      }
    } catch (err) {
      // 400 invalid VIN / plate mismatch and 409 duplicate vehicle both carry
      // a server message worth showing verbatim.
      setError(onboardingErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const switchToRental = async () => {
    if (switchingToRental) return;
    setSwitchingToRental(true);
    setError(null);
    try {
      await updateApplication({
        applicantType: 'rental_seeker',
        vehicleRelationship: 'takeme_rental',
      });
      // The relationship change re-renders this screen as the waitlist UI.
    } catch (err) {
      setError(onboardingErrorMessage(err));
    } finally {
      setSwitchingToRental(false);
    }
  };

  if (submitting) {
    return <LoadingView label="Checking your vehicle…" />;
  }

  // Result: decoded confirmation, eligibility outcomes.
  if (result) {
    const { eligibility, facts } = result;
    const factsLine = [facts.year, facts.make, facts.model].filter(Boolean).join(' ');

    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
        ]}
      >
        <Text style={styles.title}>Your vehicle</Text>

        {result.decoded ? (
          <View style={styles.card}>
            <Text style={styles.factsTitle}>{factsLine || 'Vehicle found'}</Text>
            {facts.powertrain ? (
              <FactRow label="Powertrain" value={powertrainLabel(facts.powertrain)} />
            ) : null}
            {facts.doors != null ? <FactRow label="Doors" value={String(facts.doors)} /> : null}
            {facts.seatbelts != null ? (
              <FactRow label="Seatbelts" value={String(facts.seatbelts)} />
            ) : null}
            {facts.bodyType ? <FactRow label="Body" value={facts.bodyType} /> : null}
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.factsTitle}>{factsLine || 'Details received'}</Text>
            <Text style={styles.cardBody}>
              A vehicle specialist will verify these details during review.
            </Text>
          </View>
        )}

        {!eligibility.eligible ? (
          <View style={[styles.card, styles.criticalCard]}>
            <Text style={styles.criticalTitle}>This vehicle can&apos;t drive on TAKEME</Text>
            {eligibility.reasons.map((reason) => (
              <Text key={reason} style={styles.criticalReason}>
                {reasonCopy(reason)}
              </Text>
            ))}
          </View>
        ) : eligibility.needsReview ? (
          <View style={styles.card}>
            <Text style={styles.factsTitle}>We&apos;ll take a closer look</Text>
            <Text style={styles.cardBody}>
              {eligibility.reasons.length > 0
                ? eligibility.reasons.map(reasonCopy).join(' ')
                : 'A specialist will review your vehicle details.'}
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={[styles.factsTitle, styles.approvedText]}>Vehicle eligible</Text>
            <Text style={styles.cardBody}>This vehicle meets the requirements for your market.</Text>
          </View>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          {!eligibility.eligible ? (
            <>
              <Button
                title="Choose a different vehicle"
                variant="outline"
                onPress={() => {
                  setResult(null);
                  setManualMode(false);
                  setVin('');
                  setPlate('');
                  setPlateConfirm('');
                }}
                fullWidth
              />
              <Button
                title="Get a TAKEME rental instead"
                onPress={() => void switchToRental()}
                loading={switchingToRental}
                fullWidth
              />
            </>
          ) : result.decoded ? (
            <>
              <Button
                title="This is my car"
                onPress={() => router.replace('/onboarding')}
                fullWidth
                size="lg"
              />
              <Button
                title="Not my car"
                variant="ghost"
                onPress={() => {
                  setResult(null);
                  setManualMode(true);
                }}
                fullWidth
              />
            </>
          ) : (
            <Button
              title="Done"
              onPress={() => router.replace('/onboarding')}
              fullWidth
              size="lg"
            />
          )}
        </View>
      </ScrollView>
    );
  }

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
        <Text style={styles.title}>Your vehicle</Text>
        <Text style={styles.subtitle}>
          Start with your VIN — we can confirm most details automatically.
        </Text>

        <View style={styles.fields}>
          <View>
            <Input
              label="VIN"
              value={vin}
              onChangeText={(text) => setVin(text.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={VIN_LENGTH}
              error={vinError}
              placeholder="17 characters"
            />
            <Text style={styles.counter}>
              {vinTrimmed.length}/{VIN_LENGTH}
            </Text>
          </View>
          <Input
            label="License plate"
            value={plate}
            onChangeText={(text) => setPlate(text.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Input
            label="Confirm license plate"
            value={plateConfirm}
            onChangeText={(text) => setPlateConfirm(text.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            contextMenuHidden
            error={
              plateConfirm.length > 0 &&
              plate.trim().toUpperCase() !== plateConfirm.trim().toUpperCase()
                ? "The plate numbers don't match."
                : undefined
            }
          />
          <Input
            label="Plate state"
            value={plateState}
            onChangeText={(text) => setPlateState(text.toUpperCase().replace(/[^A-Z]/g, ''))}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={2}
            placeholder="Two letters, e.g. WA"
          />

          {manualMode ? (
            <View style={styles.manualSection}>
              <Text style={styles.manualTitle}>Vehicle details</Text>
              <Text style={styles.manualHint}>
                We couldn&apos;t confirm everything automatically. Enter the details and a
                specialist will verify them.
              </Text>
              <Input label="Make" value={make} onChangeText={setMake} autoCapitalize="words" />
              <Input label="Model" value={model} onChangeText={setModel} autoCapitalize="words" />
              <Input
                label="Model year"
                value={year}
                onChangeText={(t) => setYear(t.replace(/\D/g, '').slice(0, 4))}
                keyboardType="number-pad"
              />
              <Input label="Color" value={color} onChangeText={setColor} autoCapitalize="words" />
              <Input
                label="Doors"
                value={doors}
                onChangeText={(t) => setDoors(t.replace(/\D/g, '').slice(0, 1))}
                keyboardType="number-pad"
              />
              <Input
                label="Seatbelts"
                value={seatbelts}
                onChangeText={(t) => setSeatbelts(t.replace(/\D/g, '').slice(0, 1))}
                keyboardType="number-pad"
              />
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setManualMode(true)}
              style={styles.manualLink}
            >
              <Text style={styles.manualLinkText}>No VIN handy? Enter details manually</Text>
            </Pressable>
          )}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Check vehicle" onPress={() => void submit()} fullWidth size="lg" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function powertrainLabel(powertrain: string): string {
  const map: Record<string, string> = {
    bev: 'Battery electric',
    battery_electric: 'Battery electric',
    phev: 'Plug-in hybrid',
    hybrid: 'Hybrid',
    ice: 'Gas',
  };
  return map[powertrain.toLowerCase()] ?? powertrain;
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.factRow}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// TAKEME rental waitlist
// ---------------------------------------------------------------------------

function WaitlistView() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, joinWaitlist, leaveWaitlist } = useOnboarding();
  const marketKey = state?.market?.key ?? '';

  const [vehicleSize, setVehicleSize] = useState<WaitlistVehicleSize>('standard');
  const [pickupArea, setPickupArea] = useState('');
  const [notifyOptIn, setNotifyOptIn] = useState(true);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    if (busy || !marketKey) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await joinWaitlist({
        marketKey,
        vehicleSize,
        ...(pickupArea.trim() ? { pickupArea: pickupArea.trim() } : {}),
        notifyOptIn,
      });
      setJoined(ok);
    } catch (err) {
      setError(onboardingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (busy || !marketKey) return;
    setBusy(true);
    setError(null);
    try {
      await leaveWaitlist(marketKey);
      setJoined(false);
    } catch (err) {
      setError(onboardingErrorMessage(err));
    } finally {
      setBusy(false);
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
        <Text style={styles.title}>TAKEME rental</Text>
        <Text style={styles.subtitle}>
          Join the list for a TAKEME rental EV in {state?.market?.displayName ?? 'your market'}.
          We&apos;ll reach out when a vehicle is available.
        </Text>

        {joined ? (
          <View style={styles.card}>
            <Text style={[styles.factsTitle, styles.approvedText]}>You&apos;re on the list</Text>
            <Text style={styles.cardBody}>
              We&apos;ll notify you when a rental vehicle opens up in your area.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.fieldLabel}>Vehicle size</Text>
            <View style={styles.segmented} accessibilityRole="radiogroup">
              {(
                [
                  { value: 'standard', label: 'Standard' },
                  { value: 'large', label: 'Large' },
                ] as const
              ).map((option) => {
                const selected = vehicleSize === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => setVehicleSize(option.value)}
                    style={[styles.segment, selected && styles.segmentSelected]}
                  >
                    <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.waitlistField}>
              <Input
                label="Preferred pickup area (optional)"
                value={pickupArea}
                onChangeText={setPickupArea}
                placeholder="Neighborhood or zip code"
              />
            </View>

            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Notify me when a vehicle is available</Text>
              <Switch
                value={notifyOptIn}
                onValueChange={setNotifyOptIn}
                trackColor={{ false: colors.gray300, true: colors.accent }}
                thumbColor={colors.white}
                accessibilityLabel="Notify me when a vehicle is available"
              />
            </View>
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          {joined ? (
            <>
              <Button
                title="Done"
                onPress={() => router.replace('/onboarding')}
                fullWidth
                size="lg"
              />
              <Button
                title="Leave the waitlist"
                variant="ghost"
                onPress={() => void leave()}
                loading={busy}
                fullWidth
              />
            </>
          ) : (
            <Button
              title="Join the waitlist"
              onPress={() => void join()}
              loading={busy}
              fullWidth
              size="lg"
            />
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  fields: { marginTop: spacing['2xl'], gap: spacing.lg, marginBottom: spacing.xl },
  counter: { ...typography.small, color: colors.textMuted, marginTop: spacing.xs, textAlign: 'right' },
  manualSection: {
    gap: spacing.lg,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.gray50,
  },
  manualTitle: { ...typography.bodyBold, color: colors.text },
  manualHint: { ...typography.caption, color: colors.textSecondary },
  manualLink: { minHeight: 44, justifyContent: 'center' },
  manualLinkText: { ...typography.captionBold, color: colors.text },
  card: {
    marginTop: spacing.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.white,
    gap: spacing.sm,
  },
  criticalCard: { backgroundColor: colors.gray50 },
  criticalTitle: { ...typography.bodyBold, color: colors.statusCritical },
  criticalReason: { ...typography.caption, color: colors.statusCritical },
  factsTitle: { ...typography.h3, color: colors.text },
  approvedText: { color: colors.statusApproved },
  cardBody: { ...typography.caption, color: colors.textSecondary },
  factRow: { flexDirection: 'row', justifyContent: 'space-between', minHeight: 24 },
  factLabel: { ...typography.caption, color: colors.textSecondary },
  factValue: { ...typography.captionBold, color: colors.text },
  error: { ...typography.caption, color: colors.statusCritical, marginBottom: spacing.md },
  actions: { marginTop: spacing.xl, gap: spacing.sm },
  fieldLabel: {
    ...typography.captionBold,
    color: colors.text,
    marginTop: spacing['2xl'],
    marginBottom: spacing.sm,
  },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    backgroundColor: colors.white,
  },
  segment: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  segmentSelected: { backgroundColor: colors.primary },
  segmentText: { ...typography.caption, color: colors.text },
  segmentTextSelected: { color: colors.white, fontWeight: '600' },
  waitlistField: { marginTop: spacing.lg },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  toggleLabel: { ...typography.caption, color: colors.text, flex: 1 },
});
