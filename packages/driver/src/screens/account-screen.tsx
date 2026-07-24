import React from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatPhone, formatRating } from '@takeme/shared';
import type { DriverRidePreferences } from '@takeme/shared';
import type {
  DriverDocument,
  PerformanceResponse,
  ProfileResponse,
} from '@/types/driver-hub';
import { StatusChip, type ChipTone } from '@/components/hub/status-chip';
import { SkeletonBlock } from '@/components/hub/state-views';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export interface AccountScreenProps {
  /** Profile + performance data phase. Settings sections render regardless. */
  phase: 'loading' | 'error' | 'ready';
  profile: ProfileResponse | null;
  performance: PerformanceResponse | null;
  identity: { name: string | null; phone: string | null };
  onRetry: () => void;
  refreshing: boolean;
  onRefresh: () => void;

  prefs: DriverRidePreferences | null;
  enrolling: boolean;
  onPetToggle: (value: boolean) => void;
  onEnrollPress: () => void;
  onLeavePress: () => void;

  alertSound: boolean;
  onAlertSoundChange: (value: boolean) => void;

  onDocumentPress: (doc: DriverDocument) => void;
  onNotificationSettings: () => void;
  onHelp: () => void;
  onReportIssue: () => void;
  onPrivacy: () => void;
  onTerms: () => void;
  onCall911: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}

function titleCase(raw: string): string {
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function docChip(doc: DriverDocument): { label: string; tone: ChipTone } {
  if (doc.expired) return { label: 'Expired', tone: 'critical' };
  if (doc.status === 'rejected') return { label: 'Action needed', tone: 'critical' };
  if (doc.actionRequired) return { label: 'Expires soon', tone: 'warning' };
  if (doc.status === 'approved') return { label: 'Approved', tone: 'approved' };
  if (doc.status === 'pending') return { label: 'In review', tone: 'muted' };
  return { label: titleCase(doc.status), tone: 'muted' };
}

export function AccountScreenView(props: AccountScreenProps) {
  const { profile, performance } = props;
  const name = profile?.driver.fullName ?? props.identity.name;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
      >
        <Text style={styles.header}>Account</Text>

        {/* Profile header */}
        <View style={styles.profileHeader}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{name ? name[0].toUpperCase() : 'D'}</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.name} numberOfLines={1}>
              {name ?? 'Driver'}
            </Text>
            <View style={styles.profileMetaRow}>
              {profile?.driver.verified ? (
                <View style={styles.verifiedBadge}>
                  <Ionicons name="checkmark-circle" size={14} color={colors.statusApproved} />
                  <Text style={styles.verifiedText}>Verified driver</Text>
                </View>
              ) : null}
              {profile?.driver.rating != null ? (
                <View style={styles.ratingWrap}>
                  <Ionicons name="star" size={13} color={colors.text} />
                  <Text style={styles.ratingText}>{formatRating(profile.driver.rating)}</Text>
                </View>
              ) : null}
            </View>
            {props.identity.phone ? (
              <Text style={styles.profileDetail}>{formatPhone(props.identity.phone)}</Text>
            ) : null}
            {profile ? (
              <Text style={styles.profileDetail}>Driver ID {profile.driver.driverId}</Text>
            ) : null}
          </View>
        </View>

        {props.phase === 'loading' ? (
          <View style={styles.dataLoading}>
            <SkeletonBlock width="100%" height={72} radius={borderRadius.md} />
            <SkeletonBlock width="100%" height={72} radius={borderRadius.md} style={{ marginTop: spacing.md }} />
          </View>
        ) : null}

        {props.phase === 'error' ? (
          <View style={styles.dataError}>
            <Text style={styles.dataErrorTitle}>Couldn&apos;t load your driver details</Text>
            <Text style={styles.dataErrorBody}>
              Vehicle, documents, and performance are unavailable right now.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={props.onRetry}
              style={({ pressed }) => [styles.dataErrorRetry, pressed && styles.pressed]}
            >
              <Text style={styles.dataErrorRetryText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Vehicle */}
        {profile?.vehicle ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Vehicle</Text>
            <View style={styles.vehicleRow}>
              <Ionicons name="car-outline" size={22} color={colors.text} />
              <View style={styles.vehicleInfo}>
                <Text style={styles.vehicleName} numberOfLines={1}>
                  {[profile.vehicle.year, profile.vehicle.make, profile.vehicle.model]
                    .filter(Boolean)
                    .join(' ')}
                </Text>
                <Text style={styles.vehicleMeta} numberOfLines={1}>
                  {[
                    profile.vehicle.color,
                    profile.vehicle.plateNumber,
                    profile.vehicle.vehicleClass ? titleCase(profile.vehicle.vehicleClass) : null,
                    profile.vehicle.capacity != null ? `${profile.vehicle.capacity} seats` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* Documents & compliance */}
        {profile && profile.documents.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Documents &amp; compliance</Text>
            {profile.documents.map((doc) => {
              const chip = docChip(doc);
              const needsAction = doc.actionRequired || doc.expired || doc.status === 'rejected';
              return (
                <Pressable
                  key={doc.id}
                  accessibilityRole="button"
                  onPress={() => props.onDocumentPress(doc)}
                  style={({ pressed }) => [styles.docRow, pressed && styles.pressed]}
                >
                  <View style={styles.docInfo}>
                    <Text style={styles.rowLabel}>{titleCase(doc.docType)}</Text>
                    {doc.expiresAt ? (
                      <Text
                        style={[
                          styles.rowSubtitle,
                          doc.expired && { color: colors.statusCritical },
                          !doc.expired && doc.actionRequired && { color: colors.statusWarning },
                        ]}
                      >
                        {doc.expired ? 'Expired' : 'Expires'} {dateLabel(doc.expiresAt)}
                      </Text>
                    ) : null}
                  </View>
                  <StatusChip label={chip.label} tone={chip.tone} />
                  {needsAction ? (
                    <Ionicons name="chevron-forward" size={16} color={colors.gray400} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* Performance */}
        {performance ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Performance</Text>
            <RateRow
              label="Acceptance rate"
              pct={performance.offers.acceptanceRatePct}
              sampleNote={`${performance.offers.sent} of 5 offers needed`}
            />
            <RateRow
              label="Completion rate"
              pct={performance.trips.completionRatePct}
              sampleNote={`${performance.trips.completed + performance.trips.cancelledByYou} of 5 trips needed`}
            />
            <RateRow
              label="Cancellation rate"
              pct={performance.trips.cancellationRatePct}
              sampleNote={`${performance.trips.completed + performance.trips.cancelledByYou} of 5 trips needed`}
            />
            <View style={styles.perfRow}>
              <Text style={styles.rowLabel}>Completed trips</Text>
              <Text style={styles.perfValue}>{performance.trips.completed}</Text>
            </View>
            <Text style={styles.perfWindowNote}>Last {performance.windowDays} days</Text>
          </View>
        ) : null}

        {/* Ride preferences — existing behavior, unchanged */}
        {props.prefs ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Ride preferences</Text>
            <View style={styles.prefRow}>
              <View style={styles.prefInfo}>
                <Text style={styles.rowLabel}>Pet Friendly rides</Text>
                <Text style={styles.rowSubtitle}>
                  Accept trips where a rider brings a household pet
                </Text>
              </View>
              <Switch
                value={props.prefs.petFriendlyOptIn}
                onValueChange={props.onPetToggle}
                trackColor={{ false: colors.gray300, true: colors.gray900 }}
                thumbColor={colors.white}
                ios_backgroundColor={colors.gray300}
              />
            </View>

            {props.prefs.womenPreferred.invited || props.prefs.womenPreferred.enrolled ? (
              <View style={styles.prefRow}>
                <View style={styles.prefInfo}>
                  <Text style={styles.rowLabel}>Women Preferred program</Text>
                  <Text style={styles.rowSubtitle}>
                    {props.prefs.womenPreferred.enrolled ? 'Enrolled' : "You're invited"}
                  </Text>
                </View>
                {props.prefs.womenPreferred.enrolled ? (
                  <Pressable
                    onPress={props.onLeavePress}
                    disabled={props.enrolling}
                    style={[styles.prefLinkButton, props.enrolling && styles.prefButtonDisabled]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.prefLinkText}>
                      {props.enrolling ? 'Updating...' : 'Leave program'}
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={props.onEnrollPress}
                    disabled={props.enrolling}
                    style={[styles.prefEnrollButton, props.enrolling && styles.prefButtonDisabled]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.prefEnrollText}>
                      {props.enrolling ? 'Enrolling...' : 'Enroll'}
                    </Text>
                  </Pressable>
                )}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Ride request alerts — existing behavior, unchanged */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ride request alerts</Text>
          <View style={styles.prefRow}>
            <View style={styles.prefInfo}>
              <Text style={styles.rowLabel}>Alert sound</Text>
              <Text style={styles.rowSubtitle}>
                Play the loud TAKEME alert for incoming requests. Vibration and notifications stay
                on.
              </Text>
            </View>
            <Switch
              value={props.alertSound}
              onValueChange={props.onAlertSoundChange}
              trackColor={{ false: colors.gray300, true: colors.gray900 }}
              thumbColor={colors.white}
              ios_backgroundColor={colors.gray300}
            />
          </View>
          <MenuItem
            label="Notification settings"
            subtitle="Manage TAKEME notifications in iOS Settings"
            onPress={props.onNotificationSettings}
          />
        </View>

        {/* Support */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Support</Text>
          <MenuItem label="Help" subtitle="FAQ and support" onPress={props.onHelp} />
          <MenuItem
            label="Report an Issue"
            subtitle="Safety or trip issues"
            onPress={props.onReportIssue}
          />
          <MenuItem label="Privacy Policy" subtitle="How your data is used" onPress={props.onPrivacy} />
          <MenuItem label="Terms of Service" subtitle="Driver agreement" onPress={props.onTerms} />
        </View>

        {/* Safety */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Safety</Text>
          <Pressable
            accessibilityRole="button"
            onPress={props.onCall911}
            style={({ pressed }) => [styles.emergencyRow, pressed && styles.pressed]}
          >
            <Ionicons name="call" size={20} color={colors.statusCritical} />
            <View style={styles.prefInfo}>
              <Text style={styles.emergencyLabel}>Call 911</Text>
              <Text style={styles.rowSubtitle}>
                In an emergency, call 911 first. Then report the trip to TAKEME.
              </Text>
            </View>
          </Pressable>
        </View>

        <Pressable style={styles.signOutButton} accessibilityRole="button" onPress={props.onSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>

        <Pressable
          style={styles.signOutButton}
          accessibilityRole="button"
          onPress={props.onDeleteAccount}
        >
          <Text style={styles.deleteText}>Delete Account</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function RateRow({
  label,
  pct,
  sampleNote,
}: {
  label: string;
  pct: number | null;
  sampleNote: string;
}) {
  return (
    <View style={styles.perfRow}>
      <View style={styles.prefInfo}>
        <Text style={styles.rowLabel}>{label}</Text>
        {pct == null ? <Text style={styles.rowSubtitle}>{sampleNote}</Text> : null}
      </View>
      {pct != null ? (
        <Text style={styles.perfValue}>{pct}%</Text>
      ) : (
        <Text style={styles.perfValueMuted}>Not enough data yet</Text>
      )}
    </View>
  );
}

function MenuItem({
  label,
  subtitle,
  onPress,
}: {
  label: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}
      accessibilityRole="button"
      onPress={onPress}
    >
      <View style={styles.prefInfo}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowSubtitle}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.gray400} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingBottom: spacing['5xl'] },
  header: {
    ...typography.h2,
    color: colors.text,
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  pressed: { opacity: 0.7 },

  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['2xl'],
    marginBottom: spacing['3xl'],
    gap: spacing.lg,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...typography.h2, color: colors.white },
  profileInfo: { flex: 1 },
  name: { ...typography.h3, color: colors.text },
  profileMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: 2,
    flexWrap: 'wrap',
  },
  verifiedBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  verifiedText: { ...typography.small, fontWeight: '600', color: colors.statusApproved },
  ratingWrap: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  ratingText: { ...typography.small, fontWeight: '600', color: colors.text },
  profileDetail: { ...typography.small, color: colors.textSecondary, marginTop: 2 },

  dataLoading: { paddingHorizontal: spacing['2xl'], marginBottom: spacing['3xl'] },
  dataError: {
    marginHorizontal: spacing['2xl'],
    marginBottom: spacing['3xl'],
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
  },
  dataErrorTitle: { ...typography.bodyBold, color: colors.text },
  dataErrorBody: { ...typography.small, color: colors.textSecondary, marginTop: 2 },
  dataErrorRetry: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  dataErrorRetryText: { ...typography.captionBold, color: colors.text, textDecorationLine: 'underline' },

  section: { marginBottom: spacing['3xl'] },
  sectionTitle: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing['2xl'],
    marginBottom: spacing.sm,
  },
  rowLabel: { ...typography.body, color: colors.text },
  rowSubtitle: { ...typography.small, color: colors.textSecondary, marginTop: 2 },

  vehicleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  vehicleInfo: { flex: 1 },
  vehicleName: { ...typography.bodyBold, color: colors.text },
  vehicleMeta: { ...typography.small, color: colors.textSecondary, marginTop: 2 },

  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: 56,
  },
  docInfo: { flex: 1 },

  perfRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: 52,
  },
  perfValue: { ...typography.bodyBold, color: colors.text },
  perfValueMuted: { ...typography.caption, color: colors.textMuted },
  perfWindowNote: {
    ...typography.small,
    color: colors.textMuted,
    paddingHorizontal: spacing['2xl'],
    marginTop: spacing.sm,
  },

  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing['2xl'],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.lg,
    minHeight: 52,
  },
  prefInfo: { flex: 1 },
  prefEnrollButton: {
    backgroundColor: colors.gray900,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 36,
    justifyContent: 'center',
  },
  prefEnrollText: { ...typography.captionBold, color: colors.white },
  prefLinkButton: { paddingVertical: spacing.sm, minHeight: 44, justifyContent: 'center' },
  prefLinkText: {
    ...typography.captionBold,
    color: colors.textSecondary,
    textDecorationLine: 'underline',
  },
  prefButtonDisabled: { opacity: 0.5 },

  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing['2xl'],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.lg,
    minHeight: 52,
  },

  emergencyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  emergencyLabel: { ...typography.bodyBold, color: colors.statusCritical },

  signOutButton: {
    marginHorizontal: spacing['2xl'],
    marginTop: spacing.xl,
    alignItems: 'center',
    paddingVertical: spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  signOutText: { ...typography.bodyBold, color: colors.text },
  deleteText: { ...typography.body, color: colors.textSecondary },
});
