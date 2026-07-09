import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/providers/auth';
import { API } from '@takeme/shared';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing } from '@/theme/spacing';

const MENU_ITEMS = [
  'Ride History',
  'Payment',
  'Personal Info',
  'Security & Privacy',
  'Support',
] as const;

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, session, signOut } = useAuth();
  const name = user?.user_metadata?.full_name ?? 'Rider';

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
      'This permanently deletes your account and all associated data (rides, payment info, profile). This cannot be undone.',
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

  const handleMenuPress = (label: string) => {
    switch (label) {
      case 'Ride History':
        router.push('/(app)/(tabs)/activity');
        break;
      case 'Support':
        Linking.openURL('mailto:support@takememobility.com');
        break;
      default:
        Alert.alert(label, 'Coming soon');
    }
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Back / header area — just breathing room on a tab screen */}
        <View style={styles.topSpacer} />

        {/* Avatar */}
        <View style={styles.avatarWrap}>
          <View style={styles.avatar}>
            <Text style={styles.avatarLetter}>
              {name[0]?.toUpperCase() ?? 'R'}
            </Text>
          </View>
        </View>

        {/* Name */}
        <Text style={styles.name}>{name}</Text>

        {/* Menu */}
        <View style={styles.menu}>
          {MENU_ITEMS.map((label, i) => (
            <Pressable
              key={label}
              onPress={() => handleMenuPress(label)}
              style={({ pressed }) => [
                styles.row,
                pressed && styles.rowPressed,
                i < MENU_ITEMS.length - 1 && styles.rowDivider,
              ]}
            >
              <Text style={styles.rowLabel}>{label}</Text>
              <Text style={styles.chevron}>{'\u203A'}</Text>
            </Pressable>
          ))}
        </View>

        {/* Bottom */}
        <View style={styles.bottom}>
          <Pressable
            style={({ pressed }) => [styles.signOutBtn, pressed && styles.signOutPressed]}
            onPress={handleSignOut}
          >
            <Text style={styles.signOutText}>Sign Out</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.signOutBtn, pressed && styles.signOutPressed]}
            onPress={handleDeleteAccount}
          >
            <Text style={styles.deleteText}>Delete Account</Text>
          </Pressable>

          <Text style={styles.version}>Takeme v0.1.0</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.white,
  },
  scroll: {
    flexGrow: 1,
  },

  topSpacer: {
    height: 20,
  },

  // ── Avatar ──
  avatarWrap: {
    alignItems: 'center',
    marginTop: spacing['4xl'],
    marginBottom: spacing['2xl'],
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.black,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    fontSize: 34,
    fontWeight: '300',
    color: colors.white,
    letterSpacing: -0.5,
  },

  // ── Name ──
  name: {
    ...typography.h3,
    color: colors.black,
    textAlign: 'center',
    marginBottom: spacing['5xl'],
  },

  // ── Menu ──
  menu: {
    paddingHorizontal: spacing.screen,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 22,
  },
  rowPressed: {
    opacity: 0.5,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray200,
  },
  rowLabel: {
    fontSize: 17,
    fontWeight: '400',
    color: colors.black,
    letterSpacing: -0.2,
  },
  chevron: {
    fontSize: 22,
    fontWeight: '300',
    color: colors.gray300,
  },

  // ── Bottom ──
  bottom: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingTop: spacing['6xl'],
  },
  signOutBtn: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing['3xl'],
    marginBottom: spacing['2xl'],
  },
  signOutPressed: {
    opacity: 0.5,
  },
  signOutText: {
    fontSize: 15,
    fontWeight: '400',
    color: colors.gray500,
    letterSpacing: -0.1,
  },
  deleteText: {
    fontSize: 15,
    fontWeight: '400',
    color: '#DC2626',
    letterSpacing: -0.1,
  },
  version: {
    fontSize: 12,
    fontWeight: '400',
    color: colors.gray300,
    letterSpacing: 0.2,
  },
});
