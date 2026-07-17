import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/providers/auth';
import { useSupabase } from '@/providers/supabase';
import { colors } from '@/theme/colors';

type RideMessage = {
  id: string;
  ride_id: string;
  sender_role: 'rider' | 'driver';
  sender_id: string;
  body: string;
  created_at: string;
};

/**
 * In-app thread with the rider for the active trip. Runs on the RLS-protected
 * ride_messages table with realtime delivery — no phone numbers on either
 * side. Sending is blocked server-side once the ride is no longer active.
 */
export function TripMessagesSheet({
  rideId,
  visible,
  onClose,
}: {
  rideId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const supabase = useSupabase();
  const { user } = useAuth();
  const listRef = useRef<FlatList<RideMessage>>(null);
  const [messages, setMessages] = useState<RideMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;

    supabase
      .from('ride_messages')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (alive) setMessages((data as RideMessage[] | null) ?? []);
      });

    const channel = supabase
      .channel(`ride-messages-${rideId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ride_messages', filter: `ride_id=eq.${rideId}` },
        (payload) => {
          const message = payload.new as RideMessage;
          setMessages((current) =>
            current && !current.some((m) => m.id === message.id) ? [...current, message] : current,
          );
        },
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [visible, rideId, supabase]);

  async function send() {
    const body = draft.trim();
    if (!body || sending || !user) return;
    setSending(true);
    setError(null);
    const { data, error: insertError } = await supabase
      .from('ride_messages')
      .insert({ ride_id: rideId, sender_role: 'driver', sender_id: user.id, body })
      .select('*')
      .single();
    setSending(false);
    if (insertError) {
      setError('Message didn’t send. The trip may have ended.');
      return;
    }
    setDraft('');
    if (data) {
      setMessages((current) =>
        current && !current.some((m) => m.id === (data as RideMessage).id)
          ? [...current, data as RideMessage]
          : current,
      );
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close messages" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 10 }]}>
          <View style={styles.grabber} />
          <Text accessibilityRole="header" style={styles.title}>
            Message your rider
          </Text>

          {messages === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.textSecondary} />
            </View>
          ) : messages.length === 0 ? (
            <Text style={styles.emptyNote}>
              Let the rider know where you are — they see it instantly.
            </Text>
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(m) => m.id}
              style={styles.list}
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
              renderItem={({ item }) => (
                <View
                  style={[
                    styles.bubble,
                    item.sender_role === 'driver' ? styles.bubbleMine : styles.bubbleTheirs,
                  ]}>
                  <Text
                    style={
                      item.sender_role === 'driver' ? styles.bubbleTextMine : styles.bubbleText
                    }>
                    {item.body}
                  </Text>
                </View>
              )}
            />
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Message…"
              placeholderTextColor={colors.textSecondary}
              style={styles.input}
              maxLength={500}
              accessibilityLabel="Message your rider"
              onSubmitEditing={() => void send()}
              returnKeyType="send"
            />
            <Pressable
              onPress={() => void send()}
              disabled={!draft.trim() || sending}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              style={({ pressed }) => [
                styles.sendButton,
                (!draft.trim() || sending) && styles.sendDisabled,
                pressed && styles.pressed,
              ]}>
              {sending ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <Text style={styles.sendText}>Send</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    maxHeight: 480,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.gray200,
    marginBottom: 12,
  },
  title: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 10 },

  loading: { paddingVertical: 32, alignItems: 'center' },
  emptyNote: { fontSize: 13, color: colors.textSecondary, lineHeight: 18, paddingVertical: 16 },
  list: { maxHeight: 280, marginBottom: 6 },

  bubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 8,
    marginBottom: 6,
  },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: colors.text, borderBottomRightRadius: 5 },
  bubbleTheirs: {
    alignSelf: 'flex-start',
    backgroundColor: colors.gray100,
    borderBottomLeftRadius: 5,
  },
  bubbleText: { fontSize: 15, color: colors.text, lineHeight: 20 },
  bubbleTextMine: { fontSize: 15, color: colors.white, lineHeight: 20 },

  error: { fontSize: 12.5, color: colors.textSecondary, marginBottom: 6 },

  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingTop: 4 },
  input: {
    flex: 1,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.gray100,
    paddingHorizontal: 14,
    fontSize: 15,
    color: colors.text,
  },
  sendButton: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 14,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { fontSize: 14, fontWeight: '600', color: colors.white },
  pressed: { opacity: 0.8 },
});
