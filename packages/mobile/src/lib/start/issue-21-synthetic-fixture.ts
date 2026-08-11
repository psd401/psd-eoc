import {
  ActivationPreviewSchema,
  CreateActivationPreviewInputSchema,
  EventPageSchema,
  EventSchema,
  EventTypePageSchema,
  EventTypeVersionSchema,
  FacilityPageSchema,
  IdempotencyKeySchema,
  JoinEventResultSchema,
  StartEventInputSchema,
  StartEventResultSchema,
  type ActivationPreview,
  type Event,
  type EventTypeVersion,
  type NotificationPurpose,
} from '@psd-eoc/contracts';

import type {
  AuthenticatedRequestInput,
  AuthenticatedRequestTransport,
} from '../auth/auth-controller';

const uuid = (suffix: number): string =>
  `71000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  facility: uuid(1),
  eventType: uuid(2),
  eventTypeVersion: uuid(3),
  roster: uuid(4),
  audience: uuid(5),
  user: uuid(6),
  session: uuid(7),
  initialPreview: uuid(8),
  initialEvent: uuid(9),
  request: uuid(10),
  activationPreview: uuid(11),
  activatedEvent: uuid(12),
  transition: uuid(13),
  journal: uuid(14),
  intent: uuid(15),
  participant: uuid(16),
});

const FIXTURE_CREATED_AT = '2026-08-11T17:00:00.000Z';
const FIXTURE_DIGEST = 'a'.repeat(64);

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    },
  });
}

function parseBody(input: AuthenticatedRequestInput): unknown {
  if (input.body === undefined) {
    throw new TypeError('The synthetic fixture requires a JSON body.');
  }
  try {
    return JSON.parse(input.body) as unknown;
  } catch {
    throw new TypeError('The synthetic fixture received invalid JSON.');
  }
}

function templateSet(purpose: NotificationPurpose) {
  return {
    templateMode: 'drill' as const,
    purpose,
    push: {
      channel: 'push' as const,
      templateMode: 'drill' as const,
      purpose,
      classificationMarker: 'DRILL' as const,
      title: '[DRILL] Synthetic {{eventType}}',
      body: '[DRILL] Synthetic practice at {{site}}.',
    },
    email: {
      channel: 'email' as const,
      templateMode: 'drill' as const,
      purpose,
      classificationMarker: 'DRILL' as const,
      subject: '[DRILL] Synthetic {{eventType}}',
      textBody: '[DRILL] Synthetic practice at {{site}}.',
    },
    sms: {
      channel: 'sms' as const,
      templateMode: 'drill' as const,
      purpose,
      classificationMarker: 'DRILL' as const,
      body: '[DRILL] Synthetic practice at {{site}}.',
    },
  };
}

function eventTypeVersion(): EventTypeVersion {
  return EventTypeVersionSchema.parse({
    id: IDS.eventTypeVersion,
    eventTypeId: IDS.eventType,
    version: 1,
    templateMode: 'drill',
    name: 'Synthetic earthquake drill',
    description: 'Synthetic fixtures only; no provider is contacted.',
    enabled: true,
    templates: {
      activation: templateSet('activation'),
      'all-clear': templateSet('all-clear'),
      reactivation: templateSet('reactivation'),
    },
    supersedesVersionId: null,
    createdBy: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    publicationAuthorization: {
      kind: 'human-admin',
      approvedByUserId: IDS.user,
      approvalReference: 'issue-21-synthetic-fixture',
    },
    createdAt: FIXTURE_CREATED_AT,
  });
}

function syntheticAuthorization(previewId: string, requestId: string) {
  return {
    kind: 'synthetic-training' as const,
    activationPreviewId: previewId,
    consequenceDigest: FIXTURE_DIGEST,
    requestId,
  };
}

function activeEvent(
  eventId: string,
  previewId: string,
  requestId: string,
  createdAt: string,
): Event {
  return EventSchema.parse({
    id: eventId,
    facilityId: IDS.facility,
    kind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: 'drill',
    },
    status: 'active',
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
    createdBy: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    createdAt,
    activatedAt: createdAt,
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: syntheticAuthorization(previewId, requestId),
  });
}

function mockedChannelConsequences() {
  const integrationStatus = (channel: 'push' | 'email') => ({
    integrationId: channel === 'push' ? 'expo-push' : 'ses-email',
    label: 'mocked' as const,
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: FIXTURE_CREATED_AT,
  });
  return [
    {
      channel: 'push' as const,
      endpointCount: 2,
      renderedMessage: {
        channel: 'push' as const,
        eventKind: 'drill' as const,
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        classificationMarker: 'DRILL' as const,
        title: '[DRILL] Synthetic earthquake drill',
        body: '[DRILL] Synthetic recipients only.',
      },
      integrationStatus: integrationStatus('push'),
    },
    {
      channel: 'email' as const,
      endpointCount: 2,
      renderedMessage: {
        channel: 'email' as const,
        eventKind: 'drill' as const,
        templateMode: 'drill' as const,
        purpose: 'activation' as const,
        classificationMarker: 'DRILL' as const,
        subject: '[DRILL] Synthetic earthquake drill',
        textBody: '[DRILL] Synthetic recipients only.',
      },
      integrationStatus: integrationStatus('email'),
    },
  ] as const;
}

function activationPreview(now: Date): ActivationPreview {
  return ActivationPreviewSchema.parse({
    id: IDS.activationPreview,
    facilityId: IDS.facility,
    kind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: 'drill',
    },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
    audienceConfig: { id: IDS.audience, version: 1 },
    recipientCount: 2,
    channels: mockedChannelConsequences(),
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    activeEventIds: [IDS.initialEvent],
    consequenceDigest: FIXTURE_DIGEST,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  });
}

function activationResult(
  preview: ActivationPreview,
  idempotencyKey: string,
  occurredAt: string,
) {
  const actor = {
    kind: 'human' as const,
    userId: IDS.user,
    sessionId: IDS.session,
  };
  const authorization = syntheticAuthorization(preview.id, IDS.request);
  const targeting = {
    kind: 'drill' as const,
    templateMode: 'drill' as const,
    rosterPopulation: 'synthetic' as const,
  };
  const transition = {
    id: IDS.transition,
    sequence: 1,
    actor,
    source: 'mobile' as const,
    occurredAt,
    requestId: IDS.request,
    confirmationId: null,
    consequenceDigest: null,
    targeting,
    idempotencyKey,
    transition: 'activate' as const,
    eventId: IDS.activatedEvent,
    from: 'draft' as const,
    to: 'active' as const,
    activationAuthorization: authorization,
  };
  const event = activeEvent(
    IDS.activatedEvent,
    preview.id,
    IDS.request,
    occurredAt,
  );
  return StartEventResultSchema.parse({
    event,
    transition,
    journalEntries: [
      {
        id: IDS.journal,
        eventId: event.id,
        sequence: 1,
        author: actor,
        source: 'mobile',
        serverTime: occurredAt,
        clientTime: null,
        supersedes: null,
        kind: 'system',
        payload: {
          code: 'event-activated',
          summary: 'Synthetic drill fixture accepted without a provider.',
          transition,
        },
      },
    ],
    notificationIntent: {
      id: IDS.intent,
      eventId: event.id,
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      eventTypeVersion: preview.eventTypeVersion,
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: 'synthetic',
      audienceConfig: preview.audienceConfig,
      createdBy: actor,
      source: 'mobile',
      requestId: IDS.request,
      authorization,
      channels: preview.channels,
      createdAt: occurredAt,
    },
    preparedActivationConsumption: null,
  });
}

function assertSyntheticPreviewSelection(input: unknown): void {
  const selection = CreateActivationPreviewInputSchema.parse(input);
  if (
    selection.facilityId !== IDS.facility ||
    selection.kind !== 'drill' ||
    selection.templateMode !== 'drill' ||
    selection.eventTypeVersion.id !== IDS.eventTypeVersion ||
    selection.eventTypeVersion.templateMode !== 'drill' ||
    selection.rosterPopulation !== 'synthetic'
  ) {
    throw new TypeError(
      'The issue-21 fixture accepts only its exact synthetic drill selection.',
    );
  }
}

export function isIssue21SyntheticFixtureEnabled(): boolean {
  return (
    typeof __DEV__ !== 'undefined' &&
    __DEV__ &&
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE === 'issue-21'
  );
}

/**
 * In-memory, development-only operational transport for Maestro. It accepts
 * only one synthetic drill fixture, labels every integration mocked, performs
 * no network or provider I/O, and fails closed for every unexpected request.
 * Authentication remains owned by MobileAuthController before this seam runs.
 */
export function createIssue21SyntheticFixtureTransport(
  now: () => Date = () => new Date(),
): AuthenticatedRequestTransport {
  const version = eventTypeVersion();
  const seededEvent = activeEvent(
    IDS.initialEvent,
    IDS.initialPreview,
    IDS.request,
    FIXTURE_CREATED_AT,
  );
  const activatedEvents: Event[] = [];
  const activationResults = new Map<
    string,
    ReturnType<typeof activationResult>
  >();
  let currentPreview: ActivationPreview | null = null;

  return async (_bearer, input) => {
    if (!isIssue21SyntheticFixtureEnabled()) {
      throw new TypeError('The issue-21 synthetic fixture is disabled.');
    }
    if (input.signal?.aborted === true) {
      throw new DOMException(
        'The synthetic request was aborted.',
        'AbortError',
      );
    }

    if (
      input.operation === 'query' &&
      input.method === 'GET' &&
      input.path === '/api/mobile/start/facilities'
    ) {
      return jsonResponse(
        FacilityPageSchema.parse({
          items: [
            {
              id: IDS.facility,
              code: 'SYNTH',
              name: 'Synthetic Test School',
              active: true,
              createdAt: FIXTURE_CREATED_AT,
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      );
    }

    if (
      input.operation === 'query' &&
      input.method === 'GET' &&
      input.path === '/event-types/api?operation=list&enabled=true'
    ) {
      return jsonResponse(
        EventTypePageSchema.parse({
          items: [
            {
              eventType: {
                id: IDS.eventType,
                key: 'issue-21-synthetic-earthquake',
                familyKey: 'issue-21-synthetic-earthquake',
                templateMode: 'drill',
                createdAt: FIXTURE_CREATED_AT,
              },
              latestVersion: version,
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      );
    }

    if (
      input.operation === 'query' &&
      input.method === 'GET' &&
      input.path === '/api/events'
    ) {
      return jsonResponse(
        EventPageSchema.parse({
          items: [seededEvent, ...activatedEvents],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      );
    }

    if (
      input.operation === 'query' &&
      input.method === 'POST' &&
      input.path === '/api/mobile/start/preview'
    ) {
      assertSyntheticPreviewSelection(parseBody(input));
      currentPreview = activationPreview(now());
      return jsonResponse(currentPreview);
    }

    if (
      input.operation === 'mutation' &&
      input.method === 'POST' &&
      input.path === '/api/mobile/start/activate'
    ) {
      const idempotencyKey = IdempotencyKeySchema.parse(input.idempotencyKey);
      const startInput = StartEventInputSchema.parse(parseBody(input));
      const preview = currentPreview;
      if (
        preview === null ||
        startInput.source !== 'activation-preview' ||
        startInput.activationPreviewId !== preview.id ||
        startInput.activeEventDecision.decision !== 'start-new' ||
        startInput.activeEventDecision.activeEventIdsSeen.length !== 1 ||
        startInput.activeEventDecision.activeEventIdsSeen[0] !==
          IDS.initialEvent
      ) {
        throw new TypeError(
          'The synthetic activation does not match its current preview.',
        );
      }
      let result = activationResults.get(idempotencyKey);
      if (result === undefined) {
        if (activationResults.size > 0) {
          throw new TypeError(
            'The issue-21 fixture permits only one synthetic activation.',
          );
        }
        result = activationResult(preview, idempotencyKey, now().toISOString());
        activationResults.set(idempotencyKey, result);
        activatedEvents.push(result.event);
      }
      return jsonResponse(result);
    }

    const joinMatch = /^\/api\/events\/([0-9a-f-]+)\/join$/u.exec(input.path);
    if (
      input.operation === 'mutation' &&
      input.method === 'POST' &&
      joinMatch?.[1] !== undefined
    ) {
      IdempotencyKeySchema.parse(input.idempotencyKey);
      const body = parseBody(input);
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      ) {
        throw new TypeError('The synthetic join body must be empty.');
      }
      const event = [seededEvent, ...activatedEvents].find(
        (candidate) => candidate.id === joinMatch[1],
      );
      if (event === undefined) {
        throw new TypeError('The synthetic join target is unavailable.');
      }
      return jsonResponse(
        JoinEventResultSchema.parse({
          event,
          participantId: IDS.participant,
          joined: true,
        }),
      );
    }

    throw new TypeError(
      'The issue-21 fixture rejected an unexpected operational request.',
    );
  };
}
