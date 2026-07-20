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
// POST /api/driver/onboarding/training — submit a quiz attempt.
// Scoring is server-side against the requirement definition; opening the
// content never completes a module, and correct answers are never sent to
// the client.
// ═══════════════════════════════════════════════════════════════════════════

const schema = z
  .object({
    requirementKey: z.string().min(1).max(64),
    answers: z.array(
      z.object({ questionId: z.string().max(16), selected: z.number().int().min(0).max(10) }),
    ).min(1).max(50),
  })
  .strict();

interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
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
  if (!application) {
    return NextResponse.json({ error: 'No application' }, { status: 409 });
  }

  const { data: requirement } = await svc
    .from('application_requirements')
    .select('id, definition_id, status')
    .eq('application_id', application.id)
    .eq('requirement_key', body.requirementKey)
    .maybeSingle();
  if (!requirement) {
    return NextResponse.json({ error: 'Unknown requirement' }, { status: 404 });
  }
  const { data: definition } = await svc
    .from('requirement_definitions')
    .select('review_method, config')
    .eq('id', requirement.definition_id)
    .maybeSingle();
  if (definition?.review_method !== 'quiz') {
    return NextResponse.json({ error: 'This step has no quiz' }, { status: 400 });
  }

  const config = definition.config as {
    questions?: QuizQuestion[];
    pass_score?: number;
    max_attempts?: number;
    module_version?: number;
  };
  const questions = config.questions ?? [];
  if (questions.length === 0) {
    return NextResponse.json({ error: 'Module unavailable' }, { status: 500 });
  }

  const { count: attemptCount } = await svc
    .from('training_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('application_requirement_id', requirement.id);
  const maxAttempts = config.max_attempts ?? 5;
  if ((attemptCount ?? 0) >= maxAttempts) {
    return NextResponse.json(
      { error: 'Attempt limit reached. Contact support to continue.' },
      { status: 429 },
    );
  }

  const answerById = new Map(body.answers.map((a) => [a.questionId, a.selected]));
  let correct = 0;
  for (const q of questions) {
    if (answerById.get(q.id) === q.answer) correct += 1;
  }
  const score = Math.round((correct / questions.length) * 100);
  const passScore = config.pass_score ?? 80;
  const passed = score >= passScore;

  await svc.from('training_attempts').insert({
    application_requirement_id: requirement.id,
    user_id: user.id,
    module_version: config.module_version ?? 1,
    score,
    passed,
    answers: body.answers,
    completed_at: new Date().toISOString(),
  });

  await logEvent(svc, {
    applicationId: application.id,
    userId: user.id,
    actor: 'driver',
    event: passed ? 'training_passed' : 'training_failed',
    detail: { requirementKey: body.requirementKey, score },
  });

  const bundle = await getOnboardingBundle(svc, user.id);
  return NextResponse.json({
    state: toClientState(bundle),
    result: {
      score,
      passScore,
      passed,
      attemptsRemaining: Math.max(0, maxAttempts - ((attemptCount ?? 0) + 1)),
    },
  });
}
