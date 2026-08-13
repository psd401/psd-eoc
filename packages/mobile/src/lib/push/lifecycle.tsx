import {
  PushTokenRegistrationReceiptSchema,
  PushTokenUnregistrationReceiptSchema,
  type RegisterPushTokenInput,
  type UnregisterPushTokenInput,
} from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';

import { useMobileAuth } from '../auth';
import {
  configureForegroundPushHandling,
  currentNativePushPlatform,
  currentPushRegistrationConfiguration,
  expoPushNativePort,
  expoPushResponsePort,
  normalizePushResponse,
} from './native-port';
import {
  authChangeRouteReadiness,
  committedAuthRouteReadiness,
  decidePushAppStateReadiness,
  shouldFencePushRegistration,
} from './app-state-readiness';
import {
  PushRegistrationController,
  type PushRegistrationSession,
} from './registration-controller';
import { PushNotificationNotice } from './permission-notice';
import { PushResponseController } from './response-controller';

// Register before React effects so a foreground notification cannot race app
// startup and fall back to ambiguous platform-default presentation behavior.
configureForegroundPushHandling();

/** Mounts permission, registration, token-refresh, and deep-link lifecycles. */
export function PushNotificationLifecycle() {
  const auth = useMobileAuth();
  const router = useRouter();
  const registrationRef = useRef<PushRegistrationController | null>(null);
  registrationRef.current ??= new PushRegistrationController({
    configuration: currentPushRegistrationConfiguration(),
    native: expoPushNativePort,
  });
  const registration = registrationRef.current;
  const snapshot = useSyncExternalStore(
    registration.subscribe,
    registration.getSnapshot,
    registration.getSnapshot,
  );
  // This ref represents committed layout readiness, not speculative render
  // state. It starts closed and changes only in the synchronous auth fence or
  // the layout effect after Stack.Protected has committed.
  const protectedShellReadyRef = useRef(false);
  const responseRef = useRef<PushResponseController | null>(null);
  responseRef.current ??= new PushResponseController(
    (payload) => {
      router.push({
        pathname: '/events/[id]',
        params: { id: payload.eventId },
      });
    },
    () => {
      // Keep killed-launch evidence recoverable until every accepted
      // pre-unlock tap has actually navigated.
      void expoPushResponsePort.clearLast().catch(() => undefined);
    },
    () => protectedShellReadyRef.current && AppState.currentState === 'active',
  );
  const responses = responseRef.current;

  useEffect(() => {
    void registration.start();
    return () => registration.stop();
  }, [registration]);

  useEffect(
    () =>
      auth.subscribeState(() => {
        // AuthController publishes synchronously. Fence native/provider work
        // here instead of waiting for a React render or effect cleanup.
        registration.fenceInactiveSession();
        // The rendered hasCachedShell ref may still be stale until React
        // commits. Close response routing immediately on every auth change;
        // the layout effect reopens it only from the committed protected shell.
        const closed = authChangeRouteReadiness();
        protectedShellReadyRef.current = closed;
        responses.setRouteReady(closed);
      }),
    [auth.subscribeState, registration, responses],
  );

  useEffect(() => {
    const platform = currentNativePushPlatform();
    const session = auth.state.session;
    if (auth.state.phase === 'offline-cached' && session !== null) {
      registration.suspendSession();
      return;
    }
    if (
      auth.state.phase !== 'online' ||
      session === null ||
      platform === null
    ) {
      registration.clearSession();
      return;
    }
    const binding: PushRegistrationSession = Object.freeze({
      deviceEnrollmentId: session.deviceEnrollment.id,
      platform,
      isActive: () =>
        auth.isOnlineSession(session.session.id, session.deviceEnrollment.id),
      register: (input: RegisterPushTokenInput) =>
        auth.requestAuthenticated({
          method: 'POST',
          path: '/api/devices/push-token',
          body: input,
          idempotencyKey: Crypto.randomUUID(),
          schema: PushTokenRegistrationReceiptSchema,
        }),
      unregister: (input: UnregisterPushTokenInput) =>
        auth.requestAuthenticated({
          method: 'POST',
          path: '/api/devices/push-token/unregister',
          body: input,
          idempotencyKey: Crypto.randomUUID(),
          schema: PushTokenUnregistrationReceiptSchema,
        }),
    });
    void registration.reconcile(binding);
    // Effect cleanup runs before the next auth phase is visible here. Suspend
    // first so an offline-cached transition can retain denied instructions and
    // cleanup uncertainty; the next effect clears fully for sign-out states.
    return () => registration.suspendSession();
  }, [
    auth.requestAuthenticated,
    auth.isOnlineSession,
    auth.state.phase,
    auth.state.session?.deviceEnrollment.id,
    auth.state.session?.session.id,
    registration,
  ]);

  useLayoutEffect(() => {
    const ready = committedAuthRouteReadiness(
      auth.hasCachedShell,
      AppState.currentState,
    );
    protectedShellReadyRef.current = ready;
    responses.setRouteReady(ready);
    // AuthController creates a new immutable state object for every
    // publication. Depending on that committed revision is intentional:
    // cached-checking -> online -> offline-cached all keep hasCachedShell true,
    // but each synchronous publication closed routing before this commit.
  }, [auth.hasCachedShell, auth.state, responses]);

  useEffect(() => {
    let backgrounded = AppState.currentState === 'background';
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (shouldFencePushRegistration(nextState)) {
        // React may be suspended immediately after this callback. Abort token
        // acquisition before any state-derived effect cleanup is required.
        registration.suspendSession();
      }
      const decision = decidePushAppStateReadiness(
        backgrounded,
        nextState,
        protectedShellReadyRef.current,
      );
      backgrounded = decision.backgrounded;
      // Close in the native lifecycle callback itself. React may be suspended
      // before a state-derived effect can run after backgrounding. A null
      // decision intentionally waits for a fresh authenticated layout commit.
      if (decision.routeReady !== null) {
        responses.setRouteReady(decision.routeReady);
      }
    });
    return () => subscription.remove();
  }, [registration, responses]);

  useEffect(() => {
    let mounted = true;
    const handle = (response: Parameters<typeof normalizePushResponse>[0]) => {
      responses.receive(normalizePushResponse(response));
    };
    // Listener first: a tap arriving while killed-state evidence is read still
    // enters the same bounded dedupe path.
    const subscription = expoPushResponsePort.addListener(handle);
    void expoPushResponsePort
      .getLast()
      .then((response) => {
        if (mounted && response !== null) handle(response);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [responses]);

  return (
    <PushNotificationNotice
      onOpenSettings={() => {
        void registration.openSettings();
      }}
      onRequestPermission={() => {
        void registration.requestPermission();
      }}
      onRetry={() => {
        void registration.retry();
      }}
      snapshot={snapshot}
    />
  );
}
