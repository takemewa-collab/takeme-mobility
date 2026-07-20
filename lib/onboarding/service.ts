/**
 * Onboarding service — DB orchestration around the pure engine.
 * All functions take the service-role client; caller is responsible for
 * having authenticated the user (bearer) or admin (requireAdmin) first.
 */
import type { createServiceClient } from '@/lib/supabase/service';
import {
  applicableDefinitions,
  backgroundRequirementStatus,
  computeActivation,
  effectiveStatus,
  nextAction,
  withDependencyBlocking,
  SATISFIED,
} from './engine';
import type {
  ActivationResult,
  ApplicationRequirementRow,
  BackgroundCaseView,
  RequirementDefinition,
  RequirementStatus,
} from './types';

type Svc = ReturnType<typeof createServiceClient>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const AUTO_UPDATABLE: ReadonlySet<string> = new Set([
  'not_started',
  'in_progress',
  'submitted',
  'under_review',
  'needs_action',
  'blocked',
  'expiring_soon',
]);

export interface OnboardingBundle {
  application: Row | null;
  market: Row | null;
  definitions: RequirementDefinition[];
  requirements: Row[];
  documents: Row[];
  consents: Row[];
  backgroundCase: Row | null;
  driver: Row | null;
  activation: ActivationResult;
  nextActionKey: string | null;
  displayStatus: Record<string, RequirementStatus>;
}

export async function listMarkets(svc: Svc): Promise<Row[]> {
  const { data } = await svc
    .from('onboarding_markets')
    .select('id, key, country_code, region_code, city, display_name, status, policies')
    .neq('status', 'inactive')
    .order('display_name');
  return data ?? [];
}

export async function latestApplication(svc: Svc, userId: string): Promise<Row | null> {
  const { data } = await svc
    .from('driver_applications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function loadDefinitions(svc: Svc, marketId: string | null): Promise<RequirementDefinition[]> {
  let query = svc.from('requirement_definitions').select('*').eq('active', true);
  if (marketId) {
    query = query.or(`market_id.is.null,market_id.eq.${marketId}`);
  } else {
    query = query.is('market_id', null);
  }
  const { data } = await query;
  return (data ?? []) as RequirementDefinition[];
}

export async function logEvent(
  svc: Svc,
  params: {
    applicationId: string | null;
    userId: string | null;
    actor: 'driver' | 'admin' | 'system' | 'provider';
    actorId?: string | null;
    event: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await svc.from('onboarding_events').insert({
    application_id: params.applicationId,
    user_id: params.userId,
    actor: params.actor,
    actor_id: params.actorId ?? null,
    event: params.event,
    detail: params.detail ?? {},
  });
}

/**
 * Instantiate/refresh application_requirements from the applicable
 * definitions. Idempotent; never deletes history. Rows whose definition no
 * longer applies flip to not_applicable (and back if it applies again).
 */
export async function syncRequirements(svc: Svc, application: Row): Promise<{
  definitions: RequirementDefinition[];
  requirements: Row[];
}> {
  const definitions = await loadDefinitions(svc, application.market_id ?? null);
  const applicable = applicableDefinitions(definitions, {
    applicantType: application.applicant_type ?? null,
    vehicleRelationship: application.vehicle_relationship ?? null,
    marketId: application.market_id ?? null,
  });
  const applicableKeys = new Set(applicable.map((d) => d.key));

  const { data: existingRows } = await svc
    .from('application_requirements')
    .select('*')
    .eq('application_id', application.id);
  const existing = new Map<string, Row>((existingRows ?? []).map((r: Row) => [r.requirement_key, r]));

  // Create missing instances.
  const inserts = applicable
    .filter((d) => !existing.has(d.key))
    .map((d) => ({
      application_id: application.id,
      definition_id: d.id,
      requirement_key: d.key,
      status: 'not_started',
      required: d.required,
      blocking: d.blocking,
    }));
  if (inserts.length > 0) {
    await svc.from('application_requirements').upsert(inserts, {
      onConflict: 'application_id,requirement_key',
      ignoreDuplicates: true,
    });
  }

  // Re-activate rows that apply again; retire rows that no longer apply.
  const updates: Array<{ id: string; status: string }> = [];
  for (const [key, row] of existing) {
    if (!applicableKeys.has(key) && row.status !== 'not_applicable' && !SATISFIED.has(row.status)) {
      updates.push({ id: row.id, status: 'not_applicable' });
    }
    if (applicableKeys.has(key) && row.status === 'not_applicable') {
      updates.push({ id: row.id, status: 'not_started' });
    }
  }
  for (const u of updates) {
    await svc.from('application_requirements').update({ status: u.status }).eq('id', u.id);
  }

  const { data: rows } = await svc
    .from('application_requirements')
    .select('*')
    .eq('application_id', application.id);
  return { definitions: applicable, requirements: (rows ?? []) as Row[] };
}

/** Derive auto/quiz/provider statuses and persist changes. */
async function applyAutoStatuses(
  svc: Svc,
  application: Row,
  definitions: RequirementDefinition[],
  requirements: Row[],
  consents: Row[],
  backgroundCase: Row | null,
): Promise<Row[]> {
  const defsByKey = new Map(definitions.map((d) => [d.key, d]));
  const now = new Date();

  const consentedKeys = new Set(consents.map((c: Row) => c.document_key));

  for (const req of requirements) {
    const def = defsByKey.get(req.requirement_key);
    if (!def) continue;
    let desired: RequirementStatus | null = null;

    if (def.review_method === 'auto') {
      const legalKeys = (def.config?.legal_keys as string[] | undefined) ?? null;
      if (legalKeys) {
        desired = legalKeys.every((k) => consentedKeys.has(k)) ? 'approved' : 'not_started';
      } else if (def.key === 'profile_details') {
        desired = application.full_name && application.phone ? 'approved' : 'not_started';
      } else if (def.key === 'vehicle_details') {
        const check = application.vehicle_verification as Row | null;
        if (!check) desired = 'not_started';
        else if (check.eligible) desired = 'approved';
        else if (check.needsReview) desired = 'under_review';
        else desired = 'needs_action';
      }
    } else if (def.review_method === 'provider' && def.category === 'background') {
      desired = backgroundRequirementStatus(
        backgroundCase
          ? ({ status: backgroundCase.status, provider: backgroundCase.provider, expires_at: backgroundCase.expires_at } as BackgroundCaseView)
          : null,
      );
    } else if (def.review_method === 'quiz') {
      const { data: passed } = await svc
        .from('training_attempts')
        .select('id')
        .eq('application_requirement_id', req.id)
        .eq('passed', true)
        .limit(1);
      if (passed && passed.length > 0) desired = 'approved';
    }

    // Expiry materialization for approved rows with an expiration date.
    if (desired == null && req.status === 'approved' && req.expires_at) {
      const renewalDays = Number(def.config?.renewal_window_days ?? 30);
      const eff = effectiveStatus(
        { status: req.status, expires_at: req.expires_at },
        renewalDays,
        now,
      );
      if (eff !== req.status) desired = eff;
    }

    if (
      desired != null &&
      desired !== req.status &&
      (AUTO_UPDATABLE.has(req.status) || ['expired', 'expiring_soon'].includes(desired) ||
        (req.status === 'approved' && desired !== 'approved' && def.review_method === 'provider'))
    ) {
      await svc.from('application_requirements').update({ status: desired }).eq('id', req.id);
      req.status = desired;
    }
  }
  return requirements;
}

/**
 * Full server-side onboarding state for a user. This is the single source the
 * app renders, and the input to the activation gate.
 */
export async function getOnboardingBundle(svc: Svc, userId: string): Promise<OnboardingBundle> {
  const application = await latestApplication(svc, userId);
  const emptyActivation: ActivationResult = {
    decision: 'ineligible',
    reasonCodes: ['no_application'],
    requiredActions: [],
  };
  const { data: driver } = await svc
    .from('drivers')
    .select('id, is_verified, is_active, status')
    .eq('auth_user_id', userId)
    .maybeSingle();

  if (!application) {
    // Legacy path: drivers provisioned before the activation platform keep
    // working without an application record.
    const legacyEligible = Boolean(driver?.is_verified && driver?.is_active);
    return {
      application: null,
      market: null,
      definitions: [],
      requirements: [],
      documents: [],
      consents: [],
      backgroundCase: null,
      driver: driver ?? null,
      activation: legacyEligible
        ? { decision: 'eligible', reasonCodes: ['legacy_driver'], requiredActions: [] }
        : emptyActivation,
      nextActionKey: null,
      displayStatus: {},
    };
  }

  const [{ data: market }, { data: consents }, { data: bgCase }] = await Promise.all([
    application.market_id
      ? svc.from('onboarding_markets').select('*').eq('id', application.market_id).maybeSingle()
      : Promise.resolve({ data: null } as { data: Row | null }),
    svc
      .from('consent_records')
      .select('id, document_key, version, locale, accepted_at, legal_document_id')
      .eq('user_id', userId),
    svc
      .from('background_check_cases')
      .select('*')
      .eq('application_id', application.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const { definitions, requirements } = await syncRequirements(svc, application);
  const synced = await applyAutoStatuses(
    svc, application, definitions, requirements, consents ?? [], bgCase ?? null,
  );

  const { data: documents } = await svc
    .from('driver_documents')
    .select('id, doc_type, status, storage_path, rejection_reason, expires_at, created_at, application_requirement_id, mime_type')
    .eq('driver_id', userId)
    .neq('status', 'superseded')
    .order('created_at', { ascending: false });

  const defsByKey = new Map(definitions.map((d) => [d.key, d]));
  const display = withDependencyBlocking(
    synced as ApplicationRequirementRow[],
    defsByKey,
  );

  const activation = computeActivation({
    applicationStatus: application.status,
    requirements: synced as ApplicationRequirementRow[],
    driver: driver ? { is_verified: driver.is_verified, is_active: driver.is_active } : null,
    now: new Date(),
  });

  const nextKey = nextAction(synced as ApplicationRequirementRow[], defsByKey, display);

  await recordActivationTransition(svc, application, userId, activation);

  return {
    application,
    market: market ?? null,
    definitions,
    requirements: synced,
    documents: documents ?? [],
    consents: consents ?? [],
    backgroundCase: bgCase ?? null,
    driver: driver ?? null,
    activation,
    nextActionKey: nextKey,
    displayStatus: Object.fromEntries(display),
  };
}

/** Append an activation_events row only when the decision changed. */
async function recordActivationTransition(
  svc: Svc,
  application: Row,
  userId: string,
  activation: ActivationResult,
): Promise<void> {
  const { data: last } = await svc
    .from('activation_events')
    .select('decision')
    .eq('application_id', application.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last?.decision === activation.decision) return;
  await svc.from('activation_events').insert({
    application_id: application.id,
    user_id: userId,
    decision: activation.decision,
    reason_codes: activation.reasonCodes,
    snapshot: { requiredActions: activation.requiredActions },
  });

  // First transition to eligible provisions the dispatchable driver row.
  if (activation.decision === 'eligible' && application.status !== 'approved') {
    await svc
      .from('driver_applications')
      .update({ status: 'approved' })
      .eq('id', application.id);
    const { error } = await svc.rpc('provision_approved_driver', {
      p_application_id: application.id,
    });
    if (error) {
      console.error('[onboarding] provision failed:', error.message);
    } else {
      await logEvent(svc, {
        applicationId: application.id,
        userId,
        actor: 'system',
        event: 'driver_provisioned',
      });
    }
  }
}

/** Activation gate for the online toggle. */
export async function activationDecisionForUser(
  svc: Svc,
  userId: string,
): Promise<ActivationResult> {
  const bundle = await getOnboardingBundle(svc, userId);
  return bundle.activation;
}

/** Serialize a bundle into the client-facing DTO (no internal ids leak). */
export function toClientState(bundle: OnboardingBundle) {
  const defsByKey = new Map(bundle.definitions.map((d) => [d.key, d]));
  return {
    application: bundle.application
      ? {
          id: bundle.application.id,
          status: bundle.application.status,
          applicantType: bundle.application.applicant_type,
          vehicleRelationship: bundle.application.vehicle_relationship,
          preferredLanguage: bundle.application.preferred_language,
          fullName: bundle.application.full_name,
          phone: bundle.application.phone,
          email: bundle.application.email,
          vehicle: bundle.application.vehicle_make
            ? {
                make: bundle.application.vehicle_make,
                model: bundle.application.vehicle_model,
                year: bundle.application.vehicle_year,
                color: bundle.application.vehicle_color,
                plate: bundle.application.plate_number,
                plateState: bundle.application.plate_state,
                vin: bundle.application.vin,
                verification: bundle.application.vehicle_verification ?? null,
              }
            : null,
          submittedAt: bundle.application.submitted_at,
        }
      : null,
    market: bundle.market
      ? {
          id: bundle.market.id,
          key: bundle.market.key,
          displayName: bundle.market.display_name,
          status: bundle.market.status,
          evPolicy: bundle.market.policies?.ev ?? {},
        }
      : null,
    requirements: bundle.requirements
      .map((r) => {
        const def = defsByKey.get(r.requirement_key);
        if (!def) return null;
        const docs = bundle.documents.filter(
          (d) => d.application_requirement_id === r.id,
        );
        return {
          key: r.requirement_key,
          title: def.title,
          summary: def.summary,
          instructions: def.instructions,
          category: def.category,
          reviewMethod: def.review_method,
          required: r.required,
          blocking: r.blocking,
          externalUrl: def.external_url,
          docKinds: def.doc_kinds,
          dependsOn: def.depends_on,
          sortOrder: def.sort_order,
          status: bundle.displayStatus[r.requirement_key] ?? r.status,
          rejectionReason: r.rejection_reason,
          reviewNote: r.review_note,
          expiresAt: r.expires_at,
          updatedAt: r.updated_at,
          config: {
            requires_back: def.config?.requires_back ?? false,
            camera_only: def.config?.camera_only ?? false,
            sections: def.config?.sections ?? null,
            questions: sanitizeQuestions(def.config?.questions),
            pass_score: def.config?.pass_score ?? null,
            legal_keys: def.config?.legal_keys ?? null,
            disclosure_keys: def.config?.disclosure_keys ?? null,
          },
          documents: docs.map((d) => ({
            id: d.id,
            docType: d.doc_type,
            status: d.status,
            rejectionReason: d.rejection_reason,
            expiresAt: d.expires_at,
            createdAt: d.created_at,
          })),
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a!.sortOrder as number) - (b!.sortOrder as number)),
    backgroundCheck: bundle.backgroundCase
      ? {
          status: bundle.backgroundCase.status,
          provider: bundle.backgroundCase.provider,
          invitationUrl: bundle.backgroundCase.result_summary?.invitation_url ?? null,
          submittedAt: bundle.backgroundCase.submitted_at,
        }
      : null,
    consents: bundle.consents.map((c) => ({
      documentKey: c.document_key,
      version: c.version,
      acceptedAt: c.accepted_at,
    })),
    activation: {
      decision: bundle.activation.decision,
      reasonCodes: bundle.activation.reasonCodes,
      requiredActions: bundle.activation.requiredActions,
      nextAction: bundle.nextActionKey,
    },
    driver: bundle.driver
      ? { exists: true, isVerified: bundle.driver.is_verified, isActive: bundle.driver.is_active }
      : { exists: false, isVerified: false, isActive: false },
  };
}

/** Never ship correct answers to the client. */
function sanitizeQuestions(questions: unknown) {
  if (!Array.isArray(questions)) return null;
  return questions.map((q: Row) => ({
    id: q.id,
    prompt: q.prompt,
    options: q.options,
  }));
}
