import { describe, expect, test } from 'bun:test';

import {
  CreateDeliveryTestTargetSetVersionInputSchema,
  DeliveryTestPreviewSchema,
  DeliveryTestTargetSetVersionSchema,
} from './delivery-test';
import { ActivationPreviewSchema, StartEventInputSchema } from './event';
import {
  DispatchOutboxResultSchema,
  NotificationIntentSchema,
  NotificationOutboxMessageSchema,
} from './notification';

const IDS = Object.freeze({
  audience: '10000000-0000-4000-8000-000000000001',
  batch: '10000000-0000-4000-8000-000000000002',
  confirmation: '10000000-0000-4000-8000-000000000003',
  eligibility: '10000000-0000-4000-8000-000000000004',
  emailEndpoint: '10000000-0000-4000-8000-000000000005',
  event: '10000000-0000-4000-8000-000000000006',
  eventTypeVersion: '10000000-0000-4000-8000-000000000007',
  facility: '10000000-0000-4000-8000-000000000008',
  intent: '10000000-0000-4000-8000-000000000009',
  outbox: '10000000-0000-4000-8000-000000000010',
  preview: '10000000-0000-4000-8000-000000000011',
  recipient: '10000000-0000-4000-8000-000000000012',
  request: '10000000-0000-4000-8000-000000000013',
  roster: '10000000-0000-4000-8000-000000000014',
  session: '10000000-0000-4000-8000-000000000015',
  targetSet: '10000000-0000-4000-8000-000000000016',
  user: '10000000-0000-4000-8000-000000000017',
});

const CREATED_AT = '2026-08-16T20:00:00.000Z';
const EXPIRES_AT = '2026-08-16T20:15:00.000Z';
const DIGEST = 'a'.repeat(64);
const ENDPOINT_DIGEST = 'b'.repeat(64);

const deliveryTest = Object.freeze({
  purpose: 'monthly-live-delivery-test' as const,
  targetSet: Object.freeze({ id: IDS.targetSet, version: 1 }),
  endpointReferenceDigest: ENDPOINT_DIGEST,
});

const emailConsequence = Object.freeze({
  channel: 'email' as const,
  endpointCount: 1,
  renderedMessage: Object.freeze({
    templateMode: 'drill' as const,
    purpose: 'activation' as const,
    classificationMarker: 'DRILL' as const,
    eventKind: 'drill' as const,
    channel: 'email' as const,
    subject: '[DRILL] Lockdown Drill at Harbor Ridge',
    textBody: '[DRILL] Training only. Started once confirmed.',
  }),
  integrationStatus: Object.freeze({
    integrationId: 'ses-email',
    label: 'live-verified' as const,
    verifiedAt: CREATED_AT,
    verifiedByUserId: IDS.user,
    authorizationReference: 'controlled-canary-verification',
    reasonCode: null,
    observedAt: CREATED_AT,
  }),
});

const smsConsequence = Object.freeze({
  channel: 'sms' as const,
  endpointCount: 1,
  renderedMessage: Object.freeze({
    templateMode: 'drill' as const,
    purpose: 'activation' as const,
    classificationMarker: 'DRILL' as const,
    eventKind: 'drill' as const,
    channel: 'sms' as const,
    body: '[DRILL] Training only. Started once confirmed.',
  }),
  integrationStatus: Object.freeze({
    integrationId: 'aws-eum-sms',
    label: 'live-verified' as const,
    verifiedAt: CREATED_AT,
    verifiedByUserId: IDS.user,
    authorizationReference: 'controlled-canary-verification',
    reasonCode: null,
    observedAt: CREATED_AT,
  }),
});

const controlledActivationPreview = Object.freeze({
  id: IDS.preview,
  facilityId: IDS.facility,
  kind: 'drill' as const,
  templateMode: 'drill' as const,
  eventTypeVersion: Object.freeze({
    id: IDS.eventTypeVersion,
    templateMode: 'drill' as const,
  }),
  rosterSnapshotId: IDS.roster,
  rosterPopulation: 'staff' as const,
  recipientCount: 1,
  channels: Object.freeze([emailConsequence]),
  sendReadiness: 'ready' as const,
  blockingReasonCodes: Object.freeze([]),
  activeEventIds: Object.freeze([]),
  deliveryTest,
  threat: null,
  responseDetail: null,
  consequenceDigest: DIGEST,
  createdAt: CREATED_AT,
  expiresAt: EXPIRES_AT,
});

const controlledSmsActivationPreview = Object.freeze({
  ...controlledActivationPreview,
  channels: Object.freeze([smsConsequence]),
});

const humanAuthorization = Object.freeze({
  kind: 'human-confirmed' as const,
  activationPreviewId: IDS.preview,
  preparedActivationId: null,
  confirmationId: IDS.confirmation,
  consequenceDigest: DIGEST,
  requestId: IDS.request,
});

const controlledIntent = Object.freeze({
  id: IDS.intent,
  eventId: IDS.event,
  eventKind: 'drill' as const,
  templateMode: 'drill' as const,
  purpose: 'activation' as const,
  eventTypeVersion: Object.freeze({
    id: IDS.eventTypeVersion,
    templateMode: 'drill' as const,
  }),
  rosterSnapshotId: IDS.roster,
  rosterPopulation: 'staff' as const,
  deliveryTest,
  createdBy: Object.freeze({
    kind: 'human' as const,
    userId: IDS.user,
    sessionId: IDS.session,
  }),
  source: 'web' as const,
  requestId: IDS.request,
  authorization: humanAuthorization,
  channels: Object.freeze([emailConsequence]),
  createdAt: CREATED_AT,
});

const controlledSmsIntent = Object.freeze({
  ...controlledIntent,
  channels: Object.freeze([smsConsequence]),
});

function controlledTargetSet(endpointChannel: 'email' | 'push' = 'email') {
  return {
    mode: 'controlled-email-canary' as const,
    id: IDS.targetSet,
    version: 1,
    facilityId: IDS.facility,
    rosterSnapshotId: IDS.roster,
    supersedesVersionId: null,
    endpoints: [
      {
        eligibilityFactId: IDS.eligibility,
        recipientId: IDS.recipient,
        endpointId: IDS.emailEndpoint,
        channel: endpointChannel,
        attestation: 'approved-synthetic-canary' as const,
        optedInAt: CREATED_AT,
        attestedAt: CREATED_AT,
        attestedByUserId: IDS.user,
        authorizationReference: 'controlled-canary-approval',
      },
    ],
    endpointReferenceDigest: ENDPOINT_DIGEST,
    approvedByUserId: IDS.user,
    approvedWithSessionId: IDS.session,
    approvedAt: CREATED_AT,
    createdAt: CREATED_AT,
  };
}

describe('controlled email delivery-test canary contracts', () => {
  test('adds a discriminated singleton-email target without weakening ordinary target sets', () => {
    expect(
      CreateDeliveryTestTargetSetVersionInputSchema.safeParse({
        mode: 'controlled-email-canary',
        previousVersion: null,
        facilityId: IDS.facility,
        rosterSnapshotId: IDS.roster,
        eligibilityFactIds: [IDS.eligibility],
      }).success,
    ).toBe(true);
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse(controlledTargetSet())
        .success,
    ).toBe(true);
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse(controlledTargetSet('push'))
        .success,
    ).toBe(false);
    const derived = DeliveryTestTargetSetVersionSchema.parse({
      ...controlledTargetSet(),
      mode: undefined,
    });
    expect('mode' in derived ? derived.mode : null).toBe(
      'controlled-email-canary',
    );
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse({
        ...controlledTargetSet(),
        mode: 'ordinary',
      }).success,
    ).toBe(false);
  });

  test('adds an exact singleton-push target for bounded physical drills', () => {
    expect(
      CreateDeliveryTestTargetSetVersionInputSchema.safeParse({
        mode: 'controlled-push-canary',
        previousVersion: null,
        facilityId: IDS.facility,
        rosterSnapshotId: IDS.roster,
        eligibilityFactIds: [IDS.eligibility],
      }).success,
    ).toBe(true);
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse({
        ...controlledTargetSet('push'),
        mode: 'controlled-push-canary',
      }).success,
    ).toBe(true);

    const pushConsequence = {
      ...emailConsequence,
      channel: 'push' as const,
      renderedMessage: {
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        classificationMarker: 'DRILL' as const,
        eventKind: 'drill' as const,
        channel: 'push' as const,
        title: '[DRILL] Bounded push canary',
        body: '[DRILL] Training only. Started once confirmed.',
      },
      integrationStatus: {
        ...emailConsequence.integrationStatus,
        integrationId: 'expo-push',
      },
    };
    const pushActivation = {
      ...controlledActivationPreview,
      channels: [pushConsequence],
    };
    expect(ActivationPreviewSchema.safeParse(pushActivation).success).toBe(
      true,
    );
    expect(
      DeliveryTestPreviewSchema.safeParse({
        purpose: 'monthly-live-delivery-test',
        activationPreview: pushActivation,
        targetSet: deliveryTest.targetSet,
        endpointReferenceDigest: ENDPOINT_DIGEST,
        channels: [
          {
            channel: 'push',
            endpointCount: 1,
            integrationStatus: pushConsequence.integrationStatus,
            credentialVerified: true,
          },
        ],
        consequenceDigest: DIGEST,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      }).success,
    ).toBe(true);
    expect(
      NotificationIntentSchema.safeParse({
        ...controlledIntent,
        channels: [pushConsequence],
      }).success,
    ).toBe(true);
  });

  test('adds an exact singleton-SMS target without accepting another channel', () => {
    const smsTarget = {
      ...controlledTargetSet(),
      mode: 'controlled-sms-canary' as const,
      endpoints: [
        {
          ...controlledTargetSet().endpoints[0],
          channel: 'sms' as const,
        },
      ],
    };
    expect(
      CreateDeliveryTestTargetSetVersionInputSchema.safeParse({
        mode: 'controlled-sms-canary',
        previousVersion: null,
        facilityId: IDS.facility,
        rosterSnapshotId: IDS.roster,
        eligibilityFactIds: [IDS.eligibility],
      }).success,
    ).toBe(true);
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse(smsTarget).success,
    ).toBe(true);
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse({
        ...smsTarget,
        endpoints: controlledTargetSet().endpoints,
      }).success,
    ).toBe(false);
  });

  test('binds a singleton SMS preview, intent, outbox, and dispatch batch to one endpoint', () => {
    expect(
      ActivationPreviewSchema.safeParse(controlledSmsActivationPreview).success,
    ).toBe(true);
    expect(
      ActivationPreviewSchema.safeParse({
        ...controlledSmsActivationPreview,
        channels: [{ ...smsConsequence, endpointCount: 2 }],
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestPreviewSchema.safeParse({
        purpose: 'monthly-live-delivery-test',
        activationPreview: controlledSmsActivationPreview,
        targetSet: deliveryTest.targetSet,
        endpointReferenceDigest: ENDPOINT_DIGEST,
        channels: [
          {
            channel: 'sms',
            endpointCount: 1,
            integrationStatus: smsConsequence.integrationStatus,
            credentialVerified: true,
          },
        ],
        consequenceDigest: DIGEST,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      }).success,
    ).toBe(true);
    expect(
      NotificationIntentSchema.safeParse(controlledSmsIntent).success,
    ).toBe(true);
    expect(
      NotificationIntentSchema.safeParse({
        ...controlledSmsIntent,
        deliveryTest: null,
      }).success,
    ).toBe(false);

    const message = {
      version: 2 as const,
      facilityId: IDS.facility,
      outboxId: IDS.outbox,
      intentId: IDS.intent,
      eventId: IDS.event,
      eventKind: 'drill' as const,
      templateMode: 'drill' as const,
      purpose: 'activation' as const,
      eventTypeVersion: controlledSmsIntent.eventTypeVersion,
      rosterSnapshotId: IDS.roster,
      rosterPopulation: 'staff' as const,
      deliveryTest,
      requestId: IDS.request,
      authorization: humanAuthorization,
      channels: [smsConsequence],
      createdAt: CREATED_AT,
    };
    expect(NotificationOutboxMessageSchema.safeParse(message).success).toBe(
      true,
    );

    const batch = {
      id: IDS.batch,
      intentId: IDS.intent,
      eventId: IDS.event,
      facilityId: IDS.facility,
      eventKind: 'drill' as const,
      templateMode: 'drill' as const,
      purpose: 'activation' as const,
      eventTypeVersion: controlledSmsIntent.eventTypeVersion,
      rosterSnapshotId: IDS.roster,
      rosterPopulation: 'staff' as const,
      deliveryTest,
      requestId: IDS.request,
      authorization: humanAuthorization,
      channel: 'sms' as const,
      renderedMessage: smsConsequence.renderedMessage,
      integrationStatus: smsConsequence.integrationStatus,
      sequence: 1,
      endpointCount: 1,
      createdAt: CREATED_AT,
    };
    const result = {
      facilityId: IDS.facility,
      outboxRecord: {
        id: IDS.outbox,
        message,
        status: 'published' as const,
        attempts: 1,
        availableAt: CREATED_AT,
        lockedUntil: null,
        publishedAt: CREATED_AT,
        failedAt: null,
        lastErrorCode: null,
      },
      batches: [batch],
    };
    expect(DispatchOutboxResultSchema.safeParse(result).success).toBe(true);
    expect(
      DispatchOutboxResultSchema.safeParse({
        ...result,
        outboxRecord: {
          ...result.outboxRecord,
          message: {
            ...message,
            channels: [{ ...smsConsequence, endpointCount: 2 }],
          },
        },
        batches: [{ ...batch, endpointCount: 2 }],
      }).success,
    ).toBe(false);
  });

  test('allows exactly one email consequence only with staff DRILL delivery-test provenance', () => {
    expect(
      ActivationPreviewSchema.safeParse(controlledActivationPreview).success,
    ).toBe(true);
    expect(
      ActivationPreviewSchema.safeParse({
        ...controlledActivationPreview,
        deliveryTest: null,
      }).success,
    ).toBe(false);
    expect(
      ActivationPreviewSchema.safeParse({
        ...controlledActivationPreview,
        kind: 'incident',
        templateMode: 'real',
      }).success,
    ).toBe(false);
    expect(
      ActivationPreviewSchema.safeParse({
        ...controlledActivationPreview,
        recipientCount: 2,
      }).success,
    ).toBe(false);
    expect(
      ActivationPreviewSchema.safeParse({
        ...controlledActivationPreview,
        channels: [{ ...emailConsequence, endpointCount: 2 }],
      }).success,
    ).toBe(false);
  });

  test('binds preview, intent, and outbox to the same one-email DRILL consequence', () => {
    expect(
      DeliveryTestPreviewSchema.safeParse({
        purpose: 'monthly-live-delivery-test',
        activationPreview: controlledActivationPreview,
        targetSet: deliveryTest.targetSet,
        endpointReferenceDigest: ENDPOINT_DIGEST,
        channels: [
          {
            channel: 'email',
            endpointCount: 1,
            integrationStatus: emailConsequence.integrationStatus,
            credentialVerified: true,
          },
        ],
        consequenceDigest: DIGEST,
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      }).success,
    ).toBe(true);
    expect(NotificationIntentSchema.safeParse(controlledIntent).success).toBe(
      true,
    );

    const message = {
      version: 2 as const,
      facilityId: IDS.facility,
      outboxId: IDS.outbox,
      intentId: IDS.intent,
      eventId: IDS.event,
      eventKind: 'drill' as const,
      templateMode: 'drill' as const,
      purpose: 'activation' as const,
      eventTypeVersion: controlledIntent.eventTypeVersion,
      rosterSnapshotId: IDS.roster,
      rosterPopulation: 'staff' as const,
      deliveryTest,
      requestId: IDS.request,
      authorization: humanAuthorization,
      channels: [emailConsequence],
      createdAt: CREATED_AT,
    };
    expect(NotificationOutboxMessageSchema.safeParse(message).success).toBe(
      true,
    );

    const batch = {
      id: IDS.batch,
      intentId: IDS.intent,
      eventId: IDS.event,
      facilityId: IDS.facility,
      eventKind: 'drill' as const,
      templateMode: 'drill' as const,
      purpose: 'activation' as const,
      eventTypeVersion: controlledIntent.eventTypeVersion,
      rosterSnapshotId: IDS.roster,
      rosterPopulation: 'staff' as const,
      deliveryTest,
      requestId: IDS.request,
      authorization: humanAuthorization,
      channel: 'email' as const,
      renderedMessage: emailConsequence.renderedMessage,
      integrationStatus: emailConsequence.integrationStatus,
      sequence: 1,
      endpointCount: 1,
      createdAt: CREATED_AT,
    };
    expect(
      DispatchOutboxResultSchema.safeParse({
        facilityId: IDS.facility,
        outboxRecord: {
          id: IDS.outbox,
          message,
          status: 'published',
          attempts: 1,
          availableAt: CREATED_AT,
          lockedUntil: null,
          publishedAt: CREATED_AT,
          failedAt: null,
          lastErrorCode: null,
        },
        batches: [batch],
      }).success,
    ).toBe(true);
  });

  test('rejects email-only ordinary, synthetic, agent, and system plans', () => {
    expect(
      NotificationIntentSchema.safeParse({
        ...controlledIntent,
        deliveryTest: null,
      }).success,
    ).toBe(false);
    expect(
      NotificationIntentSchema.safeParse({
        ...controlledIntent,
        rosterPopulation: 'synthetic',
      }).success,
    ).toBe(false);
    expect(
      NotificationIntentSchema.safeParse({
        ...controlledIntent,
        createdBy: {
          kind: 'agent',
          agentId: IDS.user,
          apiKeyId: IDS.session,
        },
        source: 'agent-rest',
      }).success,
    ).toBe(false);
    expect(
      NotificationIntentSchema.safeParse({
        ...controlledIntent,
        createdBy: { kind: 'system', serviceId: 'email-worker' },
        source: 'worker',
      }).success,
    ).toBe(false);
  });

  test('start-event accepts only an opaque preview reference and explicit start-new decision', () => {
    const exactInput = {
      source: 'activation-preview' as const,
      activationPreviewId: IDS.preview,
      activeEventDecision: {
        decision: 'start-new' as const,
        activeEventIdsSeen: [],
      },
    };
    expect(StartEventInputSchema.safeParse(exactInput).success).toBe(true);
    for (const injected of [
      { method: 'GET' },
      { sourceActor: 'agent' },
      { scheduled: true },
      { webhook: true },
      { endpointId: IDS.emailEndpoint },
    ]) {
      expect(
        StartEventInputSchema.safeParse({ ...exactInput, ...injected }).success,
      ).toBe(false);
    }
  });
});
