import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '../../lib/auth';

const MALFORMED_CALLBACK_MESSAGE =
  'Google did not return a usable sign-in result. No device session was created. Start sign-in again.';

const PROVIDER_REFUSED_MESSAGE =
  'Google refused the sign-in attempt. No device session was created. Start sign-in again.';

const UNKNOWN_FAILURE_MESSAGE =
  'PSD EOC could not complete Google sign-in. Try again or contact district technology support.';

/** Repeated query parameters are a malformed callback, not a value to guess at. */
function singleParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Landing screen for `psdeoc://auth/callback`.
 *
 * Android delivers the OIDC redirect as an OS intent. When `promptAsync` is
 * still listening it resolves the redirect in-process and this screen only has
 * to say so and get out of the way. When it is not — the app was cold-started
 * by the redirect, or the custom tab was handed off after a restart — the
 * authorization code would otherwise land on Expo Router's Unmatched Route and
 * be discarded. Here it is handed to the resume path instead.
 *
 * iOS never reaches this screen in the normal flow, because
 * `ASWebAuthenticationSession` captures the redirect before the router sees it.
 */
export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{
    code?: string | string[];
    error?: string | string[];
    state?: string | string[];
  }>();
  const { completeGoogleSignIn, hasCachedShell, isSigningIn, signInError } =
    useMobileAuth();
  const router = useRouter();

  // Decided once, on mount. If a sign-in was already running when this screen
  // appeared, that attempt owns the redirect and resuming would race it for a
  // single-use authorization code.
  const ownedByPromptRef = useRef<boolean | null>(null);
  ownedByPromptRef.current ??= isSigningIn;
  const ownedByPrompt = ownedByPromptRef.current;

  const startedRef = useRef(false);
  const [settled, setSettled] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const leave = useCallback(() => {
    // The route guards in the root layout decide where this lands: the
    // authenticated home once enrollment succeeded, the sign-in screen if not.
    router.replace('/');
  }, [router]);

  useEffect(() => {
    if (ownedByPrompt) {
      // Nothing to do but wait for the in-flight attempt to resolve.
      if (!isSigningIn) {
        leave();
      }
      return;
    }
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    const code = singleParam(params.code);
    const state = singleParam(params.state);
    const providerError = singleParam(params.error);

    if (providerError !== null) {
      setLocalError(PROVIDER_REFUSED_MESSAGE);
      setSettled(true);
      return;
    }
    if (code === null || state === null) {
      setLocalError(MALFORMED_CALLBACK_MESSAGE);
      setSettled(true);
      return;
    }

    void completeGoogleSignIn(code, state).finally(() => {
      setSettled(true);
    });
  }, [
    completeGoogleSignIn,
    isSigningIn,
    leave,
    ownedByPrompt,
    params.code,
    params.error,
    params.state,
  ]);

  // A resume that enrolled the device leaves immediately; there is nothing on
  // this screen worth showing once there is a session.
  useEffect(() => {
    if (settled && localError === null && hasCachedShell) {
      leave();
    }
  }, [hasCachedShell, leave, localError, settled]);

  const failure = settled
    ? (localError ??
      (hasCachedShell ? null : (signInError ?? UNKNOWN_FAILURE_MESSAGE)))
    : null;

  if (failure !== null) {
    return (
      <SafeAreaView style={styles.page}>
        <View style={styles.content}>
          <View
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.errorNotice}
          >
            <Text accessibilityRole="header" style={styles.errorTitle}>
              Sign-in did not complete
            </Text>
            <Text style={styles.errorBody}>{failure}</Text>
          </View>
          <Pressable
            accessibilityHint="Returns to the PSD EOC sign-in screen"
            accessibilityLabel="Return to sign-in"
            accessibilityRole="button"
            onPress={leave}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Return to sign-in</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <View
        accessibilityLiveRegion="polite"
        accessibilityRole="progressbar"
        style={styles.content}
      >
        <ActivityIndicator color="#175A8E" size="large" />
        <Text accessibilityRole="header" style={styles.title}>
          Completing sign-in
        </Text>
        <Text style={styles.body}>
          PSD EOC is finishing secure enrollment for this device. This takes a
          moment.
        </Text>
      </View>
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
    gap: 16,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#102A43',
    fontSize: 26,
    fontWeight: '900',
    lineHeight: 33,
    textAlign: 'center',
  },
  body: {
    color: '#486581',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  errorNotice: {
    backgroundColor: '#FFF1F0',
    borderColor: '#C0352B',
    borderRadius: 14,
    borderWidth: 2,
    gap: 6,
    padding: 16,
  },
  errorTitle: {
    color: '#7A1E17',
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 24,
  },
  errorBody: {
    color: '#7A1E17',
    fontSize: 15,
    lineHeight: 22,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#175A8E',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  buttonPressed: {
    opacity: 0.76,
  },
});
