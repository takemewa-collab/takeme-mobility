import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiClient, API } from '@takeme/shared';
import { Button } from '@/components/ui';
import { useAuth } from '@/providers/auth';
import { getClerkToken } from '@/lib/clerk';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

const REQUIRED_DOCS = [
  { key: 'license_front', label: "Driver's License (Front)" },
  { key: 'license_back', label: "Driver's License (Back)" },
  { key: 'insurance', label: 'Insurance Card' },
  { key: 'registration', label: 'Vehicle Registration' },
  { key: 'profile_photo', label: 'Profile Photo' },
] as const;

export default function DocumentsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  const apiClient = useMemo(() => {
    const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!baseUrl) return null;
    return new ApiClient({
      baseUrl,
      getAccessToken: getClerkToken,
    });
  }, []);

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      if (apiClient) {
        await apiClient.post(API.DRIVER_APPLY, {
          fullName: params.fullName ?? '',
          phone: user?.phone ?? '',
          email: params.email ?? '',
          licenseNumber: params.licenseNumber ?? '',
          vehicleMake: params.vehicleMake ?? '',
          vehicleModel: params.vehicleModel ?? '',
          vehicleYear: parseInt(String(params.vehicleYear ?? '2024')),
          vehicleColor: params.vehicleColor ?? '',
          plateNumber: params.plateNumber ?? '',
          vehicleClass: 'electric',
        });
      }
      router.push('/(auth)/onboarding/pending');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Submission failed';
      Alert.alert('Error', message);
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.step}>Step 3 of 3</Text>
        <Text style={styles.title}>Upload Documents</Text>
        <Text style={styles.subtitle}>
          We need these documents to verify your identity and vehicle.
          Document upload will be available after approval.
        </Text>

        {REQUIRED_DOCS.map((doc) => (
          <Pressable
            key={doc.key}
            style={styles.uploadCard}
            onPress={() => Alert.alert('Coming soon', 'Document upload will be available in the next update.')}
          >
            <View style={styles.uploadIcon}>
              <Text style={styles.uploadIconText}>{'\u2191'}</Text>
            </View>
            <View style={styles.uploadInfo}>
              <Text style={styles.uploadLabel}>{doc.label}</Text>
              <Text style={styles.uploadStatus}>Tap to upload</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.bottom}>
        <Button
          title={submitting ? 'Submitting...' : 'Submit Application'}
          onPress={handleSubmit}
          size="lg"
          fullWidth
          disabled={submitting}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { padding: spacing['2xl'], paddingTop: spacing['3xl'] },
  step: { ...typography.captionBold, color: colors.accent, marginBottom: spacing.sm },
  title: { ...typography.h2, color: colors.text, marginBottom: spacing.sm },
  subtitle: { ...typography.body, color: colors.textSecondary, marginBottom: spacing['3xl'] },
  uploadCard: {
    flexDirection: 'row', alignItems: 'center', padding: spacing.lg,
    backgroundColor: colors.gray50, borderRadius: borderRadius.md,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', marginBottom: spacing.md,
  },
  uploadIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent + '20',
    alignItems: 'center', justifyContent: 'center', marginRight: spacing.md,
  },
  uploadIconText: { fontSize: 18, color: colors.accent },
  uploadInfo: { flex: 1 },
  uploadLabel: { ...typography.bodyBold, color: colors.text },
  uploadStatus: { ...typography.small, color: colors.textMuted, marginTop: 2 },
  bottom: { padding: spacing['2xl'] },
});
