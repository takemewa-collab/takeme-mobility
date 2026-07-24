'use client';

import { useEffect } from 'react';

/**
 * Stripe Connect onboarding REFRESH bridge. Stripe sends the user here when
 * an Account Link has expired or was already used (links are single-use).
 * The app must mint a FRESH link — so this page routes straight back to the
 * app, which re-requests /api/driver/payouts/account-link.
 */
const APP_REFRESH_URL = 'takeme-driver://payouts/refresh';

export default function PayoutSetupRefreshPage() {
  useEffect(() => {
    window.location.href = APP_REFRESH_URL;
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-6">
      <div className="max-w-sm text-center">
        <p className="text-[22px] font-semibold text-[#111111]">Link expired</p>
        <p className="mt-3 text-[15px] leading-relaxed text-[#6B6B6B]">
          That setup link is no longer valid. Return to the TAKEME Driver app
          and tap Set up payouts again — a fresh link is created every time.
        </p>
        <a
          href={APP_REFRESH_URL}
          className="mt-8 inline-block w-full rounded-2xl bg-[#111111] px-6 py-4 text-[16px] font-semibold text-white"
        >
          Open TAKEME Driver
        </a>
      </div>
    </div>
  );
}
