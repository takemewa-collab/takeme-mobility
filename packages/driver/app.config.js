/** @type {import('expo/config').ExpoConfig} */

const GOOGLE_MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

module.exports = ({ config }) => ({
  ...config,
  name: 'Takeme Driver',
  slug: 'takeme-driver',
  owner: 'takememobilitys-organization',
  version: '0.1.0',
  runtimeVersion: {
    policy: 'appVersion',
  },
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'takeme-driver',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0F172A',
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.takememobility.driver',
    config: {
      googleMapsApiKey: GOOGLE_MAPS_API_KEY,
    },
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'Takeme Driver needs your location to receive ride requests from nearby riders.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Takeme Driver broadcasts your location to riders while you are online, even when the app is in the background.',
      // Only 'location' is actually used. 'remote-notification' and 'fetch'
      // were declared but there is no push-registration or background-fetch
      // code, which draws App Review scrutiny — removed until implemented.
      UIBackgroundModes: ['location'],
      // HTTPS-only app → no non-exempt encryption (skips export-compliance hold).
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0F172A',
    },
    package: 'com.takememobility.driver',
    config: {
      googleMaps: {
        apiKey: GOOGLE_MAPS_API_KEY,
      },
    },
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
    ],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'Takeme Driver broadcasts your location while online to match you with nearby riders.',
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#0F172A',
      },
    ],
    'expo-task-manager',
  ],
  extra: {
    eas: {
      projectId: '54d340d6-471d-4b38-aa64-31c8cb0cf354',
    },
  },
  experiments: {
    typedRoutes: true,
  },
});
