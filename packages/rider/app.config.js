/** @type {import('expo/config').ExpoConfig} */

const GOOGLE_MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const STRIPE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
const MERCHANT_ID = process.env.EXPO_PUBLIC_MERCHANT_ID ?? 'merchant.com.takememobility.rider';

module.exports = ({ config }) => ({
  ...config,
  name: 'Takeme',
  slug: 'takeme',
  owner: 'takememobilitys-organization',
  version: '0.1.0',
  runtimeVersion: {
    policy: 'appVersion',
  },
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'takeme-rider',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#0F172A',
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.takememobility.rider',
    config: {
      googleMapsApiKey: GOOGLE_MAPS_API_KEY,
    },
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'Takeme needs your location to find nearby drivers and show your position on the map.',
      // HTTPS-only app: no non-exempt encryption → avoids the export-compliance
      // prompt holding every TestFlight/App Store submission.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0F172A',
    },
    package: 'com.takememobility.rider',
    config: {
      googleMaps: {
        apiKey: GOOGLE_MAPS_API_KEY,
      },
    },
    permissions: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    // Rider uses foreground location only (NSLocationWhenInUseUsageDescription
    // above). No "Always"/background authorization is requested — asking for it
    // without background use is a common App Store privacy rejection.
    'expo-location',
    [
      '@stripe/stripe-react-native',
      {
        merchantIdentifier: MERCHANT_ID,
        enableGooglePay: true,
      },
    ],
  ],
  extra: {
    eas: {
      projectId: 'f793a12f-748f-4da0-96b2-ee293210526b',
    },
  },
  experiments: {
    typedRoutes: true,
  },
});
