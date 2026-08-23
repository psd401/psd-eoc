import { describe, expect, test } from 'bun:test';

import {
  ActivationPreviewSchema,
  type ActivationPreview,
  type EventKind,
  type RosterPopulation,
  type TemplateMode,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../../lib/auth/sessions';
import {
  ACTIVATION_RATE_LIMIT_MAX_SUBMISSIONS,
  ACTIVATION_RATE_LIMIT_WINDOW_MS,
  issueStartEventConfirmation,
  type ActivationRateLimitReservationInput,
  type StartConfirmationStore,
  type StartConfirmationTransaction,
} from '../_lib/confirmation';

const IDS = {
  user: '20000000-0000-4000-8000-000000000001',
  session: '20000000-0000-4000-8000-000000000002',
  epoch: '20000000-0000-4000-8000-000000000003',
  facility: '20000000-0000-4000-8000-000000000004',
  otherFacility: '20000000-0000-4000-8000-000000000005',
  preview: '20000000-0000-4000-8000-000000000006',
  eventType: '20000000-0000-4000-8000-000000000007',
  roster: '20000000-0000-4000-8000-000000000008',
  audience: '20000000-0000-4000-8000-000000000009',
  activeEvent: '20000000-0000-4000-8000-000000000010',
  consumedRequest: '20000000-0000-4000-8000-000000000011',
} as const;

const NOW = new Date('2026-08-10T18:00:00.000Z');
const IDEMPOTENCY_KEY = 'confirmation-boundary-key-0001';

function authenticated(
  facilityIds: readonly string[] | null = null,
  source: AuthenticatedSession['source'] = 'web',
): AuthenticatedSession {
  return {
    actor: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    source,
    roles: ['staff'],
    scope: {
      facilityScope:
        facilityIds === null
          ? { kind: 'district' }
          : { kind: 'facilities', facilityIds },
    },
    membershipState: 'fresh',
    result: {
      session: { id: IDS.session },
      connectivityEpoch: { id: IDS.epoch },
    },
  } as unknown as AuthenticatedSession;
}

function renderedMessage(
  channel: 'email' | 'push',
  kind: EventKind,
  templateMode: TemplateMode,
) {
  const classificationMarker = templateMode === 'real' ? 'INCIDENT' : 'DRILL';
  const common = {
    channel,
    eventKind: kind,
    templateMode,
    purpose: 'activation' as const,
    classificationMarker,
  };
  return channel === 'push'
    ? {
        ...common,
        title: `[${classificationMarker}] Synthetic notice`,
        body: `[${classificationMarker}] Synthetic test message.`,
      }
    : {
        ...common,
        subject: `[${classificationMarker}] Synthetic notice`,
        textBody: `[${classificationMarker}] Synthetic test message.`,
      };
}

function preview(
  kind: Extract<EventKind, 'drill' | 'incident'>,
  rosterPopulation: RosterPopulation,
  overrides: Partial<ActivationPreview> = {},
): ActivationPreview {
  const templateMode = kind === 'incident' ? 'real' : 'drill';
  const integrationLabel =
    rosterPopulation === 'synthetic' ? 'mocked' : 'live-verified';
  return ActivationPreviewSchema.parse({
    id: IDS.preview,
    facilityId: IDS.facility,
    kind,
    templateMode,
    eventTypeVersion: { id: IDS.eventType, templateMode },
    rosterSnapshotId: IDS.roster,
    rosterPopulation,
    recipientCount: 2,
    channels: (['push', 'email'] as const).map((channel) => ({
      channel,
      endpointCount: 2,
      renderedMessage: renderedMessage(channel, kind, templateMode),
      integrationStatus:
        integrationLabel === 'mocked'
          ? {
              integrationId: channel === 'push' ? 'expo-push' : 'ses-email',
              label: integrationLabel,
              verifiedAt: null,
              verifiedByUserId: null,
              authorizationReference: null,
              reasonCode: null,
              observedAt: '2026-08-10T17:59:00.000Z',
            }
          : {
              integrationId: channel === 'push' ? 'expo-push' : 'ses-email',
              label: integrationLabel,
              verifiedAt: '2026-08-10T17:55:00.000Z',
              verifiedByUserId: IDS.user,
              authorizationReference: 'synthetic-test-authorization',
              reasonCode: null,
              observedAt: '2026-08-10T17:59:00.000Z',
            },
    })),
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    activeEventIds: [IDS.activeEvent],
    consequenceDigest: 'a'.repeat(64),
    createdAt: '2026-08-10T17:59:00.000Z',
    expiresAt: '2026-08-10T18:10:00.000Z',
    ...overrides,
  });
}

class MemoryConfirmationStore implements StartConfirmationStore {
  public readonly persisted: Parameters<
    StartConfirmationTransaction['persistConfirmation']
  >[0][] = [];
  public readonly rateChecks: ActivationRateLimitReservationInput[] = [];
  public denialCount = 0;
  public queuedCurrentTimes: Date[] = [];

  private readonly statuses = new Map<
    string,
    Readonly<{
      status: 'consumed' | 'expired' | 'issued';
      consumedAt: string | null;
      consumedForRequestId: string | null;
      expiredAt: string | null;
    }>
  >();
  private transactionTail: Promise<void> = Promise.resolve();

  public constructor(
    public previewValue: ActivationPreview | null,
    public currentTime = NOW,
  ) {}

  public async transaction<Result>(
    operation: (transaction: StartConfirmationTransaction) => Promise<Result>,
  ): Promise<Result> {
    const previous = this.transactionTail;
    let release: () => void = () => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation({
        readCurrentTime: async () =>
          this.queuedCurrentTimes.shift() ?? this.currentTime,
        loadPreview: async () => this.previewValue,
        loadConfirmation: async (confirmationId) => {
          const confirmation = this.persisted.find(
            (candidate) => candidate.id === confirmationId,
          );
          const lifecycle = this.statuses.get(confirmationId);
          return confirmation === undefined || lifecycle === undefined
            ? null
            : { confirmation, ...lifecycle };
        },
        reserveActivationSubmission: async (input) => {
          this.rateChecks.push(input);
          if (
            this.persisted.some(
              (confirmation) => confirmation.id === input.confirmationId,
            )
          ) {
            return 'replay';
          }
          const windowStart =
            input.occurredAt.getTime() - ACTIVATION_RATE_LIMIT_WINDOW_MS;
          const count = this.persisted.filter(
            (confirmation) =>
              confirmation.confirmedByUserId === input.actor.userId &&
              confirmation.consequenceDigest === input.consequenceDigest &&
              Date.parse(confirmation.issuedAt) >= windowStart &&
              Date.parse(confirmation.issuedAt) <= input.occurredAt.getTime(),
          ).length;
          if (count >= ACTIVATION_RATE_LIMIT_MAX_SUBMISSIONS) {
            this.denialCount += 1;
            return 'denied';
          }
          return 'fresh';
        },
        persistConfirmation: async (confirmation) => {
          if (
            this.persisted.some((candidate) => candidate.id === confirmation.id)
          ) {
            throw new Error('Duplicate synthetic confirmation ID.');
          }
          this.persisted.push(confirmation);
          this.statuses.set(confirmation.id, {
            status: 'issued',
            consumedAt: null,
            consumedForRequestId: null,
            expiredAt: null,
          });
        },
      });
    } finally {
      release();
    }
  }

  public markConsumed(confirmationId: string, consumedAt: string): void {
    this.statuses.set(confirmationId, {
      status: 'consumed',
      consumedAt,
      consumedForRequestId: IDS.consumedRequest,
      expiredAt: null,
    });
  }
}

function startInput() {
  return {
    source: 'activation-preview' as const,
    activationPreviewId: IDS.preview,
    activeEventDecision: {
      decision: 'start-new' as const,
      activeEventIdsSeen: [IDS.activeEvent],
    },
  };
}

describe('start-event human confirmation boundary', () => {
  test('derives both protected actions for a real staff incident', async () => {
    const store = new MemoryConfirmationStore(preview('incident', 'staff'));

    const receipt = await issueStartEventConfirmation(
      {
        authenticated: authenticated(),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      },
      store,
    );

    expect(receipt).toEqual({
      confirmationId: expect.any(String),
      confirmationIssuedAt: NOW,
      executionTime: NOW,
    });
    expect(store.persisted).toEqual([
      expect.objectContaining({
        id: receipt.confirmationId,
        capabilityId: 'start-event',
        actionIds: ['start-real-incident', 'send-real-notification'],
        confirmedByUserId: IDS.user,
        confirmedWithSessionId: IDS.session,
        connectivityEpochId: IDS.epoch,
        consequenceDigest: 'a'.repeat(64),
        issuedAt: NOW.toISOString(),
        expiresAt: '2026-08-10T18:05:00.000Z',
      }),
    ]);
    expect(store.rateChecks).toEqual([
      expect.objectContaining({
        actionIds: ['start-real-incident', 'send-real-notification'],
        actor: expect.objectContaining({ userId: IDS.user }),
        confirmationId: receipt.confirmationId,
        consequenceDigest: 'a'.repeat(64),
        facilityId: IDS.facility,
        idempotencyKey: IDEMPOTENCY_KEY,
        occurredAt: NOW,
        source: 'web',
      }),
    ]);
  });

  test('returns a DB execution time read after fresh confirmation persistence', async () => {
    const store = new MemoryConfirmationStore(preview('incident', 'staff'));
    const issuedAt = new Date('2026-08-10T18:00:01.000Z');
    const executionTime = new Date('2026-08-10T18:00:02.000Z');
    store.queuedCurrentTimes.push(NOW, issuedAt, executionTime);

    const receipt = await issueStartEventConfirmation(
      {
        authenticated: authenticated(),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      },
      store,
    );

    expect(store.persisted[0]?.issuedAt).toBe(issuedAt.toISOString());
    expect(store.persisted[0]?.id).toBe(receipt.confirmationId);
    expect(receipt).toEqual({
      confirmationId: receipt.confirmationId,
      confirmationIssuedAt: issuedAt,
      executionTime,
    });
    expect(receipt.executionTime.getTime()).toBeGreaterThanOrEqual(
      receipt.confirmationIssuedAt.getTime(),
    );
  });

  test('derives only notification authorization for a staff drill', async () => {
    const store = new MemoryConfirmationStore(preview('drill', 'staff'));

    await issueStartEventConfirmation(
      {
        authenticated: authenticated(),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      },
      store,
    );

    expect(store.persisted[0]?.actionIds).toEqual(['send-real-notification']);
  });

  test('preserves mobile provenance when reserving an activation', async () => {
    const store = new MemoryConfirmationStore(preview('drill', 'staff'));

    await issueStartEventConfirmation(
      {
        authenticated: authenticated(null, 'mobile'),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      },
      store,
    );

    expect(store.rateChecks).toEqual([
      expect.objectContaining({
        source: 'mobile',
      }),
    ]);
  });

  test('recovers the committed confirmation when the engine was never entered', async () => {
    const store = new MemoryConfirmationStore(preview('incident', 'staff'));

    const firstReceipt = await issueStartEventConfirmation(
      {
        authenticated: authenticated(),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      },
      store,
    );
    expect(store.persisted[0]?.id).toBe(firstReceipt.confirmationId);
    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: IDEMPOTENCY_KEY,
          startInput: startInput(),
        },
        store,
      ),
    ).resolves.toMatchObject({
      confirmationId: firstReceipt.confirmationId,
      confirmationIssuedAt: NOW,
      executionTime: NOW,
    });

    expect(store.rateChecks).toHaveLength(2);
    expect(store.persisted).toHaveLength(1);
  });

  test('hands a consumed expired replay to engine idempotency resolution', async () => {
    const store = new MemoryConfirmationStore(preview('incident', 'staff'));
    const receipt = await issueStartEventConfirmation(
      {
        authenticated: authenticated(),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      },
      store,
    );
    store.markConsumed(receipt.confirmationId, '2026-08-10T18:01:00.000Z');
    store.currentTime = new Date('2026-08-10T18:11:00.000Z');

    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: IDEMPOTENCY_KEY,
          startInput: startInput(),
        },
        store,
      ),
    ).resolves.toMatchObject({ confirmationId: receipt.confirmationId });
    expect(store.persisted).toHaveLength(1);
  });

  test('fails closed when an issued recovery confirmation expired', async () => {
    const store = new MemoryConfirmationStore(preview('incident', 'staff'));
    await issueStartEventConfirmation(
      {
        authenticated: authenticated(),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      },
      store,
    );
    store.currentTime = new Date('2026-08-10T18:06:00.000Z');

    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: IDEMPOTENCY_KEY,
          startInput: startInput(),
        },
        store,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CONFIRMATION_INVALID',
      status: 403,
    });
    expect(store.persisted).toHaveLength(1);
  });

  test('fails closed when replayed confirmation evidence does not match', async () => {
    const store = new MemoryConfirmationStore(preview('incident', 'staff'));
    await issueStartEventConfirmation(
      {
        authenticated: authenticated(),
        idempotencyKey: IDEMPOTENCY_KEY,
        startInput: startInput(),
      },
      store,
    );
    const persisted = store.persisted[0];
    if (persisted === undefined) {
      throw new Error('Expected staff confirmation evidence.');
    }
    store.persisted[0] = {
      ...persisted,
      consequenceDigest: 'b'.repeat(64),
    };

    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: IDEMPOTENCY_KEY,
          startInput: startInput(),
        },
        store,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CONFIRMATION_INVALID',
      status: 403,
    });
    expect(store.persisted).toHaveLength(1);
  });

  test('rejects synthetic previews before rate or confirmation persistence', async () => {
    const store = new MemoryConfirmationStore(preview('drill', 'synthetic'));

    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: IDEMPOTENCY_KEY,
          startInput: startInput(),
        },
        store,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

    expect(store.rateChecks).toEqual([]);
    expect(store.persisted).toEqual([]);
  });

  test('limits fresh user/facility submissions without charging idempotent replay', async () => {
    const store = new MemoryConfirmationStore(preview('drill', 'staff'));

    for (let index = 1; index <= 3; index += 1) {
      const receipt = await issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: `confirmation-boundary-key-000${index}`,
          startInput: startInput(),
        },
        store,
      );
      expect(store.persisted.at(-1)?.id).toBe(receipt.confirmationId);
    }
    const firstConfirmationId = store.persisted[0]?.id;
    if (firstConfirmationId === undefined) {
      throw new Error('Expected persisted staff confirmation evidence.');
    }
    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: 'confirmation-boundary-key-0001',
          startInput: startInput(),
        },
        store,
      ),
    ).resolves.toMatchObject({ confirmationId: firstConfirmationId });
    expect(store.persisted).toHaveLength(3);

    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: 'confirmation-boundary-key-0004',
          startInput: startInput(),
        },
        store,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(store.persisted).toHaveLength(3);
    expect(store.denialCount).toBe(1);

    store.currentTime = new Date(
      NOW.getTime() + ACTIVATION_RATE_LIMIT_WINDOW_MS + 1,
    );
    const fourthReceipt = await issueStartEventConfirmation(
      {
        authenticated: authenticated(),
        idempotencyKey: 'confirmation-boundary-key-0004',
        startInput: startInput(),
      },
      store,
    );
    expect(store.persisted.at(-1)?.id).toBe(fourthReceipt.confirmationId);
    expect(store.persisted).toHaveLength(4);
  });

  test('serializes concurrent staff submissions against persisted slots', async () => {
    const store = new MemoryConfirmationStore(preview('drill', 'staff'));
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((index) =>
        issueStartEventConfirmation(
          {
            authenticated: authenticated(),
            idempotencyKey: `concurrent-confirmation-key-000${index}`,
            startInput: startInput(),
          },
          store,
        ),
      ),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(3);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'RATE_LIMITED', status: 429 },
    });
    expect(store.persisted).toHaveLength(3);
    expect(store.denialCount).toBe(1);
  });

  test('fails closed before issuance when active-event evidence changed', async () => {
    const store = new MemoryConfirmationStore(preview('incident', 'staff'));
    const changedInput = {
      ...startInput(),
      activeEventDecision: {
        decision: 'start-new' as const,
        activeEventIdsSeen: [],
      },
    };

    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated(),
          idempotencyKey: IDEMPOTENCY_KEY,
          startInput: changedInput,
        },
        store,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.persisted).toEqual([]);
  });

  test('fails closed for expired, blocked, missing, and out-of-scope previews', async () => {
    const cases = [
      new MemoryConfirmationStore(
        preview('incident', 'staff', {
          expiresAt: '2026-08-10T17:59:30.000Z',
        }),
      ),
      new MemoryConfirmationStore(
        preview('incident', 'staff', {
          sendReadiness: 'blocked',
          blockingReasonCodes: ['PUSH_NOT_LIVE_VERIFIED'],
        }),
      ),
      new MemoryConfirmationStore(null),
    ];

    for (const store of cases) {
      await expect(
        issueStartEventConfirmation(
          {
            authenticated: authenticated(),
            idempotencyKey: IDEMPOTENCY_KEY,
            startInput: startInput(),
          },
          store,
        ),
      ).rejects.toBeDefined();
      expect(store.persisted).toEqual([]);
    }

    const outOfScope = new MemoryConfirmationStore(
      preview('incident', 'staff'),
    );
    await expect(
      issueStartEventConfirmation(
        {
          authenticated: authenticated([IDS.otherFacility]),
          idempotencyKey: IDEMPOTENCY_KEY,
          startInput: startInput(),
        },
        outOfScope,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(outOfScope.persisted).toEqual([]);
  });
});
