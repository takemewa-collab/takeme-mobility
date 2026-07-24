import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
  Linking,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/providers/auth';
import { useTrip } from '@/providers/trip';
import { getClerkToken } from '@/lib/clerk';
import { isAlertSoundEnabled, setAlertSoundEnabled } from '@/lib/offer-alert';
import type { DriverRidePreferences } from '@takeme/shared';
import { formatPhone, API, ApiError } from '@takeme/shared';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

/** Prefer the server's own words on a rejected preference change. */
function serverMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const body = err.body as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
    if (typeof body.message === 'string' && body.message) return body.message;
  }
  return fallback;
}

export default function DriverAccountScreen() {
  const { user, signOut } = useAuth();
  const { apiClient } = useTrip();

  // Ride preferences — the section only renders once the endpoint answers, so
  // an older server (endpoint absent) degrades to no section at all.
  const [prefs, setPrefs] = useState<DriverRidePreferences | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  // Ride Request Alerts: in-app sound toggle. Vibration and push alerts stay
  // on regardless — the sound preference must never silently kill the alert.
  const [alertSound, setAlertSound] = useState(true);
  useEffect(() => {
    let cancelled = false;
    isAlertSoundEnabled().then((enabled) => {
      if (!cancelled) setAlertSound(enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const handleAlertSoundToggle = (value: boolean) => {
    setAlertSound(value);
    void setAlertSoundEnabled(value);
  };

  useEffect(() => {
    if (!apiClient) return;
    let cancelled = false;
    apiClient
      .get<DriverRidePreferences>(API.DRIVER_PREFERENCES)
      .then((data) => {
        if (cancelled || !data || typeof data.petFriendlyOptIn !== 'boolean') return;
        setPrefs({
          petFriendlyOptIn: data.petFriendlyOptIn,
          womenPreferred: {
            invited: data.womenPreferred?.invited === true,
            enrolled: data.womenPreferred?.enrolled === true,
          },
        });
      })
      .catch(() => {
        // Endpoint missing or unreachable — quietly hide the section.
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const handlePetToggle = (value: boolean) => {
    if (!apiClient || !prefs) return;
    // Optimistic: flip immediately, revert if the server rejects it.
    setPrefs({ ...prefs, petFriendlyOptIn: value });
    apiClient.put(API.DRIVER_PREFERENCES, { petFriendlyOptIn: value }).catch((err) => {
      setPrefs((p) => (p ? { ...p, petFriendlyOptIn: !value } : p));
      Alert.alert(
        'Could not update',
        serverMessage(err, 'Your Pet Friendly preference was not saved. Please try again.'),
      );
    });
  };

  const setEnrollment = async (enroll: boolean) => {
    if (!apiClient || !prefs || enrolling) return;
    setEnrolling(true);
    try {
      await apiClient.put(API.DRIVER_PREFERENCES, { womenPreferredEnroll: enroll });
      setPrefs((p) =>
        p ? { ...p, womenPreferred: { ...p.womenPreferred, enrolled: enroll } } : p,
      );
    } catch (err) {
      Alert.alert(
        enroll ? 'Could not enroll' : 'Could not leave program',
        serverMessage(err, 'Please try again or contact support@takememobility.com.'),
      );
    } finally {
      setEnrolling(false);
    }
  };

  const handleEnroll = () => {
    Alert.alert(
      'Women Preferred program',
      'This program matches you with riders who chose it. Participation is voluntary and you can leave the program at any time from this screen. Enrolling does not share any personal information about you or riders.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Enroll', onPress: () => setEnrollment(true) },
      ],
    );
  };

  const handleLeaveProgram = () => {
    Alert.alert('Leave Women Preferred program?', 'You can re-enroll at any time while invited.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave program', style: 'destructive', onPress: () => setEnrollment(false) },
    ]);
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  };

  const deleteAccount = async () => {
    try {
      const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
      const token = await getClerkToken();
      const res = await fetch(`${baseUrl}${API.ACCOUNT_DELETE}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await signOut();
    } catch {
      Alert.alert('Could not delete account', 'Please try again or contact support@takememobility.com.');
    }
  };

  const handleDeleteAccount = () => {
    // Two-step confirmation for an irreversible, data-destroying action.
    Alert.alert(
      'Delete Account',
      'This permanently deletes your account and all associated data (trips, earnings, payout info, documents). This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            Alert.alert('Are you sure?', 'This is permanent and cannot be reversed.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete my account', style: 'destructive', onPress: deleteAccount },
            ]),
        },
      ],
    );
  };

  const phone = user?.phone;
  const name = user?.full_name;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.header}>Account</Text>

        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {name ? name[0].toUpperCase() : 'D'}
            </Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.name}>{name ?? 'Driver'}</Text>
            {phone && <Text style={styles.phone}>{formatPhone(phone)}</Text>}
          </View>
        </View>

        {prefs ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Ride preferences</Text>

            <View style={styles.prefRow}>
              <View style={styles.prefInfo}>
                <Text style={styles.menuLabel}>Pet Friendly rides</Text>
                <Text style={styles.menuSubtitle}>
                  Accept trips where a rider brings a household pet
                </Text>
              </View>
              <Switch
                value={prefs.petFriendlyOptIn}
                onValueChange={handlePetToggle}
                trackColor={{ false: colors.gray300, true: colors.gray900 }}
                thumbColor={colors.white}
                ios_backgroundColor={colors.gray300}
              />
            </View>

            {/* Invite-only: no self-service path exists when not invited. */}
            {prefs.womenPreferred.invited || prefs.womenPreferred.enrolled ? (
              <View style={styles.prefRow}>
                <View style={styles.prefInfo}>
                  <Text style={styles.menuLabel}>Women Preferred program</Text>
                  <Text style={styles.menuSubtitle}>
                    {prefs.womenPreferred.enrolled ? 'Enrolled' : "You're invited"}
                  </Text>
                </View>
                {prefs.womenPreferred.enrolled ? (
                  <Pressable
                    onPress={handleLeaveProgram}
                    disabled={enrolling}
                    style={[styles.prefLinkButton, enrolling && styles.prefButtonDisabled]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.prefLinkText}>
                      {enrolling ? 'Updating...' : 'Leave program'}
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={handleEnroll}
                    disabled={enrolling}
                    style={[styles.prefEnrollButton, enrolling && styles.prefButtonDisabled]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.prefEnrollText}>
                      {enrolling ? 'Enrolling...' : 'Enroll'}
                    </Text>
                  </Pressable>
                )}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ride request alerts</Text>
          <View style={styles.prefRow}>
            <View style={styles.prefInfo}>
              <Text style={styles.menuLabel}>Alert sound</Text>
              <Text style={styles.menuSubtitle}>
                Play the loud TAKEME alert for incoming requests. Vibration and
                notifications stay on.
              </Text>
            </View>
            <Switch
              value={alertSound}
              onValueChange={handleAlertSoundToggle}
              trackColor={{ false: colors.gray300, true: colors.gray900 }}
              thumbColor={colors.white}
              ios_backgroundColor={colors.gray300}
            />
          </View>
        </View>

        {/* Vehicle and payout self-service ship in the next release; until the
            screens exist we don't show doors that open onto "Coming soon". */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Support</Text>
          <MenuItem label="Help" subtitle="FAQ and support" onPress={() => Linking.openURL('mailto:support@takememobility.com')} />
          <MenuItem label="Report an Issue" subtitle="Safety or trip issues" onPress={() => Linking.openURL('mailto:safety@takememobility.com')} />
        </View>

        <Pressable style={styles.signOutButton} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>

        <Pressable style={styles.signOutButton} onPress={handleDeleteAccount}>
          <Text style={styles.deleteText}>Delete Account</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function MenuItem({ label, subtitle, onPress }: { label: string; subtitle: string; onPress: () => void }) {
  return (
    <Pressable style={styles.menuItem} onPress={onPress}>
      <View>
        <Text style={styles.menuLabel}>{label}</Text>
        <Text style={styles.menuSubtitle}>{subtitle}</Text>
      </View>
      <Text style={styles.chevron}>{'\u203A'}</Text>
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
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing['2xl'],
    padding: spacing.lg,
    backgroundColor: colors.gray50,
    borderRadius: borderRadius.lg,
    marginBottom: spacing['3xl'],
  },
  avatar: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.lg,
  },
  avatarText: { ...typography.h2, color: colors.white },
  profileInfo: { flex: 1 },
  name: { ...typography.bodyBold, color: colors.text },
  phone: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  section: { marginBottom: spacing['2xl'] },
  sectionTitle: {
    ...typography.captionBold, color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.5,
    paddingHorizontal: spacing['2xl'], marginBottom: spacing.sm,
  },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.md, paddingHorizontal: spacing['2xl'],
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  menuLabel: { ...typography.body, color: colors.text },
  menuSubtitle: { ...typography.small, color: colors.textSecondary, marginTop: 2 },
  chevron: { fontSize: 22, color: colors.textMuted },
  prefRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.md, paddingHorizontal: spacing['2xl'],
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  prefInfo: { flex: 1, marginRight: spacing.lg },
  prefEnrollButton: {
    backgroundColor: colors.gray900, borderRadius: borderRadius.md,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.lg,
  },
  prefEnrollText: { ...typography.captionBold, color: colors.white },
  prefLinkButton: { paddingVertical: spacing.sm },
  prefLinkText: { ...typography.captionBold, color: colors.textSecondary, textDecorationLine: 'underline' },
  prefButtonDisabled: { opacity: 0.5 },
  signOutButton: {
    marginHorizontal: spacing['2xl'], marginTop: spacing.xl,
    alignItems: 'center', paddingVertical: spacing.md,
  },
  signOutText: { ...typography.bodyBold, color: colors.error },
  deleteText: { ...typography.body, color: colors.textSecondary },
});
