import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';
import {
  getOnboardingBundle,
  latestApplication,
  logEvent,
  toClientState,
} from '@/lib/onboarding/service';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/onboarding/documents
//   { action: 'create_upload', requirementKey, docType, contentType, sizeBytes }
//     → short-lived signed upload URL into the private driver-docs bucket.
//       Object keys are randomized and user-scoped; the bucket has no public
//       access and no client storage policies.
//   { action: 'submit', requirementKey, docType, path, expiresOn? }
//     → registers the uploaded object for review, supersedes prior pending
//       versions, and moves the requirement to submitted.
// ═══════════════════════════════════════════════════════════════════════════

const DOC_MIME: Record<string, number> = {
  'image/jpeg': 15 * 1024 * 1024,
  'image/png': 15 * 1024 * 1024,
  'image/webp': 15 * 1024 * 1024,
  'image/heic': 15 * 1024 * 1024,
  'application/pdf': 15 * 1024 * 1024,
};

const createUploadSchema = z
  .object({
    action: z.literal('create_upload'),
    requirementKey: z.string().min(1).max(64),
    docType: z.string().min(1).max(40),
    contentType: z.string().min(1).max(80),
    sizeBytes: z.number().int().positive(),
  })
  .strict();

const submitSchema = z
  .object({
    action: z.literal('submit'),
    requirementKey: z.string().min(1).max(64),
    docType: z.string().min(1).max(40),
    path: z.string().min(1).max(300),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

const schema = z.discriminatedUnion('action', [createUploadSchema, submitSchema]);

async function loadRequirement(
  svc: ReturnType<typeof createServiceClient>,
  applicationId: string,
  requirementKey: string,
  docType: string,
) {
  const { data: requirement } = await svc
    .from('application_requirements')
    .select('id, requirement_key, status, definition_id')
    .eq('application_id', applicationId)
    .eq('requirement_key', requirementKey)
    .maybeSingle();
  if (!requirement) return { requirement: null, definition: null };
  const { data: definition } = await svc
    .from('requirement_definitions')
    .select('doc_kinds, review_method, config, title')
    .eq('id', requirement.definition_id)
    .maybeSingle();
  if (!definition?.doc_kinds?.includes(docType)) {
    return { requirement, definition: null };
  }
  return { requirement, definition };
}

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, 'driver-onboarding');
  if (limited) return limited;

  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const body = parsed.data;

  const svc = createServiceClient();
  const application = await latestApplication(svc, user.id);
  if (!application || ['rejected', 'suspended'].includes(application.status)) {
    return NextResponse.json({ error: 'No editable application' }, { status: 409 });
  }

  const { requirement, definition } = await loadRequirement(
    svc, application.id, body.requirementKey, body.docType,
  );
  if (!requirement) {
    return NextResponse.json({ error: 'Unknown requirement' }, { status: 404 });
  }
  if (!definition) {
    return NextResponse.json({ error: 'Document type not accepted for this step' }, { status: 400 });
  }

  if (body.action === 'create_upload') {
    const maxSize = DOC_MIME[body.contentType];
    if (!maxSize) {
      return NextResponse.json(
        { error: 'Unsupported file type. Use a photo (JPEG, PNG, HEIC) or PDF.' },
        { status: 400 },
      );
    }
    if (body.sizeBytes > maxSize) {
      return NextResponse.json({ error: 'File is too large (15 MB max).' }, { status: 400 });
    }
    const ext = body.contentType === 'application/pdf' ? 'pdf' : body.contentType.split('/')[1];
    const path = `${user.id}/${body.requirementKey}/${body.docType}-${randomUUID()}.${ext}`;
    const { data: signed, error } = await svc.storage
      .from('driver-docs')
      .createSignedUploadUrl(path);
    if (error || !signed) {
      return NextResponse.json({ error: 'Could not prepare upload' }, { status: 500 });
    }
    return NextResponse.json({
      path,
      token: signed.token,
      signedUrl: signed.signedUrl,
    });
  }

  // action === 'submit'
  if (!body.path.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: 'Invalid document path' }, { status: 403 });
  }
  // Confirm the object actually exists before registering it.
  const folder = body.path.slice(0, body.path.lastIndexOf('/'));
  const name = body.path.slice(body.path.lastIndexOf('/') + 1);
  const { data: listed } = await svc.storage.from('driver-docs').list(folder, { search: name });
  const object = (listed ?? []).find((o) => o.name === name);
  if (!object) {
    return NextResponse.json(
      { error: 'Upload not found. Please try uploading again.' },
      { status: 400 },
    );
  }

  // Supersede prior open versions of this doc type on this requirement.
  await svc
    .from('driver_documents')
    .update({ status: 'superseded' })
    .eq('driver_id', user.id)
    .eq('application_requirement_id', requirement.id)
    .eq('doc_type', body.docType)
    .in('status', ['pending', 'rejected']);

  const { data: doc, error: docError } = await svc
    .from('driver_documents')
    .insert({
      driver_id: user.id,
      doc_type: body.docType,
      storage_path: body.path,
      application_requirement_id: requirement.id,
      status: 'pending',
      expires_at: body.expiresOn ? `${body.expiresOn}T00:00:00Z` : null,
      mime_type: (object.metadata as { mimetype?: string } | null)?.mimetype ?? null,
      size_bytes: (object.metadata as { size?: number } | null)?.size ?? null,
    })
    .select('id')
    .single();
  if (docError || !doc) {
    return NextResponse.json({ error: 'Could not register document' }, { status: 500 });
  }

  // All accepted doc kinds present → requirement moves to submitted.
  const docKinds: string[] = definition.doc_kinds ?? [];
  const { data: openDocs } = await svc
    .from('driver_documents')
    .select('doc_type, status')
    .eq('application_requirement_id', requirement.id)
    .in('status', ['pending', 'approved']);
  const presentKinds = new Set((openDocs ?? []).map((d) => d.doc_type));
  const complete = docKinds.every((k) => presentKinds.has(k));
  await svc
    .from('application_requirements')
    .update({ status: complete ? 'submitted' : 'in_progress', rejection_reason: null })
    .eq('id', requirement.id);

  await logEvent(svc, {
    applicationId: application.id,
    userId: user.id,
    actor: 'driver',
    event: 'document_submitted',
    detail: { requirementKey: body.requirementKey, docType: body.docType, documentId: doc.id },
  });

  const bundle = await getOnboardingBundle(svc, user.id);
  return NextResponse.json({ state: toClientState(bundle), documentId: doc.id });
}
