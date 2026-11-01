import { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '../../lib/auth';
import { privacyPolicyUrl } from '../../lib/auth/auth-api-client';

const UNEXPECTED_SIGN_IN_ERROR =
  'PSD EOC could not start secure sign-in. Try again or contact district technology support.';

/** Stable identifiers for the partner agency flow's Maestro journey. */
export const PARTNER_SIGN_IN_TEST_IDS = Object.freeze({
  toggle: 'partner-sign-in-toggle',
  email: 'partner-sign-in-email',
  requestCode: 'partner-sign-in-request-code',
  code: 'partner-sign-in-code',
  verify: 'partner-sign-in-verify',
  startOver: 'partner-sign-in-start-over',
});

/** The emailed partner code, as the field keeps it: digits only. */
export function partnerCodeDigits(value: string): string {
  return value.replace(/\D/gu, '').slice(0, 8);
}

export default function SignInScreen() {
  const {
    beginAppReviewSignIn,
    beginGoogleSignIn,
    beginPartnerSignIn,
    completePartnerSignIn,
    isSigningIn,
    partnerCodeRequested,
    resetPartnerSignIn,
    signInError,
    signOut,
    state,
  } = useMobileAuth();
  const [localError, setLocalError] = useState<string | null>(null);
  // App-store reviewers cannot complete district single sign-on on their test
  // devices, so they are given one review account and a code instead.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEmail, setReviewEmail] = useState('');
  const [reviewCode, setReviewCode] = useState('');
  const [reviewAttempted, setReviewAttempted] = useState(false);
  // Partner agencies are not in district single sign-on. They hold an
  // admission in the partner pool and prove one address with an emailed code,
  // so their flow is two steps and never leaves the app.
  const [partnerOpen, setPartnerOpen] = useState(false);
  const [partnerEmail, setPartnerEmail] = useState('');
  const [partnerCode, setPartnerCode] = useState('');
  const [partnerAttempted, setPartnerAttempted] = useState(false);
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
  const reviewFailure = reviewAttempted && !busy && visibleError !== null;
  const partnerFailure = partnerAttempted && !busy && visibleError !== null;
  const reviewReady =
    reviewEmail.trim().length > 0 && reviewCode.trim().length > 0;
  const partnerEmailReady = partnerEmail.trim().length > 0;
  const partnerCodeReady = partnerCode.length >= 6;

  async function handleReviewSignIn(): Promise<void> {
    setLocalError(null);
    setAttempted(false);
    setPartnerAttempted(false);
    setReviewAttempted(true);
    try {
      await beginAppReviewSignIn(reviewEmail, reviewCode);
    } catch {
      setLocalError(UNEXPECTED_SIGN_IN_ERROR);
    }
  }

  async function handleSignIn(): Promise<void> {
    setLocalError(null);
    setReviewAttempted(false);
    setPartnerAttempted(false);
    setAttempted(true);
    try {
      await beginGoogleSignIn();
    } catch {
      setLocalError(UNEXPECTED_SIGN_IN_ERROR);
    }
  }

  /**
   * One action for the partner's first step: the passkey if this device has
   * one for them, the emailed code otherwise. The two are deliberately not
   * two buttons — a partner should not have to know which they have, and the
   * fallback must look the same as never having had a passkey at all.
   */
  async function handlePartnerContinue(): Promise<void> {
    setLocalError(null);
    setAttempted(false);
    setReviewAttempted(false);
    setPartnerAttempted(true);
    setPartnerCode('');
    try {
      await beginPartnerSignIn(partnerEmail);
    } catch {
      setLocalError(UNEXPECTED_SIGN_IN_ERROR);
    }
  }

  async function handlePartnerSignIn(): Promise<void> {
    setLocalError(null);
    setAttempted(false);
    setReviewAttempted(false);
    setPartnerAttempted(true);
    try {
      await completePartnerSignIn(partnerCode);
    } catch {
      setLocalError(UNEXPECTED_SIGN_IN_ERROR);
    }
  }

  function handlePartnerStartOver(): void {
    setLocalError(null);
    setPartnerAttempted(false);
    setPartnerCode('');
    resetPartnerSignIn();
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
        automaticallyAdjustKeyboardInsets
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

        {visibleError !== null &&
        !attemptFailure &&
        !reviewFailure &&
        !partnerFailure ? (
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
            If this device has a screen lock, PSD EOC asks for Face ID, your
            Android biometric, or the device passcode when you return. PSD EOC
            never creates a separate app PIN.
          </Text>
        </View>

        <View style={styles.reviewSection}>
          <Pressable
            accessibilityHint="Shows the sign-in for invited partner agency responders"
            accessibilityLabel="Partner agency sign-in"
            accessibilityRole="button"
            accessibilityState={{ expanded: partnerOpen }}
            onPress={() => {
              setPartnerOpen((open) => !open);
            }}
            style={({ pressed }) => [
              styles.privacyLink,
              pressed && styles.buttonPressed,
            ]}
            testID={PARTNER_SIGN_IN_TEST_IDS.toggle}
          >
            <Text style={styles.privacyLinkText}>Partner agency sign-in</Text>
          </Pressable>

          {partnerOpen ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Partner agency</Text>
              <Text style={styles.cardBody}>
                {partnerCodeRequested
                  ? 'If that address holds a current partner admission, a code is on its way to it. Enter the code to finish signing in.'
                  : 'For invited first responders. Enter the email address your agency was invited with. PSD EOC uses the passkey you added to this device, or emails you a one-time code. District staff sign in with Google above.'}
              </Text>

              {partnerCodeRequested ? (
                <>
                  <TextInput
                    accessibilityLabel="One-time code from your email"
                    autoCapitalize="none"
                    autoComplete="one-time-code"
                    autoCorrect={false}
                    autoFocus
                    editable={!busy}
                    inputMode="numeric"
                    keyboardType="number-pad"
                    maxLength={8}
                    onChangeText={(value) => {
                      setPartnerCode(partnerCodeDigits(value));
                    }}
                    onSubmitEditing={() => {
                      if (partnerCodeReady && !busy) {
                        void handlePartnerSignIn();
                      }
                    }}
                    placeholder="One-time code"
                    placeholderTextColor="#829AB1"
                    style={styles.reviewInput}
                    testID={PARTNER_SIGN_IN_TEST_IDS.code}
                    textContentType="oneTimeCode"
                    value={partnerCode}
                  />
                  <Pressable
                    accessibilityHint="Finishes partner agency sign-in with the code from your email"
                    accessibilityLabel="Sign in with this code"
                    accessibilityRole="button"
                    accessibilityState={{
                      busy,
                      disabled: busy || !partnerCodeReady,
                    }}
                    disabled={busy || !partnerCodeReady}
                    onPress={() => {
                      void handlePartnerSignIn();
                    }}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      pressed && !busy && styles.buttonPressed,
                      (busy || !partnerCodeReady) && styles.buttonDisabled,
                    ]}
                    testID={PARTNER_SIGN_IN_TEST_IDS.verify}
                  >
                    {isSigningIn && partnerAttempted ? (
                      <ActivityIndicator color="#FFFFFF" size="small" />
                    ) : null}
                    <Text style={styles.primaryButtonText}>
                      {isSigningIn && partnerAttempted
                        ? 'Signing in'
                        : 'Sign in with this code'}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityHint="Discards this code request and asks for the email address again"
                    accessibilityLabel="Use a different address"
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={handlePartnerStartOver}
                    style={({ pressed }) => [
                      styles.privacyLink,
                      pressed && styles.buttonPressed,
                    ]}
                    testID={PARTNER_SIGN_IN_TEST_IDS.startOver}
                  >
                    <Text style={styles.privacyLinkText}>
                      Use a different address
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <TextInput
                    accessibilityLabel="Partner agency email"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoCorrect={false}
                    editable={!busy}
                    inputMode="email"
                    keyboardType="email-address"
                    onChangeText={setPartnerEmail}
                    onSubmitEditing={() => {
                      if (partnerEmailReady && !busy) {
                        void handlePartnerContinue();
                      }
                    }}
                    placeholder="Partner agency email"
                    placeholderTextColor="#829AB1"
                    style={styles.reviewInput}
                    testID={PARTNER_SIGN_IN_TEST_IDS.email}
                    textContentType="emailAddress"
                    value={partnerEmail}
                  />
                  <Pressable
                    accessibilityHint="Uses the passkey on this device for this address, or emails a one-time code"
                    accessibilityLabel="Continue partner agency sign-in"
                    accessibilityRole="button"
                    accessibilityState={{
                      busy,
                      disabled: busy || !partnerEmailReady,
                    }}
                    disabled={busy || !partnerEmailReady}
                    onPress={() => {
                      void handlePartnerContinue();
                    }}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      pressed && !busy && styles.buttonPressed,
                      (busy || !partnerEmailReady) && styles.buttonDisabled,
                    ]}
                    testID={PARTNER_SIGN_IN_TEST_IDS.requestCode}
                  >
                    {isSigningIn && partnerAttempted ? (
                      <ActivityIndicator color="#FFFFFF" size="small" />
                    ) : null}
                    <Text style={styles.primaryButtonText}>
                      {isSigningIn && partnerAttempted
                        ? 'Checking this device'
                        : 'Continue'}
                    </Text>
                  </Pressable>
                </>
              )}

              {partnerFailure ? (
                <View
                  accessibilityLiveRegion="assertive"
                  accessibilityRole="alert"
                  style={styles.attemptFailure}
                >
                  <Text style={styles.attemptFailureTitle}>
                    Partner sign-in did not complete
                  </Text>
                  <Text style={styles.attemptFailureBody}>{visibleError}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={styles.reviewSection}>
          <Pressable
            accessibilityHint="Shows the sign-in for the account supplied to app store reviewers"
            accessibilityLabel="App store review sign-in"
            accessibilityRole="button"
            accessibilityState={{ expanded: reviewOpen }}
            onPress={() => {
              setReviewOpen((open) => !open);
            }}
            style={({ pressed }) => [
              styles.privacyLink,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.privacyLinkText}>App store review sign-in</Text>
          </Pressable>

          {reviewOpen ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>App store review</Text>
              <Text style={styles.cardBody}>
                For Apple and Google reviewers only. Enter the review account
                email and the password supplied with this submission. District
                staff sign in with Google above.
              </Text>
              <TextInput
                accessibilityLabel="Review account email"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                editable={!busy}
                inputMode="email"
                keyboardType="email-address"
                onChangeText={setReviewEmail}
                placeholder="Review account email"
                placeholderTextColor="#829AB1"
                style={styles.reviewInput}
                testID="app-review-email"
                textContentType="username"
                value={reviewEmail}
              />
              <TextInput
                accessibilityLabel="Review password"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                editable={!busy}
                onChangeText={setReviewCode}
                onSubmitEditing={() => {
                  if (reviewReady && !busy) {
                    void handleReviewSignIn();
                  }
                }}
                placeholder="Review password"
                placeholderTextColor="#829AB1"
                secureTextEntry
                style={styles.reviewInput}
                testID="app-review-code"
                textContentType="password"
                value={reviewCode}
              />
              <Pressable
                accessibilityLabel="Sign in for app review"
                accessibilityRole="button"
                accessibilityState={{
                  busy,
                  disabled: busy || !reviewReady,
                }}
                disabled={busy || !reviewReady}
                onPress={() => {
                  void handleReviewSignIn();
                }}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && !busy && styles.buttonPressed,
                  (busy || !reviewReady) && styles.buttonDisabled,
                ]}
              >
                {isSigningIn && reviewAttempted ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : null}
                <Text style={styles.primaryButtonText}>
                  {isSigningIn && reviewAttempted
                    ? 'Signing in'
                    : 'Sign in for app review'}
                </Text>
              </Pressable>
              {reviewFailure ? (
                <View
                  accessibilityLiveRegion="assertive"
                  accessibilityRole="alert"
                  style={styles.attemptFailure}
                >
                  <Text style={styles.attemptFailureTitle}>
                    Review sign-in did not complete
                  </Text>
                  <Text style={styles.attemptFailureBody}>{visibleError}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
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
  reviewSection: {
    gap: 12,
  },
  reviewInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#9FB3C8',
    borderRadius: 12,
    borderWidth: 1,
    color: '#102A43',
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  privacyLinkText: {
    color: '#175A8E',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    textDecorationLine: 'underline',
  },
});
