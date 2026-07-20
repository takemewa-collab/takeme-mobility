import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/onboarding/documents/[id] — short-lived signed view URL for
// the caller's OWN document (thumbnails / review screens). 404 for anything
// not owned by the caller; documents are never publicly addressable.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const svc = createServiceClient();
  const { data: doc } = await svc
    .from('driver_documents')
    .select('id, driver_id, storage_path, doc_type, status')
    .eq('id', id)
    .eq('driver_id', user.id)
    .maybeSingle();
  if (!doc || !doc.storage_path) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data: signed, error } = await svc.storage
    .from('driver-docs')
    .createSignedUrl(doc.storage_path, 120);
  if (error || !signed) {
    return NextResponse.json({ error: 'Could not create view URL' }, { status: 500 });
  }
  return NextResponse.json({ url: signed.signedUrl, docType: doc.doc_type, status: doc.status });
}
