import { useState, useCallback } from 'react';
import { Alert } from 'react-native';
import { isStripeConfigured } from '@/providers/stripe';
import { useAuth } from '@/providers/auth';
import { useSupabase } from '@/providers/supabase';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

interface PaymentResult {
  success: boolean;
  paymentIntentId?: string;
  error?: string;
}

/**
 * Stripe PaymentSheet hook.
 *
 * Dynamically requires @stripe/stripe-react-native at call time to avoid
 * crashing in Expo Go where native modules don't exist. The Metro resolver
 * stub in metro.config.js handles the bundling side.
 *
 * In Expo Go: returns "Stripe not configured" immediately.
 * In dev build: runs the full PaymentSheet flow.
 */
export function usePayment() {
  const { user } = useAuth();
  const supabase = useSupabase();
  const [loading, setLoading] = useState(false);
  const [lastPaymentMethod, setLastPaymentMethod] = useState<string | null>(null);

  const requestPayment = useCallback(
    async (amountUsd: number): Promise<PaymentResult> => {
      if (!isStripeConfigured) {
        return { success: false, error: 'Stripe not configured' };
      }
      if (!user) {
        return { success: false, error: 'Not authenticated' };
      }

      setLoading(true);
      try {
        // Dynamic require — safe because Metro stubs the native specs
        const stripe = require('@stripe/stripe-react-native');
        const { initPaymentSheet, presentPaymentSheet } = stripe;

        if (!initPaymentSheet || !presentPaymentSheet) {
          return { success: false, error: 'Stripe native module not available. Use a dev build.' };
        }

        // 1. Create PaymentIntent on backend
        console.log('[payment] Creating intent: $' + amountUsd.toFixed(2));

        // Server derives the rider from the Bearer token — never trust a
        // client-supplied riderId for payment operations.
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) {
          return { success: false, error: 'Session expired. Sign in again.' };
        }

        const res = await fetch(`${API_BASE}/api/mobile/payment-sheet`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            amount: amountUsd,
            email: user.email,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }

        const { clientSecret, ephemeralKey, customerId, paymentIntentId } = await res.json();

        // 2. Initialize PaymentSheet
        const { error: initError } = await initPaymentSheet({
          paymentIntentClientSecret: clientSecret,
          customerEphemeralKeySecret: ephemeralKey,
          customerId,
          merchantDisplayName: 'Takeme',
          applePay: { merchantCountryCode: 'US' },
          // testEnv must be false in release builds or real cards won't charge.
          googlePay: { merchantCountryCode: 'US', testEnv: __DEV__ },
          allowsDelayedPaymentMethods: false,
        });

        if (initError) {
          return { success: false, error: initError.message };
        }

        // 3. Present PaymentSheet
        const { error: presentError } = await presentPaymentSheet();

        if (presentError) {
          if (presentError.code === 'Canceled') {
            return { success: false, error: 'cancelled' };
          }
          return { success: false, error: presentError.message };
        }

        // Authorized (not captured)
        console.log('[payment] Authorized:', paymentIntentId);
        setLastPaymentMethod('Card ending ····');
        return { success: true, paymentIntentId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Payment failed';
        console.error('[payment] Error:', msg);
        return { success: false, error: msg };
      } finally {
        setLoading(false);
      }
    },
    [user, supabase],
  );

  return {
    requestPayment,
    loading,
    lastPaymentMethod,
    isConfigured: isStripeConfigured,
  };
}
