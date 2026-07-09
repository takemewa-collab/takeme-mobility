import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/providers/auth';
import { formatPhone, API } from '@takeme/shared';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

export default function DriverAccountScreen() {
  const { user, session, signOut } = useAuth();

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  };

  const deleteAccount = async () => {
    try {
      const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
      const res = await fetch(`${baseUrl}${API.ACCOUNT_DELETE}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
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

  const phone = user?.phone ?? user?.user_metadata?.phone;
  const name = user?.user_metadata?.full_name;

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

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Vehicle</Text>
          <MenuItem label="Vehicle Info" subtitle="Manage your vehicle details" />
          <MenuItem label="Documents" subtitle="View uploaded documents" />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payments</Text>
          <MenuItem label="Payout Method" subtitle="Bank account, Takeme Card" />
          <MenuItem label="Tax Documents" subtitle="1099 and tax information" />
        </View>

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

function MenuItem({ label, subtitle, onPress }: { label: string; subtitle: string; onPress?: () => void }) {
  return (
    <Pressable style={styles.menuItem} onPress={onPress ?? (() => Alert.alert(label, 'Coming soon'))}>
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
  signOutButton: {
    marginHorizontal: spacing['2xl'], marginTop: spacing.xl,
    alignItems: 'center', paddingVertical: spacing.md,
  },
  signOutText: { ...typography.bodyBold, color: colors.error },
  deleteText: { ...typography.body, color: '#DC2626' },
});
