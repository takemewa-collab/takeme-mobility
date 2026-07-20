import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '@takeme/shared';
import { Button } from '@/components/ui';
import { ErrorView, LoadingView } from '@/components/onboarding';
import { exitTask } from '@/lib/nav';
import { useDiscardGuard } from '@/hooks/use-discard-guard';
import { useOnboarding, onboardingErrorMessage } from '@/providers/onboarding';
import type { TrainingResult } from '@/types/onboarding';
import { borderRadius, colors, spacing, typography } from '@/theme';

type Mode = 'sections' | 'quiz' | 'result';

export default function TrainingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { key } = useLocalSearchParams<{ key?: string }>();
  const { state, loading, error, refresh, submitTraining } = useOnboarding();

  const requirement = useMemo(
    () => state?.requirements.find((r) => r.key === key) ?? null,
    [state, key],
  );

  const sections = useMemo(() => requirement?.config.sections ?? [], [requirement]);
  const questions = useMemo(() => requirement?.config.questions ?? [], [requirement]);

  const [mode, setMode] = useState<Mode>(sections.length > 0 ? 'sections' : 'quiz');
  const [sectionIndex, setSectionIndex] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<TrainingResult | null>(null);

  // Started answering but not submitted yet — confirm before losing answers.
  // Progress itself is never recorded on leave: completion only happens via
  // the explicit submitTraining POST.
  useDiscardGuard(
    Object.keys(answers).length > 0 && result === null,
    'Your quiz answers haven’t been submitted.',
  );

  if (!state) {
    if (loading) return <LoadingView />;
    return <ErrorView message={error} onRetry={() => void refresh()} />;
  }
  if (!requirement) {
    return (
      <ErrorView message="This step is no longer available." onRetry={() => exitTask(router)} />
    );
  }

  const submit = async () => {
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await submitTraining(
        requirement.key,
        questions.map((q) => ({ questionId: q.id, selected: answers[q.id] ?? '' })),
      );
      setResult(res);
      setMode('result');
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setSubmitError(
          'You have reached the attempt limit for now. Review the material and try again later.',
        );
      } else {
        setSubmitError(onboardingErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const containerPadding = {
    paddingTop: spacing.xl,
    paddingBottom: insets.bottom + spacing['3xl'],
  } as const;

  if (mode === 'result' && result) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={[styles.content, containerPadding]}>
        {result.passed ? (
          <>
            <Text style={styles.title}>Training complete</Text>
            <Text style={styles.subtitle}>
              You scored {result.score} of {result.passScore} needed. This step is done.
            </Text>
            <View style={styles.actions}>
              <Button title="Done" onPress={() => exitTask(router)} fullWidth size="lg" />
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title}>Not quite</Text>
            <Text style={styles.subtitle}>
              You scored {result.score}. You need {result.passScore} to pass.
              {result.attemptsRemaining != null
                ? ` ${result.attemptsRemaining} ${
                    result.attemptsRemaining === 1 ? 'attempt' : 'attempts'
                  } remaining.`
                : ''}
            </Text>
            <View style={styles.actions}>
              {sections.length > 0 ? (
                <Button
                  title="Review material"
                  variant="outline"
                  onPress={() => {
                    setMode('sections');
                    setSectionIndex(0);
                    setQuestionIndex(0);
                    setAnswers({});
                    setResult(null);
                  }}
                  fullWidth
                />
              ) : null}
              {result.attemptsRemaining == null || result.attemptsRemaining > 0 ? (
                <Button
                  title="Try again"
                  onPress={() => {
                    setMode('quiz');
                    setQuestionIndex(0);
                    setAnswers({});
                    setResult(null);
                  }}
                  fullWidth
                />
              ) : null}
              <Button
                title="Do this later"
                variant="ghost"
                onPress={() => exitTask(router)}
                fullWidth
              />
            </View>
          </>
        )}
      </ScrollView>
    );
  }

  if (mode === 'sections' && sections.length > 0) {
    const section = sections[Math.min(sectionIndex, sections.length - 1)];
    const isLastSection = sectionIndex >= sections.length - 1;
    return (
      <View style={[styles.container, containerPadding, styles.pager]}>
        <ScrollView style={styles.sectionScroll} contentContainerStyle={styles.sectionContent}>
          <Text style={styles.progressLabel}>{requirement.title}</Text>
          <Text style={styles.title}>{section.title}</Text>
          <Text style={styles.sectionBody}>{section.body}</Text>
        </ScrollView>
        <View style={styles.footer}>
          <View style={styles.dots} accessibilityLabel={`Section ${sectionIndex + 1} of ${sections.length}`}>
            {sections.map((s, i) => (
              <View key={s.title} style={[styles.dot, i === sectionIndex && styles.dotActive]} />
            ))}
          </View>
          <Button
            title={isLastSection ? (questions.length > 0 ? 'Start quiz' : 'Continue') : 'Continue'}
            onPress={() => {
              if (isLastSection) {
                if (questions.length > 0) setMode('quiz');
                else exitTask(router);
              } else {
                setSectionIndex((i) => i + 1);
              }
            }}
            fullWidth
            size="lg"
          />
          {sectionIndex > 0 ? (
            <Button
              title="Back"
              variant="ghost"
              onPress={() => setSectionIndex((i) => i - 1)}
              fullWidth
            />
          ) : null}
        </View>
      </View>
    );
  }

  if (questions.length === 0) {
    return (
      <ErrorView message="This training has no quiz right now." onRetry={() => exitTask(router)} />
    );
  }

  const question = questions[Math.min(questionIndex, questions.length - 1)];
  const selected = answers[question.id];
  const isLastQuestion = questionIndex >= questions.length - 1;

  return (
    <View style={[styles.container, containerPadding, styles.pager]}>
      <ScrollView style={styles.sectionScroll} contentContainerStyle={styles.sectionContent}>
        <Text style={styles.progressLabel}>
          Question {questionIndex + 1} of {questions.length}
        </Text>
        <Text style={styles.title}>{question.prompt}</Text>
        <View style={styles.options} accessibilityRole="radiogroup">
          {question.options.map((option) => {
            const isSelected = selected === option;
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                onPress={() => setAnswers((prev) => ({ ...prev, [question.id]: option }))}
                style={({ pressed }) => [
                  styles.option,
                  isSelected && styles.optionSelected,
                  pressed && styles.optionPressed,
                ]}
              >
                <View style={[styles.radio, isSelected && styles.radioSelected]}>
                  {isSelected ? <View style={styles.radioInner} /> : null}
                </View>
                <Text style={[styles.optionText, isSelected && styles.optionTextSelected]}>
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
      </ScrollView>
      <View style={styles.footer}>
        <Button
          title={isLastQuestion ? 'Submit answers' : 'Continue'}
          onPress={() => {
            if (isLastQuestion) void submit();
            else setQuestionIndex((i) => i + 1);
          }}
          disabled={!selected}
          loading={submitting}
          fullWidth
          size="lg"
        />
        {questionIndex > 0 ? (
          <Button
            title="Back"
            variant="ghost"
            onPress={() => setQuestionIndex((i) => i - 1)}
            fullWidth
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  pager: { paddingHorizontal: spacing.lg },
  content: { paddingHorizontal: spacing.lg },
  title: { ...typography.h2, color: colors.text, marginTop: spacing.xs },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.sm },
  progressLabel: { ...typography.caption, color: colors.textMuted },
  sectionScroll: { flex: 1 },
  sectionContent: { paddingBottom: spacing.xl },
  sectionBody: { ...typography.body, color: colors.text, marginTop: spacing.lg },
  footer: { paddingTop: spacing.md, gap: spacing.sm },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.gray300 },
  dotActive: { backgroundColor: colors.primary },
  options: { marginTop: spacing.xl, gap: spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.white,
    gap: spacing.md,
  },
  optionSelected: { borderColor: colors.primary, backgroundColor: colors.gray50 },
  optionPressed: { backgroundColor: colors.gray50 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.gray400,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.primary },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary },
  optionText: { ...typography.body, color: colors.text, flex: 1 },
  optionTextSelected: { fontWeight: '600' },
  error: { ...typography.caption, color: colors.statusCritical, marginTop: spacing.lg },
  actions: { marginTop: spacing['2xl'], gap: spacing.sm },
});
