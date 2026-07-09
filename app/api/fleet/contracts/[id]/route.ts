import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { apiSuccess, apiError } from '@/lib/fleet/utils/api'
import { getContract } from '@/lib/fleet/services/contract.service'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const contract = await getContract(id)

    // Ownership: only the contract's owner, driver, or a named signer may read it
    // (it contains the rendered agreement + signer emails/IPs).
    const signers = (contract as { contract_signers?: { signer_user_id?: string }[] }).contract_signers ?? []
    const isParty =
      contract.owner_id === user.id ||
      contract.driver_id === user.id ||
      signers.some((s) => s.signer_user_id === user.id)
    if (!isParty) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    return apiSuccess(contract)
  } catch (error) {
    return apiError(error)
  }
}
