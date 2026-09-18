import { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '../../lib/auth';
import { privacyPolicyUrl } from '../../lib/auth/auth-api-client';

const UNEXPECTED_SIGN_IN_ERROR =
  'PSD EOC could not start secure sign-in. Try again or contact district technology support.';

export default function SignInScreen() {
  const { beginGoogleSignIn, isSigningIn, signInError, signOut, state } =
    useMobileAuth();
  const [localError, setLocalError] = useState<string | null>(null);
  const [isRetryingStorage, setIsRetryingStorage] = useState(false);
  // A failed attempt has to be visible where the press happened. The notice
  // above the card can already be on screen before anyone taps, so a sign-in
  // that fails fast repaints nothing near the button and reads as a dead
  // control. That is what an app reviewer reported as an unresponsive button.
  const [attempted, setAttempted] = useState(false);
  const storageBlocked = state.phase === 'blocked';
  const busy = isSigningIn || isRetryingStorage;
  const visibleError = localError ?? signInError ?? state.message;
  // When a press just failed, the message belongs at the button and nowhere
  // else. Showing it in both places says the same thing twice and buries it.
  const attemptFailure = attempted && !busy && visibleError !== null;

  async function handleSignIn(): Promise<void> {
    setLocalError(null);
    setAttempted(true);
    try {
      await beginGoogleSignIn();
    } catch {
      setLocalError(UNEXPECTED_SIGN_IN_ERROR);
    }
  }

  async function handleStorageRetry(): Promise<void> {
    setLocalError(null);
    setIsRetryingStorage(true);
    try {
      // A local sign-out clears any unusable enrollment marker. The next
      // enrollment still has to prove that secure storage is available.
      await signOut();
    } catch {
      setLocalError(
        'Secure device storage is still unavailable. Contact district technology support.',
      );
    } finally {
      setIsRetryingStorage(false);
    }
  }

  async function handlePrivacyPolicy(): Promise<void> {
    setLocalError(null);
    try {
      await Linking.openURL(
        privacyPolicyUrl(process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL, __DEV__),
      );
    } catch {
      setLocalError(
        'PSD EOC could not open the privacy policy. Check your connection and try again.',
      );
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={styles.page}
      >
        <View style={styles.brand}>
          <Text style={styles.eyebrow}>DISTRICT STAFF</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Sign in to PSD EOC
          </Text>
          <Text style={styles.subtitle}>
            Use your district Google account to enroll this staff device. Access
            requires current membership in a designated staff access group.
          </Text>
        </View>

        {visibleError !== null && !attemptFailure ? (
          <View
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.errorNotice}
          >
            <Text style={styles.errorTitle}>Action needs attention</Text>
            <Text style={styles.errorBody}>{visibleError}</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Secure device enrollment</Text>
          <Text style={styles.cardBody}>
            Google verifies your district identity, and the server checks the
            designated staff access group. PSD EOC then stores only its opaque
            device session in encrypted system storage.
          </Text>

          {storageBlocked ? (
            <Pressable
              accessibilityHint="Checks secure device storage again before Google sign-in is allowed"
              accessibilityLabel="Retry secure device setup"
              accessibilityRole="button"
              accessibilityState={{ busy, disabled: busy }}
              disabled={busy}
              onPress={() => {
                void handleStorageRetry();
              }}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && !busy && styles.buttonPressed,
                busy && styles.buttonDisabled,
              ]}
            >
              {isRetryingStorage ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : null}
              <Text style={styles.primaryButtonText}>
                {isRetryingStorage
                  ? 'Checking secure storage'
                  : 'Retry secure device setup'}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityHint="Opens Google sign-in in the system browser; only authorized staff can enroll"
              accessibilityLabel="Sign in with Google"
              accessibilityRole="button"
              accessibilityState={{ busy, disabled: busy }}
              disabled={busy}
              onPress={() => {
                void handleSignIn();
              }}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && !busy && styles.buttonPressed,
                busy && styles.buttonDisabled,
              ]}
            >
              {isSigningIn ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : null}
              <Text style={styles.primaryButtonText}>
                {isSigningIn ? 'Signing in securely' : 'Sign in with Google'}
              </Text>
            </Pressable>
          )}

          {attemptFailure ? (
            <View
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              style={styles.attemptFailure}
            >
              <Text style={styles.attemptFailureTitle}>
                Sign-in did not start
              </Text>
              <Text style={styles.attemptFailureBody}>{visibleError}</Text>
              <Pressable
                accessibilityHint="Starts Google sign-in again"
                accessibilityLabel="Try signing in again"
                accessibilityRole="button"
                onPress={() => {
                  void handleSignIn();
                }}
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text style={styles.retryButtonText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <View accessibilityRole="summary" style={styles.deviceSecurityNotice}>
          <Text style={styles.noticeTitle}>
            Your device protects return access
          </Text>
          <Text style={styles.noticeBody}>
            After enrollment, use Face ID, your Android biometric, or the device
            passcode fallback supplied by the operating system. PSD EOC never
            creates a separate app PIN.
          </Text>
        </View>

        <Pressable
          accessibilityHint="Opens the public policy for this configured district deployment"
          accessibilityLabel="Privacy policy"
          accessibilityRole="link"
          onPress={() => {
            void handlePrivacyPolicy();
          }}
          style={({ pressed }) => [
            styles.privacyLink,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.privacyLinkText}>Privacy policy</Text>
        </Pressable>
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
  brand: {
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
  card: {
    backgroundColor: '#FFFFFF',
    borderColor: '#BCCCDC',
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 20,
  },
  cardTitle: {
    color: '#102A43',
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 27,
  },
  cardBody: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 22,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#175A8E',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    marginTop: 8,
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 13,
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
  attemptFailure: {
    backgroundColor: '#FFF0F1',
    borderColor: '#B42332',
    borderRadius: 14,
    borderWidth: 2,
    gap: 9,
    marginTop: 14,
    padding: 14,
  },
  attemptFailureBody: {
    color: '#6B101B',
    fontSize: 15,
    lineHeight: 22,
  },
  attemptFailureTitle: {
    color: '#6B101B',
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 23,
  },
  retryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderColor: '#B42332',
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  retryButtonText: {
    color: '#6B101B',
    fontSize: 16,
    fontWeight: '900',
    lineHeight: 22,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  deviceSecurityNotice: {
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
  privacyLink: {
    alignSelf: 'center',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  privacyLinkText: {
    color: '#175A8E',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    textDecorationLine: 'underline',
  },
});
