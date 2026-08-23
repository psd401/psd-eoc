import { describe, expect, test } from 'bun:test';
import type {
  EventKind,
  JoinEventResult,
  StartEventResult,
  TemplateMode,
} from '@psd-eoc/contracts';
import { EventTypeVersionRefSchema } from '@psd-eoc/contracts';

import { OfflineMutationDeniedError } from '../auth/auth-errors';
import { StartClientError } from './start-api-client';
import {
  StartMutationCoordinator,
  mapStartMutationError,
  type StartMutationActivationEvidence,
  type StartMutationOwner,
  type StartMutationPersistence,
  type StartMutationRecoveryRecord,
  type StartMutationSubmission,
} from './start-mutation-coordinator';

const OWNER: StartMutationOwner = Object.freeze({
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  deviceEnrollmentId: '00000000-0000-4000-8000-000000000003',
});
const OTHER_OWNER: StartMutationOwner = Object.freeze({
  userId: '00000000-0000-4000-8000-000000000011',
  sessionId: '00000000-0000-4000-8000-000000000012',
  deviceEnrollmentId: '00000000-0000-4000-8000-000000000013',
});
const ACTIVATION_KEY = 'activation-key-0001';
const JOIN_KEY = 'join-event-key-0001';
const ACTIVATION_PREVIEW_ID = '00000000-0000-4000-8000-000000000301';
const FACILITY_ID = '00000000-0000-4000-8000-000000000302';
const EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000303';
const ROSTER_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000304';
const ACTIVATED_EVENT_ID = '00000000-0000-4000-8000-000000000101';
const JOIN_EVENT_ID = '00000000-0000-4000-8000-000000000201';
const ACTIVATION_DIGEST = 'a'.repeat(64);
const ACTIVATION_EVIDENCE: StartMutationActivationEvidence = Object.freeze({
  previewId: ACTIVATION_PREVIEW_ID,
  facilityId: FACILITY_ID,
  kind: 'drill',
  mode: 'drill',
  eventTypeVersion: EventTypeVersionRefSchema.parse({
    id: EVENT_TYPE_VERSION_ID,
    templateMode: 'drill',
  }),
  rosterSnapshotId: ROSTER_SNAPSHOT_ID,
  rosterPopulation: 'synthetic',
  consequenceDigest: ACTIVATION_DIGEST,
});
class MemoryPersistence implements StartMutationPersistence {
  public record: StartMutationRecoveryRecord | null = null;
  public readonly actions: string[] = [];
  public failRead = false;
  public failWrite = false;
  public failClear = false;

  public read(): StartMutationRecoveryRecord | null {
    this.actions.push('read');
    if (this.failRead) throw new Error('synthetic read failure');
    return this.record;
  }

  public write(record: StartMutationRecoveryRecord): void {
    this.actions.push(`write:${record.phase}`);
    if (this.failWrite) throw new Error('synthetic write failure');
    this.record = record;
  }

  public clear(): void {
    this.actions.push('clear');
    if (this.failClear) throw new Error('synthetic clear failure');
    this.record = null;
  }
}

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

function activationResult(mode: TemplateMode = 'drill'): StartEventResult {
  return {
    event: {
      id: ACTIVATED_EVENT_ID,
      kind: mode === 'real' ? 'incident' : 'drill',
      templateMode: mode,
      eventTypeVersion: { templateMode: mode },
    },
    transition: { transition: 'activate' },
  } as StartEventResult;
}

function joinResult(
  mode: TemplateMode = 'real',
  eventKind: EventKind = mode === 'real' ? 'incident' : 'drill',
): JoinEventResult {
  return {
    event: {
      id: JOIN_EVENT_ID,
      kind: eventKind,
      templateMode: mode,
      eventTypeVersion: { templateMode: mode },
    },
    participantId: '00000000-0000-4000-8000-000000000202',
    joined: true,
  } as JoinEventResult;
}

function online(
  coordinator: StartMutationCoordinator,
  owner: StartMutationOwner = OWNER,
): void {
  coordinator.reconcile({ phase: 'online', owner });
}

function activationSubmission(
  run: () => Promise<StartEventResult>,
  owner: StartMutationOwner = OWNER,
): StartMutationSubmission {
  return {
    operation: 'activate',
    owner,
    eventKind: 'drill',
    eventTypeName: 'Practice Lockdown',
    mode: 'drill',
    idempotencyKey: ACTIVATION_KEY,
    activationEvidence: ACTIVATION_EVIDENCE,
    run,
  };
}

function joinSubmission(
  run: () => Promise<JoinEventResult>,
  owner: StartMutationOwner = OWNER,
): StartMutationSubmission {
  return {
    operation: 'join',
    owner,
    eventId: JOIN_EVENT_ID,
    eventKind: 'incident',
    eventTypeName: 'Lockdown',
    mode: 'real',
    idempotencyKey: JOIN_KEY,
    run,
  };
}

describe('StartMutationCoordinator admission', () => {
  test('rejects drill/test activation-evidence classification drift before persistence or transport', () => {
    for (const [eventKind, evidenceKind] of [
      ['test', 'drill'],
      ['drill', 'test'],
    ] as const) {
      const persistence = new MemoryPersistence();
      const coordinator = new StartMutationCoordinator(persistence);
      let calls = 0;
      online(coordinator);
      const submission = activationSubmission(async () => {
        calls += 1;
        return activationResult();
      }) as Extract<StartMutationSubmission, { operation: 'activate' }>;

      expect(() =>
        coordinator.submit({
          ...submission,
          eventKind,
          activationEvidence: {
            ...ACTIVATION_EVIDENCE,
            kind: evidenceKind,
          },
        }),
      ).toThrow(
        'Activation evidence does not match the displayed event classification.',
      );
      expect(calls).toBe(0);
      expect(persistence.actions).toEqual([]);
      expect(coordinator.getSnapshot()).toEqual({ phase: 'idle' });
    }
  });

  test('rejects a test event bound to a staff roster before persistence or transport', () => {
    const persistence = new MemoryPersistence();
    const coordinator = new StartMutationCoordinator(persistence);
    let calls = 0;
    online(coordinator);
    const submission = activationSubmission(async () => {
      calls += 1;
      return activationResult('drill');
    }) as Extract<StartMutationSubmission, { operation: 'activate' }>;

    expect(() =>
      coordinator.submit({
        ...submission,
        eventKind: 'test',
        activationEvidence: {
          ...ACTIVATION_EVIDENCE,
          kind: 'test',
          rosterPopulation: 'staff',
        },
      }),
    ).toThrow();
    expect(calls).toBe(0);
    expect(persistence.actions).toEqual([]);
    expect(coordinator.getSnapshot()).toEqual({ phase: 'idle' });
  });

  test('invokes one activation immediately and rejects its double tap', async () => {
    const coordinator = new StartMutationCoordinator();
    const operation = deferred<StartEventResult>();
    let calls = 0;
    online(coordinator);

    const first = coordinator.submit(
      activationSubmission(() => {
        calls += 1;
        expect(coordinator.getSnapshot()).toMatchObject({
          phase: 'pending',
          visibility: 'owner',
        });
        return operation.promise;
      }),
    );
    const second = coordinator.submit(
      activationSubmission(() => {
        calls += 1;
        return Promise.resolve(activationResult());
      }),
    );

    expect(first.accepted).toBe(true);
    expect(second).toEqual({ accepted: false });
    expect(calls).toBe(1);
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'pending',
      visibility: 'owner',
      operation: 'activate',
      eventKind: 'drill',
      eventTypeName: 'Practice Lockdown',
      mode: 'drill',
    });
    expect(JSON.stringify(coordinator.getSnapshot())).not.toContain(
      ACTIVATION_KEY,
    );
    operation.resolve(activationResult());
    if (first.accepted) await first.completion;
  });

  test('retains only the exact pending join event identity for its owner', async () => {
    const coordinator = new StartMutationCoordinator();
    const operation = deferred<JoinEventResult>();
    online(coordinator);

    const admission = coordinator.submit(
      joinSubmission(() => operation.promise),
    );
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'pending',
      visibility: 'owner',
      operation: 'join',
      eventId: JOIN_EVENT_ID,
      eventKind: 'incident',
      eventTypeName: 'Lockdown',
      mode: 'real',
    });

    coordinator.reconcile({ phase: 'locked', owner: null });
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'pending',
      visibility: 'pending-other-session',
    });
    expect(JSON.stringify(coordinator.getSnapshot())).not.toContain(
      JOIN_EVENT_ID,
    );

    online(coordinator);
    expect(coordinator.getSnapshot()).toMatchObject({
      operation: 'join',
      eventId: JOIN_EVENT_ID,
      eventTypeName: 'Lockdown',
    });
    expect(coordinator.getSnapshot()).not.toMatchObject({
      eventId: '00000000-0000-4000-8000-000000000299',
    });

    operation.resolve(joinResult());
    if (admission.accepted) await admission.completion;
  });

  test('blocks join doubles and both activation/join cross-kind races', async () => {
    const joinFirst = new StartMutationCoordinator();
    const pendingJoin = deferred<JoinEventResult>();
    let joinCalls = 0;
    online(joinFirst);
    const admittedJoin = joinFirst.submit(
      joinSubmission(() => {
        joinCalls += 1;
        return pendingJoin.promise;
      }),
    );
    expect(
      joinFirst.submit(
        joinSubmission(() => {
          joinCalls += 1;
          return Promise.resolve(joinResult());
        }),
      ),
    ).toEqual({ accepted: false });
    expect(
      joinFirst.submit(
        activationSubmission(() => Promise.resolve(activationResult())),
      ),
    ).toEqual({ accepted: false });
    expect(joinCalls).toBe(1);

    const activationFirst = new StartMutationCoordinator();
    const pendingActivation = deferred<StartEventResult>();
    online(activationFirst);
    const admittedActivation = activationFirst.submit(
      activationSubmission(() => pendingActivation.promise),
    );
    expect(
      activationFirst.submit(
        joinSubmission(() => Promise.resolve(joinResult())),
      ),
    ).toEqual({ accepted: false });

    pendingJoin.resolve(joinResult());
    pendingActivation.resolve(activationResult());
    if (admittedJoin.accepted) await admittedJoin.completion;
    if (admittedActivation.accepted) await admittedActivation.completion;
  });

  test('rejects submission unless the exact reconciled owner is online', () => {
    const coordinator = new StartMutationCoordinator();
    const ownerChanges: readonly StartMutationOwner[] = [
      { ...OWNER, userId: OTHER_OWNER.userId },
      { ...OWNER, sessionId: OTHER_OWNER.sessionId },
      { ...OWNER, deviceEnrollmentId: OTHER_OWNER.deviceEnrollmentId },
    ];
    let calls = 0;

    expect(
      coordinator.submit(
        activationSubmission(() => {
          calls += 1;
          return Promise.resolve(activationResult());
        }),
      ),
    ).toEqual({ accepted: false });

    for (const changedOwner of ownerChanges) {
      online(coordinator, changedOwner);
      expect(
        coordinator.submit(
          activationSubmission(() => {
            calls += 1;
            return Promise.resolve(activationResult());
          }),
        ),
      ).toEqual({ accepted: false });
    }
    expect(calls).toBe(0);
  });
});

describe('StartMutationCoordinator app-lifetime retention', () => {
  test('retains a success through lock, unmount, settlement, and same-owner remount', async () => {
    const coordinator = new StartMutationCoordinator();
    const operation = deferred<StartEventResult>();
    let notifications = 0;
    online(coordinator);
    const unsubscribe = coordinator.subscribe(() => {
      notifications += 1;
    });
    const admission = coordinator.submit(
      activationSubmission(() => operation.promise),
    );
    unsubscribe();
    coordinator.reconcile({ phase: 'locked', owner: null });
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'pending',
      visibility: 'pending-other-session',
    });

    operation.resolve(activationResult());
    if (admission.accepted) await admission.completion;
    expect(coordinator.getSnapshot()).toEqual({ phase: 'idle' });
    expect(notifications).toBe(1);

    online(coordinator);
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'succeeded',
      completion: {
        kind: 'activated',
        eventId: ACTIVATED_EVENT_ID,
        eventKind: 'drill',
        eventTypeName: 'Practice Lockdown',
        mode: 'drill',
      },
    });
  });

  test('retains a public-safe error through transient auth absence and remount', async () => {
    const coordinator = new StartMutationCoordinator();
    const operation = deferred<JoinEventResult>();
    online(coordinator);
    const admission = coordinator.submit(
      joinSubmission(() => operation.promise),
    );

    coordinator.reconcile({ phase: 'cached-checking', owner: null });
    coordinator.reconcile({ phase: 'offline-cached', owner: null });
    operation.reject(
      new StartClientError('The join request was rejected.', false, false),
    );
    if (admission.accepted) await admission.completion;
    expect(coordinator.getSnapshot()).toEqual({ phase: 'idle' });

    online(coordinator);
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'failed',
      operation: 'join',
      eventKind: 'incident',
      eventTypeName: 'Lockdown',
      mode: 'real',
      error: {
        message: 'The join request was rejected.',
        outcomeUnknown: false,
      },
    });
  });

  test('ignores connectivity-epoch changes for the same exact owner', async () => {
    const coordinator = new StartMutationCoordinator();
    const operation = deferred<StartEventResult>();
    online(coordinator);
    const admission = coordinator.submit(
      activationSubmission(() => operation.promise),
    );

    // Reconciliation intentionally has no epoch field: reconnect epochs are
    // not owner identity, so a same-owner online observation retains work.
    online(coordinator, { ...OWNER });
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'pending',
      visibility: 'owner',
    });
    expect(JSON.stringify(coordinator.getSnapshot())).not.toContain(
      ACTIVATION_KEY,
    );
    operation.resolve(activationResult());
    if (admission.accepted) await admission.completion;
    online(coordinator, { ...OWNER });
    expect(coordinator.getSnapshot().phase).toBe('succeeded');
  });

  test('never retries an operation after failure or auth reconciliation', async () => {
    const coordinator = new StartMutationCoordinator();
    let calls = 0;
    online(coordinator);
    const admission = coordinator.submit(
      activationSubmission(() => {
        calls += 1;
        return Promise.reject(new Error('private upstream detail'));
      }),
    );
    if (admission.accepted) await admission.completion;

    coordinator.reconcile({ phase: 'locked', owner: null });
    online(coordinator);
    coordinator.getSnapshot();
    coordinator.claimSuccessFeedback(OWNER);
    expect(calls).toBe(1);
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      error: { outcomeUnknown: true },
    });
  });
});

describe('StartMutationCoordinator durable recovery', () => {
  test('persists an unresolved fence before invoking transport, then persists success', async () => {
    const persistence = new MemoryPersistence();
    const coordinator = new StartMutationCoordinator(persistence);
    online(coordinator);

    const admission = coordinator.submit(
      activationSubmission(() => {
        persistence.actions.push('run');
        return Promise.resolve(activationResult());
      }),
    );

    expect(admission.accepted).toBe(true);
    expect(persistence.actions).toEqual(['write:unresolved', 'run']);
    if (admission.accepted) await admission.completion;
    expect(persistence.actions).toEqual([
      'write:unresolved',
      'run',
      'write:succeeded',
    ]);
    expect(persistence.record).toMatchObject({
      phase: 'succeeded',
      operation: 'activate',
      idempotencyKey: ACTIVATION_KEY,
      activationEvidence: ACTIVATION_EVIDENCE,
      feedbackClaimed: false,
    });
  });

  test('blocks without invoking transport when the pre-transport fence cannot be stored', () => {
    const persistence = new MemoryPersistence();
    persistence.failWrite = true;
    const coordinator = new StartMutationCoordinator(persistence);
    let calls = 0;
    online(coordinator);

    const admission = coordinator.submit(
      activationSubmission(() => {
        calls += 1;
        return Promise.resolve(activationResult());
      }),
    );

    expect(admission).toEqual({ accepted: false });
    expect(calls).toBe(0);
    expect(persistence.actions).toEqual(['write:unresolved']);
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'recovery-blocked',
    });
  });

  test('hydrates an abandoned request without replay and keeps every other owner fenced', () => {
    const persistence = new MemoryPersistence();
    const original = new StartMutationCoordinator(persistence);
    const operation = deferred<StartEventResult>();
    let calls = 0;
    online(original);
    const admission = original.submit(
      activationSubmission(() => {
        calls += 1;
        return operation.promise;
      }),
    );
    expect(admission.accepted).toBe(true);
    expect(persistence.record?.phase).toBe('unresolved');

    const restarted = new StartMutationCoordinator(persistence);
    online(restarted, OTHER_OWNER);
    expect(restarted.hydrate()).toBe(true);
    expect(restarted.getSnapshot()).toEqual({
      phase: 'unresolved-other-session',
    });
    expect(
      restarted.submit(
        activationSubmission(() => {
          calls += 1;
          return Promise.resolve(activationResult());
        }, OTHER_OWNER),
      ),
    ).toEqual({ accepted: false });
    expect(calls).toBe(1);

    online(restarted, OWNER);
    expect(restarted.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      operation: 'activate',
      mode: 'drill',
      error: { outcomeUnknown: true },
    });
    expect(calls).toBe(1);
  });

  test('retains the exact activation request fence after an uncertain transport outcome', async () => {
    const persistence = new MemoryPersistence();
    const coordinator = new StartMutationCoordinator(persistence);
    online(coordinator);
    const admission = coordinator.submit(
      activationSubmission(() =>
        Promise.reject(new Error('private uncertain transport state')),
      ),
    );
    if (admission.accepted) await admission.completion;
    expect(coordinator.getSnapshot().phase).toBe('unresolved');
    expect(persistence.record).toMatchObject({
      phase: 'unresolved',
      operation: 'activate',
      idempotencyKey: ACTIVATION_KEY,
      activationEvidence: ACTIVATION_EVIDENCE,
    });
  });

  test('retains one-time feedback across restart and clears durable truth only on acknowledgement', async () => {
    const persistence = new MemoryPersistence();
    const original = new StartMutationCoordinator(persistence);
    online(original);
    const admission = original.submit(
      activationSubmission(() => Promise.resolve(activationResult())),
    );
    if (admission.accepted) await admission.completion;

    const firstRestart = new StartMutationCoordinator(persistence);
    online(firstRestart);
    expect(firstRestart.hydrate()).toBe(true);
    expect(firstRestart.claimSuccessFeedback(OWNER)).toEqual({
      kind: 'activated',
      eventId: ACTIVATED_EVENT_ID,
      eventKind: 'drill',
      eventTypeName: 'Practice Lockdown',
      mode: 'drill',
    });
    expect(persistence.record).toMatchObject({
      phase: 'succeeded',
      feedbackClaimed: true,
    });

    const secondRestart = new StartMutationCoordinator(persistence);
    online(secondRestart);
    expect(secondRestart.hydrate()).toBe(true);
    expect(secondRestart.claimSuccessFeedback(OWNER)).toBeNull();
    expect(secondRestart.acknowledge(OWNER)).toBe(true);
    expect(persistence.record).toBeNull();

    const afterAcknowledgement = new StartMutationCoordinator(persistence);
    online(afterAcknowledgement);
    expect(afterAcknowledgement.hydrate()).toBe(true);
    expect(afterAcknowledgement.getSnapshot()).toEqual({ phase: 'idle' });
  });

  test('fails closed on hydration, terminal persistence, and durable-clear errors', async () => {
    const unreadablePersistence = new MemoryPersistence();
    unreadablePersistence.failRead = true;
    const unreadable = new StartMutationCoordinator(unreadablePersistence);
    online(unreadable);
    expect(unreadable.hydrate()).toBe(false);
    expect(unreadable.getSnapshot().phase).toBe('recovery-blocked');

    const terminalPersistence = new MemoryPersistence();
    const terminalCoordinator = new StartMutationCoordinator(
      terminalPersistence,
    );
    const operation = deferred<StartEventResult>();
    online(terminalCoordinator);
    const terminalAdmission = terminalCoordinator.submit(
      activationSubmission(() => operation.promise),
    );
    terminalPersistence.failWrite = true;
    operation.resolve(activationResult());
    if (terminalAdmission.accepted) await terminalAdmission.completion;
    expect(terminalCoordinator.getSnapshot().phase).toBe('recovery-blocked');

    const unclearedPersistence = new MemoryPersistence();
    const uncleared = new StartMutationCoordinator(unclearedPersistence);
    online(uncleared);
    const success = uncleared.submit(
      activationSubmission(() => Promise.resolve(activationResult())),
    );
    if (success.accepted) await success.completion;
    unclearedPersistence.failClear = true;
    expect(uncleared.acknowledge(OWNER)).toBe(false);
    expect(uncleared.getSnapshot().phase).toBe('recovery-blocked');
    expect(unclearedPersistence.record?.phase).toBe('succeeded');
  });
});

describe('StartMutationCoordinator owner quarantine', () => {
  test.each(['signed-out', 'blocked'] as const)(
    'quarantines pending work on definitive %s and discards its settlement',
    async (phase) => {
      const coordinator = new StartMutationCoordinator();
      const operation = deferred<StartEventResult>();
      online(coordinator);
      const admission = coordinator.submit(
        activationSubmission(() => operation.promise),
      );

      coordinator.reconcile({ phase, owner: null });
      const neutral = coordinator.getSnapshot();
      expect(neutral).toEqual({
        phase: 'pending',
        visibility: 'pending-other-session',
      });
      expect(JSON.stringify(neutral)).not.toContain(OWNER.userId);
      expect(JSON.stringify(neutral)).not.toContain(OWNER.sessionId);
      expect(JSON.stringify(neutral)).not.toContain(OWNER.deviceEnrollmentId);
      expect(JSON.stringify(neutral)).not.toContain('Practice Lockdown');
      expect(JSON.stringify(neutral)).not.toContain('drill');

      operation.resolve(activationResult());
      if (admission.accepted) await admission.completion;
      online(coordinator);
      expect(coordinator.getSnapshot()).toEqual({ phase: 'idle' });
      expect(coordinator.claimSuccessFeedback(OWNER)).toBeNull();
    },
  );

  test.each([
    { ...OWNER, userId: OTHER_OWNER.userId },
    { ...OWNER, sessionId: OTHER_OWNER.sessionId },
    { ...OWNER, deviceEnrollmentId: OTHER_OWNER.deviceEnrollmentId },
  ])(
    'quarantines on each exact-owner mismatch and retains unknown truth: %j',
    async (nextOwner) => {
      const coordinator = new StartMutationCoordinator();
      const operation = deferred<JoinEventResult>();
      online(coordinator);
      const admission = coordinator.submit(
        joinSubmission(() => operation.promise),
      );

      online(coordinator, nextOwner);
      expect(coordinator.getSnapshot()).toEqual({
        phase: 'pending',
        visibility: 'pending-other-session',
      });
      operation.reject(new Error('must not surface'));
      if (admission.accepted) await admission.completion;
      expect(coordinator.getSnapshot()).toEqual({
        phase: 'unresolved-other-session',
      });
      online(coordinator);
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'unresolved',
        operation: 'join',
        error: { outcomeUnknown: true },
      });
    },
  );

  test('clears and never re-exposes a terminal result across owners', async () => {
    const coordinator = new StartMutationCoordinator();
    online(coordinator);
    const admission = coordinator.submit(
      activationSubmission(() => Promise.resolve(activationResult())),
    );
    if (admission.accepted) await admission.completion;
    expect(coordinator.getSnapshot().phase).toBe('succeeded');

    online(coordinator, OTHER_OWNER);
    expect(coordinator.getSnapshot()).toEqual({ phase: 'idle' });
    online(coordinator);
    expect(coordinator.getSnapshot()).toEqual({ phase: 'idle' });
  });
});

describe('StartMutationCoordinator terminal handling', () => {
  test('preserves a joined synthetic test as test classification', async () => {
    const coordinator = new StartMutationCoordinator();
    online(coordinator);
    const admission = coordinator.submit({
      operation: 'join',
      owner: OWNER,
      eventId: JOIN_EVENT_ID,
      eventKind: 'test',
      eventTypeName: 'Synthetic delivery test',
      mode: 'drill',
      idempotencyKey: JOIN_KEY,
      run: () => Promise.resolve(joinResult('drill', 'test')),
    });
    if (admission.accepted) await admission.completion;
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'succeeded',
      completion: {
        kind: 'joined',
        eventId: JOIN_EVENT_ID,
        eventKind: 'test',
        eventTypeName: 'Synthetic delivery test',
        mode: 'drill',
      },
    });
  });

  test('derives exact completion kind, event type, and mode for join', async () => {
    const coordinator = new StartMutationCoordinator();
    online(coordinator);
    const admission = coordinator.submit(
      joinSubmission(() => Promise.resolve(joinResult())),
    );
    if (admission.accepted) await admission.completion;
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'succeeded',
      completion: {
        kind: 'joined',
        eventId: JOIN_EVENT_ID,
        eventKind: 'incident',
        eventTypeName: 'Lockdown',
        mode: 'real',
      },
    });
  });

  test('treats an operation or real-vs-drill mismatch as unresolved', async () => {
    const wrongOperationCoordinator = new StartMutationCoordinator();
    online(wrongOperationCoordinator);
    const wrongOperation = wrongOperationCoordinator.submit(
      activationSubmission(
        () =>
          Promise.resolve(
            joinResult('drill'),
          ) as unknown as Promise<StartEventResult>,
      ),
    );
    if (wrongOperation.accepted) await wrongOperation.completion;
    expect(wrongOperationCoordinator.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      mode: 'drill',
      error: { outcomeUnknown: true },
    });
    expect(wrongOperationCoordinator.acknowledge(OWNER)).toBe(false);
    expect(wrongOperationCoordinator.getSnapshot().phase).toBe('unresolved');

    const wrongModeCoordinator = new StartMutationCoordinator();
    online(wrongModeCoordinator);
    const wrongMode = wrongModeCoordinator.submit(
      activationSubmission(() => Promise.resolve(activationResult('real'))),
    );
    if (wrongMode.accepted) await wrongMode.completion;
    expect(wrongModeCoordinator.getSnapshot()).toMatchObject({
      phase: 'unresolved',
      mode: 'drill',
      error: { outcomeUnknown: true },
    });
  });

  test('retains a definite failure distinctly from an unknown outcome', async () => {
    const coordinator = new StartMutationCoordinator();
    online(coordinator);
    const admission = coordinator.submit(
      activationSubmission(() =>
        Promise.reject(
          new StartClientError(
            'The activation was rejected before it completed.',
            false,
            false,
          ),
        ),
      ),
    );
    if (admission.accepted) await admission.completion;

    expect(coordinator.getSnapshot()).toEqual({
      phase: 'failed',
      operation: 'activate',
      eventKind: 'drill',
      eventTypeName: 'Practice Lockdown',
      mode: 'drill',
      error: {
        message: 'The activation was rejected before it completed.',
        outcomeUnknown: false,
      },
    });
    expect(coordinator.acknowledge(OWNER)).toBe(true);
  });

  test('reports a pre-transport denial without a key-bearing operation', () => {
    const coordinator = new StartMutationCoordinator();
    online(coordinator);

    expect(
      coordinator.reportDeniedSubmission(
        OWNER,
        {
          operation: 'join',
          eventKind: 'incident',
          eventTypeName: 'Lockdown',
          mode: 'real',
        },
        new OfflineMutationDeniedError(),
      ),
    ).toBe(true);
    expect(coordinator.getSnapshot()).toEqual({
      phase: 'failed',
      operation: 'join',
      eventKind: 'incident',
      eventTypeName: 'Lockdown',
      mode: 'real',
      error: {
        message:
          'Offline — starting an incident and other changes are unavailable. Reconnect, review the consequences, and confirm again. No event was started or joined, and nothing was queued.',
        outcomeUnknown: false,
      },
    });
  });

  test('acknowledges only same-owner terminal state', async () => {
    const coordinator = new StartMutationCoordinator();
    online(coordinator);
    expect(coordinator.acknowledge(OWNER)).toBe(false);
    const admission = coordinator.submit(
      activationSubmission(() => Promise.resolve(activationResult())),
    );
    expect(coordinator.acknowledge(OWNER)).toBe(false);
    if (admission.accepted) await admission.completion;
    expect(coordinator.acknowledge(OTHER_OWNER)).toBe(false);
    expect(coordinator.getSnapshot().phase).toBe('succeeded');
    expect(coordinator.acknowledge(OWNER)).toBe(true);
    expect(coordinator.getSnapshot()).toEqual({ phase: 'idle' });
    expect(coordinator.acknowledge(OWNER)).toBe(false);
  });

  test('claims success feedback once for only the same owner', async () => {
    const coordinator = new StartMutationCoordinator();
    online(coordinator);
    const admission = coordinator.submit(
      activationSubmission(() => Promise.resolve(activationResult())),
    );
    if (admission.accepted) await admission.completion;

    expect(coordinator.claimSuccessFeedback(OTHER_OWNER)).toBeNull();
    expect(coordinator.claimSuccessFeedback(OWNER)).toEqual({
      kind: 'activated',
      eventId: ACTIVATED_EVENT_ID,
      eventKind: 'drill',
      eventTypeName: 'Practice Lockdown',
      mode: 'drill',
    });
    expect(coordinator.claimSuccessFeedback(OWNER)).toBeNull();
    expect(coordinator.getSnapshot().phase).toBe('succeeded');
  });

  test('notifies subscribers for visible transitions and honors unsubscribe', async () => {
    const coordinator = new StartMutationCoordinator();
    const phases: string[] = [];
    online(coordinator);
    const unsubscribe = coordinator.subscribe(() => {
      const snapshot = coordinator.getSnapshot();
      phases.push(
        snapshot.phase === 'pending'
          ? `${snapshot.phase}:${snapshot.visibility}`
          : snapshot.phase,
      );
    });
    const admission = coordinator.submit(
      joinSubmission(() => Promise.resolve(joinResult())),
    );
    if (admission.accepted) await admission.completion;
    expect(phases).toEqual(['pending:owner', 'succeeded']);
    unsubscribe();
    expect(coordinator.acknowledge(OWNER)).toBe(true);
    expect(phases).toEqual(['pending:owner', 'succeeded']);
  });
});

describe('mapStartMutationError', () => {
  test('maps offline denials, safe client failures, and unknown values', () => {
    expect(mapStartMutationError(new OfflineMutationDeniedError())).toEqual({
      message:
        'Offline — starting an incident and other changes are unavailable. Reconnect, review the consequences, and confirm again. No event was started or joined, and nothing was queued.',
      outcomeUnknown: false,
    });
    expect(
      mapStartMutationError(
        new StartClientError('Public server message', false, true),
      ),
    ).toEqual({
      message: 'Public server message',
      outcomeUnknown: true,
    });
    expect(mapStartMutationError(new Error('private bearer detail'))).toEqual({
      message:
        'The outcome is unknown. Check active events before making another decision. Nothing will retry automatically.',
      outcomeUnknown: true,
    });
  });
});
