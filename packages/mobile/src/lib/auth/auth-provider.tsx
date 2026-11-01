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
import { nativePasskeyPort } from './native-passkey-port';
import {
  enrollPartnerPasskey as enrollPasskeyWith,
  partnerPasskeyOfferFrom,
  signInPartnerWithPasskey,
  type PartnerPasskeyPort,
} from './partner-passkey-client';
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
   * Partner sign-in from one address: the passkey first, the emailed code as
   * the fallback.
   *
   * `signed-in` means a passkey answered and a session was enrolled.
   * `code-requested` means a code is on its way — which is the answer for a
   * device with no passkey support, a partner who dismissed the sheet, and an
   * address the pool holds no passkey for alike, because none of those may be
   * distinguishable to the person at the screen. `failed` means neither
   * happened and `signInError` says what to do (issue #647).
   */
  readonly beginPartnerSignIn: (
    email: string,
  ) => Promise<'signed-in' | 'code-requested' | 'failed'>;
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
  /**
   * The offer to add a passkey after an emailed-code sign-in.
   *
   * It is present only when the server handed this device a hand-off and the
   * device can run a ceremony, so the offer is never made where it could not
   * be accepted. Declining it changes nothing: the emailed code keeps
   * working, and the next code sign-in offers again (issue #647).
   */
  readonly partnerPasskeyOffer: Readonly<{
    offered: boolean;
    busy: boolean;
    error: string | null;
  }>;
  /** Runs the enrollment ceremony. False when nothing was enrolled. */
  readonly enrollPartnerPasskey: () => Promise<boolean>;
  /** Puts the offer away without enrolling anything. */
  readonly dismissPartnerPasskeyOffer: () => void;
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

const PARTNER_PASSKEY_SURFACE: SignInSurface = Object.freeze({
  fallbackMessage:
    'PSD EOC could not add a passkey to this device. Your emailed code still works.',
  unavailableMessage: 'Passkeys are not available in this build.',
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

/**
 * The platform authenticator the partner passkey paths use. Injectable so a
 * test can state a device that has one, has none, or dismisses the sheet,
 * without a phone in the room.
 */
export interface AuthProviderProps {
  readonly passkeyPort?: PartnerPasskeyPort;
}

export function AuthProvider({
  children,
  passkeyPort = nativePasskeyPort,
}: PropsWithChildren<AuthProviderProps>) {
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
  // The passkey enrollment hand-off, for as long as the offer is on screen.
  // Like the flow above it is opaque, it is never written to storage, and it
  // dies with the process: an abandoned offer should not wait on disk for a
  // hand-off that has already expired.
  const partnerEnrollmentRef = useRef<string | null>(null);
  const [partnerPasskeyOffered, setPartnerPasskeyOffered] = useState(false);
  const enrollingPasskeyRef = useRef(false);
  const [partnerPasskeyBusy, setPartnerPasskeyBusy] = useState(false);
  const [partnerPasskeyError, setPartnerPasskeyError] = useState<string | null>(
    null,
  );

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

  const beginPartnerSignIn = useCallback(
    async (
      email: string,
    ): Promise<'signed-in' | 'code-requested' | 'failed'> => {
      let outcome: 'signed-in' | 'code-requested' | 'failed' = 'failed';
      await runAttempt(
        PARTNER_SURFACE,
        async (live) => {
          const address = email.trim().toLowerCase();
          const installationId =
            await runtime.storage.getOrCreateInstallationId();
          const attempt = await signInPartnerWithPasskey({
            api: live.signInApi,
            port: passkeyPort,
            email: address,
            platform: live.platform,
            installationId,
          });
          if (attempt.kind === 'signed-in') {
            return Object.freeze({
              kind: 'signed-in' as const,
              session: attempt.session,
            });
          }
          // Every way a passkey did not happen ends here: the code is the
          // fallback and the only path that needs nothing of the device.
          return Object.freeze({
            kind: 'code-requested' as const,
            started: await live.signInApi.partnerSignInStart({
              email: address,
              platform: live.platform,
              installationId,
            }),
          });
        },
        async (result) => {
          if (result.kind === 'signed-in') {
            if (await runtime.controller.enroll(result.session)) {
              outcome = 'signed-in';
            } else {
              setSignInError(runtime.controller.getSnapshot().message);
            }
            return;
          }
          partnerFlowRef.current = result.started.flowToken;
          setPartnerCodeRequested(true);
          outcome = 'code-requested';
        },
        () => {
          partnerFlowRef.current = null;
          setPartnerCodeRequested(false);
        },
      );
      return outcome;
    },
    [passkeyPort, runAttempt, runtime],
  );

  const completePartnerSignIn = useCallback(
    (code: string) =>
      runAttempt(
        PARTNER_SURFACE,
        async (live) => {
          const flowToken = partnerFlowRef.current;
          if (flowToken === null) {
            throw new MobileAuthError(
              'rejected',
              'This sign-in request expired. Request a new code.',
            );
          }
          const verified = await live.signInApi.partnerSignInVerify({
            flowToken,
            code: code.trim(),
          });
          // The server has spent this flow. Whatever happens to the session
          // from here, the screen must come back on its first step rather
          // than ask again for a code that can no longer be answered. A
          // refused code throws above instead, leaving the flow to be
          // retyped.
          partnerFlowRef.current = null;
          setPartnerCodeRequested(false);
          return verified;
        },
        async (verified) => {
          const enrolled = await runtime.controller.enroll(verified.session);
          if (!enrolled) {
            setSignInError(runtime.controller.getSnapshot().message);
          }
          // The offer is resolved here, after the session has either taken
          // effect or not, and from this sign-in's own answer alone — which
          // is also what ends an offer the previous attempt left behind.
          const offer = partnerPasskeyOfferFrom({
            sessionEnrolled: enrolled,
            enrollmentToken: verified.passkeyEnrollmentToken,
            supported: passkeyPort.isSupported(),
          });
          partnerEnrollmentRef.current = offer;
          setPartnerPasskeyOffered(offer !== null);
          setPartnerPasskeyError(null);
        },
      ),
    [passkeyPort, runAttempt, runtime],
  );

  const resetPartnerSignIn = useCallback(() => {
    partnerFlowRef.current = null;
    setPartnerCodeRequested(false);
    setSignInError(null);
  }, []);

  const dismissPartnerPasskeyOffer = useCallback(() => {
    partnerEnrollmentRef.current = null;
    setPartnerPasskeyOffered(false);
    setPartnerPasskeyError(null);
  }, []);

  const enrollPartnerPasskey = useCallback(async (): Promise<boolean> => {
    // A ref, not the busy flag: React state settles after the render, and two
    // presses before that render would both read the one hand-off and start
    // two ceremonies. This is the same guard one sign-in attempt uses.
    if (enrollingPasskeyRef.current) {
      return false;
    }
    const enrollmentToken = partnerEnrollmentRef.current;
    const signInApi = runtime.signInApi;
    if (enrollmentToken === null || signInApi === null) {
      dismissPartnerPasskeyOffer();
      return false;
    }
    enrollingPasskeyRef.current = true;
    setPartnerPasskeyBusy(true);
    setPartnerPasskeyError(null);
    try {
      const enrolled = await enrollPasskeyWith({
        api: signInApi,
        port: passkeyPort,
        enrollmentToken,
      });
      // Whether it was enrolled or declined, this hand-off has been used for
      // the one ceremony it authorizes. The next code sign-in offers again.
      partnerEnrollmentRef.current = null;
      setPartnerPasskeyOffered(false);
      return enrolled;
    } catch (error) {
      // A failed enrollment is only a slower sign-in next time, so it is
      // reported where it happened and nowhere near the session. A refusal
      // also ends the offer, exactly as the browser clears its enrollment
      // cookie on one: the pool has decided about this hand-off, and leaving
      // a button that can only be refused again is worse than saying so
      // once. Anything else — an unreachable server, a pool that did not
      // answer — leaves the offer up to be tried again.
      setPartnerPasskeyError(publicSignInError(PARTNER_PASSKEY_SURFACE, error));
      if (error instanceof MobileAuthError && error.kind === 'rejected') {
        partnerEnrollmentRef.current = null;
        setPartnerPasskeyOffered(false);
      }
      return false;
    } finally {
      enrollingPasskeyRef.current = false;
      setPartnerPasskeyBusy(false);
    }
  }, [dismissPartnerPasskeyOffer, passkeyPort, runtime]);

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
      beginPartnerSignIn,
      completePartnerSignIn,
      partnerCodeRequested,
      resetPartnerSignIn,
      partnerPasskeyOffer: {
        offered: partnerPasskeyOffered,
        busy: partnerPasskeyBusy,
        error: partnerPasskeyError,
      },
      enrollPartnerPasskey,
      dismissPartnerPasskeyOffer,
      isPartnerSession: isPartnerSession(state.session),
      unlock: () => runtime.controller.foreground(),
      retryConnection: () => runtime.controller.retryConnection(),
      subscribeState,
      isOnlineSession,
      requestAuthenticated: runtime.controller.requestAuthenticated,
      signOut: async () => {
        // A sign-out leaves no half-finished partner attempt behind, so the
        // sign-in screen comes back on its first step rather than asking for
        // a code nobody requested, and no passkey offer outlives the session
        // that earned it.
        resetPartnerSignIn();
        dismissPartnerPasskeyOffer();
        setSignInRedirectUncaptured(false);
        await runtime.controller.signOut();
      },
      assertMutationAllowed: () => runtime.controller.assertMutationAllowed(),
    }),
    [
      beginAppReviewSignIn,
      beginGoogleSignIn,
      beginPartnerSignIn,
      completeGoogleSignIn,
      completePartnerSignIn,
      dismissPartnerPasskeyOffer,
      enrollPartnerPasskey,
      isOnlineSession,
      isSigningIn,
      partnerCodeRequested,
      partnerPasskeyBusy,
      partnerPasskeyError,
      partnerPasskeyOffered,
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
