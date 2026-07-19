import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { AirportContext, AirportContextDirection } from '@takeme/shared';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

const DIRECTION_LABELS: Record<AirportContextDirection, string> = {
  airport_pickup: 'Airport pickup',
  airport_dropoff: 'Airport drop-off',
};

/**
 * Monochrome card rendering a trip's immutable airport snapshot: where exactly
 * to go inside the airport (terminal, level/zone/door/island), which flight,
 * and the ordered driver instructions. Absent fields are omitted, never
 * invented.
 */
export function AirportContextCard({ context }: { context: AirportContext }) {
  const snap = context.snapshot;
  const { airport, terminal, service_point: servicePoint } = snap;

  // "Level 3 · Zone B · Door 26" — only the parts the snapshot actually has.
  const locationLine = [
    servicePoint.level ? `Level ${servicePoint.level}` : null,
    servicePoint.zone ? `Zone ${servicePoint.zone}` : null,
    servicePoint.door ? `Door ${servicePoint.door}` : null,
    servicePoint.island ? `Island ${servicePoint.island}` : null,
  ]
    .filter((part): part is string => part != null)
    .join(' · ');

  const flightNumber = context.flight_number ?? snap.flight_number ?? null;
  const flightLine = flightNumber
    ? snap.airline
      ? `${snap.airline.display_name} · ${flightNumber}`
      : flightNumber
    : null;

  const instructions = snap.instructions?.driver ?? [];

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.airportName} numberOfLines={1}>
          {'✈'} {airport.display_name} ({airport.iata_code})
        </Text>
        <Text style={styles.directionLabel}>{DIRECTION_LABELS[context.direction]}</Text>
      </View>

      {terminal ? <Text style={styles.detailLine}>{terminal.name}</Text> : null}
      {locationLine.length > 0 ? <Text style={styles.detailLine}>{locationLine}</Text> : null}
      {flightLine ? <Text style={styles.detailLine}>{flightLine}</Text> : null}

      {instructions.length > 0 ? (
        <View style={styles.instructions}>
          {instructions.map((instruction, index) => (
            <View key={`${instruction.title}-${index}`} style={styles.instructionRow}>
              <Text style={styles.instructionTitle}>{instruction.title}</Text>
              <Text style={styles.instructionBody}>{instruction.body}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.gray50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  airportName: { ...typography.captionBold, color: colors.text, flex: 1, marginRight: spacing.sm },
  directionLabel: { ...typography.small, color: colors.textSecondary },
  detailLine: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  instructions: { marginTop: spacing.md },
  instructionRow: { marginTop: spacing.sm },
  instructionTitle: { ...typography.small, fontWeight: '600', color: colors.text },
  instructionBody: { ...typography.small, color: colors.textSecondary, marginTop: 1 },
});
