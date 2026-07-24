'use client';

import { useEffect } from 'react';

/**
 * Stripe Connect onboarding RETURN bridge. Stripe requires an HTTPS
 * return_url; this page immediately hands control back to the TAKEME Driver
 * app via its scheme. When the app opened the flow with an auth session
 * (openAuthSessionAsync), the scheme redirect closes the browser sheet
 * automatically; the button is the fallback for plain browsers.
 *
 * Reaching this page does NOT mean onboarding finished — the app re-fetches
 * the authoritative account status from the backend on return.
 */
const APP_RETURN_URL = 'takeme-driver://payouts/return';

export default function PayoutSetupReturnPage() {
  useEffect(() => {
    window.location.href = APP_RETURN_URL;
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-6">
      <div className="max-w-sm text-center">
        <p className="text-[22px] font-semibold text-[#111111]">Almost done</p>
        <p className="mt-3 text-[15px] leading-relaxed text-[#6B6B6B]">
          Head back to the TAKEME Driver app — your payout setup status will
          refresh automatically.
        </p>
        <a
          href={APP_RETURN_URL}
          className="mt-8 inline-block w-full rounded-2xl bg-[#111111] px-6 py-4 text-[16px] font-semibold text-white"
        >
          Open TAKEME Driver
        </a>
      </div>
    </div>
  );
}
