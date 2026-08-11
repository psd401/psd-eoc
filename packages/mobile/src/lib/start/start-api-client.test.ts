import { describe, expect, test } from 'bun:test';

import {
  ActivationPreviewSchema,
  CreateActivationPreviewInputSchema,
  EventSchema,
  EventTypeVersionSchema,
  JoinEventResultSchema,
  StartEventResultSchema,
  type ActivationPreview,
  type CreateActivationPreviewInput,
  type Event,
  type EventTypeVersion,
  type NotificationPurpose,
  type StartEventResult,
  type TemplateMode,
} from '@psd-eoc/contracts';

import type { AuthenticatedRequestInput } from '../auth/auth-controller';
import {
  activate,
  createPreview,
  join,
  loadStartHomeData,
  StartClientError,
  type StartAuthenticatedRequest,
} from './start-api-client';

const uuid = (suffix: number): string =>
  `61000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  facility: uuid(1),
  secondFacility: uuid(2),
  otherFacility: uuid(3),
  eventType: uuid(4),
  latestVersion: uuid(5),
  historicalVersion: uuid(6),
  alternateVersion: uuid(7),
  activeEvent: uuid(8),
  otherEvent: uuid(9),
  preview: uuid(10),
  roster: uuid(11),
  audience: uuid(12),
  user: uuid(13),
  session: uuid(14),
  request: uuid(15),
  transition: uuid(16),
  journal: uuid(17),
  intent: uuid(18),
  participant: uuid(19),
  confirmation: uuid(20),
});

const NOW = '2026-08-11T18:00:00.000Z';
const EXPIRES = '2026-08-11T18:10:00.000Z';
const IDEMPOTENCY_KEY = 'mobile-start-idempotency-0001';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function selectionFixture(
  mode: TemplateMode = 'drill',
  versionId = IDS.latestVersion,
): CreateActivationPreviewInput {
  return CreateActivationPreviewInputSchema.parse({
    facilityId: IDS.facility,
    kind: mode === 'real' ? 'incident' : 'drill',
    templateMode: mode,
    eventTypeVersion: { id: versionId, templateMode: mode },
    rosterPopulation: mode === 'real' ? 'staff' : 'synthetic',
  });
}

function templateSet(mode: TemplateMode, purpose: NotificationPurpose) {
  const marker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  return {
    templateMode: mode,
    purpose,
    push: {
      channel: 'push' as const,
      templateMode: mode,
      purpose,
      classificationMarker: marker,
      title: 'Synthetic {{eventType}}',
      body: 'Synthetic notice at {{site}}.',
    },
    email: {
      channel: 'email' as const,
      templateMode: mode,
      purpose,
      classificationMarker: marker,
      subject: 'Synthetic {{eventType}}',
      textBody: 'Synthetic notice at {{site}}.',
    },
    sms: {
      channel: 'sms' as const,
      templateMode: mode,
      purpose,
      classificationMarker: marker,
      body: 'Synthetic notice at {{site}}.',
    },
  };
}

function eventTypeVersionFixture(
  input: Readonly<{
    id: string;
    mode?: TemplateMode;
    name: string;
    supersedesVersionId?: string | null;
    version?: number;
  }>,
): EventTypeVersion {
  const mode = input.mode ?? 'drill';
  return EventTypeVersionSchema.parse({
    id: input.id,
    eventTypeId: IDS.eventType,
    version: input.version ?? 1,
    templateMode: mode,
    name: input.name,
    description: 'Synthetic contract fixture; no provider is contacted.',
    enabled: true,
    templates: {
      activation: templateSet(mode, 'activation'),
      'all-clear': templateSet(mode, 'all-clear'),
      reactivation: templateSet(mode, 'reactivation'),
    },
    supersedesVersionId: input.supersedesVersionId ?? null,
    createdBy: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    publicationAuthorization: {
      kind: 'human-admin',
      approvedByUserId: IDS.user,
      approvalReference: 'synthetic-contract-fixture',
    },
    createdAt: NOW,
  });
}

function integrationStatus(channel: 'push' | 'email', live: boolean) {
  return {
    integrationId: channel === 'push' ? 'expo-push' : 'ses-email',
    label: live ? ('live-verified' as const) : ('mocked' as const),
    verifiedAt: live ? NOW : null,
    verifiedByUserId: live ? IDS.user : null,
    authorizationReference: live
      ? 'contract-only-response-fixture-not-live-provider-evidence'
      : null,
    reasonCode: null,
    observedAt: NOW,
  };
}

function previewFixture(
  selection: CreateActivationPreviewInput,
  input: Readonly<{
    activeEventIds?: readonly string[];
    previewId?: string;
  }> = {},
): ActivationPreview {
  const marker = selection.templateMode === 'real' ? 'INCIDENT' : 'DRILL';
  const prefix = `[${marker}]`;
  const live = selection.rosterPopulation === 'staff';
  return ActivationPreviewSchema.parse({
    id: input.previewId ?? IDS.preview,
    facilityId: selection.facilityId,
    kind: selection.kind,
    templateMode: selection.templateMode,
    eventTypeVersion: selection.eventTypeVersion,
    rosterSnapshotId: IDS.roster,
    rosterPopulation: selection.rosterPopulation,
    audienceConfig: { id: IDS.audience, version: 1 },
    recipientCount: 2,
    channels: [
      {
        channel: 'push',
        endpointCount: 2,
        renderedMessage: {
          channel: 'push',
          eventKind: selection.kind,
          templateMode: selection.templateMode,
          purpose: 'activation',
          classificationMarker: marker,
          title: `${prefix} Synthetic start preview`,
          body: `${prefix} Synthetic recipients only.`,
        },
        integrationStatus: integrationStatus('push', live),
      },
      {
        channel: 'email',
        endpointCount: 2,
        renderedMessage: {
          channel: 'email',
          eventKind: selection.kind,
          templateMode: selection.templateMode,
          purpose: 'activation',
          classificationMarker: marker,
          subject: `${prefix} Synthetic start preview`,
          textBody: `${prefix} Synthetic recipients only.`,
        },
        integrationStatus: integrationStatus('email', live),
      },
    ],
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    activeEventIds: input.activeEventIds ?? [],
    consequenceDigest: 'a'.repeat(64),
    createdAt: NOW,
    expiresAt: EXPIRES,
  });
}

function activeEventFixture(
  selection: CreateActivationPreviewInput,
  eventId = IDS.activeEvent,
): Event {
  return EventSchema.parse({
    id: eventId,
    facilityId: selection.facilityId,
    kind: selection.kind,
    templateMode: selection.templateMode,
    eventTypeVersion: selection.eventTypeVersion,
    status: 'active',
    rosterSnapshotId: IDS.roster,
    rosterPopulation: selection.rosterPopulation,
    createdBy: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    createdAt: NOW,
    activatedAt: NOW,
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization:
      selection.rosterPopulation === 'staff'
        ? {
            kind: 'human-confirmed',
            activationPreviewId: IDS.preview,
            preparedActivationId: null,
            confirmationId: IDS.confirmation,
            consequenceDigest: 'a'.repeat(64),
            requestId: IDS.request,
          }
        : {
            kind: 'synthetic-training',
            activationPreviewId: IDS.preview,
            consequenceDigest: 'a'.repeat(64),
            requestId: IDS.request,
          },
  });
}

function activationResultFixture(
  preview: ActivationPreview,
  idempotencyKey = IDEMPOTENCY_KEY,
): StartEventResult {
  const actor = {
    kind: 'human' as const,
    userId: IDS.user,
    sessionId: IDS.session,
  };
  const staff = preview.rosterPopulation === 'staff';
  const authorization = staff
    ? ({
        kind: 'human-confirmed' as const,
        activationPreviewId: preview.id,
        preparedActivationId: null,
        confirmationId: IDS.confirmation,
        consequenceDigest: preview.consequenceDigest,
        requestId: IDS.request,
      } as const)
    : ({
        kind: 'synthetic-training' as const,
        activationPreviewId: preview.id,
        consequenceDigest: preview.consequenceDigest,
        requestId: IDS.request,
      } as const);
  const targeting = {
    kind: preview.kind,
    templateMode: preview.templateMode,
    rosterPopulation: preview.rosterPopulation,
  };
  const transition = {
    id: IDS.transition,
    sequence: 1,
    actor,
    source: 'mobile' as const,
    occurredAt: NOW,
    requestId: IDS.request,
    confirmationId: staff ? IDS.confirmation : null,
    consequenceDigest: staff ? preview.consequenceDigest : null,
    targeting,
    idempotencyKey,
    transition: 'activate' as const,
    eventId: IDS.otherEvent,
    from: 'draft' as const,
    to: 'active' as const,
    activationAuthorization: authorization,
  };

  return StartEventResultSchema.parse({
    event: {
      id: IDS.otherEvent,
      facilityId: preview.facilityId,
      kind: preview.kind,
      templateMode: preview.templateMode,
      eventTypeVersion: preview.eventTypeVersion,
      status: 'active',
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: preview.rosterPopulation,
      createdBy: actor,
      createdAt: NOW,
      activatedAt: NOW,
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
        id: IDS.journal,
        eventId: IDS.otherEvent,
        sequence: 1,
        author: actor,
        source: 'mobile',
        serverTime: NOW,
        clientTime: null,
        supersedes: null,
        kind: 'system',
        payload: {
          code: 'event-activated',
          summary: 'Synthetic contract fixture accepted.',
          transition,
        },
      },
    ],
    notificationIntent: {
      id: IDS.intent,
      eventId: IDS.otherEvent,
      eventKind: preview.kind,
      templateMode: preview.templateMode,
      purpose: 'activation',
      eventTypeVersion: preview.eventTypeVersion,
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: preview.rosterPopulation,
      audienceConfig: preview.audienceConfig,
      createdBy: actor,
      source: 'mobile',
      requestId: IDS.request,
      authorization,
      channels: preview.channels,
      createdAt: NOW,
    },
    preparedActivationConsumption: null,
  });
}

function oneResponseRequest(
  payload: unknown,
  calls: AuthenticatedRequestInput[] = [],
): StartAuthenticatedRequest {
  return async (input) => {
    calls.push(input);
    return jsonResponse(payload);
  };
}

describe('mobile start API client', () => {
  test('loads every page and resolves a historical active-event type name', async () => {
    const latestVersion = eventTypeVersionFixture({
      id: IDS.latestVersion,
      name: 'Latest practice type',
      supersedesVersionId: IDS.historicalVersion,
      version: 2,
    });
    const historicalVersion = eventTypeVersionFixture({
      id: IDS.historicalVersion,
      name: 'Historical practice type',
    });
    const historicalSelection = selectionFixture(
      'drill',
      IDS.historicalVersion,
    );
    const activeEvent = activeEventFixture(historicalSelection);
    const calls: AuthenticatedRequestInput[] = [];
    const request: StartAuthenticatedRequest = async (input) => {
      calls.push(input);
      switch (input.path) {
        case '/api/mobile/start/facilities':
          return jsonResponse({
            items: [
              {
                id: IDS.facility,
                code: 'NORTH',
                name: 'North Synthetic School',
                active: true,
                createdAt: NOW,
              },
            ],
            pageInfo: { hasMore: true, nextCursor: 'facility_cursor' },
          });
        case '/api/mobile/start/facilities?cursor=facility_cursor':
          return jsonResponse({
            items: [
              {
                id: IDS.secondFacility,
                code: 'SOUTH',
                name: 'South Synthetic School',
                active: true,
                createdAt: NOW,
              },
            ],
            pageInfo: { hasMore: false, nextCursor: null },
          });
        case '/event-types/api?operation=list&enabled=true':
          return jsonResponse({
            items: [
              {
                eventType: {
                  id: IDS.eventType,
                  key: 'synthetic-practice',
                  familyKey: 'synthetic-practice',
                  templateMode: 'drill',
                  createdAt: NOW,
                },
                latestVersion,
              },
            ],
            pageInfo: { hasMore: false, nextCursor: null },
          });
        case '/api/events':
          return jsonResponse({
            items: [activeEvent],
            pageInfo: { hasMore: true, nextCursor: 'event_cursor' },
          });
        case '/api/events?cursor=event_cursor':
          return jsonResponse({
            items: [],
            pageInfo: { hasMore: false, nextCursor: null },
          });
        case `/event-types/api?operation=version&eventTypeVersionId=${IDS.historicalVersion}`:
          return jsonResponse(historicalVersion);
        default:
          throw new Error(`Unexpected synthetic request: ${input.path}`);
      }
    };

    const result = await loadStartHomeData(request);

    expect(result.facilities.map((facility) => facility.name)).toEqual([
      'North Synthetic School',
      'South Synthetic School',
    ]);
    expect(result.eventTypes).toHaveLength(1);
    expect(result.activeEvents).toEqual([
      {
        event: activeEvent,
        facilityName: 'North Synthetic School',
        eventTypeName: 'Historical practice type',
      },
    ]);
    expect(calls.map((call) => call.path)).toEqual(
      expect.arrayContaining([
        '/api/mobile/start/facilities',
        '/api/mobile/start/facilities?cursor=facility_cursor',
        '/event-types/api?operation=list&enabled=true',
        '/api/events',
        '/api/events?cursor=event_cursor',
        `/event-types/api?operation=version&eventTypeVersionId=${IDS.historicalVersion}`,
      ]),
    );
    expect(calls.every((call) => call.operation === 'query')).toBe(true);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('uses an explicit classification fallback for unavailable historical names', async () => {
    const activeEvent = activeEventFixture(
      selectionFixture('drill', IDS.historicalVersion),
    );
    const request: StartAuthenticatedRequest = async (input) => {
      if (input.path === '/api/mobile/start/facilities') {
        return jsonResponse({
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      if (input.path === '/event-types/api?operation=list&enabled=true') {
        return jsonResponse({
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      if (input.path === '/api/events') {
        return jsonResponse({
          items: [activeEvent],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      return jsonResponse(
        {
          code: 'NOT_FOUND',
          message: 'Synthetic historical version is unavailable.',
          requestId: IDS.request,
          retryable: false,
          fieldErrors: [],
        },
        404,
      );
    };

    const result = await loadStartHomeData(request);

    expect(result.activeEvents[0]).toMatchObject({
      facilityName: 'Authorized facility',
      eventTypeName: 'Practice drill',
    });
  });

  test('creates a contract-validated preview bound to the exact selection', async () => {
    const selection = selectionFixture();
    const preview = previewFixture(selection, {
      activeEventIds: [IDS.activeEvent],
    });
    const calls: AuthenticatedRequestInput[] = [];

    await expect(
      createPreview(oneResponseRequest(preview, calls), selection),
    ).resolves.toEqual(preview);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'query',
      method: 'POST',
      path: '/api/mobile/start/preview',
    });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual(selection);
    expect(calls[0]?.idempotencyKey).toBeUndefined();
  });

  test('rejects a schema-valid preview for a different facility', async () => {
    const selection = selectionFixture();
    const mismatched = previewFixture({
      ...selection,
      facilityId: IDS.otherFacility,
    });

    await expect(
      createPreview(oneResponseRequest(mismatched), selection),
    ).rejects.toMatchObject({
      name: 'StartClientError',
      outcomeUnknown: false,
    });
  });

  test('activates once with the preview active-event evidence and matching idempotency key', async () => {
    const preview = previewFixture(selectionFixture(), {
      activeEventIds: [IDS.activeEvent, IDS.otherEvent],
    });
    const result = activationResultFixture(preview);
    const calls: AuthenticatedRequestInput[] = [];

    await expect(
      activate(oneResponseRequest(result, calls), preview, IDEMPOTENCY_KEY),
    ).resolves.toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'mutation',
      method: 'POST',
      path: '/api/mobile/start/activate',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      source: 'activation-preview',
      activationPreviewId: preview.id,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: [IDS.activeEvent, IDS.otherEvent],
      },
    });
  });

  test('rejects schema-valid activation results that mismatch facility, mode, or event type', async () => {
    const selectedPreview = previewFixture(selectionFixture());
    const facilityResult = activationResultFixture(
      previewFixture({
        ...selectionFixture(),
        facilityId: IDS.otherFacility,
      }),
    );
    const modeResult = activationResultFixture(
      previewFixture(selectionFixture('real', IDS.latestVersion)),
    );
    const eventTypeResult = activationResultFixture(
      previewFixture(selectionFixture('drill', IDS.alternateVersion)),
    );

    for (const result of [facilityResult, modeResult, eventTypeResult]) {
      expect(StartEventResultSchema.safeParse(result).success).toBe(true);
      await expect(
        activate(oneResponseRequest(result), selectedPreview, IDEMPOTENCY_KEY),
      ).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: true,
      });
    }
  });

  test('does not automatically retry an activation with an unknown network outcome', async () => {
    const preview = previewFixture(selectionFixture());
    let calls = 0;
    const request: StartAuthenticatedRequest = async () => {
      calls += 1;
      throw new Error('synthetic network interruption');
    };

    await expect(
      activate(request, preview, IDEMPOTENCY_KEY),
    ).rejects.toMatchObject({
      name: 'StartClientError',
      retryable: false,
      outcomeUnknown: true,
    });
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  test('joins exactly the selected active event', async () => {
    const selectedEvent = activeEventFixture(selectionFixture());
    const result = JoinEventResultSchema.parse({
      event: selectedEvent,
      participantId: IDS.participant,
      joined: true,
    });
    const calls: AuthenticatedRequestInput[] = [];

    await expect(
      join(oneResponseRequest(result, calls), selectedEvent, IDEMPOTENCY_KEY),
    ).resolves.toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'mutation',
      method: 'POST',
      path: `/api/events/${selectedEvent.id}/join`,
      body: '{}',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  test('treats a schema-valid join for another event as outcome-unknown', async () => {
    const wrongResult = JoinEventResultSchema.parse({
      event: activeEventFixture(selectionFixture(), IDS.otherEvent),
      participantId: IDS.participant,
      joined: true,
    });

    await expect(
      join(
        oneResponseRequest(wrongResult),
        activeEventFixture(selectionFixture()),
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toMatchObject({
      name: 'StartClientError',
      retryable: false,
      outcomeUnknown: true,
    });
  });

  test('rejects immutable classification drift for the selected event ID', async () => {
    const selectedEvent = activeEventFixture(selectionFixture());
    const driftedResult = JoinEventResultSchema.parse({
      event: activeEventFixture(
        selectionFixture('drill', IDS.alternateVersion),
      ),
      participantId: IDS.participant,
      joined: true,
    });

    await expect(
      join(oneResponseRequest(driftedResult), selectedEvent, IDEMPOTENCY_KEY),
    ).rejects.toMatchObject({
      name: 'StartClientError',
      retryable: false,
      outcomeUnknown: true,
    });
  });

  test('rejects contract-invalid success payloads without trusting partial fields', async () => {
    await expect(
      join(
        oneResponseRequest({
          event: activeEventFixture(selectionFixture()),
          participantId: IDS.participant,
          joined: false,
        }),
        activeEventFixture(selectionFixture()),
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toBeInstanceOf(StartClientError);
  });
});
