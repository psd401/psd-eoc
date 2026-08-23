import { describe, expect, test } from 'bun:test';

import {
  ActivationPreviewSchema,
  DeliveryTestPreviewSchema,
  DeliveryTestRunSchema,
  DeliveryTestTargetSetVersionSchema,
  HumanConfirmationSchema,
  type DeliveryTestPreview,
  type DeliveryTestTargetSetVersion,
  type HumanConfirmation,
  type IntegrationStatus,
  type StartEventInput,
  type StartEventResult,
} from '@psd-eoc/contracts';

import type { TrustedCapabilityInvocation } from '../capabilities/engine';
import {
  DeliveryTestSafetyError,
  assembleDeliveryTestChannelReport,
  assembleMonthlyDeliveryTestReport,
  deliveryTestEndpointReferenceDigest,
  executeMonthlyDeliveryTest,
  type DeliveryTestExecutionDependencies,
  type ResolvedDeliveryTestAudience,
} from './e2e-delivery';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  facility: uuid(1),
  roster: uuid(2),
  targetSet: uuid(3),
  eventType: uuid(4),
  audience: uuid(5),
  preview: uuid(6),
  recipient: uuid(7),
  pushEndpoint: uuid(8),
  emailEndpoint: uuid(9),
  approver: uuid(10),
  approvalSession: uuid(11),
  human: uuid(12),
  session: uuid(13),
  otherSession: uuid(14),
  connectivityEpoch: uuid(15),
  confirmation: uuid(16),
  request: uuid(17),
  event: uuid(18),
  intent: uuid(19),
  run: uuid(20),
  report: uuid(21),
  previousReport: uuid(22),
  extraEndpoint: uuid(23),
  agent: uuid(24),
  apiKey: uuid(25),
  pushEligibilityFact: uuid(26),
  emailEligibilityFact: uuid(27),
});

const TIMES = Object.freeze({
  optedIn: '2026-08-13T17:50:00.000Z',
  attested: '2026-08-13T17:55:00.000Z',
  targetCreated: '2026-08-13T17:58:00.000Z',
  approved: '2026-08-13T17:59:00.000Z',
  previewCreated: '2026-08-13T18:00:00.000Z',
  confirmationIssued: '2026-08-13T18:00:30.000Z',
  now: '2026-08-13T18:01:00.000Z',
  confirmationExpires: '2026-08-13T18:04:00.000Z',
  previewExpires: '2026-08-13T18:05:00.000Z',
  completed: '2026-08-13T18:01:04.000Z',
  generated: '2026-08-13T18:01:05.000Z',
});

const CONSEQUENCE_DIGEST = 'c'.repeat(64);

function endpointReferences() {
  return [
    {
      recipientId: IDS.recipient,
      endpointId: IDS.pushEndpoint,
      channel: 'push' as const,
    },
    {
      recipientId: IDS.recipient,
      endpointId: IDS.emailEndpoint,
      channel: 'email' as const,
    },
  ];
}

function targetSet(): DeliveryTestTargetSetVersion {
  const refs = endpointReferences();
  return DeliveryTestTargetSetVersionSchema.parse({
    id: IDS.targetSet,
    version: 1,
    facilityId: IDS.facility,
    rosterSnapshotId: IDS.roster,
    supersedesVersionId: null,
    endpoints: refs.map((reference) => ({
      ...reference,
      eligibilityFactId:
        reference.channel === 'push'
          ? IDS.pushEligibilityFact
          : IDS.emailEligibilityFact,
      attestation: 'approved-synthetic-canary',
      optedInAt: TIMES.optedIn,
      attestedAt: TIMES.attested,
      attestedByUserId: IDS.approver,
      authorizationReference: 'product-owner-approved-canary-v1',
    })),
    endpointReferenceDigest: deliveryTestEndpointReferenceDigest(refs),
    approvedByUserId: IDS.approver,
    approvedWithSessionId: IDS.approvalSession,
    approvedAt: TIMES.approved,
    createdAt: TIMES.targetCreated,
  });
}

function integrationStatus(
  integrationId: 'expo-push' | 'ses-email',
): IntegrationStatus {
  return {
    integrationId,
    label: 'live-verified',
    verifiedAt: TIMES.targetCreated,
    verifiedByUserId: IDS.approver,
    authorizationReference: 'live-verification-record-v1',
    reasonCode: null,
    observedAt: TIMES.approved,
  };
}

function activationChannels() {
  return [
    {
      channel: 'push' as const,
      endpointCount: 1,
      renderedMessage: {
        channel: 'push' as const,
        eventKind: 'drill' as const,
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        classificationMarker: 'DRILL' as const,
        title: '[DRILL] Monthly controlled delivery test',
        body: '[DRILL] Monthly controlled delivery test.',
      },
      integrationStatus: integrationStatus('expo-push'),
    },
    {
      channel: 'email' as const,
      endpointCount: 1,
      renderedMessage: {
        channel: 'email' as const,
        eventKind: 'drill' as const,
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        classificationMarker: 'DRILL' as const,
        subject: '[DRILL] Monthly controlled delivery test',
        textBody: '[DRILL] Monthly controlled delivery test.',
      },
      integrationStatus: integrationStatus('ses-email'),
    },
  ];
}

function deliveryTestPreview(): DeliveryTestPreview {
  const approvedTargets = targetSet();
  const metadata = {
    purpose: 'monthly-live-delivery-test' as const,
    targetSet: { id: approvedTargets.id, version: approvedTargets.version },
    endpointReferenceDigest: approvedTargets.endpointReferenceDigest,
  };
  const channels = activationChannels();
  const activationPreview = ActivationPreviewSchema.parse({
    id: IDS.preview,
    facilityId: IDS.facility,
    kind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: { id: IDS.eventType, templateMode: 'drill' },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'staff',
    recipientCount: 1,
    channels,
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    activeEventIds: [],
    deliveryTest: metadata,
    consequenceDigest: CONSEQUENCE_DIGEST,
    createdAt: TIMES.previewCreated,
    expiresAt: TIMES.previewExpires,
  });
  return DeliveryTestPreviewSchema.parse({
    purpose: 'monthly-live-delivery-test',
    activationPreview,
    targetSet: metadata.targetSet,
    endpointReferenceDigest: metadata.endpointReferenceDigest,
    channels: channels.map((channel) => ({
      channel: channel.channel,
      endpointCount: channel.endpointCount,
      integrationStatus: channel.integrationStatus,
      credentialVerified: true,
    })),
    consequenceDigest: CONSEQUENCE_DIGEST,
    createdAt: TIMES.previewCreated,
    expiresAt: TIMES.previewExpires,
  });
}

function confirmation(
  input: Readonly<{
    sessionId?: string;
    expiresAt?: string;
    consequenceDigest?: string;
  }> = {},
): HumanConfirmation {
  return HumanConfirmationSchema.parse({
    id: IDS.confirmation,
    capabilityId: 'start-event',
    actionIds: ['send-real-notification'],
    connectivityEpochId: IDS.connectivityEpoch,
    confirmedByUserId: IDS.human,
    confirmedWithSessionId: input.sessionId ?? IDS.session,
    consequenceDigest: input.consequenceDigest ?? CONSEQUENCE_DIGEST,
    issuedAt: TIMES.confirmationIssued,
    expiresAt: input.expiresAt ?? TIMES.confirmationExpires,
  });
}

function humanInvocation(
  source: 'web' | 'mobile' = 'web',
): TrustedCapabilityInvocation {
  return {
    actor: { kind: 'human', userId: IDS.human, sessionId: IDS.session },
    source,
    scope: {
      facilityScope: { kind: 'facilities', facilityIds: [IDS.facility] },
    },
    requestId: IDS.request,
    serverTime: new Date(TIMES.now),
    connectivityEpochId: IDS.connectivityEpoch,
    mutation: {
      idempotencyKey: 'monthly-delivery-test-start-0001',
      transport:
        source === 'web'
          ? {
              kind: 'web-interactive',
              method: 'POST',
              interaction: 'explicit-user-submit',
              csrfVerified: true,
            }
          : {
              kind: 'mobile-interactive',
              interaction: 'explicit-user-submit',
            },
      humanConfirmationId: IDS.confirmation,
    },
  };
}

function startEventInput(): StartEventInput {
  return {
    source: 'activation-preview',
    activationPreviewId: IDS.preview,
    activeEventDecision: {
      decision: 'start-new',
      activeEventIdsSeen: [],
    },
  };
}

function canonicalActivationResult(
  preview: DeliveryTestPreview,
  authorization: HumanConfirmation,
): StartEventResult {
  return {
    event: {
      id: IDS.event,
      kind: 'drill',
      templateMode: 'drill',
      rosterPopulation: 'staff',
      activatedAt: TIMES.now,
      activationAuthorization: {
        kind: 'human-confirmed',
        activationPreviewId: preview.activationPreview.id,
        confirmationId: authorization.id,
      },
    },
    notificationIntent: {
      id: IDS.intent,
      deliveryTest: preview.activationPreview.deliveryTest,
    },
  } as unknown as StartEventResult;
}

interface Fixture {
  readonly preview: DeliveryTestPreview;
  readonly confirmation: HumanConfirmation;
  readonly invocation: TrustedCapabilityInvocation;
  readonly startInput: StartEventInput;
  resolved: ResolvedDeliveryTestAudience;
  executorCalls: number;
  resolverCalls: number;
  readonly dependencies: DeliveryTestExecutionDependencies;
}

function fixture(source: 'web' | 'mobile' = 'web'): Fixture {
  const preview = deliveryTestPreview();
  const approvedTargets = targetSet();
  const authorization = confirmation();
  const state = {
    preview,
    confirmation: authorization,
    invocation: humanInvocation(source),
    startInput: startEventInput(),
    resolved: {
      targetSet: approvedTargets,
      activeEndpointRefs: endpointReferences(),
    },
    executorCalls: 0,
    resolverCalls: 0,
  };
  const dependencies: DeliveryTestExecutionDependencies = {
    resolveAudience: async () => {
      state.resolverCalls += 1;
      return state.resolved;
    },
    executeStartEvent: async () => {
      state.executorCalls += 1;
      return canonicalActivationResult(state.preview, state.confirmation);
    },
    createRunId: () => IDS.run,
  };
  return Object.assign(state, { dependencies });
}

async function execute(value: Fixture) {
  return executeMonthlyDeliveryTest(
    {
      preview: value.preview,
      confirmation: value.confirmation,
      startEventInput: value.startInput,
      invocation: value.invocation,
    },
    value.dependencies,
  );
}

function expectDeniedBeforeStart(value: Fixture): void {
  expect(value.executorCalls).toBe(0);
}

describe('monthly live delivery-test safety harness', () => {
  test('recomputes a stable destination-free digest over sorted opaque refs', () => {
    const refs = endpointReferences();
    const forward = deliveryTestEndpointReferenceDigest(refs);
    const reverse = deliveryTestEndpointReferenceDigest([...refs].reverse());

    expect(forward).toBe(reverse);
    expect(forward).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      deliveryTestEndpointReferenceDigest([refs[0]!, refs[0]!, refs[1]!]),
    ).toThrow(DeliveryTestSafetyError);
  });

  for (const source of ['web', 'mobile'] as const) {
    test(`delegates a valid ${source} run exactly once to canonical start-event`, async () => {
      const value = fixture(source);
      const result = await execute(value);

      expect(value.resolverCalls).toBe(1);
      expect(value.executorCalls).toBe(1);
      expect(result.run).toEqual(
        DeliveryTestRunSchema.parse({
          id: IDS.run,
          activationPreviewId: IDS.preview,
          eventId: IDS.event,
          notificationIntentId: IDS.intent,
          targetSet: { id: IDS.targetSet, version: 1 },
          endpointReferenceDigest: targetSet().endpointReferenceDigest,
          consequenceDigest: CONSEQUENCE_DIGEST,
          confirmationId: IDS.confirmation,
          startedByUserId: IDS.human,
          startedWithSessionId: IDS.session,
          startedAt: TIMES.now,
        }),
      );
      expect(result.activation.event.kind).toBe('drill');
      expect(result.activation.event.templateMode).toBe('drill');
    });
  }

  test('rejects every non-human or non-app invocation before audience or start I/O', async () => {
    const invocations: readonly TrustedCapabilityInvocation[] = [
      {
        actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
        source: 'mcp',
        scope: { facilityScope: { kind: 'district' } },
        requestId: IDS.request,
        serverTime: new Date(TIMES.now),
        connectivityEpochId: null,
        mutation: {
          idempotencyKey: 'agent-monthly-test-0001',
          transport: { kind: 'mcp-tool-call' },
          humanConfirmationId: null,
        },
      },
      {
        actor: { kind: 'system', serviceId: 'monthly-delivery-test-reminder' },
        source: 'worker',
        scope: { facilityScope: { kind: 'district' } },
        requestId: IDS.request,
        serverTime: new Date(TIMES.now),
        connectivityEpochId: null,
        mutation: {
          idempotencyKey: 'scheduled-monthly-test-0001',
          transport: { kind: 'scheduled-execution' },
          humanConfirmationId: null,
        },
      },
    ];

    for (const invocation of invocations) {
      const value = fixture();
      Object.assign(value, { invocation });
      await expect(execute(value)).rejects.toMatchObject({
        code: 'INVOCATION_DENIED',
      });
      expect(value.resolverCalls).toBe(0);
      expectDeniedBeforeStart(value);
    }
  });

  test('rejects stale and cross-session confirmations before audience or start I/O', async () => {
    for (const invalidConfirmation of [
      confirmation({ expiresAt: '2026-08-13T18:00:59.000Z' }),
      confirmation({ sessionId: IDS.otherSession }),
      confirmation({ consequenceDigest: 'd'.repeat(64) }),
    ]) {
      const value = fixture();
      Object.assign(value, { confirmation: invalidConfirmation });
      await expect(execute(value)).rejects.toBeInstanceOf(
        DeliveryTestSafetyError,
      );
      expect(value.resolverCalls).toBe(0);
      expectDeniedBeforeStart(value);
    }
  });

  test('rejects mocked, blocked, and credential-unverified channel truth before start I/O', async () => {
    const values = ['mocked', 'blocked', 'credential'] as const;
    for (const kind of values) {
      const value = fixture();
      const base = value.preview;
      const channels = base.channels.map((channel, index) => {
        if (index !== 0) return channel;
        if (kind === 'credential') {
          return { ...channel, credentialVerified: false };
        }
        return {
          ...channel,
          credentialVerified: false,
          integrationStatus: {
            ...channel.integrationStatus,
            label: kind,
            verifiedAt: null,
            verifiedByUserId: null,
            authorizationReference: null,
            reasonCode: kind === 'blocked' ? 'PROVIDER_DISABLED' : null,
          },
        };
      });
      Object.assign(value, {
        preview: { ...base, channels } as DeliveryTestPreview,
      });

      await expect(execute(value)).rejects.toBeTruthy();
      expectDeniedBeforeStart(value);
    }
  });

  test('rejects an extra, swapped, or duplicated active endpoint before start I/O', async () => {
    const variants = [
      [
        ...endpointReferences(),
        {
          recipientId: IDS.recipient,
          endpointId: IDS.extraEndpoint,
          channel: 'push' as const,
        },
      ],
      [
        endpointReferences()[0]!,
        {
          ...endpointReferences()[1]!,
          endpointId: IDS.extraEndpoint,
        },
      ],
      [
        endpointReferences()[0]!,
        endpointReferences()[0]!,
        endpointReferences()[1]!,
      ],
    ];

    for (const activeEndpointRefs of variants) {
      const value = fixture();
      value.resolved = { ...value.resolved, activeEndpointRefs };
      await expect(execute(value)).rejects.toMatchObject({
        code: 'TARGET_SET_INVALID',
      });
      expectDeniedBeforeStart(value);
    }
  });

  test('rejects ordinary, non-attested staff endpoints before start I/O', async () => {
    const value = fixture();
    const unapproved = {
      ...value.resolved.targetSet,
      endpoints: value.resolved.targetSet.endpoints.map((endpoint) => ({
        ...endpoint,
        attestation: 'ordinary-staff',
      })),
    } as unknown as DeliveryTestTargetSetVersion;
    value.resolved = { ...value.resolved, targetSet: unapproved };

    await expect(execute(value)).rejects.toBeTruthy();
    expectDeniedBeforeStart(value);
  });

  test('rejects target version, roster, channel-count, and digest mismatches before start I/O', async () => {
    const mutations: readonly ((value: Fixture) => void)[] = [
      (value) => {
        value.resolved = {
          ...value.resolved,
          targetSet: {
            ...value.resolved.targetSet,
            id: uuid(90),
          },
        };
      },
      (value) => {
        value.resolved = {
          ...value.resolved,
          targetSet: {
            ...value.resolved.targetSet,
            rosterSnapshotId: uuid(91),
          },
        };
      },
      (value) => {
        const preview = value.preview;
        Object.assign(value, {
          preview: {
            ...preview,
            channels: preview.channels.map((channel, index) =>
              index === 0 ? { ...channel, endpointCount: 2 } : channel,
            ),
          } as DeliveryTestPreview,
        });
      },
      (value) => {
        value.resolved = {
          ...value.resolved,
          targetSet: {
            ...value.resolved.targetSet,
            endpointReferenceDigest: 'e'.repeat(64),
          },
        };
      },
    ];

    for (const mutate of mutations) {
      const value = fixture();
      mutate(value);
      await expect(execute(value)).rejects.toBeTruthy();
      expectDeniedBeforeStart(value);
    }
  });
});

describe('append-only delivery-test report assembly', () => {
  const run = DeliveryTestRunSchema.parse({
    id: IDS.run,
    activationPreviewId: IDS.preview,
    eventId: IDS.event,
    notificationIntentId: IDS.intent,
    targetSet: { id: IDS.targetSet, version: 1 },
    endpointReferenceDigest:
      deliveryTestEndpointReferenceDigest(endpointReferences()),
    consequenceDigest: CONSEQUENCE_DIGEST,
    confirmationId: IDS.confirmation,
    startedByUserId: IDS.human,
    startedWithSessionId: IDS.session,
    startedAt: TIMES.now,
  });

  test('keeps provider acceptance, delivered, and unknown as distinct truth', () => {
    const push = assembleDeliveryTestChannelReport({
      channel: 'push',
      endpointCount: 2,
      activationToProviderAcceptMs: 900,
      latestStateCounts: { 'provider-accepted': 1, delivered: 1 },
      completedAt: TIMES.completed,
    });
    const email = assembleDeliveryTestChannelReport({
      channel: 'email',
      endpointCount: 2,
      activationToProviderAcceptMs: null,
      latestStateCounts: { 'provider-accepted': 1, unknown: 1 },
      completedAt: null,
    });

    expect(push.latestStateCounts).toEqual([
      { state: 'provider-accepted', count: 1 },
      { state: 'delivered', count: 1 },
    ]);
    expect(email.latestStateCounts).toEqual([
      { state: 'provider-accepted', count: 1 },
      { state: 'unknown', count: 1 },
    ]);

    const report = assembleMonthlyDeliveryTestReport({
      id: IDS.report,
      run,
      sequence: 1,
      supersedesReportId: null,
      status: 'incomplete',
      channels: [push, email],
      generatedAt: TIMES.generated,
      finalizedByServiceId: 'delivery-test-report-finalizer',
      source: 'worker',
      reasonCode: 'PROVIDER_RECEIPT_PENDING',
    });
    expect(report.status).toBe('incomplete');
    expect(JSON.stringify(report)).not.toContain('destination');
    expect(JSON.stringify(report)).not.toContain('providerReference');
  });

  test('requires honest terminal state and a valid append-only sequence', () => {
    const completed = (channel: 'push' | 'email') =>
      assembleDeliveryTestChannelReport({
        channel,
        endpointCount: 1,
        activationToProviderAcceptMs: 750,
        latestStateCounts: { 'provider-accepted': 1 },
        completedAt: TIMES.completed,
      });

    expect(() =>
      assembleMonthlyDeliveryTestReport({
        id: IDS.report,
        run,
        sequence: 1,
        supersedesReportId: null,
        status: 'succeeded',
        channels: [completed('push'), completed('email')],
        generatedAt: TIMES.generated,
        finalizedByServiceId: 'delivery-test-report-finalizer',
        source: 'worker',
        reasonCode: null,
      }),
    ).not.toThrow();

    expect(() =>
      assembleMonthlyDeliveryTestReport({
        id: IDS.report,
        run,
        sequence: 1,
        supersedesReportId: null,
        status: 'succeeded',
        channels: [
          assembleDeliveryTestChannelReport({
            channel: 'push',
            endpointCount: 2,
            activationToProviderAcceptMs: 750,
            latestStateCounts: { 'provider-accepted': 1 },
            completedAt: TIMES.completed,
          }),
          completed('email'),
        ],
        generatedAt: TIMES.generated,
        finalizedByServiceId: 'delivery-test-report-finalizer',
        source: 'worker',
        reasonCode: null,
      }),
    ).toThrow();

    expect(() =>
      assembleMonthlyDeliveryTestReport({
        id: IDS.report,
        run,
        sequence: 1,
        supersedesReportId: null,
        status: 'succeeded',
        channels: [
          assembleDeliveryTestChannelReport({
            channel: 'push',
            endpointCount: 1,
            activationToProviderAcceptMs: 750,
            latestStateCounts: { attempted: 1 },
            completedAt: TIMES.completed,
          }),
          completed('email'),
        ],
        generatedAt: TIMES.generated,
        finalizedByServiceId: 'delivery-test-report-finalizer',
        source: 'worker',
        reasonCode: null,
      }),
    ).toThrow(DeliveryTestSafetyError);

    expect(() =>
      assembleMonthlyDeliveryTestReport({
        id: IDS.report,
        run,
        sequence: 2,
        supersedesReportId: null,
        status: 'failed',
        channels: [completed('push'), completed('email')],
        generatedAt: TIMES.generated,
        finalizedByServiceId: 'delivery-test-report-finalizer',
        source: 'worker',
        reasonCode: 'TERMINAL_PROVIDER_FAILURE',
      }),
    ).toThrow();

    expect(() =>
      assembleMonthlyDeliveryTestReport({
        id: IDS.report,
        run,
        sequence: 2,
        supersedesReportId: IDS.previousReport,
        status: 'incomplete',
        channels: [completed('push'), completed('email')],
        generatedAt: TIMES.generated,
        finalizedByServiceId: 'delivery-test-report-finalizer',
        source: 'worker',
        reasonCode: 'PROVIDER_RECEIPT_PENDING',
      }),
    ).toThrow();
  });

  test('rejects impossible counts and reports generated before the run', () => {
    expect(() =>
      assembleDeliveryTestChannelReport({
        channel: 'push',
        endpointCount: 1,
        activationToProviderAcceptMs: null,
        latestStateCounts: { unknown: 2 },
        completedAt: null,
      }),
    ).toThrow();

    const unknown = (channel: 'push' | 'email') =>
      assembleDeliveryTestChannelReport({
        channel,
        endpointCount: 1,
        activationToProviderAcceptMs: null,
        latestStateCounts: { unknown: 1 },
        completedAt: null,
      });
    expect(() =>
      assembleMonthlyDeliveryTestReport({
        id: IDS.report,
        run,
        sequence: 1,
        supersedesReportId: null,
        status: 'incomplete',
        channels: [unknown('push'), unknown('email')],
        generatedAt: '2026-08-13T18:00:59.999Z',
        finalizedByServiceId: 'delivery-test-report-finalizer',
        source: 'worker',
        reasonCode: 'NO_TERMINAL_EVIDENCE',
      }),
    ).toThrow(DeliveryTestSafetyError);
  });
});
