import { describe, expect, test } from 'bun:test';
import {
  ActivationPreviewSchema,
  EventSchema,
  StartEventResultSchema,
  type Event,
  type StartEventResult,
} from '@psd-eoc/contracts';

import {
  StartFlowRequestError,
  requestStartFlow,
  requireActiveJoinedEvent,
  requireMatchingActiveJoinedEvent,
  requireMatchingActivationResult,
} from './client-request';
import {
  activationPreviewFixture,
  activationResultFixture,
} from '../test/playwright.fixtures';

const uuid = (suffix: number): string =>
  `17000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

function activeEvent(overrides: Partial<Event> = {}): Event {
  return EventSchema.parse({
    id: uuid(1),
    facilityId: uuid(2),
    kind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: { id: uuid(3), templateMode: 'drill' },
    status: 'active',
    rosterSnapshotId: uuid(4),
    rosterPopulation: 'synthetic',
    createdBy: { kind: 'human', userId: uuid(5), sessionId: uuid(6) },
    createdAt: '2026-08-10T18:00:00.000Z',
    activatedAt: '2026-08-10T18:00:00.000Z',
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: {
      kind: 'synthetic-training',
      activationPreviewId: uuid(7),
      consequenceDigest: 'a'.repeat(64),
      requestId: uuid(8),
    },
    ...overrides,
  });
}

async function expectUnresolved(operation: () => unknown): Promise<void> {
  try {
    operation();
    throw new Error('Expected join validation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(StartFlowRequestError);
    expect((error as StartFlowRequestError).outcomeUnknown).toBe(true);
  }
}

describe('joined-event response validation', () => {
  test('accepts only the requested active event', () => {
    const event = activeEvent();
    expect(requireActiveJoinedEvent(event, event.id)).toBe(event);
    expect(requireMatchingActiveJoinedEvent(event, event)).toBe(event);
  });

  test('treats a schema-valid response for another event as unresolved', async () => {
    await expectUnresolved(() =>
      requireActiveJoinedEvent(activeEvent({ id: uuid(9) }), uuid(1)),
    );
  });

  test('treats a joined event that is no longer active as unresolved', async () => {
    const closed = activeEvent({
      status: 'closed',
      allClearAt: '2026-08-10T18:04:00.000Z',
      closedAt: '2026-08-10T18:05:00.000Z',
    });
    await expectUnresolved(() =>
      requireMatchingActiveJoinedEvent(closed, activeEvent()),
    );
  });

  test('pins classification and roster identity on confirmation-page joins', async () => {
    await expectUnresolved(() =>
      requireMatchingActiveJoinedEvent(
        activeEvent({ rosterSnapshotId: uuid(10) }),
        activeEvent(),
      ),
    );
  });
});

const ACTIVATION_SELECTION = Object.freeze({
  facilityId: uuid(20),
  kind: 'drill' as const,
  templateMode: 'drill' as const,
  eventTypeVersion: {
    id: uuid(21),
    templateMode: 'drill' as const,
  },
  rosterPopulation: 'staff' as const,
});
const ACTIVATION_IDEMPOTENCY_KEY = 'activate:synthetic-response-binding';

function preparedActivationResult(base: StartEventResult): StartEventResult {
  if (
    base.transition.transition !== 'activate' ||
    base.event.activationAuthorization?.kind !== 'human-confirmed' ||
    base.notificationIntent === null
  ) {
    throw new Error('Synthetic activation result is not human-confirmed.');
  }
  const preparedActivationId = uuid(22);
  const authorization = {
    ...base.event.activationAuthorization,
    preparedActivationId,
  };
  const transition = {
    ...base.transition,
    activationAuthorization: authorization,
  };
  return StartEventResultSchema.parse({
    ...base,
    event: { ...base.event, activationAuthorization: authorization },
    transition,
    notificationIntent: {
      ...base.notificationIntent,
      authorization,
    },
    journalEntries: base.journalEntries.map((entry) =>
      entry.kind === 'system' && 'transition' in entry.payload
        ? { ...entry, payload: { ...entry.payload, transition } }
        : entry,
    ),
    preparedActivationConsumption: {
      preparedActivationId,
      eventId: base.event.id,
      authorization,
      requestId: base.transition.requestId,
      consumedBy: base.transition.actor,
      consumedAt: base.transition.occurredAt,
    },
  });
}

describe('activation response binding', () => {
  const preview = activationPreviewFixture(ACTIVATION_SELECTION, {
    simulatedReadyStaff: true,
  });
  const selection = {
    eventKind: ACTIVATION_SELECTION.kind,
    eventTypeVersionId: ACTIVATION_SELECTION.eventTypeVersion.id,
    facilityId: ACTIVATION_SELECTION.facilityId,
    templateMode: ACTIVATION_SELECTION.templateMode,
  };

  test('accepts the exact preview and idempotency-bound browser result', () => {
    const result = activationResultFixture(preview, ACTIVATION_IDEMPOTENCY_KEY);
    expect(
      requireMatchingActivationResult(
        result,
        preview,
        selection,
        ACTIVATION_IDEMPOTENCY_KEY,
      ),
    ).toBe(result.event);
  });

  test('treats a result for another idempotent request as unresolved', async () => {
    await expectUnresolved(() =>
      requireMatchingActivationResult(
        activationResultFixture(preview, 'activate:different-request'),
        preview,
        selection,
        ACTIVATION_IDEMPOTENCY_KEY,
      ),
    );
  });

  test('treats a result authorized by another preview as unresolved', async () => {
    const otherPreview = ActivationPreviewSchema.parse({
      ...preview,
      id: uuid(23),
      consequenceDigest: 'b'.repeat(64),
    });
    await expectUnresolved(() =>
      requireMatchingActivationResult(
        activationResultFixture(otherPreview, ACTIVATION_IDEMPOTENCY_KEY),
        preview,
        selection,
        ACTIVATION_IDEMPOTENCY_KEY,
      ),
    );
  });

  test('rejects agent-prepared provenance on the direct browser preview path', async () => {
    const result = preparedActivationResult(
      activationResultFixture(preview, ACTIVATION_IDEMPOTENCY_KEY),
    );
    await expectUnresolved(() =>
      requireMatchingActivationResult(
        result,
        preview,
        selection,
        ACTIVATION_IDEMPOTENCY_KEY,
      ),
    );
  });

  test('rejects schema-valid notification consequences that differ from the preview', async () => {
    const result = activationResultFixture(preview, ACTIVATION_IDEMPOTENCY_KEY);
    if (result.notificationIntent === null) {
      throw new Error(
        'Synthetic activation result has no notification intent.',
      );
    }
    const mismatched = StartEventResultSchema.parse({
      ...result,
      notificationIntent: {
        ...result.notificationIntent,
        channels: result.notificationIntent.channels.map((channel) =>
          channel.channel === 'push'
            ? { ...channel, endpointCount: channel.endpointCount + 1 }
            : channel,
        ),
      },
    });

    await expectUnresolved(() =>
      requireMatchingActivationResult(
        mismatched,
        preview,
        selection,
        ACTIVATION_IDEMPOTENCY_KEY,
      ),
    );
  });

  test('rejects a schema-valid notification intent for another audience version', async () => {
    const result = activationResultFixture(preview, ACTIVATION_IDEMPOTENCY_KEY);
    if (result.notificationIntent === null) {
      throw new Error(
        'Synthetic activation result has no notification intent.',
      );
    }
    const mismatched = StartEventResultSchema.parse({
      ...result,
      notificationIntent: {
        ...result.notificationIntent,
        audienceConfig: {
          ...result.notificationIntent.audienceConfig,
          version: result.notificationIntent.audienceConfig.version + 1,
        },
      },
    });

    await expectUnresolved(() =>
      requireMatchingActivationResult(
        mismatched,
        preview,
        selection,
        ACTIVATION_IDEMPOTENCY_KEY,
      ),
    );
  });
});

async function withStalledBrowserRequest(
  operation: (requests: () => number) => Promise<void>,
): Promise<void> {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'synthetic-csrf=synthetic-token' },
  });
  globalThis.fetch = ((_input, init) => {
    requestCount += 1;
    return new Promise<Response>((_resolve, reject) => {
      const requestSignal = init?.signal;
      const rejectAbort = () =>
        reject(new DOMException('Synthetic timeout.', 'AbortError'));
      if (requestSignal?.aborted === true) {
        rejectAbort();
      } else {
        requestSignal?.addEventListener('abort', rejectAbort, { once: true });
      }
    });
  }) as typeof fetch;
  try {
    await operation(() => requestCount);
  } finally {
    globalThis.fetch = originalFetch;
    if (documentDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'document');
    } else {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    }
  }
}

async function withBrowserResponse(
  response: Response,
  operation: () => Promise<void>,
): Promise<void> {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'synthetic-csrf=synthetic-token' },
  });
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  try {
    await operation();
  } finally {
    globalThis.fetch = originalFetch;
    if (documentDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'document');
    } else {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    }
  }
}

describe('start-flow request deadlines', () => {
  test('classifies a stalled join as outcome-unknown without replay', async () => {
    await withStalledBrowserRequest(async (requests) => {
      let caught: unknown;
      try {
        await requestStartFlow(
          '/start/api/join',
          { eventId: uuid(1) },
          'synthetic-csrf',
          { parse: (value: unknown) => value },
          'join:synthetic-timeout',
          undefined,
          5,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(StartFlowRequestError);
      expect((caught as StartFlowRequestError).outcomeUnknown).toBe(true);
      expect((caught as StartFlowRequestError).retryable).toBe(false);
      expect(requests()).toBe(1);
    });
  });

  test('classifies a stalled preview as safely retryable', async () => {
    await withStalledBrowserRequest(async (requests) => {
      let caught: unknown;
      try {
        await requestStartFlow(
          '/start/api/preview',
          { facilityId: uuid(2) },
          'synthetic-csrf',
          { parse: (value: unknown) => value },
          undefined,
          undefined,
          5,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(StartFlowRequestError);
      expect((caught as StartFlowRequestError).outcomeUnknown).toBe(false);
      expect((caught as StartFlowRequestError).retryable).toBe(true);
      expect(requests()).toBe(1);
    });
  });

  test('classifies a parseable mutation 5xx as outcome-unknown', async () => {
    await withBrowserResponse(
      Response.json(
        {
          code: 'INTERNAL_ERROR',
          message: 'Synthetic server acknowledgement was interrupted.',
          requestId: uuid(24),
          retryable: true,
          fieldErrors: [],
        },
        { status: 503 },
      ),
      async () => {
        let caught: unknown;
        try {
          await requestStartFlow(
            '/start/api/activate',
            { activationPreviewId: uuid(25) },
            'synthetic-csrf',
            { parse: (value: unknown) => value },
            'activate:synthetic-503',
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StartFlowRequestError);
        expect((caught as StartFlowRequestError).outcomeUnknown).toBe(true);
        expect((caught as StartFlowRequestError).retryable).toBe(false);
      },
    );
  });

  test('keeps a parseable mutation 4xx definite', async () => {
    await withBrowserResponse(
      Response.json(
        {
          code: 'CONFLICT',
          message: 'Synthetic request was definitely rejected.',
          requestId: uuid(26),
          retryable: true,
          fieldErrors: [],
        },
        { status: 409 },
      ),
      async () => {
        let caught: unknown;
        try {
          await requestStartFlow(
            '/start/api/join',
            { eventId: uuid(1) },
            'synthetic-csrf',
            { parse: (value: unknown) => value },
            'join:synthetic-409',
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StartFlowRequestError);
        expect((caught as StartFlowRequestError).outcomeUnknown).toBe(false);
        expect((caught as StartFlowRequestError).retryable).toBe(true);
      },
    );
  });
});
