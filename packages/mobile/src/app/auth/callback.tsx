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
 * Android delivers the OIDC redirect as an OS intent, and the app's own scheme
 * means the OS can route it here at the same moment `expo-web-browser` is
 * waiting for it. Both outcomes of that race have to end in a session:
 *
 * - The browser session captured it. `promptAsync` exchanges the code, a
 *   session exists, and this screen only has to get out of the way.
 * - The OS routed it here first. Dismissing the custom tab resolves
 *   `promptAsync` as cancelled, so the attempt reports that nothing was
 *   created — while the authorization code is sitting in this screen's params.
 *   Waiting for that attempt to finish and then spending the code is what
 *   makes the outcome the same either way.
 *
 * Only an attempt that never saw a redirect may be resumed from here. Any
 * other failure is the real answer and is shown as it stands, so a second
 * attempt can never overwrite it with a worse message.
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
  const {
    completeGoogleSignIn,
    hasCachedShell,
    isSigningIn,
    signInError,
    signInRedirectUncaptured,
  } = useMobileAuth();
  const router = useRouter();

  // Decided once, on mount. If a sign-in was already running when this screen
  // appeared, resuming straight away would race that attempt for a single-use
  // authorization code, so this screen waits for it to finish first.
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
    if (startedRef.current) {
      return;
    }
    if (ownedByPrompt) {
      // Still running: it may yet be the one that captured this redirect.
      if (isSigningIn) {
        return;
      }
      startedRef.current = true;
      if (hasCachedShell) {
        // It captured the redirect and enrolled the device.
        leave();
        return;
      }
      if (!signInRedirectUncaptured) {
        // It reached its own answer, so that answer stands.
        if (signInError === null) {
          leave();
          return;
        }
        setSettled(true);
        return;
      }
      // It ended without ever seeing a redirect. The code is here.
    } else {
      startedRef.current = true;
    }

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
    hasCachedShell,
    isSigningIn,
    leave,
    ownedByPrompt,
    params.code,
    params.error,
    params.state,
    signInError,
    signInRedirectUncaptured,
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
