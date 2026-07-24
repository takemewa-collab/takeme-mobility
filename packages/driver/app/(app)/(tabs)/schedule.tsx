import React from 'react';
import { useRouter } from 'expo-router';
import { useDriverStatus } from '@/providers/driver-status';
import { ScheduleScreenView } from '@/screens/schedule-screen';

/**
 * Schedule tab container. The platform has no scheduled-rides backend yet —
 * the screen states that plainly ("Coming later") and only surfaces real
 * state: the driver's live online status and a link to alert settings.
 */
export default function ScheduleTab() {
  const router = useRouter();
  const { status } = useDriverStatus();
  const online = status === 'available' || status === 'busy' || status === 'on_trip';

  return (
    <ScheduleScreenView
      online={online}
      onGoToHome={() => router.push('/(app)/(tabs)/dashboard')}
      onOpenAlertSettings={() => router.push('/(app)/(tabs)/account')}
    />
  );
}
