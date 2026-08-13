import {
  ChannelAttemptSchema,
  DispatchBatchSchema,
  EndpointSchema,
  type ChannelAttempt,
  type DispatchBatch,
  type Endpoint,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from './attempt';

export const IDS = Object.freeze({
  actor: '00000000-0000-4000-8000-000000000001',
  request: '00000000-0000-4000-8000-000000000002',
  confirmation: '00000000-0000-4000-8000-000000000003',
  preview: '00000000-0000-4000-8000-000000000004',
  audience: '00000000-0000-4000-8000-000000000005',
  roster: '00000000-0000-4000-8000-000000000006',
  eventTypeVersion: '00000000-0000-4000-8000-000000000007',
  event: '00000000-0000-4000-8000-000000000008',
  facility: '00000000-0000-4000-8000-000000000015',
  intent: '00000000-0000-4000-8000-000000000009',
  batch: '00000000-0000-4000-8000-000000000010',
  recipient: '00000000-0000-4000-8000-000000000011',
  endpoint: '00000000-0000-4000-8000-000000000012',
  attempt: '00000000-0000-4000-8000-000000000013',
  secondAttempt: '00000000-0000-4000-8000-000000000014',
});

export const TIMES = Object.freeze({
  created: '2026-08-10T16:00:00.000Z',
  attempted: '2026-08-10T16:00:01.000Z',
  recorded: '2026-08-10T16:00:02.000Z',
});

export function syntheticBatch(): DispatchBatch {
  return DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    facilityId: IDS.facility,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: { id: IDS.eventTypeVersion, templateMode: 'drill' },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
    audienceConfig: { id: IDS.audience, version: 1 },
    requestId: IDS.request,
    authorization: {
      kind: 'synthetic-training',
      activationPreviewId: IDS.preview,
      consequenceDigest: 'a'.repeat(64),
      requestId: IDS.request,
    },
    channel: 'push',
    renderedMessage: {
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'push',
      title: '[DRILL] Synthetic lockdown test',
      body: '[DRILL] Synthetic training only.',
    },
    integrationStatus: {
      integrationId: 'expo-push',
      label: 'mocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt: TIMES.created,
    },
    sequence: 1,
    endpointCount: 1,
    createdAt: TIMES.created,
  });
}

export function realBatch(): DispatchBatch {
  return DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    facilityId: IDS.facility,
    eventKind: 'incident',
    templateMode: 'real',
    purpose: 'activation',
    eventTypeVersion: { id: IDS.eventTypeVersion, templateMode: 'real' },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'staff',
    audienceConfig: { id: IDS.audience, version: 1 },
    requestId: IDS.request,
    authorization: {
      kind: 'human-confirmed',
      activationPreviewId: IDS.preview,
      preparedActivationId: null,
      confirmationId: IDS.confirmation,
      consequenceDigest: 'b'.repeat(64),
      requestId: IDS.request,
    },
    channel: 'push',
    renderedMessage: {
      eventKind: 'incident',
      templateMode: 'real',
      purpose: 'activation',
      classificationMarker: 'INCIDENT',
      channel: 'push',
      title: '[INCIDENT] Lockdown',
      body: '[INCIDENT] Follow district safety procedures.',
    },
    integrationStatus: {
      integrationId: 'expo-push',
      label: 'live-verified',
      verifiedAt: TIMES.created,
      verifiedByUserId: IDS.actor,
      authorizationReference: 'synthetic-product-owner-approval-reference',
      reasonCode: null,
      observedAt: TIMES.created,
    },
    sequence: 1,
    endpointCount: 1,
    createdAt: TIMES.created,
  });
}

export function attemptFor(
  batch: DispatchBatch,
  options: Readonly<{ id?: string; number?: number }> = {},
): ChannelAttempt {
  return ChannelAttemptSchema.parse({
    id: options.id ?? IDS.attempt,
    batchId: batch.id,
    intentId: batch.intentId,
    eventId: batch.eventId,
    eventKind: batch.eventKind,
    templateMode: batch.templateMode,
    purpose: batch.purpose,
    eventTypeVersion: batch.eventTypeVersion,
    rosterSnapshotId: batch.rosterSnapshotId,
    rosterPopulation: batch.rosterPopulation,
    recipientId: IDS.recipient,
    endpointId: IDS.endpoint,
    channel: batch.channel,
    attemptNumber: options.number ?? 1,
    attemptedAt: TIMES.attempted,
  });
}

export function endpointFor(batch: DispatchBatch): Endpoint {
  return EndpointSchema.parse({
    id: IDS.endpoint,
    status: 'active',
    capturedAt: TIMES.created,
    channel: 'push',
    platform: 'ios',
    token:
      batch.rosterPopulation === 'synthetic'
        ? 'synthetic-unroutable:push-device-1'
        : 'ExponentPushToken[synthetic-staff-fixture]',
  });
}

export function workItem(
  batch: DispatchBatch = syntheticBatch(),
  options: Readonly<{ attemptId?: string; attemptNumber?: number }> = {},
): WorkerAttemptWorkItem {
  return Object.freeze({
    batch,
    attempt: attemptFor(batch, {
      ...(options.attemptId === undefined ? {} : { id: options.attemptId }),
      ...(options.attemptNumber === undefined
        ? {}
        : { number: options.attemptNumber }),
    }),
    endpoint: endpointFor(batch),
  });
}
