import Link from 'next/link'

export const metadata = { title: 'TakeMe — Terms of Service' }

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-[#d2d2d7]">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-5 lg:px-10">
          <Link href="/" className="text-[18px] text-[#1d1d1f]">
            <span className="font-semibold">TakeMe</span>
            <span className="ml-[5px] font-light text-[#86868b]">Terms</span>
          </Link>
          <Link href="/" className="text-[14px] font-medium text-[#6e6e73] hover:text-[#1d1d1f]">Back to home</Link>
        </div>
      </header>
      <div className="mx-auto max-w-[800px] px-6 py-20 lg:px-10">
        <h1 className="text-[clamp(2rem,4vw,3rem)] font-semibold tracking-tight text-[#1d1d1f]">Terms of Service</h1>
        <p className="mt-2 text-[14px] text-[#86868b]">Last updated: July 20, 2026</p>
        <div className="mt-8 space-y-8 text-[15px] leading-[1.8] text-[#6e6e73]">
          <section>
            <h2 className="mb-3 text-[18px] font-semibold text-[#1d1d1f]">1. The Service</h2>
            <p>TAKEME provides technology that connects riders with independent drivers of electric vehicles. When you request a ride, you enter into a transportation arrangement fulfilled by the driver. TAKEME facilitates booking, routing, pricing, and payment for that trip.</p>
          </section>
          <section>
            <h2 className="mb-3 text-[18px] font-semibold text-[#1d1d1f]">2. Your Account</h2>
            <p>You must be at least 18 years old and provide accurate information to use TAKEME. You are responsible for activity on your account and for keeping your sign-in method secure. You can delete your account at any time from the app under Account → Privacy &amp; data.</p>
          </section>
          <section>
            <h2 className="mb-3 text-[18px] font-semibold text-[#1d1d1f]">3. Fares and Payments</h2>
            <p>The fare, including any fees applicable to your trip, is shown before you confirm a booking. Payment is processed through our payment partner using the method you select. Final charges may reflect route changes you request, added stops, waiting time, or applicable tolls and fees, and are itemized on your receipt.</p>
          </section>
          <section>
            <h2 className="mb-3 text-[18px] font-semibold text-[#1d1d1f]">4. Cancellations</h2>
            <p>You may cancel a ride in the app. A cancellation fee may apply when a driver is already on the way, and is always shown before it is charged.</p>
          </section>
          <section>
            <h2 className="mb-3 text-[18px] font-semibold text-[#1d1d1f]">5. Conduct</h2>
            <p>Treat drivers and their vehicles with respect. Unsafe, unlawful, or abusive behavior, damage to vehicles, or fraudulent payment activity may result in suspension or removal from the platform. Service animals are always welcome.</p>
          </section>
          <section>
            <h2 className="mb-3 text-[18px] font-semibold text-[#1d1d1f]">6. Disclaimers and Liability</h2>
            <p>TAKEME provides the platform &quot;as is&quot; to arrange transportation. To the extent permitted by law, TAKEME&apos;s liability for claims arising from use of the platform is limited to the amount you paid for the trip giving rise to the claim. Nothing in these terms limits liability that cannot be limited by law.</p>
          </section>
          <section>
            <h2 className="mb-3 text-[18px] font-semibold text-[#1d1d1f]">7. Changes</h2>
            <p>We may update these terms as the service evolves. When we make material changes, we will notify you in the app, and continued use after the effective date constitutes acceptance.</p>
          </section>
          <section>
            <h2 className="mb-3 text-[18px] font-semibold text-[#1d1d1f]">Contact</h2>
            <p>Questions about these terms: legal@takememobility.com, or TakeMe Mobility LLC, Seattle, WA.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
