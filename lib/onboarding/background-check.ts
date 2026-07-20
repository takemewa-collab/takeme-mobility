/**
 * Background-check provider abstraction.
 *
 * Real screening runs through a consumer-reporting agency whose hosted flow
 * collects sensitive identifiers (SSN, DOB) directly from the candidate —
 * TAKEME servers never receive or store them.
 *
 * Providers:
 *  - 'checkr'  — used automatically when CHECKR_API_KEY is configured.
 *                Creates a candidate + hosted invitation.
 *  - 'manual'  — fallback when no provider is configured. Creates a case in
 *                under_review for the compliance queue. This is an honest
 *                "a human must decide" state, never an automatic pass.
 */

export interface SubmitInput {
  userId: string;
  applicationId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  /** Two-letter work-location state, e.g. 'WA'. */
  workState: string | null;
}

export interface SubmitResult {
  provider: 'checkr' | 'manual';
  providerCaseId: string | null;
  status: 'candidate_action' | 'under_review' | 'provider_unavailable';
  /** Hosted flow URL the candidate must complete (checkr only). */
  invitationUrl: string | null;
}

export function activeProvider(): 'checkr' | 'manual' {
  return process.env.CHECKR_API_KEY ? 'checkr' : 'manual';
}

export async function submitBackgroundCheck(input: SubmitInput): Promise<SubmitResult> {
  if (activeProvider() === 'checkr') {
    return submitViaCheckr(input);
  }
  return {
    provider: 'manual',
    providerCaseId: null,
    status: 'under_review',
    invitationUrl: null,
  };
}

async function submitViaCheckr(input: SubmitInput): Promise<SubmitResult> {
  const apiKey = process.env.CHECKR_API_KEY!;
  const packageSlug = process.env.CHECKR_PACKAGE ?? 'driver_pro';
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  try {
    const [firstName, ...rest] = input.fullName.trim().split(/\s+/);
    const candidateRes = await fetch('https://api.checkr.com/v1/candidates', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name: firstName,
        last_name: rest.join(' ') || firstName,
        email: input.email ?? undefined,
        phone: input.phone ?? undefined,
        work_locations: input.workState ? [{ state: input.workState }] : undefined,
        // SSN / DOB / license details are collected by Checkr's hosted flow.
      }),
    });
    if (!candidateRes.ok) {
      console.error('[bgc] checkr candidate create failed:', candidateRes.status);
      return { provider: 'checkr', providerCaseId: null, status: 'provider_unavailable', invitationUrl: null };
    }
    const candidate = (await candidateRes.json()) as { id: string };

    const inviteRes = await fetch('https://api.checkr.com/v1/invitations', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidate_id: candidate.id,
        package: packageSlug,
        work_locations: input.workState ? [{ state: input.workState }] : undefined,
      }),
    });
    if (!inviteRes.ok) {
      console.error('[bgc] checkr invitation failed:', inviteRes.status);
      return { provider: 'checkr', providerCaseId: candidate.id, status: 'provider_unavailable', invitationUrl: null };
    }
    const invite = (await inviteRes.json()) as { invitation_url?: string };
    return {
      provider: 'checkr',
      providerCaseId: candidate.id,
      status: 'candidate_action',
      invitationUrl: invite.invitation_url ?? null,
    };
  } catch (err) {
    console.error('[bgc] checkr unreachable:', err instanceof Error ? err.message : err);
    return { provider: 'checkr', providerCaseId: null, status: 'provider_unavailable', invitationUrl: null };
  }
}

/** Map provider webhook report statuses onto internal case statuses. */
export function mapProviderStatus(eventType: string, reportStatus?: string): string | null {
  switch (eventType) {
    case 'invitation.completed':
      return 'provider_pending';
    case 'invitation.expired':
      return 'candidate_action';
    case 'report.created':
      return 'provider_pending';
    case 'report.suspended':
      return 'info_required';
    case 'report.resumed':
      return 'provider_pending';
    case 'report.disputed':
      return 'dispute';
    case 'report.pre_adverse_action':
      return 'pre_adverse';
    case 'report.post_adverse_action':
      return 'adverse_final';
    case 'report.completed':
      if (reportStatus === 'clear') return 'clear';
      if (reportStatus === 'consider') return 'consider';
      return 'under_review';
    default:
      return null;
  }
}
