import { describe, expect, test } from 'bun:test';

import {
  ActivationPreviewSchema,
  ApiErrorSchema,
  CreateActivationPreviewInputSchema,
  EventSchema,
  EventTypeVersionSchema,
  JoinEventResultSchema,
  StartEventResultSchema,
  type ActivationPreview,
  type ApiErrorCode,
  type CreateActivationPreviewInput,
  type Event,
  type EventTypeVersion,
  type NotificationPurpose,
  type StartEventResult,
  type TemplateMode,
} from '@psd-eoc/contracts';

import {
  AuthenticatedApiError,
  AuthenticatedRequestFailure,
  type AuthenticatedRequestOptions,
} from '../api';
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
const ALL_CLEAR_AT = '2026-08-11T18:01:00.000Z';
const INTERMEDIATE_ALL_CLEAR_AT = '2026-08-11T18:02:00.000Z';
const REACTIVATED_AT = '2026-08-11T18:02:00.000Z';
const LATER_ALL_CLEAR_AT = '2026-08-11T18:03:00.000Z';
const LATER_REACTIVATED_AT = '2026-08-11T18:04:00.000Z';
const LATEST_REACTIVATED_AT = '2026-08-11T18:05:00.000Z';
const EXPIRES = '2026-08-11T18:10:00.000Z';
const IDEMPOTENCY_KEY = 'mobile-start-idempotency-0001';

type RecordedAuthenticatedRequest = AuthenticatedRequestOptions<unknown>;

function parseResponse<Output>(
  input: AuthenticatedRequestOptions<Output>,
  payload: unknown,
): Output {
  return input.schema.parse(payload);
}

function syntheticApiError(
  status: number,
  input: Readonly<{
    code?: ApiErrorCode;
    message?: string;
    retryable?: boolean;
  }> = {},
): AuthenticatedApiError {
  return new AuthenticatedApiError(
    ApiErrorSchema.parse({
      code: input.code ?? 'INTERNAL_ERROR',
      message:
        input.message ?? 'Synthetic server acknowledgement was interrupted.',
      requestId: IDS.request,
      retryable: input.retryable ?? true,
      fieldErrors: [],
    }),
    status,
  );
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
  calls: RecordedAuthenticatedRequest[] = [],
): StartAuthenticatedRequest {
  return async <Output>(
    input: AuthenticatedRequestOptions<Output>,
  ): Promise<Output> => {
    calls.push(input);
    return parseResponse(input, payload);
  };
}

describe('mobile start API client', () => {
  test('loads every page while retaining inactive-site names only for active events', async () => {
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
    const historicalSelection = CreateActivationPreviewInputSchema.parse({
      ...selectionFixture('drill', IDS.historicalVersion),
      facilityId: IDS.secondFacility,
    });
    const activeEvent = activeEventFixture(historicalSelection);
    const calls: RecordedAuthenticatedRequest[] = [];
    const request: StartAuthenticatedRequest = async <Output>(
      input: AuthenticatedRequestOptions<Output>,
    ): Promise<Output> => {
      calls.push(input);
      switch (input.path) {
        case '/api/mobile/start/facilities':
          return parseResponse(input, {
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
          return parseResponse(input, {
            items: [
              {
                id: IDS.secondFacility,
                code: 'SOUTH',
                name: 'South Synthetic School',
                active: false,
                createdAt: NOW,
              },
            ],
            pageInfo: { hasMore: false, nextCursor: null },
          });
        case '/event-types/api?operation=list&enabled=true':
          return parseResponse(input, {
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
          return parseResponse(input, {
            items: [activeEvent],
            pageInfo: { hasMore: true, nextCursor: 'event_cursor' },
          });
        case '/api/events?cursor=event_cursor':
          return parseResponse(input, {
            items: [],
            pageInfo: { hasMore: false, nextCursor: null },
          });
        case `/event-types/api?operation=version&eventTypeVersionId=${IDS.historicalVersion}`:
          return parseResponse(input, historicalVersion);
        default:
          throw new Error(`Unexpected synthetic request: ${input.path}`);
      }
    };

    const result = await loadStartHomeData(request);

    expect(result.facilities.map((facility) => facility.name)).toEqual([
      'North Synthetic School',
    ]);
    expect(result.eventTypes).toHaveLength(1);
    expect(result.activeEvents).toEqual([
      {
        event: activeEvent,
        facilityName: 'South Synthetic School',
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
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('uses a controlled-test fallback for an unavailable historical name', async () => {
    const drillSelection = selectionFixture('drill', IDS.historicalVersion);
    const activeEvent = activeEventFixture(
      CreateActivationPreviewInputSchema.parse({
        ...drillSelection,
        kind: 'test',
      }),
    );
    const request: StartAuthenticatedRequest = async <Output>(
      input: AuthenticatedRequestOptions<Output>,
    ): Promise<Output> => {
      if (input.path === '/api/mobile/start/facilities') {
        return parseResponse(input, {
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      if (input.path === '/event-types/api?operation=list&enabled=true') {
        return parseResponse(input, {
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      if (input.path === '/api/events') {
        return parseResponse(input, {
          items: [activeEvent],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      throw new AuthenticatedApiError(
        ApiErrorSchema.parse({
          code: 'NOT_FOUND',
          message: 'Historical version is unavailable.',
          requestId: IDS.request,
          retryable: false,
          fieldErrors: [],
        }),
        404,
      );
    };

    const result = await loadStartHomeData(request);

    expect(result.activeEvents[0]).toMatchObject({
      facilityName: 'Authorized facility',
      eventTypeName: 'Controlled test',
    });
  });

  test('rejects a schema-valid non-active event from the active-event endpoint', async () => {
    const selectedEvent = activeEventFixture(selectionFixture());
    const allClearEvent = EventSchema.parse({
      ...selectedEvent,
      status: 'all-clear',
      allClearAt: ALL_CLEAR_AT,
    });
    const request: StartAuthenticatedRequest = async <Output>(
      input: AuthenticatedRequestOptions<Output>,
    ): Promise<Output> => {
      if (input.path === '/api/mobile/start/facilities') {
        return parseResponse(input, {
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      if (input.path === '/event-types/api?operation=list&enabled=true') {
        return parseResponse(input, {
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      if (input.path === '/api/events') {
        return parseResponse(input, {
          items: [allClearEvent],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      throw new Error(`Unexpected synthetic request: ${input.path}`);
    };

    await expect(loadStartHomeData(request)).rejects.toMatchObject({
      name: 'StartClientError',
      outcomeUnknown: false,
    });
  });

  test('creates a contract-validated preview bound to the exact selection', async () => {
    const selection = selectionFixture();
    const preview = previewFixture(selection, {
      activeEventIds: [IDS.activeEvent],
    });
    const calls: RecordedAuthenticatedRequest[] = [];

    await expect(
      createPreview(
        oneResponseRequest(preview, calls),
        selection,
        IDEMPOTENCY_KEY,
      ),
    ).resolves.toEqual(preview);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/mobile/start/preview',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(calls[0]?.body).toEqual(selection);
  });

  test('rejects a schema-valid preview for a different facility', async () => {
    const selection = selectionFixture();
    const mismatched = previewFixture({
      ...selection,
      facilityId: IDS.otherFacility,
    });

    await expect(
      createPreview(oneResponseRequest(mismatched), selection, IDEMPOTENCY_KEY),
    ).rejects.toMatchObject({
      name: 'StartClientError',
      outcomeUnknown: false,
    });
  });

  test('activates once with preview evidence and accepts a server-scoped transition key', async () => {
    const preview = previewFixture(selectionFixture(), {
      activeEventIds: [IDS.activeEvent, IDS.otherEvent],
    });
    const result = activationResultFixture(preview, 'f'.repeat(64));
    const calls: RecordedAuthenticatedRequest[] = [];

    await expect(
      activate(oneResponseRequest(result, calls), preview, IDEMPOTENCY_KEY),
    ).resolves.toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/mobile/start/activate',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(calls[0]?.body).toEqual({
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
      throw new AuthenticatedRequestFailure(
        'network',
        'Synthetic network interruption.',
      );
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

  test('aborts a timed-out activation once and reports its outcome as unknown', async () => {
    const preview = previewFixture(selectionFixture());
    const originalSetTimeout = globalThis.setTimeout;
    let calls = 0;
    let observedSignal: AbortSignal | undefined;
    let fireTimeout: (() => void) | undefined;

    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      expect(delay).toBe(20_000);
      fireTimeout = callback;
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;

    try {
      const request: StartAuthenticatedRequest = (input) => {
        calls += 1;
        observedSignal = input.signal;
        return new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('Synthetic request aborted.');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      };

      const pendingActivation = activate(request, preview, IDEMPOTENCY_KEY);
      expect(calls).toBe(1);
      expect(observedSignal?.aborted).toBe(false);
      expect(fireTimeout).toBeDefined();

      fireTimeout?.();

      await expect(pendingActivation).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: true,
      });
      expect(observedSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(calls).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('does not retry activate or join after an actual HTTP 5xx response', async () => {
    const preview = previewFixture(selectionFixture());
    const selectedEvent = activeEventFixture(selectionFixture());
    const mutations = [
      (request: StartAuthenticatedRequest) =>
        activate(request, preview, IDEMPOTENCY_KEY),
      (request: StartAuthenticatedRequest) =>
        join(request, selectedEvent, IDEMPOTENCY_KEY),
    ];

    for (const mutate of mutations) {
      let calls = 0;
      const request: StartAuthenticatedRequest = async () => {
        calls += 1;
        throw syntheticApiError(503);
      };

      await expect(mutate(request)).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: true,
      });
      await Promise.resolve();
      expect(calls).toBe(1);
    }
  });

  test('keeps retryable idempotency-in-progress 409 mutations outcome-unknown', async () => {
    const preview = previewFixture(selectionFixture());
    const selectedEvent = activeEventFixture(selectionFixture());
    const mutations = [
      (request: StartAuthenticatedRequest) =>
        activate(request, preview, IDEMPOTENCY_KEY),
      (request: StartAuthenticatedRequest) =>
        join(request, selectedEvent, IDEMPOTENCY_KEY),
    ];

    for (const mutate of mutations) {
      let calls = 0;
      const request: StartAuthenticatedRequest = async () => {
        calls += 1;
        throw syntheticApiError(409, {
          code: 'CONFLICT',
          message: 'The original request is still in progress.',
          retryable: true,
        });
      };

      await expect(mutate(request)).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: true,
        code: 'CONFLICT',
      });
      await Promise.resolve();
      expect(calls).toBe(1);
    }
  });

  test('keeps malformed mutation 4xx responses outcome-unknown', async () => {
    const preview = previewFixture(selectionFixture());

    for (const status of [400, 408, 409, 429]) {
      let calls = 0;
      const request: StartAuthenticatedRequest = async () => {
        calls += 1;
        throw new AuthenticatedRequestFailure(
          'invalid-response',
          'Synthetic proxy response did not match the API contract.',
          status,
        );
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
    }
  });

  test('keeps unsupported or mismatched non-retryable API rejections outcome-unknown', async () => {
    const preview = previewFixture(selectionFixture());
    const ambiguousResponses: readonly Readonly<{
      code: ApiErrorCode;
      status: number;
    }>[] = [
      { status: 408, code: 'INTERNAL_ERROR' },
      { status: 425, code: 'CONFLICT' },
      { status: 499, code: 'VALIDATION_ERROR' },
      { status: 400, code: 'INTERNAL_ERROR' },
      { status: 408, code: 'VALIDATION_ERROR' },
    ];

    for (const response of ambiguousResponses) {
      let calls = 0;
      const request: StartAuthenticatedRequest = async () => {
        calls += 1;
        throw syntheticApiError(response.status, {
          code: response.code,
          retryable: false,
        });
      };

      await expect(
        activate(request, preview, IDEMPOTENCY_KEY),
      ).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: true,
        code: response.code,
      });
      await Promise.resolve();
      expect(calls).toBe(1);
    }
  });

  test('keeps an explicit terminal application rejection known', async () => {
    const selectedEvent = activeEventFixture(selectionFixture());
    let calls = 0;
    const request: StartAuthenticatedRequest = async () => {
      calls += 1;
      throw syntheticApiError(409, {
        code: 'CONFLICT',
        message: 'The selected event is no longer active.',
        retryable: false,
      });
    };

    await expect(
      join(request, selectedEvent, IDEMPOTENCY_KEY),
    ).rejects.toMatchObject({
      name: 'StartClientError',
      retryable: false,
      outcomeUnknown: false,
      code: 'CONFLICT',
    });
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  test('keeps failures proven to occur before send known', async () => {
    const preview = previewFixture(selectionFixture());

    for (const kind of ['configuration', 'invalid-request'] as const) {
      let calls = 0;
      const request: StartAuthenticatedRequest = async () => {
        calls += 1;
        throw new AuthenticatedRequestFailure(
          kind,
          'Synthetic request was blocked before send.',
        );
      };

      await expect(
        activate(request, preview, IDEMPOTENCY_KEY),
      ).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: false,
      });
      await Promise.resolve();
      expect(calls).toBe(1);
    }
  });

  test('joins exactly the selected active event', async () => {
    const selectedEvent = activeEventFixture(selectionFixture());
    const result = JoinEventResultSchema.parse({
      event: selectedEvent,
      participantId: IDS.participant,
      joined: true,
    });
    const calls: RecordedAuthenticatedRequest[] = [];

    await expect(
      join(oneResponseRequest(result, calls), selectedEvent, IDEMPOTENCY_KEY),
    ).resolves.toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: `/api/events/${selectedEvent.id}/join`,
      body: {},
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  test('accepts a legitimate join after the event is all-cleared and reactivated', async () => {
    const selectedEvent = activeEventFixture(selectionFixture());
    const reactivatedEvent = EventSchema.parse({
      ...selectedEvent,
      allClearAt: ALL_CLEAR_AT,
      reactivatedAt: REACTIVATED_AT,
    });
    const result = JoinEventResultSchema.parse({
      event: reactivatedEvent,
      participantId: IDS.participant,
      joined: true,
    });
    const calls: RecordedAuthenticatedRequest[] = [];

    await expect(
      join(oneResponseRequest(result, calls), selectedEvent, IDEMPOTENCY_KEY),
    ).resolves.toEqual(result);
    expect(calls).toHaveLength(1);
  });

  test('rejects rollback from a reactivated event to initial or older lifecycle truth', async () => {
    const initialEvent = activeEventFixture(selectionFixture());
    const selectedEvent = EventSchema.parse({
      ...initialEvent,
      allClearAt: LATER_ALL_CLEAR_AT,
      reactivatedAt: LATER_REACTIVATED_AT,
    });
    const olderReactivation = EventSchema.parse({
      ...initialEvent,
      allClearAt: ALL_CLEAR_AT,
      reactivatedAt: REACTIVATED_AT,
    });

    for (const event of [initialEvent, olderReactivation]) {
      const result = JoinEventResultSchema.parse({
        event,
        participantId: IDS.participant,
        joined: true,
      });
      await expect(
        join(oneResponseRequest(result), selectedEvent, IDEMPOTENCY_KEY),
      ).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: true,
      });
    }
  });

  test('rejects a rewritten pair whose all-clear predates the observed reactivation', async () => {
    const initialEvent = activeEventFixture(selectionFixture());
    const selectedEvent = EventSchema.parse({
      ...initialEvent,
      allClearAt: ALL_CLEAR_AT,
      reactivatedAt: LATER_REACTIVATED_AT,
    });
    const rewrittenEvent = EventSchema.parse({
      ...initialEvent,
      allClearAt: INTERMEDIATE_ALL_CLEAR_AT,
      reactivatedAt: LATEST_REACTIVATED_AT,
    });
    const result = JoinEventResultSchema.parse({
      event: rewrittenEvent,
      participantId: IDS.participant,
      joined: true,
    });

    await expect(
      join(oneResponseRequest(result), selectedEvent, IDEMPOTENCY_KEY),
    ).rejects.toMatchObject({
      name: 'StartClientError',
      retryable: false,
      outcomeUnknown: true,
    });
  });

  test('accepts an unchanged reactivation pair', async () => {
    const selectedEvent = EventSchema.parse({
      ...activeEventFixture(selectionFixture()),
      allClearAt: ALL_CLEAR_AT,
      reactivatedAt: REACTIVATED_AT,
    });
    const result = JoinEventResultSchema.parse({
      event: selectedEvent,
      participantId: IDS.participant,
      joined: true,
    });

    await expect(
      join(oneResponseRequest(result), selectedEvent, IDEMPOTENCY_KEY),
    ).resolves.toEqual(result);
  });

  test('accepts a later complete reactivation cycle', async () => {
    const initialEvent = activeEventFixture(selectionFixture());
    const selectedEvent = EventSchema.parse({
      ...initialEvent,
      allClearAt: ALL_CLEAR_AT,
      reactivatedAt: REACTIVATED_AT,
    });
    const result = JoinEventResultSchema.parse({
      event: EventSchema.parse({
        ...initialEvent,
        allClearAt: LATER_ALL_CLEAR_AT,
        reactivatedAt: LATER_REACTIVATED_AT,
      }),
      participantId: IDS.participant,
      joined: true,
    });

    await expect(
      join(oneResponseRequest(result), selectedEvent, IDEMPOTENCY_KEY),
    ).resolves.toEqual(result);
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

  test('rejects facility or roster identity drift for the selected event ID', async () => {
    const selectedEvent = activeEventFixture(selectionFixture());
    const mismatches = [
      EventSchema.parse({
        ...selectedEvent,
        facilityId: IDS.otherFacility,
      }),
      EventSchema.parse({
        ...selectedEvent,
        rosterSnapshotId: uuid(21),
      }),
    ];

    for (const event of mismatches) {
      const result = JoinEventResultSchema.parse({
        event,
        participantId: IDS.participant,
        joined: true,
      });
      await expect(
        join(oneResponseRequest(result), selectedEvent, IDEMPOTENCY_KEY),
      ).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: true,
      });
    }
  });

  test('rejects immutable creator or activation-authorization provenance drift', async () => {
    const selectedEvent = activeEventFixture(selectionFixture('real'));
    const mismatches = [
      EventSchema.parse({
        ...selectedEvent,
        createdBy: {
          kind: 'human',
          userId: uuid(22),
          sessionId: IDS.session,
        },
      }),
      EventSchema.parse({
        ...selectedEvent,
        activationAuthorization: {
          ...selectedEvent.activationAuthorization,
          confirmationId: uuid(23),
        },
      }),
    ];

    for (const event of mismatches) {
      const result = JoinEventResultSchema.parse({
        event,
        participantId: IDS.participant,
        joined: true,
      });
      await expect(
        join(oneResponseRequest(result), selectedEvent, IDEMPOTENCY_KEY),
      ).rejects.toMatchObject({
        name: 'StartClientError',
        retryable: false,
        outcomeUnknown: true,
      });
    }
  });

  test('rejects a same-ID join response that is no longer active', async () => {
    const selectedEvent = activeEventFixture(selectionFixture());
    const result = JoinEventResultSchema.parse({
      event: EventSchema.parse({
        ...selectedEvent,
        status: 'all-clear',
        allClearAt: ALL_CLEAR_AT,
      }),
      participantId: IDS.participant,
      joined: true,
    });

    await expect(
      join(oneResponseRequest(result), selectedEvent, IDEMPOTENCY_KEY),
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
