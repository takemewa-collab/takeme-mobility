/** @type {import('expo/config').ExpoConfig} */

const GOOGLE_MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

module.exports = ({ config }) => ({
  ...config,
  name: 'Takeme Driver',
  slug: 'takeme-driver',
  owner: 'takememobility-app',
  version: '1.0.0',
  runtimeVersion: {
    policy: 'appVersion',
  },
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'takeme-driver',
  extra: {
    eas: {
      projectId: '0cc33074-ead9-4e4b-92bc-06077d4b205d',
    },
  },
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#111111',
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
    entitlements: {
      // Ride offers are delivered with interruption-level "time-sensitive" —
      // iOS requires this entitlement for the level to be honored. This is
      // NOT the Critical Alerts entitlement; silent mode / Focus behavior is
      // respected within Apple's rules.
      'com.apple.developer.usernotifications.time-sensitive': true,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#111111',
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
        color: '#111111',
        // Bundled ride-request alert (iOS bundle + android/res/raw) — referenced
        // by filename in the push payload and the Android channel config.
        sounds: ['./assets/sounds/ride_request.wav'],
      },
    ],
    'expo-task-manager',
    [
      'expo-image-picker',
      {
        cameraPermission:
          'TAKEME uses your camera to photograph your documents for verification.',
        photosPermission:
          'TAKEME uses your photo library to attach photos of your documents for verification.',
      },
    ],
    [
      '@sentry/react-native/expo',
      {
        organization: 'takeme-mobility',
        project: 'takeme-driver',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
});
