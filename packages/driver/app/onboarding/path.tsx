import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui';
import { useOnboarding, onboardingErrorMessage } from '@/providers/onboarding';
import type { ApplicantType, VehicleRelationship } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

type Stage = 'root' | 'ev_ownership' | 'livery_vehicle';

interface PathChoice {
  applicantType: ApplicantType;
  vehicleRelationship: VehicleRelationship;
}

interface CardDef {
  title: string;
  summary: string;
  onSelect: () => void;
}

export default function PathScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { updateApplication } = useOnboarding();
  const [stage, setStage] = useState<Stage>('root');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async (choice: PathChoice) => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await updateApplication(choice);
      router.replace('/onboarding');
    } catch (err) {
      setError(onboardingErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const rootCards: CardDef[] = [
    {
      title: 'I have an electric vehicle',
      summary: 'Drive your own EV on the TAKEME platform.',
      onSelect: () => setStage('ev_ownership'),
    },
    {
      title: 'I need a TAKEME vehicle',
      summary: 'Join the list for a TAKEME rental EV.',
      onSelect: () =>
        void commit({ applicantType: 'rental_seeker', vehicleRelationship: 'takeme_rental' }),
    },
    {
      title: 'I drive for a fleet',
      summary: 'Your fleet assigns you a vehicle.',
      onSelect: () =>
        void commit({ applicantType: 'fleet_driver', vehicleRelationship: 'fleet_assigned' }),
    },
    {
      title: 'I own a fleet',
      summary: 'Manage vehicles and drivers on TAKEME.',
      onSelect: () => void commit({ applicantType: 'fleet_owner', vehicleRelationship: 'none' }),
    },
    {
      title: 'Professional chauffeur or livery',
      summary: 'Licensed livery and black-car operators.',
      onSelect: () => setStage('livery_vehicle'),
    },
  ];

  const evCards: CardDef[] = [
    {
      title: 'I own it',
      summary: 'The vehicle is registered to you.',
      onSelect: () =>
        void commit({ applicantType: 'individual_owner', vehicleRelationship: 'personal_owned' }),
    },
    {
      title: 'I lease it',
      summary: 'You hold a personal lease on the vehicle.',
      onSelect: () =>
        void commit({ applicantType: 'individual_lease', vehicleRelationship: 'personal_leased' }),
    },
  ];

  const liveryCards: CardDef[] = [
    {
      title: 'I have my own commercial vehicle',
      summary: 'You operate your own livery-plated vehicle.',
      onSelect: () =>
        void commit({
          applicantType: 'livery_operator',
          vehicleRelationship: 'commercial_livery',
        }),
    },
    {
      title: 'I drive for an operator',
      summary: 'You drive a vehicle under another operator.',
      onSelect: () =>
        void commit({ applicantType: 'subcarrier', vehicleRelationship: 'commercial_livery' }),
    },
  ];

  const cards = stage === 'root' ? rootCards : stage === 'ev_ownership' ? evCards : liveryCards;
  const title =
    stage === 'root'
      ? 'How will you drive?'
      : stage === 'ev_ownership'
        ? 'Your electric vehicle'
        : 'Your livery setup';
  const subtitle =
    stage === 'root'
      ? 'This shapes the steps you see next.'
      : stage === 'ev_ownership'
        ? 'Do you own or lease your EV?'
        : 'Do you operate your own commercial vehicle?';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing['3xl'] },
      ]}
    >
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.cards}>
        {cards.map((card) => (
          <Pressable
            key={card.title}
            accessibilityRole="button"
            accessibilityLabel={card.title}
            disabled={submitting}
            onPress={card.onSelect}
            style={({ pressed }) => [
              styles.card,
              pressed && styles.cardPressed,
              submitting && styles.cardDimmed,
            ]}
          >
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>{card.title}</Text>
              <Text style={styles.cardSummary}>{card.summary}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </View>

      {stage !== 'root' ? (
        <Button
          title="Back"
          variant="ghost"
          onPress={() => setStage('root')}
          disabled={submitting}
          style={styles.back}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  error: { ...typography.caption, color: colors.statusCritical, marginTop: spacing.sm },
  cards: { marginTop: spacing['2xl'], gap: spacing.md },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 72,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.white,
    gap: spacing.md,
  },
  cardPressed: { backgroundColor: colors.gray50 },
  cardDimmed: { opacity: 0.5 },
  cardText: { flex: 1, gap: spacing.xs },
  cardTitle: { ...typography.bodyBold, color: colors.text },
  cardSummary: { ...typography.caption, color: colors.textSecondary },
  chevron: { ...typography.h3, color: colors.gray400 },
  back: { marginTop: spacing.xl, alignSelf: 'center' },
});
