import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ClerkProvider,
  useAuth as useClerkSession,
  useSignIn,
  useSignUp,
} from '@clerk/clerk-expo';
import { tokenCache } from '@clerk/clerk-expo/token-cache';
import { CLERK_PUBLISHABLE_KEY } from '@/lib/clerk';

/**
 * Clerk owns identity and OTP delivery (real SMS — no Twilio, no mock codes),
 * and Supabase accepts the Clerk session token natively via third-party auth.
 * The only platform hop left is /api/auth/profile, which ensures the shadow
 * Supabase user and returns its id — the id drivers.auth_user_id keys on.
 */

export type DriverUser = {
  /** Shadow Supabase auth user id (drivers.auth_user_id), not the Clerk id. */
  id: string;
  phone: string | null;
  email: string | null;
  full_name: string | null;
};

interface AuthState {
  user: DriverUser | null;
  loading: boolean;
  initialized: boolean;
}

interface AuthActions {
  sendOtp: (phone: string) => Promise<{ success: boolean; error?: string }>;
  verifyOtp: (phone: string, code: string) => Promise<{ success: boolean; error?: string }>;
  /** Email one-time code — an alternative to phone for drivers without SMS. */
  sendEmailOtp: (email: string) => Promise<{ success: boolean; error?: string }>;
  verifyEmailOtp: (email: string, code: string) => Promise<{ success: boolean; error?: string }>;
  signOut: () => Promise<void>;
}

type AuthContextValue = AuthState & AuthActions;

const AuthContext = createContext<AuthContextValue | null>(null);

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL!;

/** One line out of Clerk's error array, readable enough to show a driver. */
function clerkError(e: unknown): string {
  const err = e as { errors?: { longMessage?: string; message?: string }[] };
  return err?.errors?.[0]?.longMessage ?? err?.errors?.[0]?.message ?? 'Something went wrong.';
}

type ProfileResponse = {
  user: { id: string; phone: string | null; email: string | null; fullName: string | null };
};

function useClerkAuthValue(): AuthContextValue {
  const { isLoaded, isSignedIn, getToken, signOut: clerkSignOut } = useClerkSession();
  const { signIn, setActive: setActiveSignIn } = useSignIn();
  const { signUp, setActive: setActiveSignUp } = useSignUp();
  const [user, setUser] = useState<DriverUser | null>(null);
  const [profileResolved, setProfileResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  // Which flow the pending OTP belongs to — Clerk splits new vs. returning.
  const flow = useRef<'signIn' | 'signUp'>('signIn');

  /**
   * Ensures the shadow Supabase user and loads the platform identity. The
   * returned id is the Supabase auth user id — what drivers.auth_user_id
   * and trip queries key on — not the Clerk id.
   */
  const loadProfile = useCallback(async (): Promise<void> => {
    const clerkToken = await getToken();
    if (!clerkToken) throw new Error('no Clerk session');
    const response = await fetch(`${API_BASE_URL}/api/auth/profile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clerkToken}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`profile failed (${response.status})`);
    const body = (await response.json()) as ProfileResponse;
    setUser({
      id: body.user.id,
      phone: body.user.phone,
      email: body.user.email,
      full_name: body.user.fullName,
    });
    setProfileResolved(true);
  }, [getToken]);

  // Restore on launch: Clerk rehydrates its session from SecureStore; we
  // resolve it to the platform identity. Failure = signed out, never a hang.
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on sign-out, not a render loop
      setUser(null);
      setProfileResolved(false);
      return;
    }
    loadProfile().catch(() => setProfileResolved(true));
  }, [isLoaded, isSignedIn, loadProfile]);

  const sendOtp = useCallback(
    async (phone: string) => {
      if (!signIn || !signUp) return { success: false, error: 'Auth is still loading.' };
      setBusy(true);
      try {
        const attempt = await signIn.create({ identifier: phone });
        const factor = attempt.supportedFirstFactors?.find(
          (f): f is Extract<typeof f, { strategy: 'phone_code' }> => f.strategy === 'phone_code',
        );
        if (!factor) return { success: false, error: 'Phone sign-in is not enabled.' };
        await signIn.prepareFirstFactor({
          strategy: 'phone_code',
          phoneNumberId: factor.phoneNumberId,
        });
        flow.current = 'signIn';
        return { success: true };
      } catch {
        // Unknown identifier → this is a brand-new driver.
        try {
          await signUp.create({ phoneNumber: phone });
          await signUp.preparePhoneNumberVerification();
          flow.current = 'signUp';
          return { success: true };
        } catch (e) {
          return { success: false, error: clerkError(e) };
        }
      } finally {
        setBusy(false);
      }
    },
    [signIn, signUp],
  );

  const verifyOtp = useCallback(
    async (_phone: string, code: string) => {
      setBusy(true);
      try {
        if (flow.current === 'signUp') {
          if (!signUp || !setActiveSignUp) return { success: false, error: 'Auth is still loading.' };
          const result = await signUp.attemptPhoneNumberVerification({ code });
          if (result.status !== 'complete' || !result.createdSessionId) {
            return { success: false, error: 'That code is wrong or has expired.' };
          }
          await setActiveSignUp({ session: result.createdSessionId });
        } else {
          if (!signIn || !setActiveSignIn) return { success: false, error: 'Auth is still loading.' };
          const result = await signIn.attemptFirstFactor({ strategy: 'phone_code', code });
          if (result.status !== 'complete' || !result.createdSessionId) {
            return { success: false, error: 'That code is wrong or has expired.' };
          }
          await setActiveSignIn({ session: result.createdSessionId });
        }
        // Block until the platform identity exists so the next screen can load.
        await loadProfile();
        return { success: true };
      } catch (e) {
        return { success: false, error: clerkError(e) };
      } finally {
        setBusy(false);
      }
    },
    [signIn, signUp, setActiveSignIn, setActiveSignUp, loadProfile],
  );

  const sendEmailOtp = useCallback(
    async (email: string) => {
      if (!signIn || !signUp) return { success: false, error: 'Auth is still loading.' };
      setBusy(true);
      try {
        const attempt = await signIn.create({ identifier: email });
        const factor = attempt.supportedFirstFactors?.find(
          (f): f is Extract<typeof f, { strategy: 'email_code' }> => f.strategy === 'email_code',
        );
        if (!factor) return { success: false, error: 'Email sign-in is not enabled.' };
        await signIn.prepareFirstFactor({
          strategy: 'email_code',
          emailAddressId: factor.emailAddressId,
        });
        flow.current = 'signIn';
        return { success: true };
      } catch {
        try {
          await signUp.create({ emailAddress: email });
          await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
          flow.current = 'signUp';
          return { success: true };
        } catch (e) {
          return { success: false, error: clerkError(e) };
        }
      } finally {
        setBusy(false);
      }
    },
    [signIn, signUp],
  );

  const verifyEmailOtp = useCallback(
    async (_email: string, code: string) => {
      setBusy(true);
      try {
        if (flow.current === 'signUp') {
          if (!signUp || !setActiveSignUp) return { success: false, error: 'Auth is still loading.' };
          const result = await signUp.attemptEmailAddressVerification({ code });
          if (result.status !== 'complete' || !result.createdSessionId) {
            return { success: false, error: 'That code is wrong or has expired.' };
          }
          await setActiveSignUp({ session: result.createdSessionId });
        } else {
          if (!signIn || !setActiveSignIn) return { success: false, error: 'Auth is still loading.' };
          const result = await signIn.attemptFirstFactor({ strategy: 'email_code', code });
          if (result.status !== 'complete' || !result.createdSessionId) {
            return { success: false, error: 'That code is wrong or has expired.' };
          }
          await setActiveSignIn({ session: result.createdSessionId });
        }
        await loadProfile();
        return { success: true };
      } catch (e) {
        return { success: false, error: clerkError(e) };
      } finally {
        setBusy(false);
      }
    },
    [signIn, signUp, setActiveSignIn, setActiveSignUp, loadProfile],
  );

  const signOut = useCallback(async () => {
    setUser(null);
    setProfileResolved(false);
    await clerkSignOut().catch(() => {});
  }, [clerkSignOut]);

  // initialized: Clerk restored its session AND (if signed in) the profile
  // request settled — the layouts gate every redirect on this flag.
  const initialized = isLoaded && (!isSignedIn || profileResolved);

  return useMemo(
    () => ({
      user: isSignedIn ? user : null,
      loading: busy,
      initialized,
      sendOtp,
      verifyOtp,
      sendEmailOtp,
      verifyEmailOtp,
      signOut,
    }),
    [isSignedIn, user, busy, initialized, sendOtp, verifyOtp, sendEmailOtp, verifyEmailOtp, signOut],
  );
}

function ClerkBridge({ children }: { children: React.ReactNode }) {
  const value = useClerkAuthValue();
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <ClerkBridge>{children}</ClerkBridge>
    </ClerkProvider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
