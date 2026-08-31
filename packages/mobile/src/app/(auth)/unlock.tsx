import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '../../lib/auth';

export default function UnlockScreen() {
  const { signOut, state, unlock } = useMobileAuth();
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const isBooting = state.phase === 'booting';
  const busy = isUnlocking || isRemoving;
  const visibleError = localError ?? state.message;

  async function handleUnlock(): Promise<void> {
    setLocalError(null);
    setIsUnlocking(true);
    try {
      await unlock();
    } catch {
      setLocalError(
        'PSD EOC could not open device authentication. Try again or contact district technology support.',
      );
    } finally {
      setIsUnlocking(false);
    }
  }

  async function handleRemoveEnrollment(): Promise<void> {
    setLocalError(null);
    setIsConfirmingRemoval(false);
    setIsRemoving(true);
    try {
      await signOut();
    } catch {
      setLocalError(
        'Sign-out was not completed. PSD EOC kept the enrolled session because device authentication or online server and push cleanup could not be confirmed. Reconnect and try again.',
      );
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        style={styles.page}
      >
        <View style={styles.lockMark}>
          <Text accessibilityElementsHidden style={styles.lockMarkText}>
            PSD
          </Text>
        </View>

        <View style={styles.heading}>
          <Text style={styles.eyebrow}>SECURE STAFF ACCESS</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {isBooting ? 'Preparing PSD EOC' : 'Unlock PSD EOC'}
          </Text>
          <Text style={styles.subtitle}>
            {isBooting
              ? 'Checking for an enrolled device session.'
              : 'Confirm with device security before the enrolled session can be read.'}
          </Text>
        </View>

        {visibleError !== null ? (
          <View
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.errorNotice}
          >
            <Text style={styles.errorTitle}>PSD EOC remains locked</Text>
            <Text style={styles.errorBody}>{visibleError}</Text>
          </View>
        ) : null}

        {isBooting ? (
          <View
            accessibilityLabel="Checking secure device enrollment"
            accessibilityRole="progressbar"
            style={styles.progress}
          >
            <ActivityIndicator color="#175A8E" size="large" />
            <Text style={styles.progressText}>Checking secure enrollment</Text>
          </View>
        ) : (
          <Pressable
            accessibilityHint="Opens Face ID, Android biometric, or the operating system device passcode fallback"
            accessibilityLabel={
              visibleError === null
                ? 'Unlock with device security'
                : 'Try device unlock again'
            }
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy }}
            disabled={busy}
            onPress={() => {
              void handleUnlock();
            }}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && !busy && styles.buttonPressed,
              busy && styles.buttonDisabled,
            ]}
          >
            {isUnlocking ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : null}
            <Text style={styles.primaryButtonText}>
              {isUnlocking
                ? 'Waiting for device security'
                : visibleError === null
                  ? 'Unlock with device security'
                  : 'Try unlock again'}
            </Text>
          </Pressable>
        )}

        {!isBooting ? (
          <View style={styles.removalSection}>
            {isConfirmingRemoval ? (
              <View
                accessibilityLiveRegion="assertive"
                accessibilityRole="alert"
                style={styles.removalConfirmation}
              >
                <Text
                  accessibilityRole="header"
                  style={styles.confirmationTitle}
                >
                  Sign out and stop push alerts?
                </Text>
                <Text style={styles.confirmationBody}>
                  PSD EOC will first ask for device security so it can read the
                  protected credential. It must then contact the server to
                  revoke this session and stop this device&apos;s push alerts
                  before removing the local credential. If cleanup cannot be
                  confirmed, nothing is removed and no offline cleanup is
                  queued.
                </Text>
                <Pressable
                  accessibilityLabel="Cancel sign-out"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  onPress={() => {
                    setIsConfirmingRemoval(false);
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && !busy && styles.buttonPressed,
                    busy && styles.buttonDisabled,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityHint="Requires device security and online server and push cleanup before the encrypted local session is removed"
                  accessibilityLabel="Confirm sign-out and push cleanup"
                  accessibilityRole="button"
                  accessibilityState={{ busy: isRemoving, disabled: busy }}
                  disabled={busy}
                  onPress={() => {
                    void handleRemoveEnrollment();
                  }}
                  style={({ pressed }) => [
                    styles.destructiveButton,
                    pressed && !busy && styles.buttonPressed,
                    busy && styles.buttonDisabled,
                  ]}
                >
                  {isRemoving ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : null}
                  <Text style={styles.destructiveButtonText}>
                    {isRemoving
                      ? 'Confirming secure sign-out'
                      : 'Sign out and stop push alerts'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Pressable
                  accessibilityHint="Asks you to confirm before any local credential is removed"
                  accessibilityLabel="Sign out on this device"
                  accessibilityRole="button"
                  accessibilityState={{ busy, disabled: busy }}
                  disabled={busy}
                  onPress={() => {
                    setIsConfirmingRemoval(true);
                  }}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && !busy && styles.buttonPressed,
                    busy && styles.buttonDisabled,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>
                    Sign out on this device
                  </Text>
                </Pressable>
                <Text style={styles.removalHelp}>
                  You will be asked to confirm before this locked device's
                  encrypted session is removed.
                </Text>
              </>
            )}
          </View>
        ) : null}

        <View accessibilityRole="summary" style={styles.fallbackNotice}>
          <Text style={styles.noticeTitle}>Device passcode fallback</Text>
          <Text style={styles.noticeBody}>
            If biometrics are unavailable, use the passcode option supplied by
            iOS or Android. PSD EOC never asks you to create or enter a separate
            app PIN.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#F4F7FA',
    flex: 1,
  },
  content: {
    flexGrow: 1,
    gap: 22,
    justifyContent: 'center',
    padding: 24,
    paddingBottom: 40,
  },
  lockMark: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#17324D',
    borderRadius: 16,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  lockMarkText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  heading: {
    gap: 8,
  },
  eyebrow: {
    color: '#3B5874',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    lineHeight: 16,
  },
  title: {
    color: '#102A43',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -0.5,
    lineHeight: 41,
  },
  subtitle: {
    color: '#486581',
    fontSize: 17,
    lineHeight: 25,
  },
  errorNotice: {
    backgroundColor: '#FFF1F0',
    borderColor: '#C0352B',
    borderRadius: 14,
    borderWidth: 2,
    gap: 4,
    padding: 16,
  },
  errorTitle: {
    color: '#7A1E17',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  errorBody: {
    color: '#7A1E17',
    fontSize: 15,
    lineHeight: 22,
  },
  progress: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#BCCCDC',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    minHeight: 72,
    padding: 18,
  },
  progressText: {
    color: '#334E68',
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 23,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#175A8E',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    textAlign: 'center',
  },
  buttonPressed: {
    opacity: 0.76,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  removalSection: {
    gap: 8,
  },
  removalConfirmation: {
    backgroundColor: '#FFF1F0',
    borderColor: '#C0352B',
    borderRadius: 14,
    borderWidth: 2,
    gap: 12,
    padding: 16,
  },
  confirmationTitle: {
    color: '#7A1E17',
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 23,
  },
  confirmationBody: {
    color: '#7A1E17',
    fontSize: 15,
    lineHeight: 22,
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#486581',
    borderRadius: 12,
    borderWidth: 2,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  secondaryButtonText: {
    color: '#17324D',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    textAlign: 'center',
  },
  destructiveButton: {
    alignItems: 'center',
    backgroundColor: '#A82820',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  destructiveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    textAlign: 'center',
  },
  removalHelp: {
    color: '#486581',
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 2,
  },
  fallbackNotice: {
    backgroundColor: '#E8F1F8',
    borderColor: '#9DB8CF',
    borderRadius: 16,
    borderWidth: 1,
    gap: 5,
    padding: 17,
  },
  noticeTitle: {
    color: '#102A43',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  noticeBody: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 22,
  },
});
