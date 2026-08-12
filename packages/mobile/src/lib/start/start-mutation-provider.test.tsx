import { describe, expect, mock, test } from 'bun:test';
import type {
  ActivationPreview,
  Event,
  JoinEventResult,
  StartEventResult,
} from '@psd-eoc/contracts';

import type { MobileAuthContextValue } from '../auth/auth-provider';
import { OfflineMutationDeniedError } from '../auth/auth-errors';
import { sessionFixture } from '../auth/auth-test-fixtures';
import type { StartHomeActiveEvent } from './start-api-client';
import type {
  StartMutationOwner,
  StartMutationPersistence,
  StartMutationRecoveryRecord,
} from './start-mutation-coordinator';

mock.module('expo-crypto', () => ({
  randomUUID: (): string => 'unused-default-key',
}));
mock.module('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
  getItem: (): null => null,
  setItem: (): void => {},
}));
mock.module('../auth/auth-provider', () => ({
  useMobileAuth: (): never => {
    throw new Error('Controller tests do not render the React provider.');
  },
}));

const {
  StartMutationProviderController,
  deliverClaimedStartMutationSuccessFeedback,
} = await import('./start-mutation-provider');
const {
  createStartMutationActivationEvidence,
  createStartMutationCoordinator,
} = await import('./start-mutation-coordinator');

type AuthBinding = Pick<
  MobileAuthContextValue,
  'assertMutationAllowed' | 'authenticatedRequest' | 'state'
>;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const PREVIEW = {
  id: '00000000-0000-4000-8000-000000000010',
  facilityId: '00000000-0000-4000-8000-000000000011',
  kind: 'drill',
  templateMode: 'drill',
  eventTypeVersion: {
    id: '00000000-0000-4000-8000-000000000012',
    templateMode: 'drill',
  },
  rosterSnapshotId: '00000000-0000-4000-8000-000000000013',
  rosterPopulation: 'synthetic',
  consequenceDigest: 'a'.repeat(64),
} as ActivationPreview;
const CHOICE = {
  event: {
    templateMode: 'real',
  } as Event,
  eventTypeName: 'Synthetic lockdown',
  facilityName: 'Synthetic school',
} satisfies StartHomeActiveEvent;

function activationResult(): StartEventResult {
  return {
    event: {
      templateMode: 'drill',
      eventTypeVersion: { templateMode: 'drill' },
    },
    transition: { transition: 'activate' },
  } as StartEventResult;
}

function joinResult(): JoinEventResult {
  return {
    event: {
      templateMode: 'real',
      eventTypeVersion: { templateMode: 'real' },
    },
    joined: true,
  } as JoinEventResult;
}

function matchingActivationEvent(): Event {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    facilityId: PREVIEW.facilityId,
    kind: PREVIEW.kind,
    templateMode: PREVIEW.templateMode,
    eventTypeVersion: PREVIEW.eventTypeVersion,
    status: 'active',
    rosterSnapshotId: PREVIEW.rosterSnapshotId,
    rosterPopulation: PREVIEW.rosterPopulation,
    createdBy: {
      kind: 'human',
      userId: ownerFixture().userId,
      sessionId: ownerFixture().sessionId,
    },
    createdAt: '2026-08-12T12:00:00.000Z',
    activatedAt: '2026-08-12T12:00:00.000Z',
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: {
      kind: 'synthetic-training',
      activationPreviewId: PREVIEW.id,
      consequenceDigest: PREVIEW.consequenceDigest,
      requestId: '00000000-0000-4000-8000-000000000021',
    },
  } as Event;
}

function ownerFixture(): StartMutationOwner {
  const established = sessionFixture();
  return Object.freeze({
    userId: established.user.id,
    sessionId: established.session.id,
    deviceEnrollmentId: established.deviceEnrollment.id,
  });
}

function unresolvedActivationRecord(): StartMutationRecoveryRecord {
  return Object.freeze({
    phase: 'unresolved',
    owner: ownerFixture(),
    operation: 'activate',
    eventTypeName: 'Recovered synthetic earthquake drill',
    mode: 'drill',
    idempotencyKey: 'recovered-provider-key-0001',
    activationEvidence: createStartMutationActivationEvidence(PREVIEW),
    error: Object.freeze({
      message: 'Persisted fail-closed recovery marker.',
      outcomeUnknown: true,
    }),
  });
}

class MemoryStartMutationPersistence implements StartMutationPersistence {
  public reads = 0;
  public writes = 0;
  public clears = 0;
  public failRead = false;

  public constructor(
    public record: StartMutationRecoveryRecord | null = null,
  ) {}

  public read(): StartMutationRecoveryRecord | null {
    this.reads += 1;
    if (this.failRead) throw new Error('synthetic recovery read failure');
    return this.record;
  }

  public write(record: StartMutationRecoveryRecord): void {
    this.writes += 1;
    this.record = record;
  }

  public clear(): void {
    this.clears += 1;
    this.record = null;
  }
}

function authBinding(
  phase: MobileAuthContextValue['state']['phase'] = 'online',
  options: Readonly<{
    differentOwner?: boolean;
    mutationDenied?: boolean;
    request?: MobileAuthContextValue['authenticatedRequest'];
  }> = {},
): AuthBinding {
  const established = sessionFixture();
  const session =
    phase === 'locked' || phase === 'signed-out' || phase === 'blocked'
      ? null
      : options.differentOwner
        ? {
            ...established,
            session: {
              ...established.session,
              id: '00000000-0000-4000-8000-000000000099',
            },
            connectivityEpoch: {
              ...established.connectivityEpoch,
              sessionId: '00000000-0000-4000-8000-000000000099',
            },
          }
        : established;
  return {
    state: {
      phase,
      session,
      connectivityEpochId:
        phase === 'online' && session !== null
          ? session.connectivityEpoch.id
          : null,
      message: null,
    },
    assertMutationAllowed: () => {
      if (options.mutationDenied) throw new OfflineMutationDeniedError();
      const live = session ?? established;
      return {
        connectivityEpochId: live.connectivityEpoch.id,
        userId: live.user.id,
        sessionId: live.session.id,
        deviceEnrollmentId: live.deviceEnrollment.id,
      };
    },
    authenticatedRequest:
      options.request ??
      (() => Promise.reject(new Error('Unexpected test transport call.'))),
  };
}

describe('StartMutationProviderController retention', () => {
  test('retains activation success through background lock for the same owner', async () => {
    const operation = deferred<StartEventResult>();
    const request = authBinding().authenticatedRequest;
    const keys: string[] = [];
    const transports: unknown[][] = [];
    const controller = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => {
        keys.push('activation-provider-key');
        return 'activation-provider-key';
      },
      activate: (receivedRequest, preview, key) => {
        transports.push([receivedRequest, preview, key]);
        return operation.promise;
      },
    });
    controller.reconcile(authBinding('online', { request }));

    const admission = controller.submitActivation({
      preview: PREVIEW,
      eventTypeName: 'Synthetic earthquake drill',
    });
    expect(admission.accepted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'pending',
      visibility: 'owner',
      operation: 'activate',
      mode: 'drill',
    });
    controller.reconcile(authBinding('locked', { request }));
    expect(controller.getSnapshot()).toEqual({
      phase: 'pending',
      visibility: 'pending-other-session',
    });

    operation.resolve(activationResult());
    if (admission.accepted) await admission.completion;
    expect(controller.getSnapshot()).toEqual({ phase: 'idle' });
    controller.reconcile(authBinding('online', { request }));
    expect(controller.getSnapshot()).toEqual({
      phase: 'succeeded',
      completion: {
        kind: 'activated',
        eventTypeName: 'Synthetic earthquake drill',
        mode: 'drill',
      },
    });
    expect(keys).toEqual(['activation-provider-key']);
    expect(transports).toEqual([[request, PREVIEW, 'activation-provider-key']]);
  });

  test('retains failure through lock without retrying on same-owner unlock', async () => {
    const operation = deferred<JoinEventResult>();
    let calls = 0;
    const controller = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => 'join-provider-key',
      join: () => {
        calls += 1;
        return operation.promise;
      },
    });
    controller.reconcile(authBinding());
    const admission = controller.submitJoin({ choice: CHOICE });
    controller.reconcile(authBinding('locked'));
    operation.reject(new Error('private transport detail'));
    if (admission.accepted) await admission.completion;
    expect(controller.getSnapshot()).toEqual({
      phase: 'unresolved-other-session',
    });

    controller.reconcile(authBinding());
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      operation: 'join',
      eventTypeName: 'Synthetic lockdown',
      mode: 'real',
      error: { outcomeUnknown: true },
    });
    controller.reconcile(authBinding('locked'));
    expect(controller.resolveActivationFromFreshEvents([])).toBe(false);
    controller.reconcile(authBinding());
    expect(calls).toBe(1);
    expect(controller.acknowledge()).toBe(false);
    expect(controller.resolveActivationFromFreshEvents([])).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      operation: 'join',
    });
  });
});

describe('StartMutationProviderController hydration lifecycle', () => {
  test('hydrates once on first online reconciliation without notifying or resubmitting', () => {
    const persistence = new MemoryStartMutationPersistence(
      unresolvedActivationRecord(),
    );
    const coordinator = createStartMutationCoordinator(persistence);
    let notifications = 0;
    let keyCalls = 0;
    let transportCalls = 0;
    coordinator.subscribe(() => {
      notifications += 1;
    });
    const controller = new StartMutationProviderController({
      coordinator,
      createIdempotencyKey: () => {
        keyCalls += 1;
        return 'must-not-be-created-key-0001';
      },
      activate: () => {
        transportCalls += 1;
        return Promise.resolve(activationResult());
      },
    });

    controller.reconcile(authBinding('locked'), false);
    expect(persistence.reads).toBe(0);
    expect(controller.getSnapshot()).toEqual({ phase: 'idle' });

    controller.reconcile(authBinding('online'), false);
    expect(persistence.reads).toBe(1);
    expect(notifications).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      operation: 'activate',
      eventTypeName: 'Recovered synthetic earthquake drill',
      mode: 'drill',
      error: { outcomeUnknown: true },
    });
    expect(
      controller.submitActivation({
        preview: PREVIEW,
        eventTypeName: 'Must remain blocked',
      }),
    ).toEqual({ accepted: false });

    controller.reconcile(authBinding('locked'), false);
    expect(controller.getSnapshot()).toEqual({
      phase: 'unresolved-other-session',
    });
    controller.reconcile(authBinding('online'), false);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      operation: 'activate',
    });
    expect(persistence.reads).toBe(1);
    expect(notifications).toBe(0);
    expect(keyCalls).toBe(0);
    expect(transportCalls).toBe(0);
    expect(persistence.writes).toBe(0);
    expect(persistence.clears).toBe(0);
  });

  test('fails closed in the same reconciliation when recovery cannot be read', () => {
    const persistence = new MemoryStartMutationPersistence();
    persistence.failRead = true;
    const coordinator = createStartMutationCoordinator(persistence);
    let notifications = 0;
    coordinator.subscribe(() => {
      notifications += 1;
    });
    const controller = new StartMutationProviderController({ coordinator });

    controller.reconcile(authBinding('online'), false);

    expect(persistence.reads).toBe(1);
    expect(notifications).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'recovery-blocked',
    });
    expect(controller.submitJoin({ choice: CHOICE })).toEqual({
      accepted: false,
    });

    controller.reconcile(authBinding('locked'), false);
    controller.reconcile(authBinding('online'), false);
    expect(persistence.reads).toBe(1);
    expect(notifications).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'recovery-blocked',
    });
  });
});

describe('StartMutationProviderController owner quarantine', () => {
  test('never leaks pending identity or settlement after sign-out', async () => {
    const operation = deferred<StartEventResult>();
    const controller = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => 'sign-out-provider-key',
      activate: () => operation.promise,
    });
    controller.reconcile(authBinding());
    const admission = controller.submitActivation({
      preview: PREVIEW,
      eventTypeName: 'Must not leak',
    });

    controller.reconcile(authBinding('signed-out'));
    const neutral = controller.getSnapshot();
    expect(neutral).toEqual({
      phase: 'pending',
      visibility: 'pending-other-session',
    });
    expect(JSON.stringify(neutral)).not.toContain('Must not leak');
    expect(JSON.stringify(neutral)).not.toContain('drill');
    operation.resolve(activationResult());
    if (admission.accepted) await admission.completion;
    controller.reconcile(authBinding());
    expect(controller.getSnapshot()).toEqual({ phase: 'idle' });
  });

  test('quarantines immediately when any different exact owner is online', async () => {
    const operation = deferred<JoinEventResult>();
    const controller = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => 'owner-change-provider-key',
      join: () => operation.promise,
    });
    controller.reconcile(authBinding());
    const admission = controller.submitJoin({ choice: CHOICE });

    controller.reconcile(authBinding('online', { differentOwner: true }));
    const neutral = controller.getSnapshot();
    expect(neutral).toEqual({
      phase: 'pending',
      visibility: 'pending-other-session',
    });
    expect(JSON.stringify(neutral)).not.toContain('Synthetic lockdown');
    expect(JSON.stringify(neutral)).not.toContain('real');
    operation.reject(new Error('must stay quarantined'));
    if (admission.accepted) await admission.completion;
    controller.reconcile(authBinding());
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      operation: 'join',
    });
  });
});

describe('StartMutationProviderController admission and terminal API', () => {
  test('rejects a retained callback when live auth has crossed sessions', () => {
    let keyCalls = 0;
    let transportCalls = 0;
    const retainedAuth = authBinding();
    const newSessionAuth = authBinding('online', { differentOwner: true });
    const controller = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => {
        keyCalls += 1;
        return 'cross-session-key-must-not-exist';
      },
      activate: () => {
        transportCalls += 1;
        return Promise.resolve(activationResult());
      },
    });
    controller.reconcile({
      ...retainedAuth,
      // A callback retained from the preceding commit still carries that
      // render's state, while this live guard reads the auth controller now.
      assertMutationAllowed: newSessionAuth.assertMutationAllowed,
    });

    expect(
      controller.submitActivation({
        preview: PREVIEW,
        eventTypeName: 'Synthetic earthquake drill',
      }),
    ).toEqual({ accepted: false });
    expect(controller.getSnapshot()).toEqual({ phase: 'idle' });
    expect(keyCalls).toBe(0);
    expect(transportCalls).toBe(0);
  });

  test('rejects every retained terminal callback after live auth crosses sessions', async () => {
    const retainedAuth = authBinding();
    const newSessionAuth = authBinding('online', { differentOwner: true });
    const activationController = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => 'terminal-cross-session-activation-key',
      activate: () => Promise.resolve(activationResult()),
    });
    activationController.reconcile(retainedAuth);
    const activation = activationController.submitActivation({
      preview: PREVIEW,
      eventTypeName: 'Must stay private',
    });
    if (activation.accepted) await activation.completion;
    activationController.reconcile({
      ...retainedAuth,
      assertMutationAllowed: newSessionAuth.assertMutationAllowed,
    });

    expect(activationController.claimSuccessFeedback()).toBeNull();
    expect(activationController.acknowledge()).toBe(false);
    expect(activationController.getSnapshot()).toMatchObject({
      phase: 'succeeded',
      completion: { eventTypeName: 'Must stay private' },
    });

    const persistence = new MemoryStartMutationPersistence(
      unresolvedActivationRecord(),
    );
    const unresolvedController = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(persistence),
    });
    unresolvedController.reconcile(retainedAuth);
    unresolvedController.reconcile({
      ...retainedAuth,
      assertMutationAllowed: newSessionAuth.assertMutationAllowed,
    });
    expect(
      unresolvedController.resolveActivationFromFreshEvents([
        matchingActivationEvent(),
      ]),
    ).toBe(false);
    expect(unresolvedController.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      eventTypeName: 'Recovered synthetic earthquake drill',
    });
    expect(persistence.record?.phase).toBe('unresolved');
  });

  test('rejects offline, denied, and busy submissions before another key or run', async () => {
    const operation = deferred<StartEventResult>();
    let keyCalls = 0;
    let runs = 0;
    const controller = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => {
        keyCalls += 1;
        return `provider-key-${String(keyCalls).padStart(4, '0')}`;
      },
      activate: () => {
        runs += 1;
        return operation.promise;
      },
      join: () => {
        runs += 1;
        return Promise.resolve(joinResult());
      },
    });

    controller.reconcile(authBinding('offline-cached'));
    expect(
      controller.submitActivation({
        preview: PREVIEW,
        eventTypeName: 'Synthetic earthquake drill',
      }),
    ).toEqual({ accepted: false });
    controller.reconcile(authBinding('online', { mutationDenied: true }));
    expect(controller.submitJoin({ choice: CHOICE })).toEqual({
      accepted: false,
    });
    expect(controller.getSnapshot()).toEqual({
      phase: 'failed',
      operation: 'join',
      eventTypeName: 'Synthetic lockdown',
      mode: 'real',
      error: {
        message:
          'Offline — starting an incident and other changes are unavailable. Reconnect, review the consequences, and confirm again. No event was started or joined, and nothing was queued.',
        outcomeUnknown: false,
      },
    });
    expect(keyCalls).toBe(0);
    expect(runs).toBe(0);

    controller.reconcile(authBinding());
    expect(controller.acknowledge()).toBe(true);
    const admitted = controller.submitActivation({
      preview: PREVIEW,
      eventTypeName: 'Synthetic earthquake drill',
    });
    expect(admitted.accepted).toBe(true);
    expect(controller.isPendingNow()).toBe(true);
    expect(controller.submitJoin({ choice: CHOICE })).toEqual({
      accepted: false,
    });
    expect(keyCalls).toBe(1);
    expect(runs).toBe(1);
    operation.resolve(activationResult());
    if (admitted.accepted) await admitted.completion;
  });

  test('claims success feedback once and acknowledges only while owner is online', async () => {
    const controller = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => 'terminal-provider-key',
      join: () => Promise.resolve(joinResult()),
    });
    controller.reconcile(authBinding());
    const admission = controller.submitJoin({ choice: CHOICE });
    if (admission.accepted) await admission.completion;

    expect(controller.isPendingNow()).toBe(false);
    expect(controller.claimSuccessFeedback()).toEqual({
      kind: 'joined',
      eventTypeName: 'Synthetic lockdown',
      mode: 'real',
    });
    expect(controller.claimSuccessFeedback()).toBeNull();
    controller.reconcile(authBinding('locked'));
    expect(controller.acknowledge()).toBe(false);
    controller.reconcile(authBinding());
    expect(controller.acknowledge()).toBe(true);
    expect(controller.getSnapshot()).toEqual({ phase: 'idle' });
  });

  test('delivers one haptic and announcement across lock, unlock, and result remount', async () => {
    const controller = new StartMutationProviderController({
      coordinator: createStartMutationCoordinator(),
      createIdempotencyKey: () => 'remount-feedback-provider-key',
      join: () => Promise.resolve(joinResult()),
    });
    controller.reconcile(authBinding());
    const admission = controller.submitJoin({ choice: CHOICE });
    if (admission.accepted) await admission.completion;

    const announcements: string[] = [];
    let haptics = 0;
    const deliverFocusedResultFeedback = (): boolean =>
      deliverClaimedStartMutationSuccessFeedback(
        controller.claimSuccessFeedback,
        {
          announce: (completion) => {
            announcements.push(
              `${completion.kind}:${completion.mode}:${completion.eventTypeName}`,
            );
          },
          haptic: () => {
            haptics += 1;
          },
        },
      );

    expect(deliverFocusedResultFeedback()).toBe(true);
    controller.reconcile(authBinding('locked'));
    controller.reconcile(authBinding());
    expect(deliverFocusedResultFeedback()).toBe(false);
    expect(haptics).toBe(1);
    expect(announcements).toEqual(['joined:real:Synthetic lockdown']);
  });
});
