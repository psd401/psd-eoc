import {
  ActivationPreviewSchema,
  ApiErrorSchema,
  EventSchema,
  JoinEventResultSchema,
  StartEventResultSchema,
  TimestampSchema,
  UuidSchema,
  type ActivationPreview,
  type CreateActivationPreviewInput,
  type Event,
  type JoinEventResult,
  type StartEventResult,
  type TemplateMode,
} from '@psd-eoc/contracts';
import { z } from 'zod';

const uuid = (suffix: number): string =>
  `15000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

export const PLAYWRIGHT_IDS = Object.freeze({
  activeEventTypeVersion: uuid(10),
  activatedEvent: uuid(11),
  activationConfirmation: uuid(12),
  activationTransition: uuid(13),
  notificationIntent: uuid(14),
  activationJournal: uuid(15),
  activationPreview: uuid(2),
  audience: uuid(3),
  joinParticipant: uuid(4),
  rosterSnapshot: uuid(5),
  staffRosterConfiguration: '80000000-0000-4000-8000-000000000040',
  staffRosterSnapshot: uuid(18),
  staffBuildingGroup: '80000000-0000-4000-8000-000000000030',
  staffSouthBuildingGroup: '80000000-0000-4000-8000-000000000031',
  staffOthersGroup: '80000000-0000-4000-8000-000000000032',
  staffRecipientNorth: uuid(20),
  staffRecipientSouth: uuid(21),
  staffRecipientOthers: uuid(22),
  staffRecipientNorthPush: uuid(23),
  staffRecipientSouthEmail: uuid(24),
  staffRecipientOthersPush: uuid(25),
  staffRecipientOthersEmail: uuid(26),
  request: uuid(6),
  user: uuid(7),
  session: uuid(8),
  mismatchedFacility: uuid(9),
});

const StartFlowPlaywrightEventSchema = z
  .object({
    id: UuidSchema,
    activatedAt: TimestampSchema,
    previewId: UuidSchema,
    requestId: UuidSchema,
    journalEntryIds: z.array(UuidSchema).length(3).readonly(),
    notificationIntentId: UuidSchema,
    outboxId: UuidSchema,
  })
  .strict()
  .readonly();

/** Non-secret, run-owned evidence produced by canonical setup capabilities. */
export const StartFlowPlaywrightFixtureSchema = z
  .object({
    runId: z.string().regex(/^[0-9a-f]{32}$/u),
    actor: z
      .object({
        kind: z.literal('human'),
        userId: UuidSchema,
        sessionId: UuidSchema,
      })
      .strict()
      .readonly(),
    connectivityEpochId: UuidSchema,
    activeEvents: z
      .tuple([StartFlowPlaywrightEventSchema, StartFlowPlaywrightEventSchema])
      .readonly(),
  })
  .strict()
  .readonly();

export type StartFlowPlaywrightFixture = z.infer<
  typeof StartFlowPlaywrightFixtureSchema
>;

/**
 * Contract-valid browser-only activation result. The matching POST is
 * intercepted before it can reach the server, database, outbox, or provider.
 */
export function activationResultFixture(
  preview: ActivationPreview,
  idempotencyKey: string,
): StartEventResult {
  const occurredAt = new Date().toISOString();
  const actor = {
    kind: 'human' as const,
    userId: PLAYWRIGHT_IDS.user,
    sessionId: PLAYWRIGHT_IDS.session,
  };
  const authorization = {
    kind: 'human-confirmed' as const,
    activationPreviewId: preview.id,
    preparedActivationId: null,
    confirmationId: PLAYWRIGHT_IDS.activationConfirmation,
    consequenceDigest: preview.consequenceDigest,
    requestId: PLAYWRIGHT_IDS.request,
  };
  const targeting = {
    kind: preview.kind,
    templateMode: preview.templateMode,
    rosterPopulation: 'staff' as const,
  };
  const transition = {
    id: PLAYWRIGHT_IDS.activationTransition,
    sequence: 1,
    actor,
    source: 'web' as const,
    occurredAt,
    requestId: PLAYWRIGHT_IDS.request,
    confirmationId: PLAYWRIGHT_IDS.activationConfirmation,
    consequenceDigest: preview.consequenceDigest,
    targeting,
    idempotencyKey,
    transition: 'activate' as const,
    eventId: PLAYWRIGHT_IDS.activatedEvent,
    from: 'draft' as const,
    to: 'active' as const,
    activationAuthorization: authorization,
  };

  return StartEventResultSchema.parse({
    event: {
      id: PLAYWRIGHT_IDS.activatedEvent,
      facilityId: preview.facilityId,
      kind: preview.kind,
      templateMode: preview.templateMode,
      eventTypeVersion: preview.eventTypeVersion,
      status: 'active',
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: 'staff',
      createdBy: actor,
      createdAt: occurredAt,
      activatedAt: occurredAt,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: authorization,
    },
    transition,
    journalEntries: [
      {
        id: PLAYWRIGHT_IDS.activationJournal,
        eventId: PLAYWRIGHT_IDS.activatedEvent,
        sequence: 1,
        author: actor,
        authorDisplayName: null,
        source: 'web',
        serverTime: occurredAt,
        clientTime: null,
        supersedes: null,
        kind: 'system',
        payload: {
          code: 'event-activated',
          summary: 'Synthetic browser activation fixture accepted.',
          transition,
        },
      },
    ],
    notificationIntent: {
      id: PLAYWRIGHT_IDS.notificationIntent,
      eventId: PLAYWRIGHT_IDS.activatedEvent,
      eventKind: preview.kind,
      templateMode: preview.templateMode,
      purpose: 'activation',
      eventTypeVersion: preview.eventTypeVersion,
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: 'staff',
      createdBy: actor,
      source: 'web',
      requestId: PLAYWRIGHT_IDS.request,
      authorization,
      channels: preview.channels,
      createdAt: occurredAt,
    },
    preparedActivationConsumption: null,
  });
}

function channelConsequences(
  input: Readonly<{
    includeSms: boolean;
    kind: 'incident' | 'drill';
    mode: TemplateMode;
    observedAt: string;
    simulatedReadyStaff: boolean;
  }>,
): ActivationPreview['channels'] {
  const marker = input.mode === 'real' ? 'INCIDENT' : 'DRILL';
  const prefix = `[${marker}]`;
  const integrationStatus = (
    integrationId: 'expo-push' | 'ses-email' | 'aws-eum-sms',
  ) =>
    input.simulatedReadyStaff
      ? {
          integrationId,
          label: 'live-verified' as const,
          verifiedAt: input.observedAt,
          verifiedByUserId: PLAYWRIGHT_IDS.user,
          authorizationReference:
            'synthetic-playwright-interception-not-provider-evidence',
          reasonCode: null,
          observedAt: input.observedAt,
        }
      : {
          integrationId,
          label: 'configured-unverified' as const,
          verifiedAt: null,
          verifiedByUserId: null,
          authorizationReference: null,
          reasonCode: null,
          observedAt: input.observedAt,
        };

  const consequences: ActivationPreview['channels'] = [
    {
      channel: 'push',
      endpointCount: 4,
      renderedMessage: {
        channel: 'push',
        eventKind: input.kind,
        templateMode: input.mode,
        purpose: 'activation',
        classificationMarker: marker,
        title: `${prefix} Synthetic browser preview`,
        body: `${prefix} No provider can receive this browser fixture.`,
      },
      integrationStatus: integrationStatus('expo-push'),
    },
    {
      channel: 'email',
      endpointCount: 3,
      renderedMessage: {
        channel: 'email',
        eventKind: input.kind,
        templateMode: input.mode,
        purpose: 'activation',
        classificationMarker: marker,
        subject: `${prefix} Synthetic browser preview`,
        textBody: `${prefix} No provider can receive this browser fixture.`,
      },
      integrationStatus: integrationStatus('ses-email'),
    },
    {
      channel: 'sms',
      endpointCount: 2,
      renderedMessage: {
        channel: 'sms',
        eventKind: input.kind,
        templateMode: input.mode,
        purpose: 'activation',
        classificationMarker: marker,
        body: `${prefix} Synthetic browser preview only.`,
      },
      integrationStatus: integrationStatus('aws-eum-sms'),
    },
  ];
  return input.includeSms
    ? consequences
    : consequences.filter((channel) => channel.channel !== 'sms');
}

/**
 * Browser-only transport fixture. `simulatedReadyStaff` exercises the client
 * submit state but is not integration evidence: the matching activation POST
 * is always intercepted and no server capability or provider is contacted.
 */
export function activationPreviewFixture(
  selection: CreateActivationPreviewInput,
  input: Readonly<{
    activeEventIds?: readonly string[];
    includeSms?: boolean;
    mismatchedFacility?: boolean;
    simulatedReadyStaff?: boolean;
  }> = {},
): ActivationPreview {
  const simulatedReadyStaff = input.simulatedReadyStaff === true;
  if (selection.kind === 'test') {
    throw new Error(
      'The human start-flow browser fixture cannot select tests.',
    );
  }
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1_000).toISOString();

  return ActivationPreviewSchema.parse({
    id: PLAYWRIGHT_IDS.activationPreview,
    facilityId: input.mismatchedFacility
      ? PLAYWRIGHT_IDS.mismatchedFacility
      : selection.facilityId,
    kind: selection.kind,
    templateMode: selection.templateMode,
    eventTypeVersion: selection.eventTypeVersion,
    rosterSnapshotId: PLAYWRIGHT_IDS.rosterSnapshot,
    rosterPopulation: 'staff',
    recipientCount: 4,
    channels: channelConsequences({
      kind: selection.kind,
      includeSms: input.includeSms !== false,
      mode: selection.templateMode,
      observedAt: createdAt,
      simulatedReadyStaff,
    }),
    sendReadiness: simulatedReadyStaff ? 'ready' : 'blocked',
    blockingReasonCodes: simulatedReadyStaff
      ? []
      : ['INTEGRATION_NOT_LIVE_VERIFIED'],
    activeEventIds: input.activeEventIds ?? [],
    consequenceDigest: 'a'.repeat(64),
    createdAt,
    expiresAt,
  });
}

export function joinEventResultFixture(
  selection: CreateActivationPreviewInput,
  eventId: string,
  input: Readonly<{ activatedAt?: string }> = {},
): JoinEventResult {
  return JoinEventResultSchema.parse({
    event: activeEventFixture(selection, eventId, input),
    participantId: PLAYWRIGHT_IDS.joinParticipant,
    joined: true,
  });
}

/** A synthetic DRILL used to prove a REAL prospective selection cannot leak. */
export function activeEventFixture(
  selection: CreateActivationPreviewInput,
  eventId: string,
  input: Readonly<{ activatedAt?: string }> = {},
): Event {
  const at = input.activatedAt ?? new Date().toISOString();
  return EventSchema.parse({
    id: eventId,
    facilityId: selection.facilityId,
    kind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: {
      id: PLAYWRIGHT_IDS.activeEventTypeVersion,
      templateMode: 'drill',
    },
    status: 'active',
    rosterSnapshotId: PLAYWRIGHT_IDS.rosterSnapshot,
    rosterPopulation: 'synthetic',
    createdBy: {
      kind: 'human',
      userId: PLAYWRIGHT_IDS.user,
      sessionId: PLAYWRIGHT_IDS.session,
    },
    createdAt: at,
    activatedAt: at,
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: {
      kind: 'synthetic-training',
      activationPreviewId: PLAYWRIGHT_IDS.activationPreview,
      consequenceDigest: 'a'.repeat(64),
      requestId: PLAYWRIGHT_IDS.request,
    },
  });
}

export function interceptedActivationError() {
  return ApiErrorSchema.parse({
    code: 'CONFLICT',
    message:
      'Synthetic browser interception stopped here; no event or notification was created.',
    requestId: PLAYWRIGHT_IDS.request,
    retryable: false,
    fieldErrors: [],
  });
}

export function interruptedActivationError() {
  return ApiErrorSchema.parse({
    code: 'INTERNAL_ERROR',
    message:
      'Synthetic response interruption leaves the activation outcome unknown.',
    requestId: PLAYWRIGHT_IDS.request,
    retryable: true,
    fieldErrors: [],
  });
}
