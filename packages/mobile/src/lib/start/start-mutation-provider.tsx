import type {
  ActivationPreview,
  JoinEventResult,
  StartEventResult,
} from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';

import {
  useMobileAuth,
  type MobileAuthContextValue,
} from '../auth/auth-provider';
import { activate, join, type StartHomeActiveEvent } from './start-api-client';
import {
  createStartMutationCoordinator,
  createStartMutationActivationEvidence,
  type StartMutationAdmission,
  type StartMutationCompletion,
  type StartMutationCoordinator,
  type StartMutationOwner,
  type StartMutationPersistence,
  type StartMutationSnapshot,
} from './start-mutation-coordinator';
import { isIssue21SyntheticFixtureEnabled } from './issue-21-synthetic-fixture';
import { createStartMutationStore } from './start-mutation-store';

export interface SubmitStartActivationInput {
  readonly preview: ActivationPreview;
  readonly eventTypeName: string;
}

export interface SubmitStartJoinInput {
  readonly choice: StartHomeActiveEvent;
}

export interface StartMutationContextValue {
  readonly snapshot: StartMutationSnapshot;
  readonly isPendingNow: () => boolean;
  readonly submitActivation: (
    input: SubmitStartActivationInput,
  ) => StartMutationAdmission;
  readonly submitJoin: (input: SubmitStartJoinInput) => StartMutationAdmission;
  readonly acknowledge: () => boolean;
  readonly acknowledgeUnresolved: () => boolean;
  readonly claimSuccessFeedback: () => StartMutationCompletion | null;
}

export interface StartMutationSuccessFeedbackSinks {
  readonly announce: (completion: StartMutationCompletion) => void;
  readonly haptic: () => Promise<void> | void;
}

/** Delivers both success signals only when the app-lifetime claim succeeds. */
export function deliverClaimedStartMutationSuccessFeedback(
  claim: () => StartMutationCompletion | null,
  sinks: StartMutationSuccessFeedbackSinks,
): boolean {
  const completion = claim();
  if (completion === null) return false;

  try {
    sinks.announce(completion);
  } catch {
    // Accessibility feedback failure must not prevent the independent haptic.
  }
  try {
    void Promise.resolve(sinks.haptic()).catch(() => undefined);
  } catch {
    // Native haptic failure must not change the retained success state.
  }
  return true;
}

type StartMutationAuth = Pick<
  MobileAuthContextValue,
  'assertMutationAllowed' | 'requestAuthenticated' | 'state'
>;

export interface StartMutationProviderControllerDependencies {
  readonly coordinator?: StartMutationCoordinator;
  readonly createIdempotencyKey?: () => string;
  readonly activate?: typeof activate;
  readonly join?: typeof join;
}

const REJECTED_ADMISSION: StartMutationAdmission = Object.freeze({
  accepted: false,
});
const CHECKING_RECOVERY_SNAPSHOT: StartMutationSnapshot = Object.freeze({
  phase: 'checking-recovery',
});

function createRuntimeStartMutationPersistence(): StartMutationPersistence {
  if (!isIssue21SyntheticFixtureEnabled()) return createStartMutationStore();

  // The synthetic native journey has no device state to recover. Keep its
  // recovery journal in this JavaScript process so simulator SecureStore
  // behavior cannot block the provider-free fixture, while every ordinary
  // runtime continues to use the device-protected store above.
  let value: string | null = null;
  return createStartMutationStore({
    getItem: () => value,
    setItem: (_key, nextValue) => {
      value = nextValue;
    },
  });
}

function ownerFromAuth(auth: StartMutationAuth): StartMutationOwner | null {
  const established = auth.state.session;
  if (established === null) return null;
  return Object.freeze({
    userId: established.user.id,
    sessionId: established.session.id,
    deviceEnrollmentId: established.deviceEnrollment.id,
  });
}

function authReconciliationKey(auth: StartMutationAuth): string {
  const session = auth.state.session;
  return [
    auth.state.phase,
    session?.user.id ?? 'no-user',
    session?.session.id ?? 'no-session',
    session?.deviceEnrollment.id ?? 'no-device',
    auth.state.connectivityEpochId ?? 'no-connectivity-epoch',
  ].join(':');
}

/**
 * App-lifetime adapter between authentication, the validated start client,
 * and the mutation coordinator. It admits work synchronously and deliberately
 * contains no retry or offline queue.
 */
export class StartMutationProviderController {
  private readonly coordinator: StartMutationCoordinator;
  private readonly createIdempotencyKey: () => string;
  private readonly runActivation: typeof activate;
  private readonly runJoin: typeof join;
  private auth: StartMutationAuth | null = null;
  private hydrated = false;

  public constructor(
    dependencies: StartMutationProviderControllerDependencies = {},
  ) {
    this.coordinator =
      dependencies.coordinator ??
      createStartMutationCoordinator(createRuntimeStartMutationPersistence());
    this.createIdempotencyKey =
      dependencies.createIdempotencyKey ?? (() => Crypto.randomUUID());
    this.runActivation = dependencies.activate ?? activate;
    this.runJoin = dependencies.join ?? join;
  }

  public getSnapshot = (): StartMutationSnapshot =>
    this.coordinator.getSnapshot();

  public subscribe = (listener: () => void): (() => void) =>
    this.coordinator.subscribe(listener);

  /** Must run before a render reads the external-store snapshot. */
  public reconcile(auth: StartMutationAuth, notify = true): void {
    this.auth = auth;
    const observation = {
      phase: auth.state.phase,
      owner: ownerFromAuth(auth),
    } as const;
    this.coordinator.reconcile(observation, notify);
    if (!this.hydrated && auth.state.phase === 'online') {
      this.hydrated = true;
      this.coordinator.hydrate(notify);
      // Hydration can restore a terminal record owned by an older session.
      // Reconcile once more so known terminal data is cleared before paint.
      this.coordinator.reconcile(observation, notify);
    }
  }

  public isPendingNow = (): boolean =>
    this.coordinator.getSnapshot().phase === 'pending';

  private onlineIdleOwner(): StartMutationOwner | null {
    const auth = this.auth;
    if (
      auth === null ||
      auth.state.phase !== 'online' ||
      auth.state.session === null ||
      this.coordinator.getSnapshot().phase !== 'idle'
    ) {
      return null;
    }

    return ownerFromAuth(auth);
  }

  private assertAdmissionOrReport(
    owner: StartMutationOwner,
    display: Readonly<{
      operation: 'activate' | 'join';
      eventKind: ActivationPreview['kind'];
      eventTypeName: string;
      mode: ActivationPreview['templateMode'];
    }>,
  ): boolean {
    const auth = this.auth;
    if (auth === null) return false;
    try {
      const live = auth.assertMutationAllowed();
      return (
        live.userId === owner.userId &&
        live.sessionId === owner.sessionId &&
        live.deviceEnrollmentId === owner.deviceEnrollmentId
      );
    } catch (error) {
      this.coordinator.reportDeniedSubmission(owner, display, error);
      return false;
    }
  }

  private exactLiveOwner(): StartMutationOwner | null {
    const auth = this.auth;
    const owner = auth === null ? null : ownerFromAuth(auth);
    if (auth === null || owner === null || auth.state.phase !== 'online') {
      return null;
    }
    try {
      const live = auth.assertMutationAllowed();
      return live.userId === owner.userId &&
        live.sessionId === owner.sessionId &&
        live.deviceEnrollmentId === owner.deviceEnrollmentId
        ? owner
        : null;
    } catch {
      return null;
    }
  }

  public submitActivation = (
    input: SubmitStartActivationInput,
  ): StartMutationAdmission => {
    const auth = this.auth;
    const owner = this.onlineIdleOwner();
    if (auth === null || owner === null) return REJECTED_ADMISSION;
    if (
      !this.assertAdmissionOrReport(owner, {
        operation: 'activate',
        eventKind: input.preview.kind,
        eventTypeName: input.eventTypeName,
        mode: input.preview.templateMode,
      })
    ) {
      return REJECTED_ADMISSION;
    }

    // No await may occur between the idle check above and coordinator.submit.
    // That makes this UUID belong to exactly this synchronously admitted tap.
    const idempotencyKey = this.createIdempotencyKey();
    const request = auth.requestAuthenticated;
    return this.coordinator.submit({
      operation: 'activate',
      owner,
      eventKind: input.preview.kind,
      eventTypeName: input.eventTypeName,
      mode: input.preview.templateMode,
      idempotencyKey,
      activationEvidence: createStartMutationActivationEvidence(input.preview),
      run: (): Promise<StartEventResult> =>
        this.runActivation(request, input.preview, idempotencyKey),
    });
  };

  public submitJoin = (input: SubmitStartJoinInput): StartMutationAdmission => {
    const auth = this.auth;
    const owner = this.onlineIdleOwner();
    if (auth === null || owner === null) return REJECTED_ADMISSION;
    if (
      !this.assertAdmissionOrReport(owner, {
        operation: 'join',
        eventKind: input.choice.event.kind,
        eventTypeName: input.choice.eventTypeName,
        mode: input.choice.event.templateMode,
      })
    ) {
      return REJECTED_ADMISSION;
    }

    const idempotencyKey = this.createIdempotencyKey();
    const request = auth.requestAuthenticated;
    return this.coordinator.submit({
      operation: 'join',
      owner,
      eventId: input.choice.event.id,
      eventKind: input.choice.event.kind,
      eventTypeName: input.choice.eventTypeName,
      mode: input.choice.event.templateMode,
      idempotencyKey,
      run: (): Promise<JoinEventResult> =>
        this.runJoin(request, input.choice.event, idempotencyKey),
    });
  };

  public acknowledge = (): boolean => {
    const owner = this.exactLiveOwner();
    return owner === null ? false : this.coordinator.acknowledge(owner);
  };

  public acknowledgeUnresolved = (): boolean => {
    const owner = this.exactLiveOwner();
    return owner === null
      ? false
      : this.coordinator.acknowledgeUnresolved(owner);
  };

  public claimSuccessFeedback = (): StartMutationCompletion | null => {
    const owner = this.exactLiveOwner();
    return owner === null ? null : this.coordinator.claimSuccessFeedback(owner);
  };
}

export function createStartMutationProviderController(
  dependencies: StartMutationProviderControllerDependencies = {},
): StartMutationProviderController {
  return new StartMutationProviderController(dependencies);
}

const StartMutationContext = createContext<StartMutationContextValue | null>(
  null,
);

export function StartMutationProvider({ children }: PropsWithChildren) {
  const auth = useMobileAuth();
  const controllerRef = useRef<StartMutationProviderController | null>(null);
  controllerRef.current ??= createStartMutationProviderController();
  const controller = controllerRef.current;
  const authKey = authReconciliationKey(auth);
  const [reconciledAuthKey, setReconciledAuthKey] = useState<string | null>(
    null,
  );
  const retainedSnapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  // SecureStore reads and retained-truth reconciliation belong to React's
  // commit phase. Until that exact auth observation is committed, descendants
  // receive only a neutral fail-closed snapshot and no mutation callback can
  // be admitted from the rendered tree.
  useLayoutEffect(() => {
    controller.reconcile(auth);
    setReconciledAuthKey(authKey);
  }, [auth, authKey, controller]);

  const snapshot =
    reconciledAuthKey === authKey
      ? retainedSnapshot
      : CHECKING_RECOVERY_SNAPSHOT;
  const value = useMemo<StartMutationContextValue>(
    () => ({
      snapshot,
      isPendingNow: () =>
        snapshot.phase === 'checking-recovery' || controller.isPendingNow(),
      submitActivation: (input) =>
        snapshot.phase === 'checking-recovery'
          ? REJECTED_ADMISSION
          : controller.submitActivation(input),
      submitJoin: (input) =>
        snapshot.phase === 'checking-recovery'
          ? REJECTED_ADMISSION
          : controller.submitJoin(input),
      acknowledge: () =>
        snapshot.phase !== 'checking-recovery' && controller.acknowledge(),
      acknowledgeUnresolved: () =>
        snapshot.phase !== 'checking-recovery' &&
        controller.acknowledgeUnresolved(),
      claimSuccessFeedback: () =>
        snapshot.phase === 'checking-recovery'
          ? null
          : controller.claimSuccessFeedback(),
    }),
    [controller, snapshot],
  );

  return (
    <StartMutationContext.Provider value={value}>
      {children}
    </StartMutationContext.Provider>
  );
}

export function useStartMutation(): StartMutationContextValue {
  const context = useContext(StartMutationContext);
  if (context === null) {
    throw new Error(
      'useStartMutation must be used inside StartMutationProvider.',
    );
  }
  return context;
}
