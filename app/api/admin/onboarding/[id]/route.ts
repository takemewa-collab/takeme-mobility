import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin-auth';
import { logAdminAction } from '@/lib/admin-audit';
import { createServiceClient } from '@/lib/supabase/service';
import { getOnboardingBundle, logEvent } from '@/lib/onboarding/service';
import { pushTokenForUser, sendPushNotification } from '@/lib/push';

// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/admin/onboarding/[id] — full applicant detail: requirement
//      checklist, documents (short-lived signed view URLs, audited),
//      consents, background case, event history, activation decision.
// POST /api/admin/onboarding/[id] — review actions:
//      approve_document / reject_document / approve_requirement /
//      reject_requirement / request_info / waive_requirement /
//      set_background_status (manual provider only) / reject_application /
//      suspend_application / reinstate_application / add_note
// Every action is admin-audited and appended to onboarding_events; driver-
// visible transitions send a deep-linking push.
// ═══════════════════════════════════════════════════════════════════════════

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve_document'), documentId: z.string().uuid(), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  z.object({ action: z.literal('reject_document'), documentId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ action: z.literal('approve_requirement'), requirementKey: z.string().max(64), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('reject_requirement'), requirementKey: z.string().max(64), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ action: z.literal('request_info'), requirementKey: z.string().max(64), note: z.string().trim().min(3).max(500) }).strict(),
  z.object({ action: z.literal('waive_requirement'), requirementKey: z.string().max(64), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ action: z.literal('set_background_status'), status: z.enum(['clear', 'consider', 'adverse_final', 'under_review']), note: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('reject_application'), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ action: z.literal('suspend_application'), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ action: z.literal('reinstate_application'), note: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal('add_note'), note: z.string().trim().min(1).max(1000) }).strict(),
]);

async function notifyDriver(userId: string, title: string, body: string, requirementKey?: string) {
  const token = await pushTokenForUser(userId, 'driver');
  if (!token) return;
  await sendPushNotification({
    to: token,
    title,
    body,
    data: { type: 'onboarding_update', requirementKey: requirementKey ?? null },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireAdmin();
  if (error || !user) return error!;
  const { id } = await params;

  const svc = createServiceClient();
  const { data: application } = await svc
    .from('driver_applications')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!application) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const bundle = await getOnboardingBundle(svc, application.user_id);

  // Signed view URLs for open documents (5 minutes); each view is audited.
  const documents = await Promise.all(
    bundle.documents.map(async (d) => {
      let viewUrl: string | null = null;
      if (d.storage_path) {
        const { data: signed } = await svc.storage
          .from('driver-docs')
          .createSignedUrl(d.storage_path, 300);
        viewUrl = signed?.signedUrl ?? null;
      }
      return {
        id: d.id,
        docType: d.doc_type,
        status: d.status,
        rejectionReason: d.rejection_reason,
        expiresAt: d.expires_at,
        createdAt: d.created_at,
        requirementId: d.application_requirement_id,
        mimeType: d.mime_type,
        viewUrl,
      };
    }),
  );
  if (documents.some((d) => d.viewUrl)) {
    await logAdminAction({
      adminId: user.id,
      adminEmail: user.email,
      action: 'onboarding_documents_viewed',
      targetType: 'driver_application',
      targetId: id,
      details: { documentIds: documents.filter((d) => d.viewUrl).map((d) => d.id) },
    });
  }

  const { data: events } = await svc
    .from('onboarding_events')
    .select('actor, actor_id, event, detail, created_at')
    .eq('application_id', id)
    .order('created_at', { ascending: false })
    .limit(100);

  const defsByKey = new Map(bundle.definitions.map((d) => [d.key, d]));
  return NextResponse.json({
    application: bundle.application,
    market: bundle.market ? { key: bundle.market.key, displayName: bundle.market.display_name } : null,
    driver: bundle.driver,
    activation: bundle.activation,
    requirements: bundle.requirements
      .map((r) => {
        const def = defsByKey.get(r.requirement_key);
        return {
          id: r.id,
          key: r.requirement_key,
          title: def?.title ?? r.requirement_key,
          category: def?.category ?? null,
          reviewMethod: def?.review_method ?? null,
          required: r.required,
          blocking: r.blocking,
          status: bundle.displayStatus[r.requirement_key] ?? r.status,
          rejectionReason: r.rejection_reason,
          reviewNote: r.review_note,
          expiresAt: r.expires_at,
          updatedAt: r.updated_at,
          complianceReview: Boolean(def?.config?.compliance_review),
        };
      })
      .sort((a, b) => {
        const da = defsByKey.get(a.key)?.sort_order ?? 999;
        const db = defsByKey.get(b.key)?.sort_order ?? 999;
        return da - db;
      }),
    documents,
    consents: bundle.consents.map((c) => ({
      documentKey: c.document_key,
      version: c.version,
      locale: c.locale,
      acceptedAt: c.accepted_at,
    })),
    backgroundCheck: bundle.backgroundCase
      ? {
          provider: bundle.backgroundCase.provider,
          status: bundle.backgroundCase.status,
          submittedAt: bundle.backgroundCase.submitted_at,
          completedAt: bundle.backgroundCase.completed_at,
        }
      : null,
    events: events ?? [],
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireAdmin();
  if (error || !user) return error!;
  const { id } = await params;

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }
  const body = parsed.data;

  const svc = createServiceClient();
  const { data: application } = await svc
    .from('driver_applications')
    .select('id, user_id, status, full_name')
    .eq('id', id)
    .maybeSingle();
  if (!application) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const audit = (action: string, details: Record<string, unknown>) =>
    logAdminAction({
      adminId: user.id,
      adminEmail: user.email,
      action,
      targetType: 'driver_application',
      targetId: id,
      details,
    });
  const event = (event: string, detail: Record<string, unknown>) =>
    logEvent(svc, {
      applicationId: id,
      userId: application.user_id,
      actor: 'admin',
      actorId: user.id,
      event,
      detail,
    });

  const loadRequirement = async (key: string) => {
    const { data } = await svc
      .from('application_requirements')
      .select('id, requirement_key, status, definition_id')
      .eq('application_id', id)
      .eq('requirement_key', key)
      .maybeSingle();
    return data;
  };

  switch (body.action) {
    case 'approve_document':
    case 'reject_document': {
      const { data: doc } = await svc
        .from('driver_documents')
        .select('id, doc_type, application_requirement_id, driver_id')
        .eq('id', body.documentId)
        .eq('driver_id', application.user_id)
        .maybeSingle();
      if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

      if (body.action === 'approve_document') {
        await svc
          .from('driver_documents')
          .update({
            status: 'approved',
            reviewed_at: new Date().toISOString(),
            reviewed_by: user.id,
            rejection_reason: null,
            expires_at: body.expiresOn ? `${body.expiresOn}T00:00:00Z` : undefined,
          })
          .eq('id', doc.id);
        await audit('onboarding_document_approved', { documentId: doc.id, docType: doc.doc_type });
        await event('document_approved', { documentId: doc.id, docType: doc.doc_type });

        // If every accepted doc kind on the requirement is approved, approve
        // the requirement and carry the earliest expiry forward.
        if (doc.application_requirement_id) {
          const { data: reqRow } = await svc
            .from('application_requirements')
            .select('id, requirement_key, definition_id')
            .eq('id', doc.application_requirement_id)
            .maybeSingle();
          if (reqRow) {
            const { data: def } = await svc
              .from('requirement_definitions')
              .select('doc_kinds')
              .eq('id', reqRow.definition_id)
              .maybeSingle();
            const kinds: string[] = def?.doc_kinds ?? [];
            const { data: docs } = await svc
              .from('driver_documents')
              .select('doc_type, status, expires_at')
              .eq('application_requirement_id', reqRow.id)
              .neq('status', 'superseded');
            const approvedKinds = new Set(
              (docs ?? []).filter((d) => d.status === 'approved').map((d) => d.doc_type),
            );
            if (kinds.every((k) => approvedKinds.has(k))) {
              const expiries = (docs ?? [])
                .filter((d) => d.status === 'approved' && d.expires_at)
                .map((d) => d.expires_at as string)
                .sort();
              await svc
                .from('application_requirements')
                .update({
                  status: 'approved',
                  expires_at: expiries[0] ?? null,
                  rejection_reason: null,
                })
                .eq('id', reqRow.id);
              await notifyDriver(
                application.user_id,
                'Step approved',
                'A step in your TAKEME application was approved.',
                reqRow.requirement_key,
              );
            }
          }
        }
      } else {
        await svc
          .from('driver_documents')
          .update({
            status: 'rejected',
            reviewed_at: new Date().toISOString(),
            reviewed_by: user.id,
            rejection_reason: body.reason,
          })
          .eq('id', doc.id);
        if (doc.application_requirement_id) {
          await svc
            .from('application_requirements')
            .update({ status: 'needs_action', rejection_reason: body.reason })
            .eq('id', doc.application_requirement_id);
        }
        await audit('onboarding_document_rejected', { documentId: doc.id, reason: body.reason });
        await event('document_rejected', { documentId: doc.id, docType: doc.doc_type, reason: body.reason });
        await notifyDriver(
          application.user_id,
          'We need a new photo',
          body.reason,
        );
      }
      break;
    }

    case 'approve_requirement':
    case 'reject_requirement':
    case 'request_info':
    case 'waive_requirement': {
      const reqRow = await loadRequirement(body.requirementKey);
      if (!reqRow) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 });

      if (body.action === 'approve_requirement') {
        await svc
          .from('application_requirements')
          .update({
            status: 'approved',
            expires_at: body.expiresOn ? `${body.expiresOn}T00:00:00Z` : null,
            review_note: body.note ?? null,
            rejection_reason: null,
          })
          .eq('id', reqRow.id);
        await notifyDriver(application.user_id, 'Step approved', 'A step in your TAKEME application was approved.', reqRow.requirement_key);
      } else if (body.action === 'reject_requirement') {
        await svc
          .from('application_requirements')
          .update({ status: 'rejected', rejection_reason: body.reason })
          .eq('id', reqRow.id);
        await notifyDriver(application.user_id, 'Action needed', body.reason, reqRow.requirement_key);
      } else if (body.action === 'request_info') {
        await svc
          .from('application_requirements')
          .update({ status: 'needs_action', review_note: body.note })
          .eq('id', reqRow.id);
        await notifyDriver(application.user_id, 'More information needed', body.note, reqRow.requirement_key);
      } else {
        await svc
          .from('application_requirements')
          .update({ status: 'waived', waived_by: user.id, waived_reason: body.reason })
          .eq('id', reqRow.id);
      }
      await audit(`onboarding_${body.action}`, { ...body });
      await event(body.action, { requirementKey: body.requirementKey });
      break;
    }

    case 'set_background_status': {
      const { data: bgCase } = await svc
        .from('background_check_cases')
        .select('id, provider, status')
        .eq('application_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!bgCase) return NextResponse.json({ error: 'No background case' }, { status: 404 });
      if (bgCase.provider !== 'manual') {
        return NextResponse.json(
          { error: 'Provider-managed cases update via webhook, not manually.' },
          { status: 409 },
        );
      }
      await svc
        .from('background_check_cases')
        .update({
          status: body.status,
          completed_at: ['clear', 'consider', 'adverse_final'].includes(body.status)
            ? new Date().toISOString()
            : null,
          result_summary: body.note ? { note: body.note } : null,
        })
        .eq('id', bgCase.id);
      await audit('onboarding_background_status', { from: bgCase.status, to: body.status });
      await event('background_status_set', { from: bgCase.status, to: body.status });
      if (body.status === 'clear') {
        await notifyDriver(application.user_id, 'Background check complete', 'Your background check is complete.', 'background_check');
      }
      break;
    }

    case 'reject_application':
    case 'suspend_application':
    case 'reinstate_application': {
      const nextStatus =
        body.action === 'reject_application' ? 'rejected'
        : body.action === 'suspend_application' ? 'suspended'
        : 'pending';
      await svc
        .from('driver_applications')
        .update({ status: nextStatus, notes: 'reason' in body ? body.reason : (body.note ?? null) })
        .eq('id', id);
      if (body.action === 'suspend_application') {
        await svc
          .from('drivers')
          .update({ is_active: false, status: 'offline' })
          .eq('auth_user_id', application.user_id);
      }
      if (body.action === 'reinstate_application') {
        await svc
          .from('drivers')
          .update({ is_active: true })
          .eq('auth_user_id', application.user_id);
      }
      await audit(`onboarding_${body.action}`, { ...body });
      await event(body.action, 'reason' in body ? { reason: body.reason } : {});
      break;
    }

    case 'add_note': {
      await event('admin_note', { note: body.note });
      await audit('onboarding_note_added', { note: body.note });
      break;
    }
  }

  const bundle = await getOnboardingBundle(svc, application.user_id);
  return NextResponse.json({
    ok: true,
    activation: bundle.activation,
    applicationStatus: bundle.application?.status ?? null,
  });
}
