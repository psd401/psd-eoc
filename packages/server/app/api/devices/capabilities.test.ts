import { describe, expect, test } from 'bun:test';

import type {
  Actor,
  CapabilityInput,
  DeviceEnrollmentPage,
  EndpointStatusRecord,
  PushTokenRegistrationReceipt,
  PushTokenUnregistrationReceipt,
} from '@psd-eoc/contracts';

import {
  type CapabilityAuditEvent,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
  type TrustedCapabilityInvocation,
} from '../../../lib/capabilities/engine';
import {
  EXPO_DEVICE_NOT_REGISTERED_REASON,
  executeDeviceCapability,
  planPushTokenRegistration,
  PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
  type DeviceCapabilityStore,
  type DeviceCapabilityTransaction,
} from '../../../lib/capabilities/devices';

const ids = {
  user: '00000000-0000-4000-8000-000000001201',
  session: '00000000-0000-4000-8000-000000001202',
  epoch: '00000000-0000-4000-8000-000000001203',
  request: '00000000-0000-4000-8000-000000001204',
  device: '00000000-0000-4000-8000-000000001205',
  roster: '00000000-0000-4000-8000-000000001206',
  recipient: '00000000-0000-4000-8000-000000001207',
  endpoint: '00000000-0000-4000-8000-000000001208',
  status: '00000000-0000-4000-8000-000000001209',
  registrationA: '00000000-0000-4000-8000-000000001210',
  registrationB: '00000000-0000-4000-8000-000000001211',
} as const;

const now = new Date('2026-08-11T18:00:00.000Z');
const token = 'ExponentPushToken[synthetic-device-001]';

function humanActor(): Extract<Actor, { kind: 'human' }> {
  return { kind: 'human', userId: ids.user, sessionId: ids.session };
}

function humanInvocation(mutation: boolean): TrustedCapabilityInvocation {
  return {
    actor: humanActor(),
    source: 'mobile',
    scope: { facilityScope: { kind: 'district' } },
    requestId: ids.request,
    serverTime: now,
    connectivityEpochId: ids.epoch,
    mutation: mutation
      ? {
          idempotencyKey: 'device-capability-test-0001',
          transport: {
            kind: 'mobile-interactive',
            interaction: 'explicit-user-submit',
          },
          humanConfirmationId: null,
        }
      : null,
  };
}

function workerInvocation(
  serviceId: string = PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
): TrustedCapabilityInvocation {
  return {
    actor: { kind: 'system', serviceId },
    source: 'worker',
    scope: { facilityScope: { kind: 'district' } },
    requestId: ids.request,
    serverTime: now,
    connectivityEpochId: null,
    mutation: {
      idempotencyKey: 'push-invalidation-test-0001',
      transport: { kind: 'worker-execution' },
      humanConfirmationId: null,
    },
  };
}

class TestDeviceTransaction implements DeviceCapabilityTransaction {
  public readonly completed: CompleteIdempotencyInput[] = [];
  public readonly transactionAudits: CapabilityAuditEvent[] = [];
  public readonly endpointStatusCalls: Array<
    CapabilityInput<'record-endpoint-status'>
  > = [];
  public registrationActor: Extract<Actor, { kind: 'human' }> | null = null;
  public claimedInput: ClaimIdempotencyInput | null = null;

  public async readCurrentTime(): Promise<Date> {
    return now;
  }

  public async claimIdempotency(
    input: ClaimIdempotencyInput,
  ): Promise<IdempotencyClaim> {
    this.claimedInput = input;
    return { kind: 'new', recordId: ids.registrationA };
  }

  public async completeIdempotency(
    input: CompleteIdempotencyInput,
  ): Promise<void> {
    this.completed.push(input);
  }

  public async getHumanConfirmation(): Promise<null> {
    return null;
  }

  public async consumeHumanConfirmation(): Promise<boolean> {
    return false;
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.transactionAudits.push(event);
  }

  public async registerPushToken(
    input: CapabilityInput<'register-push-token'>,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<PushTokenRegistrationReceipt> {
    this.registrationActor = actor;
    return {
      deviceEnrollmentId: input.deviceEnrollmentId,
      platform: input.platform,
      status: 'registered',
    };
  }

  public async unregisterPushToken(
    input: CapabilityInput<'unregister-push-token'>,
  ): Promise<PushTokenUnregistrationReceipt> {
    return {
      deviceEnrollmentId: input.deviceEnrollmentId,
      status: 'unregistered',
    };
  }

  public async listMyDevices(): Promise<DeviceEnrollmentPage> {
    return {
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    };
  }

  public async recordEndpointStatus(
    input: CapabilityInput<'record-endpoint-status'>,
  ): Promise<EndpointStatusRecord> {
    this.endpointStatusCalls.push(input);
    return {
      id: ids.status,
      ...input,
      recordedAt: now.toISOString(),
    };
  }

  public async loadPushTokenRegistrationReplay(): Promise<null> {
    return null;
  }

  public async loadPushTokenUnregistrationReplay(): Promise<null> {
    return null;
  }

  public async loadEndpointStatusReplay(): Promise<null> {
    return null;
  }
}

function testStore(transaction = new TestDeviceTransaction()): {
  readonly failureAudits: CapabilityAuditEvent[];
  readonly store: DeviceCapabilityStore;
  readonly transaction: TestDeviceTransaction;
} {
  const failureAudits: CapabilityAuditEvent[] = [];
  const store: DeviceCapabilityStore = {
    async transaction<Result>(
      operation: (transaction: DeviceCapabilityTransaction) => Promise<Result>,
    ): Promise<Result> {
      return operation(transaction);
    },
    async appendCapabilityAudit(event) {
      failureAudits.push(event);
    },
  };
  return { failureAudits, store, transaction };
}

describe('device capability registration planning', () => {
  test('keeps one identical active token and retires every duplicate or replacement', () => {
    const active = [
      { id: ids.registrationA, token },
      { id: ids.registrationB, token: `${token}-old` },
    ];

    expect(planPushTokenRegistration(active, token)).toEqual({
      keepRegistrationId: ids.registrationA,
      registrationRequired: false,
      unregisterRegistrationIds: [ids.registrationB],
    });
    expect(planPushTokenRegistration(active, `${token}-new`)).toEqual({
      keepRegistrationId: null,
      registrationRequired: true,
      unregisterRegistrationIds: [ids.registrationA, ids.registrationB],
    });
  });

  test('collapses duplicate active rows for the same token deterministically', () => {
    expect(
      planPushTokenRegistration(
        [
          { id: ids.registrationA, token },
          { id: ids.registrationB, token },
        ],
        token,
      ),
    ).toEqual({
      keepRegistrationId: ids.registrationA,
      registrationRequired: false,
      unregisterRegistrationIds: [ids.registrationB],
    });
  });
});

describe('canonical device capabilities', () => {
  test('registers for the actor session and keeps token material out of durable metadata', async () => {
    const { store, transaction } = testStore();
    const result = await executeDeviceCapability(
      'register-push-token',
      { deviceEnrollmentId: ids.device, platform: 'ios', token },
      humanInvocation(true),
      store,
    );

    expect(result).toEqual({
      deviceEnrollmentId: ids.device,
      platform: 'ios',
      status: 'registered',
    });
    expect(transaction.registrationActor).toEqual(humanActor());
    expect(transaction.completed).toHaveLength(1);
    expect(JSON.stringify(transaction.completed)).not.toContain(token);
    expect(JSON.stringify(transaction.transactionAudits)).not.toContain(token);
    expect(transaction.completed[0]?.resultReference).toBe(
      `push-registration:${ids.device}:ios`,
    );
  });

  test('allows only the dedicated worker to record the fixed Expo invalidation', async () => {
    const input = {
      rosterSnapshotId: ids.roster,
      recipientId: ids.recipient,
      endpointId: ids.endpoint,
      status: 'invalid' as const,
      reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
    };
    const accepted = testStore();

    await expect(
      executeDeviceCapability(
        'record-endpoint-status',
        input,
        workerInvocation(),
        accepted.store,
      ),
    ).resolves.toMatchObject(input);
    expect(accepted.transaction.endpointStatusCalls).toEqual([input]);

    const denied = testStore();
    await expect(
      executeDeviceCapability(
        'record-endpoint-status',
        input,
        workerInvocation('some-other-worker'),
        denied.store,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
      status: 403,
    });
    expect(denied.transaction.endpointStatusCalls).toHaveLength(0);
    expect(denied.failureAudits.at(-1)).toMatchObject({
      outcome: 'denied',
      action: 'record-endpoint-status',
    });
  });

  test('denies broad endpoint status inputs even to the dedicated worker', async () => {
    const { store, transaction } = testStore();
    await expect(
      executeDeviceCapability(
        'record-endpoint-status',
        {
          rosterSnapshotId: ids.roster,
          recipientId: ids.recipient,
          endpointId: ids.endpoint,
          status: 'disabled',
          reasonCode: 'ARBITRARY_DISABLE',
        },
        workerInvocation(),
        store,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(transaction.endpointStatusCalls).toHaveLength(0);
  });
});
