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
  type LocalAuthenticator,
} from './auth-controller';
import { MobileAuthError } from './auth-errors';
import { expoOidcBrowser, expoPkceSource } from './expo-oidc';
import {
  createSyntheticSimulatorAuthenticator,
  isSyntheticSimulatorAuthenticatorEnabled,
} from './synthetic-simulator-authenticator';
import { createLocalAuthenticator } from './local-authenticator';
import { MobileOidcClient } from './oidc-client';
import { isPartnerSession } from './partner-session';
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
  /**
   * Partner sign-in, first step: ask the partner pool to email a code to one
   * address. True means a code was requested, which the server answers the
   * same way for every address; it is never a statement that the address
   * holds partner access.
   */
  readonly requestPartnerCode: (email: string) => Promise<boolean>;
  /** Partner sign-in, second step: answer the outstanding flow with its code. */
  readonly completePartnerSignIn: (code: string) => Promise<void>;
  /** True while one partner code request is outstanding and still usable. */
  readonly partnerCodeRequested: boolean;
  /**
   * True when the signed-in person holds a partner admission rather than
   * district staff access. Partners read, join and post; they never start or
   * end an event, and the server refuses those capabilities whatever the
   * screen offers, so this only keeps the app from offering them.
   */
  readonly isPartnerSession: boolean;
  /** Abandons the outstanding partner flow and returns to the address step. */
  readonly resetPartnerSignIn: () => void;
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
  readonly signInApi: AuthApiClient | null;
  readonly storage: AuthStorage;
}

const MobileAuthContext = createContext<MobileAuthContextValue | null>(null);

/**
 * The device owner's unlock, or the simulator stand-in one of the end-to-end
 * journeys qualifies for. Every build anyone installs takes the first branch,
 * because the stand-in's own gate refuses a release build and any origin but
 * this machine's loopback.
 */
function localAuthenticator(): LocalAuthenticator {
  return isSyntheticSimulatorAuthenticatorEnabled()
    ? createSyntheticSimulatorAuthenticator()
    : createLocalAuthenticator();
}

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
        localAuthenticator: localAuthenticator(),
        createIdempotencyKey: () => Crypto.randomUUID(),
      }),
      storage: fixture.storage,
      oidc: null,
      signInApi: null,
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
    localAuthenticator: localAuthenticator(),
    createIdempotencyKey: () => Crypto.randomUUID(),
  });
  return Object.freeze({
    controller,
    storage,
    signInApi: api,
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

/**
 * What one sign-in surface says when something it did not anticipate goes
 * wrong, and when this build has no live authentication runtime at all. Each
 * surface names itself, so a partner is never told that Google sign-in
 * failed and a staff member is never told about partner agencies.
 */
interface SignInSurface {
  readonly fallbackMessage: string;
  readonly unavailableMessage: string;
}

const GOOGLE_SURFACE: SignInSurface = Object.freeze({
  fallbackMessage:
    'PSD EOC could not complete Google sign-in. Try again or contact district technology support.',
  unavailableMessage:
    'Synthetic accessibility testing does not use Google sign-in. Restart the development build to restore its in-memory enrollment.',
});

const APP_REVIEW_SURFACE: SignInSurface = Object.freeze({
  fallbackMessage:
    'PSD EOC could not complete review sign-in. Try again or contact district technology support.',
  unavailableMessage: 'App review sign-in is not available in this build.',
});

const PARTNER_SURFACE: SignInSurface = Object.freeze({
  fallbackMessage:
    'PSD EOC could not complete partner agency sign-in. Try again or contact district technology support.',
  unavailableMessage: 'Partner agency sign-in is not available in this build.',
});

function publicSignInError(surface: SignInSurface, error: unknown): string {
  return error instanceof MobileAuthError
    ? error.message
    : surface.fallbackMessage;
}

/** The live authentication runtime, present together or not at all. */
interface LiveAuthRuntime {
  readonly oidc: MobileOidcClient;
  readonly signInApi: AuthApiClient;
  readonly platform: NativeDevicePlatform;
}

function resolveLiveRuntime(
  runtime: AuthRuntime,
  surface: SignInSurface,
): LiveAuthRuntime {
  if (runtime.oidc === null || runtime.signInApi === null) {
    throw new MobileAuthError('configuration', surface.unavailableMessage);
  }
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new MobileAuthError(
      'configuration',
      'PSD EOC sign-in requires an iOS or Android build.',
    );
  }
  return Object.freeze({
    oidc: runtime.oidc,
    signInApi: runtime.signInApi,
    platform: Platform.OS,
  });
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
  // The sealed partner flow stays in memory for the few minutes it is usable.
  // It is opaque, it is not a credential, and it is deliberately not written
  // to storage: an abandoned attempt should die with the process rather than
  // wait on disk for a code that has already expired.
  const partnerFlowRef = useRef<string | null>(null);
  const [partnerCodeRequested, setPartnerCodeRequested] = useState(false);

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

  /**
   * Runs one sign-in attempt. Only one may be in flight at a time, and
   * whatever it does to the screen — the busy flag and the one visible
   * message — belongs to this wrapper, not to the surfaces, so every surface
   * behaves the same whether it enrolls a session or only asks for a code.
   */
  const runAttempt = useCallback(
    async <Result,>(
      surface: SignInSurface,
      attempt: (live: LiveAuthRuntime) => Promise<Result>,
      onSuccess: (result: Result) => void | Promise<void>,
      onFailure: () => void = () => {},
    ): Promise<void> => {
      if (signingInRef.current) {
        return;
      }
      signingInRef.current = true;
      setIsSigningIn(true);
      setSignInError(null);
      setSignInRedirectUncaptured(false);
      try {
        await onSuccess(await attempt(resolveLiveRuntime(runtime, surface)));
      } catch (error) {
        onFailure();
        setSignInError(publicSignInError(surface, error));
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

  const runSignIn = useCallback(
    (
      surface: SignInSurface,
      attempt: (live: LiveAuthRuntime) => Promise<MobileSessionResponse>,
    ) =>
      runAttempt(surface, attempt, async (payload) => {
        const enrolled = await runtime.controller.enroll(payload);
        if (!enrolled) {
          setSignInError(runtime.controller.getSnapshot().message);
        }
      }),
    [runAttempt, runtime],
  );

  const beginGoogleSignIn = useCallback(
    () =>
      runSignIn(GOOGLE_SURFACE, async (live) => {
        const installationId =
          await runtime.storage.getOrCreateInstallationId();
        return live.oidc.signIn(live.platform, installationId);
      }),
    [runSignIn, runtime],
  );

  const completeGoogleSignIn = useCallback(
    (authorizationCode: string, state: string) =>
      runSignIn(GOOGLE_SURFACE, (live) =>
        live.oidc.completeSignIn(authorizationCode, state),
      ),
    [runSignIn],
  );

  const beginAppReviewSignIn = useCallback(
    (email: string, code: string) =>
      runSignIn(APP_REVIEW_SURFACE, async (live) => {
        const installationId =
          await runtime.storage.getOrCreateInstallationId();
        return live.signInApi.appReviewSignIn({
          email: email.trim().toLowerCase(),
          code: code.trim(),
          platform: live.platform,
          installationId,
        });
      }),
    [runSignIn, runtime],
  );

  const requestPartnerCode = useCallback(
    async (email: string): Promise<boolean> => {
      let requested = false;
      await runAttempt(
        PARTNER_SURFACE,
        async (live) => {
          const installationId =
            await runtime.storage.getOrCreateInstallationId();
          return live.signInApi.partnerSignInStart({
            email: email.trim().toLowerCase(),
            platform: live.platform,
            installationId,
          });
        },
        (started) => {
          partnerFlowRef.current = started.flowToken;
          setPartnerCodeRequested(true);
          requested = true;
        },
        () => {
          partnerFlowRef.current = null;
          setPartnerCodeRequested(false);
        },
      );
      return requested;
    },
    [runAttempt, runtime],
  );

  const completePartnerSignIn = useCallback(
    (code: string) =>
      runSignIn(PARTNER_SURFACE, async (live) => {
        const flowToken = partnerFlowRef.current;
        if (flowToken === null) {
          throw new MobileAuthError(
            'rejected',
            'This sign-in request expired. Request a new code.',
          );
        }
        const payload = await live.signInApi.partnerSignInVerify({
          flowToken,
          code: code.trim(),
        });
        // The server has spent this flow. Whatever happens to the session
        // from here, the screen must come back on its first step rather than
        // ask again for a code that can no longer be answered. A refused code
        // throws above instead, leaving the flow to be retyped.
        partnerFlowRef.current = null;
        setPartnerCodeRequested(false);
        return payload;
      }),
    [runSignIn],
  );

  const resetPartnerSignIn = useCallback(() => {
    partnerFlowRef.current = null;
    setPartnerCodeRequested(false);
    setSignInError(null);
  }, []);

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
      requestPartnerCode,
      completePartnerSignIn,
      partnerCodeRequested,
      resetPartnerSignIn,
      isPartnerSession: isPartnerSession(state.session),
      unlock: () => runtime.controller.foreground(),
      retryConnection: () => runtime.controller.retryConnection(),
      subscribeState,
      isOnlineSession,
      requestAuthenticated: runtime.controller.requestAuthenticated,
      signOut: async () => {
        // A sign-out leaves no half-finished partner attempt behind, so the
        // sign-in screen comes back on its first step rather than asking for
        // a code nobody requested.
        resetPartnerSignIn();
        setSignInRedirectUncaptured(false);
        await runtime.controller.signOut();
      },
      assertMutationAllowed: () => runtime.controller.assertMutationAllowed(),
    }),
    [
      beginAppReviewSignIn,
      beginGoogleSignIn,
      completeGoogleSignIn,
      completePartnerSignIn,
      isOnlineSession,
      isSigningIn,
      partnerCodeRequested,
      requestPartnerCode,
      resetPartnerSignIn,
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
