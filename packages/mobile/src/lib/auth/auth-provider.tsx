import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import type {
  ConnectivityEpochId,
  DeviceEnrollmentId,
  MobileSessionResponse,
  NativeDevicePlatform,
  SessionId,
  UserId,
} from '@psd-eoc/contracts';
import { AppState, Platform } from 'react-native';

import {
  CLIENT_DIAGNOSTIC_PATH,
  ClientDiagnostics,
} from '../api/client-diagnostics';
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

import { AuthenticatedApiClient, type RequestAuthenticated } from '../api';
import { AuthApiClient, parseAuthApiBaseUrl } from './auth-api-client';
import {
  MobileAuthController,
  type AuthStorage,
  type AuthState,
} from './auth-controller';
import { MobileAuthError } from './auth-errors';
import { expoOidcBrowser, expoPkceSource } from './expo-oidc';
import {
  createIssue32SyntheticAuthenticator,
  isIssue32SyntheticAuthenticatorEnabled,
} from './issue-32-synthetic-authenticator';
import { createLocalAuthenticator } from './local-authenticator';
import { MobileOidcClient } from './oidc-client';
import { OidcRedirectNotCapturedError } from './oidc-client';
import { createSecurePendingOidcFlowStore } from './secure-pending-oidc-flow';
import { createSecureSessionStore } from './secure-session-store';
import {
  createIssue21SyntheticAuthFixture,
  createIssue21SyntheticFixtureTransport,
  isIssue21SyntheticFixtureEnabled,
} from '../start/issue-21-synthetic-fixture';

export interface MobileAuthContextValue {
  readonly state: AuthState;
  readonly hasCachedShell: boolean;
  readonly isSigningIn: boolean;
  readonly signInError: string | null;
  /**
   * The last attempt ended without the browser handing back a redirect, so a
   * code delivered to the deep-link route may still complete it.
   */
  readonly signInRedirectUncaptured: boolean;
  readonly beginGoogleSignIn: () => Promise<void>;
  /** Signs in the app-store review account with the code it was given. */
  readonly beginAppReviewSignIn: (email: string, code: string) => Promise<void>;
  /** Resumes an attempt whose redirect arrived outside `promptAsync`. */
  readonly completeGoogleSignIn: (
    authorizationCode: string,
    state: string,
  ) => Promise<void>;
  readonly unlock: () => Promise<void>;
  readonly retryConnection: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** Synchronous lifecycle observation for native work that React may suspend. */
  readonly subscribeState: (listener: () => void) => () => void;
  readonly isOnlineSession: (
    sessionId: SessionId,
    deviceEnrollmentId: DeviceEnrollmentId,
  ) => boolean;
  readonly requestAuthenticated: RequestAuthenticated;
  readonly assertMutationAllowed: () => Readonly<{
    connectivityEpochId: ConnectivityEpochId;
    userId: UserId;
    sessionId: SessionId;
    deviceEnrollmentId: DeviceEnrollmentId;
  }>;
}

interface AuthRuntime {
  readonly controller: MobileAuthController;
  readonly oidc: MobileOidcClient | null;
  readonly reviewApi: AuthApiClient | null;
  readonly storage: AuthStorage;
}

const MobileAuthContext = createContext<MobileAuthContextValue | null>(null);

function createRuntime(): AuthRuntime {
  if (isIssue21SyntheticFixtureEnabled()) {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
      throw new MobileAuthError(
        'configuration',
        'The issue-21 synthetic fixture requires an iOS or Android development build.',
      );
    }
    const fixture = createIssue21SyntheticAuthFixture(Platform.OS);
    return Object.freeze({
      controller: new MobileAuthController({
        api: fixture.api,
        authenticatedApi: createIssue21SyntheticFixtureTransport(Platform.OS),
        storage: fixture.storage,
        localAuthenticator: isIssue32SyntheticAuthenticatorEnabled()
          ? createIssue32SyntheticAuthenticator()
          : createLocalAuthenticator(),
        createIdempotencyKey: () => Crypto.randomUUID(),
      }),
      storage: fixture.storage,
      oidc: null,
      reviewApi: null,
    });
  }

  const storage = createSecureSessionStore();
  const baseUrl = () =>
    parseAuthApiBaseUrl(process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL, __DEV__);
  const api = new AuthApiClient(baseUrl);
  // Failures the server never receives are witnessed only here. Without this
  // the reporter exists but is never given to the client, and every failure is
  // still invisible -- which is exactly what happened on the first build that
  // shipped the reporting code.
  const diagnostics = new ClientDiagnostics(
    {
      async send(reports) {
        await fetch(`${baseUrl()}${CLIENT_DIAGNOSTIC_PATH}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
          body: JSON.stringify({ reports }),
          credentials: 'omit',
          cache: 'no-store',
        });
      },
    },
    () => ({
      applicationVersion: Application.nativeApplicationVersion,
      nativeBuildVersion: Application.nativeBuildVersion,
      platform: Platform.OS === 'android' ? 'android' : 'ios',
    }),
  );
  const controller = new MobileAuthController({
    api,
    authenticatedApi: new AuthenticatedApiClient(
      baseUrl,
      undefined,
      diagnostics,
    ),
    storage,
    localAuthenticator: createLocalAuthenticator(),
    createIdempotencyKey: () => Crypto.randomUUID(),
  });
  return Object.freeze({
    controller,
    storage,
    reviewApi: api,
    oidc: new MobileOidcClient(
      api,
      expoOidcBrowser,
      expoPkceSource,
      () => new Date(),
      createSecurePendingOidcFlowStore(),
    ),
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
  const [signInRedirectUncaptured, setSignInRedirectUncaptured] =
    useState(false);
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

  const runSignIn = useCallback(
    async (
      attempt: (
        oidc: MobileOidcClient,
        platform: NativeDevicePlatform,
      ) => Promise<MobileSessionResponse>,
    ) => {
      if (signingInRef.current) {
        return;
      }
      signingInRef.current = true;
      setIsSigningIn(true);
      setSignInError(null);
      setSignInRedirectUncaptured(false);
      try {
        if (runtime.oidc === null) {
          throw new MobileAuthError(
            'configuration',
            'Synthetic accessibility testing does not use Google sign-in. Restart the development build to restore its in-memory enrollment.',
          );
        }
        if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
          throw new MobileAuthError(
            'configuration',
            'Mobile Google sign-in requires an iOS or Android development build.',
          );
        }
        // Platform is narrowed by the guard above, so the attempt never has
        // to assert it.
        const payload = await attempt(runtime.oidc, Platform.OS);
        const enrolled = await runtime.controller.enroll(payload);
        if (!enrolled) {
          setSignInError(runtime.controller.getSnapshot().message);
        }
      } catch (error) {
        setSignInError(publicSignInError(error));
        setSignInRedirectUncaptured(
          error instanceof OidcRedirectNotCapturedError,
        );
      } finally {
        signingInRef.current = false;
        setIsSigningIn(false);
      }
    },
    [runtime],
  );

  const beginGoogleSignIn = useCallback(
    () =>
      runSignIn(async (oidc, platform) => {
        const installationId =
          await runtime.storage.getOrCreateInstallationId();
        return oidc.signIn(platform, installationId);
      }),
    [runSignIn, runtime],
  );

  const completeGoogleSignIn = useCallback(
    (authorizationCode: string, state: string) =>
      runSignIn((oidc) => oidc.completeSignIn(authorizationCode, state)),
    [runSignIn],
  );

  const beginAppReviewSignIn = useCallback(
    (email: string, code: string) =>
      runSignIn(async (_oidc, platform) => {
        if (runtime.reviewApi === null) {
          throw new MobileAuthError(
            'configuration',
            'App review sign-in is not available in this build.',
          );
        }
        const installationId =
          await runtime.storage.getOrCreateInstallationId();
        return runtime.reviewApi.appReviewSignIn({
          email: email.trim().toLowerCase(),
          code: code.trim(),
          platform,
          installationId,
        });
      }),
    [runSignIn, runtime],
  );

  const subscribeState = useCallback(
    (listener: () => void) => runtime.controller.subscribe(listener),
    [runtime],
  );
  const isOnlineSession = useCallback(
    (sessionId: SessionId, deviceEnrollmentId: DeviceEnrollmentId) => {
      try {
        const current = runtime.controller.assertMutationAllowed();
        return (
          current.sessionId === sessionId &&
          current.deviceEnrollmentId === deviceEnrollmentId
        );
      } catch {
        return false;
      }
    },
    [runtime],
  );

  const value = useMemo<MobileAuthContextValue>(
    () => ({
      state,
      hasCachedShell: shellAvailable(state),
      isSigningIn,
      signInError,
      signInRedirectUncaptured,
      beginGoogleSignIn,
      beginAppReviewSignIn,
      completeGoogleSignIn,
      unlock: () => runtime.controller.foreground(),
      retryConnection: () => runtime.controller.retryConnection(),
      subscribeState,
      isOnlineSession,
      requestAuthenticated: runtime.controller.requestAuthenticated,
      signOut: async () => {
        setSignInError(null);
        setSignInRedirectUncaptured(false);
        await runtime.controller.signOut();
      },
      assertMutationAllowed: () => runtime.controller.assertMutationAllowed(),
    }),
    [
      beginAppReviewSignIn,
      beginGoogleSignIn,
      completeGoogleSignIn,
      isOnlineSession,
      isSigningIn,
      runtime,
      signInError,
      signInRedirectUncaptured,
      state,
      subscribeState,
    ],
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
