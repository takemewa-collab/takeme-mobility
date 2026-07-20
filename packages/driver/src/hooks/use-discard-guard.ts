import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useNavigation } from 'expo-router';

interface DiscardGuardLabels {
  /** Cancel-style button that keeps the user on the screen. */
  stay?: string;
  /** Destructive button that lets the removal proceed. */
  leave?: string;
}

/**
 * Confirms before the screen is removed while it holds unsaved work.
 *
 * Listens to react-navigation's `beforeRemove`, which fires for the native
 * header back button, iOS swipe-back, and the Android hardware back button
 * alike on a native stack. When `hasUnsavedChanges` is false the removal
 * proceeds untouched.
 *
 * The flag is read through a ref at event time so a save handler can reset
 * its snapshot and navigate away in the same interaction without re-arming
 * the guard mid-flight.
 */
export function useDiscardGuard(
  hasUnsavedChanges: boolean,
  message?: string,
  labels?: DiscardGuardLabels,
): void {
  const navigation = useNavigation();
  const guardRef = useRef(hasUnsavedChanges);
  const messageRef = useRef(message);
  const labelsRef = useRef(labels);

  // Synced in an effect (not during render); effects flush in hook-call
  // order, so callers that navigate from a later effect after clearing their
  // dirty flag always see the updated value here.
  useEffect(() => {
    guardRef.current = hasUnsavedChanges;
    messageRef.current = message;
    labelsRef.current = labels;
  });

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (!guardRef.current) return;
      e.preventDefault();
      Alert.alert(
        'Discard changes?',
        messageRef.current ?? 'Your edits on this screen haven’t been saved.',
        [
          { text: labelsRef.current?.stay ?? 'Keep editing', style: 'cancel' },
          {
            text: labelsRef.current?.leave ?? 'Discard',
            style: 'destructive',
            onPress: () => navigation.dispatch(e.data.action),
          },
        ],
      );
    });
    return unsubscribe;
  }, [navigation]);
}
