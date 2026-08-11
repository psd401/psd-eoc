import * as Crypto from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';

import { AuthApiClient, parseAuthApiBaseUrl } from './auth-api-client';
import {
  createAuthenticatedRequestTransport,
  MobileAuthController,
  type AuthState,
  type MobileAuthenticatedRequest,
} from './auth-controller';
import { MobileAuthError } from './auth-errors';
import { expoOidcBrowser, expoPkceSource } from './expo-oidc';
import { createLocalAuthenticator } from './local-authenticator';
import { MobileOidcClient } from './oidc-client';
import { createSecureSessionStore } from './secure-session-store';
import {
  createIssue21SyntheticFixtureTransport,
  isIssue21SyntheticFixtureEnabled,
} from '../start/issue-21-synthetic-fixture';

export interface MobileAuthContextValue {
  readonly state: AuthState;
  readonly hasCachedShell: boolean;
  readonly isSigningIn: boolean;
  readonly signInError: string | null;
  readonly beginGoogleSignIn: () => Promise<void>;
  readonly unlock: () => Promise<void>;
  readonly retryConnection: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly authenticatedRequest: MobileAuthenticatedRequest;
  readonly assertMutationAllowed: () => Readonly<{
    connectivityEpochId: string;
  }>;
}

interface AuthRuntime {
  readonly controller: MobileAuthController;
  readonly oidc: MobileOidcClient;
  readonly storage: ReturnType<typeof createSecureSessionStore>;
}

const MobileAuthContext = createContext<MobileAuthContextValue | null>(null);

function createRuntime(): AuthRuntime {
  const storage = createSecureSessionStore();
  const apiOrigin = () =>
    parseAuthApiBaseUrl(process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL, __DEV__);
  const api = new AuthApiClient(apiOrigin);
  const controller = new MobileAuthController({
    api,
    authenticatedRequest: isIssue21SyntheticFixtureEnabled()
      ? createIssue21SyntheticFixtureTransport()
      : createAuthenticatedRequestTransport(apiOrigin),
    storage,
    localAuthenticator: createLocalAuthenticator(),
    createIdempotencyKey: () => Crypto.randomUUID(),
  });
  return Object.freeze({
    controller,
    storage,
    oidc: new MobileOidcClient(api, expoOidcBrowser, expoPkceSource),
  });
}

function shellAvailable(state: AuthState): boolean {
  return (
    state.phase === 'cached-checking' ||
    state.phase === 'offline-cached' ||
    state.phase === 'online'
  );
}

function publicSignInError(error: unknown): string {
  return error instanceof MobileAuthError
    ? error.message
    : 'PSD EOC could not complete Google sign-in. Try again or contact district technology support.';
}

export function AuthProvider({ children }: PropsWithChildren) {
  const runtimeRef = useRef<AuthRuntime | null>(null);
  runtimeRef.current ??= createRuntime();
  const runtime = runtimeRef.current;
  const state = useSyncExternalStore(
    runtime.controller.subscribe,
    runtime.controller.getSnapshot,
    runtime.controller.getSnapshot,
  );
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const signingInRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let wasBackgrounded = AppState.currentState === 'background';
    void runtime.controller.bootstrap().then(() => {
      if (mounted && AppState.currentState === 'active') {
        void runtime.controller.foreground();
      }
    });
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') {
        wasBackgrounded = true;
        runtime.controller.background();
      } else if (nextState === 'active' && wasBackgrounded) {
        wasBackgrounded = false;
        void runtime.controller.foreground();
      }
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [runtime]);

  const beginGoogleSignIn = useCallback(async () => {
    if (signingInRef.current) {
      return;
    }
    signingInRef.current = true;
    setIsSigningIn(true);
    setSignInError(null);
    try {
      if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
        throw new MobileAuthError(
          'configuration',
          'Mobile Google sign-in requires an iOS or Android development build.',
        );
      }
      const installationId = await runtime.storage.getOrCreateInstallationId();
      const payload = await runtime.oidc.signIn(Platform.OS, installationId);
      const enrolled = await runtime.controller.enroll(payload);
      if (!enrolled) {
        setSignInError(runtime.controller.getSnapshot().message);
      }
    } catch (error) {
      setSignInError(publicSignInError(error));
    } finally {
      signingInRef.current = false;
      setIsSigningIn(false);
    }
  }, [runtime]);

  const value = useMemo<MobileAuthContextValue>(
    () => ({
      state,
      hasCachedShell: shellAvailable(state),
      isSigningIn,
      signInError,
      beginGoogleSignIn,
      unlock: () => runtime.controller.foreground(),
      retryConnection: () => runtime.controller.retryConnection(),
      signOut: async () => {
        setSignInError(null);
        await runtime.controller.signOut();
      },
      authenticatedRequest: runtime.controller.authenticatedRequest,
      assertMutationAllowed: () => runtime.controller.assertMutationAllowed(),
    }),
    [beginGoogleSignIn, isSigningIn, runtime, signInError, state],
  );

  return (
    <MobileAuthContext.Provider value={value}>
      {children}
    </MobileAuthContext.Provider>
  );
}

export function useMobileAuth(): MobileAuthContextValue {
  const context = useContext(MobileAuthContext);
  if (context === null) {
    throw new Error('useMobileAuth must be used inside AuthProvider.');
  }
  return context;
}
