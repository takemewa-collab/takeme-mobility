import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatRelativeTime } from '@takeme/shared';
import type { DriverNotification } from '@/types/driver-hub';
import { HubEmpty, HubError, HubLoading } from '@/components/hub/state-views';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, hitSlop } from '@/theme/spacing';

type IoniconName = keyof typeof Ionicons.glyphMap;

const CATEGORY_ICONS: Record<string, IoniconName> = {
  payout: 'cash-outline',
  document: 'document-text-outline',
  compliance: 'shield-checkmark-outline',
  ride: 'car-outline',
  safety: 'shield-outline',
};

export interface NotificationsScreenProps {
  phase: 'loading' | 'error' | 'ready';
  notifications: DriverNotification[];
  unreadCount: number;
  loadingMore: boolean;
  onEndReached: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onBack: () => void;
  onMarkAllRead: () => void;
  onPressItem: (notification: DriverNotification) => void;
}

export function NotificationsScreenView(props: NotificationsScreenProps) {
  const unread = props.notifications.filter((n) => n.read_at == null);
  const read = props.notifications.filter((n) => n.read_at != null);
  const sections = [
    ...(unread.length > 0 ? [{ key: 'new', title: 'New', data: unread }] : []),
    ...(read.length > 0 ? [{ key: 'earlier', title: 'Earlier', data: read }] : []),
  ];

  const header = (
    <View style={styles.navBar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={props.onBack}
        hitSlop={hitSlop}
        style={styles.backButton}
      >
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.navTitle}>Notifications</Text>
      {props.unreadCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={props.onMarkAllRead}
          hitSlop={hitSlop}
          style={styles.markAllButton}
        >
          <Text style={styles.markAllText}>Mark all read</Text>
        </Pressable>
      ) : (
        <View style={styles.backButton} />
      )}
    </View>
  );

  if (props.phase === 'loading') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <HubLoading />
      </SafeAreaView>
    );
  }

  if (props.phase === 'error') {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <HubError
          title="Couldn't load notifications"
          body="Check your connection and try again."
          onRetry={props.onRetry}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <NotificationRow notification={item} onPress={() => props.onPressItem(item)} />
        )}
        ListEmptyComponent={
          <HubEmpty
            icon="notifications-off-outline"
            title="You're all caught up"
            body="Payout updates, document reminders, and trip notices will appear here."
          />
        }
        ListFooterComponent={
          props.loadingMore ? (
            <View style={styles.footerLoading}>
              <ActivityIndicator color={colors.text} />
            </View>
          ) : null
        }
        onEndReachedThreshold={0.4}
        onEndReached={props.onEndReached}
        refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
  );
}

function NotificationRow({
  notification,
  onPress,
}: {
  notification: DriverNotification;
  onPress: () => void;
}) {
  const isUnread = notification.read_at == null;
  const icon = CATEGORY_ICONS[notification.category] ?? 'notifications-outline';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={20} color={isUnread ? colors.text : colors.gray500} />
        {isUnread ? <View style={styles.unreadDot} /> : null}
      </View>
      <View style={styles.rowText}>
        <Text style={isUnread ? styles.rowTitleUnread : styles.rowTitle} numberOfLines={2}>
          {notification.title}
        </Text>
        <Text style={styles.rowBody} numberOfLines={3}>
          {notification.body}
        </Text>
        <Text style={styles.rowTime}>{formatRelativeTime(notification.created_at)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  listContent: { paddingBottom: spacing['5xl'], flexGrow: 1 },
  pressed: { opacity: 0.7 },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    minHeight: 44,
  },
  backButton: { width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center' },
  navTitle: { ...typography.bodyBold, color: colors.text },
  markAllButton: { minHeight: 44, justifyContent: 'center' },
  markAllText: { ...typography.captionBold, color: colors.text, textDecorationLine: 'underline' },

  sectionTitle: {
    ...typography.captionBold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    minHeight: 64,
  },
  iconWrap: { width: 28, alignItems: 'center', paddingTop: 2 },
  unreadDot: {
    position: 'absolute',
    top: 0,
    right: 2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.black,
  },
  rowText: { flex: 1 },
  rowTitle: { ...typography.body, color: colors.textSecondary },
  rowTitleUnread: { ...typography.bodyBold, color: colors.text },
  rowBody: { ...typography.caption, color: colors.textSecondary, marginTop: 1 },
  rowTime: { ...typography.small, color: colors.textMuted, marginTop: spacing.xs },
  footerLoading: { paddingVertical: spacing.xl },
});
