import {
  ChannelAttemptSchema,
  DispatchBatchSchema,
  EmailWorkerAttemptWorkItemSchema,
  EndpointSchema,
  type DispatchBatch,
  type EmailWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';

const IDS = Object.freeze({
  actor: '00000000-0000-4000-8000-000000000001',
  confirmation: '00000000-0000-4000-8000-000000000003',
  preview: '00000000-0000-4000-8000-000000000004',
  roster: '00000000-0000-4000-8000-000000000006',
  eventTypeVersion: '00000000-0000-4000-8000-000000000007',
  event: '00000000-0000-4000-8000-000000000008',
  intent: '00000000-0000-4000-8000-000000000009',
  batch: '00000000-0000-4000-8000-000000000010',
  recipient: '00000000-0000-4000-8000-000000000011',
  endpoint: '00000000-0000-4000-8000-000000000012',
  attempt: '00000000-0000-4000-8000-000000000013',
  facility: '00000000-0000-4000-8000-000000000015',
  targetSet: '00000000-0000-4000-8000-000000000016',
  request: '00000000-0000-4000-8000-000000000017',
});

const CREATED_AT = '2026-08-10T16:00:00.000Z';
const ATTEMPTED_AT = '2026-08-10T16:00:01.000Z';

/** Address-safe controlled-email fixture for server boundary tests. */
export function emailDeliveryTestBatch(): DispatchBatch {
  return DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    facilityId: IDS.facility,
    eventKind: 'drill',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: 'drill',
    },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'staff',
    deliveryTest: {
      purpose: 'monthly-live-delivery-test',
      targetSet: { id: IDS.targetSet, version: 1 },
      endpointReferenceDigest: 'd'.repeat(64),
    },
    requestId: IDS.request,
    authorization: {
      kind: 'human-confirmed',
      activationPreviewId: IDS.preview,
      preparedActivationId: null,
      confirmationId: IDS.confirmation,
      consequenceDigest: 'b'.repeat(64),
      requestId: IDS.request,
    },
    channel: 'email',
    renderedMessage: {
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'email',
      subject: '[DRILL] Live canary email test',
      textBody: '[DRILL] LIVE CANARY — TRAINING ONLY.',
    },
    integrationStatus: {
      integrationId: 'ses-email',
      label: 'live-verified',
      verifiedAt: CREATED_AT,
      verifiedByUserId: IDS.actor,
      authorizationReference: 'synthetic-live-verification-reference',
      reasonCode: null,
      observedAt: CREATED_AT,
    },
    sequence: 1,
    endpointCount: 1,
    createdAt: CREATED_AT,
  });
}

export function emailDeliveryTestWorkItem(): EmailWorkerAttemptWorkItem {
  const batch = emailDeliveryTestBatch();
  return EmailWorkerAttemptWorkItemSchema.parse({
    batch,
    attempt: ChannelAttemptSchema.parse({
      id: IDS.attempt,
      batchId: batch.id,
      intentId: batch.intentId,
      eventId: batch.eventId,
      eventKind: batch.eventKind,
      templateMode: batch.templateMode,
      purpose: batch.purpose,
      eventTypeVersion: batch.eventTypeVersion,
      rosterSnapshotId: batch.rosterSnapshotId,
      rosterPopulation: batch.rosterPopulation,
      deliveryTest: batch.deliveryTest,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      channel: 'email',
      attemptNumber: 1,
      attemptedAt: ATTEMPTED_AT,
    }),
    endpoint: EndpointSchema.parse({
      id: IDS.endpoint,
      status: 'active',
      capturedAt: CREATED_AT,
      channel: 'email',
      email: 'controlled-recipient@example.invalid',
    }),
  });
}

export const EMAIL_RUNTIME_FIXTURE_ATTEMPT_ID = IDS.attempt;
