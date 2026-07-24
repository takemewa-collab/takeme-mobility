/**
 * All API endpoint paths, centralized so both rider and driver apps
 * reference the same routes. These map to the Next.js /api/* routes.
 */
export const API = {
  // Auth
  AUTH_SEND_OTP: '/api/auth/send-otp',
  AUTH_VERIFY_OTP: '/api/auth/verify-otp',
  AUTH_LOGIN: '/api/auth/login',
  AUTH_SIGNUP: '/api/auth/signup',

  // Account
  ACCOUNT_DELETE: '/api/account/delete',

  // Quotes
  QUOTES: '/api/quotes',

  // Rides
  RIDES_CREATE: '/api/rides/create',
  RIDES_CANCEL: '/api/rides/cancel',
  RIDES_LIST: '/api/rides',

  // Dispatch
  DISPATCH: '/api/dispatch',

  // Payments
  PAYMENTS: '/api/payments',
  PAYMENTS_CAPTURE: '/api/payments/capture',

  // Driver
  DRIVER_APPLY: '/api/driver/apply',
  DRIVER_APPROVE: '/api/driver/approve',
  DRIVER_STATUS: '/api/driver/status',
  DRIVER_LOCATION: '/api/driver/location',
  DRIVER_ROUTE: '/api/driver/route',
  PUSH_TOKEN: '/api/push-token',
  DRIVER_RIDES: '/api/driver/rides',
  DRIVER_PREFERENCES: '/api/driver/preferences',
  DRIVER_DASHBOARD: '/api/driver/dashboard',
  DRIVER_DOCUMENTS: '/api/driver/documents',
  DRIVER_ONBOARDING: '/api/driver/onboarding',
  DRIVER_ONBOARDING_VEHICLE: '/api/driver/onboarding/vehicle',
  DRIVER_ONBOARDING_LEGAL: '/api/driver/onboarding/legal',
  DRIVER_ONBOARDING_DOCUMENTS: '/api/driver/onboarding/documents',
  DRIVER_ONBOARDING_BACKGROUND: '/api/driver/onboarding/background-check',
  DRIVER_ONBOARDING_TRAINING: '/api/driver/onboarding/training',
  DRIVER_ONBOARDING_WAITLIST: '/api/driver/onboarding/waitlist',
  DRIVER_EARNINGS_ADD: '/api/driver/earnings/add',
  DRIVER_PAYOUTS_INSTANT: '/api/driver/payouts/instant',

  // Cards
  CARD_CREATE_CARDHOLDER: '/api/card/create-cardholder',
  CARD_CREATE_VIRTUAL: '/api/card/create-virtual',
  CARD_CREATE_PHYSICAL: '/api/card/create-physical',
  CARD_ACTIVATE: '/api/card/activate',
  CARD_STATUS: '/api/card/status',
  CARD_FUND: '/api/card/fund',

  // Health
  HEALTH: '/api/health',
} as const;
