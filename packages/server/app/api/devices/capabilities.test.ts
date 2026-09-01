import { describe, expect, test } from 'bun:test';

import {
  DispatchBatchSchema,
  EndpointStatusRecordSchema,
  RosterSnapshotSchema,
  type Actor,
  type CapabilityInput,
  type DeviceEnrollmentPage,
  type EndpointStatusRecord,
  type PushTokenRegistrationReceipt,
  type PushTokenUnregistrationReceipt,
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
  createDrizzlePushEndpointPolicyStore,
  executeDeviceCapability,
  planPushTokenRegistration,
  PUSH_ENDPOINT_INVALIDATION_SERVICE_ID,
  PushEndpointResolutionError,
  resolvePushEndpointPage,
  resolvePushEndpoints,
  type DeviceCapabilityStore,
  type DeviceCapabilityTransaction,
  type PushEndpointPolicyQuery,
  type PushEndpointPolicyStore,
} from '../../../lib/capabilities/devices';
import type { Database } from '../../../db/client';

const ids = {
  user: '00000000-0000-4000-8000-000000001201',
  session: '00000000-0000-4000-8000-000000001202',
  epoch: '00000000-0000-4000-8000-000000001203',
  request: '00000000-0000-4000-8000-000000001204',
  device: '00000000-0000-4000-8000-000000001205',
  roster: '00000000-0000-4000-8000-000000001206',
  recipient: '00000000-0000-4000-8000-000000001207',
  endpoint: '00000000-0000-4000-8000-000000001208',
  ordinaryRecipient: '00000000-0000-4000-8000-000000001212',
  ordinaryEndpoint: '00000000-0000-4000-8000-000000001213',
  deliveryTargetSet: '00000000-0000-4000-8000-000000001214',
  confirmation: '00000000-0000-4000-8000-000000001215',
  status: '00000000-0000-4000-8000-000000001209',
  registrationA: '00000000-0000-4000-8000-000000001210',
  registrationB: '00000000-0000-4000-8000-000000001211',
} as const;

const now = new Date('2026-08-11T18:00:00.000Z');
const token = 'ExponentPushToken[synthetic-device-001]';
const build = Object.freeze({
  applicationId: 'example.synthetic.eoc',
  applicationVersion: '1.0.4',
  nativeBuildVersion: '7',
  expoProjectId: '00000000-0000-4000-8000-000000001299',
  updateMode: 'embedded-only' as const,
});
const registrationInput = Object.freeze({
  deviceEnrollmentId: ids.device,
  platform: 'ios' as const,
  provider: 'expo' as const,
  serviceEnvironment: 'production' as const,
  build,
  token,
});

const resolutionIds = Object.freeze({
  facility: '00000000-0000-4000-8000-000000001230',
  audience: '00000000-0000-4000-8000-000000001231',
  group: '00000000-0000-4000-8000-000000001232',
  configuration: '00000000-0000-4000-8000-000000001233',
  preview: '00000000-0000-4000-8000-000000001234',
  eventType: '00000000-0000-4000-8000-000000001235',
  event: '00000000-0000-4000-8000-000000001236',
  intent: '00000000-0000-4000-8000-000000001237',
  batch: '00000000-0000-4000-8000-000000001238',
});

const resolutionGroup = Object.freeze({
  id: resolutionIds.group,
  kind: 'synthetic' as const,
  purpose: 'building' as const,
  facilityId: resolutionIds.facility,
});

const resolutionRoster = RosterSnapshotSchema.parse({
  id: ids.roster,
  version: 1,
  population: 'synthetic',
  complete: true,
  sourceConfiguration: { id: resolutionIds.configuration, version: 1 },
  facilityIds: [resolutionIds.facility],
  expectedSourceGroupRefs: [resolutionGroup],
  sourceGroupRefs: [resolutionGroup],
  recipients: [
    {
      id: ids.recipient,
      population: 'synthetic',
      googleSubject: null,
      displayName: 'Synthetic push staff',
      groupSourceRefs: [resolutionGroup],
      endpoints: [
        {
          id: ids.endpoint,
          channel: 'push',
          status: 'active',
          capturedAt: now.toISOString(),
          platform: 'ios',
          provider: 'expo',
          serviceEnvironment: 'production',
          token: 'synthetic-unroutable:push-device-resolution',
        },
      ],
    },
  ],
  syncStartedAt: now.toISOString(),
  capturedAt: now.toISOString(),
});

function resolutionBatch(endpointCount = 1) {
  return DispatchBatchSchema.parse({
    id: resolutionIds.batch,
    intentId: resolutionIds.intent,
    eventId: resolutionIds.event,
    facilityId: resolutionIds.facility,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: resolutionIds.eventType,
      templateMode: 'drill',
    },
    rosterSnapshotId: ids.roster,
    rosterPopulation: 'synthetic',
    requestId: ids.request,
    authorization: {
      kind: 'synthetic-training',
      activationPreviewId: resolutionIds.preview,
      consequenceDigest: 'a'.repeat(64),
      requestId: ids.request,
    },
    channel: 'push',
    renderedMessage: {
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'push',
      title: '[DRILL] Synthetic push test',
      body: '[DRILL] Synthetic training only.',
    },
    integrationStatus: {
      integrationId: 'expo-push',
      label: 'mocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt: now.toISOString(),
    },
    sequence: 1,
    endpointCount,
    createdAt: now.toISOString(),
  });
}

function resolutionInput(endpointCount = 1) {
  return {
    batch: resolutionBatch(endpointCount),
    audience: {
      facilityId: resolutionIds.facility,
      rosterSnapshot: resolutionRoster,
    },
  };
}

function deliveryTestPushResolutionInput() {
  const staffGroup = Object.freeze({
    ...resolutionGroup,
    kind: 'google-group' as const,
  });
  const rosterSnapshot = RosterSnapshotSchema.parse({
    ...resolutionRoster,
    population: 'staff',
    expectedSourceGroupRefs: [staffGroup],
    sourceGroupRefs: [staffGroup],
    recipients: [
      {
        id: ids.recipient,
        population: 'staff',
        googleSubject: 'synthetic-approved-canary-subject',
        displayName: 'Approved synthetic canary fixture',
        groupSourceRefs: [staffGroup],
        endpoints: [
          {
            id: ids.endpoint,
            channel: 'push',
            status: 'active',
            capturedAt: now.toISOString(),
            platform: 'ios',
            provider: 'expo',
            serviceEnvironment: 'production',
            token: 'ExponentPushToken[approved-synthetic-canary-fixture]',
          },
        ],
      },
      {
        id: ids.ordinaryRecipient,
        population: 'staff',
        googleSubject: 'synthetic-ordinary-staff-subject',
        displayName: 'Ordinary synthetic staff fixture',
        groupSourceRefs: [staffGroup],
        endpoints: [
          {
            id: ids.ordinaryEndpoint,
            channel: 'push',
            status: 'active',
            capturedAt: now.toISOString(),
            platform: 'android',
            provider: 'expo',
            serviceEnvironment: 'production',
            token: 'ExponentPushToken[ordinary-staff-must-not-send]',
          },
        ],
      },
    ],
  });
  const deliveryTest = Object.freeze({
    purpose: 'monthly-live-delivery-test' as const,
    targetSet: { id: ids.deliveryTargetSet, version: 1 },
    endpointReferenceDigest: 'd'.repeat(64),
  });
  const batch = DispatchBatchSchema.parse({
    ...resolutionBatch(),
    eventKind: 'drill',
    rosterPopulation: 'staff',
    deliveryTest,
    authorization: {
      kind: 'human-confirmed',
      activationPreviewId: resolutionIds.preview,
      preparedActivationId: null,
      confirmationId: ids.confirmation,
      consequenceDigest: 'b'.repeat(64),
      requestId: ids.request,
    },
    renderedMessage: {
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'push',
      title: '[DRILL] Live canary test',
      body: '[DRILL] LIVE CANARY — TRAINING ONLY.',
    },
    integrationStatus: {
      integrationId: 'expo-push',
      label: 'live-verified',
      verifiedAt: now.toISOString(),
      verifiedByUserId: ids.user,
      authorizationReference: 'synthetic-live-verification-reference',
      reasonCode: null,
      observedAt: now.toISOString(),
    },
    endpointCount: 1,
  });
  return Object.freeze({
    deliveryTest,
    input: Object.freeze({
      batch,
      audience: Object.freeze({
        facilityId: resolutionIds.facility,
        rosterSnapshot,
      }),
    }),
  });
}

function supersededTargetDatabase(target: Readonly<Record<string, unknown>>) {
  const queuedRows: readonly (readonly unknown[])[] = [
    [{ facilityId: resolutionIds.facility }],
    [target],
    [{ id: '00000000-0000-4000-8000-000000001239' }],
  ];
  let selectCalls = 0;
  let executeCalls = 0;
  let transactionCalls = 0;
  const queryDatabase = {
    select() {
      const rows = queuedRows[selectCalls] ?? [];
      selectCalls += 1;
      const builder = {
        from() {
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return Promise.resolve(rows);
        },
      };
      return builder;
    },
    execute() {
      executeCalls += 1;
      return Promise.resolve([]);
    },
  };
  const database = {
    ...queryDatabase,
    transaction<Result>(
      operation: (transaction: typeof queryDatabase) => Promise<Result>,
    ) {
      transactionCalls += 1;
      return operation(queryDatabase);
    },
  } as unknown as Database;
  return Object.freeze({
    database,
    executeCalls: () => executeCalls,
    selectCalls: () => selectCalls,
    transactionCalls: () => transactionCalls,
  });
}

class PushPolicyStore implements PushEndpointPolicyStore {
  public readonly queries: PushEndpointPolicyQuery[] = [];

  public constructor(
    private readonly status: 'active' | 'disabled' | 'invalid' = 'active',
    private readonly approvedEndpointIds: ReadonlySet<string> | null = null,
  ) {}

  public loadEndpointPolicy(query: PushEndpointPolicyQuery): Promise<unknown> {
    this.queries.push(query);
    return Promise.resolve(
      query.candidates.map((candidate) => ({
        ...candidate,
        status: this.status,
        approvedForDeliveryTest:
          query.deliveryTest === null ||
          this.approvedEndpointIds === null ||
          this.approvedEndpointIds.has(candidate.endpointId),
      })),
    );
  }
}

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
  public idempotencyClaim: IdempotencyClaim = {
    kind: 'new',
    recordId: ids.registrationA,
  };
  public endpointStatusReplay: EndpointStatusRecord | null = null;
  public endpointStatusReplayLoads = 0;

  public async readCurrentTime(): Promise<Date> {
    return now;
  }

  public async claimIdempotency(
    input: ClaimIdempotencyInput,
  ): Promise<IdempotencyClaim> {
    this.claimedInput = input;
    return this.idempotencyClaim;
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
      provider: input.provider,
      serviceEnvironment: input.serviceEnvironment,
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
    if (input.reasonCode === 'APNS_UNREGISTERED') {
      return EndpointStatusRecordSchema.parse({
        id: ids.status,
        rosterSnapshotId: input.rosterSnapshotId,
        recipientId: input.recipientId,
        endpointId: input.endpointId,
        status: input.status,
        reasonCode: input.reasonCode,
        recordedAt: now.toISOString(),
      });
    }
    return EndpointStatusRecordSchema.parse({
      id: ids.status,
      ...input,
      recordedAt: now.toISOString(),
    });
  }

  public async loadPushTokenRegistrationReplay(): Promise<null> {
    return null;
  }

  public async loadPushTokenUnregistrationReplay(): Promise<null> {
    return null;
  }

  public async loadEndpointStatusReplay(): Promise<EndpointStatusRecord | null> {
    this.endpointStatusReplayLoads += 1;
    return this.endpointStatusReplay;
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
      { id: ids.registrationA, provider: 'expo', token },
      { id: ids.registrationB, provider: 'expo', token: `${token}-old` },
      { id: ids.endpoint, provider: 'apns', token: `${token}-native` },
    ];

    expect(planPushTokenRegistration(active, token, 'expo')).toEqual({
      keepRegistrationId: ids.registrationA,
      registrationRequired: false,
      unregisterRegistrationIds: [ids.registrationB],
    });
    expect(planPushTokenRegistration(active, `${token}-new`, 'expo')).toEqual({
      keepRegistrationId: null,
      registrationRequired: true,
      unregisterRegistrationIds: [ids.registrationA, ids.registrationB],
    });
  });

  test('collapses duplicate active rows for the same token deterministically', () => {
    expect(
      planPushTokenRegistration(
        [
          { id: ids.registrationA, provider: 'expo', token },
          { id: ids.registrationB, provider: 'expo', token },
        ],
        token,
        'expo',
      ),
    ).toEqual({
      keepRegistrationId: ids.registrationA,
      registrationRequired: false,
      unregisterRegistrationIds: [ids.registrationB],
    });
  });
});

describe('pinned push endpoint resolution', () => {
  test('overlays current endpoint status before exposing a pinned token', async () => {
    const activeStore = new PushPolicyStore();
    await expect(
      resolvePushEndpoints(resolutionInput(), activeStore),
    ).resolves.toEqual([
      expect.objectContaining({
        rosterSnapshotId: ids.roster,
        rosterPopulation: 'synthetic',
        recipientId: ids.recipient,
        endpoint: expect.objectContaining({
          id: ids.endpoint,
          channel: 'push',
        }),
      }),
    ]);
    expect(activeStore.queries).toEqual([
      {
        rosterSnapshotId: ids.roster,
        rosterPopulation: 'synthetic',
        endpointCount: 1,
        deliveryTest: null,
        candidates: [{ recipientId: ids.recipient, endpointId: ids.endpoint }],
        // The batch's creation instant, so the policy reads live devices as
        // of the same moment the audience was resolved.
        asOf: now.toISOString(),
      },
    ]);
    expect(JSON.stringify(activeStore.queries)).not.toContain(
      'synthetic-unroutable',
    );

    await expect(
      resolvePushEndpoints(resolutionInput(), new PushPolicyStore('invalid')),
    ).resolves.toEqual([]);
    await expect(
      resolvePushEndpoints(resolutionInput(), new PushPolicyStore('disabled')),
    ).resolves.toEqual([]);
  });

  test('fails closed on incomplete, extra, accessor, cross-bound, or rejected status evidence', async () => {
    const failures: PushEndpointPolicyStore[] = [
      { loadEndpointPolicy: () => Promise.resolve([]) },
      {
        loadEndpointPolicy: (query) =>
          Promise.resolve([
            { ...query.candidates[0], status: 'active', extra: true },
          ]),
      },
      {
        loadEndpointPolicy: (query) =>
          Promise.resolve([
            Object.defineProperty(
              {
                ...query.candidates[0],
                endpointId: ids.endpoint,
              },
              'status',
              { enumerable: true, get: () => 'active' },
            ),
          ]),
      },
      {
        loadEndpointPolicy: (query) =>
          Promise.resolve([
            {
              recipientId: ids.user,
              endpointId: query.candidates[0]?.endpointId,
              status: 'active',
            },
          ]),
      },
      {
        loadEndpointPolicy: () =>
          Promise.reject(new Error('synthetic store outage')),
      },
    ];
    for (const store of failures) {
      await expect(
        resolvePushEndpoints(resolutionInput(), store),
      ).rejects.toMatchObject({
        code: 'INVALID_PUSH_ENDPOINT_POLICY',
      });
    }
  });

  test('rejects an audience smaller than the batch was planned for before reading policy state', async () => {
    const store = new PushPolicyStore();
    await expect(
      resolvePushEndpoints(resolutionInput(2), store),
    ).rejects.toBeInstanceOf(PushEndpointResolutionError);
    await expect(
      resolvePushEndpoints(resolutionInput(2), store),
    ).rejects.toMatchObject({ code: 'PUSH_ENDPOINT_COUNT_MISMATCH' });
    expect(store.queries).toEqual([]);
  });

  test('accepts an audience that grew past the planned count and asks policy about every endpoint it holds', async () => {
    // Devices enrolled after the roster was published join the audience at
    // send time. The batch's planned count is a floor, not an exact match, and
    // the policy is asked about what the audience actually holds.
    const store = new PushPolicyStore();
    const resolved = await resolvePushEndpoints(resolutionInput(0), store);
    expect(resolved).toHaveLength(1);
    expect(store.queries).toHaveLength(1);
    expect(store.queries[0]).toMatchObject({
      endpointCount: 1,
      deliveryTest: null,
    });
  });

  test('returns only the approved canary endpoint from a staff audience', async () => {
    const { deliveryTest, input } = deliveryTestPushResolutionInput();
    const store = new PushPolicyStore('active', new Set([ids.endpoint]));

    const resolved = await resolvePushEndpoints(input, store);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.recipientId).toBe(ids.recipient);
    expect(resolved[0]?.endpoint.id).toBe(ids.endpoint);
    expect(JSON.stringify(resolved)).not.toContain(
      'ordinary-staff-must-not-send',
    );
    expect(store.queries[0]).toMatchObject({
      rosterPopulation: 'staff',
      endpointCount: 1,
      deliveryTest,
      candidates: [
        { recipientId: ids.recipient, endpointId: ids.endpoint },
        {
          recipientId: ids.ordinaryRecipient,
          endpointId: ids.ordinaryEndpoint,
        },
      ],
    });
  });

  test('pages immutable candidates before mutable eligibility filtering', async () => {
    const { input } = deliveryTestPushResolutionInput();
    const store = new PushPolicyStore(
      'active',
      new Set([ids.ordinaryEndpoint]),
    );

    await expect(resolvePushEndpointPage(input, store, 0, 1)).resolves.toEqual({
      endpoints: [],
      nextCursor: 1,
    });
    await expect(resolvePushEndpointPage(input, store, 1, 1)).resolves.toEqual({
      endpoints: [
        expect.objectContaining({
          recipientId: ids.ordinaryRecipient,
          endpoint: expect.objectContaining({ id: ids.ordinaryEndpoint }),
        }),
      ],
      nextCursor: null,
    });
  });

  test('rejects a superseded target under the facility lock before exposing a token', async () => {
    const { deliveryTest, input } = deliveryTestPushResolutionInput();
    const fixture = supersededTargetDatabase({
      id: deliveryTest.targetSet.id,
      version: deliveryTest.targetSet.version,
      facilityId: resolutionIds.facility,
      rosterSnapshotId: ids.roster,
      rosterPopulation: 'staff',
      endpointReferenceDigest: deliveryTest.endpointReferenceDigest,
    });
    const store = createDrizzlePushEndpointPolicyStore(fixture.database);
    let releasedTokens: readonly string[] | undefined;
    let providerCalls = 0;

    await expect(
      resolvePushEndpoints(input, store).then((resolved) => {
        releasedTokens = resolved.map(({ endpoint }) => endpoint.token);
        providerCalls += resolved.length;
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PUSH_ENDPOINT_POLICY' });

    expect(releasedTokens).toBeUndefined();
    expect(providerCalls).toBe(0);
    expect(fixture.transactionCalls()).toBe(1);
    expect(fixture.executeCalls()).toBe(1);
    expect(fixture.selectCalls()).toBe(3);
  });
});

describe('canonical device capabilities', () => {
  test('rejects a direct registration without its atomic Expo fallback', async () => {
    const { store, transaction } = testStore();

    await expect(
      executeDeviceCapability(
        'register-push-token',
        {
          ...registrationInput,
          provider: 'apns',
          token: 'synthetic-apns-token-material',
        },
        humanInvocation(true),
        store,
      ),
    ).rejects.toThrow();
    expect(transaction.claimedInput).toBeNull();
    expect(transaction.registrationActor).toBeNull();
  });

  test('registers for the actor session and keeps token material out of durable metadata', async () => {
    const { store, transaction } = testStore();
    const nativeToken = 'synthetic-apns-token-material';
    const result = await executeDeviceCapability(
      'register-push-token',
      {
        ...registrationInput,
        provider: 'apns',
        token: nativeToken,
        expoFallbackToken: token,
      },
      humanInvocation(true),
      store,
    );

    expect(result).toEqual({
      deviceEnrollmentId: ids.device,
      platform: 'ios',
      provider: 'apns',
      serviceEnvironment: 'production',
      status: 'registered',
    });
    expect(transaction.registrationActor).toEqual(humanActor());
    expect(transaction.completed).toHaveLength(1);
    expect(JSON.stringify(transaction.completed)).not.toContain(token);
    expect(JSON.stringify(transaction.completed)).not.toContain(nativeToken);
    expect(JSON.stringify(transaction.transactionAudits)).not.toContain(token);
    expect(JSON.stringify(transaction.transactionAudits)).not.toContain(
      nativeToken,
    );
    expect(transaction.completed[0]?.resultReference).toBe(
      `push-registration:${ids.device}:ios:apns:production`,
    );
  });

  test('registers a push token for any authenticated staff device', async () => {
    // The exact-build allowlist that used to gate this is gone: it had to be
    // hand-edited for every release and silently broke push for every device
    // on a build nobody remembered to add.
    const allowed = testStore();
    await executeDeviceCapability(
      'register-push-token',
      registrationInput,
      humanInvocation(true),
      allowed.store,
    );
    expect(allowed.transaction.registrationActor).not.toBeNull();
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

  test('re-authorizes the dedicated worker before returning a completed replay', async () => {
    const input = {
      rosterSnapshotId: ids.roster,
      recipientId: ids.recipient,
      endpointId: ids.endpoint,
      status: 'invalid' as const,
      reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
    };
    const { store, transaction } = testStore();
    const output = await executeDeviceCapability(
      'record-endpoint-status',
      input,
      workerInvocation(),
      store,
    );
    const claimedInput = transaction.claimedInput;
    expect(claimedInput).not.toBeNull();
    if (claimedInput === null) throw new Error('Expected idempotency claim.');

    transaction.idempotencyClaim = {
      kind: 'completed',
      requestDigest: claimedInput.requestDigest,
      resultReference: `endpoint-status:${output.id}`,
    };
    transaction.endpointStatusReplay = output;
    const webhookInvocation: TrustedCapabilityInvocation = {
      ...workerInvocation(),
      source: 'webhook',
      mutation: {
        ...workerInvocation().mutation!,
        transport: { kind: 'webhook-delivery' },
      },
    };

    await expect(
      executeDeviceCapability(
        'record-endpoint-status',
        input,
        webhookInvocation,
        store,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
      status: 403,
    });
    expect(transaction.endpointStatusReplayLoads).toBe(0);
  });

  test('rejects confirmation metadata before returning a completed worker replay', async () => {
    const input = {
      rosterSnapshotId: ids.roster,
      recipientId: ids.recipient,
      endpointId: ids.endpoint,
      status: 'invalid' as const,
      reasonCode: EXPO_DEVICE_NOT_REGISTERED_REASON,
    };
    const { store, transaction } = testStore();
    const output = await executeDeviceCapability(
      'record-endpoint-status',
      input,
      workerInvocation(),
      store,
    );
    const claimedInput = transaction.claimedInput;
    expect(claimedInput).not.toBeNull();
    if (claimedInput === null) throw new Error('Expected idempotency claim.');

    transaction.idempotencyClaim = {
      kind: 'completed',
      requestDigest: claimedInput.requestDigest,
      resultReference: `endpoint-status:${output.id}`,
    };
    transaction.endpointStatusReplay = output;
    const replayInvocation = workerInvocation();
    const confirmedInvocation: TrustedCapabilityInvocation = {
      ...replayInvocation,
      mutation: {
        ...replayInvocation.mutation!,
        humanConfirmationId: ids.status,
      },
    };

    await expect(
      executeDeviceCapability(
        'record-endpoint-status',
        input,
        confirmedInvocation,
        store,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
      status: 403,
    });
    expect(transaction.endpointStatusReplayLoads).toBe(0);
  });
});
