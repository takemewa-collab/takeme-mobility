import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import type { DriverRidePreferences } from '@takeme/shared';
import { API, ApiError } from '@takeme/shared';
import { useAuth } from '@/providers/auth';
import { useTrip } from '@/providers/trip';
import { getClerkToken } from '@/lib/clerk';
import { isAlertSoundEnabled, setAlertSoundEnabled } from '@/lib/offer-alert';
import { useApiResource } from '@/hooks/use-api-resource';
import type { PerformanceResponse, ProfileResponse } from '@/types/driver-hub';
import { AccountScreenView } from '@/screens/account-screen';

/** Prefer the server's own words on a rejected preference change. */
function serverMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const body = err.body as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
    if (typeof body.message === 'string' && body.message) return body.message;
  }
  return fallback;
}

export default function DriverAccountTab() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { apiClient } = useTrip();

  // ── Profile + performance (real data or an honest error card) ──
  const profileFetcher = useMemo(() => {
    if (!apiClient) return null;
    return () => apiClient.get<ProfileResponse>(API.DRIVER_PROFILE);
  }, [apiClient]);
  const profile = useApiResource(profileFetcher);

  const performanceFetcher = useMemo(() => {
    if (!apiClient) return null;
    return () => apiClient.get<PerformanceResponse>(API.DRIVER_PERFORMANCE);
  }, [apiClient]);
  const performance = useApiResource(performanceFetcher);

  // Combined phase for the data-backed sections: error only when the profile
  // itself failed; performance failing alone just hides its section.
  const dataPhase: 'loading' | 'error' | 'ready' =
    profile.phase === 'loading' ? 'loading' : profile.phase === 'error' ? 'error' : 'ready';

  const retryData = useCallback(() => {
    profile.reload();
    performance.reload();
  }, [profile, performance]);

  const refreshData = useCallback(() => {
    profile.refresh();
    performance.reload();
  }, [profile, performance]);

  // ── Ride preferences — existing behavior, unchanged ──
  const [prefs, setPrefs] = useState<DriverRidePreferences | null>(null);
  const [enrolling, setEnrolling] = useState(false);

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

  const handlePetToggle = useCallback(
    (value: boolean) => {
      if (!apiClient || !prefs) return;
      setPrefs({ ...prefs, petFriendlyOptIn: value });
      apiClient.put(API.DRIVER_PREFERENCES, { petFriendlyOptIn: value }).catch((err) => {
        setPrefs((p) => (p ? { ...p, petFriendlyOptIn: !value } : p));
        Alert.alert(
          'Could not update',
          serverMessage(err, 'Your Pet Friendly preference was not saved. Please try again.'),
        );
      });
    },
    [apiClient, prefs],
  );

  const setEnrollment = useCallback(
    async (enroll: boolean) => {
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
    },
    [apiClient, prefs, enrolling],
  );

  const handleEnroll = useCallback(() => {
    Alert.alert(
      'Women Preferred program',
      'This program matches you with riders who chose it. Participation is voluntary and you can leave the program at any time from this screen. Enrolling does not share any personal information about you or riders.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Enroll', onPress: () => setEnrollment(true) },
      ],
    );
  }, [setEnrollment]);

  const handleLeaveProgram = useCallback(() => {
    Alert.alert('Leave Women Preferred program?', 'You can re-enroll at any time while invited.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave program', style: 'destructive', onPress: () => setEnrollment(false) },
    ]);
  }, [setEnrollment]);

  // ── Alert sound — existing behavior, unchanged ──
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
  const handleAlertSoundToggle = useCallback((value: boolean) => {
    setAlertSound(value);
    void setAlertSoundEnabled(value);
  }, []);

  // ── Sign out / delete — existing behavior, unchanged ──
  const handleSignOut = useCallback(() => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  }, [signOut]);

  const deleteAccount = useCallback(async () => {
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
      Alert.alert(
        'Could not delete account',
        'Please try again or contact support@takememobility.com.',
      );
    }
  }, [signOut]);

  const handleDeleteAccount = useCallback(() => {
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
  }, [deleteAccount]);

  return (
    <AccountScreenView
      phase={dataPhase}
      profile={profile.data}
      performance={performance.data}
      identity={{ name: user?.full_name ?? null, phone: user?.phone ?? null }}
      onRetry={retryData}
      refreshing={profile.refreshing}
      onRefresh={refreshData}
      prefs={prefs}
      enrolling={enrolling}
      onPetToggle={handlePetToggle}
      onEnrollPress={handleEnroll}
      onLeavePress={handleLeaveProgram}
      alertSound={alertSound}
      onAlertSoundChange={handleAlertSoundToggle}
      onDocumentPress={() => router.push('/onboarding')}
      onNotificationSettings={() => void Linking.openSettings()}
      onHelp={() => void Linking.openURL('mailto:support@takememobility.com')}
      onReportIssue={() => void Linking.openURL('mailto:safety@takememobility.com')}
      onPrivacy={() => void WebBrowser.openBrowserAsync('https://www.takememobility.com/privacy')}
      onTerms={() => void WebBrowser.openBrowserAsync('https://www.takememobility.com/terms')}
      onCall911={() => void Linking.openURL('tel:911')}
      onSignOut={handleSignOut}
      onDeleteAccount={handleDeleteAccount}
    />
  );
}
