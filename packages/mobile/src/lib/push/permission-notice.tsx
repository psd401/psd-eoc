import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { PushRegistrationSnapshot } from './registration-controller';

function publicPushInstructions(platform: 'android' | 'ios' | null): string {
  return platform === 'ios'
    ? 'Open iPhone Settings, choose Notifications, choose PSD EOC, then enable Allow Notifications, Sounds, and Lock Screen.'
    : 'Open Android Settings, choose Apps, choose PSD EOC, then enable Notifications and the PSD EOC incident and drill alerts channel.';
}

interface PushNotificationNoticeProps {
  readonly onOpenSettings: () => void;
  readonly onRequestPermission: () => void;
  readonly onRetry: () => void;
  readonly snapshot: PushRegistrationSnapshot;
}

export function PushNotificationNotice({
  onOpenSettings,
  onRequestPermission,
  onRetry,
  snapshot,
}: PushNotificationNoticeProps) {
  if (snapshot.phase === 'idle' || snapshot.phase === 'registered') return null;
  if (snapshot.phase === 'registering') {
    return (
      <View
        accessibilityLabel="Confirming push alert registration"
        accessibilityRole="progressbar"
        style={styles.notice}
      >
        <ActivityIndicator color="#17324D" size="small" />
        <Text style={styles.noticeBody}>
          Confirming push alert registration
        </Text>
      </View>
    );
  }

  const explanation = snapshot.phase === 'explanation-required';
  const denied = snapshot.phase === 'denied';
  const providerDisabled = snapshot.phase === 'provider-disabled';
  const title = explanation
    ? 'Get PSD EOC alerts on this device'
    : denied
      ? 'Push alerts are off'
      : providerDisabled
        ? 'Push registration is disabled'
        : 'Push registration needs attention';
  const body = explanation
    ? 'PSD EOC uses audible lock-screen notifications for both real incidents and clearly marked drills. Continue only when you are ready for the operating-system permission prompt.'
    : denied
      ? publicPushInstructions(snapshot.platform)
      : (snapshot.message ??
        'PSD EOC could not confirm this device for push alerts.');

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[styles.notice, denied && styles.deniedNotice]}
    >
      <View style={styles.noticeCopy}>
        <Text accessibilityRole="header" style={styles.noticeTitle}>
          {title}
        </Text>
        <Text style={styles.noticeBody}>{body}</Text>
        {snapshot.message !== null && denied ? (
          <Text style={styles.noticeWarning}>{snapshot.message}</Text>
        ) : null}
      </View>
      {explanation ? (
        <Pressable
          accessibilityHint="Opens the operating-system notification permission prompt"
          accessibilityLabel="Continue to notification permission"
          accessibilityRole="button"
          onPress={onRequestPermission}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            Continue to notification permission
          </Text>
        </Pressable>
      ) : denied ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="Open device notification settings"
            accessibilityRole="button"
            onPress={onOpenSettings}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Open device settings</Text>
          </Pressable>
          <Pressable
            accessibilityHint="Checks permission again after you return from Settings"
            accessibilityLabel="Check push permission again"
            accessibilityRole="button"
            onPress={onRetry}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Check again</Text>
          </Pressable>
        </View>
      ) : providerDisabled ? null : (
        <Pressable
          accessibilityLabel="Retry push registration"
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.secondaryButtonText}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    alignItems: 'flex-start',
    backgroundColor: '#EAF2F8',
    borderBottomColor: '#8AA7BC',
    borderBottomWidth: 1,
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  deniedNotice: {
    backgroundColor: '#FFF4E5',
    borderBottomColor: '#B56A00',
  },
  noticeCopy: { gap: 4 },
  noticeTitle: { color: '#102A43', fontSize: 16, fontWeight: '800' },
  noticeBody: { color: '#243B53', fontSize: 15, lineHeight: 21 },
  noticeWarning: { color: '#7A2E0B', fontSize: 14, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  primaryButton: {
    backgroundColor: '#175A8E',
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  secondaryButton: {
    backgroundColor: '#FFFFFF',
    borderColor: '#175A8E',
    borderRadius: 8,
    borderWidth: 2,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  secondaryButtonText: { color: '#123F62', fontSize: 15, fontWeight: '800' },
  buttonPressed: { opacity: 0.75 },
});
