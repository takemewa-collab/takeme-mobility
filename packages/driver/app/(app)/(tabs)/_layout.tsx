import React from 'react';
import { StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';

type IoniconName = keyof typeof Ionicons.glyphMap;

function icon(focused: IoniconName, unfocused: IoniconName) {
  return function TabIcon({ focused: isFocused, color }: { focused: boolean; color: string }) {
    return <Ionicons name={isFocused ? focused : unfocused} size={24} color={color} />;
  };
}

export default function DriverTabLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.gray400,
        // Edge-to-edge bar: full width, anchored to the bottom, solid white
        // with a top hairline; the home-indicator safe area lives INSIDE the
        // bar so nothing ever peeks out beneath it.
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 56 + insets.bottom,
          paddingBottom: Math.max(insets.bottom, 8),
          paddingTop: 6,
        },
        tabBarLabelStyle: { ...typography.small, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{ title: 'Home', tabBarIcon: icon('home', 'home-outline') }}
      />
      <Tabs.Screen
        name="earnings"
        options={{ title: 'Earnings', tabBarIcon: icon('wallet', 'wallet-outline') }}
      />
      <Tabs.Screen
        name="trips"
        options={{ title: 'Trips', tabBarIcon: icon('car', 'car-outline') }}
      />
      <Tabs.Screen
        name="schedule"
        options={{ title: 'Schedule', tabBarIcon: icon('calendar', 'calendar-outline') }}
      />
      <Tabs.Screen
        name="account"
        options={{ title: 'Account', tabBarIcon: icon('person', 'person-outline') }}
      />
    </Tabs>
  );
}
